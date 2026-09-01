#!/usr/bin/env node
/**
 * Publish every queued post that is due and cleared.
 *
 *   node src/cli-publish.js                       # queue mode
 *   node src/cli-publish.js state/sample-post.json # one specific post
 *
 * The poster PNG must already be rendered AND live at PUBLIC_ASSET_BASE —
 * Instagram fetches the image URL server-side, so publishing first always fails.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { publisherFor } from "./publish/index.js";
import { ctaLink } from "./brain.js";
import { TRANSPORT } from "./publish/index.js";
import { commentOn } from "./publish/comment.js";
import { readFile as readFileAsync } from "node:fs/promises";
import { readQueue, writeQueue, duePosts } from "./queue.js";
import {
  isPaused, isDryRun, postedTodayCount, assertAssetReachable, maxPostsPerDay, assertLicensed,
} from "./guards.js";
import { decisions, report, mirrorPosts } from "./control.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

const dryRun = isDryRun();
const startedAt = new Date().toISOString();

if (isPaused()) {
  console.log("PAUSED file present — nothing published.");
  process.exit(0);
}

if (!(await assertLicensed("publish"))) {
  await report("publish", { ok: true, startedAt, summary: "skipped - subscription inactive" });
  process.exit(0);
}

const base = (process.env.PUBLIC_ASSET_BASE ?? "").replace(/\/$/, "");
if (!base) throw new Error("PUBLIC_ASSET_BASE is not set — Instagram needs a public image URL");

const singleFile = process.argv[2];
const queue = singleFile ? null : await readQueue();
// Approvals and rejections from the dashboard, applied before anything is
// selected. Silence is never read as rejection: an unreachable control plane
// returns an empty map and the queue publishes on its own schedule.
if (queue) {
  const decided = await decisions();
  for (const row of queue) {
    const d = decided.get(row.id);
    if (!d || row.status === "posted") continue;
    if (d.decision === "reject" || d.decision === "regenerate") row.status = "reject";
    if (d.decision === "approve") {
      row.status = "approved";
      if (d.note) row.caption = d.note;
    }
  }
}

const posts = singleFile
  ? [JSON.parse(await readFile(path.resolve(ROOT, singleFile), "utf8"))]
  : duePosts(queue);

if (!posts.length) {
  // A decision above may still have changed the queue, so persist it before
  // leaving - otherwise a rejection is silently forgotten.
  if (queue && !dryRun) await writeQueue(queue);
  await report("publish", { ok: true, startedAt, summary: "nothing due" });
  console.log("Nothing due.");
  process.exit(0);
}

/** Our own comments must never be triaged as if a customer wrote them. */
async function rememberOurComment(id) {
  const file = path.join(ROOT, "state", "our-comments.json");
  let ids = [];
  if (existsSync(file)) {
    try {
      ids = JSON.parse(await readFile(file, "utf8"));
    } catch {
      ids = [];
    }
  }
  if (ids.includes(id)) return;
  ids.push(id);
  await writeFile(file, JSON.stringify(ids.slice(-2000), null, 2));
}

const dailyCap = await maxPostsPerDay();
const history = existsSync(path.join(ROOT, "state", "history.json"))
  ? JSON.parse(await readFile(path.join(ROOT, "state", "history.json"), "utf8"))
  : [];

for (const post of posts) {
  console.log(`\n--- ${post.id}`);
  const imageUrl = `${base}/${post.id}.png`;

  if (!existsSync(path.join(ROOT, "public", `${post.id}.png`))) {
    console.error(`  no rendered asset — skipped`);
    continue;
  }
  if (!dryRun) {
    try {
      await assertAssetReachable(imageUrl);
    } catch (err) {
      console.error(`  ${err.message} — skipped`);
      continue;
    }
  }

  // The link is appended at send time, not written into the queue, so changing
  // the WhatsApp number never means regenerating a week of posts.
  const brand = JSON.parse(
    await readFileAsync(path.join(ROOT, "brands", post.brand ?? DEFAULT_BRAND, "brand.json"), "utf8")
  );
  // The CTA link goes in the FIRST COMMENT rather than the caption: a caption
  // link is widely observed to suppress reach, and it is still one tap away.
  // Metricool carries firstCommentText natively, so the trick survives the
  // transport switch.
  const link = ctaLink(brand, post.id);
  const caption = [post.caption, (post.hashtags ?? []).join(" ")]
    .filter(Boolean)
    .join("\n\n");
  const results = [];

  for (const platform of post.platforms ?? []) {
    const already = await postedTodayCount(platform);
    if (already >= dailyCap) {
      console.log(`  skip ${platform}: daily cap reached (${already})`);
      continue;
    }
    try {
      const result = await publisherFor(platform).publish({
        imageUrl,
        caption,
        firstComment: link,
        // The slot, not "now": Metricool schedules, so it must be told when.
        when: post.scheduledFor ? new Date(post.scheduledFor) : null,
        dryRun,
      });
      console.log(`  posted to ${platform}: ${result.postId}`);

      // Metricool attaches the first comment itself; Graph has no such field,
      // so it is written here. Never fatal: the post is already out, and a
      // missing link is worth a warning, not a failed run.
      if (TRANSPORT === "graph" && link && result.postId && result.postId !== "dry-run") {
        try {
          const cid = await commentOn(result.postId, link, { dryRun });
          if (cid) await rememberOurComment(cid);
        } catch (err) {
          console.warn(`  first comment failed on ${platform}: ${err.message.slice(0, 120)}`);
        }
      }
      results.push({ ...result, id: post.id, postedAt: new Date().toISOString() });
    } catch (err) {
      // One platform failing must never stop the others.
      console.error(`  FAILED ${platform}: ${err.message}`);
    }
  }

  if (!dryRun && results.length) {
    history.push(...results);
    if (queue) {
      const row = queue.find((q) => q.id === post.id);
      if (row) {
        row.status = "posted";
        row.postedAt = new Date().toISOString();
        row.postIds = results.map((r) => `${r.platform}:${r.postId}`);
      }
    }
  }
}

if (!dryRun) {
  await writeFile(path.join(ROOT, "state", "history.json"), JSON.stringify(history.slice(-200), null, 2));
  if (queue) await writeQueue(queue);
}

console.log(dryRun ? "\nDRY RUN — nothing was actually posted." : "\ndone.");
