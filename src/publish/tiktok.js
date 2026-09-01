/**
 * TikTok, via Metricool's hosted MCP.
 *
 * TikTok's own Content Posting API only allows PUBLIC posts once your app passes
 * their audit; unaudited apps are forced to private. Metricool is already
 * audited, so scheduling through them posts publicly with no audit of our own —
 * and their MCP works on the free plan.
 *
 * Auth is OAuth 2.1: the owner approves once (scripts/metricool-auth.mjs) and we
 * mint access tokens from the stored refresh token thereafter.
 */
import { seal, unseal } from "../secretstore.js";

const MCP = "https://ai.metricool.com/mcp";
const TOKEN_URL = "https://app.metricool.com/oauth/token";

export const id = "tiktok";

export function tiktokConfigured() {
  return Boolean(
    (process.env.METRICOOL_KEY || process.env.METRICOOL_OAUTH) && process.env.METRICOOL_BLOG_ID
  );
}

/**
 * The sealed file is the source of truth once it exists, because it holds the
 * newest rotated token. METRICOOL_OAUTH is only the seed for the first run.
 */
async function credentials() {
  if (process.env.METRICOOL_KEY) {
    const sealed = await unseal("metricool").catch((err) => {
      throw new Error(`could not decrypt state/metricool.enc — wrong METRICOOL_KEY? (${err.message})`);
    });
    if (sealed?.refresh_token) return sealed;
  }
  const raw = process.env.METRICOOL_OAUTH;
  if (!raw) throw new Error("No Metricool credentials — run scripts/metricool-auth.mjs");
  const c = JSON.parse(raw);
  if (!c.refresh_token) throw new Error("stored Metricool credentials have no refresh_token");
  return c;
}

/**
 * Metricool ROTATES refresh tokens — each one works exactly once, and the
 * response carries its replacement. Losing that replacement bricks the
 * connection, so it is persisted immediately.
 */
async function accessToken() {
  const c = await credentials();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: c.refresh_token,
    client_id: c.client_id,
    resource: MCP,
  });
  if (c.client_secret) body.set("client_secret", c.client_secret);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(
      `Metricool token refresh failed (${json.error ?? res.status}). ` +
        `A rotated refresh token was probably lost — re-run scripts/metricool-auth.mjs.`
    );
  }
  if (json.refresh_token && json.refresh_token !== c.refresh_token) {
    await persistRefresh({ ...c, refresh_token: json.refresh_token });
  }
  return json.access_token;
}

/**
 * Where the replacement goes. Locally that is the file; in CI it must go back
 * into the secret, otherwise the next run starts with a dead token.
 */
async function persistRefresh(next) {
  if (process.env.METRICOOL_KEY) {
    await seal(next, "metricool");
    console.log("  rotated refresh token sealed to state/metricool.enc");
  }
  // Keep the local copy in step too, so this machine can still authorise.
  if (!process.env.GITHUB_ACTIONS) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(".metricool.json", JSON.stringify(next, null, 2));
    console.log("  rotated refresh token saved to .metricool.json");
  }
}

let rpcId = 0;

/**
 * MCP is JSON-RPC over HTTP. Responses may come back as SSE, so both shapes are
 * handled rather than assuming one.
 */
async function rpc(token, method, params, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(60_000),
  });

  const session = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 200)}`);
  if (!text.trim()) return { result: null, session };

  // SSE frames look like: event: message\ndata: {...}
  const payload = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;

  const json = JSON.parse(payload);
  if (json.error) throw new Error(`MCP ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return { result: json.result, session };
}

async function connect() {
  const token = await accessToken();
  const { result, session } = await rpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "social-autopilot", version: "1.0" },
  });
  return { token, session, server: result?.serverInfo?.name };
}

/** Call any Metricool tool. Exposed so setup checks reuse one refresh. */
export async function callTool(name, args) {
  const { token, session } = await connect();
  const { result } = await rpc(token, "tools/call", { name, arguments: args }, session);
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  if (result?.isError) throw new Error(text.slice(0, 300));
  return text;
}

/** Full definition of one tool, for checking argument names against reality. */
export async function toolSchema(name) {
  const { token, session } = await connect();
  const { result } = await rpc(token, "tools/list", {}, session);
  return (result?.tools ?? []).find((t) => t.name === name) ?? null;
}

/** Names change; discover rather than hard-code the scheduling tool. */
export async function listTools() {
  const { token, session } = await connect();
  const { result } = await rpc(token, "tools/list", {}, session);
  return (result?.tools ?? []).map((t) => ({ name: t.name, description: t.description }));
}

/**
 * @param {object} opts
 *   videoUrl   public MP4
 *   caption    post text, hashtags included
 *   when       ISO time to schedule, or null for as soon as possible
 */
export async function publishTikTok({ videoUrl, caption, when = null, dryRun, networks = ["tiktok"] }) {
  if (dryRun) {
    console.log(`[dry-run] ${networks.join("+")} -> ${videoUrl}`);
    return { platform: "tiktok", postId: "dry-run" };
  }

  const blogId = String(process.env.METRICOOL_BLOG_ID);
  // Brand timezone is Africa/Nairobi; the API wants an explicit offset and
  // refuses anything in the past, so schedule a few minutes out.
  const at = when ?? new Date(Date.now() + 6 * 60_000);
  const local = new Date(at.getTime() + 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "");
  const date = `${local}+03:00`;

  // `info` is a JSON *string*, not an object — the schema is explicit about it.
  const info = {
    autoPublish: true,
    draft: false,
    // Required inside info as well as at the top level, in the brand's timezone.
    publicationDate: { dateTime: local, timezone: process.env.METRICOOL_TZ ?? "Africa/Nairobi" },
    text: caption,
    media: [videoUrl],
    providers: networks.map((network) => ({ network })),
    ...(networks.includes("tiktok")
      ? {
          tiktokData: {
            privacyOption: "PUBLIC_TO_EVERYONE",
            disableComment: false,
            // TikTok requires its own title, separate from the caption body.
            title: (caption.split("\n")[0] || caption).slice(0, 90),
          },
        }
      : {}),
  };

  const out = await callTool("createScheduledPost", {
    blogId,
    date,
    info: JSON.stringify(info),
  });

  // The response echoes the whole post, whose media URL also contains "planner",
  // so match the app link specifically rather than the first plausible URL.
  const url = /https:\/\/app\.metricool\.com\/\S*?(?=["\s,}]|$)/i.exec(out)?.[0] ?? null;
  console.log(`  scheduled ${networks.join("+")} for ${date}`);
  if (url) console.log(`  ${url}`);
  return { platform: networks.join("+"), postId: url ?? "scheduled", scheduledFor: date };
}
