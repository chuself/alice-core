#!/usr/bin/env node
/**
 * Two-way sync between state/queue.json and the Google Sheet.
 *
 *   node --env-file=.env src/cli-sheet.js
 *
 * Pulls whatever you typed in the Status column first, then pushes the queue back
 * so the Sheet always reflects reality. Your edits win over the local file.
 */
import { readQueue, writeQueue } from "./queue.js";
import { sheetConfigured, pushQueue, pullStatuses } from "./sheet.js";

if (!sheetConfigured()) {
  console.log("Sheet not configured (needs GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID) — skipping.");
  process.exitCode = 0;
} else {
  const queue = await readQueue();

  // 1. Your edits win — but a posted row is history and can never be reopened.
  const statuses = await pullStatuses();
  let changed = 0;
  for (const row of queue) {
    const wanted = statuses[row.id];
    if (wanted && wanted !== row.status && row.status !== "posted") {
      console.log(`  ${row.id}: ${row.status} -> ${wanted}`);
      row.status = wanted;
      changed++;
    }
  }
  if (changed) await writeQueue(queue);
  console.log(`pulled ${changed} status change(s) from the Sheet`);

  // 2. Push the current state back
  const n = await pushQueue(queue, (process.env.PUBLIC_ASSET_BASE ?? "").replace(/\/$/, ""));
  console.log(`pushed ${n} row(s) to the Sheet`);
}
