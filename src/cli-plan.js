#!/usr/bin/env node
/**
 * Plan a run of posts: brain writes the copy, a background is generated,
 * the poster is rendered, and each post lands in state/queue.json as `pending`.
 *
 *   MOCK_LLM=1 node src/cli-plan.js            # tomorrow, per state/config.json
 *   node src/cli-plan.js --days 3 --replace
 */
import path from "node:path";
import { writePost, nextPillar, findUnapprovedFigures } from "./brain.js";
import { generateBackground } from "./background.js";
import { renderPoster } from "./render.js";
import { readQueue, writeQueue, recentPosts } from "./queue.js";
import { readConfig } from "./config.js";
import { assertLicensed } from "./guards.js";
import { report, mirrorPosts } from "./control.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const EAT_OFFSET = 3; // Tanzania is UTC+3, no DST
const config = await readConfig();
// Days, not posts. Planning one day at a time means a change you make today is
// live tomorrow — no wasted week to throw away when you change your mind.
const days = Number(arg("days", 1));
const startedAt = new Date().toISOString();
// Planning is deliberately allowed while a subscription is lapsed: the queue
// keeps filling so paying restores the feed instantly.
if (!(await assertLicensed("plan", { planning: true }))) process.exit(0);
const brandId = arg("brand", DEFAULT_BRAND);
const start = arg("start") ? new Date(arg("start")) : new Date();
// Free-text steering for one run, e.g.
//   --note "push the new POS module, and sound urgent — high season starts next week"
const note = arg("note") ?? process.env.PLAN_NOTE ?? null;
const slots = arg("hours")
  ? arg("hours").split(",").map((h) => ({ hour: Number(h), format: "poster" }))
  : config.slots;

let queue = await readQueue();
// A routine change rebuilds the schedule rather than appending to the old one.
if (args.includes("--replace")) {
  const { unlinkSync, existsSync: exists } = await import("node:fs");
  const dropped = queue.filter((p) => p.status !== "posted");
  for (const p of dropped) {
    for (const f of [path.join(ROOT, "public", `${p.id}.png`), path.join(ROOT, "state", "bg", `${p.id}.png`)]) {
      if (exists(f)) unlinkSync(f);
    }
  }
  queue = queue.filter((p) => p.status === "posted");
  console.log(`--replace: dropped ${dropped.length} unposted row(s)`);
}
const planned = [];

// Written by cli-metrics.js from real engagement; absent on the first run.
const scoresPath = path.join(ROOT, "state", "pillar-scores.json");
const pillarScores = existsSync(scoresPath)
  ? JSON.parse(await readFile(scoresPath, "utf8"))
  : null;

// Build the timetable first, dropping anything already past — planning into the
// past means every one of them fires at once on the next publish run.
const timetable = [];
for (let day = 0; day < days; day++) {
  for (const slot of slots) {
    const when = new Date(start);
    when.setDate(when.getDate() + day);
    when.setUTCHours(slot.hour - EAT_OFFSET, 0, 0, 0);
    if (when > new Date()) timetable.push({ when, hour: slot.hour, format: slot.format });
  }
}
timetable.sort((a, b) => a.when - b.when);

// Never plan a slot that is already filled. Re-running the planner should be
// safe: without this it appends a second post to every slot it has seen before.
const taken = new Set(
  queue.filter((p) => p.status !== "posted" && p.status !== "reject").map((p) => p.scheduledFor)
);
const wanted = timetable.filter((t) => !taken.has(t.when.toISOString()));
if (wanted.length < timetable.length) {
  console.log(`${timetable.length - wanted.length} slot(s) already filled — skipping those`);
}
timetable.length = 0;
timetable.push(...wanted);

for (let n = 0; n < timetable.length; n++) {
  const { when, hour, format } = timetable[n];
  // Newest first — nextPillar() and the dedupe list both read position 0 as "last post".
  const recent = [...planned].reverse().concat(await recentPosts());
  const pillar = nextPillar(recent, pillarScores);

  let post;
  try {
    post = await writePost({ brandId, pillar, recent, note });
  } catch (err) {
    console.error(`slot ${n + 1} (${pillar}): brain failed — ${err.message}`);
    continue;
  }

  const scheduledFor = when;

  const id = `${brandId}-${scheduledFor.toISOString().slice(0, 10)}-${String(hour).padStart(2, "0")}-${pillar}`;

  // Held, not dropped: a human decides whether the figure is real.
  const figures = await findUnapprovedFigures(post, brandId);
  if (figures.length) {
    console.warn(`  ${id}: unapproved figures ${figures.join(", ")} — held for review`);
  }

  const bgPath = post.imagePrompt
    ? await generateBackground(post.imagePrompt, path.join(ROOT, "state", "bg", `${id}.png`))
    : null;

  const record = {
    id,
    ...post,
    // Relative to the repo root: an absolute runner path is meaningless anywhere else.
    backgroundPath: bgPath ? path.relative(ROOT, bgPath).split(path.sep).join("/") : null,
    format,
    platforms: ["facebook", "instagram"],
    scheduledFor: scheduledFor.toISOString(),
    createdAt: new Date().toISOString(),
    status: figures.length ? "needs-review" : "pending",
    heldFigures: figures.length ? figures : undefined,
  };

  await renderPoster(record, brandId, path.join(ROOT, "public", `${id}.png`));
  console.log(`planned ${id} [${format}] [${record.status}] — "${post.headline}"`);

  planned.push(record);
}

await writeQueue([...queue, ...planned]);
console.log(`\n${planned.length} post(s) queued. Review: state/queue.json`);
