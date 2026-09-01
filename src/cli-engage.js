#!/usr/bin/env node
/**
 * Reads comments on recent Facebook and Instagram posts, replies to the easy
 * ones, and escalates anything that looks like a buying signal.
 *
 * Posting without reading the replies is a leaky bucket: the engagement is
 * already paid for, this is what converts it.
 *
 * Safety posture:
 *  - never replies twice to the same comment (state/replied.json)
 *  - never replies to the Page's own comments
 *  - anything classified as a lead is escalated to a human, not answered
 *  - DRY_RUN=1 classifies and logs, sends nothing
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchComments, reply as sendReply } from "./engage/source.js";
import { availablePlatforms } from "./publish/index.js";
import { completeJson } from "./llm.js";
import { notify } from "./notify.js";
import { readHistory } from "./queue.js";
import { ctaLink } from "./brain.js";
import { isDryRun, assertLicensed } from "./guards.js";
import { report, pushLeads } from "./control.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

const REPLIED = path.join(ROOT, "state", "replied.json");
// Without "from" we cannot tell our own comments apart, so we remember the ids
// of every reply we post and skip them.
const OURS = path.join(ROOT, "state", "our-comments.json");
const LEADS = path.join(ROOT, "state", "leads.json");
const MAX_REPLIES_PER_RUN = 10;

const token = process.env.FB_PAGE_ACCESS_TOKEN;
if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
const dryRun = isDryRun();
const startedAt = new Date().toISOString();
if (!(await assertLicensed("engage"))) {
  await report("engage", { ok: true, startedAt, summary: "skipped - subscription inactive" });
  process.exit(0);
}

const brand = JSON.parse(
  await readFile(path.join(ROOT, "brands", DEFAULT_BRAND, "brand.json"), "utf8")
);
const facts = await readFile(path.join(ROOT, "brands", DEFAULT_BRAND, "facts.md"), "utf8");
const CTA = ctaLink(brand, null);

const replied = new Set(existsSync(REPLIED) ? JSON.parse(await readFile(REPLIED, "utf8")) : []);
const leads = existsSync(LEADS) ? JSON.parse(await readFile(LEADS, "utf8")) : [];
// Where this run started, so only NEW leads are pushed upward.
const before = leads.length;
const ours = new Set(existsSync(OURS) ? JSON.parse(await readFile(OURS, "utf8")) : []);

// Only look at the last 14 days — older threads are not worth waking up.
const cutoff = Date.now() - 14 * 86400_000;
const history = (await readHistory()).filter((h) => new Date(h.postedAt).getTime() > cutoff);

// One call per platform on Metricool; one per post on Graph. The source module
// hides which, so this file no longer knows what a tenant is connected to.
const comments = [];
const denied = new Set();
try {
  comments.push(
    ...(await fetchComments({ platforms: availablePlatforms(), history, ours }))
  );
} catch (err) {
  // A permissions failure reads exactly like "nobody commented" unless it is
  // called out - which is how this went unnoticed for a day.
  if (/#200|#10|Missing Permissions|permission|blocked/i.test(err.message)) {
    for (const pl of availablePlatforms()) denied.add(pl);
  }
  console.warn(`reading comments failed: ${err.message.slice(0, 160)}`);
}

if (denied.size) {
  const msg =
    `🔒 <b>Comment replies are switched off</b>
` +
    `Reading comments on <b>${[...denied].join(" and ")}</b> is being denied.

` +
    `The Page token is missing <code>pages_read_user_content</code>, ` +
    `<code>pages_manage_engagement</code> and <code>instagram_manage_comments</code>. ` +
    `Regenerate it in the Graph API Explorer with those added.`;
  console.error(`PERMISSION DENIED on: ${[...denied].join(", ")}`);
  await notify(msg);
}

console.log(`${comments.length} comment(s) on ${history.length} recent post(s)${denied.size ? " (some denied)" : ""}`);

let sent = 0;
for (const c of comments) {
  if (replied.has(c.id)) continue;
  if (c.fromPage) continue; // our own replies

  const verdict = await triage(c);
  console.log(`  [${verdict.kind}] ${c.from}: ${c.text.slice(0, 60)}`);

  if (verdict.kind === "lead") {
    leads.push({ ...c, note: verdict.reply, seenAt: new Date().toISOString() });
    await notify(
      [
        `🔥 <b>Lead on ${c.platform}</b>`,
        `<b>${escapeHtml(c.from)}</b>: ${escapeHtml(c.text)}`,
        verdict.reply ? `\n<i>${escapeHtml(verdict.reply)}</i>` : "",
        c.permalink ? `\n${c.permalink}` : "",
      ].join("\n")
    );
    // A buying signal gets a human, not a bot. Mark it so it is not re-alerted.
    replied.add(c.id);
    continue;
  }

  if (verdict.kind === "ignore" || !verdict.reply) {
    replied.add(c.id);
    continue;
  }

  const safe = sanitiseReply(verdict.reply, c);
  if (!safe) {
    console.log("  reply withheld (unsafe content) — escalated instead");
    await notify(
      `🤖 <b>Held a reply on ${c.platform}</b>
<b>${escapeHtml(c.from)}</b>: ${escapeHtml(c.text)}

The drafted reply invented a detail, so nothing was posted.`
    );
    replied.add(c.id);
    continue;
  }
  verdict.reply = safe;

  if (sent >= MAX_REPLIES_PER_RUN) {
    console.log("  reply cap reached for this run");
    break;
  }

  if (dryRun) {
    console.log(`  [dry-run] would reply: ${verdict.reply}`);
  } else {
    try {
      const postedId = await sendReply(c, verdict.reply, { dryRun });
      if (postedId) ours.add(postedId);
      // A closed reply window is not a failure: the platform will not take it,
      // and the lead alert has already reached a human.
      console.log(postedId ? "  replied" : "  not answerable - escalated");
    } catch (err) {
      console.error(`  reply failed: ${err.message}`);
      continue;
    }
  }
  replied.add(c.id);
  sent++;
}

if (!dryRun) {
  await writeFile(REPLIED, JSON.stringify([...replied].slice(-2000), null, 2));
  await writeFile(OURS, JSON.stringify([...ours].slice(-2000), null, 2));
  await writeFile(LEADS, JSON.stringify(leads.slice(-500), null, 2));
}
console.log(`\n${sent} repl(ies) sent, ${leads.length} lead(s) on file`);

/**
 * Decide what a comment is. Errs towards silence: on any failure the comment is
 * left alone rather than answered wrongly in public.
 */
async function triage(c) {
  if (!c.text.trim()) return { kind: "ignore" };
  try {
    return await completeJson(
      `You handle the public comments for ${brand.name}${brand.tagline ? ` — ${brand.tagline}` : ""}.

## The only things you may state as fact
${facts}

NEVER state a price, a phone number, a statistic, or a feature that is not listed above.
NEVER invent contact details — a contact link is appended to your reply automatically.
If you do not know, say you will follow up.

A ${c.platform} user "${c.from}" commented:
"""${c.text}"""

Return ONLY JSON:
{ "kind": "lead" | "question" | "praise" | "ignore", "reply": "under 40 words" }

- "lead" = they want pricing, a demo, to buy, or say they run a hotel and are interested.
  Put a short note to the owner in "reply" instead of a public answer.
- "question" = a genuine question about what ${brand.name} does. Answer it helpfully and invite
  them to WhatsApp. Never invent features, prices or numbers — if you do not know, say
  you will follow up.
- "praise" = a compliment or emoji. Reply warmly in one short line.
- "ignore" = spam, abuse, or unrelated.

Reply in the same language they wrote in — most will be Kiswahili.`
    );
  } catch (err) {
    console.warn(`  triage failed, leaving it alone: ${err.message}`);
    return { kind: "ignore" };
  }
}

/**
 * A public reply is the one place a hallucination is expensive and permanent.
 * Anything that looks like a phone number or a price gets the whole reply
 * withheld rather than patched — a wrong number is worse than no reply.
 */
function sanitiseReply(reply, c) {
  const text = String(reply).trim();
  if (!text) return null;

  const phoneish = /(\+?\d[\d\s().-]{6,})/;           // 7+ digits in a run
  const priceish = /(tsh|tzs|usd|\$|shilingi)\s*[\d,.]+/i;
  const approved = new Set(facts.match(/\d[\d.,]*/g) ?? []);

  if (phoneish.test(text) || priceish.test(text)) return null;

  // Any other figure must be one facts.md actually approves.
  for (const n of text.match(/\d[\d.,]*/g) ?? []) {
    if (!approved.has(n) && !/^\d$/.test(n)) return null;
  }

  // The real contact route is appended here, never written by the model.
  const withCta = c && CTA && !text.includes("wa.me") ? `${text}
${CTA}` : text;
  return withCta.slice(0, 600);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
