/**
 * Encrypted state that CI can write.
 *
 * Metricool rotates its refresh token on every use, so the replacement has to be
 * persisted between runs. GITHUB_TOKEN cannot write repo secrets, and this repo
 * is public — but it CAN commit files, and ciphertext in a public repo is inert
 * without the key. So the token lives encrypted in the repo, and only the key
 * lives in a secret.
 *
 * AES-256-GCM: authenticated, so a corrupted or tampered file fails loudly
 * rather than silently decrypting to nonsense.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";


function key() {
  const raw = process.env.METRICOOL_KEY;
  if (!raw) throw new Error("METRICOOL_KEY is not set");
  // Accept any passphrase length; hash to exactly 32 bytes.
  return createHash("sha256").update(raw).digest();
}

export function sealedPath(name = "metricool") {
  return path.join(ROOT, "state", `${name}.enc`);
}

export async function seal(obj, name) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const payload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
    updated: new Date().toISOString(),
  };
  await writeFile(sealedPath(name), JSON.stringify(payload, null, 2));
  return payload;
}

export async function unseal(name) {
  const file = sealedPath(name);
  if (!existsSync(file)) return null;
  const p = JSON.parse(await readFile(file, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(p.iv, "base64"));
  decipher.setAuthTag(Buffer.from(p.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(p.data, "base64")), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}
