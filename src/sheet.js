/**
 * Google Sheet as the human review surface.
 *
 * Two-way: the queue is pushed to the Sheet, and whatever you type in the Status
 * column is pulled back into the queue. Edit it from your phone; the pipeline obeys.
 *
 * Auth is a service account, signed here with node:crypto so there is no dependency.
 * Set GOOGLE_SERVICE_ACCOUNT_JSON (the whole JSON, or a path to it) and SHEET_ID.
 */
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/**
 * Which tab to use. Prefers SHEET_TAB, falls back to whatever the first tab is
 * actually called — a fresh Sheet is "Sheet1", and making the user rename it is
 * a pointless setup step.
 */
let TAB_CACHE = null;
async function tab() {
  if (TAB_CACHE) return TAB_CACHE;
  const meta = await sheets("?fields=sheets.properties.title");
  const titles = (meta.sheets ?? []).map((s) => s.properties.title);
  const wanted = process.env.SHEET_TAB;
  TAB_CACHE = wanted && titles.includes(wanted) ? wanted : titles[0];
  if (!TAB_CACHE) throw new Error("The spreadsheet has no tabs");
  return TAB_CACHE;
}

export const HEADERS = [
  "Date", "Status", "Pillar", "Lang", "Headline", "Caption", "Poster", "Posted IDs", "ID",
];

export function sheetConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.SHEET_ID);
}

async function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const json = raw.trim().startsWith("{")
    ? raw
    : existsSync(raw)
      ? await readFile(raw, "utf8")
      : (() => { throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is neither JSON nor a readable path`); })();
  return JSON.parse(json);
}

/** Service-account JWT -> OAuth access token. */
async function accessToken() {
  const creds = await credentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(creds.private_key));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`Sheets auth failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json.access_token;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sheets(pathAndQuery, init = {}) {
  const token = await accessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${process.env.SHEET_ID}${pathAndQuery}`,
    { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } }
  );
  const json = await res.json();
  if (json.error) throw new Error(`Sheets: ${json.error.message}`);
  return json;
}

/** Push the queue to the Sheet, newest last. Overwrites the whole tab. */
export async function pushQueue(queue, assetBase = "") {
  const TAB = await tab();
  const rows = queue.map((p) => [
    p.scheduledFor?.slice(0, 10) ?? "",
    p.status ?? "",
    p.pillar ?? "",
    p.language ?? "",
    p.headline ?? "",
    p.caption ?? "",
    assetBase ? `${assetBase}/${p.id}.png` : "",
    (p.postIds ?? []).join(" "),
    p.id,
  ]);

  await sheets(`/values/${encodeURIComponent(`${TAB}!A1:I1000`)}:clear`, { method: "POST", body: "{}" });
  await sheets(
    `/values/${encodeURIComponent(`${TAB}!A1`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [HEADERS, ...rows] }) }
  );
  return rows.length;
}

/**
 * Read the Status column back. Returns { id: status } for rows a human changed.
 * Only statuses the pipeline understands are honoured — a typo is ignored rather
 * than silently turning into "do not post".
 */
const VALID = new Set(["pending", "approved", "reject", "needs-review", "posted"]);

export async function pullStatuses() {
  const TAB = await tab();
  const json = await sheets(`/values/${encodeURIComponent(`${TAB}!A2:I1000`)}`);
  const out = {};
  for (const row of json.values ?? []) {
    const status = (row[1] ?? "").trim().toLowerCase();
    const id = (row[8] ?? "").trim();
    if (id && VALID.has(status)) out[id] = status;
  }
  return out;
}
