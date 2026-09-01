import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";


/**
 * Render one poster PNG.
 *
 * @param {object} post   { template, eyebrow, headline, body, cta, backgroundPath? }
 * @param {string} brandId
 * @param {string} outFile  absolute path of the PNG to write
 */
export async function renderPoster(post, brandId = DEFAULT_BRAND, outFile) {
  const brandDir = path.join(ROOT, "brands", brandId);
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));

  const template = post.template ?? "spotlight";
  const templatePath = path.join(brandDir, "templates", `${template}.html`);
  if (!existsSync(templatePath)) throw new Error(`No template "${template}" for brand ${brandId}`);

  const { width, height } = brand.canvas;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });

    await page.goto(pathToFileURL(templatePath).href, { waitUntil: "load" });

    await page.evaluate(
      ({ brand, post, logoUrl, bgUrl }) => {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(brand.colors)) {
          root.style.setProperty(`--${key}`, value);
        }
        root.style.setProperty("--pill", brand.radii.pill);
        root.style.setProperty("--card", brand.radii.card);

        const set = (id, text) => {
          const el = document.getElementById(id);
          if (el) el.textContent = text ?? "";
        };
        set("eyebrow", post.eyebrow);
        set("headline", post.headline);
        set("body", post.body);
        set("cta", post.cta);
        set("site", brand.site);

        // Headline never overflows: step the size down as it gets longer.
        const h = document.getElementById("headline");
        if (h) {
          const n = (post.headline ?? "").length;
          if (n > 64) h.classList.add("xlong");
          else if (n > 40) h.classList.add("long");
        }

        document.getElementById("logo").src = logoUrl;

        // A post never dies for lack of an image — the gradient fallback stands in.
        if (bgUrl) {
          const bg = document.getElementById("bg");
          bg.classList.remove("fallback");
          bg.style.backgroundImage = `url("${bgUrl}")`;
        }
      },
      {
        brand,
        post,
        logoUrl: pathToFileURL(path.join(brandDir, brand.logo)).href,
        bgUrl: post.backgroundPath ? pathToFileURL(path.resolve(ROOT, post.backgroundPath)).href : null,
      }
    );

    await page.evaluate(() => document.fonts.ready);
    // Let the background image decode before the shot.
    await page.waitForFunction(() => {
      const bg = document.getElementById("bg");
      const m = /url\("(.+)"\)/.exec(bg.style.backgroundImage);
      if (!m) return true;
      const img = new Image();
      img.src = m[1];
      return img.complete;
    }, null, { timeout: 15000 }).catch(() => {});

    await mkdir(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, type: "png" });
    return outFile;
  } finally {
    await browser.close();
  }
}

// Direct run: render the sample post so the template can be eyeballed.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const sample = JSON.parse(await readFile(path.join(ROOT, "state", "sample-post.json"), "utf8"));
  const out = path.join(ROOT, "public", `${sample.id}.png`);
  await renderPoster(sample, sample.brand ?? DEFAULT_BRAND, out);
  console.log(`rendered -> ${out}`);
}
