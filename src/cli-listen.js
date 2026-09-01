#!/usr/bin/env node
/**
 * Safety-net inbox check: process whatever is waiting, once, then exit.
 *
 * The fast path is cli-listen-live.js, which long-polls and answers in seconds.
 * This runs on a schedule so a message still lands if that chain ever breaks.
 */
import { botToken, readOffset, writeOffset, fetchUpdates, handleMessage } from "./inbox.js";

if (!botToken()) {
  console.log("TELEGRAM_BOT_TOKEN not set — nothing to listen to.");
  process.exit(0);
}

const offset = await readOffset();
const updates = await fetchUpdates(offset, 0);

if (!updates.length) {
  console.log("no new messages");
  process.exit(0);
}

let newOffset = offset;
let replan = false;
let handled = 0;

for (const u of updates) {
  newOffset = Math.max(newOffset, u.update_id + 1);
  const msg = u.message;
  if (!msg?.text) continue;
  const r = await handleMessage(msg.text, msg.chat.id);
  replan ||= r.replan;
  handled++;
  console.log(`[${r.kind}] ${msg.text.slice(0, 60)}`);
}

await writeOffset(newOffset);
console.log(`processed ${updates.length} update(s), ${handled} message(s)`);
if (replan) console.log("REPLAN_REQUESTED");
