/**
 * Post the CTA link as the first comment, on the Graph transport.
 *
 * Metricool does this natively with firstCommentText. The Graph API has no such
 * field, so the comment is written immediately after the post lands. Without
 * this, switching a tenant to the fallback transport would silently drop every
 * call to action.
 */
import { graphPost } from "../graph.js";

export async function commentOn(postId, message, { dryRun } = {}) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
  if (dryRun) {
    console.log(`  [dry-run] first comment on ${postId}: ${message.slice(0, 60)}`);
    return null;
  }
  const out = await graphPost(`${postId}/comments`, { message, access_token: token });
  return out?.id ?? null;
}
