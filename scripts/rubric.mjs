// SchemaScope scoring rubric v4 — strict by design: 100 requires excellence on every axis.
// v4 is source-neutral: a check whose only evidence source doesn't cover a resource is "not assessed"
// (left out of the possible points) rather than failed; checks SchemaScope runs itself stay scored.
// Shared by the evaluator (scores) and the site (methodology page).
// F/A/I/R follow the FAIR principles (Wilkinson et al. 2016, doi:10.1038/sdata.2016.18).
// Q measures ontology quality: upper-ontology alignment, logical consistency (reasoner),
// ROBOT quality report and OOPS! pitfalls. M = maintenance, U = adoption, P = inactivity penalty.
// Change weights here and bump RUBRIC_VERSION; `npm run rescore` recomputes from stored facts.

export const RUBRIC_VERSION = "4.1";

export const MACHINE_FORMATS = ["OWL", "OBO", "Turtle", "RDF", "JSON-LD", "LinkML", "JSON Schema", "SHACL", "YAML schema", "XSD"];
export const SEMANTIC_FORMATS = ["OWL", "OBO", "Turtle", "RDF", "JSON-LD", "SHACL"];
export const ONTOLOGY_FORMATS = ["OWL", "OBO", "Turtle", "RDF"];
export const PID_HOSTS = ["purl.obolibrary.org", "purl.org", "w3id.org", "purl.brain-bican.org", "doi.org", "identifiers.org", "purl.bioontology.org", "n2t.net"];
export const UPPER_ONTOLOGIES = ["bfo", "cob", "dolce", "gfo", "gufo", "sumo", "bfo2020"];
export const RELATION_ONTOLOGIES = ["ro"];
export const OPEN_LICENSES = /^(cc[ -]?by|cc0|cc-by|mit|bsd|apache|isc|mpl|lgpl|gpl|odc|pddl|public domain)/i;

const tier = (table, v) => table.find((s) => v >= s.min).pts;
export const T = {
  registries: [{ min: 4, pts: 5 }, { min: 3, pts: 4 }, { min: 2, pts: 3 }, { min: 1, pts: 1 }, { min: 0, pts: 0 }],
  imports: [{ min: 3, pts: 4 }, { min: 1, pts: 2 }, { min: 0, pts: 0 }],
  recency: [{ upTo: 3, pts: 10, label: "≤ 3 months" }, { upTo: 6, pts: 8, label: "≤ 6 months" }, { upTo: 12, pts: 5, label: "≤ 1 year" }, { upTo: 24, pts: 2, label: "≤ 2 years" }, { upTo: Infinity, pts: 0, label: "older / unknown" }],
  cadence: [{ min: 6, pts: 6 }, { min: 4, pts: 5 }, { min: 2, pts: 3 }, { min: 1, pts: 2 }, { min: 0, pts: 0 }],
  adopters: [{ min: 8, pts: 7 }, { min: 5, pts: 5 }, { min: 3, pts: 4 }, { min: 1, pts: 2 }, { min: 0, pts: 0 }],
  reuse: [{ min: 30, pts: 4 }, { min: 10, pts: 3 }, { min: 3, pts: 2 }, { min: 1, pts: 1 }, { min: 0, pts: 0 }],
  stars: [{ min: 500, pts: 5 }, { min: 100, pts: 4 }, { min: 25, pts: 2 }, { min: 5, pts: 1 }, { min: 0, pts: 0 }],
  citations: [{ min: 1000, pts: 5 }, { min: 300, pts: 4 }, { min: 50, pts: 2 }, { min: 10, pts: 1 }, { min: 0, pts: 0 }],
  warnDensity: [{ max: 0.05, pts: 2 }, { max: 0.5, pts: 1 }, { max: Infinity, pts: 0 }],
};

export const RUBRIC = [
  {
    key: "findable", symbol: "F", label: "Findable", fair: true, max: 12,
    formula: "4·[persistent identifier] + r(registries) + 3·[citable reference]",
    how: "F1 — the artefact has a persistent identifier: PURL, w3id or DOI (4). F4 — it is indexed in searchable services; counted across OLS, TIB, BioPortal, OBO Foundry, Bioregistry, FAIRsharing and LOV: ≥ 4 → 5, 3 → 4, 2 → 3, 1 → 1. F2 — a citable reference publication with a DOI (3).",
  },
  {
    key: "accessible", symbol: "A", label: "Accessible", fair: true, max: 12,
    formula: "3·[homepage reachable] + 6·[artefact retrievable over HTTP(S)] + 3·[metadata persists in a registry]",
    how: "A1 — the machine-readable artefact (download PURL or repository) is retrievable over HTTP(S) (6) and the homepage resolves (3). A2 — metadata stays available even if the resource disappears, because it has a persistent record in a registry: OLS, TIB, BioPortal, OBO Foundry, Bioregistry, FAIRsharing or LOV (3). Hosts that refuse automated checks count as reachable.",
  },
  {
    key: "interoperable", symbol: "I", label: "Interoperable", fair: true, max: 12,
    formula: "5·[formal format] + 3·[semantic-web IRIs] + i(imported vocabularies)",
    how: `I1 — a formal, broadly applicable language (${MACHINE_FORMATS.join(", ")}) (5). I2 — a semantic-web representation (${SEMANTIC_FORMATS.join(", ")}) whose terms are resolvable IRIs (3). I3 — qualified references to other vocabularies: ontologies it imports (OLS, Bioregistry, and owl:imports in the file itself) or whose terms it uses (at least 3 distinct terms in the file): ≥ 3 → 4, 1–2 → 2.`,
  },
  {
    key: "reusable", symbol: "R", label: "Reusable", fair: true, max: 12,
    formula: "license(5 open / 2 other) + version(4 in artefact / 2 elsewhere) + max(3·OBO principles pass rate, 2·[in FAIRsharing])",
    how: "R1.1 — a clear license: a recognised open license scores 5, any other stated license 2. R1.2 — provenance of releases: a version IRI or version info inside the artefact scores 4; a release tag or registry version only, 2. R1.3 — meets community standards: the better of the share of OBO Foundry principle checks passed on the OBO Dashboard (× 3) and a listing in FAIRsharing, a standards registry that reviews what it includes (2). LOV is counted under F4 and A2 only, so one listing isn't counted three times.",
  },
  {
    key: "quality", symbol: "Q", label: "Ontology consistency & quality", fair: false, max: 20, ontologyOnly: true,
    formula: "c(logical consistency) + 2·[OWL 2 DL] + u(upper ontology) + q(quality report)",
    how: "Applies to ontologies (OWL/OBO/RDF artefacts). Logical consistency carries half the weight: a reasoner run (ROBOT + ELK, run by SchemaScope on every ontology; the OBO Dashboard's result is used only if ours is missing) that finds the ontology consistent with no unsatisfiable classes scores 10; consistent with 1–5 unsatisfiable classes 5; more than 5 → 2; inconsistent, or the file could not be loaded, 0. OWL 2 DL profile 2. Upper-ontology alignment: imports or uses terms from BFO, COB, DOLCE, GFO or gUFO 3, the Relation Ontology 1 (read from the file as well as OLS and Bioregistry). Quality report: no ROBOT errors 2, warnings per class ≤ 0.05 → 1 (both only for OBO-style ontologies, since the ROBOT report checks OBO conventions), and a pitfall scan with no critical pitfalls 1. A check that could not be run (no retrievable artefact, file too large, tool timed out) is not assessed: its points are left out of the possible total, and the grade is flagged \"Q partially assessed\". Schemas, atlases and other non-ontology resources are not scored on Q; their total is scaled to 100 from the remaining 80 points.",
  },
  {
    key: "maintenance", symbol: "M", label: "Maintenance", fair: false, max: 16,
    formula: "recency(months) + cadence(releases in last 12 months)",
    how: "Recency of the latest commit, release or dated file: ≤ 3 months 10, ≤ 6 months 8, ≤ 1 year 5, ≤ 2 years 2, older 0. Release cadence — distinct releases in the last 12 months (GitHub releases, dated tags, version IRIs across runs): ≥ 6 → 6, ≥ 4 → 5, ≥ 2 → 3, 1 → 2.",
  },
  {
    key: "adoption", symbol: "U", label: "Community adoption", fair: false, max: 16,
    formula: "a(adopting projects) + reuse(ontologies importing it) + max(stars, citations)",
    how: "Documented adopting projects (curated, OBO Foundry usages): ≥ 8 → 7, ≥ 5 → 5, ≥ 3 → 4, ≥ 1 → 2. Reuse — other ontologies that import it (OBO Dashboard, OLS, Bioregistry): ≥ 30 → 4, ≥ 10 → 3, ≥ 3 → 2, ≥ 1 → 1. Community signal, the better of GitHub stars (≥ 500 → 5, ≥ 100 → 4, ≥ 25 → 2, ≥ 5 → 1) and reference-paper citations (≥ 1000 → 5, ≥ 300 → 4, ≥ 50 → 2, ≥ 10 → 1).",
  },
];

export const PENALTY = {
  key: "inactivity", symbol: "P", label: "Penalties (inactivity & inconsistency)",
  perYear: 4, graceYears: 1, timeCap: 20, status: 10, unknown: 5, inconsistent: 20, perCritical: 3, criticalCap: 12, cap: 50, inconsistentCap: 54,
  formula: "min(50, inactivity + 10·[archived/legacy/OBO-inactive] + 20·[inconsistent] + min(12, 3·critical pitfall types)). Inconsistent ontologies are capped at 54 (grade D).",
  how: "Problems are marked down, not just left unrewarded. Inactivity: after a one-year grace period every further year without public activity deducts 4 points (up to 20); archived, legacy or OBO-inactive resources lose a further 10; with no activity evidence at all, 5. Consistency: a logically inconsistent ontology loses 20 and can score no higher than 54 (grade D). Critical pitfalls (OOPS!, e.g. cycles in the class hierarchy, multiple domains/ranges, ambiguous namespace) cost 3 per pitfall type, up to 12. Unsatisfiable classes and ROBOT report errors already cost Q points, so they are not penalised again here. The penalty is capped at 50 and the total never drops below 0.",
};

export const FAIR_MAX = RUBRIC.filter((r) => r.fair).reduce((s, r) => s + r.max, 0);
export const GRADES = [
  { grade: "A", min: 85 },
  { grade: "B", min: 70 },
  { grade: "C", min: 55 },
  { grade: "D", min: 40 },
  { grade: "E", min: 0 },
];

const reachable = (l) => l && (l.state === "ok" || l.state === "blocked");
const monthsSince = (iso) => (Date.now() - new Date(iso).getTime()) / (30.44 * 864e5);
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
const lc = (xs) => [...new Set((xs || []).map((x) => String(x).toLowerCase()))];

export function adopters(entry, facts) {
  const list = (entry.usedBy || []).map((u) => ({ ...u, source: "curated" }));
  const seen = new Set(list.map((u) => hostOf(u.url)));
  for (const u of facts?.obo?.usages || []) {
    if (!u.user || seen.has(hostOf(u.user))) continue;
    seen.add(hostOf(u.user));
    list.push({ name: hostOf(u.user), url: u.user, note: u.description, source: "OBO Foundry registry" });
  }
  return list;
}

// Vocabularies this resource imports / depends on, and ontologies that reuse it.
const BASIC_VOCABS = ["dc", "dcterms", "owl", "rdf", "rdfs", "xsd", "skos", "oio", "foaf", "swrl"];
// Vocabularies an ontology references: imports listed by OLS/Bioregistry, plus (rubric v4.1) what its own file
// declares with owl:imports and whose terms it uses (≥ 3 distinct terms), read by scripts/artefact-scan.mjs.
export function imports(facts) {
  const scan = facts.artefactScan && !facts.artefactScan.error ? facts.artefactScan : null;
  return lc([
    ...(facts.ols?.importsFrom || []),
    ...(facts.bioregistry?.dependsOn || []),
    ...(scan?.imports || []).map((x) => x.id).filter(Boolean),
    ...Object.keys(scan?.uses || {}),
  ]).filter((x) => !BASIC_VOCABS.includes(x));
}
// Where the import evidence came from, for the score explanation.
export function importSources(facts) {
  const scan = facts.artefactScan && !facts.artefactScan.error ? facts.artefactScan : null;
  return [facts.ols?.importsFrom?.length ? "OLS" : null, facts.bioregistry?.dependsOn?.length ? "Bioregistry" : null, scan ? "the file itself" : null].filter(Boolean);
}
export function reusedBy(facts) {
  return lc([...(facts.dashboard?.usedBy || []), ...(facts.ols?.exportsTo || []), ...(facts.bioregistry?.appearsIn || [])]);
}
export function registries(entry, facts) {
  const m = facts.bioregistry?.mappings || {};
  return [
    facts.ols?.terms && !facts.ols.error ? "OLS" : null,
    facts.tib?.terms && !facts.tib.error ? "TIB" : null,
    entry.bioportal || m.bioportal ? "BioPortal" : null,
    facts.obo && !facts.obo.error ? "OBO Foundry" : null,
    facts.bioregistry && !facts.bioregistry.error ? "Bioregistry" : null,
    m.fairsharing ? "FAIRsharing" : null,
    entry.registryStats?.lov || (entry.provenance?.registries || []).some((r) => r.key === "lov") ? "LOV" : null,
  ].filter(Boolean);
}

export function lastActivity(facts) {
  const dates = [facts.github?.pushedAt, facts.github?.latestRelease?.date, facts.ols?.releaseDate, facts.bioportal?.released, facts.links?.download?.lastModified, ...(facts.releases?.dates || []).slice(-1)]
    .filter((d) => d && !Number.isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 864e5)
    .map((d) => new Date(d).toISOString());
  return dates.length ? dates.sort().at(-1) : null;
}

export function evaluatedVersion(facts) {
  const art = facts.artifact || {};
  const c = [
    art.versionIri && { label: art.versionIri.match(/(\d{4}-\d{2}-\d{2}|v?\d+(?:\.\d+)+)/)?.[1] || art.versionIri.match(/\/(v?\d+)\/[^/]+$/)?.[1] || art.versionIri, from: "version IRI in the artefact", value: art.versionIri, inArtefact: true },
    art.versionInfo && { label: art.versionInfo, from: "version info in the artefact", value: art.versionInfo, inArtefact: true },
    facts.ols?.version && { label: String(facts.ols.version), from: "OLS", value: facts.ols.versionIri || String(facts.ols.version) },
    facts.github?.latestRelease?.tag && { label: facts.github.latestRelease.tag, from: "latest GitHub release", value: facts.github.latestRelease.url || facts.github.latestRelease.tag },
    facts.bioportal?.version && { label: facts.bioportal.version, from: "BioPortal", value: facts.bioportal.version },
    facts.git?.headTag && { label: facts.git.headTag, from: "git tag on the evaluated commit", value: facts.git.commit },
    facts.git?.latestTag && { label: `${facts.git.latestTag.name} + commit ${facts.git.commit.slice(0, 7)}`, from: `latest release tag; ${facts.git.ref || "default branch"} evaluated at commit`, value: facts.git.commit, release: facts.git.latestTag.name },
    facts.git?.commit && { label: `commit ${facts.git.commit.slice(0, 7)}`, from: `${facts.git.ref || "default branch"} at evaluation time`, value: facts.git.commit },
    facts.links?.download?.lastModified && { label: `file of ${facts.links.download.lastModified.slice(0, 10)}`, from: "Last-Modified of the download", value: facts.links.download.lastModified },
  ].filter(Boolean);
  return c[0] ? { ...c[0], all: c } : null;
}

const isPid = (url) => !!url && PID_HOSTS.includes(hostOf(url));
export const isOntology = (entry) => (entry.formats || []).some((f) => ONTOLOGY_FORMATS.includes(f)) && ["ontology", "vocabulary"].includes(entry.kind);

// Our ROBOT run next to the OBO Dashboard's, check by check. Scores use ours; this only shows where they differ.
// (The Dashboard usually checks the -base.owl release, so warning counts can differ for that reason alone.)
export function compareWithDashboard(quality, dash) {
  if (!quality || quality.error || quality.consistent === undefined || !dash || dash.error) return null;
  const rows = [
    ["Logically consistent", quality.consistent, dash.consistent],
    ["Unsatisfiable classes", quality.unsatisfiable, dash.unsatisfiable],
    ["In OWL 2 DL", quality.owl2dl, dash.owl2dl],
    ["ROBOT report errors", quality.robot?.ERROR, dash.robot?.ERROR],
    ["ROBOT report warnings", quality.robot?.WARN, dash.robot?.WARN],
  ]
    .filter(([, a, b]) => a != null || b != null)
    .map(([check, ours, dashboard]) => ({ check, ours: ours ?? null, dashboard: dashboard ?? null, differs: ours != null && dashboard != null && ours !== dashboard }));
  return { rows, differences: rows.filter((x) => x.differs).map((x) => x.check), ours: { artefact: quality.artefact || null, checkedAt: quality.checkedAt || null }, dashboard: { artefact: dash.checkedVersion || null, checkedAt: dash.checkedAt || null, page: dash.page || null } };
}

export function scoreEntry(entry, facts) {
  const b = Object.fromEntries(RUBRIC.map((r) => [r.key, { score: 0, max: r.max, steps: [], notes: [] }]));
  const add = (k, label, pts, max, detail) => {
    b[k].steps.push({ label, pts, max, detail });
    b[k].score += pts;
  };
  const { homepage, repository, download } = facts.links;
  const regs = registries(entry, facts);
  const imp = imports(facts);
  const reuse = reusedBy(facts);
  const dash = facts.dashboard && !facts.dashboard.error ? facts.dashboard : null;
  const quality = facts.quality && !facts.quality.error ? facts.quality : null;

  // F
  // An artefact "works" only if the download resolves to the file itself, not to an HTML page.
  const artBroken = !!facts.artifact?.isHtml;
  const pid = isPid(entry.download) ? entry.download : entry.obo ? `http://purl.obolibrary.org/obo/${entry.obo}.owl` : null;
  const pidBroken = pid && pid === entry.download && artBroken;
  add("findable", "Persistent identifier (F1)", pid && !pidBroken ? 4 : 0, 4, !pid ? "no PURL / w3id / DOI for the artefact" : pidBroken ? `${hostOf(pid)} PURL does not resolve to the artefact (redirects to a web page)` : hostOf(pid));
  add("findable", "Indexed in services (F4)", tier(T.registries, regs.length), 5, regs.length ? `${regs.length}: ${regs.join(", ")}` : "not indexed anywhere");
  add("findable", "Citable reference (F2)", entry.publications?.length ? 3 : 0, 3, entry.publications?.length ? `doi:${entry.publications[0].doi}` : "no reference publication listed");

  // A
  add("accessible", "Homepage reachable", reachable(homepage) ? 3 : 0, 3, homepage ? `HTTP ${homepage.code || homepage.error}` : "no homepage listed");
  const dlOk = reachable(download) && !artBroken;
  const repoOk = reachable(repository);
  add("accessible", "Artefact retrievable over HTTP(S) (A1)", dlOk ? 6 : repoOk ? 3 : 0, 6,
    dlOk ? `download HTTP ${download.code}` : download && artBroken ? `download resolves to a web page, not the file${repoOk ? "; repository reachable" : ""}` : repoOk ? "only the source repository is reachable (no direct download)" : download || repository ? "unreachable" : "no download or repository listed");
  const persist = regs; // every service counted under F4 keeps a persistent record
  add("accessible", "Metadata persists in a registry (A2)", persist.length ? 3 : 0, 3, persist.length ? persist.join(", ") : "not in any registry");

  // I
  const fmt = (entry.formats || []).filter((f) => MACHINE_FORMATS.includes(f));
  add("interoperable", "Formal machine-readable format (I1)", fmt.length ? 5 : 0, 5, fmt.length ? fmt.join(", ") : `none of: ${(entry.formats || []).join(", ") || "—"}`);
  const sem = (entry.formats || []).filter((f) => SEMANTIC_FORMATS.includes(f));
  add("interoperable", "Semantic-web IRIs (I2)", sem.length ? 3 : 0, 3, sem.length ? sem.join(", ") : "no RDF/OWL/JSON-LD representation");
  add("interoperable", "References other vocabularies (I3)", tier(T.imports, imp.length), 4, imp.length ? `imports or uses ${imp.length}: ${imp.slice(0, 8).join(", ")}${imp.length > 8 ? "…" : ""} (from ${importSources(facts).join(", ")})` : facts.artefactScan && !facts.artefactScan.error ? "the file imports and uses no other vocabularies" : "no imported vocabularies found (file not read yet)");

  // R
  const license = entry.license || facts.obo?.license || facts.bioregistry?.license || facts.github?.license;
  const open = license && OPEN_LICENSES.test(license);
  add("reusable", "Clear license (R1.1)", license ? (open ? 5 : 2) : 0, 5, license ? `${license}${open ? "" : " (not a recognised open license)"}` : "none found");
  const ver = evaluatedVersion(facts);
  const verPts = ver?.inArtefact ? 4 : ver && (ver.release || ["OLS", "latest GitHub release", "BioPortal", "git tag on the evaluated commit"].includes(ver.from)) ? 2 : 0;
  add("reusable", "Release provenance (R1.2)", verPts, 4, verPts === 4 ? `${ver.label} (${ver.from})` : verPts ? `${ver.release || ver.label} (${ver.release ? "release tag" : ver.from}); not declared inside the artefact` : "no version in artefact, registry or release tags");
  {
    const vals = dash?.checks ? Object.entries(dash.checks).filter(([k]) => /^FP\d/.test(k)).map(([, v]) => v) : [];
    const pass = vals.filter((v) => v === "PASS").length;
    const oboPts = vals.length ? Math.round((3 * pass) / vals.length) : 0;
    const fsPts = regs.includes("FAIRsharing") ? 2 : 0;
    const detail = [vals.length ? `OBO principles: ${pass}/${vals.length} checks pass` : null, fsPts ? "listed in FAIRsharing" : null].filter(Boolean).join("; ");
    add("reusable", "Community standards (R1.3)", Math.max(oboPts, fsPts), 3, detail || "no compliance report (not on the OBO Dashboard) and not listed in FAIRsharing");
  }

  // Q — ontology consistency & quality
  const qApplies = isOntology(entry);
  let qNA = 0; // Q points not assessed
  const cons = quality?.consistent ?? dash?.consistent ?? null; // our own ROBOT run first; the OBO Dashboard only fills a gap
  const unsat = quality?.consistent != null ? quality.unsatisfiable ?? null : dash?.unsatisfiable ?? null;
  if (qApplies) {
    // A check SchemaScope could not run is left out of the possible points ("not assessed"), not scored 0.
    // A run that found problems, or a file ROBOT could not load, still scores (0 where it failed).
    const na = (label, max, detail) => {
      b.quality.steps.push({ label, pts: 0, max: 0, notAssessed: true, outOf: max, detail: `not assessed: ${detail}` });
      qNA += max;
    };
    const oboStyle = !!(entry.obo || dash);
    const reasonErr = quality?.consistent == null ? quality?.reasonError || "" : "";
    const loadFailed = !!reasonErr && !/^timed out/.test(reasonErr); // ROBOT ran but couldn't load/reason over the file
    const consSrc = quality?.consistent != null ? `ROBOT ${quality.reasoner || "ELK"}, run by SchemaScope` : dash?.consistent != null ? "OBO Dashboard" : null;
    if (cons != null || loadFailed) {
      const cPts = cons === true ? (!unsat ? 10 : unsat <= 5 ? 5 : 2) : 0;
      add("quality", "Logical consistency", cPts, 10, cons == null ? `ROBOT could not load or reason over the file (${reasonErr.slice(0, 120)})` : `${cons ? "consistent" : "INCONSISTENT"}, ${unsat ?? 0} unsatisfiable classes (${consSrc})`);
    } else na("Logical consistency", 10, reasonErr ? "the reasoner timed out" : "no reasoner run yet (no retrievable artefact, file too large, or not checked yet)");
    const dl = quality?.owl2dl ?? dash?.owl2dl ?? null;
    if (dl != null || loadFailed) add("quality", "OWL 2 DL profile", dl === true ? 2 : 0, 2, dl == null ? "profile not checked: file could not be loaded" : dl ? "in OWL 2 DL" : "outside OWL 2 DL");
    else na("OWL 2 DL profile", 2, "profile not checked yet");
    const upper = imp.filter((x) => UPPER_ONTOLOGIES.includes(x));
    add("quality", "Upper-ontology alignment", upper.length ? 3 : 0, 3, upper.length ? `imports or uses ${upper.join(", ").toUpperCase()}` : "no BFO/COB/DOLCE/GFO/gUFO import or terms found");
    const rel = imp.filter((x) => RELATION_ONTOLOGIES.includes(x));
    add("quality", "Standard relations (RO)", rel.length ? 1 : 0, 1, rel.length ? "imports or uses RO" : "does not import or use the Relation Ontology");
    const rr = quality?.robot || dash?.robot;
    const classes = quality?.classes || dash?.classes || facts.ols?.terms || 1;
    const dens = rr ? (rr.WARN || 0) / classes : null;
    if (!oboStyle) {
      // The ROBOT report checks OBO conventions; it isn't a fair measure for other ontologies.
      na("ROBOT report: no errors", 2, `not an OBO-style ontology (the report checks OBO conventions)${rr ? `; ${rr.ERROR || 0} errors, for information` : ""}`);
      na("ROBOT report: warning density", 1, "not an OBO-style ontology");
    } else if (rr) {
      add("quality", "ROBOT report: no errors", rr.ERROR ? 0 : 2, 2, `${rr.ERROR || 0} errors`);
      add("quality", "ROBOT report: warning density", dens <= 0.05 ? 1 : 0, 1, `${rr.WARN || 0} warnings / ${classes} classes = ${dens.toFixed(2)}`);
    } else {
      na("ROBOT report: no errors", 2, "no ROBOT report yet");
      na("ROBOT report: warning density", 1, "no ROBOT report yet");
    }
    const oops = facts.oops && !facts.oops.error ? facts.oops : null;
    if (oops) add("quality", "Pitfall scan: no critical pitfalls", oops.critical ? 0 : 1, 1, `${oops.critical} critical, ${oops.important} important, ${oops.minor} minor pitfall types (${oops.engine || "OOPS!"})`);
    else na("Pitfall scan: no critical pitfalls", 1, "no pitfall scan could be run");
    if (qNA) {
      b.quality.partial = true;
      b.quality.fullMax = b.quality.max;
      b.quality.max -= qNA;
    }
  } else {
    b.quality.applicable = false;
    b.quality.steps.push({ label: "Not applicable", pts: 0, max: 0, detail: `${entry.kind} without an OWL/OBO/RDF artefact; total scaled from 80 to 100` });
  }

  // M
  const last = lastActivity(facts);
  const m0 = last ? monthsSince(last) : Infinity;
  const m = Number.isFinite(m0) && m0 >= 0 ? m0 : Infinity; // unparseable or future dates count as no evidence
  const rt = T.recency.find((s) => m <= s.upTo);
  add("maintenance", "Recency", rt.pts, 10, last ? `${last.slice(0, 10)} → ${m.toFixed(1)} months (${rt.label})` : "no activity evidence");
  const nRel = facts.releases?.lastYear ?? 0;
  add("maintenance", "Release cadence (12 months)", tier(T.cadence, nRel), 6, `${nRel} release${nRel === 1 ? "" : "s"}${facts.releases?.from ? ` (${facts.releases.from})` : ""}`);

  // U
  const nAd = adopters(entry, facts).length;
  add("adoption", "Documented adopting projects", tier(T.adopters, nAd), 7, `${nAd} project${nAd === 1 ? "" : "s"}`);
  const lovReuse = entry.registryStats?.lov?.reusedByVocabularies || 0;
  const reuseN = Math.max(reuse.length, lovReuse);
  add("adoption", "Reused by other ontologies", tier(T.reuse, reuseN), 4, reuseN > reuse.length ? `${lovReuse} vocabularies (LOV)` : `${reuse.length}${reuse.length ? `: ${reuse.slice(0, 6).join(", ")}${reuse.length > 6 ? "…" : ""}` : ""}`);
  const stars = facts.github?.stars ?? 0;
  const cites = Math.max(0, ...(facts.citations || []).map((c) => c.count ?? 0));
  const sp = tier(T.stars, stars), cp = tier(T.citations, cites);
  add("adoption", "Community signal", Math.max(sp, cp), 5, `max(stars ${stars} → ${sp}, citations ${cites} → ${cp})`);

  // P
  const inactiveReason = facts.github?.archived ? "repository archived" : entry.status === "legacy" ? "marked legacy" : ["inactive", "orphaned", "obsolete"].includes(facts.obo?.status) ? `${facts.obo.status} in OBO Foundry` : facts.ols?.obsolete ? "marked obsolete in OLS" : null;
  const years = last ? m / 12 : null;
  const pSteps = [];
  let timeP;
  if (years == null) {
    timeP = PENALTY.unknown;
    pSteps.push({ label: "No activity evidence", pts: -timeP, detail: "no commits, releases or dated files found" });
  } else {
    timeP = Math.min(PENALTY.timeCap, Math.round(Math.max(0, years - PENALTY.graceYears) * PENALTY.perYear));
    pSteps.push({ label: "Time since last activity", pts: -timeP, detail: `${years.toFixed(1)} years → ${PENALTY.perYear} × max(0, ${years.toFixed(1)} − ${PENALTY.graceYears})${timeP === PENALTY.timeCap ? " (capped)" : ""}` });
  }
  const statusP = inactiveReason ? PENALTY.status : 0;
  pSteps.push({ label: "Inactive status", pts: -statusP, detail: inactiveReason || "not archived, legacy or inactive" });
  let consP = 0;
  if (qApplies && cons === false) {
    consP = PENALTY.inconsistent;
    pSteps.push({ label: "Logically inconsistent", pts: -consP, detail: "a reasoner found the ontology inconsistent; score capped at 54" });
  } else if (qApplies) pSteps.push({ label: "Consistency", pts: 0, detail: cons === true ? (unsat ? `consistent; ${unsat} unsatisfiable classes are counted under Q, not here` : "consistent, no unsatisfiable classes") : "not yet checked by a reasoner" });
  let pitP = 0;
  if (qApplies) {
    const oopsF = facts.oops && !facts.oops.error ? facts.oops : null;
    if (oopsF?.critical) {
      pitP = Math.min(PENALTY.criticalCap, PENALTY.perCritical * oopsF.critical);
      const codes = (oopsF.pitfalls || []).filter((p) => p.importance === "critical").map((p) => p.code).join(", ");
      pSteps.push({ label: "Critical pitfalls", pts: -pitP, detail: `${oopsF.critical} critical pitfall type${oopsF.critical === 1 ? "" : "s"}${codes ? ` (${codes})` : ""} × ${PENALTY.perCritical}${pitP === PENALTY.criticalCap ? " (capped)" : ""}` });
    }
  }
  const pTotal = Math.min(PENALTY.cap, timeP + statusP + consP + pitP);

  for (const k of Object.keys(b)) b[k].notes.unshift(...b[k].steps.filter((s) => s.max > 0 && s.pts < s.max).map((s) => `${s.label}: ${s.detail}`));
  const earned = Object.entries(b).filter(([k]) => k !== "quality" || qApplies).reduce((s, [, x]) => s + x.score, 0);
  const possible = qApplies ? 100 - qNA : 100 - b.quality.max; // unassessed Q checks are left out, like Q for schemas
  const scaled = Math.round((earned * 100) / possible);
  let score = Math.max(0, scaled - pTotal);
  if (qApplies && cons === false) score = Math.min(score, PENALTY.inconsistentCap);
  const fair = RUBRIC.filter((r) => r.fair).reduce((s, r) => s + b[r.key].score, 0);
  const grade = GRADES.find((g) => score >= g.min).grade;
  return {
    score, gross: scaled, earned, possible, qualityApplies: qApplies, qualityPartial: qApplies && qNA > 0, qualityNotAssessed: qNA,
    penalty: { score: -pTotal, reason: pTotal ? pSteps.filter((x) => x.pts).map((x) => x.detail).join("; ") : `no penalties (active${qApplies && cons === true ? ", consistent" : ""})`, steps: pSteps },
    consistent: qApplies ? cons : null,
    dashboardComparison: qApplies ? compareWithDashboard(quality, dash) : null,
    grade, fair, breakdown: b, lastActivity: last, adopterCount: nAd, reuseCount: reuseN, importCount: imp.length, registries: regs, evaluatedVersion: ver,
  };
}
