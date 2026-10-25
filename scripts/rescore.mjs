#!/usr/bin/env node
// Recompute scores from stored facts after a rubric change (no network).
// Reads the newest of .local/data/evaluation.json and data/evaluation.json; writes to .local/data/ unless in CI.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { RUBRIC_VERSION, scoreEntry } from "./rubric.mjs";
import { root, outData, trackedData, IS_CI } from "./paths.mjs";

const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const candidates = [];
for (const f of [path.join(outData, "evaluation.json"), path.join(trackedData, "evaluation.json")])
  if (existsSync(f)) candidates.push(JSON.parse(await readFile(f, "utf8")));
const ev = candidates.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0];
if (!ev) throw new Error("No evaluation data found; run npm run evaluate first.");
for (const e of catalog) {
  const f = ev.entries[e.id];
  if (f) Object.assign(f, scoreEntry(e, f));
}
ev.rubricVersion = RUBRIC_VERSION;
ev.rescoredAt = new Date().toISOString();
await mkdir(outData, { recursive: true });
const out = path.join(outData, "evaluation.json");
await writeFile(out, JSON.stringify(ev, null, 2) + "\n");
console.log(`Rescored ${Object.keys(ev.entries).length} entries → ${path.relative(root, out)}${IS_CI ? "" : " (local preview)"}`);
