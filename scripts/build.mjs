#!/usr/bin/env node
// Builds the static site into dist/ from data/*.json. Templates live in scripts/site.mjs (shared with web/server.mjs).
import { writeFile, mkdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localData } from "./paths.mjs";
import { createSite, loadLocalData } from "./site.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const data = await loadLocalData();
const { catalog, categories, runs } = data;
const { files, evaluatedAt } = await createSite(data);

await rm(dist, { recursive: true, force: true });
await cp(path.join(root, "src/assets"), path.join(dist, "assets"), { recursive: true });
if (existsSync(path.join(root, "public"))) await cp(path.join(root, "public"), dist, { recursive: true });
for (const [p, render] of files) {
  const content = render();
  const out = path.join(dist, p);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, content);
}
if (existsSync(path.join(localData, "evaluation.json"))) console.log(`Note: previewing local evaluation data from .local/data (not committed). Deploys use data/ from the Evaluate catalog Action.`);
console.log(`Built ${files.size} files into dist/ (${catalog.length} entries, ${categories.length} categories, ${runs.length} archived run${runs.length === 1 ? "" : "s"}${evaluatedAt ? `, latest evaluation ${evaluatedAt}` : ""})`);
