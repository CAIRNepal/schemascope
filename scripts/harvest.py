#!/usr/bin/env python3
"""Harvest every ontology / vocabulary / schema listed by the major registries into data/catalog.json.

Sources (each download is recorded in data/sources.json and archived in data/sources/*.gz):
  - Bioregistry   — entries that are semantic artefacts (have ontology downloads or portal mappings)
  - OBO Foundry   — the OBO registry (domains, status, licences)
  - OLS (EMBL-EBI) and TIB Terminology Service — every loaded ontology
  - LOV (Linked Open Vocabularies) — semantic-web vocabularies (full RDF dump)
  - NeuroSchema   — curated neuroscience catalog (neuroschema.org)

Records are merged across registries (by prefix, registry cross-mappings and namespace), assigned a
primary domain plus secondary domains, and every field keeps provenance: which registry it came from,
the exact URL and when it was retrieved. Curated entries and curated overrides in the catalog win.

  python3 scripts/harvest.py            # harvest all sources and rewrite data/catalog.json
  python3 scripts/harvest.py --offline  # rebuild from the archived raw files in data/sources/
  python3 scripts/harvest.py --only neuroschema[,lov]  # download just these sources; the rest come from data/sources/
"""
import gzip
import hashlib
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "sources"
OFFLINE = "--offline" in sys.argv
_only = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), None) or (sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv[:-1] else None)
LIVE = {k.strip() for k in _only.split(",") if k.strip()} if _only else None
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
UA = "schemascope-harvester/1.0 (+https://schemascope.org)"

SOURCES = {
    "bioregistry": {"name": "Bioregistry", "url": "https://raw.githubusercontent.com/biopragmatics/bioregistry/main/exports/registry/registry.json", "page": "https://bioregistry.io", "license": "CC0-1.0"},
    "obo": {"name": "OBO Foundry", "url": "https://obofoundry.org/registry/ontologies.jsonld", "page": "https://obofoundry.org", "license": "CC0-1.0"},
    "ols": {"name": "OLS (EMBL-EBI)", "url": "https://www.ebi.ac.uk/ols4/api/v2/ontologies?size=1000", "page": "https://www.ebi.ac.uk/ols4", "license": "Apache-2.0 (service); per-ontology licences apply"},
    "tib": {"name": "TIB Terminology Service", "url": "https://api.terminology.tib.eu/api/v2/ontologies?size=1000", "page": "https://terminology.tib.eu", "license": "per-ontology licences apply"},
    "lov": {"name": "Linked Open Vocabularies (LOV)", "url": "https://lov.linkeddata.es/lov.n3.gz", "page": "https://lov.linkeddata.es", "license": "CC-BY-4.0"},
    "neuroschema": {"name": "NeuroSchema", "url": "https://neuroschema.org/catalog.json", "page": "https://neuroschema.org", "license": "CC-BY-4.0"},
}
if LIVE and LIVE - SOURCES.keys():
    sys.exit(f"--only: unknown source(s) {', '.join(sorted(LIVE - SOURCES.keys()))}; choose from {', '.join(SOURCES)}")


def fetch(key):
    """Download a source (or read the archived copy offline); archive it and record provenance."""
    s = SOURCES[key]
    path = RAW / f"{key}{'.n3' if key == 'lov' else '.json'}.gz"
    # With --only, sources not named are read from their archive (downloaded only if there's no archive yet).
    if OFFLINE or (LIVE and key not in LIVE and path.exists()):
        raw = gzip.decompress(path.read_bytes())
        retrieved = json.loads((DATA / "sources.json").read_text())["sources"][key]["retrievedAt"]
    else:
        raw, err = None, None
        for attempt in range(3):
            try:
                req = urllib.request.Request(s["url"], headers={"User-Agent": UA, "Accept": "application/json, */*;q=0.5"})
                raw = urllib.request.urlopen(req, timeout=180).read()
                if s["url"].endswith(".gz"):
                    raw = gzip.decompress(raw)
                break
            except Exception as e:  # flaky registries: back off and retry
                err = e
                time.sleep(5 * (attempt + 1))
        if raw is None:
            if not path.exists():
                print(f"! {s['name']}: download failed ({err}); skipping this source", file=sys.stderr)
                s.update(error=str(err), retrievedAt=None)
                return None
            print(f"! {s['name']}: download failed ({err}); using the archived copy", file=sys.stderr)
            raw = gzip.decompress(path.read_bytes())
            prev = json.loads((DATA / "sources.json").read_text())["sources"].get(key, {}) if (DATA / "sources.json").exists() else {}
            s.update(stale=True, staleReason=str(err))
            retrieved = prev.get("retrievedAt", NOW)
        else:
            retrieved = NOW
            RAW.mkdir(parents=True, exist_ok=True)
            path.write_bytes(gzip.compress(raw, mtime=0))
    s.update(retrievedAt=retrieved, sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw), archive=str(path.relative_to(ROOT)))
    return raw


# ---------- domain classification ----------
OBO_DOMAIN = {
    "agriculture": ["agri"], "anatomy and development": ["life"], "biological systems": ["life"], "chemistry and biochemistry": ["chemistry", "life"],
    "diet, metabolomics, and nutrition": ["agri", "health"], "environment": ["earth"], "health": ["health"], "information": ["metadata"],
    "information technology": ["computing"], "investigations": ["life", "metadata"], "microbiology": ["life"], "organisms": ["life"],
    "phenotype": ["health", "life"], "simulation": ["computing"], "upper": ["foundational"],
}
LOV_TAG = {
    "Methods": "metadata", "Metadata": "metadata", "Industry": "engineering", "IoT": "engineering", "Services": "society", "Support": "metadata",
    "Catalogs": "metadata", "Geography": "earth", "Environment": "earth", "Society": "society", "API": "computing", "RDF": "metadata", "People": "society",
    "Quality": "metadata", "Events": "society", "Vocabularies": "metadata", "General & Upper": "foundational", "Geometry": "earth", "Biology": "life",
    "Multimedia": "humanities", "Time": "metadata", "W3C Rec": "metadata", "Academy": "metadata", "Government": "society", "Tag": "metadata",
    "FRBR": "humanities", "eBusiness": "society", "Food": "agri", "Health": "health", "Transport": "society", "Contracts": "privacy", "Security": "privacy",
    "Travel": "society", "SPAR": "metadata", "PLM": "engineering", "Press": "humanities", "Image": "humanities", "Music": "humanities", "RML": "computing",
    "Games": "humanities", "SSDesk": "metadata", "PROTON": "foundational", "CSV": "computing", "Rec": "metadata", "Water": "earth", "Cultural Heritage": "humanities",
}
# Word patterns over name + keywords (+ description, weighted lower).
WORDS = {
    "foundational": r"upper ontology|top[- ]level|foundational ontology|formal ontology|\bbfo\b|relation ontology|mid-level",
    "metadata": r"metadata|provenance|catalog|dataset|bibliograph|citation|publishing|licen[cs]e|digital librar|document|scholarly|research data|identifier",
    "life": r"\bgene|genom|protein|cell\b|cells\b|cellular|anatom|taxonom|organism|species|biolog|molecular|sequence|microb|zoolog|evolution|bioinformatic|omics",
    "health": r"disease|clinical|medic|patient|health|phenotyp|pathol|drug|pharma|vaccin|symptom|nurs|epidemi|infect|cancer|surgery|adverse event",
    "neuro": r"neuro(?!.{0,20}network)|\bbrain\b|cognitive (neuro)?science|psychiatr|mental (health|disorder|illness)|nervous system|\bneurons?\b|neuroimag|electrophysiolog",
    "chemistry": r"chemi|molecule|reaction|materials?\b|crystal|polymer|spectroscop|nanoparticle|catalys",
    "earth": r"environment|ecolog|earth|geo(graph|log|spatial)|climate|ocean|marine|atmospher|hydrolog|soil|biodivers|weather",
    "agri": r"agricult|plant|crop|food|livestock|farm|forestry|fisher|nutrition|agronom|trait|animal husbandry|wine|dairy",
    "physical": r"physic|astronom|\bunits?\b|measurement|quantit|mathemat|statistic|optic|particle|quantum",
    "engineering": r"engineer|manufactur|industr|building|architecture of buildings|\biot\b|internet of things|energy|device|automotive|robot|smart|product",
    "humanities": r"humanities|cultural|heritage|museum|archive|history|art\b|arts\b|music|linguist|language|literature|religio|media",
    "privacy": r"privacy|gdpr|data protection|personal data|consent|contract|legal|\blaw\b|regulat|complian|polic(y|ies)|cyber|security|threat|vulnerab|attack|access control|trust",
    "society": r"social|society|government|economic|business|commerce|finance|transport|tourism|education|person|people|organi[sz]ation",
    "computing": r"software|computing|computer|algorithm|machine learning|artificial intelligence|programming|data science|web service|workflow|\bapi\b",
}
WORDS = {k: re.compile(v, re.I) for k, v in WORDS.items()}


def classify(text_strong, text_weak, votes):
    for d, rx in WORDS.items():
        if rx.search(text_strong):
            votes[d] += 2
        elif text_weak and rx.search(text_weak):
            votes[d] += 0.6
    return votes


# ---------- helpers ----------
def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def shorten(t, n=560):
    t = clean(t)
    if len(t) <= n:
        return t
    cut = t[:n]
    end = max(cut.rfind(". "), cut.rfind("; "))
    return (cut[: end + 1] if end > 120 else re.sub(r"\s+\S*$", "", cut) + "…").strip()


def url_ok(u):
    return isinstance(u, str) and re.match(r"^https?://\S+$", u.strip() or "") is not None


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:60]


LIC = {"CC-BY-4.0": "CC BY 4.0", "CC-BY-3.0": "CC BY 3.0", "CC0-1.0": "CC0 1.0", "CC-BY-SA-4.0": "CC BY-SA 4.0", "CC-BY-SA-3.0": "CC BY-SA 3.0"}


def lic(v):
    if isinstance(v, dict):
        v = v.get("label") or v.get("url")
    v = clean(v)
    if not v:
        return None
    m = re.search(r"creativecommons\.org/(licenses|publicdomain)/([a-z-]+)/(\d\.\d)", v, re.I)
    if m:
        return ("CC0 " if m.group(2) == "zero" else "CC " + m.group(2).upper().replace("-", " ").replace("BY ", "BY-").replace("BY-SA", "BY-SA").strip() + " ") + m.group(3) if m.group(2) != "zero" else "CC0 1.0"
    return LIC.get(v, v)[:120]


class Rec(dict):
    """A merged record; every set() remembers which registry supplied the field."""

    def put(self, field, value, src, overwrite=False):
        if value in (None, "", [], {}):
            return
        if field in self and not overwrite:
            return
        self[field] = value
        self.setdefault("_fields", {})[field] = src


records, alias = [], {}


def find(*keys):
    for k in keys:
        if k and str(k).lower() in alias:
            return alias[str(k).lower()]
    return None


def niri(u):
    u = str(u or "").strip().lower()
    u = re.sub(r"^https?://(www\.)?", "", u)
    return re.sub(r"[/#]+$", "", u)


def register_iri(r, *iris):
    for u in iris:
        if u and len(niri(u)) > 8:
            alias.setdefault("iri:" + niri(u), r)


def register(r, *keys):
    for k in keys:
        if k:
            alias.setdefault(str(k).lower(), r)


def new(src, src_id, src_url):
    r = Rec()
    r["_sources"] = []
    r["_votes"] = Counter()
    records.append(r)
    return r


def cite(r, key, src_id, url=None):
    r["_sources"].append({"registry": SOURCES[key]["name"], "key": key, "id": src_id, "url": url or SOURCES[key]["url"], "retrievedAt": SOURCES[key]["retrievedAt"]})


# ---------- 1. Bioregistry ----------
br = json.loads(fetch("bioregistry") or b"{}")
SEM = {"ols", "obofoundry", "bioportal", "lov", "agroportal", "ontobee", "aberowl", "tib.ts", "ecoportal", "biodivportal", "bartoc", "fairsharing"}
for prefix, d in br.items():
    m = d.get("mappings") or {}
    is_sem = bool(SEM & set(m)) and (set(m) & (SEM - {"fairsharing"}) or d.get("download_owl") or d.get("download_obo")) or d.get("download_owl") or d.get("download_obo") or d.get("download_rdf")
    if not is_sem:
        continue
    r = new("bioregistry", prefix, None)
    r["id"] = slug(prefix)
    r.put("acronym", d.get("preferred_prefix") or prefix.upper(), "bioregistry")
    r.put("name", clean(d.get("name")), "bioregistry")
    r.put("description", shorten(d.get("description")), "bioregistry")
    for f in ("homepage", "repository"):
        if url_ok(d.get(f)):
            r.put(f, d[f], "bioregistry")
    dl = next((d[k] for k in ("download_owl", "download_rdf", "download_obo", "download_json") if url_ok(d.get(k))), None)
    r.put("download", dl, "bioregistry")
    r.put("formats", [f for k, f in (("download_owl", "OWL"), ("download_obo", "OBO"), ("download_rdf", "RDF"), ("download_json", "JSON")) if d.get(k)], "bioregistry")
    r.put("license", lic(d.get("license")), "bioregistry")
    if m.get("ols"):
        r.put("ols", str(m["ols"]).lower(), "bioregistry")
    if m.get("obofoundry"):
        r.put("obo", str(m["obofoundry"]).lower(), "bioregistry")
    if m.get("bioportal"):
        r.put("bioportal", m["bioportal"], "bioregistry")
    r["bioregistry"] = prefix
    pubs = [{"title": clean(p.get("title")), "doi": p["doi"].replace("https://doi.org/", ""), **({"year": int(p["year"])} if p.get("year") else {})} for p in (d.get("publications") or []) if p.get("doi") and clean(p.get("title"))][:2]
    r.put("publications", pubs, "bioregistry")
    kw = [clean(k).lower() for k in (d.get("keywords") or [])][:8]
    r.put("tags", kw, "bioregistry")
    if d.get("deprecated"):
        r["status"] = "legacy"
    r["_kind"] = "ontology" if (d.get("download_owl") or d.get("download_obo") or m.get("obofoundry") or m.get("ols")) else "vocabulary"
    r["_registry_mappings"] = m
    classify(" ".join([r.get("name", ""), " ".join(kw)]), r.get("description", ""), r["_votes"])
    cite(r, "bioregistry", prefix, f"https://bioregistry.io/api/registry/{prefix}")
    register(r, prefix, m.get("ols"), m.get("obofoundry"), m.get("lov"), m.get("tib.ts"), m.get("bioportal"))
    register_iri(r, (d.get("uri_format") or "").replace("$1", ""), d.get("rdf_uri_format", "").replace("$1", "") if d.get("rdf_uri_format") else None)
    register(r, *(("lov:" + str(m["lov"])) for _ in [0] if m.get("lov")))
    register(r, *(("tib:" + str(m["tib.ts"])) for _ in [0] if m.get("tib.ts")))

# ---------- 2. OBO Foundry ----------
obo = json.loads(fetch("obo") or b'{"ontologies": []}')["ontologies"]
for o in obo:
    r = find(o["id"])
    if r is None:
        r = new("obo", o["id"], None)
        r["id"] = slug(o["id"])
        r["_kind"] = "ontology"
        register(r, o["id"])
    r.put("name", clean(o.get("title")), "obo")
    r.put("description", shorten(o.get("description")), "obo")
    if url_ok(o.get("homepage")):
        r.put("homepage", o["homepage"], "obo")
    if url_ok(o.get("repository")):
        r.put("repository", o["repository"], "obo")
    r.put("download", o.get("ontology_purl") if url_ok(o.get("ontology_purl")) else None, "obo")
    r.put("license", lic(o.get("license")), "obo")
    r.put("obo", o["id"], "obo")
    r.setdefault("formats", ["OWL", "OBO"])
    if o.get("activity_status") in ("inactive", "orphaned", "obsolete"):
        r["status"] = "legacy" if o.get("activity_status") == "obsolete" else r.get("status")
    for dom in OBO_DOMAIN.get(o.get("domain", ""), []):
        r["_votes"][dom] += 4
    cite(r, "obo", o["id"], f"https://obofoundry.org/ontology/{o['id']}.html")

# ---------- 3. OLS + TIB ----------
for key in ("ols", "tib"):
    data = json.loads(fetch(key) or b"{}")
    for o in data.get("elements") or []:
        oid = o.get("ontologyId")
        if not oid:
            continue
        r = find(("tib:" + oid) if key == "tib" else None, oid)
        if r is None:
            r = new(key, oid, None)
            r["id"] = slug(oid)
            r["_kind"] = "ontology"
            register(r, oid)
        title = o.get("title") or o.get("label") or o.get("http://purl.org/dc/terms/title")
        title = title[0] if isinstance(title, list) else title
        desc = o.get("description") or o.get("http://purl.org/dc/terms/abstract")
        desc = desc[0] if isinstance(desc, list) else desc
        r.put("name", clean(title if isinstance(title, str) else ""), key)
        r.put("description", shorten(desc if isinstance(desc, str) else ""), key)
        hp = o.get("homepage")
        if url_ok(hp):
            r.put("homepage", hp, key)
        purl = o.get("ontologyPurl")
        if url_ok(purl):
            r.put("download", purl, key)
        r.put("license", lic(o.get("license") or o.get("http://purl.org/dc/terms/license")), key)
        if key == "ols":
            r.put("ols", oid, "ols")
        register_iri(r, o.get("iri"), o.get("baseUri", [None])[0] if isinstance(o.get("baseUri"), list) and o.get("baseUri") else None)
        r.setdefault("formats", ["OWL"])
        for c in o.get("classifications") or []:
            for v in (c.values() if isinstance(c, dict) else [c]):
                for t in (v if isinstance(v, list) else [v]):
                    classify(str(t), "", r["_votes"])
        cite(r, key, oid, f"{'https://www.ebi.ac.uk/ols4' if key == 'ols' else 'https://terminology.tib.eu/ts'}/ontologies/{oid}")

# ---------- 4. LOV ----------
try:
    import rdflib
except ImportError:
    sys.exit("rdflib is required: pip install -r requirements.txt")
lov_raw = fetch("lov")
g = rdflib.Graph()
if lov_raw:
    g.parse(data=lov_raw.decode("utf8"), format="n3")
VOAF = rdflib.Namespace("http://purl.org/vocommons/voaf#")
VANN = rdflib.Namespace("http://purl.org/vocab/vann/")
DCT = rdflib.Namespace("http://purl.org/dc/terms/")
DCAT = rdflib.Namespace("http://www.w3.org/ns/dcat#")
FOAF = rdflib.Namespace("http://xmlns.com/foaf/0.1/")


def lit(v, p):
    vals = [o for o in g.objects(v, p)]
    en = [o for o in vals if getattr(o, "language", None) in ("en", None)]
    return clean((en or vals or [""])[0])


for v in g.subjects(rdflib.RDF.type, VOAF.Vocabulary):
    prefix = lit(v, VANN.preferredNamespacePrefix)
    ns = lit(v, VANN.preferredNamespaceUri)
    r = find("lov:" + prefix, "iri:" + niri(ns))
    if r is None:
        existing = find(prefix)
        # Same prefix in another registry is only the same resource if the names agree.
        if existing is not None and slug(lit(v, DCT.title))[:12] and slug(existing.get("name", ""))[:12] == slug(lit(v, DCT.title))[:12]:
            r = existing
    if r is None:
        r = new("lov", prefix, None)
        r["id"] = slug(prefix) if find(prefix) is None else slug(prefix + "-lov")
        r["_kind"] = "vocabulary"
        register(r, "lov:" + prefix)
    r.put("acronym", prefix, "lov")
    r.put("name", lit(v, DCT.title), "lov")
    r.put("description", shorten(lit(v, DCT.description)), "lov")
    hp = lit(v, FOAF.homepage)
    if url_ok(hp):
        r.put("homepage", hp, "lov")
    if url_ok(ns):
        r.put("homepage", ns, "lov")
    dists = sorted(str(o) for o in g.objects(v, DCAT.distribution))
    if dists:
        r.put("download", dists[-1], "lov")
    r.put("formats", ["RDF"], "lov")
    tags = sorted({str(o) for o in g.objects(v, DCAT.keyword)})
    if tags:
        r.put("tags", [t.lower() for t in tags], "lov")
    for t in tags:
        if t in LOV_TAG:
            r["_votes"][LOV_TAG[t]] += 4
    stats = {k: int(lit(v, VOAF[k]) or 0) for k in ("reusedByVocabularies", "reusedByDatasets", "occurrencesInDatasets")}
    modified = lit(v, DCT.modified)
    r.setdefault("registryStats", {})["lov"] = {**stats, **({"modified": modified} if modified else {}), "namespace": ns}
    classify(" ".join([r.get("name", ""), " ".join(tags)]), r.get("description", ""), r["_votes"])
    cite(r, "lov", prefix, f"https://lov.linkeddata.es/dataset/lov/vocabs/{prefix}")
    register_iri(r, ns)
    register(r, prefix if find(prefix) is None else None)

# ---------- 5. Discovered (dereferenced artefacts, scripts/discover.py) ----------
disc_path = DATA / "discovered.json"
if disc_path.exists():
    disc = json.loads(disc_path.read_text())
    SOURCES["discovery"] = {"name": "Discovered by dereferencing", "url": "data/discovered.json", "page": "https://schemascope.org/about/#discovery",
                            "license": "metadata read from each artefact", "retrievedAt": disc.get("generatedAt"), "channels": disc.get("channels"),
                            "candidates": disc.get("candidates"), "bytes": disc_path.stat().st_size, "archive": "data/sources/discovered.json.gz"}
    for x in disc.get("entries", []):
        r = find("iri:" + niri(x.get("iri")), "iri:" + niri(x.get("namespace")), "iri:" + niri(x.get("url")), "lov:" + (x.get("prefix") or ""))
        if r is None:
            r = new("discovery", x.get("hint"), None)
            base = x.get("prefix") or x.get("hint") or x["title"]
            r["id"] = slug(base) if find(base) is None else slug(base + "-" + x["channel"].split(".")[0])
            r["_kind"] = "vocabulary" if x.get("format") == "SKOS" else "ontology"
            register(r, r["id"])
        r.put("acronym", x.get("prefix") or (x["hint"] if x["channel"] == "curated candidate" else None), "discovery")
        r.put("name", x["title"], "discovery")
        r.put("description", shorten(x.get("description")), "discovery")
        r.put("download", x["url"] if url_ok(x["url"]) else None, "discovery")
        r.put("homepage", x.get("via") if url_ok(x.get("via")) and x["channel"] in ("GitHub", "curated candidate") else (x.get("iri") if url_ok(x.get("iri")) else None), "discovery")
        r.put("repository", x.get("repository"), "discovery")
        r.put("license", lic(x.get("license")), "discovery")
        r.put("formats", ["OWL" if x.get("format") == "OWL" else "RDF"] + (["SKOS"] if x.get("format") == "SKOS" else []), "discovery")
        if x.get("doi") or (x.get("via") or "").startswith("https://doi.org/"):
            doi = x.get("doi") or x["via"].replace("https://doi.org/", "")
            r.put("publications", [{"title": x["title"], "doi": doi}] if x["channel"] == "Zenodo" else [], "discovery")
        r.setdefault("registryStats", {})["discovery"] = {k: x.get(k) for k in ("terms", "triples", "versionInfo", "versionIri", "titleFrom") if x.get(k)}
        classify(x["title"], x.get("description", ""), r["_votes"])
        r["_sources"].append({"registry": f"Discovered via {x['channel']}", "key": "discovery", "id": x.get("hint"), "url": x.get("via") or x["url"],
                              "artefact": x["url"], "retrievedAt": x.get("checkedAt"),
                              **({"note": x["note"]} if x.get("note") else {}), **({"alsoFoundVia": x["alsoFoundVia"]} if x.get("alsoFoundVia") else {})})
        register_iri(r, x.get("iri"), x.get("namespace"))

# ---------- 6. NeuroSchema (curated neuroscience entries) ----------
ns_cat = json.loads(fetch("neuroschema") or b"{}")
neuro_entries = []
for e in ns_cat.get("entries", []):
    r = find(e["id"], e.get("obo"), e.get("ols"), e.get("bioregistry"))
    curated = {k: v for k, v in e.items() if k in ("id", "acronym", "name", "category", "kind", "description", "formats", "maintainer", "license", "homepage", "repository", "download", "ols", "obo", "bioportal", "status", "publications", "usedBy", "modules", "tools", "tags")}
    if r is None:
        r = new("neuroschema", e["id"], None)
        r["id"] = e["id"]
        r["_kind"] = e.get("kind", "schema")
        r["_neuro_primary"] = True
        register(r, e["id"])
    for k, v in curated.items():
        if k in ("id", "category"):
            continue
        r.put(k, v, "neuroschema", overwrite=k in ("usedBy", "modules", "tools", "description", "kind") and r.get("_neuro_primary"))
    r["_votes"]["neuro"] += 6 if r.get("_neuro_primary") else 3
    cite(r, "neuroschema", e["id"], f"https://neuroschema.org/o/{e['id']}/")

# ---------- merge near-duplicates across registries ----------
from urllib.parse import urlparse
STOP = {"the", "ontology", "vocabulary", "owl", "an", "a", "of", "for", "and"}
def name_key(n):
    return " ".join(w for w in re.sub(r"[^a-z0-9 ]+", " ", n.lower()).split() if w not in STOP)
def hosts(r):
    hs = set()
    for k in ("homepage", "download", "repository"):
        if r.get(k):
            h = urlparse(r[k]).netloc.lower().replace("www.", "")
            if h and h not in ("github.com", "raw.githubusercontent.com", "w3id.org", "purl.org", "zenodo.org", "doi.org"):
                hs.add(h)
    for s_ in r["_sources"]:
        if s_["key"] == "lov":
            pass
    return hs
groups = defaultdict(list)
for r in records:
    if r.get("name"):
        groups[name_key(r["name"])].append(r)
merged_away = set()
for key, rs in groups.items():
    if len(rs) < 2 or not key or re.search(r"\d", key):
        continue
    rs.sort(key=lambda r: -len(r["_sources"]))
    keep = rs[0]
    for other in rs[1:]:
        if not (hosts(keep) & hosts(other)):
            continue
        for f, v in other.items():
            if f.startswith("_") or f in ("id",):
                continue
            if f not in keep or keep.get(f) in (None, "", [], {}):
                keep[f] = v
                keep.setdefault("_fields", {})[f] = other.get("_fields", {}).get(f, "merge")
        keep["_sources"] += other["_sources"]
        keep["_votes"].update(other["_votes"])
        keep.setdefault("_merged_ids", []).append(other["id"])
        merged_away.add(id(other))
records = [r for r in records if id(r) not in merged_away]

# ---------- finalize ----------
categories = {c["id"] for c in json.loads((DATA / "categories.json").read_text())}
# Curated entries and overrides live in data/curated.json (kept across harvests).
CURATED = DATA / "curated.json"
old = {e["id"]: e for e in json.loads(CURATED.read_text())} if CURATED.exists() else {}
out, seen = [], set()
for r in records:
    if not r.get("name"):
        continue
    rid = r["id"] or slug(r["name"])
    while rid in seen:
        rid += "-x"
    seen.add(rid)
    votes = r["_votes"]
    # Strong evidence (registry domains, tags, name) wins; a description-only match still beats "multidisciplinary".
    ranked = [d for d, _ in votes.most_common() if d in categories and votes[d] >= 0.6]
    primary = ("neuro" if r.get("_neuro_primary") else None) or (ranked[0] if ranked else "multidisciplinary")
    secondary = [d for d in ranked if d != primary and votes[d] >= 2][:4]
    srcs = {s["registry"] for s in r["_sources"]}
    desc = r.get("description") or ""
    fields = dict(r.get("_fields", {}))
    if len(desc) < 40:
        desc = f"{r['name']}: {desc.rstrip('.') + '. ' if desc else ''}A {r.get('kind') or r['_kind']} listed in {', '.join(sorted(srcs))}.".replace("..", ".")
        fields["description"] = "generated (registry description missing or too short)"
    e = {
        "id": rid,
        "acronym": r.get("acronym"),
        "name": r["name"][:200],
        "category": primary,
        **({"domains": secondary} if secondary else {}),
        "kind": r.get("kind") or r["_kind"],
        "description": desc[:600],
        "formats": r.get("formats") or [],
        **{k: r[k] for k in ("maintainer", "license", "homepage", "repository", "download", "ols", "obo", "bioportal", "bioregistry", "status", "registryStats") if r.get(k)},
        "publications": r.get("publications") or [],
        "usedBy": r.get("usedBy") or [],
        **{k: r[k] for k in ("modules", "tools") if r.get(k)},
        "tags": (r.get("tags") or [])[:8],
        "provenance": {
            "source": "harvest",
            "retrievedAt": NOW if not OFFLINE else max((s["retrievedAt"] or NOW) for s in r["_sources"]),
            "registries": r["_sources"],
            **({"mergedIds": r["_merged_ids"]} if r.get("_merged_ids") else {}),
            "fields": {k: SOURCES[v]["name"] if v in SOURCES else v for k, v in fields.items()},
        },
    }
    if not e["acronym"]:
        e.pop("acronym")
    elif e["acronym"].islower() and re.match(r"^[a-z0-9_]{2,16}$", e["acronym"]):
        e["acronym"] = e["acronym"].upper()
    # Curated catalog entries and curated overrides win over harvested values.
    prev = old.get(rid)
    if prev and prev.get("provenance", {}).get("source") in ("curated", "Bioregistry", "NeuroSchema catalog"):
        for k in ("category", "domains", "usedBy", "modules", "tools"):
            if prev.get(k):
                e[k] = prev[k]
        for k, v in (prev.get("provenance", {}).get("overrides") or {}).items():
            e[k] = v
        if prev["provenance"].get("overrides"):
            e["provenance"]["overrides"] = prev["provenance"]["overrides"]
            e["provenance"]["overridesNote"] = "curated by SchemaScope, takes precedence over registry values"
    if prev and prev.get("provenance", {}).get("source") in ("curated", "NeuroSchema catalog"):
        for k in ("acronym", "name", "description", "kind", "formats", "license", "homepage", "repository", "download", "tags", "publications"):
            if prev.get(k):
                e[k] = prev[k]
        e["provenance"]["curated"] = {kk: prev["provenance"].get(kk) for kk in ("source", "curatedAt", "curatedBy", "note", "sourcesChecked", "url", "retrievedAt") if prev["provenance"].get(kk)}
    for k in ("ols", "obo"):
        if k in e:
            e[k] = str(e[k]).lower()
            if not re.match(r"^[a-z0-9_]+$", e[k]):
                e.pop(k)
    for k in ("homepage", "repository", "download"):
        if k in e and not url_ok(e[k]):
            e.pop(k)
    if "homepage" not in e and "repository" not in e:
        e["homepage"] = next((s["url"] for s in r["_sources"] if url_ok(s["url"])), None)
    out.append(e)

# Curated entries that no registry lists are kept as they are.
harvested_ids = {e["id"] for e in out}
for oid, e in old.items():
    if oid not in harvested_ids and e.get("provenance", {}).get("source") == "curated":
        out.append(e)

out.sort(key=lambda e: e["id"])
(DATA / "catalog.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
manifest = {"generatedAt": NOW, "offline": OFFLINE, "entries": len(out), "sources": {k: {kk: vv for kk, vv in v.items()} for k, v in SOURCES.items()}}
(DATA / "sources.json").write_text(json.dumps(manifest, indent=2) + "\n")
cats = Counter(e["category"] for e in out)
print(f"Harvested {len(out)} resources from {len(SOURCES)} registries → data/catalog.json")
print("  by domain:", ", ".join(f"{k} {v}" for k, v in cats.most_common()))
print("  sources:", ", ".join(f"{v['name']} ({v.get('bytes', 0) // 1024} KB{', FAILED' if v.get('error') else ', archived copy' if v.get('stale') else ''})" for v in SOURCES.values()))
