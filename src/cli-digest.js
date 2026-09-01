#!/usr/bin/env node
/**
 * The weekly message: what is queued, what needs a human, what went out.
 *   node src/cli-digest.js
 */
import { readQueue, readHistory } from "./queue.js";
import { notify } from "./notify.js";
import { readFileSync } from "node:fs";
import { DEFAULT_BRAND } from "./brand-id.js";

// The digest is signed with the client name, which lives in the brand pack.
const BRAND_NAME = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL(`../brands/${DEFAULT_BRAND}/brand.json`, import.meta.url), "utf8")
    ).name;
  } catch {
    return "Alice";
  }
})();

const queue = await readQueue();
const history = await readHistory();
const now = new Date();
const weekAgo = new Date(now - 7 * 86400_000);

const upcoming = queue
  .filter((p) => p.status !== "posted" && p.status !== "reject" && new Date(p.scheduledFor) >= now)
  .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

const needsReview = upcoming.filter((p) => p.status === "needs-review");
const postedThisWeek = history.filter((h) => new Date(h.postedAt) >= weekAgo);

const fmt = (d) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

const lines = [
  `📅 <b>${BRAND_NAME} — week of ${fmt(now)}</b>`,
  ``,
  `<b>${upcoming.length}</b> queued · <b>${postedThisWeek.length}</b> posted in the last 7 days`,
];

if (needsReview.length) {
  lines.push(``, `⚠️ <b>${needsReview.length} need${needsReview.length === 1 ? "s" : ""} your eye</b> (unapproved figures — these will NOT auto-post):`);
  for (const p of needsReview) {
    lines.push(`• ${fmt(p.scheduledFor)} — ${p.headline}`);
    lines.push(`  figures: ${(p.heldFigures ?? []).join(", ")}`);
  }
}

const auto = upcoming.filter((p) => p.status !== "needs-review");
if (auto.length) {
  lines.push(``, `✅ <b>Going out automatically:</b>`);
  for (const p of auto.slice(0, 10)) {
    lines.push(`• ${fmt(p.scheduledFor)} [${p.pillar}] ${p.headline}`);
  }
}

lines.push(``, `Edit or reject: <code>state/queue.json</code>`);
lines.push(`Stop everything: create <code>state/PAUSED</code>`);

await notify(lines.join("\n"));
console.log("digest sent");
