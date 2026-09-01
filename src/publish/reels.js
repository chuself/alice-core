/**
 * Video publishing. Separate from the image publishers because both platforms
 * treat video as an async upload: you hand over a URL, they fetch and transcode,
 * and publishing before that finishes fails.
 */
import { graphPost, graphGet } from "../graph.js";

export const id = "reels";

/** Instagram Reels: container -> poll until FINISHED -> publish. */
export async function publishInstagramReel({ videoUrl, caption, coverUrl, dryRun }) {
  const igUser = requireEnv("IG_USER_ID");
  const token = requireEnv("FB_PAGE_ACCESS_TOKEN");

  if (dryRun) {
    console.log(`[dry-run] instagram REEL -> ${videoUrl}`);
    return { platform: "instagram", postId: "dry-run" };
  }

  const params = {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
    access_token: token,
  };
  if (coverUrl) params.cover_url = coverUrl;

  const container = await graphPost(`${igUser}/media`, params);
  await waitForContainer(container.id, token);

  const published = await graphPost(`${igUser}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
  return { platform: "instagram", postId: published.id };
}

/**
 * Facebook Reels proper. `/videos` produces a video post that merely gets a
 * /reel/ URL — it never appears in the Page's Reels tab. A native Reel needs
 * the three-phase /video_reels upload: start, upload, finish.
 */
export async function publishFacebookVideo({ videoUrl, caption, dryRun }) {
  const pageId = requireEnv("FB_PAGE_ID");
  const token = requireEnv("FB_PAGE_ACCESS_TOKEN");

  if (dryRun) {
    console.log(`[dry-run] facebook REEL -> ${videoUrl}`);
    return { platform: "facebook", postId: "dry-run" };
  }

  // 1. start — reserves a video id and an upload endpoint
  const start = await graphPost(`${pageId}/video_reels`, {
    upload_phase: "start",
    access_token: token,
  });
  const videoId = start.video_id;
  if (!videoId) throw new Error("video_reels start returned no video_id");

  // 2. upload — hand Facebook the URL and let it fetch the file itself
  const up = await fetch(start.upload_url ?? `https://rupload.facebook.com/video-upload/v21.0/${videoId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      file_url: videoUrl,
    },
  });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || upJson.success === false || upJson.error) {
    throw new Error(`reel upload failed: ${upJson.error?.message ?? up.status}`);
  }

  // 3. finish — publish it as a Reel
  const finish = await graphPost(`${pageId}/video_reels`, {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description: caption,
    access_token: token,
  });
  if (finish.success === false) throw new Error("video_reels finish rejected");

  await waitForFacebookReel(videoId, token);
  return { platform: "facebook", postId: videoId };
}

/** Facebook processes asynchronously too; a "published" reel can still be encoding. */
async function waitForFacebookReel(videoId, token, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const info = await graphGet(videoId, { fields: "status", access_token: token });
    const st = info.status ?? {};
    if (st.video_status === "ready") return;
    if (st.video_status === "error" || st.processing_phase?.status === "error") {
      throw new Error(`FB reel processing failed: ${JSON.stringify(st).slice(0, 200)}`);
    }
    if (i % 5 === 0) console.log(`  facebook processing… (${st.video_status ?? "?"})`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  console.warn("  facebook reel still processing — it will appear shortly");
}

/**
 * Transcoding a 1080x1920 clip takes far longer than an image fetch, so this
 * waits minutes rather than seconds before giving up.
 */
async function waitForContainer(creationId, token, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const info = await graphGet(creationId, {
      fields: "status_code,status",
      access_token: token,
    });
    if (info.status_code === "FINISHED") return;
    if (info.status_code === "ERROR" || info.status_code === "EXPIRED") {
      throw new Error(`IG reel container ${info.status_code}: ${info.status ?? ""}`);
    }
    if (i % 5 === 0) console.log(`  transcoding… (${info.status_code})`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`IG reel container never finished (waited ${(attempts * 8) / 60} min)`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
