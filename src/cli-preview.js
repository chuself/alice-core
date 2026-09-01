#!/usr/bin/env node
/**
 * Render one sample poster per pillar from the current brand pack.
 *
 * This is what the Brand tab shows after a save: proof that the palette, the
 * logo and the fonts actually render, before a single real post is written.
 *
 * Deliberately keyless. The copy is local placeholder text, so a preview costs
 * no model quota and works before any credential is connected — which is the
 * whole point, because Brand comes before Connections finishes.
 *
 *   node src/cli-preview.js
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PILLARS } from "./brain.js";
import { renderPoster } from "./render.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { report } from "./control.js";
import { ROOT } from "./paths.js";

const startedAt = new Date().toISOString();

const brand = JSON.parse(
  await readFile(path.join(ROOT, "brands", DEFAULT_BRAND, "brand.json"), "utf8"),
);

/** One line per pillar, so the preview shows the range rather than one look. */
const SAMPLES = {
  "feature-spotlight": {
    eyebrow: "Feature",
    headline: "The one thing that saves an hour a day.",
    body: "A concrete capability, and the minutes it gives back. This is placeholder copy.",
  },
  "pain-point": {
    eyebrow: "Problem",
    headline: "The question that costs you every morning.",
    body: "A frustration the customer recognises, named before the fix is offered.",
  },
  "number-that-lands": {
    eyebrow: "Numbers",
    headline: "A figure worth stopping for.",
    body: "Drawn only from your verified facts. Never invented.",
  },
  "client-proof": {
    eyebrow: "Proof",
    headline: "What a customer actually said.",
    body: "Real words from a real customer carry further than any claim.",
  },
  "swahili-tip": {
    eyebrow: "Ushauri",
    headline: "Kidokezo cha leo kwa biashara yako.",
    body: "Ushauri wa vitendo, wenye manufaa hata kwa asiyenunua leo.",
  },
  "industry-note": {
    eyebrow: "Industry",
    headline: "Something true about this trade.",
    body: "Credibility, not a sales pitch. Placeholder copy for the preview.",
  },
};

let rendered = 0;
for (const pillar of PILLARS) {
  const sample = SAMPLES[pillar] ?? SAMPLES["feature-spotlight"];
  const id = `preview-${pillar}`;
  const record = {
    id,
    ...sample,
    cta: "See it work",
    pillar,
    brand: DEFAULT_BRAND,
    // No AI background: the gradient is the honest floor, and it is what a
    // client sees on any day an image provider is down anyway.
    backgroundPath: null,
    template: "spotlight",
  };

  try {
    await renderPoster(record, DEFAULT_BRAND, path.join(ROOT, "public", `${id}.png`));
    console.log(`preview ${id}.png`);
    rendered++;
  } catch (err) {
    console.error(`preview ${id} FAILED: ${err.message}`);
  }
}

console.log(`\n${rendered} of ${PILLARS.length} previews rendered for ${brand.name}.`);
await report("preview", {
  ok: rendered > 0,
  startedAt,
  summary: `${rendered} of ${PILLARS.length} previews rendered`,
  ...(rendered ? {} : { error: "no preview rendered — check the brand pack" }),
});
