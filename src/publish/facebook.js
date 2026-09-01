import { graphPost } from "../graph.js";

export const id = "facebook";

/**
 * Post a photo to a Facebook Page.
 * Needs FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN (a Page token, not a user token).
 */
export async function publish({ imageUrl, caption, dryRun }) {
  const pageId = requireEnv("FB_PAGE_ID");
  const token = requireEnv("FB_PAGE_ACCESS_TOKEN");

  if (dryRun) {
    console.log(`[dry-run] facebook -> POST ${pageId}/photos`);
    console.log(`[dry-run]   url: ${imageUrl}`);
    console.log(`[dry-run]   caption: ${caption.slice(0, 80)}...`);
    return { platform: id, postId: "dry-run", url: null };
  }

  // Two steps on purpose. Posting straight to /photos creates an "added_photos"
  // album story; attaching an unpublished photo to /feed creates a real feed
  // post, which is what followers actually see in their timeline.
  const photo = await graphPost(`${pageId}/photos`, {
    url: imageUrl,
    published: "false",
    temporary: "false",
    access_token: token,
  });
  if (!photo.id) throw new Error("photo upload returned no id");

  const out = await graphPost(`${pageId}/feed`, {
    message: caption,
    attached_media: JSON.stringify([{ media_fbid: photo.id }]),
    access_token: token,
  });

  return {
    platform: id,
    postId: out.id,
    url: out.id ? `https://facebook.com/${out.id}` : null,
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} — see .env.example`);
  return v;
}
