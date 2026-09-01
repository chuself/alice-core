/**
 * Reel renderer: deterministic frames + voiceover -> vertical MP4.
 *
 * Nothing animates on its own. The page exposes setFrame(t) and we screenshot
 * each timestamp, so a render is reproducible and always matches the audio
 * length exactly — the same discipline as the poster renderer.
 */
import { chromium } from "playwright";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./paths.js";

const run = promisify(execFile);
export const FPS = 24;
const SIZE = { width: 1080, height: 1920 };

/**
 * @param {object} post   { beats[], eyebrow, cta, backgroundPath?, template? }
 * @param {string} audioFile  voiceover mp3, or null for a silent track
 * @param {string} outFile    .mp4 to write
 */
export async function renderReel(post, brandId, audioFile, outFile) {
  const brandDir = path.join(ROOT, "brands", brandId);
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));
  const templatePath = path.join(brandDir, "templates", `${post.videoTemplate ?? "reel"}.html`);
  if (!existsSync(templatePath)) throw new Error(`No reel template for ${brandId}`);

  // The video is as long as the narration, plus a beat to breathe at the end.
  const narration = audioFile ? await audioDuration(audioFile) : 0;
  const duration = Math.min(59, Math.max(7, Math.round((narration || 8) + 1.2)));

  const frameDir = path.join(ROOT, "state", "frames", post.id);
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(templatePath).href, { waitUntil: "load" });

    await page.evaluate(
      ({ brand, post, logoUrl, bgUrl, duration }) => {
        const root = document.documentElement;
        for (const [k, v] of Object.entries(brand.colors)) root.style.setProperty(`--${k}`, v);
        root.style.setProperty("--pill", brand.radii.pill);

        document.getElementById("logo").src = logoUrl;
        document.getElementById("eyebrow").textContent = post.eyebrow ?? "";
        document.getElementById("cta").textContent = post.cta ?? "";
        document.getElementById("site").textContent = brand.site;

        if (bgUrl) {
          const bg = document.getElementById("bg");
          bg.classList.remove("fallback");
          bg.style.backgroundImage = `url("${bgUrl}")`;
        }
        window.buildReel({ beats: post.beats ?? [], duration });
      },
      {
        brand,
        post,
        logoUrl: pathToFileURL(path.join(brandDir, brand.logo)).href,
        bgUrl: post.backgroundPath
          ? pathToFileURL(path.resolve(ROOT, post.backgroundPath)).href
          : null,
        duration,
      }
    );

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300); // let the background image decode

    const total = Math.round(duration * FPS);
    for (let i = 0; i < total; i++) {
      await page.evaluate((t) => window.setFrame(t), i / FPS);
      await page.screenshot({
        path: path.join(frameDir, `f${String(i).padStart(5, "0")}.png`),
        type: "png",
      });
    }
    console.log(`  ${total} frames at ${FPS}fps (${duration}s)`);
  } finally {
    await browser.close();
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await encode(frameDir, audioFile, duration, outFile);
  await rm(frameDir, { recursive: true, force: true });
  return outFile;
}

/**
 * H.264 + AAC in an MP4 with faststart — Instagram rejects anything else, and
 * without faststart the moov atom sits at the end and upload validation fails.
 */
async function encode(frameDir, audioFile, duration, outFile) {
  const args = [
    "-y",
    "-framerate", String(FPS),
    "-i", path.join(frameDir, "f%05d.png"),
  ];

  if (audioFile) {
    args.push("-i", audioFile);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  args.push(
    "-map", "0:v:0",
    "-map", "1:a:0",
    // Pad the audio to the full length. Without this "-shortest" trims the video
    // to the narration and the closing CTA never reaches the viewer.
    "-af", "apad",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-crf", "20",
    "-preset", "medium",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-t", String(duration),
    "-movflags", "+faststart",
    outFile
  );

  await run("ffmpeg", args, { maxBuffer: 1024 * 1024 * 32 });
}

export async function audioDuration(file) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Sanity gate before anything is uploaded. */
export async function probeVideo(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_name,width,height",
    "-of", "json",
    file,
  ]);
  return JSON.parse(stdout);
}
