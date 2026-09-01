/**
 * Metricool REST API — the whole transport in one file.
 *
 * Base: https://app.metricool.com/api
 * Auth: X-Mc-Auth header, plus userId and blogId on every query. A static user
 * token, so unlike the MCP's OAuth there is nothing that rotates and nothing a
 * read can destroy. That is why this path is safe for the dashboard to hold and
 * for a status check to touch.
 *
 * What this buys, versus talking to Meta ourselves:
 *   - no App Review, no Business Verification, no per-client Meta app
 *   - nine networks instead of two
 *   - comment reading AND replying, which is what keeps lead capture alive
 *   - firstCommentText is a native field, so the CTA-in-first-comment survives
 *   - media takes public URLs, so posters already on Pages need no upload
 *
 * The limits are theirs, not ours, and are handled at the call site:
 *   - Facebook and Instagram accept comment replies for 24h only
 *   - comments on ads cannot be answered at all
 */
const BASE = process.env.METRICOOL_API_BASE ?? "https://app.metricool.com/api";
const TIMEOUT_MS = 30_000;

export function metricoolConfigured() {
  return Boolean(
    process.env.METRICOOL_USER_TOKEN &&
      process.env.METRICOOL_USER_ID &&
      process.env.METRICOOL_BLOG_ID
  );
}

function creds() {
  const userToken = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  const blogId = process.env.METRICOOL_BLOG_ID;
  if (!userToken || !userId || !blogId) {
    throw new Error(
      "Metricool needs METRICOOL_USER_TOKEN, METRICOOL_USER_ID and METRICOOL_BLOG_ID"
    );
  }
  return { userToken, userId, blogId };
}

/**
 * Every call carries userId and blogId. Passing the wrong blogId is the one
 * mistake that posts a client's content to another client's account, so it is
 * never defaulted at a call site — it comes from the environment, once.
 */
async function call(method, path, { query = {}, body = null } = {}) {
  const { userToken, userId, blogId } = creds();
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("userId", userId);
  url.searchParams.set("blogId", blogId);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      "X-Mc-Auth": userToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Metricool ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Metricool ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/* ── brands ───────────────────────────────────────────────────────────────── */

/** Every brand this token can see. Used by setup checks to confirm the id. */
export async function brands() {
  const out = await call("GET", "/v2/settings/brands");
  return out?.data ?? out ?? [];
}

/* ── publishing ───────────────────────────────────────────────────────────── */

const TZ = process.env.METRICOOL_TZ ?? "Africa/Nairobi";
const OFFSET_HOURS = 3; // EAT, no DST

/** Metricool wants a local wall-clock string plus a named timezone. */
function localTime(at) {
  return new Date(at.getTime() + OFFSET_HOURS * 3600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "");
}

/**
 * Schedule one post to one or more networks.
 *
 * `autoPublish: true` is what makes this publishing rather than drafting — the
 * post goes out on its own at the given minute. `draft: false` for the same
 * reason: a draft waits for a human who is not coming.
 *
 * @param {object} o
 *   networks   ["instagram","facebook","tiktok",…]
 *   text       the caption, hashtags included
 *   mediaUrls  public URLs. Several means a carousel.
 *   when       Date. Anything in the past is pushed forward: the API refuses it.
 *   firstComment  the CTA link, posted as the first comment rather than in the
 *                 caption, because a caption link suppresses reach.
 */
export async function schedulePost({
  networks,
  text,
  mediaUrls = [],
  when = null,
  firstComment = null,
  tiktokTitle = null,
  dryRun = false,
}) {
  if (!networks?.length) throw new Error("schedulePost needs at least one network");

  const at = when && when.getTime() > Date.now() + 60_000 ? when : new Date(Date.now() + 5 * 60_000);
  const dateTime = localTime(at);

  const body = {
    publicationDate: { dateTime, timezone: TZ },
    text,
    providers: networks.map((network) => ({ network })),
    media: mediaUrls,
    autoPublish: true,
    draft: false,
    // Metricool copies the file rather than hot-linking Pages forever.
    saveExternalMediaFiles: true,
    ...(firstComment ? { firstCommentText: firstComment } : {}),
    ...(networks.includes("tiktok")
      ? {
          tiktokData: {
            privacyOption: "PUBLIC_TO_EVERYONE",
            disableComment: false,
            // TikTok insists on its own title, separate from the caption.
            title: (tiktokTitle ?? text.split("\n")[0] ?? text).slice(0, 90),
          },
        }
      : {}),
  };

  if (dryRun) {
    console.log(`  [dry-run] metricool ${networks.join("+")} at ${dateTime}, ${mediaUrls.length} media`);
    return { id: "dry-run", scheduledFor: dateTime, networks };
  }

  const out = await call("POST", "/v2/scheduler/posts", { body });
  const post = out?.data ?? out;
  return {
    id: post?.id ?? post?.uuid ?? "scheduled",
    uuid: post?.uuid ?? null,
    scheduledFor: dateTime,
    networks,
    providers: post?.providers ?? [],
  };
}

/** What actually went out, so history and metrics reflect reality. */
export async function publishedPosts({ start, end } = {}) {
  const out = await call("GET", "/v2/flows/posts/published", {
    query: { start, end },
  });
  return out?.data ?? [];
}

/* ── inbox ────────────────────────────────────────────────────────────────── */

/**
 * Providers as Metricool names them. Instagram business accounts report as
 * INSTAGRAMBUSINESS, which is not the value the scheduler uses — mixing the two
 * up returns an empty list rather than an error, so both are listed explicitly.
 */
export const INBOX_PROVIDERS = {
  instagram: "INSTAGRAMBUSINESS",
  facebook: "FACEBOOK",
  tiktok: "TIKTOKBUSINESS",
  youtube: "YOUTUBE",
  linkedin: "LINKEDIN",
  twitter: "TWITTER",
  gmb: "GMB",
};

/**
 * Comment threads on this brand's posts.
 *
 * @param {string} provider  a value from INBOX_PROVIDERS
 * @returns {Promise<Array>} threads: { id, provider, status, root, participants }
 */
export async function commentThreads(provider) {
  const out = await call("GET", "/v2/inbox/post-comments", { query: { provider } });
  return out?.data ?? [];
}

/**
 * Reply to one comment.
 *
 * Facebook and Instagram only accept a reply within 24 hours of the comment.
 * Older ones are not answered — they are escalated to a human, which is the
 * behaviour we would want anyway.
 */
export async function replyToComment({ provider, objectId, text, dryRun = false }) {
  if (dryRun) {
    console.log(`  [dry-run] metricool reply on ${objectId}: ${text.slice(0, 60)}`);
    return { id: "dry-run" };
  }
  const out = await call("POST", "/v2/inbox/post-comments", {
    body: { provider, objectId, text },
  });
  return out?.data ?? out;
}

/** Mark a thread read/resolved so it stops coming back. */
export async function setThreadStatus(threadId, status = "RESOLVED") {
  return call("PUT", "/v2/inbox/status", { body: { ids: [threadId], status } });
}

/* ── insight ──────────────────────────────────────────────────────────────── */

/** When this audience is actually awake. Reports only; the routine is human. */
export async function bestTimes(provider, { start, end } = {}) {
  const out = await call("GET", `/v2/scheduler/besttimes/${provider}`, {
    query: { start, end, timezone: TZ },
  });
  return out?.data ?? out;
}

/** Per-post performance, for the pillar feedback loop. */
export async function postAnalytics(network, { start, end } = {}) {
  const out = await call("GET", `/v2/analytics/posts/${network}`, {
    query: { start, end, timezone: TZ },
  });
  return out?.data ?? [];
}
