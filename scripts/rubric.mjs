// SchemaScope scoring rubric v3 — strict by design: 100 requires excellence on every axis.
// Shared by the evaluator (scores) and the site (methodology page).
// F/A/I/R follow the FAIR principles (Wilkinson et al. 2016, doi:10.1038/sdata.2016.18).
// Q measures ontology quality: upper-ontology alignment, logical consistency (reasoner),
// ROBOT quality report and OOPS! pitfalls. M = maintenance, U = adoption, P = inactivity penalty.
// Change weights here and bump RUBRIC_VERSION; `npm run rescore` recomputes from stored facts.

export const RUBRIC_VERSION = "3.4";

export const MACHINE_FORMATS = ["OWL", "OBO", "Turtle", "RDF", "JSON-LD", "LinkML", "JSON Schema", "SHACL", "YAML schema", "XSD"];
export const SEMANTIC_FORMATS = ["OWL", "OBO", "Turtle", "RDF", "JSON-LD", "SHACL"];
export const ONTOLOGY_FORMATS = ["OWL", "OBO", "Turtle", "RDF"];
export const PID_HOSTS = ["purl.obolibrary.org", "purl.org", "w3id.org", "purl.brain-bican.org", "doi.org", "identifiers.org", "purl.bioontology.org", "n2t.net"];
export const UPPER_ONTOLOGIES = ["bfo", "cob", "dolce", "gfo", "sumo", "bfo2020"];
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
    how: "F1 — the artefact has a persistent identifier: PURL, w3id or DOI (4). F4 — it is indexed in searchable services; counted across OLS, TIB, BioPortal, OBO Foundry, Bioregistry and FAIRsharing: ≥ 4 → 5, 3 → 4, 2 → 3, 1 → 1. F2 — a citable reference publication with a DOI (3).",
  },
  {
    key: "accessible", symbol: "A", label: "Accessible", fair: true, max: 12,
    formula: "3·[homepage reachable] + 6·[artefact retrievable over HTTP(S)] + 3·[metadata persists in a registry]",
    how: "A1 — the machine-readable artefact (download PURL or repository) is retrievable over HTTP(S) (6) and the homepage resolves (3). A2 — metadata stays available even if the resource disappears, because it is registered in Bioregistry or the OBO Foundry (3). Hosts that refuse automated checks count as reachable.",
  },
  {
    key: "interoperable", symbol: "I", label: "Interoperable", fair: true, max: 12,
    formula: "5·[formal format] + 3·[semantic-web IRIs] + i(imported vocabularies)",
    how: `I1 — a formal, broadly applicable language (${MACHINE_FORMATS.join(", ")}) (5). I2 — a semantic-web representation (${SEMANTIC_FORMATS.join(", ")}) whose terms are resolvable IRIs (3). I3 — qualified references to other vocabularies, measured by imported ontologies (OLS, Bioregistry): ≥ 3 → 4, 1–2 → 2.`,
  },
  {
    key: "reusable", symbol: "R", label: "Reusable", fair: true, max: 12,
    formula: "license(5 open / 2 other) + version(4 in artefact / 2 elsewhere) + 3·(OBO principles pass rate)",
    how: "R1.1 — a clear license: a recognised open license scores 5, any other stated license 2. R1.2 — provenance of releases: a version IRI or version info inside the artefact scores 4; a release tag or registry version only, 2. R1.3 — meets community standards, measured by the share of OBO Foundry principle checks passed on the OBO Dashboard (× 3). Resources outside the OBO Foundry have no independent compliance report and score 0 here.",
  },
  {
    key: "quality", symbol: "Q", label: "Ontology consistency & quality", fair: false, max: 20, ontologyOnly: true,
    formula: "c(logical consistency) + 2·[OWL 2 DL] + u(upper ontology) + q(quality report)",
    how: "Applies to ontologies (OWL/OBO/RDF artefacts). Logical consistency carries half the weight: a reasoner run (OBO Dashboard, or ROBOT + ELK in our CI) that finds the ontology consistent with no unsatisfiable classes scores 10; consistent with 1–5 unsatisfiable classes 5; more than 5 → 2; inconsistent or never checked 0. OWL 2 DL profile 2. Upper-ontology alignment: imports BFO or COB 3, the Relation Ontology 1. Quality report: no ROBOT errors 2, warnings per class ≤ 0.05 → 1, and a pitfall scan with no critical pitfalls 1 (OOPS! when reachable, otherwise the ROBOT report). Schemas, atlases and other non-ontology resources are not scored on Q; their total is scaled to 100 from the remaining 80 points.",
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
  perYear: 4, graceYears: 1, timeCap: 20, status: 10, unknown: 5, inconsistent: 20, unsat: 5, perCritical: 3, criticalCap: 12, cap: 50, inconsistentCap: 54,
  robotErrors: [{ min: 100, pts: 10 }, { min: 10, pts: 6 }, { min: 1, pts: 3 }, { min: 0, pts: 0 }],
  formula: "min(50, inactivity + 10·[archived/legacy/OBO-inactive] + 20·[inconsistent] + 5·[unsatisfiable classes] + min(12, 3·critical pitfall types) + e(ROBOT errors)). Inconsistent ontologies are capped at 54 (grade D).",
  how: "Problems are marked down, not just left unrewarded. Inactivity: after a one-year grace period every further year without public activity deducts 4 points (up to 20); archived, legacy or OBO-inactive resources lose a further 10; with no activity evidence at all, 5. Consistency: a logically inconsistent ontology loses 20 and can score no higher than 54 (grade D); one with unsatisfiable classes loses 5. Critical pitfalls (OOPS!, e.g. cycles in the class hierarchy, multiple domains/ranges, ambiguous namespace) cost 3 per pitfall type, up to 12. ROBOT report errors cost 3 (1–9), 6 (10–99) or 10 (≥ 100) for OBO-style ontologies (the report checks OBO conventions). The penalty is capped at 50 and the total never drops below 0.",
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
export function imports(facts) {
  return lc([...(facts.ols?.importsFrom || []), ...(facts.bioregistry?.dependsOn || [])]).filter((x) => !["dc", "dcterms", "owl", "rdf", "rdfs", "xsd", "skos", "oio", "foaf"].includes(x));
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
  const persist = regs.filter((x) => ["Bioregistry", "OBO Foundry"].includes(x));
  add("accessible", "Metadata persists in a registry (A2)", persist.length ? 3 : 0, 3, persist.length ? persist.join(", ") : "not in Bioregistry or OBO Foundry");

  // I
  const fmt = (entry.formats || []).filter((f) => MACHINE_FORMATS.includes(f));
  add("interoperable", "Formal machine-readable format (I1)", fmt.length ? 5 : 0, 5, fmt.length ? fmt.join(", ") : `none of: ${(entry.formats || []).join(", ") || "—"}`);
  const sem = (entry.formats || []).filter((f) => SEMANTIC_FORMATS.includes(f));
  add("interoperable", "Semantic-web IRIs (I2)", sem.length ? 3 : 0, 3, sem.length ? sem.join(", ") : "no RDF/OWL/JSON-LD representation");
  add("interoperable", "References other vocabularies (I3)", tier(T.imports, imp.length), 4, imp.length ? `imports ${imp.length}: ${imp.slice(0, 8).join(", ")}${imp.length > 8 ? "…" : ""}` : "no imported vocabularies found");

  // R
  const license = entry.license || facts.obo?.license || facts.bioregistry?.license || facts.github?.license;
  const open = license && OPEN_LICENSES.test(license);
  add("reusable", "Clear license (R1.1)", license ? (open ? 5 : 2) : 0, 5, license ? `${license}${open ? "" : " (not a recognised open license)"}` : "none found");
  const ver = evaluatedVersion(facts);
  const verPts = ver?.inArtefact ? 4 : ver && (ver.release || ["OLS", "latest GitHub release", "BioPortal", "git tag on the evaluated commit"].includes(ver.from)) ? 2 : 0;
  add("reusable", "Release provenance (R1.2)", verPts, 4, verPts === 4 ? `${ver.label} (${ver.from})` : verPts ? `${ver.release || ver.label} (${ver.release ? "release tag" : ver.from}); not declared inside the artefact` : "no version in artefact, registry or release tags");
  if (dash?.checks) {
    const vals = Object.entries(dash.checks).filter(([k]) => /^FP\d/.test(k)).map(([, v]) => v);
    const pass = vals.filter((v) => v === "PASS").length;
    add("reusable", "Community standards (R1.3)", Math.round((3 * pass) / (vals.length || 1)), 3, `OBO principles: ${pass}/${vals.length} checks pass`);
  } else add("reusable", "Community standards (R1.3)", 0, 3, "no independent compliance report (not on the OBO Dashboard)");

  // Q — ontology consistency & quality
  const qApplies = isOntology(entry);
  const cons = dash?.consistent ?? quality?.consistent ?? null;
  const unsat = dash?.unsatisfiable ?? quality?.unsatisfiable ?? null;
  if (qApplies) {
    const consSrc = dash?.consistent != null ? "OBO Dashboard" : quality?.consistent != null ? `ROBOT ${quality.reasoner || "ELK"} in SchemaScope CI` : null;
    const cPts = cons === true ? (!unsat ? 10 : unsat <= 5 ? 5 : 2) : 0;
    add("quality", "Logical consistency", cPts, 10, cons == null ? "never checked by a reasoner" : `${cons ? "consistent" : "INCONSISTENT"}, ${unsat ?? 0} unsatisfiable classes (${consSrc})`);
    const dl = dash?.owl2dl ?? quality?.owl2dl ?? null;
    add("quality", "OWL 2 DL profile", dl === true ? 2 : 0, 2, dl == null ? "profile not checked" : dl ? "in OWL 2 DL" : "outside OWL 2 DL");
    const upper = imp.filter((x) => UPPER_ONTOLOGIES.includes(x));
    add("quality", "Upper-ontology alignment", upper.length ? 3 : 0, 3, upper.length ? `imports ${upper.join(", ").toUpperCase()}` : "no BFO/COB/DOLCE import found");
    const rel = imp.filter((x) => RELATION_ONTOLOGIES.includes(x));
    add("quality", "Standard relations (RO)", rel.length ? 1 : 0, 1, rel.length ? "imports RO" : "does not import the Relation Ontology");
    const rr = dash?.robot || quality?.robot;
    const classes = dash?.classes || quality?.classes || facts.ols?.terms || 1;
    const dens = rr ? (rr.WARN || 0) / classes : null;
    add("quality", "ROBOT report: no errors", rr ? (rr.ERROR ? 0 : 2) : 0, 2, rr ? `${rr.ERROR || 0} errors` : "no ROBOT report available");
    add("quality", "ROBOT report: warning density", rr && dens <= 0.05 ? 1 : 0, 1, rr ? `${rr.WARN || 0} warnings / ${classes} classes = ${dens.toFixed(2)}` : "no ROBOT report available");
    const oops = facts.oops && !facts.oops.error ? facts.oops : null;
    if (oops) add("quality", "Pitfall scan: no critical pitfalls", oops.critical ? 0 : 1, 1, `${oops.critical} critical, ${oops.important} important, ${oops.minor} minor pitfall types (${oops.engine || "OOPS!"})`);
    else add("quality", "Pitfall scan: no critical pitfalls", rr && !rr.ERROR ? 1 : 0, 1, rr ? `no pitfall scan yet; ROBOT report has ${rr.ERROR || 0} errors` : "no pitfall scan or ROBOT report yet");
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
  } else if (qApplies && cons === true && unsat > 0) {
    consP = PENALTY.unsat;
    pSteps.push({ label: "Unsatisfiable classes", pts: -consP, detail: `${unsat} unsatisfiable classes` });
  } else if (qApplies) pSteps.push({ label: "Consistency", pts: 0, detail: cons === true ? "consistent, no unsatisfiable classes" : "not yet checked by a reasoner" });
  let pitP = 0, errP = 0;
  if (qApplies) {
    const oopsF = facts.oops && !facts.oops.error ? facts.oops : null;
    if (oopsF?.critical) {
      pitP = Math.min(PENALTY.criticalCap, PENALTY.perCritical * oopsF.critical);
      const codes = (oopsF.pitfalls || []).filter((p) => p.importance === "critical").map((p) => p.code).join(", ");
      pSteps.push({ label: "Critical pitfalls", pts: -pitP, detail: `${oopsF.critical} critical pitfall type${oopsF.critical === 1 ? "" : "s"}${codes ? ` (${codes})` : ""} × ${PENALTY.perCritical}${pitP === PENALTY.criticalCap ? " (capped)" : ""}` });
    }
    const rrF = (dash?.robot || quality?.robot) ?? null;
    // ROBOT's report checks OBO conventions; only penalise ontologies that are meant to follow them.
    const oboStyle = !!(entry.obo || dash);
    if (rrF?.ERROR && !oboStyle) pSteps.push({ label: "ROBOT report errors", pts: 0, detail: `${rrF.ERROR} errors against OBO conventions; not penalised (not an OBO-style ontology)` });
    if (rrF?.ERROR && oboStyle) {
      errP = PENALTY.robotErrors.find((t) => rrF.ERROR >= t.min).pts;
      pSteps.push({ label: "ROBOT report errors", pts: -errP, detail: `${rrF.ERROR} errors` });
    }
  }
  const pTotal = Math.min(PENALTY.cap, timeP + statusP + consP + pitP + errP);

  for (const k of Object.keys(b)) b[k].notes.unshift(...b[k].steps.filter((s) => s.max > 0 && s.pts < s.max).map((s) => `${s.label}: ${s.detail}`));
  const earned = Object.entries(b).filter(([k]) => k !== "quality" || qApplies).reduce((s, [, x]) => s + x.score, 0);
  const possible = qApplies ? 100 : 100 - b.quality.max;
  const scaled = Math.round((earned * 100) / possible);
  let score = Math.max(0, scaled - pTotal);
  if (qApplies && cons === false) score = Math.min(score, PENALTY.inconsistentCap);
  const fair = RUBRIC.filter((r) => r.fair).reduce((s, r) => s + b[r.key].score, 0);
  const grade = GRADES.find((g) => score >= g.min).grade;
  return {
    score, gross: scaled, earned, possible, qualityApplies: qApplies,
    penalty: { score: -pTotal, reason: pTotal ? pSteps.filter((x) => x.pts).map((x) => x.detail).join("; ") : `no penalties (active${qApplies && cons === true ? ", consistent" : ""})`, steps: pSteps },
    consistent: qApplies ? cons : null,
    grade, fair, breakdown: b, lastActivity: last, adopterCount: nAd, reuseCount: reuseN, importCount: imp.length, registries: regs, evaluatedVersion: ver,
  };
}
