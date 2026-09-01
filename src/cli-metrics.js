#!/usr/bin/env node
/**
 * Pull reach/engagement for everything posted, and write the top performers to
 * state/top-performers.json — the brain reads that file so the writing improves
 * instead of drifting.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readHistory, readQueue } from "./queue.js";
import { ROOT } from "./paths.js";

const token = process.env.FB_PAGE_ACCESS_TOKEN;
if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");

const history = await readHistory();
const queue = await readQueue();
const byId = new Map(queue.map((q) => [q.id, q]));
const scored = [];

for (const h of history) {
  try {
    const stats = h.platform === "facebook"
      ? await facebookStats(h.postId)
      : await instagramStats(h.postId);
    const post = byId.get(h.id);
    scored.push({
      id: h.id,
      platform: h.platform,
      pillar: post?.pillar,
      headline: post?.headline,
      ...stats,
    });
  } catch (err) {
    console.warn(`${h.platform} ${h.postId}: ${err.message}`);
  }
}

// One post is two rows (Facebook + Instagram) — combine them so a single idea
// is ranked once, on its total reach across both platforms.
const merged = new Map();
for (const s of scored) {
  const prev = merged.get(s.id);
  if (prev) {
    prev.engagement += s.engagement ?? 0;
    prev.platforms.push(s.platform);
  } else {
    merged.set(s.id, { ...s, engagement: s.engagement ?? 0, platforms: [s.platform] });
  }
}
const top = [...merged.values()]
  .sort((a, b) => b.engagement - a.engagement)
  .slice(0, 5)
  .filter((s) => s.headline);

await writeFile(path.join(ROOT, "state", "top-performers.json"), JSON.stringify(top, null, 2));

// Per-pillar averages: this is what makes pillar selection self-tuning.
const byPillar = {};
for (const s of merged.values()) {
  if (!s.pillar) continue;
  (byPillar[s.pillar] ??= []).push(s.engagement);
}
const pillarScores = Object.fromEntries(
  Object.entries(byPillar).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])
);
await writeFile(path.join(ROOT, "state", "pillar-scores.json"), JSON.stringify(pillarScores, null, 2));
console.log(`scored ${scored.length} posts, wrote ${top.length} top performers`);
for (const t of top) console.log(`  ${t.engagement} (${t.platforms.join("+")}) — [${t.pillar}] ${t.headline}`);

async function facebookStats(postId) {
  const j = await get(`${postId}?fields=likes.summary(true),comments.summary(true),shares`);
  const likes = j.likes?.summary?.total_count ?? 0;
  const comments = j.comments?.summary?.total_count ?? 0;
  const shares = j.shares?.count ?? 0;
  return { likes, comments, shares, engagement: likes + comments * 2 + shares * 3 };
}

async function instagramStats(mediaId) {
  const j = await get(`${mediaId}?fields=like_count,comments_count`);
  const likes = j.like_count ?? 0;
  const comments = j.comments_count ?? 0;
  return { likes, comments, engagement: likes + comments * 2 };
}

async function get(edge) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${edge}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}
