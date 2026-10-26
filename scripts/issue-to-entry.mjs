#!/usr/bin/env node
// Turns a "Add / update a resource" issue into a change to data/catalog.json and data/curated.json.
// Used by .github/workflows/submission.yml. Reads the issue body from ISSUE_BODY (and ISSUE_NUMBER, for provenance).
// The harvest rebuilds catalog.json from the registries plus curated.json, so a submission must land in
// curated.json too or the next `npm run harvest` drops it.
// Writes `id`, `mode` and `summary` to $GITHUB_OUTPUT; exits non-zero with a readable message on bad input.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCatalog } from "./validate-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalogPath = path.join(root, "data/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const curatedPath = path.join(root, "data/curated.json");
const curated = JSON.parse(await readFile(curatedPath, "utf8"));
const categories = JSON.parse(await readFile(path.join(root, "data/categories.json"), "utf8"));
const body = process.env.ISSUE_BODY || "";

async function out(k, v) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${k}<<EOF\n${v}\nEOF\n`);
  else console.log(`${k}=${v}`);
}
async function fail(msg) {
  await out("error", msg);
  console.error(msg);
  process.exit(1);
}

// Issue forms render each field as "### Label\n\nvalue".
const field = (label) => body.match(new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s|$)`, "i"))?.[1]?.trim();
const json = body.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1];
if (!json) await fail("Couldn't find a ```json block with the entry in the issue.");
let entry;
try {
  entry = JSON.parse(json);
} catch (e) {
  await fail(`The entry JSON doesn't parse: ${e.message}`);
}
if (Array.isArray(entry)) entry = entry[0];
delete entry.provenance; // set below, never taken from the submitter

const updateId = (field("Existing entry id \\(for corrections\\)") || "").replace(/_No response_/i, "").trim() || null;
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
entry.id = slug(updateId || entry.id || entry.acronym || entry.name);

// Fill publication titles/years from Crossref so submitters only need the DOI.
for (const p of entry.publications || []) {
  p.doi = String(p.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(p.doi)}`, { headers: { "User-Agent": "schemascope-bot/1.0 (https://schemascope.org)" } });
    if (r.ok) {
      const m = (await r.json()).message;
      if (!p.title || p.title.startsWith("(")) p.title = m.title?.[0] || p.title;
      p.year ??= m.issued?.["date-parts"]?.[0]?.[0];
    }
  } catch {}
}

const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const curatedBy = process.env.ISSUE_NUMBER ? `submission #${process.env.ISSUE_NUMBER}` : "submission";
// Fields the submitter filled in. They become curated overrides, which the harvest applies on top of registry values.
const submitted = Object.fromEntries(Object.entries(entry).filter(([k, v]) => k !== "id" && v != null && v !== "" && !(Array.isArray(v) && !v.length)));

let mode;
const idx = catalog.findIndex((e) => e.id === entry.id);
if (updateId) {
  if (idx < 0) await fail(`There is no entry "${updateId}" to update.`);
  // Keep fields the submitter didn't send (e.g. curated modules/tools).
  const prev = catalog[idx];
  const prov = prev.provenance || { source: "curated", curatedAt: now };
  catalog[idx] = {
    ...prev,
    ...submitted,
    provenance: { ...prov, overrides: { ...prov.overrides, ...submitted }, overridesNote: "curated by SchemaScope, takes precedence over registry values" },
  };
  mode = "update";
} else {
  if (idx >= 0) await fail(`An entry with id "${entry.id}" already exists. If this is a correction, put "${entry.id}" in the "Existing entry id" field.`);
  catalog.push({ publications: [], usedBy: [], tags: [], ...entry, provenance: { source: "curated", curatedAt: now, curatedBy, note: "Submitted through schemascope.org/submit." } });
  mode = "add";
}

// Mirror the result into curated.json. Registry-only fields (registries, per-field sources) stay out:
// the harvest re-adds them when a registry lists the resource.
const ci = curated.findIndex((e) => e.id === entry.id);
const base = ci >= 0 ? curated[ci] : catalog[idx >= 0 ? idx : catalog.length - 1];
const keepSource = ["curated", "Bioregistry", "NeuroSchema catalog"].includes(base.provenance?.source) ? base.provenance.source : "curated";
const record = {
  ...base,
  ...submitted,
  provenance: {
    ...base.provenance,
    source: keepSource,
    curatedAt: now,
    curatedBy,
    overrides: { ...base.provenance?.overrides, ...submitted },
  },
};
for (const k of ["registries", "fields", "retrievedAt", "mergedIds"]) delete record.provenance[k];
if (ci >= 0) curated[ci] = record;
else curated.push(record);

const problems = validateCatalog(catalog, categories);
if (problems.length) await fail(`The entry has problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);

// Same formatting as scripts/harvest.py, so a submission PR only shows the changed entry.
await writeFile(catalogPath, JSON.stringify(catalog, null, 1) + "\n");
await writeFile(curatedPath, JSON.stringify(curated, null, 1));
await out("id", entry.id);
await out("mode", mode);
const saved = catalog.find((e) => e.id === entry.id);
await out("summary", `${mode === "add" ? "Add" : "Update"} ${saved.acronym || saved.name} (\`${entry.id}\`)`);
console.log(`${mode}: ${entry.id}`);
