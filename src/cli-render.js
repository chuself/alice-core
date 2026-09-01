#!/usr/bin/env node
/**
 * Step 1 of 2: render the poster PNG into ./public.
 * The PNG must be live on Cloudflare Pages BEFORE cli-publish runs — Instagram
 * fetches the image URL server-side, so publishing first always fails.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderPoster } from "./render.js";
import { DEFAULT_BRAND } from "./brand-id.js";
import { ROOT } from "./paths.js";

const postFile = process.argv[2] ?? "state/sample-post.json";
const post = JSON.parse(await readFile(path.resolve(ROOT, postFile), "utf8"));

const out = path.join(ROOT, "public", `${post.id}.png`);
await renderPoster(post, post.brand ?? DEFAULT_BRAND, out);
console.log(`rendered -> ${path.relative(ROOT, out)}`);
