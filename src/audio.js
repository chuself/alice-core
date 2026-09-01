/**
 * Voiceover. Microsoft Edge's neural voices are free, need no key, and include
 * real Tanzanian Swahili (sw-TZ) — which is why narration beats ambient music
 * here: the audience gets spoken Kiswahili, not a stock loop.
 *
 * Falls back to a soft ambient pad, then to silence. A reel is never blocked
 * for want of audio.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const run = promisify(execFile);

/**
 * Gemini's prebuilt voices. Aoede handles both English and Kiswahili well, which
 * is why it leads — one voice keeps the channel sounding like one brand.
 */
const GEMINI_VOICE = process.env.GEMINI_TTS_VOICE ?? "Aoede";
const GEMINI_TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"];

export const VOICES = {
  sw: ["sw-TZ-RehemaNeural", "sw-TZ-DaudiNeural"],
  en: ["en-KE-AsiliaNeural", "en-GB-SoniaNeural"],
};

/**
 * @param {string} text      what to say
 * @param {string} language  "sw" | "en"
 * @param {string} outFile   .mp3 to write
 * @returns {Promise<string|null>} the file, or null if every route failed
 */
export async function speak(text, language, outFile) {
  if (process.env.SKIP_AUDIO === "1") return null;
  await mkdir(path.dirname(outFile), { recursive: true });

  // Gemini first (Aoede), Edge neural second, ambient pad last.
  const viaGemini = await geminiSpeak(text, language, outFile);
  if (viaGemini) return viaGemini;

  const voices = VOICES[language] ?? VOICES.en;
  for (const voice of voices) {
    try {
      await run(
        pythonBin(),
        [
          "-m", "edge_tts",
          "--voice", voice,
          // Equals form is required: a bare "-4%" is parsed as another flag.
          `--rate=${process.env.TTS_RATE ?? "-4%"}`,
          "--text", text,
          "--write-media", outFile,
        ],
        { maxBuffer: 1024 * 1024 * 16 }
      );
      if (existsSync(outFile)) {
        console.log(`  voiceover: ${voice}`);
        return outFile;
      }
    } catch (err) {
      console.warn(`  tts ${voice} failed: ${String(err.message).slice(0, 120)}`);
    }
  }

  try {
    await ambientPad(outFile, 10);
    console.log("  voiceover unavailable — using an ambient pad");
    return outFile;
  } catch {
    console.warn("  no audio at all — the reel will be silent");
    return null;
  }
}

/**
 * A calm synthesised pad, built with ffmpeg alone so it needs no downloads and
 * carries no licensing question.
 */
export async function ambientPad(outFile, seconds = 10) {
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=110:duration=${seconds}`,
    "-f", "lavfi",
    "-i", `sine=frequency=165:duration=${seconds}`,
    "-filter_complex",
    "[0:a]volume=0.14[a0];[1:a]volume=0.09[a1];[a0][a1]amix=inputs=2," +
      "aformat=channel_layouts=stereo,lowpass=f=900,areverb=dry=8:wet=4," +
      `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, seconds - 2)}:d=2`,
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    outFile,
  ]).catch(async () => {
    // areverb is not in every ffmpeg build — retry without it.
    await run("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=110:duration=${seconds}`,
      "-f", "lavfi",
      "-i", `sine=frequency=165:duration=${seconds}`,
      "-filter_complex",
      "[0:a]volume=0.14[a0];[1:a]volume=0.09[a1];[a0][a1]amix=inputs=2," +
        "aformat=channel_layouts=stereo,lowpass=f=900," +
        `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, seconds - 2)}:d=2`,
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      outFile,
    ]);
  });
  return outFile;
}

function pythonBin() {
  return process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
}

/**
 * Gemini TTS returns raw 24 kHz mono PCM, not a container, so it has to be
 * wrapped before anything else can read it.
 */
async function geminiSpeak(text, language, outFile) {
  if (!process.env.GEMINI_API_KEY || process.env.SKIP_GEMINI_TTS === "1") return null;

  const styled =
    language === "sw"
      ? `Say this warmly and clearly, as a Tanzanian presenter would: ${text}`
      : `Say this warmly and clearly: ${text}`;

  for (const model of GEMINI_TTS_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: styled }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
              },
            },
          }),
          signal: AbortSignal.timeout(90_000),
        }
      );
      const json = await res.json();
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) throw new Error(json.error?.message ?? "no audio returned");

      const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? "24000";
      const raw = `${outFile}.pcm`;
      await writeFile(raw, Buffer.from(part.inlineData.data, "base64"));
      await run("ffmpeg", [
        "-y",
        "-f", "s16le",
        "-ar", rate,
        "-ac", "1",
        "-i", raw,
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        outFile,
      ]);
      await rm(raw, { force: true });

      if (existsSync(outFile)) {
        console.log(`  voiceover: Gemini ${GEMINI_VOICE} (${model})`);
        return outFile;
      }
    } catch (err) {
      console.warn(`  gemini tts ${model} failed: ${String(err.message).slice(0, 110)}`);
    }
  }
  return null;
}
