#!/usr/bin/env node
// Automated evaluation of every catalog entry, with provenance.
//
// Every run:
//   - fetches fresh facts from each source and records where (`source`) and when (`fetchedAt`) each came from,
//   - archives the full run as data/runs/<run-id>.json (never overwritten, so history is kept),
//   - updates data/evaluation.json, the latest results the site reads.
// If a lookup fails (rate limit, outage), the last good value is carried forward with `stale: true`
// and keeps its original `fetchedAt`, so the site never shows a fact as fresher than it is.
//
// Optional env vars:
//   GITHUB_TOKEN        GitHub API token (unauthenticated limit is 60 requests/hour)
//   BIOPORTAL_API_KEY   adds BioPortal release dates for BioPortal-only entries
//   ONLY=id1,id2        evaluate just these entries (a partial run; other entries keep their last results)
//   NO_ARCHIVE=1        don't write a run snapshot (used for pull-request previews)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RUBRIC_VERSION, scoreEntry } from "./rubric.mjs";
import { root, outData, trackedData, IS_CI } from "./paths.mjs";

export const EVALUATOR_VERSION = "2.0.0";

const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const outFile = path.join(outData, "evaluation.json");
const runsDir = path.join(outData, "runs");
const trackedFile = path.join(trackedData, "evaluation.json");
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").filter(Boolean)) : null;
// Previous results for carry-forward: the newer of the local and the tracked copy.
const readEval = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, "utf8")) : null);
const previous = [await readEval(outFile), await readEval(trackedFile)].filter(Boolean).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] || { entries: {} };

const RDF_ACCEPT = "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, application/owl+xml;q=0.8, text/plain;q=0.5, */*;q=0.1";
const UA = "Mozilla/5.0 (compatible; schemascope-evaluator/1.1; +https://schemascope.org/evaluation/)";
const GH = process.env.GITHUB_TOKEN;
const BP = process.env.BIOPORTAL_API_KEY;
const now = () => new Date().toISOString();
const startedAt = now();
const runId = startedAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

async function get(url, { json = false, headers = {}, timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "follow", signal: ctrl.signal });
    const body = json && res.ok ? await res.json() : (await res.body?.cancel(), null);
    return { code: res.status, ok: res.ok, body, lastModified: res.headers.get("last-modified"), finalUrl: res.url };
  } catch (e) {
    return { code: 0, ok: false, body: null, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ok = reachable; blocked = server refused an automated check (still counts as reachable); dead = gone or erroring.
function linkState(code) {
  if (code >= 200 && code < 400) return "ok";
  if ([401, 403, 405, 406, 429, 999].includes(code)) return "blocked";
  return "dead";
}

async function checkLink(url) {
  if (!url) return null;
  let r = await get(url);
  if (r.code === 0 || r.code >= 500) r = await get(url, { timeout: 40000 }); // one retry for flaky hosts
  const lastModified = r.lastModified && !isNaN(Date.parse(r.lastModified)) ? new Date(r.lastModified).toISOString() : null;
  return {
    url,
    code: r.code,
    state: linkState(r.code),
    ...(r.finalUrl && r.finalUrl !== url ? { resolvedUrl: r.finalUrl } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(r.error ? { error: r.error } : {}),
    checkedAt: now(),
  };
}

const memo = new Map();
const once = (key, fn) => (memo.has(key) ? memo.get(key) : (memo.set(key, fn()), memo.get(key)));

function ghRepo(url) {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

async function github(slug) {
  const source = `https://api.github.com/repos/${slug}`;
  const headers = { Accept: "application/vnd.github+json", ...(GH ? { Authorization: `Bearer ${GH}` } : {}) };
  const repo = await get(source, { json: true, headers });
  if (!repo.ok) return { slug, source, error: `HTTP ${repo.code}`, fetchedAt: now() };
  const d = repo.body;
  const out = {
    slug,
    stars: d.stargazers_count,
    forks: d.forks_count,
    openIssues: d.open_issues_count,
    pushedAt: d.pushed_at,
    archived: d.archived,
    license: d.license && d.license.spdx_id !== "NOASSERTION" ? d.license.spdx_id : null,
  };
  if (GH) {
    const rel = await get(`${source}/releases/latest`, { json: true, headers });
    if (rel.ok) out.latestRelease = { tag: rel.body.tag_name, date: rel.body.published_at, url: rel.body.html_url };
  }
  return { ...out, source, fetchedAt: now() };
}

// OLS (EMBL-EBI). The v2 API has everything the OLS ontology page shows: counts, imports/exports,
// ontology & version IRI, languages, source file timestamp. Falls back to v1.
async function olsLike(base, portal, id) {
  const v2 = `${base}/api/v2/ontologies/${id}`;
  const r2 = await get(v2, { json: true });
  if (r2.ok && r2.body?.ontologyId) {
    const d = r2.body;
    const num = (x) => (x == null || x === "" ? null : Number(x));
    const versionIri = d["http://www.w3.org/2002/07/owl#versionIRI"] || null;
    const versionInfo = [].concat(d["http://www.w3.org/2002/07/owl#versionInfo"] || [])[0] || null;
    const releaseDate = String(versionIri || "").match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    return {
      portal, id, api: "v2",
      title: d.title || null,
      iri: d.iri || null,
      versionIri: typeof versionIri === "string" ? versionIri : versionIri?.value || null,
      version: (typeof versionInfo === "string" ? versionInfo : versionInfo?.value) || releaseDate,
      releaseDate,
      terms: num(d.numberOfClasses),
      properties: num(d.numberOfProperties),
      individuals: num(d.numberOfIndividuals),
      importsFrom: d.importsFrom || [],
      exportsTo: d.exportsTo || [],
      languages: d.language || [],
      loaded: d.loaded || null,
      sourceFileTimestamp: d.sourceFileTimestamp || null,
      obsolete: d.isObsolete === true || d.isObsolete === "true",
      status: "LOADED",
      page: `${base}/ontologies/${id}`,
      source: v2,
      fetchedAt: now(),
    };
  }
  const v1 = `${base}/api/ontologies/${id}`;
  const r = await get(v1, { json: true });
  // OLS answers unknown ids with HTTP 200 and {"status": 404} in the body.
  if (!r.ok || typeof r.body?.status === "number") return { portal, id, source: v1, error: `not found (${r.body?.status ?? r.code})`, fetchedAt: now() };
  const d = r.body;
  const versionIri = d.config?.versionIri || null;
  const releaseDate = versionIri?.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  return {
    portal, id, api: "v1",
    title: d.config?.title || null,
    iri: d.config?.id && /^https?:/.test(d.config.id) ? d.config.id : null,
    versionIri, version: d.config?.version || releaseDate, releaseDate,
    terms: d.numberOfTerms ?? null, properties: d.numberOfProperties ?? null, individuals: d.numberOfIndividuals ?? null,
    importsFrom: [], exportsTo: [], languages: d.languages || [],
    loaded: d.loaded || null, status: d.status,
    page: `${base.replace(/\/api$/, "")}/ontologies/${id}`,
    source: v1, fetchedAt: now(),
  };
}
const ols = (id) => olsLike("https://www.ebi.ac.uk/ols4", "OLS (EMBL-EBI)", id);
const tib = (id) => olsLike("https://service.tib.eu/ts4tib", "TIB Terminology Service", id);

// Bioregistry: cross-registry mappings (OLS, BioPortal, TIB, FAIRsharing, Wikidata…) and reuse links.
async function bioregistry(prefix) {
  const source = `https://bioregistry.io/api/registry/${encodeURIComponent(prefix)}`;
  const r = await get(source, { json: true });
  if (!r.ok || !r.body?.prefix) return { prefix, source, error: `HTTP ${r.code}`, fetchedAt: now() };
  const d = r.body;
  return {
    prefix: d.prefix,
    name: d.name || null,
    mappings: d.mappings || {},
    dependsOn: d.depends_on || [],
    appearsIn: d.appears_in || [],
    license: d.license || null,
    version: d.version || null,
    deprecated: !!d.deprecated,
    page: `https://bioregistry.io/${d.prefix}`,
    source,
    fetchedAt: now(),
  };
}

const OBO_SOURCE = "https://obofoundry.org/registry/ontologies.jsonld";
let oboRegistry;
async function obo(id) {
  oboRegistry ??= get(OBO_SOURCE, { json: true, timeout: 60000 }).then((r) => ({
    ok: r.ok,
    fetchedAt: now(),
    byId: Object.fromEntries((r.body?.ontologies || []).map((o) => [o.id, o])),
  }));
  const reg = await oboRegistry;
  if (!reg.ok) return { id, source: OBO_SOURCE, error: "registry unavailable", fetchedAt: reg.fetchedAt };
  const o = reg.byId[id];
  if (!o) return null;
  return {
    id,
    status: o.activity_status,
    domain: o.domain || null,
    license: o.license?.label || null,
    usages: (o.usages || []).map((u) => ({ user: u.user, type: u.type || null, description: u.description?.trim() || null })),
    source: OBO_SOURCE,
    fetchedAt: reg.fetchedAt,
  };
}

async function bioportal(acronym) {
  if (!BP) return null;
  const base = `https://data.bioontology.org/ontologies/${acronym}`;
  const [sub, met] = await Promise.all([get(`${base}/latest_submission?apikey=${BP}`, { json: true }), get(`${base}/metrics?apikey=${BP}`, { json: true })]);
  if (!sub.ok) return { portal: "BioPortal", acronym, source: `${base}/latest_submission`, error: `HTTP ${sub.code}`, fetchedAt: now() };
  return {
    portal: "BioPortal",
    acronym,
    version: sub.body.version || null,
    released: sub.body.released || null,
    terms: met.ok ? met.body.classes ?? null : null,
    properties: met.ok ? met.body.properties ?? null : null,
    individuals: met.ok ? met.body.individuals ?? null : null,
    maxDepth: met.ok ? met.body.maxDepth ?? null : null,
    page: `https://bioportal.bioontology.org/ontologies/${acronym}`,
    source: `${base}/latest_submission`,
    fetchedAt: now(),
  };
}

async function citations(doi) {
  const source = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const r = await get(source, { json: true, headers: { "User-Agent": "schemascope-evaluator/1.1 (https://schemascope.org)" } });
  return { doi, count: r.ok ? r.body.message["is-referenced-by-count"] ?? null : null, source, fetchedAt: now(), ...(r.ok ? {} : { error: `HTTP ${r.code}` }) };
}

// Exact commit of the default branch at evaluation time, via git's smart-HTTP endpoint (no API quota).
async function gitHead(slug) {
  const source = `https://github.com/${slug}.git/info/refs?service=git-upload-pack`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(source, { headers: { "User-Agent": "git/2.45.0" }, signal: ctrl.signal });
    if (!res.ok) return { source, error: `HTTP ${res.status}`, fetchedAt: now() };
    const text = await res.text();
    const commit = text.match(/([0-9a-f]{40}) HEAD/)?.[1];
    const ref = text.match(/symref=HEAD:(\S+)/)?.[1]?.replace("refs/heads/", "");
    if (!commit) return { source, error: "no HEAD", fetchedAt: now() };
    // Tags: annotated tags appear twice; the peeled "^{}" line carries the commit.
    const tags = new Map();
    for (const m of text.matchAll(/([0-9a-f]{40}) refs\/tags\/([^\s^]+)(\^\{\})?/g)) if (m[3] || !tags.has(m[2])) tags.set(m[2], m[1]);
    const key = (t) => (t.match(/\d+/g) || []).map(Number);
    const cmp = (a, b) => {
      const x = key(a), y = key(b);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
      return 0;
    };
    const releaseLike = [...tags.keys()].filter((t) => /\d/.test(t) && !/(alpha|beta|rc|dev|pre)/i.test(t)).sort(cmp);
    const latest = releaseLike.at(-1);
    const latestTag = latest ? { name: latest, commit: tags.get(latest), url: `https://github.com/${slug}/releases/tag/${latest}` } : null;
    const headTag = [...tags].find(([, sha]) => sha === commit)?.[0] || null;
    const tagDates = [...new Set([...tags.keys()].map((t) => t.match(/(\d{4})-(\d{2})-(\d{2})/)).filter(Boolean).map((m) => `${m[1]}-${m[2]}-${m[3]}`))].sort();
    return { commit, ref, headTag, latestTag, tagCount: tags.size, tagDates, url: `https://github.com/${slug}/tree/${commit}`, source, fetchedAt: now() };
  } catch (e) {
    return { source, error: e.message, fetchedAt: now() };
  } finally {
    clearTimeout(t);
  }
}

// Read the first part of the artefact to find the version it declares about itself.
const SNIFF_BYTES = 262144;
async function sniffArtifact(url) {
  if (!url || /github\.com\/[^/]+\/[^/]+\/(tree|blob)\//.test(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: RDF_ACCEPT, Range: `bytes=0-${SNIFF_BYTES - 1}` }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return { source: url, error: `HTTP ${res.status}`, fetchedAt: now() };
    const reader = res.body.getReader();
    let buf = "", got = 0;
    const dec = new TextDecoder();
    while (got < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      buf += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const pick = (...res) => res.map((r) => buf.match(r)?.[1]).find(Boolean)?.trim() || null;
    // A PURL that redirects to a web page is not a working artefact.
    const ctype = res.headers.get("content-type")?.split(";")[0] || null;
    const head = buf.slice(0, 2000).trimStart().toLowerCase();
    const isHtml = (ctype === "text/html" && !/rdf:rdf|owl:ontology|@prefix|<rdf/.test(head)) || head.startsWith("<!doctype html") || head.startsWith("<html");
    const isRdf = /rdf:rdf|owl:ontology|@prefix|@base|<rdf|prefix\s+\w*:|ontology\(|format-version:|"@context"|^\s*<https?:/m.test(buf.slice(0, 20000)) || /^(id|name|title|classes|slots|\$schema|types):/m.test(buf.slice(0, 5000));
    const versionIri = pick(/owl:versionIRI\s+rdf:resource="([^"]+)"/, /owl:versionIRI\s+<([^>]+)>/, /"versionIRI"\s*:\s*"([^"]+)"/, /versionIRI\s*\(?\s*<([^>]+)>/);
    const versionInfo = pick(/owl:versionInfo[^>]*>([^<]{1,80})</, /owl:versionInfo\s+"([^"]{1,80})"/, /^data-version:\s*(\S+)/m, /^format-version:\s*\S+[\s\S]*?^data-version:\s*(\S+)/m, /^version:\s*["']?([\w.\-]{1,40})/m, /"version"\s*:\s*"([^"]{1,40})"/);
    // Not a lookup failure: the artefact genuinely resolves to a web page. Record it (never carried forward).
    if (isHtml) return { source: res.url || url, isHtml: true, note: `resolves to an HTML page (${res.url || url}), not an ontology/schema file`, fetchedAt: now() };
    return {
      source: res.url || url,
      isRdf,
      ...(versionIri ? { versionIri } : {}),
      ...(versionInfo ? { versionInfo } : {}),
      etag: res.headers.get("etag") || null,
      contentType: res.headers.get("content-type")?.split(";")[0] || null,
      fetchedAt: now(),
    };
  } catch (e) {
    return { source: url, error: e.name === "AbortError" ? "timeout" : e.message, fetchedAt: now() };
  } finally {
    clearTimeout(t);
  }
}

// OBO Dashboard: OBO principle checks, ROBOT report, reasoner consistency, reuse.
const DASH_SOURCE = "https://dashboard.obofoundry.org/dashboard/dashboard-results.json";
let dashData;
async function dashboard(ns) {
  dashData ??= get(DASH_SOURCE, { json: true, timeout: 90000 }).then((r) => ({
    ok: r.ok,
    fetchedAt: now(),
    byNs: Object.fromEntries(((r.body && r.body.ontologies) || []).map((o) => [o.namespace, o])),
  }));
  const d = await dashData;
  if (!d.ok) return { ns, source: DASH_SOURCE, error: "dashboard unavailable", fetchedAt: d.fetchedAt };
  const o = d.byNs[ns];
  if (!o) return null;
  const m = o.metrics || {};
  return {
    ns,
    checks: Object.fromEntries(Object.entries(o.results || {}).map(([k, v]) => [k, v.status])),
    robot: o.results?.["ROBOT Report"]?.results || null,
    consistent: m["Info: Logical consistency"] ?? null,
    unsatisfiable: m["Entities: Number of unsatisfiable classes"] ?? null,
    classes: m["Entities: Number of classes"] ?? null,
    axioms: m["Axioms: Number of axioms"] ?? null,
    owl2dl: m["Info: Does the ontology fall under OWL 2 DL?"] ?? null,
    reusedPct: m["Entities: % of entities reused"] ?? null,
    usedBy: m["Info: Which ontologies use it?"] || [],
    oboScore: m["Info: Experimental OBO score"]?.oboscore ?? null,
    summary: o.summary?.status || null,
    checkedVersion: o.version || null,
    checkedAt: o.date ? new Date(o.date.replace(" ", "T") + "Z").toISOString() : null,
    page: `https://dashboard.obofoundry.org/dashboard/${ns}/dashboard.html`,
    source: DASH_SOURCE,
    fetchedAt: d.fetchedAt,
  };
}

// Quality checks produced by the CI job (scripts/quality.mjs): ROBOT reason/report and OOPS!.
async function qualityFile(id) {
  const f = [path.join(outData, "quality", `${id}.json`), path.join(trackedData, "quality", `${id}.json`)].find(existsSync);
  if (!f) return { quality: null, oops: null };
  const q = JSON.parse(await readFile(f, "utf8"));
  return { quality: q.robot ? { ...q.robot, source: `data/quality/${id}.json` } : null, oops: q.oops ? { ...q.oops, source: `data/quality/${id}.json` } : null };
}

// Release dates in the last 12 months: GitHub releases (with a token), else date-named git tags.
async function releaseDates(slug, git) {
  if (slug && GH) {
    const r = await get(`https://api.github.com/repos/${slug}/releases?per_page=100`, { json: true, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GH}` } });
    if (r.ok && Array.isArray(r.body) && r.body.length) {
      const dates = r.body.filter((x) => !x.draft && !x.prerelease && x.published_at).map((x) => x.published_at).sort();
      return { dates, from: "GitHub releases" };
    }
  }
  if (git?.tagDates?.length) return { dates: git.tagDates, from: "dated git tags" };
  return { dates: [], from: null };
}

// A failed lookup keeps the last good value (with its original fetchedAt) and says why.
function carry(fresh, old) {
  if (!fresh?.error) return fresh;
  if (old && !old.error) return { ...old, stale: true, staleReason: fresh.error, lastAttemptAt: fresh.fetchedAt };
  return fresh;
}

async function evaluate(e) {
  const slug = ghRepo(e.repository);
  // Bioregistry first: its mappings tell us the resource's id in other portals.
  const brPrefix = e.bioregistry || e.obo || e.ols || null;
  const br = brPrefix ? await once(`br:${brPrefix}`, () => bioregistry(brPrefix)) : null;
  const map = br && !br.error ? br.mappings : {};
  const olsId = e.ols || map.ols || null;
  const tibId = map["tib.ts"] || null;
  const bpId = e.bioportal || map.bioportal || null;
  const [homepage, repoLink, download, gh, olsInfo, oboInfo, bp, cites, git, artifact] = await Promise.all([
    checkLink(e.homepage),
    e.repository && e.repository !== e.homepage ? checkLink(e.repository) : null,
    checkLink(e.download),
    slug ? once(`gh:${slug}`, () => github(slug)) : null,
    olsId ? once(`ols:${olsId}`, () => ols(olsId)) : null,
    e.obo ? obo(e.obo) : null,
    bpId ? once(`bp:${bpId}`, () => bioportal(bpId)) : null,
    Promise.all((e.publications || []).map((p) => once(`doi:${p.doi}`, () => citations(p.doi)))),
    slug ? once(`git:${slug}`, () => gitHead(slug)) : null,
    e.download ? once(`art:${e.download}`, () => sniffArtifact(e.download)) : null,
  ]);
  const tibInfo = tibId ? await once(`tib:${tibId}`, () => tib(tibId)) : null;
  const dashNs = e.obo || (map.obofoundry ? String(map.obofoundry).toLowerCase() : null);
  const dash = dashNs ? await dashboard(dashNs) : null;
  const { quality, oops } = await qualityFile(e.id);
  const rel = await once(`rel:${slug || e.id}`, () => releaseDates(slug, git && !git.error ? git : null));
  const yearAgo = Date.now() - 365 * 864e5;
  const relDates = [...new Set([...(rel.dates || []).map((d) => d.slice(0, 10)), olsInfo?.releaseDate].filter(Boolean))].sort();
  const releases = { dates: relDates.slice(-24), lastYear: relDates.filter((d) => Date.parse(d) >= yearAgo).length, from: rel.from || (olsInfo?.releaseDate ? "OLS version IRI" : null) };
  const repository = e.repository && e.repository === e.homepage ? homepage : repoLink;
  const prev = previous.entries[e.id] || {};
  const facts = {
    links: { homepage, repository, download },
    github: carry(gh, prev.github),
    ols: carry(olsInfo, prev.ols),
    obo: carry(oboInfo, prev.obo),
    bioportal: carry(bp, prev.bioportal),
    citations: cites.map((c) => (c.count == null ? carry(c, prev.citations?.find((p) => p.doi === c.doi)) : c)),
    git: carry(git, prev.git),
    tib: carry(tibInfo, prev.tib),
    dashboard: carry(dash, prev.dashboard),
    quality,
    oops,
    releases,
    bioregistry: carry(br, prev.bioregistry),
    artifact: carry(artifact, prev.artifact),
  };
  return { ...facts, ...scoreEntry(e, facts), evaluatedAt: now(), runId };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

const targets = catalog.filter((e) => !only || only.has(e.id));
console.log(`Run ${runId}: evaluating ${targets.length} entries${GH ? "" : " (no GITHUB_TOKEN: skipping release lookups)"}…`);
// Concurrency: 16 with a GitHub token (5,000 requests/hour), 6 without.
const CONCURRENCY = Number(process.env.CONCURRENCY || (GH ? 16 : 6));
let done = 0;
const t0 = Date.now();
const results = await pool(targets, CONCURRENCY, async (e) => {
  const r = await evaluate(e);
  console.log(`  ${String(r.score).padStart(3)} ${r.grade}  ${e.id}`);
  if (++done % 100 === 0 || done === targets.length) {
    const rate = done / ((Date.now() - t0) / 60e3);
    console.error(`▸ ${done}/${targets.length} evaluated (${rate.toFixed(0)}/min, ~${Math.ceil((targets.length - done) / rate)} min left)`);
  }
  return [e.id, r];
});

const run = {
  id: runId,
  startedAt,
  finishedAt: now(),
  scope: only ? "partial" : "full",
  entryCount: results.length,
  trigger: process.env.GITHUB_EVENT_NAME || "local",
  evaluator: { name: "schemascope-evaluator", version: EVALUATOR_VERSION, rubricVersion: RUBRIC_VERSION, node: process.version },
  ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
  ...(process.env.GITHUB_RUN_ID ? { ciRun: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
  authenticated: { github: Boolean(GH), bioportal: Boolean(BP) },
  sources: ["HTTP link checks", "git smart-HTTP refs", DASH_SOURCE, "https://api.github.com", "https://www.ebi.ac.uk/ols4/api/v2", "https://service.tib.eu/ts4tib/api", "https://bioregistry.io/api", OBO_SOURCE, "https://api.crossref.org", ...(BP ? ["https://data.bioontology.org"] : [])],
};
const fresh = Object.fromEntries(results);

// Archive this run (immutable snapshot).
if (!process.env.NO_ARCHIVE) {
  await mkdir(runsDir, { recursive: true });
  await writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify({ run, entries: fresh }) + "\n");
}

// Latest view: this run's results + (for partial runs) the previous results of everything else.
const ids = new Set(catalog.map((e) => e.id));
const kept = only ? Object.fromEntries(Object.entries(previous.entries).filter(([id]) => ids.has(id) && !fresh[id])) : {};
const out = { generatedAt: run.finishedAt, rubricVersion: RUBRIC_VERSION, run, entries: { ...kept, ...fresh } };
await writeFile(outFile, JSON.stringify(out, null, 2) + "\n");

const stale = results.filter(([, r]) => r.github?.stale || r.ols?.stale || r.obo?.stale).map(([id]) => id);
if (stale.length) console.log(`Carried forward last good values for failed lookups: ${stale.join(", ")}`);
console.log(`Wrote ${path.relative(root, outFile)}${process.env.NO_ARCHIVE ? "" : ` and ${path.relative(root, runsDir)}/${runId}.json`}${IS_CI ? "" : " (local preview; tracked results are written only by the Evaluate catalog Action)"}`);
