import * as facebookGraph from "./facebook.js";
import * as instagramGraph from "./instagram.js";
import * as metricool from "./metricool.js";

/**
 * Every publisher exposes { id, publish({ imageUrl, caption, dryRun }) }.
 *
 * Two transports carry Facebook and Instagram, and a tenant picks one with the
 * PUBLISH_TRANSPORT variable:
 *
 *   graph      (default) our own Meta app. Full control: carousels as native
 *              child containers, the first-comment CTA, comment replies and
 *              insights. Everything the product sells.
 *
 *   metricool  posts through Metricool's already-audited app. Less control —
 *              scheduled rather than published, no first comment — but it does
 *              not depend on our Meta app being in good standing.
 *
 * The switch exists so that a restriction on our app is a variable change per
 * tenant rather than an outage with no move available. Deciding that under
 * pressure, with clients silent, is the situation this avoids.
 *
 * `engage` follows the same switch: src/engage/source.js reads and replies to
 * comments through whichever transport is selected, so a tenant on Metricool
 * needs no Meta relationship at all.
 */
export const TRANSPORT = process.env.PUBLISH_TRANSPORT ?? "metricool";

const TRANSPORTS = {
  // Two networks, full control, our own app to keep in good standing.
  graph: { facebook: facebookGraph, instagram: instagramGraph },
  // Nine networks, nobody's app to keep in good standing but Metricool's.
  metricool: {
    facebook: metricool.facebook,
    instagram: metricool.instagram,
    tiktok: metricool.tiktok,
    linkedin: metricool.linkedin,
    twitter: metricool.twitter,
    youtube: metricool.youtube,
    threads: metricool.threads,
    pinterest: metricool.pinterest,
    gmb: metricool.gmb,
  },
};

export const publishers = TRANSPORTS[TRANSPORT] ?? TRANSPORTS.graph;

/** Every platform this tenant can actually reach on its current transport. */
export function availablePlatforms() {
  return Object.keys(publishers);
}

export function publisherFor(platform) {
  const p = publishers[platform];
  if (!p) {
    throw new Error(
      `No publisher for platform "${platform}" on transport "${TRANSPORT}"`,
    );
  }
  return p;
}

/**
 * Carousels take a different call on every transport, so the caller asks here
 * rather than deciding for itself.
 */
export async function carouselFor(platform) {
  if (TRANSPORT === "metricool") {
    return platform === "instagram" ? metricool.publishCarousel : metricool.publishAlbum;
  }
  const mod = platform === "instagram" ? instagramGraph : facebookGraph;
  const fn = platform === "instagram" ? mod.publishCarousel : mod.publishAlbum;
  // Named rather than assumed: a transport that cannot do carousels should say
  // so here, not fail deep inside a publish call at the scheduled minute.
  if (typeof fn !== "function") {
    throw new Error(`Transport "${TRANSPORT}" has no carousel publisher for ${platform}`);
  }
  return fn;
}
