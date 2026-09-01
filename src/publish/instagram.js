import { graphPost, graphGet } from "../graph.js";

export const id = "instagram";

/**
 * Two-step publish: create a media container, then publish it.
 * imageUrl MUST be publicly reachable — Instagram fetches it server-side.
 */
export async function publish({ imageUrl, caption, dryRun }) {
  const igUser = requireEnv("IG_USER_ID");
  const token = requireEnv("FB_PAGE_ACCESS_TOKEN");

  if (dryRun) {
    console.log(`[dry-run] instagram -> POST ${igUser}/media then media_publish`);
    console.log(`[dry-run]   url: ${imageUrl}`);
    console.log(`[dry-run]   caption: ${caption.slice(0, 80)}...`);
    return { platform: id, postId: "dry-run", url: null };
  }

  const container = await graphPost(`${igUser}/media`, {
    image_url: imageUrl,
    caption,
    access_token: token,
  });

  await waitForContainer(container.id, token);

  const published = await graphPost(`${igUser}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
  return { platform: id, postId: published.id, url: null };
}

/** Instagram downloads the image asynchronously; publishing too early fails. */
async function waitForContainer(creationId, token, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const info = await graphGet(creationId, {
      fields: "status_code,status",
      access_token: token,
    });
    if (info.status_code === "FINISHED") return;
    if (info.status_code === "ERROR" || info.status_code === "EXPIRED") {
      throw new Error(`IG container ${creationId} ${info.status_code}: ${info.status ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`IG container ${creationId} never finished processing`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} — see .env.example`);
  return v;
}
