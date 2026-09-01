/**
 * The engine's only link to the control plane (Alice Fleet).
 *
 * Four jobs: ask permission to run, report what happened, mirror the queue so
 * the dashboard can render it, and send leads somewhere private.
 *
 * Two rules govern everything here:
 *
 *  1. **Never throw upward.** A control-plane problem must never fail a run
 *     that otherwise worked. Every function returns a value and logs; only
 *     `assertLicensed` in guards.js deliberately stops the line.
 *  2. **Fail open, within a grace window.** If the control plane is
 *     unreachable, the engine keeps running on the last good licence for
 *     GRACE_HOURS. Our outage must never silence a paying account — and the
 *     window is short enough that a non-payer cannot simply wait us out.
 *
 * Unconfigured (no CONTROL_URL) means unmanaged: the engine behaves exactly as
 * it did before the platform existed. That is what keeps Operra — tenant #0 —
 * working while the fleet is built around it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const CACHE = path.join(ROOT, "state", "license.json");

const GRACE_HOURS = 72;
const TIMEOUT_MS = 10_000;

export function controlConfigured() {
  return Boolean(process.env.CONTROL_URL && process.env.TENANT_ID);
}

function endpoint(name) {
  return `${process.env.CONTROL_URL.replace(/\/$/, "")}/api/public/${name}`;
}

function headers() {
  return {
    "content-type": "application/json",
    "x-alice-engine-secret": process.env.ALICE_ENGINE_SECRET ?? "",
  };
}

async function call(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, headers: headers(), signal: controller.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timer);
  }
}

/* ── licence ──────────────────────────────────────────────────────────────── */

/**
 * Ask whether this tenant may act.
 *
 * @returns {Promise<{active: boolean, tier?: string, limits?: object,
 *                    until?: string, source: string, reason?: string}>}
 *   source: 'live' | 'cache' | 'unmanaged' | 'expired'
 */
export async function license() {
  if (!controlConfigured()) {
    return { active: true, source: "unmanaged" };
  }

  try {
    const fresh = await call(`${endpoint("license")}?tenant=${process.env.TENANT_ID}`);
    await cacheLicense(fresh);
    return { ...fresh, source: "live" };
  } catch (err) {
    console.warn(`control: licence check failed — ${err.message}`);
    return fallbackLicense(err);
  }
}

async function cacheLicense(payload) {
  try {
    await mkdir(path.dirname(CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), payload }, null, 2));
  } catch (err) {
    console.warn(`control: could not cache the licence — ${err.message}`);
  }
}

/**
 * The grace window. Note this only works if state/license.json is committed by
 * the workflow — without it every run starts with an empty cache and a control
 * outage would stop the line immediately, which is the opposite of the intent.
 */
async function fallbackLicense(err) {
  if (!existsSync(CACHE)) {
    return { active: false, source: "expired", reason: `no cached licence (${err.message})` };
  }
  let cached;
  try {
    cached = JSON.parse(await readFile(CACHE, "utf8"));
  } catch {
    return { active: false, source: "expired", reason: "cached licence unreadable" };
  }

  const ageHours = (Date.now() - new Date(cached.fetchedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > GRACE_HOURS) {
    return {
      active: false,
      source: "expired",
      reason: `cached licence is ${Math.round(ageHours)}h old, grace is ${GRACE_HOURS}h`,
    };
  }

  console.warn(`control: running on a cached licence, ${Math.round(ageHours)}h old`);
  return { ...cached.payload, source: "cache" };
}

/** Plan ceilings, for config.js. Falls back to the cached licence. */
export async function limits() {
  const lic = await license();
  return lic.limits ?? null;
}

/* ── reporting ────────────────────────────────────────────────────────────── */

async function post(kind, payload) {
  if (!controlConfigured()) return { ok: false, skipped: "unmanaged" };
  try {
    return await call(endpoint("ingest"), {
      method: "POST",
      body: JSON.stringify({ tenant_id: process.env.TENANT_ID, kind, payload }),
    });
  } catch (err) {
    // Swallowed on purpose: a failed report must never fail the run it reports.
    console.warn(`control: ${kind} report failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Record one workflow run. Call it in a `finally`, so a crashed run is still
 * reported — an unreported failure looks identical to a job that never ran.
 */
export async function report(workflow, { ok, startedAt, summary, error } = {}) {
  return post("run", {
    workflow,
    started_at: startedAt ?? new Date().toISOString(),
    finished_at: new Date().toISOString(),
    ok: ok !== false,
    summary: summary ?? null,
    error: error ? String(error).slice(0, 1000) : null,
    log_url: runUrl(),
  });
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL ?? "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** Mirror the queue so the Preview tab has something to render. */
export async function mirrorPosts(queue, assetBase = process.env.PUBLIC_ASSET_BASE) {
  if (!queue?.length) return { ok: true, skipped: "empty" };
  return post(
    "posts",
    queue.map((p) => ({
      post_id: p.id,
      pillar: p.pillar ?? null,
      format: p.format ?? "poster",
      language: p.language ?? null,
      scheduled_for: p.scheduledFor ?? null,
      status: p.status ?? "pending",
      hold_reason: p.holdReason ?? p.needsReviewReason ?? null,
      headline: p.headline ?? null,
      caption: p.caption ?? null,
      asset_url: p.assetUrl ?? (assetBase && p.asset ? `${assetBase}/${p.asset}` : null),
      permalink: p.permalink ?? null,
    })),
  );
}

/**
 * Leads go up, and are never committed. A client's buying signals — with the
 * commenter's words and a permalink to them — must not sit in a public repo.
 */
export async function pushLeads(leads) {
  if (!leads?.length) return { ok: true, skipped: "empty" };
  return post(
    "leads",
    leads.map((l) => ({
      platform: l.platform ?? null,
      text: l.text ?? null,
      note: l.note ?? null,
      permalink: l.permalink ?? null,
      seen_at: l.seenAt ?? new Date().toISOString(),
    })),
  );
}

/* ── decisions ────────────────────────────────────────────────────────────── */

/**
 * Approvals and rejections made in the dashboard. Replaces sheet.js at the same
 * seam: publish calls this at the top of its run.
 *
 * @returns {Promise<Map<string, {decision: string, note: string|null}>>}
 *   keyed by post id. Empty map when unmanaged or unreachable — silence must
 *   never be read as rejection.
 */
export async function decisions() {
  if (!controlConfigured()) return new Map();
  try {
    const body = await call(`${endpoint("decisions")}?tenant=${process.env.TENANT_ID}`);
    return new Map(
      (body.decisions ?? []).map((d) => [d.post_id, { decision: d.decision, note: d.decision_note }]),
    );
  } catch (err) {
    console.warn(`control: could not read decisions — ${err.message}`);
    return new Map();
  }
}
