/**
 * Where comments come from, and where replies go.
 *
 * Two sources behind one shape, chosen by PUBLISH_TRANSPORT, so cli-engage.js
 * does not care which platform relationship the tenant actually has:
 *
 *   metricool  their inbox API. No Meta app needed at all — this is what makes
 *              a tenant installable in under an hour.
 *   graph      the Meta Graph API directly, for a tenant on their own app.
 *
 * Both return the same comment shape:
 *   { id, platform, text, from, permalink, fromPage, at }
 *
 * `id` is whatever that source needs in order to reply to it later, and is
 * never interpreted anywhere else.
 */
import { TRANSPORT } from "../publish/index.js";
import { commentThreads, replyToComment, INBOX_PROVIDERS } from "../metricool/api.js";
import { graphGet, graphPost } from "../graph.js";

/* ── Metricool ────────────────────────────────────────────────────────────── */

/**
 * Facebook and Instagram accept replies for 24 hours only. A comment older than
 * that is still READ — Alice must know about a lead whenever it arrived — but
 * it is marked unanswerable so it goes to a human instead of failing at reply
 * time, which would look like a bug rather than a platform rule.
 */
const REPLY_WINDOW_HOURS = 24;
const WINDOWED = new Set(["FACEBOOK", "INSTAGRAMBUSINESS"]);

function withinReplyWindow(provider, at) {
  if (!WINDOWED.has(provider)) return true;
  if (!at) return false;
  return Date.now() - new Date(at).getTime() < REPLY_WINDOW_HOURS * 3600_000;
}

async function metricoolComments(platforms) {
  const out = [];
  for (const platform of platforms) {
    const provider = INBOX_PROVIDERS[platform];
    if (!provider) continue;
    let threads;
    try {
      threads = await commentThreads(provider);
    } catch (err) {
      console.warn(`  inbox ${platform}: ${err.message.slice(0, 140)}`);
      continue;
    }

    for (const t of threads ?? []) {
      const root = t.root ?? {};
      // A thread we already resolved is done; re-reading it would re-alert.
      if (t.status === "RESOLVED") continue;
      const at = root.creationDate ?? t.creationDate ?? null;
      out.push({
        id: root.id ?? t.id,
        threadId: t.id,
        platform,
        provider,
        text: root.text ?? root.message ?? "",
        from: (t.participants ?? [])[0]?.name ?? "someone",
        permalink: root.permalink ?? t.self ?? null,
        // Our own replies must never be triaged as if a customer wrote them.
        fromPage: Boolean(root.fromPage ?? root.isOwner),
        at,
        canReply: withinReplyWindow(provider, at),
      });
    }
  }
  return out;
}

/* ── Graph ────────────────────────────────────────────────────────────────── */

async function graphComments(history, ours) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
  const out = [];

  for (const post of history) {
    const isFb = post.platform === "facebook";
    // No "from" on Facebook: Meta blocks commenter identity on Page posts, and
    // asking for it fails the WHOLE request rather than that one field.
    const fields = isFb
      ? "id,message,created_time,permalink_url"
      : "id,text,username,timestamp";
    let j;
    try {
      j = await graphGet(`${post.postId}/comments`, { fields, limit: "50", access_token: token });
    } catch (err) {
      console.warn(`  ${post.platform} ${post.postId}: ${err.message.slice(0, 140)}`);
      continue;
    }
    for (const c of j.data ?? []) {
      out.push({
        id: c.id,
        platform: post.platform,
        text: (isFb ? c.message : c.text) ?? "",
        from: isFb ? "someone" : (c.username ?? "someone"),
        permalink: isFb ? c.permalink_url : null,
        fromPage: ours.has(c.id),
        at: (isFb ? c.created_time : c.timestamp) ?? null,
        canReply: true,
      });
    }
  }
  return out;
}

/* ── the seam ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 *   platforms  ["facebook","instagram"] — used by the Metricool source
 *   history    recent posts — used by the Graph source, which polls per post
 *   ours       ids of comments we wrote, so we skip our own
 */
export async function fetchComments({ platforms = [], history = [], ours = new Set() } = {}) {
  return TRANSPORT === "metricool"
    ? metricoolComments(platforms)
    : graphComments(history, ours);
}

/**
 * Post one reply. Returns the new comment id, or null when the platform would
 * not accept it — a closed reply window is a fact to report, not an error.
 */
export async function reply(comment, text, { dryRun = false } = {}) {
  if (comment.canReply === false) {
    console.log(`  reply window closed on ${comment.platform} — escalating instead`);
    return null;
  }

  if (TRANSPORT === "metricool") {
    const out = await replyToComment({
      provider: comment.provider,
      objectId: comment.id,
      text,
      dryRun,
    });
    return out?.id ?? null;
  }

  if (dryRun) {
    console.log(`  [dry-run] graph reply on ${comment.id}: ${text.slice(0, 60)}`);
    return null;
  }
  const posted = await graphPost(`${comment.id}/comments`, {
    message: text,
    access_token: process.env.FB_PAGE_ACCESS_TOKEN,
  });
  return posted?.id ?? null;
}
