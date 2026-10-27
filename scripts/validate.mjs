#!/usr/bin/env node
// Validate data/catalog.json.
//   node scripts/validate.mjs                    structural checks (fast, offline)
//   node scripts/validate.mjs --online           also check links, DOIs and registry ids
//   ONLY=id1,id2 node scripts/validate.mjs --online --report out.md
//                                                online checks for just these entries, and a Markdown report (for PR comments)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCatalog } from "./validate-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const categories = JSON.parse(await readFile(path.join(root, "data/categories.json"), "utf8"));
const args = process.argv.slice(2);
const online = args.includes("--online");
const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").filter(Boolean)) : null;

const errors = validateCatalog(catalog, categories);
const warnings = [];
const checks = [];

// Near-duplicate names (e.g. "Cell Ontology" vs "The Cell Ontology"): warn, don't fail.
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "ontology", "schema"].includes(w)));
const jaccard = (a, b) => {
  const A = words(a), B = words(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
};
const targets = catalog.filter((e) => !only || only.has(e.id));
for (const e of targets)
  for (const o of catalog)
    if (o.id !== e.id && jaccard(e.name, o.name) > 0.8) warnings.push(`entry "${e.id}": name is very similar to "${o.id}" (${o.name}) — check it isn't a duplicate`);

async function head(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; schemascope-validator/1.0)" } });
    await r.body?.cancel();
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

// GET with a timeout; one retry on rate limits, server errors and network failures. Returns the Response, or null.
async function get(url, opts = {}, timeout = 20000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch(url, { redirect: "follow", ...opts, signal: AbortSignal.timeout(timeout) });
      if (r.status === 429 || r.status >= 500) { await r.body?.cancel(); continue; }
      return r;
    } catch {}
  }
  return null;
}

// A DOI is checked against several registries, so one being down or rate-limiting CI doesn't fail the check.
// Each source answers found (with a title, if it has one), not found (HTTP 404), or unknown (unreachable).
const UA = { "User-Agent": "schemascope-validator/1.0 (https://schemascope.org)" };
const DOI_SOURCES = [
  ["Crossref", (d) => `https://api.crossref.org/works/${d}`, (j) => j.message?.title?.[0]],
  ["DataCite", (d) => `https://api.datacite.org/dois/${d}`, (j) => j.data?.attributes?.titles?.[0]?.title],
  ["OpenAlex", (d) => `https://api.openalex.org/works/doi:${d}`, (j) => j.title],
  ["Semantic Scholar", (d) => `https://api.semanticscholar.org/graph/v1/paper/DOI:${d}?fields=title`, (j) => j.title],
  ["doi.org", (d) => `https://doi.org/api/handles/${d}`, () => ""], // the DOI resolver itself: proves existence, has no title
];
async function lookupDoi(doi) {
  const d = String(doi).trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, "").split("/").map(encodeURIComponent).join("/");
  return Promise.all(DOI_SOURCES.map(async ([name, url, title]) => {
    const r = await get(url(d), { headers: { ...UA, Accept: "application/json" } });
    if (!r) return { name, status: "unknown" };
    if (r.status === 404) { await r.body?.cancel(); return { name, status: "missing" }; }
    if (!r.ok) { await r.body?.cancel(); return { name, status: "unknown" }; }
    const j = await r.json().catch(() => null);
    return j ? { name, status: "found", title: title(j) || "" } : { name, status: "unknown" };
  }));
}

if (online) {
  for (const e of targets) {
    for (const k of ["homepage", "repository", "download"]) {
      if (!e[k]) continue;
      const code = await head(e[k]);
      if (k === "download" && code >= 200 && code < 400) {
        const r = await get(e[k], { headers: { Range: "bytes=0-2047", Accept: "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, */*;q=0.1", "User-Agent": "schemascope-validator/1.0" } });
        const t = r ? (await r.text().catch(() => "")).trimStart().toLowerCase() : "";
        if (t.startsWith("<!doctype html") || t.startsWith("<html")) {
          checks.push({ id: e.id, what: "download is the artefact", ok: false, detail: `${e[k]} → HTML page (${r.url})` });
          errors.push(`entry "${e.id}": download ${e[k]} resolves to an HTML page (${r.url}), not the ontology/schema file`);
          continue;
        }
      }
      const ok = (code >= 200 && code < 400) || [401, 403, 406, 429].includes(code);
      checks.push({ id: e.id, what: `${k} resolves`, ok, detail: `${e[k]} → HTTP ${code || "error"}` });
      if (!ok) errors.push(`entry "${e.id}": ${k} ${e[k]} returned HTTP ${code || "error"}`);
    }
    for (const p of e.publications || []) {
      const res = await lookupDoi(p.doi);
      const found = res.filter((x) => x.status === "found");
      const missing = res.filter((x) => x.status === "missing").map((x) => x.name);
      if (!found.length) {
        // Not found only if the DOI resolver itself, or every registry, says 404; otherwise we couldn't tell.
        if (missing.includes("doi.org") || missing.length === res.length) {
          checks.push({ id: e.id, what: "DOI exists", ok: false, detail: `doi:${p.doi} not found (${missing.join(", ")})` });
          errors.push(`entry "${e.id}": DOI ${p.doi} not found in ${missing.join(", ")}`);
        } else {
          checks.push({ id: e.id, what: "DOI exists", ok: null, detail: `doi:${p.doi}: couldn't reach ${res.filter((x) => x.status === "unknown").map((x) => x.name).join(", ")}` });
          warnings.push(`entry "${e.id}": couldn't verify DOI ${p.doi} (DOI services unreachable); check it by hand`);
        }
        continue;
      }
      const titled = found.filter((x) => x.title);
      if (!titled.length) {
        checks.push({ id: e.id, what: "DOI exists", ok: true, detail: `doi:${p.doi} (${found.map((x) => x.name).join(", ")})` });
        continue;
      }
      const best = titled.map((x) => ({ ...x, sim: jaccard(x.title, p.title) })).sort((a, b) => b.sim - a.sim)[0];
      checks.push({ id: e.id, what: "DOI matches title", ok: best.sim >= 0.5, detail: `${best.name}: “${best.title}” (found in ${found.map((x) => x.name).join(", ")})` });
      if (best.sim < 0.5) warnings.push(`entry "${e.id}": DOI ${p.doi} resolves to “${best.title}”, which doesn't match the given title`);
    }
    if (e.ols) {
      const r = await get(`https://www.ebi.ac.uk/ols4/api/ontologies/${e.ols}`, { headers: UA });
      const d = r ? await r.json().catch(() => null) : null;
      const ok = r?.status === 404 ? false : r ? Boolean(d && typeof d.status !== "number") : null;
      if (ok === null) {
        checks.push({ id: e.id, what: "OLS id exists", ok: null, detail: `${e.ols}: OLS unreachable` });
        warnings.push(`entry "${e.id}": couldn't reach OLS to check "${e.ols}"`);
        continue;
      }
      checks.push({ id: e.id, what: "OLS id exists", ok, detail: e.ols });
      if (!ok) errors.push(`entry "${e.id}": OLS has no ontology "${e.ols}"`);
    }
  }
}

if (args.includes("--verbose") || warnings.length <= 10) for (const w of warnings) console.warn(`⚠ ${w}`);
else if (warnings.length) console.warn(`⚠ ${warnings.length} possible near-duplicates (run with --verbose to list them)`);
for (const p of errors) console.error(`✗ ${p}`);
console.log(errors.length ? `\n${errors.length} problem(s) found.` : `✓ ${catalog.length} entries valid${online ? ` (online checks on ${targets.length})` : ""}.`);

if (reportPath) {
  const md = [
    `### ${errors.length ? "❌ Catalog validation failed" : "✅ Catalog validation passed"}`,
    "",
    ...(errors.length ? ["**Problems**", "", ...errors.map((e) => `- ${e}`), ""] : []),
    ...(warnings.length ? ["**Warnings**", "", ...warnings.map((w) => `- ${w}`), ""] : []),
    ...(checks.length ? ["| Entry | Check | Result | Detail |", "|---|---|---|---|", ...checks.map((c) => `| \`${c.id}\` | ${c.what} | ${c.ok === null ? "⚠️" : c.ok ? "✅" : "❌"} | ${c.detail.replace(/\|/g, "\\|")} |`), ""] : []),
  ].join("\n");
  await writeFile(reportPath, md);
}
process.exit(errors.length ? 1 : 0);
