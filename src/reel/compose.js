/**
 * The reel engine: one post plus one voiceover becomes one HyperFrames
 * composition.
 *
 * Alice does not hand-author video. She fills this template, so every reel for
 * every tenant is the same proven composition with different words, colours and
 * timing. That is what makes the visual quality a property of the ENGINE rather
 * than of whichever run happened to produce it.
 *
 * Contract obeyed here, from hyperframes-core — each of these is a silent
 * failure if broken:
 *
 *  - the root carries data-start="0" plus id, width, height and duration
 *  - exactly one paused GSAP timeline, registered synchronously at
 *    window.__timelines["reel"]
 *  - GSAP is vendored, never fetched: a render must not need the network
 *  - no CSS initial transform on anything GSAP also tweens — fromTo sets the
 *    start state, so the two cannot fight
 *  - the framework owns .clip visibility, so animation targets a wrapper
 *    INSIDE each clip and never the clip itself
 *  - the full-bleed background sits on a child of the root, never on the root:
 *    frame compositing can drop the root's own background and render black
 *  - no <br> in body text; no render-time clock, randomness or network
 *
 * Layout obeys the Instagram safe core: everything that must be read lives
 * between y=440 and y=1470, which clears the Reels UI top and bottom and
 * survives the 1:1 and 4:5 crops.
 */

const W = 1080;
const H = 1920;
const TAIL = 1.4; // breathing room after the last word, before the cut

/** Escape for HTML text nodes. Copy is client-authored; it must not inject. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Share the narration across the beats by word count, because that is what
 * actually takes time to say. An even split leaves a nine-word beat on screen
 * for as long as a three-word one, and the voice drifts out of step with the
 * text — the single most obvious flaw in a generated reel.
 */
export function beatTimings(beats, audioDuration) {
  const words = beats.map((b) => Math.max(1, String(b).trim().split(/\s+/).length));
  const total = words.reduce((a, b) => a + b, 0);
  const MIN = 1.8;

  let out = words.map((w) => Math.max(MIN, (w / total) * audioDuration));
  // Honour the audio, not the arithmetic: rescale so the beats end when the
  // voice does, however the minimums landed.
  const sum = out.reduce((a, b) => a + b, 0);
  const scale = audioDuration / sum;
  if (scale < 1) out = out.map((d) => d * scale);

  let t = 0;
  return out.map((d) => {
    const start = t;
    t += d;
    return { start: Number(start.toFixed(3)), duration: Number(d.toFixed(3)) };
  });
}

/**
 * @param {object} o
 *   beats       3-4 short lines. The first is the hook.
 *   brand       the brand pack (colours, name, site)
 *   audioFile   voiceover, relative to the reel project root
 *   audioDuration  seconds, measured from the real file — never guessed
 *   backgroundFile optional image, relative to the reel project root
 *   look        optional { accent, tone } from the look rotation
 * @returns {{html: string, duration: number}}
 */
export function composeReel({
  beats,
  brand,
  audioFile,
  audioDuration,
  backgroundFile = null,
  look = null,
}) {
  const lines = (beats ?? []).filter(Boolean).slice(0, 4);
  if (!lines.length) throw new Error("a reel needs at least one beat");
  if (!(audioDuration > 0)) throw new Error("audioDuration must be measured from the audio file");

  const c = brand.colors ?? {};
  const accent = look?.accent ?? c.primary ?? "#a478ff";
  const duration = Number((audioDuration + TAIL).toFixed(3));
  const timings = beatTimings(lines, audioDuration);

  const beatMarkup = lines
    .map((text, i) => {
      const { start, duration: d } = timings[i];
      const isHook = i === 0;
      const isLast = i === lines.length - 1;
      return `
      <div class="clip beat" id="beat-${i}" data-start="${start}" data-duration="${d}" data-track-index="2">
        <div class="beat-inner" id="beat-inner-${i}">
          <div class="beat-rule"></div>
          <p class="beat-text${isHook ? " hook" : ""}${isLast ? " payoff" : ""}">${esc(text)}</p>
        </div>
      </div>`;
    })
    .join("");

  // The background is a child of the root, never the root itself.
  const background = backgroundFile
    ? `<img id="bg-image" src="${esc(backgroundFile)}" alt="" />`
    : "";

  const html = `<!doctype html>
<html lang="sw" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- Vendored, not CDN: a render must never depend on the network. -->
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Brand"; src: url("assets/fonts/inter-latin-400-normal.woff2") format("woff2"); font-weight: 400; font-display: block; }
      @font-face { font-family: "Brand"; src: url("assets/fonts/inter-latin-600-normal.woff2") format("woff2"); font-weight: 600; font-display: block; }
      @font-face { font-family: "Brand"; src: url("assets/fonts/inter-latin-700-normal.woff2") format("woff2"); font-weight: 700; font-display: block; }

      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${c.bg ?? "#0b0d10"}; }
      body { font-family: "Brand", system-ui, sans-serif; }

      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }

      /* Full-bleed fill on a CHILD of the root. On the root itself the frame
         compositor can drop it and every frame renders black. */
      #bg { position: absolute; inset: 0; background: ${c.bg ?? "#0b0d10"}; }
      #bg-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      /* Two scrims: one lifts the whole frame off pure black, one guarantees
         text contrast in the safe core whatever the photograph is doing. */
      #bg-tint { position: absolute; inset: 0; background:
        radial-gradient(120% 70% at 72% 22%, ${accent}2e 0%, transparent 62%); }
      #bg-scrim { position: absolute; inset: 0; background:
        linear-gradient(180deg, ${c.bg ?? "#0b0d10"}d9 0%, ${c.bg ?? "#0b0d10"}59 34%, ${c.bg ?? "#0b0d10"}e6 82%); }

      /* SAFE CORE: 440..1470. Above and below belongs to the platform's UI. */
      .beat { position: absolute; left: 96px; right: 96px; top: 620px; }
      .beat-inner { display: block; }
      .beat-rule { width: 96px; height: 8px; border-radius: 4px; background: ${accent}; margin-bottom: 34px; }
      .beat-text {
        display: block;
        font-size: 92px; line-height: 1.08; font-weight: 700;
        letter-spacing: -0.02em; color: ${c.text ?? "#e8ecf1"};
      }
      .beat-text.hook { font-size: 104px; }
      .beat-text.payoff { color: ${accent}; }

      #brandbar { position: absolute; left: 96px; right: 96px; top: 300px; display: flex; align-items: center; gap: 20px; }
      #brandname { font-size: 34px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: ${c.textMuted ?? "#8d9aa8"}; }
      #site { position: absolute; left: 96px; top: 1400px; font-size: 36px; font-weight: 600; color: ${c.textMuted ?? "#8d9aa8"}; }

      #progress { position: absolute; left: 0; top: 1904px; height: 16px; width: ${W}px; background: ${accent}; transform-origin: 0 50%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="reel" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
      <div id="bg">
        ${background}
        <div id="bg-tint"></div>
        <div id="bg-scrim"></div>
      </div>

      <div id="brandbar"><span id="brandname">${esc(brand.name ?? "")}</span></div>
      <div id="site">${esc(brand.site ?? "")}</div>
${beatMarkup}
      <div id="progress"></div>

      <!-- The framework owns playback: it seeks and decodes this wherever it
           sits in the DOM. Nothing here plays it.
           data-start AND id are both REQUIRED: the renderer discovers media
           by id, so without one the reel renders SILENT - and a silent reel
           looks like a working reel until someone plays it. -->
      <audio id="voiceover" src="${esc(audioFile)}" data-start="0" data-duration="${audioDuration}" data-track-index="0"></audio>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });

      // Slow push on the background for the whole reel. fromTo, never a CSS
      // transform plus a tween on the same property — that pair is rejected.
      gsap.utils.toArray("#bg-image").forEach(function (el) {
        tl.fromTo(el, { scale: 1.0, xPercent: 0 }, { scale: 1.09, xPercent: -1.5, duration: ${duration}, ease: "none" }, 0);
      });

      // The brand mark settles once, then stays out of the way.
      tl.fromTo("#brandbar", { autoAlpha: 0, y: -18 }, { autoAlpha: 1, y: 0, duration: 0.7, ease: "power2.out" }, 0.15);
      tl.fromTo("#site", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.7, ease: "power2.out" }, 0.35);

      // A read-along bar: finite, seek-safe, and it tells a scroller how much
      // is left, which measurably holds them.
      tl.fromTo("#progress", { scaleX: 0 }, { scaleX: 1, duration: ${duration}, ease: "none" }, 0);

      // One in/out per beat. The target is the WRAPPER inside each clip — the
      // framework alone controls .clip visibility, and animating the clip
      // fights it.
      const beats = ${JSON.stringify(timings)};
      beats.forEach(function (b, i) {
        const inner = "#beat-inner-" + i;
        tl.fromTo(inner, { autoAlpha: 0, y: 46 }, { autoAlpha: 1, y: 0, duration: 0.55, ease: "power3.out" }, b.start);
        tl.fromTo(inner + " .beat-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: "power2.out", transformOrigin: "0 50%" }, b.start + 0.1);
        // Out only if another beat follows; the last one holds to the cut.
        if (i < beats.length - 1) {
          tl.to(inner, { autoAlpha: 0, y: -28, duration: 0.4, ease: "power2.in" }, b.start + b.duration - 0.4);
        }
      });

      window.__timelines["reel"] = tl;
    </script>
  </body>
</html>
`;

  return { html, duration };
}
