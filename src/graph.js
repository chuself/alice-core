const VERSION = process.env.GRAPH_VERSION ?? "v21.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

/** POST to the Graph API and throw a readable error on failure. */
export async function graphPost(edge, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(`${BASE}/${edge}`, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new Error(
      `Graph POST ${edge} failed (${res.status}): ${e.message ?? "unknown"}` +
        (e.code ? ` [code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}]` : "")
    );
  }
  return json;
}

export async function graphGet(edge, params) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${BASE}/${edge}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Graph GET ${edge} failed (${res.status}): ${json.error?.message ?? "unknown"}`);
  }
  return json;
}
