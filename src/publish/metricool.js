/**
 * Publishing through Metricool's REST API.
 *
 * This is the default transport. Metricool's app is already audited by every
 * platform it touches, so a tenant needs no Meta app, no App Review and no
 * Business Verification — and nine networks are available instead of two.
 *
 * The Graph transport in facebook.js / instagram.js stays as the fallback for
 * the day Metricool has a bad week. Switch with PUBLISH_TRANSPORT=graph.
 *
 * One behavioural difference worth knowing: Metricool SCHEDULES. We hand it the
 * post and the minute, and it publishes. Alice therefore hands over slightly
 * ahead of the slot rather than at it, and the queue records what was accepted
 * rather than a live post id.
 */
import { schedulePost } from "../metricool/api.js";

/** Alice's platform names → Metricool's network names for the scheduler. */
const NETWORK = {
  facebook: "facebook",
  instagram: "instagram",
  tiktok: "tiktok",
  linkedin: "linkedin",
  twitter: "twitter",
  youtube: "youtube",
  threads: "threads",
  pinterest: "pinterest",
  gmb: "gmb",
};

function toNetwork(platform) {
  const n = NETWORK[platform];
  if (!n) throw new Error(`Metricool has no network for platform "${platform}"`);
  return n;
}

/**
 * One post, one platform — the shape publish/index.js expects.
 *
 * `when` is the slot. `firstComment` carries the CTA link, which Metricool
 * supports natively, so the reach-suppression workaround survives the move.
 */
function publisher(platform) {
  return {
    id: platform,
    async publish({ imageUrl, imageUrls, caption, firstComment, when, dryRun }) {
      const media = imageUrls?.length ? imageUrls : imageUrl ? [imageUrl] : [];
      const out = await schedulePost({
        networks: [toNetwork(platform)],
        text: caption,
        mediaUrls: media,
        when: when ?? null,
        firstComment: firstComment ?? null,
        dryRun,
      });
      return {
        platform,
        postId: String(out.id),
        via: "metricool",
        scheduledFor: out.scheduledFor,
      };
    },
  };
}

export const facebook = publisher("facebook");
export const instagram = publisher("instagram");
export const tiktok = publisher("tiktok");
export const linkedin = publisher("linkedin");
export const twitter = publisher("twitter");
export const youtube = publisher("youtube");
export const threads = publisher("threads");
export const pinterest = publisher("pinterest");
export const gmb = publisher("gmb");

/** A carousel is the same call with more media, on either platform. */
export function publishCarousel({ imageUrls, caption, firstComment, when, dryRun }) {
  return instagram.publish({ imageUrls, caption, firstComment, when, dryRun });
}

export function publishAlbum({ imageUrls, caption, firstComment, when, dryRun }) {
  return facebook.publish({ imageUrls, caption, firstComment, when, dryRun });
}

/**
 * A reel is a video URL rather than images — same scheduler, and Metricool
 * routes it to Reels on the networks that have them.
 */
export async function publishVideo({ videoUrl, caption, networks, when, dryRun }) {
  const out = await schedulePost({
    networks: networks.map(toNetwork),
    text: caption,
    mediaUrls: [videoUrl],
    when: when ?? null,
    dryRun,
  });
  return { platform: networks.join("+"), postId: String(out.id), via: "metricool" };
}
