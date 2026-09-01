#!/usr/bin/env node
/**
 * The one command every tenant workflow calls.
 *
 *   npx alice plan --days 1
 *   npx alice publish
 *   npx alice verify
 *
 * Each subcommand is a module that runs on import — the CLIs are top-level-await
 * scripts, so dispatching is a dynamic import and nothing else. That keeps the
 * engine's entry points identical to what has been running in production.
 *
 * The tenant directory is the working directory. src/paths.js explains why that
 * matters more than it looks.
 */
const COMMANDS = {
  plan: "../src/cli-plan.js",
  publish: "../src/cli-publish.js",
  reel: "../src/cli-reel-hf.js",
  "reel-legacy": "../src/cli-reel.js",
  "publish-reel": "../src/cli-publish-reel.js",
  engage: "../src/cli-engage.js",
  listen: "../src/cli-listen.js",
  "listen-live": "../src/cli-listen-live.js",
  digest: "../src/cli-digest.js",
  metrics: "../src/cli-metrics.js",
  verify: "../src/cli-verify.js",
  preview: "../src/cli-preview.js",
  render: "../src/cli-render.js",
  "token-check": "../src/cli-token-check.js",
  sheet: "../src/cli-sheet.js",
};

const [, , command, ...rest] = process.argv;

if (!command || command === "--help" || command === "-h") {
  console.log("alice <command> [options]\n");
  for (const name of Object.keys(COMMANDS).sort()) console.log(`  ${name}`);
  console.log("\nRun from the tenant repository: the working directory is the tenant.");
  process.exit(command ? 0 : 1);
}

if (command === "--version" || command === "-v") {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  console.log(pkg.version);
  process.exit(0);
}

const target = COMMANDS[command];
if (!target) {
  console.error(`Unknown command "${command}". Try: ${Object.keys(COMMANDS).sort().join(", ")}`);
  process.exit(2);
}

// The subcommand reads process.argv itself, so hand it the arguments it would
// have seen when it was invoked directly as `node src/cli-plan.js …`.
process.argv = [process.argv[0], target, ...rest];

await import(new URL(target, import.meta.url).href);
