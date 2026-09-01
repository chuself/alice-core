#!/usr/bin/env node
/**
 * Build a reel from a queued post: script -> Swahili voiceover -> vertical MP4.
 *
 *   node src/cli-reel.js                # the next eligible queued post
 *   node src/cli-reel.js <post-id>
 *
 * Publishing is a separate step (cli-publish-reel.js) because, exactly like the
 * posters, the file must be live on a public URL before Instagram can fetch it.
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeReelScript } from "./brain.js";
import { speak } from "./audio.js";
import { renderReel, probeVideo } from "./video.js";
import { readQueue, writeQueue, readHistory } from "./queue.js";
import { readConfig } from "./config.js";
import { assertLicensed } from "./guards.js";
import { report } from "./control.js";
import { appendFileSync } from "node:fs";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

/** Tell the workflow whether there is anything downstream to do. */
function setOutput(built) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `built=${built}
`);
  }
}

// Normalise to null: the workflow passes "" when no id is given, and "" is
// neither null nor undefined, so ?? would keep it and skip the fallback.
const wanted = process.argv[2]?.trim() || null;

const queue = await readQueue();

const startedAt = new Date().toISOString();
if (!(await assertLicensed("reel"))) {
  await report("reel", { ok: true, startedAt, summary: "skipped - subscription inactive" });
  setOutput(false);
  process.exit(0);
}

// Cadence lives in config, not in cron, so it can be changed from Telegram.
// The workflow wakes often; this decides whether a reel is actually owed.
const cfg = await readConfig();
if (!wanted && process.env.IGNORE_CADENCE !== "1" && cfg.reelsPerDay === 0) {
  console.log("No reel slots in the current routine — nothing to do.");
  setOutput(false);
  process.exit(0);
}

// Prefer a post that is already written and not yet posted — the reel and the
// poster then carry the same idea, and nothing is invented twice.
const post =
  (wanted ? queue.find((p) => p.id === wanted) : null) ??
  // Slots declare their own format now, so the reel job films what was planned
  // as a reel rather than guessing at the next unfilmed post.
  queue.find((p) => p.format === "reel" && p.status !== "posted" && p.status !== "reject" && !p.reel) ??
  queue.find((p) => p.status !== "posted" && p.status !== "reject" && !p.reel && !p.format);

if (wanted && !post) {
  console.error(`No post with id "${wanted}" in the queue.`);
  process.exit(1);
}

if (!post) {
  console.log("No eligible post to turn into a reel — nothing to do.");
  setOutput(false);
  process.exit(0);
}

console.log(`Building a reel from: ${post.headline} [${post.language ?? "en"}]`);

const script = await writeReelScript(post, post.brand ?? DEFAULT_BRAND);
console.log(`  beats: ${script.beats.map((b) => `"${b}"`).join(" · ")}`);
console.log(`  narration: ${script.narration}`);

const audioFile = path.join(ROOT, "state", "audio", `${post.id}.mp3`);
const audio = await speak(script.narration, post.language ?? "en", audioFile);

const videoFile = path.join(ROOT, "public", `${post.id}.mp4`);
await renderReel(
  {
    ...post,
    beats: script.beats,
    cta: post.cta ?? (post.language === "sw" ? "Tuongee" : "Talk to us"),
  },
  post.brand ?? DEFAULT_BRAND,
  audio,
  videoFile
);

const probe = await probeVideo(videoFile);
const v = (probe.streams ?? []).find((s) => s.width);
const sizeMb = (Number(probe.format?.size ?? 0) / 1e6).toFixed(1);
console.log(`  ${videoFile.split(path.sep).pop()} — ${v?.width}x${v?.height}, ${Number(probe.format?.duration).toFixed(1)}s, ${sizeMb} MB`);

// Instagram rejects anything outside these bounds; fail here, not at upload.
const problems = [];
if (v?.width !== 1080 || v?.height !== 1920) problems.push(`wrong size ${v?.width}x${v?.height}`);
if (Number(probe.format?.duration) < 3) problems.push("shorter than 3s");
if (Number(probe.format?.duration) > 90) problems.push("longer than 90s");
if (Number(probe.format?.size) > 300e6) problems.push("larger than 300MB");
if (problems.length) throw new Error(`Reel rejected before upload: ${problems.join(", ")}`);

post.reel = {
  file: `${post.id}.mp4`,
  beats: script.beats,
  narration: script.narration,
  hasVoice: Boolean(audio),
  builtAt: new Date().toISOString(),
  status: "ready",
};
await writeQueue(queue);
setOutput(true);
console.log(`\nReel ready. Marked on ${post.id}.`);
