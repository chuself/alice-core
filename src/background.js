/**
 * Free AI background generation. Gemini image on the AI Studio free tier;
 * Cloudflare Workers AI (Flux schnell) as a second free option.
 *
 * Returns the written file path, or null — the renderer falls back to the
 * branded gradient, so a post never dies because an image model was down.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";

export async function generateBackground(prompt, outFile) {
  if (process.env.SKIP_IMAGE === "1") return null;

  for (const provider of [geminiImage, cloudflareFlux, pollinations]) {
    if (!provider.available()) continue;
    try {
      const bytes = await provider.run(prompt);
      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, bytes);
      console.log(`background via ${provider.name} -> ${path.basename(outFile)}`);
      return outFile;
    } catch (err) {
      console.warn(`background via ${provider.name} failed: ${err.message}`);
    }
  }
  console.warn("no background generated — falling back to the branded gradient");
  return null;
}

const geminiImage = {
  name: "gemini",
  // Off by default: Gemini image models are paid-only (free-tier quota is 0),
  // so calling them just burns a round-trip. Set GEMINI_IMAGE=1 if that changes.
  available: () => process.env.GEMINI_IMAGE === "1" && Boolean(process.env.GEMINI_API_KEY),
  async run(prompt) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${prompt}. Vertical 4:5 composition.` }] }],
        }),
      }
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error("no image in response");
    return Buffer.from(part.inlineData.data, "base64");
  },
};

const cloudflareFlux = {
  name: "cloudflare-flux",
  available: () =>
    Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
  async run(prompt) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        },
        body: JSON.stringify({ prompt, steps: 4 }),
      }
    );
    const json = await res.json();
    if (!res.ok || json.success === false) {
      throw new Error(json.errors?.[0]?.message ?? `HTTP ${res.status}`);
    }
    const b64 = json.result?.image;
    if (!b64) throw new Error("no image in response");
    return Buffer.from(b64, "base64");
  },
};

/** Keyless and free. The default background provider. */
const pollinations = {
  name: "pollinations-flux",
  available: () => process.env.NO_POLLINATIONS !== "1",
  async run(prompt) {
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?width=1080&height=1350&nologo=true&model=flux`;
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error(`not an image (${type})`);
    return Buffer.from(await res.arrayBuffer());
  },
};
