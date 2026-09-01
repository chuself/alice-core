/**
 * Operational settings the owner changes by messaging the bot — the shape of a
 * posting day, as opposed to state/steer.md which shapes what gets written.
 *
 * A day is a list of SLOTS, each with an hour and a format. Counts are not a
 * separate setting: three posters and one reel is simply four slots, three of
 * which say "poster". The previous model kept hours and counts apart, which made
 * "3 posters and 1 reel at 8, 13, 16 and 20" impossible to express.
 *
 * Validated hard: this decides how often the account posts, so a bad value is
 * worse than a rejected instruction.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const FILE = path.join(ROOT, "state", "config.json");

export const FORMATS = new Set(["poster", "reel"]);

export const DEFAULTS = {
  // Local (EAT) hours. One entry per post.
  slots: [{ hour: 9, format: "poster" }],
};

/**
 * The plan ceiling, written by the dashboard into state/limits.json.
 *
 * This is what the client cannot talk their way past: they may move hours and
 * swap a poster for a reel over Telegram, but not buy themselves a fourth post
 * a day by asking nicely. `updateConfig` reports every rejection back through
 * `inbox.js`, so the upsell happens in the conversation.
 *
 * Read once at import: a run that started under one plan should finish under
 * it. Defaults are the widest any plan allows, so an unmanaged install behaves
 * exactly as it did before the platform existed.
 */
const DEFAULT_LIMITS = {
  maxSlotsPerDay: 6,
  maxReelsPerDay: 2,
  minHour: 6,
  maxHour: 23,
};

export const LIMITS = (() => {
  const file = path.join(ROOT, "state", "limits.json");
  if (!existsSync(file)) return DEFAULT_LIMITS;
  try {
    const plan = JSON.parse(readFileSync(file, "utf8"));
    return {
      maxSlotsPerDay: plan.maxSlotsPerDay ?? DEFAULT_LIMITS.maxSlotsPerDay,
      maxReelsPerDay: plan.maxReelsPerDay ?? DEFAULT_LIMITS.maxReelsPerDay,
      minHour: plan.minHour ?? DEFAULT_LIMITS.minHour,
      maxHour: plan.maxHour ?? DEFAULT_LIMITS.maxHour,
      planName: plan.planName ?? null,
    };
  } catch {
    // A corrupt ceiling must not widen the ceiling.
    return DEFAULT_LIMITS;
  }
})();

export async function readConfig() {
  let raw = {};
  if (existsSync(FILE)) {
    try {
      raw = JSON.parse(await readFile(FILE, "utf8"));
    } catch {
      raw = {};
    }
  }
  // Only fall back to DEFAULTS when the file has neither shape, otherwise the
  // default slots would mask an older postHours config and silently reset the day.
  const hasShape = Array.isArray(raw.slots) || Array.isArray(raw.postHours);
  return withDerived(hasShape ? { ...raw } : { ...DEFAULTS, ...raw });
}

/**
 * Older configs stored postHours + postsPerDay + reelsPerWeek. Convert rather
 * than break: a config written before slots existed still has to work.
 */
function withDerived(cfg) {
  if (!Array.isArray(cfg.slots) || !cfg.slots.length) {
    const hours = Array.isArray(cfg.postHours) && cfg.postHours.length ? cfg.postHours : [9];
    cfg.slots = hours.map((hour) => ({ hour, format: "poster" }));
  }
  cfg.slots = [...cfg.slots].sort((a, b) => a.hour - b.hour);
  cfg.postersPerDay = cfg.slots.filter((s) => s.format === "poster").length;
  cfg.reelsPerDay = cfg.slots.filter((s) => s.format === "reel").length;
  return cfg;
}

/**
 * Apply a change. Returns { config, changes, rejected } so the owner can be told
 * exactly what took effect — silent clamping would be worse than saying no.
 */
export async function updateConfig(patch) {
  const current = await readConfig();
  const changes = [];
  const rejected = [];
  let slots = current.slots;

  if (Array.isArray(patch.slots) && patch.slots.length) {
    const cleaned = [];
    for (const s of patch.slots) {
      const hour = Number(s?.hour);
      const format = String(s?.format ?? "poster").toLowerCase();
      if (!Number.isInteger(hour) || hour < LIMITS.minHour || hour > LIMITS.maxHour) {
        rejected.push(`hour ${s?.hour} (allowed ${LIMITS.minHour}-${LIMITS.maxHour})`);
        continue;
      }
      if (!FORMATS.has(format)) {
        rejected.push(`format "${s?.format}"`);
        continue;
      }
      if (cleaned.some((c) => c.hour === hour)) {
        rejected.push(`duplicate hour ${hour}`);
        continue;
      }
      cleaned.push({ hour, format });
    }

    if (cleaned.length > LIMITS.maxSlotsPerDay) {
      rejected.push(`${cleaned.length} slots (max ${LIMITS.maxSlotsPerDay} a day)`);
    } else if (cleaned.filter((c) => c.format === "reel").length > LIMITS.maxReelsPerDay) {
      rejected.push(`too many reels (max ${LIMITS.maxReelsPerDay} a day)`);
    } else if (cleaned.length) {
      cleaned.sort((a, b) => a.hour - b.hour);
      if (describe(cleaned) !== describe(current.slots)) {
        slots = cleaned;
        changes.push(`day is now ${describe(cleaned)}`);
      }
    }
  }

  if (changes.length) {
    await writeFile(FILE, JSON.stringify({ slots }, null, 2));
  }
  return { config: withDerived({ slots }), changes, rejected };
}

export function describe(slots) {
  return slots.map((s) => `${s.hour}:00 ${s.format}`).join(", ");
}

/**
 * Sensible hours for a given number of posts. An even mathematical spread puts
 * posts at 6am; these are hand-picked reading moments.
 */
const SPREAD = {
  1: [9],
  2: [9, 17],
  3: [8, 13, 19],
  4: [8, 12, 16, 20],
  5: [8, 11, 14, 17, 20],
  6: [8, 10, 13, 16, 19, 21],
};

export function spreadHours(n) {
  if (SPREAD[n]) return SPREAD[n];
  const { minHour, maxHour } = LIMITS;
  const step = (maxHour - minHour) / Math.max(1, n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(minHour + step * i));
}
