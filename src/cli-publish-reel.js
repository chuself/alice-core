#!/usr/bin/env node
/**
 * Publish a built reel to Instagram Reels and the Facebook Page.
 *
 * The MP4 must already be live at PUBLIC_ASSET_BASE — both platforms fetch the
 * file server-side, exactly like the posters.
 */
import path from "node:path";
import { readQueue, writeQueue } from "./queue.js";
import { publishInstagramReel, publishFacebookVideo } from "./publish/reels.js";
import { publishTikTok, tiktokConfigured } from "./publish/tiktok.js";
import { ctaLink } from "./brain.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isPaused, isDryRun } from "./guards.js";
import { notify, sendVideo } from "./notify.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

const dryRun = isDryRun();

if (isPaused()) {
  console.log("PAUSED file present — nothing published.");
  process.exit(0);
}

const base = (process.env.PUBLIC_ASSET_BASE ?? "").replace(/\/$/, "");
if (!base) throw new Error("PUBLIC_ASSET_BASE is not set");

const queue = await readQueue();
// Same empty-string trap as cli-reel.js — "" is not null, so ?? would keep it.
const wanted = process.argv[2]?.trim() || null;
const post =
  (wanted ? queue.find((p) => p.id === wanted) : null) ??
  queue.find((p) => p.reel?.status === "ready");

if (!post) {
  console.log("No reel ready to publish.");
  process.exit(0);
}

const videoUrl = `${base}/${post.reel.file}`;
console.log(`Publishing reel: ${post.headline}`);
console.log(`  ${videoUrl}`);

// Both platforms fetch the file themselves — if it is not live, stop here
// rather than letting the platform fail opaquely minutes later.
if (!dryRun) {
  const head = await fetch(videoUrl, { method: "HEAD" });
  const type = head.headers.get("content-type") ?? "";
  if (!head.ok || !type.startsWith("video/")) {
    throw new Error(`Reel not reachable as video (${head.status}, ${type}): ${videoUrl}`);
  }
  console.log(`  reachable: ${head.status} ${type}`);
}

const brand = JSON.parse(
  await readFile(path.join(ROOT, "brands", post.brand ?? DEFAULT_BRAND, "brand.json"), "utf8")
);
const caption = [post.caption, ctaLink(brand, post.id), (post.hashtags ?? []).join(" ")]
  .filter(Boolean)
  .join("\n\n");

const results = [];
for (const [name, fn] of [
  ["instagram", publishInstagramReel],
  ["facebook", publishFacebookVideo],
]) {
  try {
    const r = await fn({ videoUrl, caption, dryRun });
    console.log(`  posted to ${name}: ${r.postId}`);
    results.push({ ...r, id: post.id, format: "reel", postedAt: new Date().toISOString() });
  } catch (err) {
    // One platform failing must never stop the other.
    console.error(`  FAILED ${name}: ${err.message}`);
  }
}

if (!dryRun && results.length) {
  post.reel.status = "posted";
  // Close the slot so nothing else picks it up.
  if (post.format === "reel") post.status = "posted";
  post.reel.postedAt = new Date().toISOString();
  post.reel.postIds = results.map((r) => `${r.platform}:${r.postId}`);
  await writeQueue(queue);

  const historyPath = path.join(ROOT, "state", "history.json");
  const history = existsSync(historyPath)
    ? JSON.parse(await readFile(historyPath, "utf8"))
    : [];
  history.push(...results);
  await writeFile(historyPath, JSON.stringify(history.slice(-200), null, 2));

  await notify(
    `🎬 <b>Reel posted</b>\n${post.headline}\n\n${results.map((r) => `${r.platform}: ${r.postId}`).join("\n")}`
  );
}

// TikTok goes through Metricool, which is already TikTok-audited, so the post is
// public without an audit of our own. Runs after the Meta legs so a TikTok
// problem can never cost us Instagram and Facebook.
if (!dryRun && tiktokConfigured()) {
  try {
    const r = await publishTikTok({ videoUrl, caption, dryRun });
    console.log(`  queued on tiktok for ${r.scheduledFor}`);
    await notify(`📱 <b>TikTok</b> queued for ${r.scheduledFor}\n${post.headline}`, { mirror: false });

    const historyPath = path.join(ROOT, "state", "history.json");
    const history = existsSync(historyPath)
      ? JSON.parse(await readFile(historyPath, "utf8"))
      : [];
    history.push({ ...r, id: post.id, format: "reel", postedAt: new Date().toISOString() });
    await writeFile(historyPath, JSON.stringify(history.slice(-200), null, 2));
  } catch (err) {
    console.error(`  TikTok failed: ${err.message}`);
    await notify(
      `⚠️ TikTok scheduling failed — the video is below to post by hand.\n<code>${err.message.slice(0, 200)}</code>`
    );
  }
} else if (!dryRun) {
  console.log("  tiktok not configured — skipping");
}

// Belt and braces: the finished file also comes to you ready to upload, so a
// TikTok failure or the monthly cap never blocks the content.
if (!dryRun && process.env.TIKTOK_HANDOFF !== "0") {
  const tags = (post.hashtags ?? []).join(" ");
  await sendVideo(
    videoUrl,
    `📱 <b>For TikTok</b> — tap and upload\n\n${post.caption ?? post.headline}\n\n${tags}`
  );
}

console.log(dryRun ? "\nDRY RUN — nothing was posted." : "\ndone.");
