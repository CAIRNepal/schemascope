// Page templates for the site, shared by the static build (scripts/build.mjs) and the web server (web/server.mjs).
// createSite(data) returns a Map of output paths to functions that render each file.
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RUBRIC, PENALTY, GRADES, RUBRIC_VERSION, FAIR_MAX, T, UPPER_ONTOLOGIES, adopters, imports as importsOf, reusedBy } from "./rubric.mjs";
import { validateCatalog, KINDS } from "./validate-lib.mjs";
import { trackedData, localData } from "./paths.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Reads the catalog, evaluation, runs and content files from data/ (the static build's data source).
export async function loadLocalData() {
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
  const roadmapFile = path.join(root, "data/roadmap.json");
  const validationFile = path.join(root, "data/validation/report.json");
  return {
    config, categories, catalog, evaluation, runs,
    roadmap: existsSync(roadmapFile) ? JSON.parse(await readFile(roadmapFile, "utf8")) : null,
    validation: existsSync(validationFile) ? JSON.parse(await readFile(validationFile, "utf8")) : null,
    catalogSchema: await readFile(path.join(root, "data/catalog.schema.json"), "utf8"),
  };
}

// One entry's state in one archived run: score, criteria and quality metrics, compared across runs.
// Used by the templates below and by the API's ingest (backend/), so both compute history the same way.
export function historyPoint(run, r) {
  return {
    runId: run.id,
    at: run.finishedAt,
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
    rubric: run.evaluator?.rubricVersion,
    // Per-criterion points and the quality metrics behind them, to compare runs.
    crit: Object.fromEntries(Object.entries(r.breakdown || {}).map(([k, b]) => [k, b.score])),
    penalty: r.penalty?.score ?? null,
    metrics: {
      consistent: (r.quality && !r.quality.error ? r.quality.consistent : null) ?? r.dashboard?.consistent ?? null,
      unsatisfiable: (r.quality && !r.quality.error ? r.quality.unsatisfiable : null) ?? r.dashboard?.unsatisfiable ?? null,
      owl2dl: (r.quality && !r.quality.error ? r.quality.owl2dl : null) ?? r.dashboard?.owl2dl ?? null,
      robotErrors: (r.quality?.robot || r.dashboard?.robot)?.ERROR ?? null,
      robotWarnings: (r.quality?.robot || r.dashboard?.robot)?.WARN ?? null,
      criticalPitfalls: r.oops && !r.oops.error ? r.oops.critical ?? null : null,
      imports: r.importCount ?? null,
      reuse: r.reuseCount ?? null,
    },
  };
}

// data: { config, categories, catalog, evaluation, runs, roadmap, validation, catalogSchema,
//        history? (per-entry points; then runs may be summaries { run, scores }), buildId?, strict? }
export async function createSite(data) {
const { config, categories, catalog, evaluation, runs } = data;
const BUILD_ID = data.buildId || Date.now().toString(36);

// ---------- validation (same rules as CI) ----------
const problems = validateCatalog(catalog, categories);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  if (data.strict !== false) process.exit(1);
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
  const partial = r.qualityPartial ? `; quality partially assessed (${r.qualityNotAssessed} of 20 Q points could not be checked)` : "";
  return `<span class="grade grade-${r.grade} ${size}" title="Evaluation score ${r.score}/100${partial}"><b>${r.grade}</b><small>${r.score}</small>${r.qualityPartial ? '<sup class="q-partial" aria-label="quality partially assessed">*</sup>' : ""}</span>`;
}
const versionLabel = (r) => r?.evaluatedVersion?.label || null;

// ---------- history & provenance ----------
const history = {};
if (data.history) Object.assign(history, data.history);
else for (const run of runs) for (const [id, r] of Object.entries(run.entries)) (history[id] ??= []).push(historyPoint(run.run, r));

const CRIT_LABELS = [["findable", "Findable"], ["accessible", "Accessible"], ["interoperable", "Interoperable"], ["reusable", "Reusable"], ["quality", "Quality"], ["maintenance", "Maintenance"], ["adoption", "Adoption"]];
const METRIC_LABELS = [["consistent", "Logically consistent"], ["unsatisfiable", "Unsatisfiable classes"], ["owl2dl", "In OWL 2 DL"], ["robotErrors", "ROBOT errors"], ["robotWarnings", "ROBOT warnings"], ["criticalPitfalls", "Critical pitfalls"], ["imports", "Imported vocabularies"], ["reuse", "Reused by"]];
const fmtMetric = (v) => (v === true ? "yes" : v === false ? "no" : v == null ? "—" : fmtNum(v));

// Metrics across runs: one column per run (newest first), a row per criterion and quality metric; changed cells are marked.
function metricsAcrossRuns(h) {
  const runs = [...h].reverse().slice(0, 8);
  if (runs.length < 2) return "";
  const LOWER_BETTER = new Set(["Unsatisfiable classes", "ROBOT errors", "ROBOT warnings", "Critical pitfalls"]);
  const row = (label, get, fmt = fmtMetric) => {
    const vals = runs.map(get);
    if (vals.every((v) => v == null)) return "";
    return `<tr><th scope="row">${esc(label)}</th>${vals.map((v, i) => {
      const older = vals[i + 1];
      const changed = older != null && v != null && older !== v;
      // "up" = better, "down" = worse (for errors and pitfalls, fewer is better); yes/no changes just get marked.
      const better = typeof v === "number" && typeof older === "number" ? (v > older) !== LOWER_BETTER.has(label) : typeof v === "boolean" ? v : null;
      const dir = better == null ? "" : better ? " up" : " down";
      return `<td class="num${changed ? ` changed${dir}` : ""}"${changed ? ` title="was ${attr(fmt(older))}"` : ""}>${esc(fmt(v))}</td>`;
    }).join("")}</tr>`;
  };
  return `<details class="metrics-runs"${runs.some((p, i) => i && JSON.stringify([p.crit, p.metrics]) !== JSON.stringify([runs[i - 1].crit, runs[i - 1].metrics])) ? " open" : ""}>
    <summary>Metrics across runs</summary>
    <div class="table-wrap"><table class="hist-table metrics-table"><thead><tr><th></th>${runs.map((p) => `<th class="num"><a href="/runs/${attr(p.runId)}.json">${esc(fmtDate(p.at))}</a><br><span class="muted">rubric v${esc(p.rubric || "?")}</span></th>`).join("")}</tr></thead><tbody>
      ${row("Score", (p) => p.score)}
      ${CRIT_LABELS.map(([k, label]) => row(label, (p) => p.crit?.[k] ?? null)).join("")}
      ${row("Penalty", (p) => p.penalty)}
      ${METRIC_LABELS.map(([k, label]) => row(label, (p) => p.metrics?.[k] ?? null)).join("")}
    </tbody></table></div>
    <p class="small muted">Newest run first. Highlighted cells changed since the run before; hover to see the earlier value. A rubric change alone can move points.</p>
  </details>`;
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
    for (const [k, label] of CRIT_LABELS) {
      const x = a.crit?.[k], y = b.crit?.[k];
      if (x != null && y != null && x !== y) add(`${label}: ${x} → ${y} (${y > x ? "+" : ""}${y - x})`);
    }
    if (a.penalty != null && b.penalty != null && a.penalty !== b.penalty) add(`Penalty: ${a.penalty} → ${b.penalty}`);
    for (const [k, label] of METRIC_LABELS) {
      const x = a.metrics?.[k], y = b.metrics?.[k];
      if (x != null && y != null && x !== y) add(`${label}: ${fmtMetric(x)} → ${fmtMetric(y)}`);
    }
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

// ---------- analytics (Google Tag Manager, loaded only after consent) ----------
const GTM = /^GTM-[A-Z0-9]+$/.test(config.gtmId || "") ? config.gtmId : null;
// Consent Mode v2 defaults to "denied"; GTM itself is injected only once the visitor has accepted.
const gtmHead = GTM
  ? `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'granted',security_storage:'granted',wait_for_update:500});
window.__loadGTM=function(){if(window.__gtmLoaded)return;window.__gtmLoaded=true;
<!-- Google Tag Manager -->
(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM}');
<!-- End Google Tag Manager -->
};
try{if(localStorage.getItem('cookie-consent')==='granted'){gtag('consent','update',{analytics_storage:'granted'});window.__loadGTM();}}catch(e){}</script>`
  : "";
const gtmBody = GTM
  ? `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
<div class="consent" id="consent" role="dialog" aria-live="polite" aria-label="Cookie consent" hidden>
  <p><b>Cookies.</b> We'd like to use Google Analytics (via Google Tag Manager) to understand how the site is used. It sets cookies only if you accept. <a href="/privacy/">Privacy</a></p>
  <div class="consent-actions"><button type="button" class="btn-ghost" data-consent="reject">Reject</button><button type="button" class="btn" data-consent="accept">Accept</button></div>
</div>`
  : "";

// ---------- layout ----------
function page({ title, description, pathname, body, graph = [], noindex = false, scripts = [] }) {
  const full = title ? `${title} · SchemaScope` : `SchemaScope — ${config.tagline}`;
  const desc = description || config.description;
  const canonical = abs(pathname);
  const ld = { "@context": "https://schema.org", "@graph": [...baseGraph(), ...graph] };
  const nav = (href, label) => `<a href="${href}"${pathname.startsWith(href) ? ' aria-current="page"' : ""}>${label}</a>`;
  // A menu group: opens on hover or focus on wide screens (click or tap toggles it); on small screens the items are listed under the label.
  const group = (label, items, extra = "") => {
    // Items may point into a page (/x/#part): the group is current on that page; only plain links are marked as the page.
    const current = items.some(([h]) => pathname.startsWith(h.split("#")[0]));
    return `<div class="nav-group" data-nav-group><button type="button" class="nav-group-btn${current ? " current" : ""}" aria-expanded="false" aria-haspopup="true">${label}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="nav-menu">${items.map(([h, t, d]) => `<a href="${h}"${!h.includes("#") && pathname.startsWith(h) ? ' aria-current="page"' : ""}><b>${t}</b><small>${d}</small></a>`).join("")}${extra}</div></div>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${gtmHead}
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
<link rel="preload" href="/assets/fonts/inter-latin-bec94a.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/instrument-serif-latin-03435c.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/style.css?v=${BUILD_ID}">
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
${gtmBody}
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="SchemaScope home">${logo()}</a>
    <nav class="nav" aria-label="Main">
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-links" aria-label="Menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path class="nt-open" d="M4 7h16M4 12h16M4 17h16"/><path class="nt-close" d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
      <div class="nav-links" id="nav-links">
      ${group("Catalog", [["/catalog/", "Browse the catalog", "Search and filter every resource"], ["/categories/", "Categories", "Resources grouped by domain"]])}
      <a class="nav-find" href="/recommend/"${pathname.startsWith("/recommend/") ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>Find a resource</a>
      ${nav("/evaluation/", "Evaluation")}
      ${nav("/mcp-docs/", "Use with AI")}
      ${group("About", [["/about/", "About", "What this is, who runs it and how"], ["/roadmap/", "Roadmap", "What's available and what's next"], ["/contact/", "Contact", "Questions, corrections and partnerships"]])}
      <a class="nav-submit" href="/submit/"${pathname.startsWith("/submit/") ? ' aria-current="page"' : ""}>Submit</a>
      </div>
      <button class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
      <a class="nav-account" href="/api/auth/github/login" data-account${pathname.startsWith("/account/") ? ' aria-current="page"' : ""}><span data-account-label>Sign in</span></a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="footer-top">
      <div class="footer-brand">${logo("logo-footer")}<p>${esc(config.description)}</p></div>
      <nav class="footer-cols" aria-label="Footer">
        <div><h2>Explore</h2>
        <a href="/catalog/">Catalog</a>
        <a href="/categories/">Categories</a>
        <a href="/recommend/">Find a resource</a>
        <a href="/evaluation/">How evaluation works</a>
        <a href="/evaluation/#runs">Run history</a></div>
        <div><h2>Developers</h2>
        <a href="/api-docs/">REST API</a>
        <a href="/mcp-docs/">Use with AI (MCP)</a>
        <a href="/llms-full.txt">Docs for LLMs</a>
        <a href="/catalog.json">catalog.json</a>
        <a href="/catalog.jsonld">DCAT JSON-LD</a></div>
        <div><h2>Community</h2>
        <a href="/submit/">Submit a resource</a>
        <a href="/roadmap/">Roadmap</a>
        ${config.repository ? `<a href="${attr(config.repository)}">GitHub</a>` : ""}
        <a href="/about/">About</a>
        <a href="/contact/">Contact</a></div>
      </nav>
    </div>
    <div class="footer-bottom">
      <div class="footer-legal">
        <span>© ${new Date().getFullYear()} ${esc(config.brand || config.name || "")}</span>
        <a href="/privacy/">Privacy</a>
        ${GTM ? `<a href="#" data-consent-open>Cookie settings</a>` : ""}
        <span class="footer-note">Descriptions are summaries; each resource keeps its own licence.${evaluatedAt ? ` Last evaluated ${evaluatedAt}.` : ""}</span>
      </div>
      ${config.parent ? `<a class="footer-parent" href="${attr(config.parent.url)}" rel="noopener"><span>${esc(config.parent.label || "Part of")}</span><img src="${attr(config.parent.logo)}" alt="${attr(config.parent.name)}" width="${config.parent.logoWidth || 320}" height="${config.parent.logoHeight || 80}" loading="lazy"></a>` : ""}
    </div>
  </div>
</footer>
<script src="/assets/app.js?v=${BUILD_ID}" defer></script>
${GTM ? `<script src="/assets/consent.js?v=${BUILD_ID}" defer></script>` : ""}
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
    <div class="find-choices">
      <span class="find-label"><span aria-hidden="true">✦</span> Not sure which to use?</span>
      <a class="find-box" href="/recommend/guided/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></svg><span><b>Answer a few questions</b><small>Area, type, format, must-haves</small></span><i aria-hidden="true">→</i></a>
      <a class="find-box" href="/recommend/ask/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg><span><b>Ask in your own words</b><small>An AI assistant suggests and explains</small></span><i aria-hidden="true">→</i></a>
    </div>
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
    <div><h2>Missing a schema or ontology?</h2><p class="muted">Submit it through ${config.repository ? `<a href="${attr(config.repository)}" rel="noopener">GitHub</a>` : "GitHub"}. Every addition is reviewed, validated and evaluated automatically before it is merged.</p></div>
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
  const nSubmitted = catalog.filter(isSubmitted).length;
  const trail = [["Home", "/"], ["Catalog", "/catalog/"]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>The catalog</h1>
  <p class="lede">All ${catalog.length.toLocaleString("en-US")} resources: harvested from Bioregistry, the OBO Foundry, OLS, TIB, LOV and NeuroSchema, found by probing the web directly, and ${nSubmitted ? `${nSubmitted.toLocaleString("en-US")} submitted by their authors` : "submitted by their authors"} through the <a href="/submit/">submission form</a>. Filter by domain (including cross-domain use), type, source or grade, and sort by score, FAIRness, activity or adoption.</p>
</section>
<section class="wrap section" id="explore">
  <div class="filters" role="group" aria-label="Filters">
    <label class="grow">Filter<input id="q" type="search" placeholder="Filter by name, tag, format…" autocomplete="off"></label>
    <label>Category<select id="f-cat"><option value="">All</option>${options(categories.map((c) => c.id), (id) => catById[id].name)}</select></label>
    <label>Type<select id="f-kind"><option value="">All</option>${options(allKinds, (k) => KIND_LABEL[k] || k)}</select></label>
    <label>Source<select id="f-reg"><option value="">All</option>${options(["Bioregistry", "OBO Foundry", "OLS (EMBL-EBI)", "TIB Terminology Service", "Linked Open Vocabularies (LOV)", "NeuroSchema", "discovered", "submitted", "curated"], (r) => ({ discovered: "Found by discovery", submitted: "Submitted by authors", curated: "Curated by SchemaScope" })[r] || r.replace(/ \(.*\)/, ""))}</select></label>
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
    <div class="find-choices">
      <span class="find-label"><span aria-hidden="true">✦</span> Not sure which to use?</span>
      <a class="find-box" href="/recommend/guided/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></svg><span><b>Answer a few questions</b><small>Area, type, format, must-haves</small></span><i aria-hidden="true">→</i></a>
      <a class="find-box" href="/recommend/ask/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg><span><b>Ask in your own words</b><small>An AI assistant suggests and explains</small></span><i aria-hidden="true">→</i></a>
    </div>
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
// Our ROBOT run next to the OBO Dashboard's. Scores use ours; differences are listed so they can be checked.
function robotComparePanel(r) {
  const c = r?.dashboardComparison;
  if (!c?.rows?.length) return "";
  const v = (x) => (x == null ? "—" : x === true ? "yes" : x === false ? "no" : fmtNum(x));
  const file = (u) => (u ? `<code>${esc(String(u).split("/").pop())}</code>` : "—");
  return `<div class="panel" id="robot-compare">
    <h2>Our checks vs the OBO Dashboard</h2>
    <p class="small muted">${c.differences.length ? `${c.differences.length} of ${c.rows.length} checks differ: ${esc(c.differences.join(", "))}.` : `All ${c.rows.length} checks agree.`} Scores use SchemaScope's own ROBOT run; the Dashboard is shown for comparison. The two may check different files (the Dashboard usually checks the <code>-base</code> release), which alone can change warning counts.</p>
    <div class="table-wrap"><table class="portal-table"><thead><tr><th>Check</th><th>SchemaScope (ROBOT + ELK)</th><th><a href="${attr(c.dashboard.page || "https://dashboard.obofoundry.org/")}" rel="noopener">OBO Dashboard</a></th><th></th></tr></thead><tbody>
      ${c.rows.map((x) => `<tr><td>${esc(x.check)}</td><td>${v(x.ours)}</td><td>${v(x.dashboard)}</td><td>${x.differs ? "<b>differs</b>" : x.ours != null && x.dashboard != null ? "same" : ""}</td></tr>`).join("")}
      <tr><td class="muted">File checked</td><td>${file(c.ours.artefact)}</td><td>${file(c.dashboard.artefact)}</td><td></td></tr>
      <tr><td class="muted">Checked on</td><td>${esc(fmtDate(c.ours.checkedAt))}</td><td>${esc(fmtDate(c.dashboard.checkedAt))}</td><td></td></tr>
    </tbody></table></div>
  </div>`;
}

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
      <ul class="bd-steps">${(b.steps || []).map((s) => `<li${s.notAssessed ? ' class="na"' : ""}><span>${esc(s.label)}</span><span class="muted">${esc(s.detail)}</span><b>${s.notAssessed ? `n/a<span class="muted"> (${s.outOf})</span>` : `${s.pts > 0 ? "+" : ""}${s.pts}`}</b></li>`).join("")}</ul>
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
      ${r?.qualityPartial ? `<p class="small q-partial-note">* Q partially assessed: ${r.qualityNotAssessed} of 20 points could not be checked and are left out of the total.</p>` : ""}
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
    ${robotComparePanel(r)}

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
      ${metricsAcrossRuns(h)}
      ${
        ch.length
          ? `<ul class="changes">${ch.slice(0, 20).map((c) => `<li><time datetime="${attr(c.at)}">${esc(fmtDate(c.at))}</time><span>${esc(c.what)}</span></li>`).join("")}</ul>`
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
          .map((s, i) => `<tr${i === 0 ? ' class="grp"' : ""}>${i === 0 ? `<td rowspan="${b.steps.length}"><b>${esc(rb.symbol)}</b> ${esc(rb.label)}${rb.fair ? ' <span class="fair-tag">FAIR</span>' : ""}<br><span class="muted small">= ${b.score} / ${b.max}</span></td>` : ""}<td>${esc(s.label)}</td><td class="muted">${esc(s.detail)}</td><td class="num">${s.notAssessed ? `n/a<span class="muted"> (${s.outOf})</span>` : `${s.pts > 0 ? "+" : ""}${s.pts}${s.max ? `<span class="muted"> / ${s.max}</span>` : ""}`}</td></tr>`)
          .join("");
      }).join("")}</tbody>
    </table></div>
    <p class="math">FAIR = ${RUBRIC.filter((x) => x.fair).map((rb) => r.breakdown[rb.key].score).join(" + ")} = <b>${r.fair}</b> / ${FAIR_MAX}</p>
    <p class="math">Penalty P = ${r.penalty ? -r.penalty.score : 0} <span class="muted small">(${esc(r.penalty?.reason || "—")})</span></p>
    <p class="math">Score = max(0, 100 · (${RUBRIC.filter((rb) => r.breakdown[rb.key]?.applicable !== false).map((rb) => `<span title="${attr(rb.label)}">${r.breakdown[rb.key].score}</span>`).join(" + ")}) / ${r.possible ?? 100} − ${r.penalty ? -r.penalty.score : 0}) = <b>${r.score}</b> → ${r.score} ≥ ${GRADES.find((g) => g.grade === r.grade).min} → grade <b>${r.grade}</b></p>
  </div>`;
}

// "All scores" table: the first rows render with the page; the rest load after first paint (app.js), so a large
// catalog doesn't block the page. The finished table is the same.
const FIRST_SCORE_ROWS = 100;
const scoreRows = () => [...catalog].sort(byScore);
const restRows = Math.max(0, catalog.length - FIRST_SCORE_ROWS);
const scoreRow = (e) => {
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
      };

function evaluationPage() {
  const rows = [...catalog].sort(byScore);
  const dist = GRADES.map((g) => ({ ...g, n: scored.filter((r) => r.grade === g.grade).length }));
  const trail = [["Home", "/"], ["Evaluation", "/evaluation/"]];
  const tbl = (steps, fmt) => steps.map((s) => `<span>${fmt(s)} → <b>${s.pts}</b></span>`).join(" · ");
  const runRows = [...runs]
    .reverse()
    .map((x) => {
      const scores = x.entries ? Object.values(x.entries).map((e) => e.score) : x.scores || [];
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
  <p class="small muted">* next to a grade means ontology quality (Q) was only partly assessed: checks SchemaScope could not run are left out of the possible points rather than scored 0.</p>
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
      <li><b>OBO Dashboard</b>: OBO principle checks and the ontologies that reuse it. Its ROBOT report and reasoner results are shown next to ours for comparison, and used only when our own check is missing.</li>
      <li><b>SchemaScope's own checks</b>: ROBOT reasons (ELK) and reports on every ontology's artefact, OBO Dashboard ones included; every ontology is also sent to the <a href="https://oops.linkeddata.es" rel="noopener">OOPS!</a> pitfall scanner.</li>
      <li><b>Crossref</b>: citation counts of each resource's reference paper.</li>
      <li><b>Curated data</b>: adopting projects, modules and tooling submitted through GitHub and reviewed before merge.</li>
    </ul>
    <p class="small muted">Each fact stores its source URL and retrieval time. Every run is archived as an immutable JSON snapshot, so any score can be traced back to the data behind it. If a source fails, the last good value is carried forward with its original timestamp and flagged. A low score often just means information is missing; adding a license, a PURL, a download link or documented adopters will raise it.</p>
  </div>
</section>

<section class="wrap section">
  <div class="section-head"><h2>All scores</h2><span class="muted small">Click a column to sort</span></div>
  <div class="table-wrap">
  <table class="score-table sortable"${restRows ? ` data-more="/evaluation/rows.html?v=${BUILD_ID}" data-more-count="${restRows}"` : ""}>
    <thead><tr>
      <th data-sort="text">Resource</th><th data-sort="text">Version evaluated</th>
      ${RUBRIC.map((r) => `<th data-sort="num" class="num${r.fair ? " th-fair" : ""}" title="${attr(r.label)}">${esc(r.symbol)}<small>/${r.max}</small></th>`).join("")}
      <th data-sort="num" class="num th-pen" title="Inactivity penalty">P</th>
      <th data-sort="num" class="num th-fair">FAIR<small>/${FAIR_MAX}</small></th>
      <th data-sort="num" class="num">Score</th><th data-sort="text">Last activity</th>
    </tr></thead>
    <tbody>${scoreRows().slice(0, FIRST_SCORE_ROWS).map(scoreRow).join("")}</tbody>
  </table>
  </div>
  ${restRows ? `<p class="muted small" data-more-status>Showing the top ${FIRST_SCORE_ROWS} of ${catalog.length.toLocaleString("en-US")}; loading the rest… <noscript><a href="/evaluation/rows.html">All rows</a></noscript></p>` : ""}
</section>

<section class="wrap section" id="runs">
  <p class="small">How robust are these scores? See the <a href="/evaluation/validation/">rubric validation</a>: sensitivity to the weights, agreement with the OBO Dashboard and with expert ratings.</p>
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
  <p class="lede">All additions and corrections go through ${config.repository ? `<a href="${attr(config.repository)}" rel="noopener">GitHub</a>` : "GitHub"}, so every change is reviewed, tracked and checked automatically before it is merged.</p>
</section>

<section class="wrap section">
  <ol class="flow">
    <li><b>1. Describe it</b><span>Fill in the form below, or open the ${issueUrl ? `<a href="${attr(issueUrl)}" rel="noopener">GitHub issue form</a>` : "GitHub issue form"} directly.</span></li>
    <li><b>2. Issue → pull request</b><span>A bot turns your issue into a pull request that adds the entry to <code>data/catalog.json</code>.</span></li>
    <li><b>3. Automated checks</b><span>CI validates the entry, checks links and DOIs for duplicates, runs the FAIR evaluation and posts the score on the PR.</span></li>
    <li><b>4. Review &amp; merge</b><span>A maintainer reviews and merges. The site redeploys, and the next evaluation run archives it.</span></li>
  </ol>
</section>

<section class="wrap section submit-grid">
  <div class="panel signin-gate" data-signin-gate hidden>
    <h2>Sign in to submit</h2>
    <p>Submissions are made with your GitHub account, so reviewers can credit you and follow up. We only read your public profile and email.</p>
    <p><a class="btn" data-signin-link href="/api/auth/github/login?next=/submit/">Sign in with GitHub</a></p>
  </div>
  <form id="submit-form" class="panel submit-form" novalidate hidden data-repo="${attr(config.repository || "")}" data-categories="${attr(categories.map((c) => c.id).join(","))}">
    <h2>Resource details</h2>
    <p class="submitter small" data-submitter hidden></p>
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
    <fieldset class="usedby">
      <legend>Used by <small class="muted">projects, tools or datasets that use this resource</small></legend>
      <div class="usedby-rows" data-usedby></div>
      <button type="button" class="btn-ghost btn-sm" data-usedby-add>+ Add a project</button>
      <template data-usedby-row>
        <div class="usedby-row">
          <label>Project name<input data-f="name" placeholder="e.g. Allen Brain Atlas" autocomplete="off"></label>
          <label>URL<input data-f="url" type="url" placeholder="https://…" autocomplete="off"></label>
          <label class="usedby-note">How it is used <small class="muted">optional</small><input data-f="note" placeholder="e.g. annotates every image with these terms" autocomplete="off"></label>
          <button type="button" class="usedby-remove" data-usedby-remove aria-label="Remove this project" title="Remove">×</button>
        </div>
      </template>
    </fieldset>
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

// Contact details (override with CONTACT_NAME, CONTACT_EMAILS=a@x,b@y and CONTACT_SITE at build time).
const CONTACT = {
  name: process.env.CONTACT_NAME || "Tek Raj Chhetri",
  emails: (process.env.CONTACT_EMAILS || "tekraj.chhetri@cair-nepal.org,tekraj@mit.edu").split(",").map((x) => x.trim()).filter(Boolean),
  site: process.env.CONTACT_SITE ?? "https://tekrajchhetri.com/",
  github: process.env.CONTACT_GITHUB ?? "tekrajchhetri", // for the photo; empty to hide it
  role: process.env.CONTACT_ROLE || "Creator & maintainer",
};

// Contributors, pulled from the GitHub API at build time (bots left out). The last good list is cached in
// .local/ so an offline build, or one that hits the rate limit, still shows it.
// Accounts not to list, e.g. AI assistants credited through Co-Authored-By lines (CONTRIBUTORS_EXCLUDE=a,b).
const EXCLUDE = new Set((process.env.CONTRIBUTORS_EXCLUDE ?? "claude").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
async function githubContributors() {
  const m = String(config.repository || "").match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const cache = path.join(root, ".local", "contributors.json");
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "schemascope-build", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/contributors?per_page=100`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = (await r.json())
      .filter((c) => c.type !== "Bot" && !/\[bot\]$/.test(c.login) && !EXCLUDE.has(c.login.toLowerCase()))
      .map((c) => ({ login: c.login, url: c.html_url, avatar: c.avatar_url }));
    // Display names need one request per person; keep the login if that fails.
    for (const c of list.slice(0, 30)) {
      const u = await fetch(`https://api.github.com/users/${c.login}`, { headers, signal: AbortSignal.timeout(10000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (u?.name) c.name = u.name;
    }
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify(list, null, 2) + "\n");
    return list;
  } catch (err) {
    if (existsSync(cache)) return JSON.parse(await readFile(cache, "utf8")).filter((c) => !EXCLUDE.has(c.login.toLowerCase()));
    console.warn(`Note: couldn't fetch contributors from GitHub (${err.message}); the contact page links to GitHub instead.`);
    return null;
  }
}
const contributors = await githubContributors();

function contactPage() {
  const trail = [["Home", "/"], ["Contact", "/contact/"]];
  const repo = config.repository;
  const ICON = {
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>',
  };
  const host = (u) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const ways = [
    { icon: ICON.plus, title: "Add or update a resource", text: "Use the submission form. A bot turns it into a pull request for review.", href: "/submit/", cta: "Submission form" },
    repo && { icon: ICON.flag, title: "Report a problem", text: "Wrong score or metadata, a broken link, or a bug on the site?", href: `${repo}/issues/new?template=report-problem.yml`, cta: "Report a problem" },
    repo && { icon: ICON.code, title: "Suggest an idea", text: "A feature, a scoring improvement or a collaboration. The code is open source too.", href: `${repo}/issues/new?template=idea.yml`, cta: "Suggest an idea" },
  ].filter(Boolean);
  const people = contributors?.length
    ? `<ul class="people">${contributors.map((c) => `<li><a href="${attr(c.url)}" rel="noopener"><img src="${attr(c.avatar)}&amp;s=160" alt="" width="64" height="64" loading="lazy"><b>${esc(c.name || c.login)}</b>${c.name ? `<small>@${esc(c.login)}</small>` : ""}</a></li>`).join("")}</ul>`
    : "";
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Contact</h1>
  <p class="lede">Questions, corrections or ideas for collaboration? We'd like to hear from you.</p>
</section>
<section class="wrap section contact">
  <div class="contact-grid">
    <article class="contact-card maintainer">
      ${CONTACT.github ? `<img class="portrait" src="https://github.com/${attr(CONTACT.github)}.png?size=240" alt="${attr(CONTACT.name)}" width="112" height="112">` : ""}
      <div>
        <p class="eyebrow">${esc(CONTACT.role)}</p>
        <h2>${esc(CONTACT.name)}</h2>
        <div class="contact-links">
          ${CONTACT.emails.map((x) => `<a class="contact-link" href="mailto:${attr(x)}">${ICON.mail}<span>${esc(x)}</span></a>`).join("")}
          ${CONTACT.site ? `<a class="contact-link" href="${attr(CONTACT.site)}" rel="noopener">${ICON.globe}<span>${esc(host(CONTACT.site))}</span></a>` : ""}
        </div>
      </div>
    </article>
    <div class="ways">
      ${ways.map((w) => `<a class="way" href="${attr(w.href)}"${w.href.startsWith("http") ? ' rel="noopener"' : ""}><span class="way-icon">${w.icon}</span><span><b>${esc(w.title)}</b><span class="muted">${esc(w.text)}</span><span class="way-cta">${esc(w.cta)} →</span></span></a>`).join("")}
    </div>
  </div>
  ${people || repo ? `<div class="contributors-block" id="contributors">
    <h2>Contributors</h2>
    <p class="muted">Everyone who has contributed to SchemaScope on GitHub.</p>
    ${people}
    ${repo ? `<p class="small muted"><a href="${attr(repo)}/graphs/contributors" rel="noopener">See all contributions on GitHub</a></p>` : ""}
  </div>` : ""}
</section>`;
  const description = `Contact the SchemaScope maintainer, and the people who have contributed to it on GitHub.`;
  return page({ title: "Contact", pathname: "/contact/", body, description, graph: [webPage("ContactPage", "/contact/", "Contact SchemaScope", description), breadcrumbs(trail)] });
}

// Features & roadmap, from data/roadmap.json (edit that file to update the page).
const roadmap = data.roadmap;
function roadmapPage() {
  const trail = [["Home", "/"], ["Features & roadmap", "/roadmap/"]];
  const LABEL = { done: "Available", "in-progress": "In progress", planned: "Planned" };
  const all = roadmap.sections.flatMap((x) => x.items);
  const count = (st) => all.filter((i) => i.status === st).length;
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Features &amp; roadmap</h1>
  <p class="lede">What SchemaScope does today, and what we plan to build next.</p>
  <p class="small muted">${count("done")} available · ${count("in-progress")} in progress · ${count("planned")} planned · updated ${esc(fmtDate(roadmap.updated))}</p>
</section>
<section class="wrap section">
  ${roadmap.sections.map((sec) => `<div class="roadmap-sec" id="${attr(sec.id)}">
    <h2>${esc(sec.title)}</h2>
    <ul class="roadmap">${sec.items.map((i) => `<li class="rm-${attr(i.status)}"><span class="rm-status">${esc(LABEL[i.status] || i.status)}</span><div><b>${esc(i.title)}</b><p>${esc(i.text)}</p></div></li>`).join("")}</ul>
  </div>`).join("")}
  <p class="small muted">Ideas or priorities you'd like to see? <a href="/contact/">Get in touch</a>${config.repository ? ` or <a href="${attr(config.repository)}/issues/new?template=idea.yml" rel="noopener">suggest an idea on GitHub</a>` : ""}.</p>
</section>`;
  const description = "SchemaScope's features and development roadmap: catalog and discovery, evaluation and rubric improvements, publication tracking, recommendations, AI readiness (MCP server, API) and tools for maintainers.";
  return page({ title: "Features & roadmap", pathname: "/roadmap/", body, description, graph: [webPage("WebPage", "/roadmap/", "SchemaScope features & roadmap", description), breadcrumbs(trail)] });
}

// Rubric validation (scripts/validate-rubric.mjs → data/validation/report.json): sensitivity to the weights,
// agreement with the OBO Dashboard, and agreement with expert ratings.
const validation = data.validation ?? null;
function validationPage() {
  const trail = [["Home", "/"], ["Evaluation", "/evaluation/"], ["Rubric validation", "/evaluation/validation/"]];
  const v = validation;
  const pc = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  const n = (x) => (x == null ? "—" : String(x));
  const sens = v?.sensitivity;
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Rubric validation</h1>
  <p class="lede">How robust SchemaScope's scores are: how much they move when the weights change, how well our own quality checks agree with the OBO Dashboard, and how well scores agree with expert ratings.</p>
  ${v ? `<p class="small muted">Rubric v${esc(v.rubricVersion)} · ${fmtNum(v.entries)} resources · computed ${esc(fmtDate(v.generatedAt))} from the evaluation of ${esc(fmtDate(v.evaluation.generatedAt))}. Reproduce with <code>npm run validate:rubric</code>.</p>` : ""}
</section>
${!v ? `<section class="wrap section"><p class="muted">No validation report yet. Run <code>npm run validate:rubric</code>.</p></section>` : `
<section class="wrap section">
  <h2>Sensitivity to the weights</h2>
  <p class="muted">${esc(sens.method)}</p>
  <div class="stat-grid">
    <div class="stat"><b>${n(sens.spearman.mean)}</b><span>mean rank correlation with the published ranking (worst 5%: ${n(sens.spearman.p05)})</span></div>
    <div class="stat"><b>${pc(sens.sameGradeShare.mean)}</b><span>of resources keep their grade on average (worst draw ${pc(sens.sameGradeShare.min)})</span></div>
    <div class="stat"><b>${n(sens.meanAbsScoreChange.mean)}</b><span>points mean score change</span></div>
    <div class="stat"><b>${fmtNum(sens.borderline.count)}</b><span>borderline resources: grade changes in ≥ ${Math.round(sens.borderline.threshold * 100)}% of draws</span></div>
  </div>
  <h3>One criterion at a time</h3>
  <div class="table-wrap"><table class="hist-table"><thead><tr><th>Criterion</th><th class="num">Grade changes, weight −30%</th><th class="num">+30%</th><th class="num">Criterion dropped</th><th class="num">Rank correlation if dropped</th></tr></thead><tbody>
    ${sens.oneAtATime.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${fmtNum(x.minus.gradeChanges)}</td><td class="num">${fmtNum(x.plus.gradeChanges)}</td><td class="num">${fmtNum(x.dropped.gradeChanges)}</td><td class="num">${n(x.dropped.rho)}</td></tr>`).join("")}
  </tbody></table></div>
  ${sens.borderline.examples.length ? `<details><summary>Most borderline resources</summary><ul class="changes">${sens.borderline.examples.map((x) => `<li><span><a href="/o/${attr(x.id)}/">${esc(x.name)}</a></span><span class="muted">${x.score} (${esc(x.grade)}), grade changes in ${Math.round(x.flipShare * 100)}% of draws</span></li>`).join("")}</ul></details>` : ""}
</section>
<section class="wrap section">
  <h2>Our quality checks vs the OBO Dashboard</h2>
  <p class="muted">${esc(v.dashboardAgreement.method)}</p>
  ${v.dashboardAgreement.ontologies ? `<div class="table-wrap"><table class="hist-table"><thead><tr><th>Check</th><th class="num">Compared</th><th class="num">Agree</th><th class="num">Agreement</th><th>Differing (examples)</th></tr></thead><tbody>
    ${v.dashboardAgreement.checks.map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${fmtNum(c.compared)}</td><td class="num">${fmtNum(c.agree)}</td><td class="num">${pc(c.rate)}</td><td>${c.differing.slice(0, 6).map((d) => `<a href="/o/${attr(d.id)}/#robot-compare">${esc(d.id)}</a>`).join(", ") || "—"}</td></tr>`).join("")}
  </tbody></table></div>
  ${v.dashboardAgreement.robotErrors ? `<p class="small muted">ROBOT error counts on ${fmtNum(v.dashboardAgreement.robotErrors.compared)} ontologies: ours higher for ${fmtNum(v.dashboardAgreement.robotErrors.oursHigher)}, equal for ${fmtNum(v.dashboardAgreement.robotErrors.equal)}, lower for ${fmtNum(v.dashboardAgreement.robotErrors.oursLower)} (rank correlation ${n(v.dashboardAgreement.robotErrors.spearman)}). We check the full download, which often includes imported terms.</p>` : ""}`
  : `<p class="muted">No ontology has both results yet. This fills in as our quality checks run (<code>npm run quality:all</code>) and the catalog is re-evaluated.</p>`}
</section>
<section class="wrap section">
  <h2>Agreement with expert ratings</h2>
  ${v.experts.ratings ? `<p>${fmtNum(v.experts.ratings)} ratings of ${fmtNum(v.experts.entries)} resources by ${fmtNum(v.experts.raters)} rater${v.experts.raters === 1 ? "" : "s"}. Rank correlation between our score and the mean rating: <b>${n(v.experts.rho)}</b>.</p>
  <div class="table-wrap"><table class="hist-table"><thead><tr><th>Our grade</th><th class="num">Resources rated</th><th class="num">Mean expert rating (1–5)</th></tr></thead><tbody>${v.experts.byGrade.map((g) => `<tr><td>${esc(g.grade)}</td><td class="num">${fmtNum(g.n)}</td><td class="num">${n(g.meanRating)}</td></tr>`).join("")}</tbody></table></div>`
  : `<p class="muted">No expert ratings yet. Ratings (1–5 per resource) go in <code>${esc(v.experts.file)}</code>; the comparison appears here once at least five resources are rated. Would you like to rate resources in your field? <a href="/contact/">Get in touch</a>.</p>`}
</section>`}`;
  const description = "How robust SchemaScope's scores are: sensitivity of grades to the rubric weights, agreement of our quality checks with the OBO Dashboard, and agreement with expert ratings.";
  return page({ title: "Rubric validation", pathname: "/evaluation/validation/", body, description, graph: [webPage("WebPage", "/evaluation/validation/", "SchemaScope rubric validation", description), breadcrumbs(trail)] });
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
  <p>Everything is tracked in Git. Use the <a href="/submit/">submission form</a>, which opens a pre-filled GitHub issue that a bot converts into a pull request, or edit <code>data/catalog.json</code> and open a pull request yourself on ${config.repository ? `<a href="${attr(config.repository)}" rel="noopener">GitHub</a>` : "GitHub"}. Every pull request is validated, link-checked, de-duplicated and FAIR-evaluated in CI before a maintainer reviews and merges it.</p>

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

function privacyPage() {
  const brand = config.brand || config.name || "This site";
  const trail = [["Home", "/"], ["Privacy", "/privacy/"]];
  const body = `
<div class="wrap doc">
  <aside class="doc-toc" aria-label="On this page">
    <p class="doc-toc-title">On this page</p>
    <nav data-doc-toc>
      <a href="#summary">In short</a>
      <a href="#chat">Search and chat</a>
      <a href="#account">Accounts and sign-in</a>
      <a href="#limits">Rate limits</a>
      <a href="#submissions">Submissions</a>
      <a href="#analytics">Analytics and cookies</a>
      <a href="#browser">Stored in your browser</a>
      <a href="#hosting">Hosting</a>
      <a href="#contact">Questions and requests</a>
    </nav>
  </aside>
  <article class="doc-main">
    ${crumbsHtml(trail)}
    <header class="doc-hero">
      <p class="doc-eyebrow"><span></span>Privacy</p>
      <h1>Your data, <em>plainly.</em></h1>
      <p>What ${esc(brand)} stores, why, and what you can do about it. Reading the catalog needs no account and stores nothing about you.</p>
      <p class="doc-updated">Last updated 31 October 2026</p>
    </header>
    <section class="doc-sec" id="summary">
      <h2>In short</h2>
      <div class="doc-cards">
        <div class="doc-card"><span class="doc-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span><b>Browsing is anonymous</b><p>The catalog, search, the API and the documentation work without an account and store nothing about you.</p></div>
        <div class="doc-card"><span class="doc-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg></span><b>Accounts use GitHub</b><p>Signing in stores your public GitHub profile and email, to show your account, credit submissions and raise your rate limit.</p></div>
        <div class="doc-card"><span class="doc-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5"/></svg></span><b>Logs without identity</b><p>Searches and chat answers are logged without who asked, to improve search. Signed in, turn it off in <a href='/account/#settings'>Settings</a>.</p></div>
        <div class="doc-card"><span class="doc-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg></span><b>Never sold, never sent out</b><p>We never sell data, and chat questions are answered by a model on our own server, not an outside AI service.</p></div>
      </div>
    </section>
    <section class="doc-sec" id="chat">
      <h2>Search and the recommendation chat</h2>
  <p>When you ask the assistant on <a href="/recommend/ask/">Find a resource</a>, your question is turned into a search of the catalog and a small language model running on our server writes the answer. Nothing is sent to an outside AI provider.</p>
  <h3>The anonymous chat and search log</h3>
  <p>To improve search and recommendations (for example to see which questions and searches return poor or no results, and to evaluate and train better ranking and models), we keep a log. For each <b>chat answer</b> it holds:</p>
  <ul>
    <li>the question you typed, what the assistant understood (filters), the resources it showed and the answer it wrote, and which model wrote it;</li>
    <li>your feedback, if you give it: 👍 or 👎 and any comment;</li>
    <li>a random id for your browser session, so turns of one conversation stay together; and the time.</li>
  </ul>
  <p>For each <b>search</b> (the guided questions on Find a resource, the search bar, and the catalog's filters) it holds the words and filters used, how many results there were, the top results, which result you opened, the session id and the time. Searches are logged once you stop typing, not every keystroke.</p>
  <p>The log does <b>not</b> contain your name, account, email, IP address or browser details, and it is not linked to your saved chats. Because it can't be traced back to you, we can't find or delete your entries later, so <b>please don't type personal or confidential information</b> into the chat.</p>
  <h3>When chats are logged</h3>
  <ul>
    <li><b>Signed out:</b> chat answers and searches are logged as above. Your chats are also kept in your browser for the current session only (session storage), so you can go back to them until you close the browser.</li>
    <li><b>Signed in:</b> logging is <b>on by default</b>. Turn it off at any time with <i>Help improve recommendations</i> in your account's <a href="/account/#settings">Settings</a>; after that, your chats and searches are no longer logged. If you rate or comment on an answer while logging is off, that one question and answer are logged (still without your identity) together with your feedback.</li>
  </ul>
  <h3>Saved chats (signed in)</h3>
  <p>Signed in, your chats are saved to your account so you can return to them. Only you can see them. Rename or delete them in the chat's sidebar; deleting removes the chat and its messages from your account.</p>
    </section>
    <section class="doc-sec" id="account">
      <h2>Accounts and sign-in</h2>
  <p>Signing in uses GitHub. We store your GitHub user id, login, name, avatar and profile link, and your verified email address (used to identify administrators and to contact you about your submissions). We set a session cookie (<code>HttpOnly</code>, valid for a limited time) to keep you signed in. You can sign out at any time.</p>
  <p><b>Personal access tokens</b> you create are stored only as a one-way hash, with their name, access, expiry and when they were last used. You can revoke them on your account page.</p>
  <p><b>Activity log:</b> for security and accountability we record sign-ins and sign-outs, token changes, submissions, reviews and administrative changes, with the time, your account, the IP address and the browser's user agent. You can see your own activity on your account page; administrators can see the full log.</p>
    </section>
    <section class="doc-sec" id="limits">
      <h2>Rate limits</h2>
  <p>To share the service fairly we count requests per minute, by IP address when signed out and by account when signed in. These counts are kept in memory for about a minute and are not stored.</p>
    </section>
    <section class="doc-sec" id="submissions">
      <h2>Submissions</h2>
  <p>When you submit or correct a resource, the entry is recorded with your account so you are credited, and you finish it as a GitHub issue and pull request, which are public and subject to <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" rel="noopener">GitHub's privacy statement</a>. Reviewers' decisions and notes are shown to you on your account page.</p>
    </section>
    <section class="doc-sec" id="analytics">
      <h2>Analytics and cookies</h2>
  ${GTM ? `<p>With your consent we use <b>Google Analytics</b>, loaded through <b>Google Tag Manager</b> (container <code>${GTM}</code>), to count visits and see which pages are useful. Until you click <i>Accept</i>, no Google script is loaded and no analytics cookies are set. Advertising storage and personalisation remain disabled even if you accept (Google Consent Mode v2).</p>
  <p>Your choice is stored in your browser's local storage (<code>cookie-consent</code>). You can change it at any time with <a href="#" data-consent-open>Cookie settings</a>; withdrawing consent removes the Google Analytics cookies.</p>
  <p>Visitors with JavaScript disabled cannot be asked for consent; for them Google Tag Manager's no-script fallback may load.</p>` : "<p>This site does not use analytics or tracking cookies.</p>"}
    </section>
    <section class="doc-sec" id="browser">
      <h2>Stored in your browser</h2>
  <ul>
    <li><b>Local storage:</b> your theme (light or dark), cookie choice, and a few display preferences of the developer docs.</li>
    <li><b>Session storage</b> (cleared when you close the browser): signed-out chats and the chat session id, a token you paste on the API docs page, and a newly created token so the setup instructions can show it.</li>
    <li><b>Cookies:</b> the sign-in session cookie, and a short-lived cookie during GitHub sign-in to protect against forged requests.</li>
  </ul>
    </section>
    <section class="doc-sec" id="hosting">
      <h2>Hosting</h2>
  <p>The site runs on our own server. Its web server and hosting provider may log technical request data (such as IP addresses) for security and operations; these logs are kept briefly and not used for anything else.</p>
    </section>
    <section class="doc-sec" id="contact">
      <h2>Questions and requests</h2>
  <p>To ask what we hold about your account, to have it deleted, or about anything on this page, <a href="/contact/">contact us</a>. Deleting your account removes your profile, tokens and saved chats; the anonymous chat log and public GitHub contributions are not linked to your account and stay as they are.</p>
  
    </section>
  </article>
</div>`;
  return page({ title: "Privacy", pathname: "/privacy/", body, description: `How ${brand} handles accounts, chats, analytics, cookies and your data.`, graph: [webPage("WebPage", "/privacy/", "Privacy", "Privacy and cookies"), breadcrumbs(trail)] });
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


// ---------- accounts: sign-in, account, API docs ----------
// These pages are filled in by /assets/account.js and /assets/apidocs.js from the API (same origin).

function accountPage() {
  const trail = [["Home", "/"], ["Account", "/account/"]];
  const brand = config.brand || config.name || "Catalog";
  const brandSlug = brand.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const ic = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const I = {
    key: ic('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M16 7l3 3M14 9l2 2"/>'),
    box: ic('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
    gauge: ic('<path d="M4 15a8 8 0 1 1 16 0"/><path d="m12 15 4-5"/>'),
    code: ic('<path d="m8 6-6 6 6 6m8-12 6 6-6 6"/>'),
    mcp: ic('<path d="M8 3h8v6H8zM2 15h8v6H2zm12 0h8v6h-8zM12 9v3M6 15v-3h12v3"/>'),
    shield: ic('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  };
  const body = `
<section class="wrap acc" data-account-page>
  ${crumbsHtml(trail)}
  <div class="acc-title"><div><h1>Your account</h1><p class="lede" data-account-intro>Manage your access, connect your tools and follow your contributions.</p></div></div>
  <div data-account-body hidden>
  <div class="acc-profile" data-profile></div>

  <div class="acc-tabs" role="tablist" aria-label="Account sections">
    <button role="tab" id="tab-overview" aria-controls="overview" data-tab="overview">Overview</button>
    <button role="tab" id="tab-tokens" aria-controls="tokens" data-tab="tokens">Access tokens <span class="acc-count" data-token-count>0</span></button>
    <button role="tab" id="tab-connections" aria-controls="connections" data-tab="connections">Connections</button>
    <button role="tab" id="tab-activity" aria-controls="activity" data-tab="activity">Activity</button>
    <button role="tab" id="tab-settings" aria-controls="settings" data-tab="settings">Settings</button>
  </div>

  <section class="acc-panel" id="overview" role="tabpanel" aria-labelledby="tab-overview">
    <div class="acc-stats">
      <div class="acc-stat"><span class="acc-eyebrow">Active tokens</span><span class="acc-stat-icon">${I.key}</span><strong data-stat-tokens>—</strong><p>For the API and MCP</p></div>
      <div class="acc-stat"><span class="acc-eyebrow">Your submissions</span><span class="acc-stat-icon">${I.box}</span><strong data-stat-subs>—</strong><p data-stat-subs-note>Your contributions to the catalog</p></div>
      <div class="acc-stat"><span class="acc-eyebrow">Rate limit</span><span class="acc-stat-icon">${I.gauge}</span><strong><span data-my-limit>—</span> <small>req / min</small></strong><p>Shared by your session and tokens. Signed out: <span data-anon-limit>—</span>.</p></div>
    </div>
    <div class="acc-grid">
      <article class="acc-card" id="submissions"><div class="acc-card-head"><h2>Your submissions</h2><a class="acc-link" href="/submit/">Submit a resource →</a></div><div data-submissions></div></article>
      <article class="acc-card"><div class="acc-card-head"><h2>Connect your workflow</h2></div><div class="acc-setup"><p>Bring ${esc(brand)} into the tools you already use.</p>
        <button type="button" class="acc-setup-item" data-open-connection="api"><span class="acc-symbol">${I.code}</span><span><b>Build with the API</b><small>Query the catalog from your code</small></span><span class="acc-arrow">→</span></button>
        <button type="button" class="acc-setup-item" data-open-connection="mcp"><span class="acc-symbol">${I.mcp}</span><span><b>Connect an AI client</b><small>Explore resources through MCP</small></span><span class="acc-arrow">→</span></button>
        <a class="acc-setup-item" href="/llms-full.txt" target="_blank" rel="noopener"><span class="acc-symbol">${ic('<path d="M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h5"/>')}</span><span><b>Docs for your AI assistant</b><small>Copy the API reference as Markdown</small></span><span class="acc-arrow">→</span></a>
      </div></article>
    </div>
    <article class="acc-card acc-recent"><div class="acc-card-head"><h2>Recent activity</h2><button type="button" class="acc-link" data-go-tab="activity">View all activity →</button></div><div data-recent></div></article>
    <p class="acc-foot">${I.shield} Your access tokens act on your behalf. Keep them private and revoke any you no longer use.</p>
  </section>

  <section class="acc-panel" id="tokens" role="tabpanel" aria-labelledby="tab-tokens" hidden>
    <div class="acc-intro"><div><h2>Personal access tokens</h2><p>For your scripts, applications and AI clients. Send one as <code>Authorization: Bearer …</code>.</p></div><button type="button" class="btn" data-create-token>＋ Create token</button></div>
    <div class="acc-card acc-tablewrap"><table class="acc-table"><thead><tr><th>Name</th><th>Token</th><th>Access</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody data-tokens></tbody></table></div>
    <p class="acc-note">A token is shown only once, when you create it. Use a separate token for each application, so you can revoke one without affecting the others.</p>
  </section>

  <section class="acc-panel" id="connections" role="tabpanel" aria-labelledby="tab-connections" hidden>
    <div class="acc-intro"><div><h2>One catalog. Two ways to connect.</h2><p>Call the REST API from your code, or connect ${esc(brand)} to an AI client.</p></div><button type="button" class="btn-ghost" data-go-tab="tokens">Manage tokens →</button></div>
    <div class="acc-switch" role="group" aria-label="Connection type"><button type="button" data-conn="api">REST API</button><button type="button" data-conn="mcp">MCP</button></div>
    <article class="acc-card acc-connection">
      <span class="acc-eyebrow" data-conn-eyebrow></span>
      <h2 data-conn-title></h2>
      <p data-conn-desc></p>
      <label class="acc-client" data-client-wrap hidden>Client <select data-client>
        <option value="claude-code">Claude Code</option><option value="claude-desktop">Claude Desktop</option><option value="cursor">Cursor</option><option value="vscode">VS Code</option><option value="codex">Codex</option><option value="json">Other clients (JSON)</option>
      </select></label>
      <div class="acc-code"><div class="acc-code-head"><span data-code-label></span><button type="button" data-copy-code>Copy</button></div><pre data-conn-code></pre></div>
      <p class="acc-note" data-conn-note></p>
    </article>
  </section>

  <section class="acc-panel" id="settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
    <div class="acc-intro"><div><h2>Settings</h2><p>How your data is used. Changes are saved straight away.</p></div></div>
    <article class="acc-card acc-pad">
      <h3>Privacy &amp; data</h3>
      <label class="acc-setting"><input type="checkbox" data-improve><span><b>Help improve recommendations</b><small>Log my chat questions and answers and my searches, <b>without my identity</b>, so search and recommendations can be improved. When off, nothing is logged and your chats are only saved to your account. <a href="/privacy/#chat">How this works</a></small></span></label>
      <p class="small muted" data-improve-status></p>
    </article>
  </section>

  <section class="acc-panel" id="activity" role="tabpanel" aria-labelledby="tab-activity" hidden>
    <div class="acc-intro"><div><h2>Account activity</h2><p>Sign-ins, token changes and contributions, newest first.</p></div></div>
    <div class="acc-filters"><input type="search" data-activity-search aria-label="Search activity" placeholder="Search activity…"><select data-activity-filter aria-label="Filter by event type"><option value="">All events</option><option value="auth.">Sign-ins &amp; sign-outs</option><option value="token.">Token changes</option><option value="submission.">Submissions</option></select></div>
    <article class="acc-card" data-activity></article>
    <p><button type="button" class="btn-ghost btn-sm" data-activity-more hidden>Older activity</button></p>
  </section>

  </div>
</section>

<dialog class="acc-dialog" data-create-dialog aria-labelledby="create-title">
  <form method="dialog" data-token-form>
    <h2 id="create-title">Create an access token</h2>
    <p>Give it a name you'll recognise and choose what it can access.</p>
    <label class="acc-field">Token name<input name="name" required maxlength="80" placeholder="e.g. Claude Code on my laptop" autocomplete="off"></label>
    <fieldset class="acc-field"><legend>Access</legend><div class="acc-checks">
      <label><input type="checkbox" name="scope" value="api" checked> REST API</label>
      <label><input type="checkbox" name="scope" value="mcp" checked> MCP</label></div></fieldset>
    <label class="acc-field">Expires<select name="expires"><option value="30">in 30 days</option><option value="90" selected>in 90 days</option><option value="365">in 1 year</option><option value="">never</option></select></label>
    <p class="acc-error" data-token-error hidden></p>
    <div class="acc-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn" value="create">Create token</button></div>
  </form>
</dialog>
<dialog class="acc-dialog" data-secret-dialog aria-labelledby="secret-title">
  <h2 id="secret-title">Copy your new token</h2>
  <p>This is the only time it is shown. Store it somewhere safe, such as an environment variable or your client's settings.</p>
  <div class="acc-code"><div class="acc-code-head"><span>Token</span><button type="button" data-copy-secret>Copy</button></div><pre data-token-value></pre></div>
  <p class="small muted" data-secret-next></p>
  <div class="acc-actions"><button type="button" class="btn-ghost" data-open-connection="mcp">Set up a client</button><button type="button" class="btn" data-close>Done</button></div>
</dialog>
<dialog class="acc-dialog" data-revoke-dialog aria-labelledby="revoke-title">
  <h2 id="revoke-title">Revoke this token?</h2>
  <p data-revoke-text>Anything using it stops working immediately.</p>
  <div class="acc-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn acc-danger" data-confirm-revoke>Revoke token</button></div>
</dialog>
<div class="acc-toast" role="status" aria-live="polite" data-toast></div>
<template data-brand-slug>${esc(brandSlug)}</template>`;
  return page({ title: "Account", pathname: "/account/", body, noindex: true, description: "Your account: tokens, connections, submissions and activity.", scripts: ["/assets/account.js"] });
}

// Recommend: a landing page that sends people to the guided questions or the chat (two pages, one engine).
function recommendData() {
  const live = catalog.filter((e) => e.status !== "legacy");
  const count = (fn) => { const m = new Map(); for (const e of live) for (const k of [fn(e)].flat()) if (k) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const top = [...catalog].sort(byScore)[0];
  const topic = (top?.tags || [])[0] || "anatomy";
  const kinds = count((e) => e.kind);
  const areas = categories.map((c) => [c.id, c.name]);
  return { kinds, formats: count((e) => e.formats || []).slice(0, 14), areas, topic, examples: [
    `An actively maintained ontology for ${topic}`,
    "A schema to describe research datasets, with an open licence",
    `Which ontology is most widely used in ${areas[0]?.[1] || "my field"}?`,
  ] };
}
const REC_ICON = {
  guide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></svg>',
  ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>',
};
const recResults = () => `
    <div class="rec-results-head"><h2>Recommendations</h2><span class="small muted" data-rec-summary></span></div>
    <div class="rec-understood" data-understood hidden></div>
    <ol class="rec-results" data-rec-results><li class="rec-empty">Loading…</li></ol>`;

function recommendPage() {
  const brand = config.brand || config.name || "Catalog";
  const { examples, topic } = recommendData();
  const trail = [["Home", "/"], ["Catalog", "/catalog/"], ["Find the right resource", "/recommend/"]];
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <p class="eyebrow">Recommend</p>
  <h1>Find the right resource</h1>
  <p class="lede">Not sure which ontology, schema or standard to use? Choose how you'd like to look. Both use ${esc(brand)}'s evaluations, how widely each resource is used and how recently it was updated, and show the reasons for every suggestion.</p>
</section>
<section class="wrap section rec-landing">
  <a class="rec-path" href="/recommend/guided/">
    <span class="rec-path-icon">${REC_ICON.guide}</span>
    <span class="rec-path-tag">Guided · no typing needed</span>
    <h2>Answer a few questions</h2>
    <p>Pick the area you work in, the type of resource, the format you need and your must-haves, such as an open licence or active maintenance. Results update as you choose.</p>
    <ul><li>Best when you know your requirements</li><li>Every filter is visible and easy to change</li><li>Instant results</li></ul>
    <span class="rec-path-cta">Start with questions →</span>
  </a>
  <div class="rec-path">
    <span class="rec-path-icon">${REC_ICON.ask}</span>
    <span class="rec-path-tag">Chat · AI assistant</span>
    <h2>Ask in your own words</h2>
    <p>Describe what you're working on, like you would to a colleague. An assistant finds matching resources in the catalog and explains which fit best and why.</p>
    <form class="rec-quick" action="/recommend/ask/" method="post" data-ask-start><label class="sr-only" for="rec-quick-q">Your question</label><input id="rec-quick-q" name="q" type="text" maxlength="600" placeholder="e.g. ${attr(examples[0])}" required><button class="btn" type="submit">Ask</button></form>
    <div class="rec-path-examples">${examples.slice(1).map((x) => `<a href="/recommend/ask/" data-ask-q="${attr(x)}">${esc(x)}</a>`).join("")}</div>
    <a class="rec-path-cta" href="/recommend/ask/">Open the chat →</a>
  </div>
</section>
<section class="wrap section rec-how">
  <h2>How recommendations are made</h2>
  <div class="rec-how-grid">
    <div><b>Match</b><p>How well a resource fits your words or choices: its name, description, tags and domains.</p></div>
    <div><b>Quality</b><p>Its ${esc(brand)} grade, from automated checks of FAIRness, quality and maintenance.</p></div>
    <div><b>Use</b><p>How many projects are known to use it, and how recently it was updated.</p></div>
    <div><b>Reasons</b><p>Each suggestion lists why it was picked, so you can judge for yourself. <a href="/evaluation/">How grades work</a></p></div>
  </div>
</section>`;
  return page({ title: "Find the right resource", pathname: "/recommend/", body, description: `Which ontology, schema or standard should you use? Answer a few questions or ask in your own words, and get recommendations from ${brand} with the reasons for each.`, scripts: [] });
}

function recommendGuidedPage() {
  const brand = config.brand || config.name || "Catalog";
  const { kinds, formats, areas, topic } = recommendData();
  const trail = [["Home", "/"], ["Find the right resource", "/recommend/"], ["Guided", "/recommend/guided/"]];
  const chip = (name, value, label, n, checked = false) => `<label class="rec-chip"><input type="radio" name="${name}" value="${attr(value)}"${checked ? " checked" : ""}><span>${esc(label)}${n != null ? ` <small>${n.toLocaleString("en-US")}</small>` : ""}</span></label>`;
  const body = `
<section class="page-head wrap">
  ${crumbsHtml(trail)}
  <h1>Answer a few questions</h1>
  <p class="lede">Choose what matters to you; recommendations update as you go. Prefer to describe it? <a href="/recommend/ask/">Ask in your own words</a>.</p>
</section>
<section class="wrap section rec" data-recommend>
  <aside class="rec-guide" aria-label="Questions">
    <form data-guide>
      <label class="rec-field"><span class="rec-q"><span class="rec-step">1</span> What's it about? <span class="muted">(optional)</span></span><input type="search" name="q" placeholder="e.g. ${attr([...new Set([topic, "cell types", "datasets", "units"])].slice(0, 3).join(", "))}" autocomplete="off"></label>
      <label class="rec-field"><span class="rec-q"><span class="rec-step">2</span> Your area</span><select name="category"><option value="">Any area</option>${areas.map(([id, name]) => `<option value="${attr(id)}">${esc(name)}</option>`).join("")}</select></label>
      <fieldset class="rec-field"><legend><span class="rec-step">3</span> Type of resource</legend><div class="rec-chips">${chip("kind", "", "Any", null, true)}${kinds.map(([k, n]) => chip("kind", k, KIND_LABEL[k] || k, n)).join("")}</div></fieldset>
      <label class="rec-field"><span class="rec-q"><span class="rec-step">4</span> Format you need</span><select name="format"><option value="">Any format</option>${formats.map(([f, n]) => `<option value="${attr(f)}">${esc(f)} (${n})</option>`).join("")}</select></label>
      <fieldset class="rec-field"><legend><span class="rec-step">5</span> Must have</legend>
        <label class="rec-check"><input type="checkbox" name="maintained"><span><b>Actively maintained</b><small>Updated in the last two years</small></span></label>
        <label class="rec-check"><input type="checkbox" name="open_license"><span><b>Open licence</b><small>CC0, CC BY, MIT, Apache, BSD…</small></span></label>
        <label class="rec-check"><input type="checkbox" name="used"><span><b>Used by other projects</b><small>At least one known adopter</small></span></label>
      </fieldset>
      <fieldset class="rec-field"><legend><span class="rec-step">6</span> Minimum grade</legend><div class="rec-chips">${chip("min_grade", "", "Any", null, true)}${["A", "B", "C"].map((g) => chip("min_grade", g, `${g}${g === "A" ? "" : " or better"}`)).join("")}</div></fieldset>
      <label class="rec-field"><span class="rec-q"><span class="rec-step">7</span> Order by</span><select name="sort"><option value="">Most relevant first</option><option value="score">Highest grade (among relevant)</option></select></label>
      <button type="reset" class="btn-ghost btn-sm">Start over</button>
    </form>
  </aside>
  <div class="rec-main">${recResults()}</div>
</section>`;
  return page({ title: "Find a resource: guided", pathname: "/recommend/guided/", body, description: `Answer a few questions and get ${brand} recommendations for ontologies, schemas and standards, with the reasons for each.`, scripts: ["/assets/recommend.js"] });
}

function recommendAskPage() {
  const brand = config.brand || config.name || "Catalog";
  const { examples, topic } = recommendData();
  const cards = [
    [examples[0], "Maintained resources for a topic"],
    [examples[1], "Schemas with an open licence"],
    [examples[2], "What most projects use"],
    [`Compare the best options for ${topic}`, "Trade-offs between candidates"],
  ];
  const body = `
<div class="cg" data-chatapp data-brand="${attr(brand)}">
  <aside class="cg-side" data-chat-side aria-label="Chats">
    <a class="cg-new" href="/recommend/ask/" data-new-chat><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New chat</a>
    <p class="cg-side-title">Your chats</p>
    <nav class="cg-list" data-chat-list aria-label="Saved chats"><p class="cg-side-note">Loading…</p></nav>
    <div class="cg-side-foot"><a href="/recommend/guided/">Prefer choosing options? <b>Answer a few questions →</b></a></div>
  </aside>
  <section class="cg-main">
    <div class="cg-top">
      <button type="button" class="cg-menu" data-chat-menu aria-label="Show chats" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
      <h1 class="cg-title" data-chat-title>Find the right resource</h1>
      <span class="cg-status" data-chat-status></span>
    </div>
    <div class="cg-scroll" data-chat-scroll>
      <div class="cg-empty" data-chat-empty>
        <div class="cg-mark" aria-hidden="true">✦</div>
        <h2>What are you working on?</h2>
        <p>Describe your data or project and what matters (format, licence, maintenance). I'll suggest resources from ${esc(brand)} and explain why.</p>
        <div class="cg-cards">${cards.map(([q, d]) => `<button type="button" class="cg-card" data-suggest="${attr(q)}"><b>${esc(q)}</b><small>${esc(d)}</small></button>`).join("")}</div>
      </div>
      <div class="cg-thread" data-chat-log aria-live="polite"></div>
    </div>
    <form class="cg-composer" data-chat-form>
      <div class="cg-box">
        <label class="sr-only" for="cg-input">Message</label>
        <textarea id="cg-input" name="q" rows="1" maxlength="600" placeholder="Ask about ontologies, schemas or standards…" required></textarea>
        <button type="submit" class="cg-send" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
      <p class="cg-fine">Answers are written by a small AI model from ${esc(brand)}'s own data; check resource pages before relying on them. <span data-save-note></span></p>
    </form>
  </section>
</div>`;
  return page({ title: "Ask: find a resource", pathname: "/recommend/ask/", body, noindex: false, description: `Describe what you need and get ${brand} recommendations for ontologies, schemas and standards, explained by an AI assistant.`, scripts: ["/assets/chat.js"] });
}

function adminPage() {
  const brand = config.brand || config.name || "Catalog";
  const ic = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const NAV = [
    ["overview", "Overview", ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>')],
    ["submissions", "Submissions", ic('<path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5M8 8h8"/>')],
    ["catalog", "Catalog", ic('<path d="M4 4h16v16H4zM8 4v16M11 8h6M11 12h6M11 16h4"/>')],
    ["evaluations", "Evaluations", ic('<path d="m4 12 5 5L20 6M4 5h7M14 20h6"/>')],
    ["users", "Users &amp; access", ic('<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>')],
    ["logs", "Logs &amp; feedback", ic('<path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5"/>')],
    ["activity", "Activity log", ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>')],
  ];
  const body = `
<div class="adm" data-admin-page>
  <aside class="adm-side" data-adm-side>
    <div class="acc-eyebrow">Administration</div>
    <nav class="adm-nav" aria-label="Administration">${NAV.map(([id, label, icon]) => `<a href="#${id}" data-view-link="${id}">${icon}<span>${label}</span>${id === "submissions" ? '<b class="adm-count" data-queue-badge hidden></b>' : ""}</a>`).join("")}</nav>
    <div class="adm-side-foot"><a href="/catalog/">↗ Open the public catalog</a><a href="/account/">Your account</a><div class="adm-me" data-admin-me></div><button type="button" class="btn-ghost btn-sm adm-signout" data-adm-signout>Sign out</button></div>
  </aside>
  <div class="adm-main">
    <div class="adm-bar"><button type="button" class="btn-ghost btn-sm adm-menu" data-adm-menu aria-expanded="false">☰ Menu</button><div class="adm-crumb">Administration <span>/</span> <b data-adm-crumb>Overview</b></div><span class="adm-date" data-adm-date></span><button type="button" class="adm-bar-signout" data-adm-signout>Sign out</button></div>
    <p class="adm-denied" data-adm-denied hidden>This page is for ${esc(brand)} superadmins. <a href="/account/">Back to your account</a></p>
    <div data-adm-views hidden>

    <section class="adm-view" id="overview">
      <div class="adm-title"><div><div class="acc-eyebrow adm-accent">Catalog operations</div><h1>Admin dashboard</h1><p>Review contributions, follow evaluations and keep the catalog reliable.</p></div>
        <div class="adm-actions"><a class="btn-ghost" href="/api/admin/catalog.csv" download>↓ Export catalog</a><a class="btn" href="#evaluations">Evaluation runs</a></div></div>
      <div class="adm-stats" data-stats></div>
      <div class="adm-alert" data-alert hidden></div>
      <div class="adm-grid">
        <article class="acc-card"><div class="acc-card-head"><div><h2>Submission queue <span class="acc-badge" data-queue-count></span></h2><p class="adm-sub">New resources and corrections waiting for review.</p></div><a class="acc-link" href="#submissions">View all →</a></div><div class="acc-tablewrap"><table class="acc-table"><thead><tr><th>Resource</th><th>Type</th><th>Received</th><th></th></tr></thead><tbody data-queue></tbody></table></div></article>
        <article class="acc-card"><div class="acc-card-head"><div><h2>Service health</h2><p class="adm-sub">Checked when this page loaded.</p></div><span class="adm-pill" data-health-pill>…</span></div><div class="adm-health" data-health></div></article>
      </div>
      <div class="adm-grid adm-below">
        <article class="acc-card"><div class="acc-card-head"><div><h2>Score changes in the latest run</h2><p class="adm-sub" data-changes-sub></p></div><a class="acc-link" href="#evaluations">All runs →</a></div><div class="acc-tablewrap"><table class="acc-table"><thead><tr><th>Resource</th><th>Grade</th><th>Score</th><th>Change</th></tr></thead><tbody data-changes></tbody></table></div></article>
        <article class="acc-card"><div class="acc-card-head"><h2>Catalog composition</h2><span class="adm-sub" data-comp-total></span></div><div class="adm-bars" data-composition></div></article>
      </div>
    </section>

    <section class="adm-view" id="submissions" hidden>
      <div class="adm-vtitle"><h2>Submission review</h2><p>Read each proposed resource or correction and record a decision. The contributor sees your decision and notes on their account page; the entry itself is merged through its pull request on GitHub.</p></div>
      <div class="acc-filters"><input type="search" data-sub-search placeholder="Search by name, id or contributor…" aria-label="Search submissions"><select data-sub-status aria-label="Status"><option value="pending">Pending</option><option value="changes_requested">Changes requested</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option></select></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table"><thead><tr><th>Resource</th><th>Type</th><th>Contributor</th><th>Received</th><th>Status</th><th></th></tr></thead><tbody data-subs></tbody></table><div class="adm-listfoot" data-subs-foot></div></div>
    </section>

    <section class="adm-view" id="catalog" hidden>
      <div class="acc-intro"><div class="adm-vtitle"><h2>Resource catalog</h2><p>Search every published resource, check its evaluation and open its page.</p></div><a class="btn-ghost" href="/api/admin/catalog.csv" download>↓ Export CSV</a></div>
      <div class="acc-filters"><input type="search" data-cat-search placeholder="Search name, acronym, tag or domain…" aria-label="Search catalog"><select data-cat-kind aria-label="Type"><option value="">All types</option><option value="ontology">Ontology</option><option value="schema">Schema</option><option value="vocabulary">Vocabulary</option><option value="atlas">Atlas</option><option value="data-standard">Data standard</option><option value="knowledge-base">Knowledge base</option></select><select data-cat-grade aria-label="Grade"><option value="">All grades</option><option>A</option><option>B</option><option>C</option><option>D</option><option>E</option><option value="none">Not evaluated</option></select></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table"><thead><tr><th>Resource</th><th>Type</th><th>Domain</th><th>Grade</th><th>Score</th><th></th></tr></thead><tbody data-cat></tbody></table><div class="adm-listfoot"><span data-cat-foot></span> <button type="button" class="btn-ghost btn-sm" data-cat-more hidden>Load more</button></div></div>
    </section>

    <section class="adm-view" id="evaluations" hidden>
      <div class="adm-vtitle"><h2>Evaluation runs</h2><p>Each run re-checks every resource against its sources and scores it with the rubric. Runs are produced by the evaluator (<code>npm run evaluate</code>, locally or in the scheduled workflow) and loaded into the API with <code>npm run ingest</code>.</p></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table"><thead><tr><th>Run</th><th>Finished</th><th>Scope</th><th class="num">Resources</th><th>Rubric</th><th>Trigger</th><th></th></tr></thead><tbody data-runs></tbody></table></div>
      <p class="acc-note">To start a new run, use the evaluator from the repository. Starting runs from this page is on the <a href="/roadmap/">roadmap</a>.</p>
    </section>

    <section class="adm-view" id="users" hidden>
      <div class="adm-vtitle"><h2>Users &amp; access</h2><p>Rate limits for everyone, and per-user limits for people or projects that need more. Superadmins are set by email in the server's <code>SUPERADMIN_EMAILS</code> setting.</p></div>
      <article class="acc-card acc-pad"><h3>Default rate limits</h3>
        <form class="limits-form" data-limits-form>
          <label>Anonymous, per IP<input type="number" name="anonymousPerMinute" min="1" required></label>
          <label>Signed in or token, per user<input type="number" name="authenticatedPerMinute" min="1" required></label>
          <span class="small muted">requests per minute</span>
          <button class="btn" type="submit">Save</button>
        </form>
        <p class="small muted" data-limit-defaults></p>
      </article>
      <div class="acc-filters"><input type="search" data-user-search placeholder="Search users by login, name or email…" aria-label="Search users"></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table"><thead><tr><th>User</th><th>Email</th><th>Last sign-in</th><th class="num">Tokens</th><th>Rate limit (per minute)</th></tr></thead><tbody data-users></tbody></table></div>
    </section>

    <section class="adm-view" id="logs" hidden>
      <div class="adm-vtitle"><h2>Logs &amp; feedback</h2><p>What people ask the assistant and search for, without their identity, and how they rate the answers. Use it to find questions with poor or no results, and export it to evaluate and improve ranking, prompts and models.</p></div>
      <div class="adm-stats" data-log-stats></div>
      <div class="adm-grid adm-even">
        <article class="acc-card"><div class="acc-card-head"><h2>Most common queries</h2></div><ol class="adm-qlist" data-top-queries></ol></article>
        <article class="acc-card"><div class="acc-card-head"><h2>Queries that found nothing</h2></div><ol class="adm-qlist" data-empty-queries></ol></article>
      </div>
      <div class="acc-intro adm-below"><div><h3 class="adm-h3">Chat answers</h3></div><div class="adm-actions"><a class="btn-ghost btn-sm" href="/api/admin/logs/export/chats.csv" download>↓ CSV</a><a class="btn-ghost btn-sm" href="/api/admin/logs/export/chats.jsonl" download>↓ JSONL</a></div></div>
      <div class="acc-filters"><input type="search" data-chatlog-q placeholder="Search questions…" aria-label="Search questions"><select data-chatlog-rating aria-label="Feedback"><option value="">All answers</option><option value="rated">With any feedback</option><option value="bad">👎 Bad</option><option value="good">👍 Good</option><option value="comment">With a comment</option></select></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table adm-logtable"><thead><tr><th>When</th><th>Question</th><th>Answer</th><th>Shown</th><th>Feedback</th></tr></thead><tbody data-chatlog></tbody></table></div>
      <p><button type="button" class="btn-ghost btn-sm" data-chatlog-more hidden>Older</button></p>
      <div class="acc-intro adm-below"><div><h3 class="adm-h3">Searches</h3></div><div class="adm-actions"><a class="btn-ghost btn-sm" href="/api/admin/logs/export/searches.csv" download>↓ CSV</a><a class="btn-ghost btn-sm" href="/api/admin/logs/export/searches.jsonl" download>↓ JSONL</a></div></div>
      <div class="acc-filters"><input type="search" data-searchlog-q placeholder="Search queries…" aria-label="Search queries"><select data-searchlog-source aria-label="Source"><option value="">All sources</option><option value="guided">Guided</option><option value="search">Search bar</option><option value="catalog">Catalog filters</option></select><label class="adm-check"><input type="checkbox" data-searchlog-empty> No results only</label></div>
      <div class="acc-card acc-tablewrap"><table class="acc-table adm-logtable"><thead><tr><th>When</th><th>Source</th><th>Query</th><th>Filters</th><th class="num">Results</th><th>Opened</th></tr></thead><tbody data-searchlog></tbody></table></div>
      <p><button type="button" class="btn-ghost btn-sm" data-searchlog-more hidden>Older</button></p>
    </section>

    <section class="adm-view" id="activity" hidden>
      <div class="adm-vtitle"><h2>Activity log</h2><p>Who signed in or out, created or revoked tokens, submitted or reviewed entries, changed settings, and every data load.</p></div>
      <div class="acc-filters"><input type="search" data-audit-search placeholder="Search loaded activity…" aria-label="Search activity"><select data-audit-action aria-label="Action"><option value="">All actions</option><option value="auth.*">Sign-in &amp; sign-out</option><option value="token.*">Tokens</option><option value="submission.*">Submissions &amp; reviews</option><option value="admin.*">Admin changes</option><option value="catalog.*">Data loads</option></select></div>
      <article class="acc-card" data-audit></article>
      <p><button type="button" class="btn-ghost btn-sm" data-audit-more hidden>Older entries</button></p>
    </section>
    </div>
  </div>
</div>

<dialog class="acc-dialog adm-dialog" data-review-dialog aria-labelledby="review-title">
  <form data-review-form>
    <div class="acc-eyebrow">Submission review</div>
    <h2 id="review-title" data-review-title></h2>
    <div class="adm-details" data-review-details></div>
    <label class="acc-field">Decision<select name="decision"><option value="approved">Approve</option><option value="changes_requested">Request changes</option><option value="rejected">Reject</option><option value="pending">Move back to pending</option></select></label>
    <label class="acc-field">Notes for the contributor<textarea name="notes" rows="4" maxlength="4000" placeholder="Explain your decision or what should change…"></textarea></label>
    <p class="acc-error" data-review-error hidden></p>
    <div class="acc-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn">Save decision</button></div>
  </form>
</dialog>
<div class="acc-toast" role="status" aria-live="polite" data-toast></div>`;
  return page({ title: "Administration", pathname: "/admin/", body, noindex: true, description: `${brand} administration: submissions, catalog, evaluations, users and activity.`, scripts: ["/assets/admin.js"] });
}

function apiDocsPage(section = "api") {
  const mcp = section === "mcp";
  const brand = config.brand || config.name || "Catalog";
  // Examples use this catalog's own best-scored entry and first category, so every request works as written.
  const top = [...catalog].sort(byScore)[0] || { id: "example", name: "Example" };
  const lastRun = runs.length ? runs[runs.length - 1].run.id : "";
  const body = `
<div class="devhub" data-devhub data-brand="${attr(brand)}" data-slug="${attr(brand.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}"
  data-entry="${attr(top.id)}" data-entry-name="${attr(top.acronym || top.name)}" data-topic="${attr((top.tags || [])[0] || "ontology")}"
  data-category="${attr(categories[0]?.id || "")}" data-run="${attr(lastRun)}" data-repo="${attr(config.repository || "")}" data-section="${section}">
  <button class="dh-menu" type="button" data-dh-menu aria-expanded="false">☰ ${mcp ? "MCP docs" : "API docs"}</button>
  <aside class="dh-side" data-dh-side>
    <input class="dh-search" type="search" placeholder="Search documentation…" aria-label="Search documentation" data-dh-search>
    <nav data-dh-nav aria-label="Developer documentation"></nav>
  </aside>
  <div class="dh-main" data-dh-content>
    <noscript><p>The developer documentation needs JavaScript. The API reference is also at <a href="/docs">/docs</a> and <a href="/openapi.json">/openapi.json</a>.</p></noscript>
  </div>
  <aside class="dh-rail" data-dh-rail aria-label="On this page"></aside>
</div>`;
  return mcp
    ? page({ title: "MCP server", pathname: "/mcp-docs/", body, description: `Connect AI assistants to ${brand} with the Model Context Protocol: what MCP is, step-by-step setup for Claude, Cursor, VS Code and Codex, the available tools and troubleshooting.`, scripts: ["/assets/apidocs.js"] })
    : page({ title: "REST API", pathname: "/api-docs/", body, description: `Build on ${brand} with the REST API: quickstart, authentication, rate limits and fair use, every endpoint with a live "Try it", and code in cURL, Python and JavaScript.`, scripts: ["/assets/apidocs.js"] });
}

// ---------- output files ----------
const files = new Map();
// Each output file is produced on demand: the static build renders them all, a server one at a time.
const put = (p, content) => files.set(p, content);

put("index.html", () => homePage());
put("categories/index.html", () => categoriesPage());
for (const c of categories) put(`category/${c.id}/index.html`, () => categoryPage(c));
for (const e of catalog) {
  put(`o/${e.id}/index.html`, () => entryPage(e));
  put(`o/${e.id}/entry.json`, () => JSON.stringify(record(e), null, 2));
}
put("evaluation/index.html", () => evaluationPage());
put("evaluation/rows.html", () => scoreRows().slice(FIRST_SCORE_ROWS).map(scoreRow).join(""));
put("catalog/index.html", () => catalogPage());
put("search/index.html", () => searchPage());
// Entries added or corrected through the submission form (the bot records "submission #<issue>").
function isSubmitted(e) {
  return /^submission/.test(e.provenance?.curatedBy || e.provenance?.curated?.curatedBy || "");
}
const regsOf = (e) => (e.provenance?.registries || []).map((x) => x.registry).filter((v, i, a) => a.indexOf(v) === i).concat(e.provenance?.source === "curated" || e.provenance?.curated ? ["curated"] : []).concat(isSubmitted(e) ? ["submitted"] : []).concat((e.provenance?.registries || []).some((x) => /^Discovered/.test(x.registry || "")) ? ["discovered"] : []).concat(e.provenance?.source === "NeuroSchema catalog" ? ["NeuroSchema"] : []);
put(
  "catalog-index.json", () =>
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
  "search-index.json", () =>
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
put("submit/index.html", () => submitPage());
put("account/index.html", () => accountPage());
put("admin/index.html", () => adminPage());
put("recommend/index.html", () => recommendPage());
put("recommend/guided/index.html", () => recommendGuidedPage());
put("recommend/ask/index.html", () => recommendAskPage());
put("api-docs/index.html", () => apiDocsPage("api"));
put("mcp-docs/index.html", () => apiDocsPage("mcp"));
put("about/index.html", () => aboutPage());
put("contact/index.html", () => contactPage());
put("roadmap/index.html", () => roadmapPage());
put("evaluation/validation/index.html", () => validationPage());
put("404.html", () => notFound());
put("privacy/index.html", () => privacyPage());
put("catalog.json", () => JSON.stringify({ name: "SchemaScope", url: config.url, generatedAt: evaluation.generatedAt || null, run: evaluation.run || null, rubricVersion: RUBRIC_VERSION, categories, entries: catalog.map(record) }, null, 2));
put("catalog.jsonld", () => JSON.stringify(dcat(), null, 2));
put("catalog.schema.json", () => data.catalogSchema);
for (const x of runs) put(`runs/${x.run.id}.json`, () => JSON.stringify(x));
put("runs/index.json", () => JSON.stringify({ runs: [...runs].reverse().map((x) => ({ ...x.run, snapshot: abs(`/runs/${x.run.id}.json`) })) }, null, 2));
put("site.webmanifest", () => JSON.stringify({ name: "SchemaScope", short_name: "SchemaScope", start_url: "/", display: "standalone", background_color: "#faf8f3", theme_color: "#0b1530", icons: [{ src: "/assets/brand/logo-mark.png", sizes: "512x512", type: "image/png" }, { src: "/assets/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] }, null, 2));
const htmlPaths = [...files.keys()].filter((p) => p.endsWith("index.html") && !/^(login|account|admin)\//.test(p)).map((p) => "/" + p.replace(/index\.html$/, ""));
put("sitemap.xml", () => sitemap(htmlPaths));
put("robots.txt", () => `User-agent: *\nAllow: /\nDisallow: /404\n\nSitemap: ${abs("/sitemap.xml")}\n`);

  return { files, evaluatedAt };
}
