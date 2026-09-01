/**
 * The engine's public surface, for anything that wants to import rather than
 * run a command. Kept deliberately small: a tenant repository should call the
 * `alice` CLI, not reach into internals, so that internals stay free to change
 * between versions.
 */
export { ROOT, tenantPath } from "./paths.js";
export { DEFAULT_BRAND } from "./brand-id.js";
export { readQueue, writeQueue, duePosts, recentPosts } from "./queue.js";
export { readConfig, updateConfig, LIMITS, describe } from "./config.js";
export { license, report, mirrorPosts, pushLeads, decisions } from "./control.js";
export { TRANSPORT, publisherFor, availablePlatforms } from "./publish/index.js";
export { composeReel, beatTimings } from "./reel/compose.js";
