#!/usr/bin/env python3
"""Discover ontologies that no registry lists, by dereferencing candidate namespaces and files.

Candidate channels (each recorded as provenance):
  - prefix.cc        every registered prefix → namespace IRI
  - w3id.org         every permanent-identifier namespace (github.com/perma-id/w3id.org)
  - Zenodo           records with ontology files (.owl/.ttl/.rdf/.jsonld) found by keyword search
  - GitHub           repositories tagged ontology / owl-ontology (needs GITHUB_TOKEN)
  - data/candidates.txt  hand-added URLs, e.g. ontologies found in papers (with the paper DOI)

A candidate is accepted only if its artefact parses as RDF and declares an owl:Ontology (or a
skos:ConceptScheme / voaf:Vocabulary) with a title and at least MIN_TERMS terms. Name, description,
licence, version and imports are read from the artefact itself.

Results are cached in data/sources/discovered.json.gz (probe results, re-probed after 30 days) and
written to data/discovered.json, which scripts/harvest.py merges into the catalog.

  python3 scripts/discover.py [--channels prefixcc,w3id,zenodo,github,candidates] [--max N] [--workers 24]
"""
import argparse
import concurrent.futures as cf
import gzip
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
import logging
logging.getLogger("rdflib").setLevel(logging.CRITICAL)

try:
    import rdflib
    from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS
except ImportError:
    sys.exit("rdflib is required: pip install -r requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "sources" / "discovered.json.gz"
NOW = datetime.now(timezone.utc)
NOWS = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
UA = "schemascope-discovery/1.0 (+https://schemascope.org)"
ACCEPT = "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, application/n-triples;q=0.7, */*;q=0.1"
MAX_BYTES = 25_000_000
MIN_TERMS = 5
VOAF = rdflib.Namespace("http://purl.org/vocommons/voaf#")
VANN = rdflib.Namespace("http://purl.org/vocab/vann/")
SCHEMA = rdflib.Namespace("https://schema.org/")
SCHEMA_HTTP = rdflib.Namespace("http://schema.org/")
CC = rdflib.Namespace("http://creativecommons.org/ns#")
GH = os.environ.get("GITHUB_TOKEN")

ap = argparse.ArgumentParser()
ap.add_argument("--channels", default="prefixcc,w3id,zenodo,github,candidates")
ap.add_argument("--max", type=int, default=0, help="limit candidates per channel (testing)")
ap.add_argument("--workers", type=int, default=24)
ap.add_argument("--recheck-days", type=int, default=30)
args = ap.parse_args()
channels = set(args.channels.split(","))


def http(url, accept="application/json", timeout=60, limit=None, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read(limit + 1 if limit else -1)
        return r.geturl(), r.headers.get("content-type", ""), body


# ---------- candidate channels ----------
def from_prefixcc():
    ctx = json.loads(http("http://prefix.cc/context", "application/ld+json")[2])["@context"]
    return [{"url": ns.rstrip("#"), "channel": "prefix.cc", "hint": p, "via": f"http://prefix.cc/{p}"} for p, ns in ctx.items() if isinstance(ns, str) and ns.startswith("http")]


def from_w3id():
    root = json.loads(http("https://api.github.com/repos/perma-id/w3id.org/git/trees/master", headers={"Authorization": f"Bearer {GH}"} if GH else None)[2])
    sha = next(x["sha"] for x in root["tree"] if x["path"] == "ids")
    tree = json.loads(http(f"https://api.github.com/repos/perma-id/w3id.org/git/trees/{sha}", headers={"Authorization": f"Bearer {GH}"} if GH else None)[2])
    return [{"url": f"https://w3id.org/{x['path']}", "channel": "w3id.org", "hint": x["path"], "via": f"https://github.com/perma-id/w3id.org/tree/master/ids/{x['path']}"} for x in tree["tree"] if x["type"] == "tree"]


def from_zenodo():
    out = []
    for q in ["ontology owl", "ontology turtle", "ontology rdf", "vocabulary skos", "knowledge graph schema ontology"]:
        for page in range(1, 11):
            url = "https://zenodo.org/api/records?" + urllib.parse.urlencode({"q": q, "size": 100, "page": page, "sort": "mostrecent"})
            try:
                hits = json.loads(http(url, timeout=90)[2]).get("hits", {}).get("hits", [])
            except Exception:
                break
            if not hits:
                break
            for h in hits:
                for f in h.get("files", []):
                    key = f.get("key", "")
                    if re.search(r"\.(owl|ttl|rdf|owx|jsonld|n3|nt)$", key, re.I):
                        link = f.get("links", {}).get("self")
                        if link:
                            out.append({"url": link, "channel": "Zenodo", "hint": re.sub(r"\.\w+$", "", key), "via": h.get("links", {}).get("doi") or h.get("links", {}).get("self_html"), "doi": h.get("doi")})
    return out


def from_github():
    if not GH:
        print("  (github channel skipped: set GITHUB_TOKEN)", file=sys.stderr)
        return []
    hdr = {"Authorization": f"Bearer {GH}", "Accept": "application/vnd.github+json"}
    repos = {}
    for topic in ["ontology", "owl-ontology", "ontologies", "owl", "skos", "linked-data-vocabulary", "rdf-vocabulary"]:
        for page in range(1, 11):
            url = "https://api.github.com/search/repositories?" + urllib.parse.urlencode({"q": f"topic:{topic}", "per_page": 100, "page": page, "sort": "stars"})
            try:
                items = json.loads(http(url, headers=hdr)[2]).get("items", [])
            except Exception:
                break
            for it in items:
                repos[it["full_name"]] = it
            if len(items) < 100:
                break
    out = []
    for full, it in repos.items():
        try:
            tree = json.loads(http(f"https://api.github.com/repos/{full}/git/trees/{it['default_branch']}?recursive=1", headers=hdr)[2]).get("tree", [])
        except Exception:
            continue
        files = [t["path"] for t in tree if t["type"] == "blob" and re.search(r"\.(owl|ttl|rdf|owx)$", t["path"], re.I) and not re.search(r"(^|/)(test|tests|example|examples|imports?|catalog|node_modules|docs?)/", t["path"], re.I)]
        files.sort(key=lambda p: (p.count("/"), len(p)))
        for p in files[:2]:
            out.append({"url": f"https://raw.githubusercontent.com/{full}/{it['default_branch']}/{urllib.parse.quote(p)}", "channel": "GitHub", "hint": it["name"], "via": it["html_url"], "repository": it["html_url"], "stars": it.get("stargazers_count")})
    return out


def from_candidates():
    f = DATA / "candidates.txt"
    if not f.exists():
        return []
    out = []
    for line in f.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        out.append({"url": parts[0], "channel": "curated candidate", "hint": parts[1] if len(parts) > 1 else "", "via": parts[2] if len(parts) > 2 else None, "note": parts[3] if len(parts) > 3 else None})
    return out


CHANNELS = {"prefixcc": from_prefixcc, "w3id": from_w3id, "zenodo": from_zenodo, "github": from_github, "candidates": from_candidates}


# ---------- probing ----------
def text(g, s, *preds):
    for p in preds:
        vals = list(g.objects(s, p))
        en = [v for v in vals if isinstance(v, rdflib.Literal) and v.language in ("en", None)]
        for v in en or vals:
            t = re.sub(r"\s+", " ", str(v)).strip()
            if t:
                return t
    return None


def probe(c):
    try:
        final, ctype, body = http(c["url"], ACCEPT, timeout=25, limit=MAX_BYTES)
    except Exception as e:
        return {**c, "ok": False, "reason": f"fetch: {str(e)[:120]}", "checkedAt": NOWS}
    if len(body) > MAX_BYTES:
        return {**c, "ok": False, "reason": "too large", "checkedAt": NOWS, "final": final}
    head = body[:2000].lstrip().lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        return {**c, "ok": False, "reason": "html", "checkedAt": NOWS, "final": final}
    g = rdflib.Graph()
    fmts = []
    ct = ctype.split(";")[0].strip()
    guess = {"text/turtle": "turtle", "application/rdf+xml": "xml", "application/ld+json": "json-ld", "application/n-triples": "nt", "text/n3": "n3", "application/owl+xml": "xml"}.get(ct)
    if guess:
        fmts.append(guess)
    fmts += [f for f in ("turtle", "xml", "json-ld", "nt") if f not in fmts]
    for fmt in fmts:
        try:
            g.parse(data=body, format=fmt, publicID=final)
            if len(g):
                break
        except Exception:
            g = rdflib.Graph()
    if not len(g):
        return {**c, "ok": False, "reason": "not RDF", "checkedAt": NOWS, "final": final}
    onts = list(g.subjects(RDF.type, OWL.Ontology)) or list(g.subjects(RDF.type, VOAF.Vocabulary)) or list(g.subjects(RDF.type, SKOS.ConceptScheme))
    if not onts:
        return {**c, "ok": False, "reason": "no ontology declaration", "checkedAt": NOWS, "final": final}
    # Files often embed other ontologies' declarations (e.g. OWL's own); pick the one this artefact is about.
    STD = ("http://www.w3.org/2002/07/owl", "http://www.w3.org/1999/02/22-rdf-syntax-ns", "http://www.w3.org/2000/01/rdf-schema", "http://www.w3.org/2001/XMLSchema",
           "http://www.w3.org/2004/02/skos/core", "http://purl.org/dc/elements/1.1", "http://purl.org/dc/terms", "http://xmlns.com/foaf/0.1", "http://www.w3.org/ns/prov")
    hint = (c.get("hint") or "").lower()
    def rank(n):
        iri = str(n).rstrip("/#")
        std = any(iri.startswith(x) for x in STD) and not any(c["url"].startswith(x) for x in STD)
        match = bool(hint) and hint in iri.lower()
        same = iri.lower() in (c["url"].rstrip("/#").lower(), final.rstrip("/#").lower())
        return (not std, same, match, len(list(g.predicate_objects(n))))
    o = max(onts, key=rank)
    # Some files merge in OWL/RDF/RDFS and inherit their titles; ignore those standard titles.
    STD_TITLE = re.compile(r"^(the )?(owl 2 schema vocabulary|rdf concepts vocabulary|rdf schema vocabulary|skos vocabulary|dublin core)", re.I)
    titles = [re.sub(r"\s+", " ", str(v)).strip() for p in (DCTERMS.title, DC.title, RDFS.label, SKOS.prefLabel, SCHEMA.name, SCHEMA_HTTP.name) for v in g.objects(o, p)]
    good = [t for t in titles if t and not STD_TITLE.match(t)]
    title, title_from = (good[0], "artefact") if good else (None, None)
    note = c.get("note") or ""
    if not title and c.get("channel") == "curated candidate" and note:
        title, title_from = note.split(":")[0].strip(), "curated candidate note (artefact title unusable)"
    terms = len(set(g.subjects(RDF.type, OWL.Class)) | set(g.subjects(RDF.type, RDFS.Class)) | set(g.subjects(RDF.type, OWL.ObjectProperty)) | set(g.subjects(RDF.type, OWL.DatatypeProperty)) | set(g.subjects(RDF.type, RDF.Property)) | set(g.subjects(RDF.type, SKOS.Concept)))
    if not title or terms < MIN_TERMS:
        return {**c, "ok": False, "reason": "no title" if not title else f"only {terms} terms", "checkedAt": NOWS, "final": final}
    lic = next((str(v) for p in (DCTERMS.license, DC.rights, CC.license, SCHEMA.license, SCHEMA_HTTP.license, DCTERMS.rights) for v in g.objects(o, p)), None)
    return {
        **c, "ok": True, "checkedAt": NOWS, "final": final, "contentType": ct,
        "iri": str(o) if isinstance(o, rdflib.URIRef) else None,
        "title": title[:200],
        "description": ((text(g, o, DCTERMS.description, DC.description, RDFS.comment, SKOS.definition, SCHEMA.description, SCHEMA_HTTP.description) or "") if title_from == "artefact" else (note.split(":", 1)[1].strip() if ":" in note else note) or "")[:1500],
        "license": lic,
        "versionIri": str(next(g.objects(o, OWL.versionIRI), "") or "") or None,
        "versionInfo": next((str(v) for v in g.objects(o, OWL.versionInfo) if re.match(r"^v?\d+(\.\d+)+", str(v).strip())), None) or text(g, o, OWL.versionInfo),
        "titleFrom": title_from,
        "prefix": text(g, o, VANN.preferredNamespacePrefix),
        "namespace": text(g, o, VANN.preferredNamespaceUri),
        "imports": sorted(str(i) for i in g.objects(o, OWL.imports))[:30],
        "creators": sorted({str(v) for v in g.objects(o, DCTERMS.creator)} | {str(v) for v in g.objects(o, DC.creator)})[:10],
        "terms": terms,
        "triples": len(g),
        "format": "OWL" if g.value(o, RDF.type) == OWL.Ontology or list(g.subjects(RDF.type, OWL.Class)) else ("SKOS" if list(g.subjects(RDF.type, SKOS.Concept)) else "RDF"),
    }


# ---------- run ----------
cache = json.loads(gzip.decompress(CACHE.read_bytes())) if CACHE.exists() else {}
cands, seen = [], set()
for name, fn in CHANNELS.items():
    if name not in channels:
        continue
    try:
        got = fn()
    except Exception as e:
        print(f"! {name}: {e}", file=sys.stderr)
        got = []
    if args.max:
        got = got[: args.max]
    new = [c for c in got if c["url"] not in seen]
    seen.update(c["url"] for c in new)
    cands += new
    print(f"  {name}: {len(new)} candidates", file=sys.stderr)

fresh_cut = (NOW - timedelta(days=args.recheck_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
todo = [c for c in cands if not (c["url"] in cache and cache[c["url"]].get("checkedAt", "") >= fresh_cut)]
print(f"Probing {len(todo)} of {len(cands)} candidates ({len(cands) - len(todo)} cached)…", file=sys.stderr)
done = 0
with cf.ThreadPoolExecutor(args.workers) as ex:
    for r in ex.map(probe, todo):
        cache[r["url"]] = r
        done += 1
        if done % 250 == 0:
            print(f"  … {done}/{len(todo)}", file=sys.stderr)
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_bytes(gzip.compress(json.dumps(cache).encode(), mtime=0))
CACHE.parent.mkdir(parents=True, exist_ok=True)
CACHE.write_bytes(gzip.compress(json.dumps(cache).encode(), mtime=0))

# Accepted, de-duplicated by ontology IRI (the same ontology is often reachable from several channels).
accepted, by_iri = [], {}
for c in cands:
    r = cache.get(c["url"])
    if not r or not r.get("ok"):
        continue
    key = (r.get("iri") or r["final"]).rstrip("/#").lower()
    if key in by_iri:
        by_iri[key].setdefault("alsoFoundVia", []).append({"channel": r["channel"], "via": r.get("via"), "url": r["url"]})
        continue
    by_iri[key] = dict(r)
    accepted.append(by_iri[key])
(DATA / "discovered.json").write_text(json.dumps({"generatedAt": NOWS, "channels": sorted(channels), "candidates": len(cands), "accepted": len(accepted), "entries": accepted}, indent=1, ensure_ascii=False) + "\n")
reasons = {}
for c in cands:
    r = cache.get(c["url"], {})
    if not r.get("ok"):
        k = (r.get("reason") or "?").split(":")[0]
        reasons[k] = reasons.get(k, 0) + 1
print(f"Accepted {len(accepted)} ontologies from {len(cands)} candidates → data/discovered.json")
print("  rejected:", ", ".join(f"{k} {v}" for k, v in sorted(reasons.items(), key=lambda x: -x[1])))
