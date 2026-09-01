#!/usr/bin/env node
/**
 * The fast listener. Holds an open connection to Telegram and answers the
 * moment a message arrives, instead of waking on a schedule.
 *
 * GitHub only throttles `schedule:` triggers, not `workflow_dispatch`, so this
 * job runs for most of an hour and then dispatches its own successor. The
 * hourly cron stays purely as a resurrection path if that chain ever breaks.
 *
 *   LIVE_MINUTES=55 node src/cli-listen-live.js
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  botToken, readOffset, writeOffset, fetchUpdates, handleMessage, REPLAN,
} from "./inbox.js";
import { ROOT } from "./paths.js";

const run = promisify(execFile);

if (!botToken()) {
  console.log("TELEGRAM_BOT_TOKEN not set — nothing to listen to.");
  process.exit(0);
}

const minutes = Number(process.env.LIVE_MINUTES ?? 55);
const deadline = Date.now() + minutes * 60_000;
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 45);

console.log(`listening for ${minutes} minutes (long poll ${POLL_SECONDS}s)…`);
let handled = 0;

while (Date.now() < deadline) {
  let updates = [];
  try {
    updates = await fetchUpdates(await readOffset(), POLL_SECONDS);
  } catch (err) {
    // A dropped long poll is normal; wait a beat rather than spinning.
    console.warn(`poll: ${err.message}`);
    await sleep(3000);
    continue;
  }

  if (!updates.length) continue;

  const started = Date.now();
  let changed = false;
  let replan = false;
  let newOffset = await readOffset();

  for (const u of updates) {
    newOffset = Math.max(newOffset, u.update_id + 1);
    const msg = u.message;
    if (!msg?.text) continue;

    const sentAt = msg.date * 1000;
    try {
      const r = await handleMessage(msg.text, msg.chat.id);
      changed ||= r.changed;
      replan ||= r.replan;
      handled++;
      console.log(
        `[${r.kind}] "${msg.text.slice(0, 50)}" — answered in ${((Date.now() - sentAt) / 1000).toFixed(1)}s`
      );
    } catch (err) {
      console.error(`handling failed: ${err.message}`);
    }
  }

  await writeOffset(newOffset);

  // Persist immediately: a watcher that dies must not lose an instruction.
  if (changed || newOffset) await commitState();
  if (replan) await triggerReplan();

  console.log(`  batch done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

console.log(`\nshift over — handled ${handled} message(s)`);
await relaunch();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function git(args) {
  try {
    await run("git", args, { cwd: ROOT });
    return true;
  } catch (err) {
    console.warn(`git ${args[0]}: ${String(err.stderr ?? err.message).slice(0, 160)}`);
    return false;
  }
}

async function commitState() {
  if (!process.env.GITHUB_ACTIONS) return;
  await git(["config", "user.name", "social-autopilot"]);
  await git(["config", "user.email", "actions@users.noreply.github.com"]);
  await git(["add", "-A", "state"]);
  try {
    await run("git", ["diff", "--staged", "--quiet"], { cwd: ROOT });
    return; // nothing staged
  } catch {
    // there are staged changes — carry on
  }
  await git(["commit", "-m", "chore: from Telegram [skip ci]"]);
  await git(["pull", "--rebase", "--autostash"]);
  await git(["push"]);
}

/** A routine change is only real once the schedule is rebuilt. */
async function triggerReplan() {
  if (!process.env.GITHUB_ACTIONS) {
    console.log("(replan requested — would dispatch plan-week)");
    return;
  }
  if (existsSync(path.join(ROOT, "state", "REPLAN"))) {
    await git(["rm", "-f", "--quiet", "state/REPLAN"]).catch(() => {});
    await commitState();
  }
  await run("gh", ["workflow", "run", "plan-week", "--field", "replace=1"], { cwd: ROOT })
    .then(() => console.log("  dispatched plan-week"))
    .catch((e) => console.warn(`  replan dispatch failed: ${e.message}`));
}

/**
 * Hand off to a fresh run. workflow_dispatch is not throttled, so the chain has
 * no gap — unlike the schedule that created the 45-minute wait in the first place.
 */
async function relaunch() {
  if (!process.env.GITHUB_ACTIONS || process.env.NO_RELAUNCH === "1") return;
  try {
    await run("gh", ["workflow", "run", "listen-live"], { cwd: ROOT });
    console.log("handed off to the next shift");
  } catch (err) {
    console.warn(`relaunch failed (the hourly cron will recover): ${err.message}`);
  }
}
