#!/usr/bin/env node
// Create or refresh catalog entries from Bioregistry, keeping provenance of where each field came from.
//   node scripts/import-bioregistry.mjs <prefix>[:category[:domain2,domain3]] ...
//   node scripts/import-bioregistry.mjs --seed data/seed.json      # bulk: [{prefix, category, domains, overrides}]
// Curated fields already in the catalog (usedBy, modules, tools, overrides) are kept; registry fields are refreshed.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./paths.mjs";
import { validateCatalog } from "./validate-lib.mjs";

const catalogPath = path.join(root, "data/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const categories = JSON.parse(await readFile(path.join(root, "data/categories.json"), "utf8"));
const args = process.argv.slice(2);

let jobs = [];
if (args[0] === "--seed") jobs = JSON.parse(await readFile(path.resolve(args[1]), "utf8"));
else jobs = args.map((a) => {
  const [prefix, category, domains] = a.split(":");
  return { prefix, category, domains: domains ? domains.split(",") : [] };
});
if (!jobs.length) {
  console.error("usage: import-bioregistry.mjs <prefix>[:category[:domains]] ... | --seed file.json");
  process.exit(2);
}

const LICENSE = { "CC-BY-4.0": "CC BY 4.0", "CC-BY-3.0": "CC BY 3.0", "CC0-1.0": "CC0 1.0", "CC-BY-SA-4.0": "CC BY-SA 4.0", "CC-BY-SA-3.0": "CC BY-SA 3.0", "CC-BY-1.0": "CC BY 1.0" };
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
function shorten(text, max = 560) {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

async function fetchBioregistry(prefix) {
  const url = `https://bioregistry.io/api/registry/${encodeURIComponent(prefix)}`;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "schemascope-importer/1.0 (+https://schemascope.org)" } });
  if (!r.ok) throw new Error(`${prefix}: Bioregistry HTTP ${r.status}`);
  return { url, d: await r.json(), retrievedAt: new Date().toISOString() };
}

let changed = 0;
for (const job of jobs) {
  const { url, d, retrievedAt } = await fetchBioregistry(job.prefix);
  const m = d.mappings || {};
  const fields = [];
  const pick = (name, value) => {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return undefined;
    fields.push(name);
    return value;
  };
  const formats = [d.download_owl && "OWL", d.download_obo && "OBO", d.download_rdf && "RDF", d.download_json && "JSON"].filter(Boolean);
  const fromRegistry = {
    id: d.prefix.replace(/[^a-z0-9]+/g, "-"),
    acronym: pick("acronym", d.preferred_prefix || d.prefix.toUpperCase()),
    name: pick("name", clean(d.name)),
    description: pick("description", shorten(d.description)),
    homepage: pick("homepage", d.homepage),
    repository: pick("repository", d.repository),
    download: pick("download", d.download_owl || d.download_rdf || d.download_obo || d.download_json),
    formats: pick("formats", formats),
    license: pick("license", d.license ? LICENSE[d.license] || d.license : undefined),
    ols: pick("ols", m.ols),
    obo: pick("obo", m.obofoundry ? String(m.obofoundry).toLowerCase() : undefined),
    bioportal: pick("bioportal", m.bioportal),
    bioregistry: d.prefix,
    publications: pick("publications", (d.publications || []).filter((p) => p.doi && clean(p.title)).slice(0, 2).map((p) => ({ title: clean(p.title), doi: p.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, ""), ...(p.year ? { year: Number(p.year) } : {}) }))),
    tags: pick("tags", (d.keywords || []).slice(0, 6).map((k) => String(k).toLowerCase())),
    ...(d.deprecated ? { status: "legacy" } : {}),
  };
  const idx = catalog.findIndex((e) => e.id === fromRegistry.id || e.bioregistry === d.prefix);
  const old = idx >= 0 ? catalog[idx] : {};
  const overrides = job.overrides || old.provenance?.overrides || {};
  const entry = {
    ...Object.fromEntries(Object.entries(fromRegistry).filter(([, v]) => v !== undefined)),
    category: job.category || old.category,
    kind: overrides.kind || old.kind || (formats.some((f) => ["OWL", "OBO"].includes(f)) || m.obofoundry || m.ols ? "ontology" : "vocabulary"),
    ...(job.domains?.length || old.domains?.length ? { domains: job.domains?.length ? job.domains : old.domains } : {}),
    usedBy: old.usedBy || [],
    ...(old.modules ? { modules: old.modules } : {}),
    ...(old.tools ? { tools: old.tools } : {}),
    ...overrides,
  };
  if (!entry.publications) entry.publications = [];
  if (!entry.tags) entry.tags = [];
  if (!entry.formats) entry.formats = [];
  entry.provenance = {
    source: "Bioregistry",
    url,
    page: `https://bioregistry.io/${d.prefix}`,
    retrievedAt,
    fields: fields.filter((f) => !(f in overrides)),
    ...(Object.keys(overrides).length ? { overrides, overridesNote: "curated by SchemaScope, takes precedence over the registry value" } : {}),
  };
  if (idx >= 0) catalog[idx] = entry;
  else catalog.push(entry);
  changed++;
  console.log(`${idx >= 0 ? "updated" : "added  "} ${entry.id.padEnd(12)} ${entry.category.padEnd(12)} ${entry.name}`);
}

const problems = validateCatalog(catalog, categories);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(`✓ ${changed} entries imported with provenance → data/catalog.json`);
