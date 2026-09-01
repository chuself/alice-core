import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readConfig } from "./config.js";
import { license } from "./control.js";
import { ROOT } from "./paths.js";


/**
 * The subscription gate. Every acting job asks before it does anything.
 *
 * Three ways through: an active licence, a cached licence inside the 72-hour
 * grace window, or no control plane at all — an unmanaged install, which is how
 * this engine behaves whenever CONTROL_URL is unset.
 *
 * Suspension stops publishing, not planning: the queue keeps filling so that
 * paying restores the feed instantly. Jobs that only write to the queue pass
 * { planning: true }.
 *
 * @returns {Promise<boolean>} true if the caller should continue.
 */
export async function assertLicensed(workflow, { planning = false } = {}) {
  const lic = await license();

  if (lic.active || lic.source === "unmanaged") {
    if (lic.source === "cache") {
      console.warn(`licence: serving ${workflow} from cache — control plane unreachable`);
    }
    return true;
  }

  if (planning) {
    console.warn(`licence: inactive, but ${workflow} only plans — continuing`);
    return true;
  }

  console.error(
    `licence: ${workflow} refused — ${lic.reason ?? `subscription is not active (${lic.source})`}`,
  );
  return false;
}

/**
 * Ceiling, not a target: the configured cadence plus one, so a retry or a
 * manual post still fits but a bug cannot spam the account.
 */
export async function maxPostsPerDay() {
  const { postsPerDay } = await readConfig();
  return Math.max(2, postsPerDay + 1);
}

/** Kill switch: `git commit` an empty state/PAUSED file to stop all publishing. */
export function isPaused() {
  return existsSync(path.join(ROOT, "state", "PAUSED"));
}

export function isDryRun() {
  return process.env.DRY_RUN === "1";
}

/** How many times this platform has already been posted to today. */
export async function postedTodayCount(platform) {
  const historyPath = path.join(ROOT, "state", "history.json");
  if (!existsSync(historyPath)) return 0;
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  return history.filter((h) => h.platform === platform && h.postedAt?.startsWith(today)).length;
}

/**
 * A post never goes out without a reachable asset — this is the check that stops
 * Instagram from silently publishing a broken container.
 */
export async function assertAssetReachable(imageUrl) {
  let res;
  try {
    res = await fetch(imageUrl, { method: "HEAD" });
  } catch (err) {
    throw new Error(`Asset unreachable: ${imageUrl} (${err.message})`);
  }
  if (!res.ok) throw new Error(`Asset returned ${res.status}: ${imageUrl}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`Asset is not an image (${type}): ${imageUrl}`);
}
