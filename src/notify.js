/**
 * Outbound alerts. Telegram is the control channel (it can receive replies);
 * WhatsApp is an optional mirror for whoever lives in WhatsApp all day.
 *
 * Everything no-ops silently when unconfigured, so the pipeline never fails
 * just because notifications are not set up yet.
 */
const API = "https://api.telegram.org/bot";

export function notifyConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export function whatsappConfigured() {
  return Boolean(
    (process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY) ||
      (process.env.WA_PHONE_NUMBER_ID && process.env.WA_TOKEN && process.env.WA_TO)
  );
}

/**
 * @param {string} text  HTML for Telegram; tags are stripped for WhatsApp.
 * @param {object} opts
 *   silent   — no push sound on Telegram
 *   mirror   — also send to WhatsApp (default true; noisy internals pass false)
 */
export async function notify(text, { silent = false, mirror = true } = {}) {
  let ok = false;

  if (notifyConfigured()) {
    ok = await sendTelegram(text, silent);
  } else {
    console.log(`[notify skipped — Telegram not configured]\n${text}`);
  }

  // A WhatsApp failure must never mask a delivered Telegram alert.
  if (mirror && whatsappConfigured()) {
    try {
      await sendWhatsApp(stripHtml(text));
    } catch (err) {
      console.error(`WhatsApp mirror failed: ${err.message}`);
    }
  }
  return ok;
}

async function sendTelegram(text, silent) {
  const res = await fetch(`${API}${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: silent,
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`Telegram failed: ${json.description ?? res.status}`);
    return false;
  }
  return true;
}

/**
 * Two WhatsApp routes:
 *  - CallMeBot: free, one-way, third-party relay. Good enough for alerts.
 *  - Meta Cloud API: official and reliable, but a message sent more than 24h
 *    after your last inbound needs a paid template, so it is opt-in.
 */
async function sendWhatsApp(text) {
  const body = text.slice(0, 900);

  if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_TOKEN && process.env.WA_TO) {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.WA_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: process.env.WA_TO,
          type: "text",
          text: { body },
        }),
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return true;
  }

  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(process.env.CALLMEBOT_PHONE)}` +
    `&text=${encodeURIComponent(body)}&apikey=${encodeURIComponent(process.env.CALLMEBOT_APIKEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`CallMeBot HTTP ${res.status}`);
  return true;
}

/**
 * Deliver a finished video to Telegram so it can be posted by hand where no
 * automatic route exists (TikTok, until an audited path is in place).
 * Telegram fetches the file itself, so the URL must be public and under ~20MB.
 */
export async function sendVideo(videoUrl, caption) {
  if (!notifyConfigured()) {
    console.log(`[video not sent — Telegram not configured] ${videoUrl}`);
    return false;
  }
  const res = await fetch(`${API}${process.env.TELEGRAM_BOT_TOKEN}/sendVideo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      video: videoUrl,
      caption: caption.slice(0, 1000),
      parse_mode: "HTML",
      supports_streaming: true,
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`sendVideo failed: ${json.description ?? res.status}`);
    // Fall back to a plain link — better a link than nothing.
    await notify(`${caption}

${videoUrl}`, { mirror: false });
    return false;
  }
  return true;
}

/** Failures must be loud — this is how an unattended pipeline asks for help. */
export async function notifyFailure(what, err) {
  await notify(
    `⚠️ <b>Social Autopilot</b>\n${what}\n\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`
  );
}

function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
