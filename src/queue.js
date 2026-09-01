import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const QUEUE = path.join(ROOT, "state", "queue.json");
const HISTORY = path.join(ROOT, "state", "history.json");

export async function readQueue() {
  if (!existsSync(QUEUE)) return [];
  return JSON.parse(await readFile(QUEUE, "utf8"));
}

export async function writeQueue(queue) {
  await writeFile(QUEUE, JSON.stringify(queue, null, 2));
}

export async function readHistory() {
  if (!existsSync(HISTORY)) return [];
  return JSON.parse(await readFile(HISTORY, "utf8"));
}

/** What the brain is shown so it does not repeat itself: newest first. */
export async function recentPosts(limit = 60) {
  const queue = await readQueue();
  return [...queue].reverse().slice(0, limit);
}

/**
 * Posts that are due and cleared to go out.
 *
 * A `pending` post publishes at its scheduled time. The review window is the
 * gap between planning and the slot itself — an extra countdown on top of that
 * silently pushed same-week posts past their slot, which is exactly what
 * happened to the first 08:00 run.
 *
 * `needs-review` (an unapproved figure) never auto-publishes; a human decides.
 */
export function duePosts(queue, now = new Date()) {
  return queue.filter((p) => {
    if (p.status === "posted" || p.status === "reject" || p.status === "needs-review") return false;
    // Reel slots are filmed and published by the reel pipeline. Publishing them
    // here too would post the same idea twice — once as video, once as a poster.
    if (p.format === "reel") return false;
    if (new Date(p.scheduledFor) > now) return false;
    return p.status === "pending" || p.status === "approved";
  });
}
