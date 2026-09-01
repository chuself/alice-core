#!/usr/bin/env node
/**
 * Token watchdog. A silently dead token is the classic way these pipelines fail,
 * so this shouts well before it happens.
 */
import { notify } from "./notify.js";

const token = process.env.FB_PAGE_ACCESS_TOKEN;
if (!token) {
  await notify("⚠️ <b>Social Autopilot</b>\nFB_PAGE_ACCESS_TOKEN is not set.");
  process.exit(1);
}

const res = await fetch(
  `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}`,
  { headers: { authorization: `Bearer ${token}` } }
);
const { data } = await res.json();

if (!data?.is_valid) {
  await notify(`🚨 <b>Social Autopilot — token is INVALID</b>\nPosting has stopped. Re-run scripts/exchange-token.js.`);
  process.exit(1);
}

const expires = data.expires_at;
if (!expires) {
  // No process.exit() here: an explicit exit while fetch keepalive handles are
  // still closing crashes Node on Windows and returns 127.
  console.log("token valid, no expiry — healthy");
} else {
  const days = Math.round((expires * 1000 - Date.now()) / 86400_000);
  console.log(`token valid, expires in ${days} days`);
  if (days <= 14) {
    await notify(`⏳ <b>Social Autopilot</b>\nPage token expires in <b>${days} days</b>. Re-run <code>scripts/exchange-token.js</code> before then.`);
  }
}
