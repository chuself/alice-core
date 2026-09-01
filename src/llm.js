/**
 * Text brain. Gemini free tier first, Groq as fallback so a single exhausted
 * quota never stops the line.
 *
 * MOCK_LLM=1 returns a canned post so the whole pipeline can be exercised
 * before any API key exists.
 */
// Tried in order — free-tier models go "high demand" often enough that a single
// model id is a real outage risk for an unattended poster.
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : [
      // Full models first for quality, then the lite tier — which draws on a
      // SEPARATE free quota pool, so it keeps working after the others are spent.
      "gemini-3.5-flash",
      "gemini-flash-latest",
      "gemini-3.6-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemini-flash-lite-latest",
    ];
// Verified live 2026-08-21. The previously hardcoded llama-3.3-70b-versatile
// had been retired — a fallback that only fails when you finally need it.
const GROQ_MODELS = process.env.GROQ_MODEL
  ? [process.env.GROQ_MODEL]
  : ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

export async function completeJson(prompt, { schemaHint } = {}) {
  if (process.env.MOCK_LLM === "1") return mockPost();

  const errors = [];
  for (const provider of [gemini, groq]) {
    if (!provider.available()) continue;
    try {
      return await provider.run(prompt, schemaHint);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }
  throw new Error(
    errors.length
      ? `All LLM providers failed —\n  ${errors.join("\n  ")}`
      : "No LLM configured. Set GEMINI_API_KEY (or GROQ_API_KEY), or run with MOCK_LLM=1."
  );
}

const gemini = {
  name: "gemini",
  available: () => Boolean(process.env.GEMINI_API_KEY),
  async run(prompt) {
    let last;
    for (const model of GEMINI_MODELS) {
      // Two goes per model: a transient network blip should not cost a day's post.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await callGemini(model, prompt);
        } catch (err) {
          last = err;
          const transient = /fetch failed|ECONN|ETIMEDOUT|socket|network|high demand|503|429/i.test(err.message);
          console.warn(`  gemini/${model}${attempt > 1 ? " (retry)" : ""}: ${err.message.slice(0, 90)}`);
          if (!transient) break;
          if (attempt === 1) await new Promise((r) => setTimeout(r, 4000));
        }
      }
    }
    throw last;
  },
};

async function callGemini(model, prompt) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
        }),
      }
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("empty response");
    return parseJson(text);
}

const groq = {
  name: "groq",
  available: () => Boolean(process.env.GROQ_API_KEY),
  async run(prompt) {
    let last;
    for (const model of GROQ_MODELS) {
      try {
        return await callGroq(model, prompt);
      } catch (err) {
        last = err;
        console.warn(`  groq/${model}: ${err.message.slice(0, 90)}`);
      }
    }
    throw last;
  },
};

async function callGroq(model, prompt) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.9,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("empty response");
    return parseJson(text);
}

/** Models sometimes wrap JSON in a fence despite being told not to. */
function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`response was not JSON: ${cleaned.slice(0, 200)}`);
  }
}

function mockPost() {
  // Deliberately generic: MOCK_LLM exists to exercise the pipeline with no API
  // key, on any brand, so the canned copy must not belong to a client.
  return {
    eyebrow: "Sample",
    headline: "A sample headline, written without an API key.",
    body: "This post came from MOCK_LLM. It exists to prove the pipeline runs end to end before any credential is connected.",
    cta: "See it work",
    caption:
      "This is sample copy produced with MOCK_LLM=1.\n\nNo model was called and no credential was used.",
    hashtags: ["#Sample", "#Alice"],
    imagePrompt:
      "Soft-focus abstract background in a dark colour grade, subject right of centre, low contrast, no text, no people, no logos",
    template: "spotlight",
  };
}
