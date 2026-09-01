#!/usr/bin/env node
/**
 * The smoke test the dashboard dispatches after credentials land.
 *
 * Checks what is actually wired, calls nothing that posts, and reports the
 * result upward so the admin sees it on the tenant Overview rather than in a
 * runner log.
 *
 * Exits non-zero when something REQUIRED is broken, so the Actions run goes red
 * too — a smoke test that always passes is not a smoke test.
 *
 *   node src/cli-verify.js
 */
import { graphGet } from "./graph.js";
import { license, report, controlConfigured } from "./control.js";
import { TRANSPORT, availablePlatforms } from "./publish/index.js";
import { brands, metricoolConfigured } from "./metricool/api.js";

const startedAt = new Date().toISOString();
const checks = [];

/** @param {string} name @param {boolean} required @param {() => Promise<string>} fn */
async function check(name, required, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, required, detail });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    checks.push({ name, ok: false, required, detail: err.message });
    console.log(`  ${required ? "FAIL " : "warn "} ${name} — ${err.message}`);
  }
}

console.log("Alice verify\n");

await check("environment", true, async () => {
  // What is required depends on the transport. A Metricool tenant has no Meta
  // credentials at all, and demanding them would fail a healthy install.
  const required =
    TRANSPORT === "metricool"
      ? ["PUBLIC_ASSET_BASE", "METRICOOL_USER_TOKEN", "METRICOOL_USER_ID", "METRICOOL_BLOG_ID"]
      : ["PUBLIC_ASSET_BASE", "FB_PAGE_ID", "FB_PAGE_ACCESS_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  return `transport ${TRANSPORT}, ${required.length} required variables present`;
});

await check("networks", false, async () => {
  const p = availablePlatforms();
  return `${p.length} reachable: ${p.join(", ")}`;
});

await check("licence", false, async () => {
  const lic = await license();
  if (!controlConfigured()) return "unmanaged — no control plane configured";
  if (!lic.active) throw new Error(lic.reason ?? `not active (${lic.source})`);
  return `${lic.tier ?? "active"} via ${lic.source}`;
});

await check("brand", true, async () => {
  if (TRANSPORT === "metricool") {
    if (!metricoolConfigured()) throw new Error("Metricool credentials are incomplete");
    const list = await brands();
    const id = String(process.env.METRICOOL_BLOG_ID);
    const mine = list.find((b) => String(b.id ?? b.blogId) === id);
    // A wrong blogId is the one mistake that posts a client's content to
    // another client's account, so it is confirmed rather than assumed.
    if (!mine) throw new Error(`blogId ${id} is not among the ${list.length} brand(s) this token can see`);
    return `${mine.label ?? mine.name ?? "brand"} (${id})`;
  }
  const me = await graphGet("me", {
    fields: "id,name",
    access_token: process.env.FB_PAGE_ACCESS_TOKEN,
  });
  return `${me.name} (${me.id})`;
});

await check("instagram", false, async () => {
  if (TRANSPORT === "metricool") return "covered by the Metricool brand";
  if (!process.env.IG_USER_ID) throw new Error("IG_USER_ID not set");
  const ig = await graphGet(process.env.IG_USER_ID, {
    fields: "username",
    access_token: process.env.FB_PAGE_ACCESS_TOKEN,
  });
  return `@${ig.username}`;
});

await check("asset host", true, async () => {
  const base = (process.env.PUBLIC_ASSET_BASE ?? "").replace(/\/$/, "");
  const res = await fetch(base, { method: "HEAD" });
  // 404 is fine: Pages is answering, there is simply no index page yet.
  if (res.status >= 500) throw new Error(`${base} returned ${res.status}`);
  return `${base} answering (${res.status})`;
});

await check("brain", false, async () => {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error("neither GEMINI_API_KEY nor GROQ_API_KEY is set");
  }
  return process.env.GEMINI_API_KEY ? "Gemini configured" : "Groq only";
});

await check("telegram", false, async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error("no chat bound yet");
  return "bot and chat configured";
});

const failed = checks.filter((c) => !c.ok && c.required);
const warned = checks.filter((c) => !c.ok && !c.required);
const summary =
  `${checks.filter((c) => c.ok).length}/${checks.length} checks passed` +
  (warned.length ? `, ${warned.length} warning(s)` : "");

console.log(`\n${summary}`);

await report("verify", {
  ok: failed.length === 0,
  startedAt,
  summary,
  ...(failed.length ? { error: failed.map((f) => `${f.name}: ${f.detail}`).join(" · ") } : {}),
});

// exitCode rather than process.exit(): the report above may still have a socket
// in flight, and killing the process under it aborts the very thing that tells
// the dashboard what went wrong.
if (failed.length) process.exitCode = 1;
