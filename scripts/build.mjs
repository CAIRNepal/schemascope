#!/usr/bin/env node
// Builds the static site into dist/ from data/*.json. No dependencies.
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RUBRIC, PENALTY, GRADES, RUBRIC_VERSION, FAIR_MAX, T, UPPER_ONTOLOGIES, adopters, imports as importsOf, reusedBy } from "./rubric.mjs";
import { validateCatalog, KINDS } from "./validate-lib.mjs";
import { trackedData, localData } from "./paths.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = async (p) => JSON.parse(await readFile(path.join(root, p), "utf8"));
const config = await read("site.config.json");
const categories = await read("data/categories.json");
const catalog = await read("data/catalog.json");
// Tracked results (written by the Evaluate catalog Action) plus any newer local preview in .local/data/.
const readIf = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, "utf8")) : null);
const evalCandidates = [await readIf(path.join(trackedData, "evaluation.json")), await readIf(path.join(localData, "evaluation.json"))].filter(Boolean);
const stamp = (x) => String(x.rescoredAt && x.rescoredAt > x.generatedAt ? x.rescoredAt : x.generatedAt);
const evaluation = evalCandidates.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0] || { entries: {} };
const runFiles = new Map();
for (const dir of [path.join(trackedData, "runs"), path.join(localData, "runs")])
  if (existsSync(dir)) for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json"))) runFiles.set(f, path.join(dir, f));
const runs = await Promise.all([...runFiles.keys()].sort().map(async (f) => JSON.parse(await readFile(runFiles.get(f), "utf8"))));
const dist = path.join(root, "dist");
const BUILD_ID = Date.now().toString(36);

// ---------- validation (same rules as CI) ----------
const problems = validateCatalog(catalog, categories);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const attr = esc;
const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
const ev = (id) => evaluation.entries[id] || null;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "—");
const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const abs = (p) => config.url + p;
const KIND_LABEL = { ontology: "Ontology", schema: "Schema", vocabulary: "Vocabulary", atlas: "Atlas", "data-standard": "Data standard", "knowledge-base": "Knowledge base" };
const evaluatedAt = evaluation.generatedAt ? fmtDate(evaluation.generatedAt) : null;
const byScore = (a, b) => (ev(b.id)?.score ?? -1) - (ev(a.id)?.score ?? -1) || a.name.localeCompare(b.name);
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const LICENSE_URLS = {
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY 3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  MIT: "https://opensource.org/licenses/MIT",
  "BSD-3-Clause": "https://opensource.org/licenses/BSD-3-Clause",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "LGPL-3.0": "https://www.gnu.org/licenses/lgpl-3.0.html",
  "GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html",
};
const licenseOf = (e) => e.license || ev(e.id)?.obo?.license || ev(e.id)?.github?.license || null;
const licenseUrl = (l) => LICENSE_URLS[l] || null;
const issueUrl = config.repository ? `${config.repository}/issues/new?template=add-resource.yml` : null;

const ICONS = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.5"/>',
  dna: '<path d="M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12"/><path d="M8.5 7h7M8.5 17h7M10 12h4"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  leaf: '<path d="M5 19c0-9 6-15 15-15 0 9-6 15-15 15Z"/><path d="M5 19 14 10"/>',
  atom: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15 14.5c3 0 6 2 6 5"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a2 2 0 0 0-3-2Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  cell: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  molecule: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="17" r="2.5"/><path d="M8.2 8.3 10.5 15M15.8 8.3 13.5 15M8.5 7h7"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="4"/>',
  wave: '<path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"/>',
  node: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><path d="M7 12h3M14 11l3.3-3.6M14 13l3.3 3.6"/>',
  graph: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h8M6 8v8M18 8v8M8 18h8M7.5 7.5l9 9"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
};
const icon = (name, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.book}</svg>`;
const ext = '<svg class="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
// Two images; CSS shows the one matching the active theme (works with the manual toggle too).
const logo = (cls = "") =>
  `<span class="logo ${cls}"><img class="logo-light" src="/assets/brand/logo-horizontal.png" alt="SchemaScope" width="262" height="40"><img class="logo-dark" src="/assets/brand/logo-horizontal-dark.png" alt="" aria-hidden="true" width="262" height="40"></span>`;

function gradeBadge(e, size = "") {
  const r = ev(e.id);
  if (!r) return `<span class="grade grade-none ${size}" title="Not evaluated yet">–</span>`;
  return `<span class="grade grade-${r.grade} ${size}" title="Evaluation score ${r.score}/100"><b>${r.grade}</b><small>${r.score}</small></span>`;
}
const versionLabel = (r) => r?.evaluatedVersion?.label || null;

// ---------- history & provenance ----------
const history = {};
for (const run of runs) {
  for (const [id, r] of Object.entries(run.entries)) {
    (history[id] ??= []).push({
      runId: run.run.id,
      at: run.run.finishedAt,
      score: r.score,
      grade: r.grade,
      fair: r.fair ?? null,
      version: r.evaluatedVersion?.label || r.ols?.version || r.github?.latestRelease?.tag || null,
      terms: r.ols?.terms ?? null,
      stars: r.github?.stars ?? null,
      license: r.obo?.license || r.github?.license || null,
      lastActivity: r.lastActivity || null,
      adopters: r.adopterCount ?? null,
      links: Object.fromEntries(Object.entries(r.links || {}).filter(([, l]) => l).map(([k, l]) => [k, l.state])),
      archived: r.github?.archived || false,
      rubric: run.run.evaluator?.rubricVersion,
    });
  }
}

function changes(id) {
  const h = history[id] || [];
  const out = [];
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1], b = h[i];
    const add = (what) => out.push({ at: b.at, runId: b.runId, what });
    if (a.version !== b.version && b.version) add(`Evaluated version: ${a.version ?? "—"} → ${b.version}`);
    if (a.terms != null && b.terms != null && a.terms !== b.terms) add(`Terms: ${fmtNum(a.terms)} → ${fmtNum(b.terms)} (${b.terms > a.terms ? "+" : ""}${fmtNum(b.terms - a.terms)})`);
    if (a.score !== b.score) add(`Score: ${a.score} → ${b.score}${a.grade !== b.grade ? ` (grade ${a.grade} → ${b.grade})` : ""}${a.rubric !== b.rubric ? ` · rubric v${a.rubric} → v${b.rubric}` : ""}`);
    if (a.license !== b.license) add(`License: ${a.license ?? "none"} → ${b.license ?? "none"}`);
    if (a.adopters !== b.adopters && a.adopters != null) add(`Documented adopters: ${a.adopters} → ${b.adopters}`);
    for (const k of new Set([...Object.keys(a.links), ...Object.keys(b.links)])) if (a.links[k] !== b.links[k]) add(`${k[0].toUpperCase() + k.slice(1)} link: ${a.links[k] ?? "—"} → ${b.links[k] ?? "—"}`);
    if (!a.archived && b.archived) add("Repository archived");
  }
  return out.reverse();
}

function sparkline(points, w = 260, h = 56) {
  if (points.length < 2) return "";
  const xs = (i) => 6 + (i * (w - 12)) / (points.length - 1);
  const ys = (v) => h - 6 - (v / 100) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Score over ${points.length} runs"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>${points
    .map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.score).toFixed(1)}" r="3"><title>${esc(fmtDate(p.at))}: ${p.score}</title></circle>`)
    .join("")}</svg>`;
}

// ---------- structured data (JSON-LD) ----------
const ORG_ID = `${config.url}/#organization`;
const SITE_ID = `${config.url}/#website`;
const CATALOG_ID = `${config.url}/#catalog`;
const baseGraph = () => [
  { "@type": "Organization", "@id": ORG_ID, name: "SchemaScope", url: config.url, logo: { "@type": "ImageObject", url: abs("/assets/brand/logo-mark.png"), width: 512, height: 512 }, ...(config.repository ? { sameAs: [config.repository] } : {}) },
  {
    "@type": "WebSite",
    "@id": SITE_ID,
    name: "SchemaScope",
    alternateName: config.name,
    url: config.url + "/",
    description: config.description,
    publisher: { "@id": ORG_ID },
    inLanguage: "en",
    potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${config.url}/search/?q={search_term_string}` }, "query-input": "required name=search_term_string" },
  },
];
const breadcrumbs = (trail) => ({ "@type": "BreadcrumbList", itemListElement: trail.map(([name, p], i) => ({ "@type": "ListItem", position: i + 1, name, item: abs(p) })) });
const webPage = (type, pathname, name, description, extra = {}) => ({
  "@type": type,
  "@id": abs(pathname) + "#webpage",
  url: abs(pathname),
  name,
  description,
  isPartOf: { "@id": SITE_ID },
  inLanguage: "en",
  ...(evaluation.generatedAt ? { dateModified: evaluation.generatedAt } : {}),
  ...extra,
});

function datasetLd(e) {
  const r = ev(e.id);
  const lic = licenseOf(e);
  return {
    "@type": e.kind === "ontology" || e.kind === "vocabulary" ? ["Dataset", "DefinedTermSet"] : "Dataset",
    "@id": abs(`/o/${e.id}/`) + "#dataset",
    name: e.acronym && e.acronym !== e.name ? `${e.name} (${e.acronym})` : e.name,
    alternateName: e.acronym,
    description: e.description,
    url: abs(`/o/${e.id}/`),
    identifier: e.download || e.id,
    sameAs: [e.homepage, e.repository].filter(Boolean),
    ...(lic ? { license: licenseUrl(lic) || lic } : {}),
    isAccessibleForFree: true,
    keywords: [...(e.tags || []), catById[e.category].name, "ontology"],
    ...(e.maintainer ? { creator: { "@type": "Organization", name: e.maintainer } } : {}),
    ...(versionLabel(r) ? { version: versionLabel(r) } : {}),
    ...(r?.lastActivity ? { dateModified: r.lastActivity } : {}),
    encodingFormat: e.formats,
    ...(e.download ? { distribution: [{ "@type": "DataDownload", contentUrl: e.download, encodingFormat: (e.formats || [])[0] }] } : {}),
    ...(e.publications?.length ? { citation: e.publications.map((p) => ({ "@type": "ScholarlyArticle", name: p.title, sameAs: `https://doi.org/${p.doi}`, datePublished: String(p.year) })) } : {}),
    ...(e.species?.length && !e.species.includes("N/A") ? { about: e.species.map((s) => ({ "@type": "Thing", name: s })) } : {}),
    ...(e.modules?.length ? { hasPart: e.modules.map((m) => ({ "@type": "CreativeWork", name: m.name, url: m.url, description: m.note })) } : {}),
    ...(e.provenance?.page || e.provenance?.url ? { isBasedOn: e.provenance.page || e.provenance.url } : {}),
    ...(e.domains?.length ? { about: [catById[e.category].name, ...e.domains.map((d) => catById[d].name)].map((name) => ({ "@type": "Thing", name })) } : {}),
    includedInDataCatalog: { "@id": CATALOG_ID },
  };
}

// ---------- layout ----------
function page({ title, description, pathname, body, graph = [], noindex = false, scripts = [] }) {
  const full = title ? `${title} · SchemaScope` : `SchemaScope — ${config.tagline}`;
  const desc = description || config.description;
  const canonical = abs(pathname);
  const ld = { "@context": "https://schema.org", "@graph": [...baseGraph(), ...graph] };
  const nav = (href, label) => `<a href="${href}"${pathname.startsWith(href) ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${attr(desc)}">
<meta name="robots" content="${noindex ? "noindex" : "index, follow, max-image-preview:large"}">
<link rel="canonical" href="${attr(canonical)}">
<meta property="og:site_name" content="SchemaScope">
<meta property="og:type" content="website">
<meta property="og:title" content="${attr(full)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:image" content="${attr(abs("/assets/og-image.png"))}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="SchemaScope">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(full)}">
<meta name="twitter:description" content="${attr(desc)}">
<meta name="twitter:image" content="${attr(abs("/assets/og-image.png"))}">
<meta name="theme-color" content="#0b1530" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#faf8f3" media="(prefers-color-scheme: light)">
<link rel="icon" href="/assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/assets/favicon-64.png" sizes="64x64" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/json" href="/catalog.json" title="SchemaScope catalog (JSON)">
<link rel="alternate" type="application/ld+json" href="/catalog.jsonld" title="SchemaScope catalog (DCAT JSON-LD)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/style.css?v=${BUILD_ID}">
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="SchemaScope home">${logo()}</a>
    <nav class="nav" aria-label="Main">
      ${nav("/catalog/", "Catalog")}
      ${nav("/categories/", "Categories")}
      ${nav("/evaluation/", "Evaluation")}
      ${nav("/submit/", "Submit")}
      ${nav("/about/", "About")}
      <button class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-brand">${logo("logo-footer")}<p class="muted">${esc(config.description)}</p></div>
    <nav class="footer-links" aria-label="Footer">
      <a href="/categories/">Categories</a>
      <a href="/evaluation/">Methodology</a>
      <a href="/evaluation/#runs">Run history</a>
      <a href="/submit/">Submit a resource</a>
      <a href="/catalog.json">catalog.json</a>
      <a href="/catalog.jsonld">DCAT JSON-LD</a>
      ${config.repository ? `<a href="${attr(config.repository)}">GitHub</a>` : ""}
    </nav>
    <p class="muted small">Descriptions are summaries; each resource is owned by its maintainers and keeps its own license.${evaluatedAt ? ` Last evaluated ${evaluatedAt}.` : ""}</p>
  </div>
</footer>
<script src="/assets/app.js?v=${BUILD_ID}" defer></script>
${scripts.map((s) => `<script src="${s}?v=${BUILD_ID}" defer></script>`).join("\n")}
</body>
</html>`;
}

const crumbsHtml = (trail) =>
  `<nav class="crumbs" aria-label="Breadcrumb">${trail.map(([name, p], i) => (i === trail.length - 1 ? `<span aria-current="page">${esc(name)}</span>` : `<a href="${p}">${esc(name)}</a>`)).join(" / ")}</nav>`;

// ---------- components ----------
function card(e) {
  const r = ev(e.id);
  const cat = catById[e.category];
  const haystack = [e.acronym, e.name, e.description, e.maintainer, ...(e.tags || []), ...(e.species || []), ...(e.formats || []), cat.name, ...(e.modules || []).map((m) => m.name)].join(" ").toLowerCase();
  const nAdopt = r?.adopterCount ?? (e.usedBy || []).length;
  const ver = versionLabel(r);
  return `<article class="card" data-id="${attr(e.id)}" data-name="${attr(e.name.toLowerCase())}" data-cat="${attr(e.category)}" data-kind="${attr(e.kind)}" data-species="${attr((e.species || []).join("|"))}" data-formats="${attr((e.formats || []).join("|"))}" data-grade="${r?.grade || ""}" data-score="${r?.score ?? -1}" data-fair="${r?.fair ?? -1}" data-activity="${attr(r?.lastActivity || "")}" data-adopt="${nAdopt}" data-status="${attr(e.status || "active")}" data-text="${attr(haystack)}">
  <div class="card-top">
    <span class="kind">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
    ${e.status === "legacy" ? '<span class="pill-legacy">Legacy</span>' : r?.penalty?.score <= -8 ? `<span class="pill-stale" title="Inactivity penalty ${r.penalty.score}">Inactive</span>` : ""}
    ${gradeBadge(e)}
  </div>
  <h3><a href="/o/${attr(e.id)}/"><span class="acr">${esc(e.acronym || e.name)}</span>${e.acronym && e.acronym !== e.name ? `<span class="nm">${esc(e.name)}</span>` : ""}</a></h3>
  <p class="desc">${esc(e.description)}</p>
  <div class="card-meta">
    <a class="cat-link" href="/category/${attr(e.category)}/">${icon(cat.icon, "icon icon-sm")}${esc(cat.name)}</a>${(e.domains || []).length ? `<span class="xdomains" title="Also used in: ${attr(e.domains.map((d) => catById[d].name).join(", "))}">+${e.domains.length} domain${e.domains.length === 1 ? "" : "s"}</span>` : ""}
    ${ver ? `<span class="ver" title="Version evaluated">${esc(ver.length > 24 ? ver.slice(0, 23) + "…" : ver)}</span>` : `<span>${esc((e.species || []).slice(0, 2).join(", "))}</span>`}
  </div>
  <div class="card-foot">
    <span class="chips">${(e.formats || []).slice(0, 3).map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</span>
    <span class="stat">${r ? `<span title="FAIR subtotal">FAIR ${r.fair}/${FAIR_MAX}</span> · ` : ""}${nAdopt} adopter${nAdopt === 1 ? "" : "s"}</span>
  </div>
</article>`;
}

function categoryTile(c) {
  const n = catalog.filter((e) => e.category === c.id).length;
  const x = domainReach[c.id] - n;
  return `<a class="cat-tile" href="/category/${attr(c.id)}/">${icon(c.icon)}<span class="cat-name">${esc(c.name)}</span><span class="cat-blurb">${esc(c.blurb)}</span><span class="cat-count">${n} resource${n === 1 ? "" : "s"}${x > 0 ? ` <span class="xcount">+ ${x} from other domains</span>` : ""}</span></a>`;
}

const miniList = (items) =>
  `<ul class="mini-list">${items.map((x) => `<li><a href="/o/${attr(x.id)}/"><span class="acr">${esc(x.acronym || x.name)}</span> <span class="muted">${esc(x.name)}</span></a>${gradeBadge(x, "sm")}</li>`).join("")}</ul>`;

// ---------- cross-domain model ----------
const domainsOf = (e) => [e.category, ...(e.domains || []).filter((d) => d !== e.category)];
const entryByKey = Object.fromEntries(catalog.flatMap((x) => [x.id, x.obo, x.ols, x.bioregistry].filter(Boolean).map((k) => [String(k).toLowerCase(), x])));
// Edge weight between two domains: resources that span both, plus import links between resources of the two domains.
const crossEdges = (() => {
  const w = new Map();
  const bump = (a, b, n = 1) => {
    if (a === b) return;
    const k = [a, b].sort().join("|");
    w.set(k, (w.get(k) || 0) + n);
  };
  for (const e of catalog) {
    const ds = domainsOf(e);
    for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) bump(ds[i], ds[j]);
    for (const k of ev(e.id)?.ols?.importsFrom || []) {
      const f = entryByKey[String(k).toLowerCase()];
      if (f && f.id !== e.id) bump(e.category, f.category, 0.5);
    }
  }
  return [...w].map(([k, n]) => ({ a: k.split("|")[0], b: k.split("|")[1], n })).sort((x, y) => y.n - x.n);
})();
const domainReach = Object.fromEntries(categories.map((c) => [c.id, catalog.filter((e) => domainsOf(e).includes(c.id)).length]));
const PALETTE = ["#2aa6b4", "#4c95dd", "#f0b04a", "#7fc8d0", "#9bb8ea", "#f4c77c"];

// Hero: the domains as a constellation, linked where resources are shared.
function heroArt() {
  const cx = 870, cy = 285, R = 182;
  const pos = Object.fromEntries(categories.map((c, i) => {
    const a = (i / categories.length) * Math.PI * 2 - Math.PI / 2;
    return [c.id, { x: cx + R * Math.cos(a) * 1.05, y: cy + R * Math.sin(a), a }];
  }));
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const max = Math.max(1, ...crossEdges.map((e) => e.n));
  const links = crossEdges.filter((e) => pos[e.a] && pos[e.b]).map((e, i) => {
    const A = pos[e.a], B = pos[e.b];
    const mx = (A.x + B.x) / 2 + (cx - (A.x + B.x) / 2) * 0.55, my = (A.y + B.y) / 2 + (cy - (A.y + B.y) / 2) * 0.55;
    return `<path d="M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}" stroke="${PALETTE[i % 3]}" stroke-opacity="${(0.12 + 0.5 * e.n / max).toFixed(2)}" stroke-width="${(0.6 + 2.4 * e.n / max).toFixed(2)}" fill="none"/>`;
  });
  const sats = categories.flatMap((c, i) => {
    const p = pos[c.id];
    return Array.from({ length: 5 + (domainReach[c.id] % 5) }, () => {
      const a = rnd() * Math.PI * 2, d = 14 + rnd() * 30;
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#cfe0f5" stroke-opacity=".22" stroke-width=".7"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1.2 + rnd() * 1.8).toFixed(1)}" fill="${PALETTE[(i + 1) % PALETTE.length]}" fill-opacity=".7"/>`;
    });
  });
  const hubs = categories.map((c, i) => {
    const p = pos[c.id], r = 4 + Math.sqrt(domainReach[c.id]) * 1.6;
    const lx = p.x + Math.cos(p.a) * (r + 14), ly = p.y + Math.sin(p.a) * (r + 14);
    const anchor = Math.cos(p.a) > 0.25 ? "start" : Math.cos(p.a) < -0.25 ? "end" : "middle";
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${PALETTE[i % 3]}" class="glow"/><text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}">${esc(c.name.split(/[,&]/)[0].trim())}</text>`;
  });
  return `<svg class="hero-art" viewBox="0 0 1200 560" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
  <defs><linearGradient id="hfade" x1="0" x2="1"><stop offset="0" stop-color="#0a1a3a" stop-opacity=".92"/><stop offset=".52" stop-color="#0a1a3a" stop-opacity=".55"/><stop offset=".66" stop-color="#0a1a3a" stop-opacity="0"/></linearGradient><radialGradient id="hg" cx="72%" cy="50%" r="55%"><stop offset="0" stop-color="#2aa6b4" stop-opacity=".18"/><stop offset="1" stop-color="#2aa6b4" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="560" fill="url(#hg)"/>
  <circle cx="${cx}" cy="${cy}" r="${R + 60}" fill="none" stroke="#cfe0f5" stroke-opacity=".07"/>
  <circle cx="${cx}" cy="${cy}" r="${R - 70}" fill="none" stroke="#cfe0f5" stroke-opacity=".05"/>
  <g class="links">${links.join("")}</g>
  <g>${sats.join("")}</g>
  <g class="hubs">${hubs.join("")}</g>
  <rect width="1200" height="560" fill="url(#hfade)"/>
</svg>`;
}

// Landing: interactive-free, legible cross-domain map.
function crossDomainMap() {
  const W = 620, H = 560, cx = W / 2, cy = H / 2, R = 205;
  const pos = Object.fromEntries(categories.map((c, i) => {
    const a = (i / categories.length) * Math.PI * 2 - Math.PI / 2;
    return [c.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a }];
  }));
  const max = Math.max(1, ...crossEdges.map((e) => e.n));
  const links = crossEdges.map((e) => {
    const A = pos[e.a], B = pos[e.b];
    return `<path d="M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${cx},${cy} ${B.x.toFixed(1)},${B.y.toFixed(1)}" stroke-width="${(0.8 + 7 * e.n / max).toFixed(2)}" stroke-opacity="${(0.15 + 0.55 * e.n / max).toFixed(2)}"><title>${esc(catById[e.a].name)} ↔ ${esc(catById[e.b].name)}: ${Math.round(e.n)} shared</title></path>`;
  });
  const nodes = categories.map((c) => {
    const p = pos[c.id], r = 7 + Math.sqrt(domainReach[c.id]) * 2.4;
    const lx = cx + (R + r + 12) * Math.cos(p.a), ly = cy + (R + r + 12) * Math.sin(p.a);
    const anchor = Math.cos(p.a) > 0.2 ? "start" : Math.cos(p.a) < -0.2 ? "end" : "middle";
    return `<a href="/category/${attr(c.id)}/"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(c.name)}: ${domainReach[c.id]} resources</title></circle><text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}">${esc(c.name.split(/[,&]/)[0].trim())}</text></a>`;
  });
  return `<svg class="xmap" viewBox="-110 -10 ${W + 220} ${H + 20}" role="img" aria-label="Cross-domain map: domains connected by shared ontologies and imports">
  <g class="xmap-links">${links.join("")}</g><g class="xmap-nodes">${nodes.join("")}</g></svg>`;
}

// ---------- pages ----------
const uniq = (arr) => [...new Set(arr)].sort((a, b) => a.localeCompare(b));
const allSpecies = uniq(catalog.flatMap((e) => e.species || []).filter((s) => s !== "N/A"));
const allKinds = uniq(catalog.map((e) => e.kind));
const scored = catalog.map((e) => ev(e.id)).filter(Boolean);
const avgScore = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
const totalAdopters = scored.reduce((s, r) => s + (r.adopterCount || 0), 0);

const searchForm = (id, value = "", cls = "search") => `<form class="${cls}" role="search" action="/search/" method="get">
      <label class="sr" for="${id}">Search the catalog</label>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="${id}" name="q" type="search" value="${attr(value)}" placeholder="Search e.g. “units of measure”, “cell types”, “provenance”, “soil”…" autocomplete="off" data-search>
      <kbd>/</kbd>
    </form>`;

const catalogLd = (list) => ({
  "@type": "DataCatalog",
  "@id": CATALOG_ID,
  name: "SchemaScope catalog of ontologies and schemas",
  description: config.description,
  url: abs("/catalog/"),
  publisher: { "@id": ORG_ID },
  keywords: ["ontology", "schema", "vocabulary", "metadata", "data standard", "FAIR", "semantic web", "interoperability"],
  ...(evaluation.generatedAt ? { dateModified: evaluation.generatedAt } : {}),
  // The 100 highest-rated are listed inline; every entry page carries its own Dataset markup and is in the sitemap.
  dataset: list.slice(0, 100).map((e) => ({ "@type": "Dataset", "@id": abs(`/o/${e.id}/`) + "#dataset", name: e.name, url: abs(`/o/${e.id}/`) })),
});

function homePage() {
  const sorted = [...catalog].sort(byScore);
  const top = sorted.slice(0, 6);
  const recent = [...catalog].filter((e) => ev(e.id)?.lastActivity && !top.includes(e)).sort((a, b) => ev(b.id).lastActivity.localeCompare(ev(a.id).lastActivity)).slice(0, 6);
  const body = `
<section class="hero">
  ${heroArt()}
  <div class="wrap hero-inner">
    <p class="eyebrow">Ontologies, schemas &amp; standards · across every domain</p>
    <h1>See how the world&rsquo;s <em>schemas</em> fit together.</h1>
    <p class="lede">${esc(config.description)} Every entry is scored against the FAIR principles, ontology quality, maintenance and community adoption, with the exact version evaluated and full provenance.</p>
    ${searchForm("hero-q")}
    <dl class="stats">
      <div><dt>Resources</dt><dd>${catalog.length}</dd></div>
      <div><dt>Categories</dt><dd>${categories.length}</dd></div>
      <div><dt>Adopting projects</dt><dd>${totalAdopters}</dd></div>
      <div><dt>Avg. score</dt><dd>${avgScore ?? "—"}</dd></div>
    </dl>
  </div>
</section>

<section class="wrap section">
  <div class="section-head"><h2>Browse by domain</h2><a href="/categories/">All domains →</a></div>
  <div class="cat-grid">${categories.map(categoryTile).join("")}</div>
</section>

<section class="wrap section xsection">
  <div class="xgrid">
    <div>
      <p class="eyebrow">Cross-domain fit</p>
      <h2>How domains connect</h2>
      <p class="muted">Each line joins two domains that share ontologies or schemas, either because one resource is used in both, or because a resource in one imports a resource in the other. Thicker lines mean more sharing. Foundational ontologies, units and metadata vocabularies are the bridges.</p>
      <h3 class="bridges-title">Strongest bridges</h3>
      <ol class="bridges">${[...catalog]
        .sort((a, b) => domainsOf(b).length - domainsOf(a).length || (ev(b.id)?.score ?? 0) - (ev(a.id)?.score ?? 0))
        .slice(0, 7)
        .map((e) => `<li><a href="/o/${attr(e.id)}/"><b>${esc(e.acronym || e.name)}</b> <span class="muted">${esc(e.name)}</span></a><span class="dchips">${domainsOf(e).map((d) => `<span class="dchip" title="${attr(catById[d].name)}">${icon(catById[d].icon, "icon icon-xs")}</span>`).join("")}</span></li>`)
        .join("")}</ol>
    </div>
    <figure class="xfig">${crossDomainMap()}<figcaption class="muted small">Node size: resources used in the domain. Hover a line for the count.</figcaption></figure>
  </div>
</section>

<section class="wrap section">
  <div class="section-head"><h2>Highest rated</h2><a href="/catalog/?sort=score">See all ${catalog.length} →</a></div>
  <div class="cards">${top.map(card).join("")}</div>
</section>

<section class="wrap section">
  <div class="section-head"><h2>Recently updated</h2><a href="/catalog/?sort=activity">See all →</a></div>
  <div class="cards">${recent.map(card).join("")}</div>
</section>

<section class="wrap section browse-all"><a class="btn" href="/catalog/">Browse the full catalog</a> <a class="btn-ghost" href="/evaluation/">How we score</a></section>

<section class="wrap section cta">
  <div class="cta-inner">
    <div><h2>Missing a schema or ontology?</h2><p class="muted">Submit it through GitHub. Every addition is reviewed, validated and evaluated automatically before it is merged.</p></div>
    <a class="btn" href="/submit/">Submit a resource</a>
  </div>
</section>`;
  return page({
    title: null,
    pathname: "/",
    body,
    description: `${config.description} ${catalog.length} resources across ${categories.length} domains, scored on FAIR principles, ontology quality and maintenance, tracked over time.`,
    graph: [webPage("WebPage", "/", `SchemaScope — ${config.tagline}`, config.description, { about: { "@id": CATALOG_ID }, primaryImageOfPage: abs("/assets/og-image.png") }), catalogLd(sorted)],
  });
}

function catalogPage() {
  const options = (list, label = (x) => x) => list.map((x) => `<option value="${attr(x)}">${esc(label(x))}</option>`).join("");
  const sorted = [...catalog].sort(byScore);
  const trail = [["Home", "/"], ["Catalog", "/catalog/"]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>The catalog</h1>
  <p class="lede">All ${catalog.length.toLocaleString("en-US")} resources. Harvested from Bioregistry, the OBO Foundry, OLS, TIB, LOV and NeuroSchema. Filter by domain (including cross-domain use), type, source registry or grade, and sort by score, FAIRness, activity or adoption.</p>
</section>
<section class="wrap section" id="explore">
  <div class="filters" role="group" aria-label="Filters">
    <label class="grow">Filter<input id="q" type="search" placeholder="Filter by name, tag, format…" autocomplete="off"></label>
    <label>Category<select id="f-cat"><option value="">All</option>${options(categories.map((c) => c.id), (id) => catById[id].name)}</select></label>
    <label>Type<select id="f-kind"><option value="">All</option>${options(allKinds, (k) => KIND_LABEL[k] || k)}</select></label>
    <label>Source registry<select id="f-reg"><option value="">All</option>${options(["Bioregistry", "OBO Foundry", "OLS (EMBL-EBI)", "TIB Terminology Service", "Linked Open Vocabularies (LOV)", "NeuroSchema", "curated"], (r) => r.replace(/ \(.*\)/, ""))}</select></label>
    <label>Grade<select id="f-grade"><option value="">All</option>${options(GRADES.map((g) => g.grade), (g) => `${g} (${GRADES.find((x) => x.grade === g).min}+)`)}</select></label>
    <label>Sort<select id="f-sort">
      <option value="score">Highest score</option>
      <option value="fair">Most FAIR</option>
      <option value="name">Name A–Z</option>
      <option value="activity">Recently active</option>
      <option value="adopt">Most adopted</option>
    </select></label>
    <label class="check"><input type="checkbox" id="f-active"> Hide legacy</label>
    <button type="button" class="btn-ghost" id="f-reset">Reset</button>
  </div>
  <p class="muted small" id="count" aria-live="polite">${catalog.length.toLocaleString("en-US")} resources</p>
  <div class="cards" id="cards" data-index="/catalog-index.json?v=${BUILD_ID}">${sorted.slice(0, 48).map(card).join("")}</div>
  <p class="empty" id="empty" hidden>No resources match. <button type="button" class="link" id="f-reset2">Clear filters</button></p>
  <p class="load-more"><button type="button" class="btn-ghost" id="more">Load more</button></p>
</section>`;
  const description = `All ${catalog.length} ontologies, schemas, vocabularies and data standards in SchemaScope, with FAIR scores, versions and adoption.`;
  return page({ title: "Catalog", pathname: "/catalog/", body, description, graph: [webPage("CollectionPage", "/catalog/", "Catalog", description), catalogLd(sorted), breadcrumbs(trail)] });
}

function searchPage() {
  const trail = [["Home", "/"], ["Search", "/search/"]];
  const body = `
<section class="page-head wrap search-head">
  ${crumbsHtml(trail)}
  <h1>Search</h1>
  ${searchForm("search-q", "", "search search-page")}
  <p class="muted small" id="search-status" aria-live="polite">Type to search ${catalog.length} resources by name, acronym, tag, species, format, schema module or maintainer.</p>
</section>
<section class="wrap section">
  <ol class="results" id="results"></ol>
  <noscript><p>Search needs JavaScript. Browse the <a href="/catalog/">full catalog</a> instead.</p></noscript>
</section>`;
  return page({ title: "Search", pathname: "/search/", body, description: "Search ontologies, schemas and data standards across domains in SchemaScope.", scripts: ["/assets/search.js"], graph: [webPage("SearchResultsPage", "/search/", "Search", "Search SchemaScope."), breadcrumbs(trail)] });
}

function categoriesPage() {
  const trail = [["Home", "/"], ["Categories", "/categories/"]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Categories</h1>
  <p class="lede">${categories.length} domains covering ${catalog.length} resources.</p>
</section>
<section class="wrap section">
  ${categories
    .map((c) => {
      const items = catalog.filter((e) => e.category === c.id).sort(byScore);
      return `<div class="cat-row"><div class="cat-row-head">${icon(c.icon)}<div><h2><a href="/category/${attr(c.id)}/">${esc(c.name)}</a></h2><p class="muted">${esc(c.blurb)}</p></div></div>${miniList(items.slice(0, 12))}${items.length > 12 ? `<p class="small"><a href="/category/${attr(c.id)}/">All ${items.length} in ${esc(c.name)} →</a></p>` : ""}</div>`;
    })
    .join("")}
</section>`;
  const description = `All ${categories.length} domains of ontologies and schemas: ${categories.map((c) => c.name).join(", ")}.`;
  return page({
    title: "Categories",
    pathname: "/categories/",
    body,
    description,
    graph: [
      webPage("CollectionPage", "/categories/", "Categories", description, {
        mainEntity: { "@type": "ItemList", numberOfItems: categories.length, itemListElement: categories.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, url: abs(`/category/${c.id}/`) })) },
      }),
      breadcrumbs(trail),
    ],
  });
}

function categoryPage(c) {
  const items = catalog.filter((e) => e.category === c.id).sort(byScore);
  const trail = [["Home", "/"], ["Categories", "/categories/"], [c.name, `/category/${c.id}/`]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <div class="title-row">${icon(c.icon, "icon icon-lg")}<h1>${esc(c.name)}</h1></div>
  <p class="lede">${esc(c.blurb)}</p>
</section>
<section class="wrap section">
  <div class="section-head"><h2>${items.length} resource${items.length === 1 ? "" : "s"}</h2><span class="muted">Sorted by evaluation score</span></div>
  <div class="cards">${items.slice(0, 48).map(card).join("")}</div>
  ${items.length > 48 ? `<p class="load-more"><a class="btn-ghost" href="/catalog/?cat=${attr(c.id)}">Browse all ${items.length} in the catalog →</a></p>` : ""}
  ${(() => {
    const also = catalog.filter((e) => e.category !== c.id && (e.domains || []).includes(c.id)).sort(byScore);
    return also.length ? `<div class="section-head also-head"><h2>Also used in ${esc(c.name)}</h2><span class="muted">${also.length} resource${also.length === 1 ? "" : "s"} from other domains</span></div><div class="cards">${also.slice(0, 24).map(card).join("")}</div>${also.length > 24 ? `<p class="load-more"><a class="btn-ghost" href="/catalog/?cat=${attr(c.id)}">See all ${also.length} →</a></p>` : ""}` : "";
  })()}
  <p class="muted other-cats">Other categories: ${categories.filter((x) => x.id !== c.id).map((x) => `<a href="/category/${attr(x.id)}/">${esc(x.name)}</a>`).join(" · ")}</p>
</section>`;
  const description = `${c.name} ontologies and schemas: ${c.blurb} ${items.length} resources including ${items.slice(0, 4).map((e) => e.acronym || e.name).join(", ")}.`;
  return page({
    title: `${c.name} ontologies & schemas`,
    pathname: `/category/${c.id}/`,
    body,
    description,
    graph: [
      webPage("CollectionPage", `/category/${c.id}/`, c.name, description, {
        mainEntity: { "@type": "ItemList", numberOfItems: items.length, itemListElement: items.map((e, i) => ({ "@type": "ListItem", position: i + 1, name: e.name, url: abs(`/o/${e.id}/`) })) },
      }),
      breadcrumbs(trail),
    ],
  });
}

const linkRow = (label, url, sub) => (url ? `<a class="link-btn" href="${attr(url)}" rel="noopener"><span class="lb-t">${esc(label)}${ext}</span><small>${esc(sub || host(url))}</small></a>` : "");

function healthDot(l) {
  if (!l) return "";
  const label = { ok: "Reachable", blocked: "Reachable (refused automated check)", dead: "Unreachable" }[l.state];
  return `<span class="dot dot-${l.state}" title="${attr(`${label} — HTTP ${l.code || l.error}`)}"></span>`;
}

function provenanceRows(r) {
  if (!r) return "";
  const row = (what, src, at, extra = "") => `<tr><td>${esc(what)}</td><td>${src ? `<a href="${attr(src)}" rel="noopener nofollow">${esc(host(src))}</a>` : "—"}</td><td>${esc(fmtDateTime(at))}${extra}</td></tr>`;
  const stale = (x) => (x?.stale ? ` <span class="pill-stale" title="${attr(`Last attempt ${fmtDateTime(x.lastAttemptAt)} failed: ${x.staleReason}`)}">carried forward</span>` : "");
  const rows = [];
  for (const [k, l] of Object.entries(r.links || {})) if (l) rows.push(row(`${k[0].toUpperCase() + k.slice(1)} link check (HTTP ${l.code || l.error})`, l.url, l.checkedAt));
  if (r.artifact && !r.artifact.error) rows.push(row(`Artefact header${r.artifact.versionIri ? " (version IRI)" : r.artifact.versionInfo ? " (version info)" : ""}`, r.artifact.source, r.artifact.fetchedAt, stale(r.artifact)));
  if (r.git && !r.git.error) rows.push(row(`Git refs (commit ${r.git.commit.slice(0, 7)}${r.git.latestTag ? `, latest tag ${r.git.latestTag.name}` : ""})`, r.git.url, r.git.fetchedAt, stale(r.git)));
  if (r.github && !r.github.error) rows.push(row("GitHub repository statistics", r.github.source, r.github.fetchedAt, stale(r.github)));
  if (r.ols && !r.ols.error) rows.push(row("OLS classes, imports, version & release", r.ols.source, r.ols.fetchedAt, stale(r.ols)));
  if (r.obo && !r.obo.error) rows.push(row("OBO Foundry status, license & usages", r.obo.source, r.obo.fetchedAt, stale(r.obo)));
  if (r.tib && !r.tib.error) rows.push(row("TIB Terminology Service metrics", r.tib.source, r.tib.fetchedAt, stale(r.tib)));
  if (r.bioregistry && !r.bioregistry.error) rows.push(row("Bioregistry mappings, dependencies & reuse", r.bioregistry.source, r.bioregistry.fetchedAt, stale(r.bioregistry)));
  if (r.dashboard && !r.dashboard.error) rows.push(row(`OBO Dashboard (checked ${fmtDate(r.dashboard.checkedAt)})`, r.dashboard.page, r.dashboard.fetchedAt, stale(r.dashboard)));
  if (r.quality) rows.push(row(`ROBOT reason/report in SchemaScope CI`, null, r.quality.checkedAt, stale(r.quality)));
  if (r.oops && !r.oops.error) rows.push(row("OOPS! pitfall scan", "https://oops.linkeddata.es", r.oops.checkedAt, stale(r.oops)));
  if (r.bioportal && !r.bioportal.error) rows.push(row("BioPortal release", r.bioportal.source, r.bioportal.fetchedAt, stale(r.bioportal)));
  for (const c of r.citations || []) if (c.count != null) rows.push(row(`Crossref citations (doi:${c.doi})`, c.source, c.fetchedAt, stale(c)));
  return rows.join("");
}

// Cross-portal view: what OLS, TIB, BioPortal, Bioregistry and the OBO Dashboard report about this resource.
const idToEntry = Object.fromEntries(catalog.flatMap((x) => [x.obo, x.ols, x.bioregistry].filter(Boolean).map((k) => [String(k).toLowerCase(), x])));
const ontChip = (k) => (idToEntry[k] ? `<a class="chip chip-link" href="/o/${attr(idToEntry[k].id)}/">${esc(idToEntry[k].acronym || k.toUpperCase())}</a>` : `<a class="chip" href="https://bioregistry.io/${attr(k)}" rel="noopener nofollow">${esc(k.toUpperCase())}</a>`);
function portalsPanel(e, r) {
  if (!r) return "";
  const rows = [];
  const fmtv = (x) => (x == null ? "—" : fmtNum(x));
  for (const p of [r.ols, r.tib]) {
    if (!p || p.error) continue;
    rows.push(`<tr><td><a href="${attr(p.page)}" rel="noopener">${esc(p.portal)}</a></td><td><code>${esc(p.id)}</code></td><td>${esc(p.version || "—")}</td><td class="num">${fmtv(p.terms)}</td><td class="num">${fmtv(p.properties)}</td><td class="num">${fmtv(p.individuals)}</td><td>${esc(fmtDate(p.loaded))}</td></tr>`);
  }
  if (r.bioportal && !r.bioportal.error)
    rows.push(`<tr><td><a href="${attr(r.bioportal.page)}" rel="noopener">BioPortal</a></td><td><code>${esc(r.bioportal.acronym)}</code></td><td>${esc(r.bioportal.version || "—")}</td><td class="num">${fmtv(r.bioportal.terms)}</td><td class="num">${fmtv(r.bioportal.properties)}</td><td class="num">${fmtv(r.bioportal.individuals)}</td><td>${esc(fmtDate(r.bioportal.released))}</td></tr>`);
  const d = r.dashboard && !r.dashboard.error ? r.dashboard : null;
  if (d) rows.push(`<tr><td><a href="${attr(d.page)}" rel="noopener">OBO Dashboard</a></td><td><code>${esc(d.ns)}</code></td><td>${esc((String(d.checkedVersion || "").match(/\d{4}-\d{2}-\d{2}/) || ["—"])[0])}</td><td class="num">${fmtv(d.classes)}</td><td class="num">—</td><td class="num">—</td><td>${esc(fmtDate(d.checkedAt))}</td></tr>`);
  const br = r.bioregistry && !r.bioregistry.error ? r.bioregistry : null;
  const MAP_URL = {
    bioportal: (v) => `https://bioportal.bioontology.org/ontologies/${v}`,
    ols: (v) => `https://www.ebi.ac.uk/ols4/ontologies/${v}`,
    "tib.ts": (v) => `https://terminology.tib.eu/ts/ontologies/${v}`,
    fairsharing: (v) => `https://fairsharing.org/${v}`,
    "wikidata.entity": (v) => `https://www.wikidata.org/wiki/${v}`,
    obofoundry: (v) => `https://obofoundry.org/ontology/${String(v).toLowerCase()}.html`,
    ontobee: (v) => `https://ontobee.org/ontology/${v}`,
    aberowl: (v) => `http://aber-owl.net/ontology/${v}/`,
    agroportal: (v) => `https://agroportal.lirmm.fr/ontologies/${v}`,
    biodivportal: (v) => `https://biodivportal.gfbio.org/ontologies/${v}`,
  };
  const mappings = br ? Object.entries(br.mappings).filter(([k]) => MAP_URL[k]).map(([k, v]) => `<a class="chip chip-link" href="${attr(MAP_URL[k](v))}" rel="noopener nofollow">${esc(k)}: ${esc(v)}</a>`) : [];
  const imp = importsOf(r);
  const reuse = reusedBy(r);
  const langs = r.ols?.languages?.length ? r.ols.languages : null;
  if (!rows.length && !mappings.length && !imp.length && !reuse.length) return "";
  const d2 = d
    ? `<dl class="facts compact quality-facts">
        <div><dt>Logical consistency</dt><dd>${d.consistent === true ? "consistent" : d.consistent === false ? "INCONSISTENT" : "—"}${d.unsatisfiable != null ? ` · ${fmtNum(d.unsatisfiable)} unsatisfiable` : ""}</dd></div>
        <div><dt>OWL 2 DL</dt><dd>${d.owl2dl == null ? "—" : d.owl2dl ? "yes" : "no"}</dd></div>
        <div><dt>ROBOT report</dt><dd>${d.robot ? `${fmtNum(d.robot.ERROR)} errors · ${fmtNum(d.robot.WARN)} warnings · ${fmtNum(d.robot.INFO)} info` : "—"}</dd></div>
        <div><dt>OBO principles</dt><dd>${d.checks ? Object.entries(d.checks).filter(([k]) => /^FP/.test(k)).map(([k, v]) => `<span class="fp fp-${esc(String(v).toLowerCase())}" title="${attr(k)}: ${attr(v)}">${esc(k.split(" ")[0])}</span>`).join("") : "—"}</dd></div>
        ${d.axioms ? `<div><dt>Axioms</dt><dd>${fmtNum(d.axioms)}${d.reusedPct != null ? ` · ${d.reusedPct}% entities reused` : ""}</dd></div>` : ""}
      </dl>`
    : r.quality
    ? `<dl class="facts compact quality-facts"><div><dt>Logical consistency (ROBOT ${esc(r.quality.reasoner || "ELK")})</dt><dd>${r.quality.consistent === true ? "consistent" : r.quality.consistent === false ? "INCONSISTENT" : "—"}${r.quality.unsatisfiable != null ? ` · ${fmtNum(r.quality.unsatisfiable)} unsatisfiable` : ""}</dd></div>${r.quality.robot ? `<div><dt>ROBOT report</dt><dd>${fmtNum(r.quality.robot.ERROR)} errors · ${fmtNum(r.quality.robot.WARN)} warnings</dd></div>` : ""}</dl>`
    : "";
  const oops = r.oops && !r.oops.error ? `<p class="small">OOPS!: ${r.oops.critical} critical · ${r.oops.important} important · ${r.oops.minor} minor pitfall types${r.oops.stale ? ' <span class="pill-stale">carried forward</span>' : ""}</p>` : "";
  return `<div class="panel" id="portals">
    <h2>Portals &amp; registries</h2>
    ${rows.length ? `<div class="table-wrap"><table class="portal-table"><thead><tr><th>Source</th><th>ID</th><th>Version</th><th class="num">Classes</th><th class="num">Properties</th><th class="num">Individuals</th><th>Loaded</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : ""}
    ${r.ols?.iri ? `<p class="small"><span class="muted">Ontology IRI</span> <code>${esc(r.ols.iri)}</code>${r.ols.versionIri ? `<br><span class="muted">Version IRI</span> <code>${esc(r.ols.versionIri)}</code>` : ""}</p>` : ""}
    ${langs ? `<p class="small"><span class="muted">Languages</span> ${langs.map((l) => `<span class="chip">${esc(l)}</span>`).join(" ")}</p>` : ""}
    ${imp.length ? `<p class="small"><span class="muted">Imports from (${imp.length})</span><br>${imp.map(ontChip).join(" ")}</p>` : ""}
    ${reuse.length ? `<p class="small"><span class="muted">Reused by (${reuse.length})</span><br>${reuse.map(ontChip).join(" ")}</p>` : ""}
    ${d2}${oops}
    ${mappings.length ? `<p class="small"><span class="muted">Also registered as</span><br>${mappings.join(" ")}</p>` : ""}
  </div>`;
}

// Where this catalog record's own metadata came from (registry import or curation).
function recordProvenancePanel(e) {
  const p = e.provenance;
  if (!p) return "";
  const when = p.retrievedAt || p.curatedAt;
  const sourceLink = p.page || p.url;
  return `<div class="panel recprov">
    <h2>Record source</h2>
    <p class="small"><b>${esc(p.source === "curated" ? "Curated by SchemaScope" : p.source)}</b>${sourceLink ? ` · <a href="${attr(sourceLink)}" rel="noopener">${esc(host(sourceLink))}</a>` : ""}</p>
    <p class="small muted">${p.source === "curated" ? "Curated" : "Retrieved"} ${esc(fmtDateTime(when))}${p.curatedBy ? ` by ${esc(p.curatedBy)}` : ""}</p>
    ${p.fields?.length ? `<p class="small"><span class="muted">Fields from ${esc(p.source)}:</span> ${p.fields.map((f) => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
    ${p.overrides && Object.keys(p.overrides).length ? `<p class="small"><span class="muted">Curated overrides:</span> ${Object.keys(p.overrides).map((f) => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
    ${p.note ? `<p class="small muted">${esc(p.note)}</p>` : ""}
    ${p.sourcesChecked?.length ? `<p class="small"><span class="muted">Checked against:</span> ${p.sourcesChecked.map((u) => `<a href="${attr(u)}" rel="noopener">${esc(host(u))}</a>`).join(", ")}</p>` : ""}
    ${p.url && p.url !== sourceLink ? `<p class="small"><a href="${attr(p.url)}" rel="noopener nofollow">Raw record (API)</a></p>` : ""}
  </div>`;
}

function versionPanel(r) {
  const v = r?.evaluatedVersion;
  if (!v) return `<div class="panel version"><h2>Version evaluated</h2><p class="muted small">No version information could be detected for this resource: it has no machine-readable artefact, release tag or registry entry to read a version from.</p></div>`;
  const isUrl = (s) => /^https?:\/\//.test(s || "");
  return `<div class="panel version">
    <h2>Version evaluated</h2>
    <p class="ver-big">${esc(v.label)}</p>
    <p class="small muted">Detected from: ${esc(v.from)} · evaluated ${esc(fmtDateTime(r.evaluatedAt))}</p>
    <dl class="facts compact">${v.all
      .map((c) => `<div><dt>${esc(c.from)}</dt><dd>${isUrl(c.value) ? `<a href="${attr(c.value)}" rel="noopener">${esc(c.value)}</a>` : esc(c.value)}</dd></div>`)
      .join("")}${r.artifact?.etag ? `<div><dt>Artefact ETag</dt><dd><code>${esc(r.artifact.etag)}</code></dd></div>` : ""}</dl>
  </div>`;
}

function entryPage(e) {
  const r = ev(e.id);
  const cat = catById[e.category];
  const ad = adopters(e, r);
  const trail = [["Home", "/"], [cat.name, `/category/${cat.id}/`], [e.acronym || e.name, `/o/${e.id}/`]];
  const browse = [
    e.ols && (!r || r.ols?.terms) ? ["OLS", `https://www.ebi.ac.uk/ols4/ontologies/${e.ols}`, "EMBL-EBI Ontology Lookup Service"] : null,
    e.bioportal ? ["BioPortal", `https://bioportal.bioontology.org/ontologies/${e.bioportal}`, "NCBO BioPortal"] : null,
    e.obo ? ["OBO Foundry", `https://obofoundry.org/ontology/${e.obo}.html`, "OBO Foundry registry"] : null,
  ].filter(Boolean);
  const license = licenseOf(e);
  const facts = [
    ["Type", esc(KIND_LABEL[e.kind] || e.kind)],
    ["Primary domain", `<a href="/category/${attr(cat.id)}/">${esc(cat.name)}</a>`],
    (e.domains || []).length ? ["Also used in", (e.domains || []).map((d) => `<a class="chip chip-link" href="/category/${attr(d)}/">${esc(catById[d].name)}</a>`).join(" ")] : null,
    ["Status", esc(e.status === "legacy" ? "Legacy" : r?.obo?.status ? `${r.obo.status[0].toUpperCase()}${r.obo.status.slice(1)} (OBO Foundry)` : "Active")],
    ["Version evaluated", versionLabel(r) ? esc(versionLabel(r)) : null],
    ["Maintainer", esc(e.maintainer)],
    ["License", license ? `${licenseUrl(license) ? `<a href="${attr(licenseUrl(license))}" rel="license noopener">${esc(license)}</a>` : esc(license)}${!e.license ? (r?.obo?.license ? ' <span class="muted">(OBO Foundry)</span>' : ' <span class="muted">(detected by GitHub)</span>') : ""}` : "Not stated — check the source"],
    ["Formats", esc((e.formats || []).join(", "))],
    ["Species", esc((e.species || []).join(", "))],
    r?.ols?.terms ? ["Terms (OLS)", fmtNum(r.ols.terms)] : null,
    r?.lastActivity ? ["Last activity", fmtDate(r.lastActivity)] : null,
    r?.github && !r.github.error ? ["GitHub", `★ ${fmtNum(r.github.stars)} · ${fmtNum(r.github.forks)} forks · ${fmtNum(r.github.openIssues)} open issues${r.github.archived ? " · archived" : ""}`] : null,
    r?.git?.latestTag ? ["Latest release tag", `<a href="${attr(r.git.latestTag.url)}" rel="noopener">${esc(r.git.latestTag.name)}</a>`] : null,
  ].filter((x) => x && x[1]);

  const breakdown = r
    ? RUBRIC.map((rb) => {
        const b = r.breakdown[rb.key];
        if (!b) return "";
        const na = b.applicable === false;
        const pct = na ? 0 : Math.max(0, Math.round((b.score / b.max) * 100));
        return `<div class="bd-row${na ? " is-na" : ""}">
      <div class="bd-label"><span><b class="sym">${esc(rb.symbol)}</b> ${esc(rb.label)}${rb.fair ? ' <span class="fair-tag">FAIR</span>' : ""}</span><span class="bd-num">${na ? "n/a" : `${b.score}<small>/${b.max}</small>`}</span></div>
      <div class="bar${rb.fair ? " bar-fair" : ""}" role="img" aria-label="${attr(`${rb.label}: ${b.score} of ${b.max}`)}"><span style="width:${pct}%"></span></div>
      <ul class="bd-steps">${(b.steps || []).map((s) => `<li><span>${esc(s.label)}</span><span class="muted">${esc(s.detail)}</span><b>${s.pts > 0 ? "+" : ""}${s.pts}</b></li>`).join("")}</ul>
    </div>`;
      }).join("")
    : `<p class="muted">Not evaluated yet. Run <code>npm run evaluate</code>.</p>`;

  const linkHealth = r
    ? Object.entries(r.links)
        .filter(([, l]) => l)
        .map(([k, l]) => `<li>${healthDot(l)}<span class="lh-k">${esc(k)}</span> <a href="${attr(l.url)}" rel="noopener">${esc(host(l.url))}</a> <span class="muted">HTTP ${esc(l.code || l.error)}</span></li>`)
        .join("")
    : "";

  const pubs = (e.publications || []).map((p) => {
    const c = r?.citations?.find((x) => x.doi === p.doi)?.count;
    return `<li><a href="https://doi.org/${attr(p.doi)}" rel="noopener">${esc(p.title)}</a> <span class="muted">(${esc(p.year)}) · doi:${esc(p.doi)}${c != null ? ` · <b>${fmtNum(c)}</b> citations` : ""}</span></li>`;
  });

  const h = history[e.id] || [];
  const ch = changes(e.id);
  const related = catalog.filter((x) => x.category === e.category && x.id !== e.id).sort(byScore).slice(0, 5);

  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <div class="entry-head">
    <div>
      <p class="eyebrow">${esc(KIND_LABEL[e.kind] || e.kind)}${e.status === "legacy" ? " · Legacy" : ""}</p>
      <h1>${esc(e.acronym || e.name)}</h1>
      ${e.acronym && e.acronym !== e.name ? `<p class="subtitle">${esc(e.name)}</p>` : ""}
      <p class="lede">${esc(e.description)}</p>
      <div class="tags">${(e.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
    </div>
    <div class="score-card">
      ${gradeBadge(e, "lg")}
      ${r ? `<p class="fair-line"><span class="fair-tag">FAIR</span> <b>${r.fair}</b>/${FAIR_MAX}</p>` : ""}
      ${versionLabel(r) ? `<p class="muted small">Version ${esc(versionLabel(r).length > 28 ? versionLabel(r).slice(0, 27) + "…" : versionLabel(r))}</p>` : ""}
      <p class="muted small">${r ? `Evaluated ${fmtDate(r.evaluatedAt || evaluation.generatedAt)}` : "Not evaluated"}</p>
      <a class="small" href="/evaluation/#formula">How scores work</a>
    </div>
  </div>
</section>

<section class="wrap section entry-grid">
  <div class="entry-main">
    <div class="panel">
      <h2>Source &amp; access</h2>
      <div class="link-grid">
        ${linkRow("Homepage", e.homepage)}
        ${e.repository && e.repository !== e.homepage ? linkRow("Repository", e.repository) : ""}
        ${linkRow("Download", e.download, "Canonical file / PURL")}
        ${browse.map(([l, u, s]) => linkRow(`Browse in ${l}`, u, s)).join("")}
      </div>
      ${linkHealth ? `<ul class="link-health" aria-label="Link health">${linkHealth}</ul>` : ""}
    </div>

    ${portalsPanel(e, r)}

    ${e.modules?.length ? `<div class="panel"><h2>Schemas &amp; modules <span class="count">${e.modules.length}</span></h2><ul class="modules">${e.modules.map((m) => `<li><a href="${attr(m.url)}" rel="noopener">${esc(m.name)}${ext}</a><span class="muted">${esc(m.note || "")}</span></li>`).join("")}</ul></div>` : ""}

    <div class="panel" id="evaluation">
      <h2>Automated evaluation</h2>
      <div class="breakdown">${breakdown}</div>
      ${r?.penalty ? `<div class="bd-row bd-penalty${r.penalty.score ? " is-hit" : ""}"><div class="bd-label"><span><b class="sym">P</b> ${esc(PENALTY.label)}</span><span class="bd-num">${r.penalty.score}</span></div><ul class="bd-steps">${(r.penalty.steps || [{ label: "Activity status", detail: r.penalty.reason, pts: r.penalty.score }]).map((s) => `<li><span>${esc(s.label)}</span><span class="muted">${esc(s.detail)}</span><b>${s.pts || 0}</b></li>`).join("")}</ul></div>` : ""}
      ${r ? `<p class="bd-total">FAIR subtotal <b>${r.fair}</b>/${FAIR_MAX} · earned ${r.earned ?? r.gross}/${r.possible ?? 100}${(r.possible ?? 100) !== 100 ? ` → scaled ${r.gross}` : ""}${r.penalty?.score ? ` − ${-r.penalty.score} inactivity` : ""} = <b>${r.score}</b>/100 → grade <b>${r.grade}</b></p>` : ""}
    </div>

    <div class="panel">
      <h2>Community adoption <span class="count">${ad.length}</span></h2>
      ${
        ad.length
          ? `<ul class="adopters">${ad.map((u) => `<li><a href="${attr(u.url)}" rel="noopener">${esc(u.name)}</a>${u.note ? `<p>${esc(u.note.length > 240 ? u.note.slice(0, 237) + "…" : u.note)}</p>` : ""}<span class="src">${esc(u.source === "curated" ? "Curated by SchemaScope" : `Source: ${u.source}`)}</span></li>`).join("")}</ul>`
          : `<p class="muted">No adopting projects documented yet.</p>`
      }
      <p class="small muted">Know a project that uses ${esc(e.acronym || e.name)}? <a href="/submit/?update=${attr(e.id)}">Suggest it</a>.</p>
    </div>

    ${e.tools?.length ? `<div class="panel"><h2>Tooling</h2><ul class="modules">${e.tools.map((t) => `<li><a href="${attr(t.url)}" rel="noopener">${esc(t.name)}${ext}</a><span class="muted">${esc(t.note || "")}</span></li>`).join("")}</ul></div>` : ""}

    <div class="panel" id="history">
      <h2>History &amp; changes <span class="count">${h.length} run${h.length === 1 ? "" : "s"}</span></h2>
      ${h.length >= 2 ? `<div class="spark-wrap">${sparkline(h)}<span class="muted small">Score over time</span></div>` : ""}
      ${
        ch.length
          ? `<ul class="changes">${ch.slice(0, 12).map((c) => `<li><time datetime="${attr(c.at)}">${esc(fmtDate(c.at))}</time><span>${esc(c.what)}</span></li>`).join("")}</ul>`
          : `<p class="muted small">${h.length < 2 ? "History starts with the first archived run; changes appear after the next evaluation." : "No changes detected between runs."}</p>`
      }
      ${
        h.length
          ? `<div class="table-wrap"><table class="hist-table"><thead><tr><th>Run</th><th class="num">Score</th><th class="num">FAIR</th><th>Version evaluated</th><th class="num">Terms</th><th>Snapshot</th></tr></thead><tbody>${[...h]
              .reverse()
              .slice(0, 10)
              .map((p) => `<tr><td>${esc(fmtDateTime(p.at))}</td><td class="num">${p.score} <span class="muted">${p.grade}</span></td><td class="num">${p.fair ?? "—"}</td><td>${esc(p.version ?? "—")}</td><td class="num">${fmtNum(p.terms)}</td><td><a href="/runs/${attr(p.runId)}.json">JSON</a></td></tr>`)
              .join("")}</tbody></table></div>`
          : ""
      }
    </div>

    ${
      r
        ? `<div class="panel" id="provenance">
      <h2>Provenance</h2>
      <p class="small muted">Every fact on this page was fetched automatically. Each row shows where it came from and when. If a source fails, the last good value is kept and marked “carried forward”.</p>
      <div class="table-wrap"><table class="prov-table"><thead><tr><th>Fact</th><th>Source</th><th>Retrieved</th></tr></thead><tbody>${provenanceRows(r)}</tbody></table></div>
      <p class="small muted">Run <code>${esc(r.runId || evaluation.run?.id || "—")}</code> · evaluator v${esc(evaluation.run?.evaluator?.version || "—")} · rubric v${esc(evaluation.rubricVersion)} · <a href="/o/${attr(e.id)}/entry.json">entry.json</a>${r.runId ? ` · <a href="/runs/${attr(r.runId)}.json">run snapshot</a>` : ""}</p>
    </div>`
        : ""
    }

    ${pubs.length ? `<div class="panel"><h2>How to cite</h2><ul class="pubs">${pubs.join("")}</ul></div>` : ""}
  </div>

  <aside class="entry-side">
    ${versionPanel(r)}
    ${recordProvenancePanel(e)}
    <div class="panel">
      <h2>At a glance</h2>
      <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
    </div>
    <div class="panel">
      <h2>Machine-readable</h2>
      <p class="small"><a href="/o/${attr(e.id)}/entry.json"><code>/o/${esc(e.id)}/entry.json</code></a></p>
      <p class="small muted">Catalog record, evaluation, history and W3C PROV-O provenance for this resource.</p>
      <p class="small"><a href="/submit/?update=${attr(e.id)}">Suggest a correction</a></p>
    </div>
    ${related.length ? `<div class="panel"><h2>Related</h2>${miniList(related)}</div>` : ""}
  </aside>
</section>`;

  const title = `${e.acronym && e.acronym !== e.name ? `${e.acronym} – ` : ""}${e.name}`;
  const description = `${e.description}${r ? ` SchemaScope score ${r.score}/100 (grade ${r.grade}, FAIR ${r.fair}/${FAIR_MAX})${versionLabel(r) ? `, version ${versionLabel(r)}` : ""}.` : ""}`;
  return page({
    title,
    pathname: `/o/${e.id}/`,
    body,
    description: description.length > 300 ? description.slice(0, 297) + "…" : description,
    graph: [webPage("ItemPage", `/o/${e.id}/`, title, e.description, { mainEntity: { "@id": abs(`/o/${e.id}/`) + "#dataset" } }), datasetLd(e), breadcrumbs(trail)],
  });
}

function workedExample() {
  const sorted = [...catalog].sort(byScore);
  const pick =
    sorted.find((e) => {
      const r = ev(e.id);
      return r && r.penalty?.score < 0 && r.gross >= 55 && Object.values(r.breakdown).filter((b) => b.score < b.max).length >= 2;
    }) ||
    sorted.find((e) => {
      const r = ev(e.id);
      return r && r.score >= 60 && r.score < 100 && Object.values(r.breakdown).filter((b) => b.score < b.max).length >= 2;
    }) || sorted[0];
  const r = ev(pick?.id);
  if (!r) return "";
  return `<div class="panel example">
    <h3>Worked example: <a href="/o/${attr(pick.id)}/">${esc(pick.acronym || pick.name)}</a>${versionLabel(r) ? ` <span class="muted small">version ${esc(versionLabel(r))}</span>` : ""}</h3>
    <p class="small muted">Actual numbers from the latest run (${esc(fmtDateTime(r.evaluatedAt || evaluation.generatedAt))}).</p>
    <div class="table-wrap"><table class="ex-table">
      <thead><tr><th>Criterion</th><th>Step</th><th>Evidence</th><th class="num">Points</th></tr></thead>
      <tbody>${RUBRIC.map((rb) => {
        const b = r.breakdown[rb.key];
        return (b.steps || [])
          .map((s, i) => `<tr${i === 0 ? ' class="grp"' : ""}>${i === 0 ? `<td rowspan="${b.steps.length}"><b>${esc(rb.symbol)}</b> ${esc(rb.label)}${rb.fair ? ' <span class="fair-tag">FAIR</span>' : ""}<br><span class="muted small">= ${b.score} / ${b.max}</span></td>` : ""}<td>${esc(s.label)}</td><td class="muted">${esc(s.detail)}</td><td class="num">${s.pts > 0 ? "+" : ""}${s.pts}${s.max ? `<span class="muted"> / ${s.max}</span>` : ""}</td></tr>`)
          .join("");
      }).join("")}</tbody>
    </table></div>
    <p class="math">FAIR = ${RUBRIC.filter((x) => x.fair).map((rb) => r.breakdown[rb.key].score).join(" + ")} = <b>${r.fair}</b> / ${FAIR_MAX}</p>
    <p class="math">Penalty P = ${r.penalty ? -r.penalty.score : 0} <span class="muted small">(${esc(r.penalty?.reason || "—")})</span></p>
    <p class="math">Score = max(0, 100 · (${RUBRIC.filter((rb) => r.breakdown[rb.key]?.applicable !== false).map((rb) => `<span title="${attr(rb.label)}">${r.breakdown[rb.key].score}</span>`).join(" + ")}) / ${r.possible ?? 100} − ${r.penalty ? -r.penalty.score : 0}) = <b>${r.score}</b> → ${r.score} ≥ ${GRADES.find((g) => g.grade === r.grade).min} → grade <b>${r.grade}</b></p>
  </div>`;
}

function evaluationPage() {
  const rows = [...catalog].sort(byScore);
  const dist = GRADES.map((g) => ({ ...g, n: scored.filter((r) => r.grade === g.grade).length }));
  const trail = [["Home", "/"], ["Evaluation", "/evaluation/"]];
  const tbl = (steps, fmt) => steps.map((s) => `<span>${fmt(s)} → <b>${s.pts}</b></span>`).join(" · ");
  const runRows = [...runs]
    .reverse()
    .map((x) => {
      const scores = Object.values(x.entries).map((e) => e.score);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : "—";
      return `<tr><td>${esc(fmtDateTime(x.run.finishedAt))}</td><td>${esc(x.run.scope)}</td><td class="num">${x.run.entryCount}</td><td class="num">${avg}</td><td>${esc(x.run.trigger)}</td><td>v${esc(x.run.evaluator?.version)} / rubric v${esc(x.run.evaluator?.rubricVersion)}</td><td><a href="/runs/${attr(x.run.id)}.json">JSON</a>${x.run.ciRun ? ` · <a href="${attr(x.run.ciRun)}" rel="noopener">CI log</a>` : ""}</td></tr>`;
    })
    .join("");
  const fairRubric = RUBRIC.filter((r) => r.fair);
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Automated evaluation</h1>
  <p class="lede">Every resource is scored by a script against the <a href="https://doi.org/10.1038/sdata.2016.18" rel="noopener">FAIR principles</a>, ontology quality (upper-ontology alignment, reasoner consistency, ROBOT report, OOPS! pitfalls), maintenance and community adoption, minus a progressive inactivity penalty. The rubric is deliberately strict: 100 requires excellence on every axis. It queries OLS, TIB, BioPortal, Bioregistry, the OBO Foundry and its Dashboard, GitHub, git refs and Crossref, and reads the artefact itself to record exactly which version was evaluated. Scores describe how easy a resource is to find, trust and reuse today, not its scientific value.</p>
  <p class="muted">${evaluatedAt ? `Last run ${esc(fmtDateTime(evaluation.generatedAt))} · ` : ""}Rubric v${esc(RUBRIC_VERSION)} · ${runs.length} archived run${runs.length === 1 ? "" : "s"}</p>
</section>

<section class="wrap section">
  <div class="grade-dist">${dist.map((g) => `<div class="gd"><span class="grade grade-${g.grade}"><b>${g.grade}</b></span><span><b>${g.n}</b> resource${g.n === 1 ? "" : "s"}</span><small>${g.min}+ points</small></div>`).join("")}</div>
</section>

<section class="wrap section" id="formula">
  <h2>The formula</h2>
  <div class="formula">
    <p class="math big">Score = max(0, 100 · (<span class="fair-group"><b>F</b> + <b>A</b> + <b>I</b> + <b>R</b></span> + <b>Q</b> + <b>M</b> + <b>U</b>) / <i>possible</i> − <b class="pen">P</b>)</p>
    <p class="small muted">The highlighted group is the FAIR subtotal (max ${FAIR_MAX}). Q (ontology quality, max 20) applies to OWL/OBO/RDF ontologies; for schemas and other resources <i>possible</i> = 80 and the result is scaled to 100, otherwise <i>possible</i> = 100. P subtracts for inactivity (growing every year), logical inconsistency (−20, score capped at 54), unsatisfiable classes (−5), critical pitfalls (−3 each, up to −12) and ROBOT report errors (up to −10).</p>
    <dl class="formula-terms">
      ${RUBRIC.map((rb) => `<div${rb.fair ? ' class="is-fair"' : ""}><dt><b>${esc(rb.symbol)}</b> ${esc(rb.label)} <span class="rb-max">max ${rb.max}</span></dt><dd><code>${esc(rb.formula)}</code></dd></div>`).join("")}
      <div class="is-penalty"><dt><b>P</b> ${esc(PENALTY.label)} <span class="rb-max">0 to −50</span></dt><dd><code>${esc(PENALTY.formula)}</code></dd></div>
    </dl>
    <div class="formula-fns">
      <p><code>[x]</code> is 1 if condition <i>x</i> holds, else 0.</p>
      <p><code>r(registries)</code>: ${tbl(T.registries, (s) => `≥ ${s.min}`)} &nbsp;·&nbsp; <code>i(imports)</code>: ${tbl(T.imports, (s) => `≥ ${s.min}`)}</p>
      <p><code>c</code> (logical consistency): consistent with 0 unsatisfiable classes → <b>10</b> · 1–5 unsatisfiable → 5 · more → 2 · inconsistent or unchecked → 0 &nbsp;·&nbsp; <code>u</code>: imports ${UPPER_ONTOLOGIES.slice(0, 4).map((x) => x.toUpperCase()).join("/")} → 3, RO → 1 &nbsp;·&nbsp; <code>q</code>: no ROBOT errors → 2, ≤ 0.05 warnings/class → 1, no critical pitfalls (OOPS!, else ROBOT) → 1</p>
      <p><code>recency</code>: ${tbl(T.recency, (s) => esc(s.label))} &nbsp;·&nbsp; <code>cadence</code>: ${tbl(T.cadence, (s) => `≥ ${s.min}`)}</p>
      <p><code>a(projects)</code>: ${tbl(T.adopters, (s) => `≥ ${s.min}`)} &nbsp;·&nbsp; <code>reuse</code>: ${tbl(T.reuse, (s) => `≥ ${s.min}`)}</p>
      <p><code>stars</code>: ${tbl(T.stars, (s) => `≥ ${s.min}`)} &nbsp;·&nbsp; <code>citations</code>: ${tbl(T.citations, (s) => `≥ ${s.min}`)}</p>
      <p>Grade: ${GRADES.map((g) => `<b>${g.grade}</b> ≥ ${g.min}`).join(" · ")}</p>
    </div>
  </div>
  ${workedExample()}
</section>

<section class="wrap section">
  <h2>Criteria in plain words</h2>
  <div class="rubric">${RUBRIC.map((r) => `<div class="rb${r.fair ? " rb-fair" : ""}"><div class="rb-head"><h3>${esc(r.symbol)} · ${esc(r.label)}</h3><span class="rb-max">${r.max} pts</span></div><p>${esc(r.how)}</p></div>`).join("")}<div class="rb rb-penalty"><div class="rb-head"><h3>P · ${esc(PENALTY.label)}</h3><span class="rb-max">0 to −50</span></div><p>${esc(PENALTY.how)}</p></div></div>
  <div class="panel note">
    <h3>Which version is evaluated?</h3>
    <p class="small">Each run records the exact version it looked at, in this order of preference: the <code>owl:versionIRI</code> or <code>owl:versionInfo</code> declared inside the artefact (or <code>data-version</code> / <code>version</code> for OBO, YAML and JSON files); the version reported by OLS; the latest GitHub release; a git tag on the evaluated commit; and otherwise the exact commit of the default branch. The artefact's ETag is stored too. Every entry page shows this under “Version evaluated”, and each run's snapshot keeps it permanently.</p>
    <h3>Sources &amp; provenance</h3>
    <ul>
      <li><b>Links</b>: HTTP checks of each homepage, repository and download URL.</li>
      <li><b>Artefact</b>: the first 256 KB of the download, read for version IRI / version info.</li>
      <li><b>Git refs</b>: default-branch commit and release tags via git's HTTP endpoint.</li>
      <li><b>GitHub REST API</b>: stars, forks, open issues, last push, latest release, detected license.</li>
      <li><b>OLS (EMBL-EBI) v2 API</b>: classes, properties, individuals, imports and exports, ontology and version IRI, languages, load time.</li>
      <li><b>TIB Terminology Service</b>: the same metrics from a second OLS instance, often holding a different release.</li>
      <li><b>BioPortal</b> (with an API key): latest submission and metrics.</li>
      <li><b>Bioregistry</b>: cross-portal identifiers (OLS, BioPortal, TIB, FAIRsharing, Wikidata…), dependencies and reuse.</li>
      <li><b>OBO Foundry registry</b>: activity status, license and registered usages (shown as adopters).</li>
      <li><b>OBO Dashboard</b>: OBO principle checks, ROBOT report, reasoner consistency and unsatisfiable classes, ontologies that reuse it.</li>
      <li><b>SchemaScope CI</b>: for ontologies outside the OBO Dashboard, ROBOT reasons (ELK) and reports on the artefact; every ontology is also sent to the <a href="https://oops.linkeddata.es" rel="noopener">OOPS!</a> pitfall scanner.</li>
      <li><b>Crossref</b>: citation counts of each resource's reference paper.</li>
      <li><b>Curated data</b>: adopting projects, modules and tooling submitted through GitHub and reviewed before merge.</li>
    </ul>
    <p class="small muted">Each fact stores its source URL and retrieval time. Every run is archived as an immutable JSON snapshot, so any score can be traced back to the data behind it. If a source fails, the last good value is carried forward with its original timestamp and flagged. A low score often just means information is missing; adding a license, a PURL, a download link or documented adopters will raise it.</p>
  </div>
</section>

<section class="wrap section">
  <div class="section-head"><h2>All scores</h2><span class="muted small">Click a column to sort</span></div>
  <div class="table-wrap">
  <table class="score-table sortable">
    <thead><tr>
      <th data-sort="text">Resource</th><th data-sort="text">Version evaluated</th>
      ${RUBRIC.map((r) => `<th data-sort="num" class="num${r.fair ? " th-fair" : ""}" title="${attr(r.label)}">${esc(r.symbol)}<small>/${r.max}</small></th>`).join("")}
      <th data-sort="num" class="num th-pen" title="Inactivity penalty">P</th>
      <th data-sort="num" class="num th-fair">FAIR<small>/${FAIR_MAX}</small></th>
      <th data-sort="num" class="num">Score</th><th data-sort="text">Last activity</th>
    </tr></thead>
    <tbody>${rows
      .map((e) => {
        const r = ev(e.id);
        const v = versionLabel(r);
        return `<tr>
        <td><a href="/o/${attr(e.id)}/"><b>${esc(e.acronym || e.name)}</b></a></td>
        <td class="muted ver-cell" title="${attr(v || "")}">${esc(v ? (v.length > 26 ? v.slice(0, 25) + "…" : v) : "—")}</td>
        ${RUBRIC.map((rb) => `<td class="num">${r ? (r.breakdown[rb.key]?.applicable === false ? '<span class="muted">n/a</span>' : r.breakdown[rb.key]?.score ?? "—") : "—"}</td>`).join("")}
        <td class="num${r?.penalty?.score ? " pen" : ""}">${r?.penalty ? r.penalty.score || "0" : "—"}</td>
        <td class="num"><b>${r?.fair ?? "—"}</b></td>
        <td class="num" data-v="${r?.score ?? -1}">${gradeBadge(e, "sm")}</td>
        <td data-v="${attr(r?.lastActivity || "")}">${r?.lastActivity ? fmtDate(r.lastActivity) : '<span class="muted">—</span>'}</td>
      </tr>`;
      })
      .join("")}</tbody>
  </table>
  </div>
</section>

<section class="wrap section" id="runs">
  <div class="section-head"><h2>Run history</h2><a href="/runs/index.json">runs/index.json</a></div>
  <div class="table-wrap"><table class="score-table">
    <thead><tr><th>Finished</th><th>Scope</th><th class="num">Entries</th><th class="num">Avg. score</th><th>Trigger</th><th>Evaluator</th><th>Data</th></tr></thead>
    <tbody>${runRows || '<tr><td colspan="7" class="muted">No archived runs yet.</td></tr>'}</tbody>
  </table></div>
</section>`;
  const description = "How SchemaScope scores ontologies and schemas against the FAIR principles, maintenance and adoption: the formula, a worked example, version tracking, provenance and run history.";
  return page({
    title: "FAIR evaluation methodology & scores",
    pathname: "/evaluation/",
    body,
    description,
    graph: [
      webPage("WebPage", "/evaluation/", "FAIR evaluation methodology & scores", description),
      breadcrumbs(trail),
      {
        "@type": "Dataset",
        "@id": abs("/evaluation/") + "#dataset",
        name: "SchemaScope automated FAIR evaluation results",
        description: "Automated, provenance-tracked FAIR, maintenance and adoption scores for ontologies, schemas and data standards, with the exact version evaluated, archived per run.",
        url: abs("/evaluation/"),
        creator: { "@id": ORG_ID },
        isAccessibleForFree: true,
        license: "https://creativecommons.org/licenses/by/4.0/",
        keywords: ["FAIR", "ontology evaluation", "ontology quality", "provenance", "versioning"],
        measurementTechnique: "Automated FAIR assessment",
        variableMeasured: RUBRIC.map((r) => ({ "@type": "PropertyValue", name: r.label, maxValue: r.max })),
        ...(evaluation.generatedAt ? { dateModified: evaluation.generatedAt } : {}),
        distribution: [
          { "@type": "DataDownload", contentUrl: abs("/catalog.json"), encodingFormat: "application/json" },
          { "@type": "DataDownload", contentUrl: abs("/runs/index.json"), encodingFormat: "application/json" },
        ],
        includedInDataCatalog: { "@id": CATALOG_ID },
      },
    ],
  });
}

function submitPage() {
  const trail = [["Home", "/"], ["Submit", "/submit/"]];
  const opt = (list, label) => list.map((x) => `<option value="${attr(x)}">${esc(label ? label(x) : x)}</option>`).join("");
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Submit a resource</h1>
  <p class="lede">All additions and corrections go through GitHub, so every change is reviewed, tracked and checked automatically before it is merged.</p>
</section>

<section class="wrap section">
  <ol class="flow">
    <li><b>1. Describe it</b><span>Fill in the form below, or open the GitHub issue form directly.</span></li>
    <li><b>2. Issue → pull request</b><span>A bot turns your issue into a pull request that adds the entry to <code>data/catalog.json</code>.</span></li>
    <li><b>3. Automated checks</b><span>CI validates the entry, checks links and DOIs for duplicates, runs the FAIR evaluation and posts the score on the PR.</span></li>
    <li><b>4. Review &amp; merge</b><span>A maintainer reviews and merges. The site redeploys, and the next evaluation run archives it.</span></li>
  </ol>
</section>

<section class="wrap section submit-grid">
  <form id="submit-form" class="panel submit-form" novalidate data-repo="${attr(config.repository || "")}" data-categories="${attr(categories.map((c) => c.id).join(","))}">
    <h2>Resource details</h2>
    <input type="hidden" name="update">
    <div class="row2">
      <label>Name *<input name="name" required placeholder="Uber-anatomy Ontology"></label>
      <label>Acronym<input name="acronym" placeholder="UBERON"></label>
    </div>
    <div class="row2">
      <label>Category *<select name="category" required>${opt(categories.map((c) => c.id), (id) => catById[id].name)}</select></label>
      <label>Type *<select name="kind" required>${opt(KINDS, (k) => KIND_LABEL[k] || k)}</select></label>
    </div>
    <label>Description * <small class="muted">1–3 sentences, at least 40 characters</small><textarea name="description" rows="3" required></textarea></label>
    <div class="row2">
      <label>Homepage *<input name="homepage" type="url" required placeholder="https://…"></label>
      <label>Repository<input name="repository" type="url" placeholder="https://github.com/org/repo"></label>
    </div>
    <label>Download / PURL <small class="muted">canonical machine-readable file</small><input name="download" type="url" placeholder="http://purl.obolibrary.org/obo/xyz.owl"></label>
    <div class="row2">
      <label>Formats <small class="muted">comma-separated</small><input name="formats" placeholder="OWL, OBO, JSON-LD"></label>
      <label>Species <small class="muted">comma-separated</small><input name="species" placeholder="Mouse, Human"></label>
    </div>
    <div class="row2">
      <label>Maintainer<input name="maintainer" placeholder="Lab, institute or consortium"></label>
      <label>License<input name="license" placeholder="CC BY 4.0"></label>
    </div>
    <div class="row3">
      <label>OLS id<input name="ols" placeholder="uberon"></label>
      <label>OBO id<input name="obo" placeholder="uberon"></label>
      <label>BioPortal acronym<input name="bioportal" placeholder="UBERON"></label>
    </div>
    <label>Reference paper DOI<input name="doi" placeholder="10.1186/gb-2012-13-1-r5"></label>
    <label>Used by <small class="muted">one per line: Project name | URL | how it is used</small><textarea name="usedBy" rows="3" placeholder="Project | https://example.org | How it uses the resource"></textarea></label>
    <label>Tags <small class="muted">comma-separated</small><input name="tags" placeholder="brain regions, mouse"></label>
    <label>Anything else reviewers should know?<textarea name="notes" rows="2"></textarea></label>
    <p class="form-errors" id="form-errors" role="alert" hidden></p>
    <div class="form-actions">
      ${config.repository ? `<button type="submit" class="btn">Open pre-filled GitHub issue</button>` : `<button type="submit" class="btn" disabled title="Set repository in site.config.json">GitHub repository not configured</button>`}
      <button type="button" class="btn-ghost" id="copy-json">Copy JSON for a pull request</button>
      <button type="button" class="btn-ghost" id="download-json">Download JSON</button>
    </div>
  </form>
  <aside class="submit-side">
    <div class="panel">
      <h2>Entry preview</h2>
      <pre class="json-preview"><code id="json-preview">{}</code></pre>
    </div>
    <div class="panel">
      <h2>Prefer Git directly?</h2>
      <p class="small">Fork the repository, add your entry to <code>data/catalog.json</code>, run <code>npm run validate</code> and open a pull request. The same checks run on every PR.</p>
      ${config.repository ? `<p class="small"><a href="${attr(config.repository)}">Repository</a> · <a href="${attr(issueUrl)}">Issue form</a> · <a href="${attr(config.repository)}/pulls">Open pull requests</a></p>` : ""}
      <p class="small muted">Entry format: <a href="/catalog.schema.json">catalog.schema.json</a> (JSON Schema).</p>
    </div>
  </aside>
</section>`;
  const description = "Submit an ontology, schema or data standard to SchemaScope through GitHub. Every submission is validated, FAIR-evaluated and reviewed before merge.";
  return page({ title: "Submit a resource", pathname: "/submit/", body, description, scripts: ["/assets/submit.js"], graph: [webPage("WebPage", "/submit/", "Submit a resource", description), breadcrumbs(trail)] });
}

function aboutPage() {
  const trail = [["Home", "/"], ["About", "/about/"]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>About SchemaScope</h1>
  <p class="lede">${esc(config.description)}</p>
</section>
<section class="wrap section prose">
  <h2>What this is</h2>
  <p>Research data in every field is described with ontologies, controlled vocabularies, metadata schemas and data standards, maintained by different communities and spread across registries such as OLS, BioPortal, the OBO Foundry, Bioregistry and FAIRsharing. SchemaScope brings them into one catalog, organised by domain, shows how they connect across domains, so you can see what exists, which version is current, how FAIR and well maintained it is, and who already uses it.</p>
  <p>Each resource stays with its maintainers. This catalog links to the canonical homepage, repository, download PURL and ontology browsers; it does not copy or re-license their files.</p>

  <h2 id="contribute">Contributing</h2>
  <p>Everything is tracked in Git. Use the <a href="/submit/">submission form</a>, which opens a pre-filled GitHub issue that a bot converts into a pull request, or edit <code>data/catalog.json</code> and open a pull request yourself. Every pull request is validated, link-checked, de-duplicated and FAIR-evaluated in CI before a maintainer reviews and merges it.</p>

  <h2>Use the data</h2>
  <ul>
    <li><a href="/catalog.json"><code>/catalog.json</code></a>: every entry with its latest evaluation and evaluated version.</li>
    <li><a href="/catalog.jsonld"><code>/catalog.jsonld</code></a>: the catalog as a W3C DCAT data catalog in JSON-LD.</li>
    <li><code>/o/&lt;id&gt;/entry.json</code>: a single entry with history and W3C PROV-O provenance.</li>
    <li><a href="/runs/index.json"><code>/runs/index.json</code></a>: every archived evaluation run, each linking to its full snapshot.</li>
    <li><a href="/catalog.schema.json"><code>/catalog.schema.json</code></a>: JSON Schema for catalog entries.</li>
  </ul>
  <p>Every page embeds schema.org JSON-LD (Dataset, DataCatalog, BreadcrumbList, WebSite) so search engines, including Google Dataset Search, can index the catalog.</p>
</section>`;
  const description = "About SchemaScope: what it catalogs, how contributions are reviewed through GitHub, and how to use the catalog data and APIs.";
  return page({ title: "About", pathname: "/about/", body, description, graph: [webPage("AboutPage", "/about/", "About SchemaScope", description), breadcrumbs(trail)] });
}

function notFound() {
  return page({ title: "Not found", pathname: "/404", noindex: true, body: `<section class="page-head wrap"><h1>Page not found</h1><p class="lede">That page doesn't exist. Try the <a href="/catalog/">catalog</a> or <a href="/search/">search</a> or <a href="/categories/">categories</a>.</p></section>` });
}

// ---------- data outputs ----------
function provJsonLd(e, r) {
  if (!r) return null;
  const used = [
    ...Object.values(r.links || {}).filter(Boolean).map((l) => ({ "@id": l.url, "prov:atTime": l.checkedAt })),
    ...[r.artifact, r.git, r.github, r.ols, r.tib, r.obo, r.dashboard, r.bioregistry, r.bioportal, ...(r.citations || [])]
      .filter((x) => x && x.source && !x.error)
      .map((x) => ({ "@id": x.source, "prov:atTime": x.fetchedAt, ...(x.stale ? { "schemascope:carriedForward": true } : {}) })),
  ];
  return {
    "@context": { prov: "http://www.w3.org/ns/prov#", schemascope: `${config.url}/ns#` },
    "@id": `${abs(`/o/${e.id}/`)}#evaluation`,
    "@type": "prov:Entity",
    "prov:specializationOf": { "@id": e.download || e.repository || e.homepage, "schemascope:evaluatedVersion": r.evaluatedVersion?.value || null },
    "prov:wasGeneratedBy": {
      "@id": `${config.url}/runs/${r.runId}`,
      "@type": "prov:Activity",
      "prov:startedAtTime": evaluation.run?.startedAt,
      "prov:endedAtTime": evaluation.run?.finishedAt,
      "prov:wasAssociatedWith": { "@id": `${config.url}/ns#evaluator`, "@type": "prov:SoftwareAgent", "schemascope:version": evaluation.run?.evaluator?.version },
      "prov:used": used,
    },
    "prov:generatedAtTime": r.evaluatedAt,
    ...(history[e.id]?.length > 1 ? { "prov:wasRevisionOf": history[e.id].slice(0, -1).map((p) => ({ "@id": `${config.url}/runs/${p.runId}.json#${e.id}` })) } : {}),
  };
}

const record = (e) => {
  const r = ev(e.id);
  return {
    ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== "provenance")),
    url: abs(`/o/${e.id}/`),
    evaluation: r ? { ...r, adopters: adopters(e, r) } : null,
    history: (history[e.id] || []).map((p) => ({ ...p, snapshot: abs(`/runs/${p.runId}.json`) })),
    changes: changes(e.id),
    recordProvenance: e.provenance || null,
    evaluationProvenance: provJsonLd(e, r),
  };
};

function dcat() {
  return {
    "@context": { "@vocab": "http://www.w3.org/ns/dcat#", dct: "http://purl.org/dc/terms/", foaf: "http://xmlns.com/foaf/0.1/", skos: "http://www.w3.org/2004/02/skos/core#", prov: "http://www.w3.org/ns/prov#" },
    "@id": config.url,
    "@type": "Catalog",
    "dct:title": "SchemaScope",
    "dct:description": config.description,
    "dct:modified": evaluation.generatedAt || new Date().toISOString(),
    themeTaxonomy: categories.map((c) => ({ "@id": abs(`/category/${c.id}/`), "@type": "skos:Concept", "skos:prefLabel": c.name })),
    dataset: catalog.map((e) => {
      const r = ev(e.id);
      return {
        "@id": abs(`/o/${e.id}/`),
        "@type": "Dataset",
        "dct:identifier": e.id,
        "dct:title": e.name,
        "dct:alternative": e.acronym,
        "dct:description": e.description,
        "dct:license": licenseUrl(licenseOf(e)) ? { "@id": licenseUrl(licenseOf(e)) } : licenseOf(e) || undefined,
        "dct:publisher": e.maintainer ? { "@type": "foaf:Agent", "foaf:name": e.maintainer } : undefined,
        keyword: e.tags,
        landingPage: e.homepage ? { "@id": e.homepage } : undefined,
        version: versionLabel(r) || undefined,
        distribution: [e.download && { "@type": "Distribution", downloadURL: { "@id": e.download } }, e.repository && { "@type": "Distribution", accessURL: { "@id": e.repository } }].filter(Boolean),
        "dct:bibliographicCitation": (e.publications || []).map((p) => `https://doi.org/${p.doi}`),
        "prov:wasGeneratedBy": r?.runId ? { "@id": `${config.url}/runs/${r.runId}` } : undefined,
        "prov:wasDerivedFrom": e.provenance?.url ? { "@id": e.provenance.url, "prov:atTime": e.provenance.retrievedAt } : undefined,
        theme: [{ "@id": abs(`/category/${e.category}/`) }, ...(e.domains || []).map((d) => ({ "@id": abs(`/category/${d}/`) }))],
      };
    }),
  };
}

function sitemap(paths) {
  const lastmod = (evaluation.generatedAt || new Date().toISOString()).slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(abs(p))}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${p === "/" ? "1.0" : p.startsWith("/o/") ? "0.8" : "0.6"}</priority></url>`).join("\n")}
</urlset>
`;
}

// ---------- write ----------
const files = new Map();
const put = (p, content) => files.set(p, content);

put("index.html", homePage());
put("categories/index.html", categoriesPage());
for (const c of categories) put(`category/${c.id}/index.html`, categoryPage(c));
for (const e of catalog) {
  put(`o/${e.id}/index.html`, entryPage(e));
  put(`o/${e.id}/entry.json`, JSON.stringify(record(e), null, 2));
}
put("evaluation/index.html", evaluationPage());
put("catalog/index.html", catalogPage());
put("search/index.html", searchPage());
const regsOf = (e) => (e.provenance?.registries || []).map((x) => x.registry).filter((v, i, a) => a.indexOf(v) === i).concat(e.provenance?.source === "curated" || e.provenance?.curated ? ["curated"] : []).concat(e.provenance?.source === "NeuroSchema catalog" ? ["NeuroSchema"] : []);
put(
  "catalog-index.json",
  JSON.stringify(
    catalog.map((e) => {
      const r = ev(e.id);
      return {
        id: e.id, a: e.acronym || null, n: e.name, d: e.description.length > 180 ? e.description.slice(0, 177) + "…" : e.description,
        c: e.category, cn: catById[e.category].name, x: e.domains || [], xn: (e.domains || []).map((d) => catById[d].name),
        k: KIND_LABEL[e.kind] || e.kind, kid: e.kind, fm: (e.formats || []).slice(0, 4), tg: (e.tags || []).slice(0, 6), r: regsOf(e),
        g: r?.grade || null, s: r?.score ?? null, f: r?.fair ?? null, t: r?.lastActivity || null, u: r?.adopterCount ?? 0, v: versionLabel(r), l: e.status === "legacy" || undefined,
      };
    })
  )
);
put(
  "search-index.json",
  JSON.stringify(
    catalog.map((e) => {
      const r = ev(e.id);
      return {
        id: e.id, acronym: e.acronym || null, name: e.name, description: e.description, category: [catById[e.category].name, ...(e.domains || []).map((d) => catById[d].name)].join(" · "), kind: KIND_LABEL[e.kind] || e.kind,
        tags: e.tags || [], species: e.species || [], formats: e.formats || [], modules: (e.modules || []).map((m) => m.name), maintainer: e.maintainer || null,
        score: r?.score ?? null, grade: r?.grade ?? null, fair: r?.fair ?? null, version: versionLabel(r), legacy: e.status === "legacy",
      };
    })
  )
);
put("submit/index.html", submitPage());
put("about/index.html", aboutPage());
put("404.html", notFound());
put("catalog.json", JSON.stringify({ name: "SchemaScope", url: config.url, generatedAt: evaluation.generatedAt || null, run: evaluation.run || null, rubricVersion: RUBRIC_VERSION, categories, entries: catalog.map(record) }, null, 2));
put("catalog.jsonld", JSON.stringify(dcat(), null, 2));
put("catalog.schema.json", await readFile(path.join(root, "data/catalog.schema.json"), "utf8"));
for (const x of runs) put(`runs/${x.run.id}.json`, JSON.stringify(x));
put("runs/index.json", JSON.stringify({ runs: [...runs].reverse().map((x) => ({ ...x.run, snapshot: abs(`/runs/${x.run.id}.json`) })) }, null, 2));
put("site.webmanifest", JSON.stringify({ name: "SchemaScope", short_name: "SchemaScope", start_url: "/", display: "standalone", background_color: "#faf8f3", theme_color: "#0b1530", icons: [{ src: "/assets/brand/logo-mark.png", sizes: "512x512", type: "image/png" }, { src: "/assets/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] }, null, 2));
const htmlPaths = [...files.keys()].filter((p) => p.endsWith("index.html")).map((p) => "/" + p.replace(/index\.html$/, ""));
put("sitemap.xml", sitemap(htmlPaths));
put("robots.txt", `User-agent: *\nAllow: /\nDisallow: /404\n\nSitemap: ${abs("/sitemap.xml")}\n`);

await rm(dist, { recursive: true, force: true });
await cp(path.join(root, "src/assets"), path.join(dist, "assets"), { recursive: true });
if (existsSync(path.join(root, "public"))) await cp(path.join(root, "public"), dist, { recursive: true });
for (const [p, content] of files) {
  const out = path.join(dist, p);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, content);
}
if (existsSync(path.join(localData, "evaluation.json"))) console.log(`Note: previewing local evaluation data from .local/data (not committed). Deploys use data/ from the Evaluate catalog Action.`);
console.log(`Built ${files.size} files into dist/ (${catalog.length} entries, ${categories.length} categories, ${runs.length} archived run${runs.length === 1 ? "" : "s"}${evaluatedAt ? `, latest evaluation ${evaluatedAt}` : ""})`);
