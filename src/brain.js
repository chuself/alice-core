import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { completeJson } from "./llm.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";


export const PILLARS = [
  "feature-spotlight",
  "pain-point",
  "number-that-lands",
  "client-proof",
  "swahili-tip",
  "industry-note",
];

/**
 * The audience is Tanzanian hoteliers, so the feed leans Kiswahili: 4 of every 6
 * posts. English is kept for the two pillars where it reads more naturally —
 * hard numbers and regional industry commentary.
 */
export const PILLAR_LANGUAGE = {
  "feature-spotlight": "sw",
  "pain-point": "sw",
  "number-that-lands": "en",
  "client-proof": "sw",
  "swahili-tip": "sw",
  "industry-note": "en",
};

/**
 * Which pillar comes next.
 *
 * Round-robin is the floor — every pillar still gets used, so the feed never
 * collapses into one note. On top of that, a pillar that consistently
 * outperforms gets an extra turn, and one that consistently flops loses one.
 * `scores` is the per-pillar average engagement written by cli-metrics.js.
 */
export function nextPillar(recent, scores = null) {
  const last = recent.find((r) => PILLARS.includes(r.pillar))?.pillar;
  const i = last ? PILLARS.indexOf(last) : -1;
  const next = PILLARS[(i + 1) % PILLARS.length];

  if (!scores || Object.keys(scores).length < PILLARS.length) return next;

  // Skip the next pillar only if it is a clear laggard AND was used recently,
  // so a weak pillar is thinned out rather than silently dropped forever.
  const values = Object.values(scores);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const usedRecently = recent.slice(0, 3).some((r) => r.pillar === next);
  if (usedRecently && (scores[next] ?? 0) < average * 0.5) {
    return PILLARS[(i + 2) % PILLARS.length];
  }
  return next;
}

/**
 * The call to action. A wa.me deep link carries a per-post tag in the prefilled
 * message, so an incoming WhatsApp says which post produced it — that is what
 * lets the feedback loop optimise for conversations instead of likes.
 */
export function ctaLink(brand, postId) {
  const number = process.env.WHATSAPP_CTA_NUMBER;
  if (!number) return brand.site;
  const tag = postId ? postId.replace(new RegExp(`^${DEFAULT_BRAND}-`), "") : "";
  // The wording belongs to the brand, not to the engine.
  const template =
    brand.ctaMessage ?? "Habari, nimeona post yenu{tag}. Nataka kujua zaidi kuhusu {brand}.";
  const text = template
    .replace("{tag}", tag ? ` [${tag}]` : "")
    .replace("{brand}", brand.name ?? "");
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/**
 * Turn an approved post into a spoken reel script. Reuses the post's own angle
 * so the reel and the poster say the same thing — one idea, two formats.
 */
export async function writeReelScript(post, brandId = DEFAULT_BRAND) {
  const brandDir = path.join(ROOT, "brands", brandId);
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));
  const facts = await readFile(path.join(brandDir, "facts.md"), "utf8");
  const sw = post.language === "sw";

  const script = await completeJson(
    `Turn this into a short vertical video script for ${brand.name}, a hotel management
system in Tanzania. The audience is hotel owners and managers.

Headline: ${post.headline}
Body: ${post.body}

## The only facts you may state
${facts}
Never state a price, phone number or statistic that is not listed above.

Return ONLY JSON:
{
  "beats": ["3 to 4 on-screen lines"],
  "narration": "what the voice says, one flowing paragraph",
  "hook": "the first 3 words, must stop a thumb"
}

Rules:
- "beats" appear one at a time on screen. Each is at most 7 words. The first is the hook.
- The last beat names the payoff, not the product.
- "narration" is 30-45 words, spoken naturally, and must cover the same ground as the
  beats without reading them word for word.
- ${sw
      ? "Write EVERYTHING in natural Tanzanian Kiswahili, as a hotelier speaks."
      : "Write in English."}
- No URLs, no phone numbers, no emoji.`
  );
  return script;
}

export async function writePost({ brandId = DEFAULT_BRAND, pillar, recent = [], language, note }) {
  language ??= PILLAR_LANGUAGE[pillar] ?? "en";
  const brandDir = path.join(ROOT, "brands", brandId);
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));
  const pillars = await readFile(path.join(brandDir, "pillars.md"), "utf8");
  const facts = await readFile(path.join(brandDir, "facts.md"), "utf8");

  // What has actually worked here beats any style rule we could write.
  const topPath = path.join(ROOT, "state", "top-performers.json");
  let topLines = "";
  if (existsSync(topPath)) {
    const top = JSON.parse(await readFile(topPath, "utf8"));
    if (top.length) {
      topLines = [
        "",
        "## What performs best with this audience",
        "Study the angle of these, do not copy the wording:",
        ...top.map((t) => `- [${t.pillar}] ${t.headline}`),
        "",
      ].join("\n");
    }
  }

  // Whatever the owner told the bot in Telegram outranks the pillar defaults.
  const steerPath = path.join(ROOT, "state", "steer.md");
  let steerLines = "";
  if (existsSync(steerPath)) {
    const steer = (await readFile(steerPath, "utf8")).trim();
    if (steer) {
      steerLines = [
        "",
        "## Standing instructions from the owner",
        "These override the style guidance above. The most recent ones win.",
        steer,
        "",
      ].join("\n");
    }
  }

  const recentLines = recent
    .slice(0, 60)
    .map((r) => `- [${r.pillar}] ${r.headline}`)
    .join("\n") || "- (nothing yet)";

  const prompt = `You write social posts for ${brand.name} — ${brand.tagline} (${brand.site}).
The audience is hotel owners and managers in Tanzania and East Africa.

${pillars}
${steerLines}${topLines}
## Approved facts
You may ONLY state figures, statistics or client claims that appear here verbatim.
If you want a number that is not listed, write the post with no number at all.

${facts}

## Already posted — do not repeat these angles
${recentLines}

## Your task
Write ONE post for the pillar: **${pillar}**.
${note ? `
**Direction for this run — this overrides the usual angle:**
${note}
` : ""}

Return ONLY a JSON object with these keys:
- "eyebrow": 1-2 words, the module or theme (e.g. "Front desk", "Housekeeping"). Title case.
- "headline": max 60 characters. One concrete idea. No colons, no hype words.
- "body": 15-30 words expanding the headline. Plain, specific.
- "cta": 2-4 words (e.g. "See it work", "Book a demo").
- "caption": 40-90 words for the post itself. Opens with a hook a hotelier would recognise.
  Do NOT include any URL or phone number — the link is appended automatically.
  Line breaks allowed. At most one emoji, only if it genuinely helps.
- "hashtags": array of 3-5 hashtags, relevant, no spam.
- "imagePrompt": a photographic or abstract background description. MUST specify
  "no text, no people, no logos" and a dark ${brand.colors.primary}/${brand.colors.teal} colour grade.
  The headline is laid over the left side, so keep the subject right-of-centre and low contrast.
- "template": "spotlight"

${language === "sw"
  ? `Write EVERY field — eyebrow, headline, body, cta, caption — in natural Tanzanian Kiswahili.
Write it as a Tanzanian hotelier speaks, not as translated English. Avoid stiff textbook
Kiswahili and avoid direct word-for-word renderings of English marketing phrases.
Hashtags may stay in English where that is what people actually search.`
  : "Write in English."}`;

  const post = await completeJson(prompt);
  return { ...post, pillar, language, brand: brandId };
}

/**
 * The invented-statistic guard. An unattended LLM will eventually make up a number;
 * anything numeric that is not in facts.md gets the post held for review.
 */
export async function findUnapprovedFigures(post, brandId = DEFAULT_BRAND) {
  const factsPath = path.join(ROOT, "brands", brandId, "facts.md");
  const facts = existsSync(factsPath) ? await readFile(factsPath, "utf8") : "";
  const approved = new Set(facts.match(/\d[\d.,]*/g) ?? []);

  const text = [post.headline, post.body, post.caption].filter(Boolean).join(" ");
  const found = text.match(/\d[\d.,]*\s*%?/g) ?? [];

  return [...new Set(found.map((f) => f.trim()))].filter((f) => {
    const bare = f.replace(/%$/, "").trim();
    if (approved.has(bare)) return false;
    // A bare year or a small count reads as prose, not a claim.
    if (/^(19|20)\d{2}$/.test(bare)) return false;
    if (/^\d$/.test(bare) && !f.includes("%")) return false;
    return true;
  });
}
