/**
 * Telegram inbox logic, shared by the scheduled batch job (cli-listen.js) and
 * the long-lived watcher (cli-listen-live.js).
 *
 * One implementation on purpose: the watcher exists only to shorten the wait,
 * never to behave differently from the safety-net job.
 */
import { readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { notify } from "./notify.js";
import { readQueue } from "./queue.js";
import { completeJson } from "./llm.js";
import { updateConfig, readConfig, LIMITS } from "./config.js";
import { ROOT } from "./paths.js";

export const STEER = path.join(ROOT, "state", "steer.md");
export const OFFSET = path.join(ROOT, "state", "telegram-offset.json");
export const PAUSED = path.join(ROOT, "state", "PAUSED");
export const REPLAN = path.join(ROOT, "state", "REPLAN");

export function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

export async function readOffset() {
  if (!existsSync(OFFSET)) return 0;
  try {
    return JSON.parse(await readFile(OFFSET, "utf8")).offset ?? 0;
  } catch {
    return 0;
  }
}

export async function writeOffset(offset) {
  await writeFile(OFFSET, JSON.stringify({ offset }, null, 2));
}

/**
 * @param {number} offset
 * @param {number} timeoutSec  0 = return immediately; >0 = hold the connection
 *   open until something arrives. Long polling is what removes the wait.
 */
export async function fetchUpdates(offset, timeoutSec = 0) {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken()}/getUpdates?offset=${offset}&timeout=${timeoutSec}`,
    { signal: AbortSignal.timeout((timeoutSec + 20) * 1000) }
  );
  const json = await res.json();
  if (!json.ok) throw new Error(`getUpdates failed: ${json.description}`);
  return json.result ?? [];
}

/**
 * Handle one message. Returns what changed so the caller can decide whether
 * state needs committing and whether a replan should be triggered.
 */
export async function handleMessage(text, chatId) {
  const owner = String(process.env.TELEGRAM_CHAT_ID ?? "");
  if (owner && String(chatId) !== owner) {
    return { kind: "ignored", changed: false, replan: false };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "/pause") {
    await writeFile(PAUSED, "paused from Telegram\n");
    await notify("⏸ Publishing paused. Send /resume to start again.");
    return { kind: "command", changed: true, replan: false };
  }
  if (lower === "/resume") {
    if (existsSync(PAUSED)) await unlink(PAUSED);
    await notify("▶️ Publishing resumed.");
    return { kind: "command", changed: true, replan: false };
  }
  if (lower === "/status") {
    await notify(await statusText());
    return { kind: "command", changed: false, replan: false };
  }
  if (lower === "/replan") {
    await writeFile(REPLAN, "requested from Telegram\n");
    await notify("🔁 Re-planning now — this takes a few minutes.");
    return { kind: "command", changed: true, replan: true };
  }
  if (lower === "/clear") {
    if (existsSync(STEER)) await unlink(STEER);
    await notify("🧹 Standing instructions cleared.");
    return { kind: "command", changed: true, replan: false };
  }
  if (lower.startsWith("/start") || lower.startsWith("/help")) {
    await notify(helpText());
    return { kind: "command", changed: false, replan: false };
  }

  // Not everything typed at a bot is an instruction. "Hey" and "what's planned?"
  // are conversation; storing them as standing rules would poison the brief.
  const intent = await classify(trimmed);

  if (intent.kind === "setting") {
    const { changes, rejected } = await updateConfig(intent.settings ?? {});
    const parts = [];
    if (changes.length) parts.push(`⚙️ <b>Routine updated</b>\n• ${changes.join("\n• ")}`);
    if (rejected.length) parts.push(`❌ Not applied: ${rejected.join("; ")}`);
    if (!changes.length && !rejected.length) parts.push("Nothing to change — already set that way.");
    parts.push("\nSend /replan to rebuild the schedule now.");
    await notify(parts.join("\n"));
    if (changes.length) await writeFile(REPLAN, "routine changed\n");
    return { kind: "setting", changed: changes.length > 0, replan: changes.length > 0 };
  }

  if (intent.kind === "instruction") {
    const stamp = new Date().toISOString().slice(0, 10);
    await appendFile(STEER, `- (${stamp}) ${trimmed}\n`, "utf8");
    await notify(`✅ Noted. From the next plan onward:\n<i>${escapeHtml(trimmed)}</i>`);
    return { kind: "instruction", changed: true, replan: false };
  }

  if (intent.kind === "question") {
    await notify(intent.reply ? escapeHtml(intent.reply) : await statusText());
    return { kind: "question", changed: false, replan: false };
  }

  await notify(escapeHtml(intent.reply ?? "👍"));
  return { kind: "chat", changed: false, replan: false };
}

function helpText() {
  return [
    "Send me plain text and I will write in that style from now on.",
    "",
    "Examples:",
    "• <i>less formal, write like WhatsApp</i>",
    "• <i>push the POS module this week</i>",
    "",
    "Or change the routine:",
    "• <i>3 posters and 1 reel a day at 8, 13, 16 and 20</i>",
    "",
    "/status — what is queued",
    "/replan — rebuild the schedule now",
    "/pause — stop posting   /resume — start again",
    "/clear — forget my instructions",
  ].join("\n");
}

export async function statusText() {
  const queue = await readQueue();
  const cfg = await readConfig();
  const now = new Date();
  const upcoming = queue
    .filter((p) => p.status !== "posted" && p.status !== "reject" && new Date(p.scheduledFor) >= now)
    .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

  const lines = [
    `📊 <b>Status</b>${existsSync(PAUSED) ? " — ⏸ PAUSED" : ""}`,
    `${upcoming.length} queued · ${queue.filter((p) => p.status === "posted").length} posted all time`,
    `Routine: ${describeRoutine(cfg)}`,
    "",
  ];
  for (const p of upcoming.slice(0, 8)) {
    lines.push(`• ${eat(p.scheduledFor)} [${p.language ?? "--"}] ${p.headline}`);
  }
  if (existsSync(STEER)) {
    lines.push("", "<b>Your standing instructions:</b>", escapeHtml(await readFile(STEER, "utf8")).trim());
  }
  return lines.join("\n");
}

export function describeRoutine(cfg) {
  if (Array.isArray(cfg.slots) && cfg.slots.length) {
    return cfg.slots.map((s) => `${s.hour}:00 ${s.format}`).join(" · ");
  }
  return `${cfg.postsPerDay}/day at ${(cfg.postHours ?? []).map((h) => `${h}:00`).join(", ")} · ${cfg.reelsPerWeek} reels/week`;
}

/** Render a stored UTC timestamp in East Africa Time. */
export function eat(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 3600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Decide whether a message changes the routine, changes the writing, asks
 * something, or is just chat. On any failure it is treated as chat — a misread
 * must never silently rewrite the brief.
 */
async function classify(text) {
  const queue = await readQueue();
  const cfg = await readConfig();
  const upcoming = queue
    .filter((p) => p.status !== "posted" && p.status !== "reject")
    .slice(0, 10)
    .map((p) => `- ${p.scheduledFor?.slice(0, 10)} [${p.language ?? "--"}] ${p.headline}`)
    .join("\n");

  try {
    return await completeJson(
      `You are the assistant behind an automated social media account for a small
business. The owner sent you this on Telegram:

"""${text}"""

Currently queued:
${upcoming || "(nothing queued)"}

Current routine: ${describeRoutine(cfg)}

Classify the message and reply. Return ONLY JSON:
{
  "kind": "setting" | "instruction" | "question" | "chat",
  "settings": { "slots": [ { "hour": number, "format": "poster" | "reel" } ] },
  "reply": "under 60 words, plain text"
}

- "setting" = it changes HOW OFTEN, WHEN, or IN WHAT FORMAT to post. Return the FULL
  desired day as "slots" — one entry per post, each with its hour and its format.
  Example: "3 posters and 1 reel a day at 8, 13, 16 and 20" becomes
  [{"hour":8,"format":"poster"},{"hour":13,"format":"poster"},
   {"hour":16,"format":"reel"},{"hour":20,"format":"poster"}].
  Hours are 24h local, between ${LIMITS.minHour} and ${LIMITS.maxHour}.
  At most ${LIMITS.maxSlotsPerDay ?? 6} slots per day. If they name fewer hours than
  posts, spread the extras sensibly. Reply confirming the new day.
- "instruction" = it changes how posts are WRITTEN or what they cover (tone, wording,
  language, topics to push or avoid). Reply confirming what changed.
- "question" = they are asking something. Answer it using the queue above.
- "chat" = greeting or small talk. Reply briefly and naturally.

Reply in the same language they wrote in.`
    );
  } catch (err) {
    console.warn(`  classify failed, treating as chat: ${err.message}`);
    return { kind: "chat", reply: null };
  }
}
