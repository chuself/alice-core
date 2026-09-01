#!/usr/bin/env node
/**
 * Build one reel through HyperFrames.
 *
 *   node src/cli-reel-hf.js                 # the next eligible queued post
 *   node src/cli-reel-hf.js <post-id>
 *
 * Order matters and is not negotiable: the VOICE is recorded first, its real
 * duration is measured, and only then is the composition written. Alice's older
 * reel path learned this the hard way — a video built to a guessed length cuts
 * the closing line off, and no amount of animation polish hides it.
 *
 * Everything here is deterministic: same post, same audio, same frames.
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { writeReelScript } from "./brain.js";
import { speak } from "./audio.js";
import { probeVideo } from "./video.js";
import { readQueue, writeQueue } from "./queue.js";
import { composeReel } from "./reel/compose.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { assertLicensed } from "./guards.js";
import { report } from "./control.js";
import { ROOT } from "./paths.js";

const run = promisify(execFile);
const REEL = path.join(ROOT, "reel");
const startedAt = new Date().toISOString();

if (!(await assertLicensed("reel"))) {
  await report("reel", { ok: true, startedAt, summary: "skipped - subscription inactive" });
  process.exit(0);
}

const wanted = process.argv[2]?.trim() || null;
const queue = await readQueue();

const post =
  (wanted ? queue.find((p) => p.id === wanted) : null) ??
  queue.find((p) => p.format === "reel" && p.status !== "posted" && !p.reel?.file);

if (!post) {
  console.log("No reel to build.");
  process.exit(0);
}

console.log(`Reel for ${post.id}\n`);

const brand = JSON.parse(
  await readFile(path.join(ROOT, "brands", post.brand ?? DEFAULT_BRAND, "brand.json"), "utf8")
);

// 1. The script: 3-4 on-screen beats plus the narration that carries them.
const script = await writeReelScript(post, post.brand ?? DEFAULT_BRAND);
console.log(`  beats: ${script.beats.join(" / ")}`);

// 2. The voice, before anything visual exists.
await mkdir(path.join(REEL, "assets", "audio"), { recursive: true });
const audioPath = path.join(REEL, "assets", "audio", `${post.id}.mp3`);
const spoken = await speak(script.narration, audioPath, {
  language: post.language === "sw" ? "sw-TZ" : "en-US",
});
if (!spoken) throw new Error("no voiceover was produced — refusing to build a silent reel");

// 3. Its REAL length. Never the estimate.
const probed = await probeVideo(audioPath);
const audioDuration = Number(probed?.duration);
if (!(audioDuration > 0)) throw new Error(`could not measure ${audioPath}`);
console.log(`  narration: ${audioDuration.toFixed(2)}s`);

// 4. The background the poster already uses, so reel and poster agree.
let backgroundFile = null;
const bg = path.join(ROOT, "state", "bg", `${post.id}.png`);
if (existsSync(bg)) {
  await mkdir(path.join(REEL, "assets", "bg"), { recursive: true });
  const dest = path.join(REEL, "assets", "bg", `${post.id}.png`);
  await copyFile(bg, dest);
  backgroundFile = `assets/bg/${post.id}.png`;
}

// 5. The composition.
const { html, duration } = composeReel({
  beats: script.beats,
  brand,
  audioFile: `assets/audio/${post.id}.mp3`,
  audioDuration,
  backgroundFile,
  look: post.look ? (brand.looks ?? []).find((l) => l.name === post.look) : null,
});
await writeFile(path.join(REEL, "index.html"), html);
console.log(`  composition: ${duration.toFixed(2)}s`);

// 6. Check before render. A failed check is cheap; a failed render is minutes.
try {
  const { stdout } = await run("npx", ["--yes", "hyperframes", "check"], { cwd: REEL, shell: true });
  console.log(`  check: ${stdout.trim().split("\n").pop()}`);
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  throw new Error(`hyperframes check failed:\n${out.slice(-1500)}`);
}

// 7. Render.
const outFile = path.join(ROOT, "public", `${post.id}.mp4`);
await mkdir(path.dirname(outFile), { recursive: true });
await run("npx", ["--yes", "hyperframes", "render", "--output", outFile], {
  cwd: REEL,
  shell: true,
  maxBuffer: 1024 * 1024 * 32,
});

const final = await probeVideo(outFile);
console.log(`\nRendered ${path.basename(outFile)} — ${final?.duration}s, ${final?.width}x${final?.height}`);

post.reel = {
  file: `${post.id}.mp4`,
  engine: "hyperframes",
  beats: script.beats,
  narration: script.narration,
  duration: Number(final?.duration ?? duration),
  builtAt: new Date().toISOString(),
  status: "ready",
};
await writeQueue(queue);

await report("reel", {
  ok: true,
  startedAt,
  summary: `${post.id} rendered, ${Number(final?.duration ?? duration).toFixed(1)}s`,
});
