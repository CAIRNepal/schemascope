"""Values derived from an entry and its evaluation facts.

Mirrors the helpers in scripts/rubric.mjs (adopters, imports, reusedBy) and scripts/build.mjs
(history points, changes between runs), so the API shows the same numbers the static site did.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

KIND_LABEL = {
    "ontology": "Ontology",
    "schema": "Schema",
    "vocabulary": "Vocabulary",
    "atlas": "Atlas",
    "data-standard": "Data standard",
    "knowledge-base": "Knowledge base",
}
CRIT_LABELS = [
    ("findable", "Findable"),
    ("accessible", "Accessible"),
    ("interoperable", "Interoperable"),
    ("reusable", "Reusable"),
    ("quality", "Quality"),
    ("maintenance", "Maintenance"),
    ("adoption", "Adoption"),
]
METRIC_LABELS = [
    ("consistent", "Logically consistent"),
    ("unsatisfiable", "Unsatisfiable classes"),
    ("owl2dl", "In OWL 2 DL"),
    ("robotErrors", "ROBOT errors"),
    ("robotWarnings", "ROBOT warnings"),
    ("criticalPitfalls", "Critical pitfalls"),
    ("imports", "Imported vocabularies"),
    ("reuse", "Reused by"),
]
# Fewer is better for these metrics.
LOWER_BETTER = {"unsatisfiable", "robotErrors", "robotWarnings", "criticalPitfalls"}
BASIC_VOCABS = {"dc", "dcterms", "owl", "rdf", "rdfs", "xsd", "skos", "oio", "foaf", "swrl"}


def _ok(x: Any) -> dict | None:
    return x if isinstance(x, dict) and not x.get("error") else None


def host_of(url: str | None) -> str:
    try:
        h = urlparse(url or "").hostname
        return (h or url or "").removeprefix("www.")
    except ValueError:
        return url or ""


def _lc(xs) -> list[str]:
    out: list[str] = []
    for x in xs or []:
        s = str(x).lower()
        if s not in out:
            out.append(s)
    return out


def adopters(entry: dict, facts: dict | None) -> list[dict]:
    items = [{**u, "source": "curated"} for u in entry.get("usedBy") or []]
    seen = {host_of(u.get("url")) for u in items}
    for u in ((facts or {}).get("obo") or {}).get("usages") or []:
        user = u.get("user")
        if not user or host_of(user) in seen:
            continue
        seen.add(host_of(user))
        items.append({"name": host_of(user), "url": user, "note": u.get("description"), "source": "OBO Foundry registry"})
    return items


def imports(facts: dict | None) -> list[str]:
    facts = facts or {}
    scan = _ok(facts.get("artefactScan"))
    ids = [
        *((facts.get("ols") or {}).get("importsFrom") or []),
        *((facts.get("bioregistry") or {}).get("dependsOn") or []),
        *[x.get("id") for x in (scan or {}).get("imports") or [] if x.get("id")],
        *((scan or {}).get("uses") or {}).keys(),
    ]
    return [x for x in _lc(ids) if x not in BASIC_VOCABS]


def reused_by(facts: dict | None) -> list[str]:
    facts = facts or {}
    return _lc([
        *((facts.get("dashboard") or {}).get("usedBy") or []),
        *((facts.get("ols") or {}).get("exportsTo") or []),
        *((facts.get("bioregistry") or {}).get("appearsIn") or []),
    ])


def version_label(r: dict | None) -> str | None:
    return ((r or {}).get("evaluatedVersion") or {}).get("label")


def license_of(entry: dict, r: dict | None) -> str | None:
    r = r or {}
    return entry.get("license") or (r.get("obo") or {}).get("license") or (r.get("github") or {}).get("license")


def history_point(run: dict, r: dict) -> dict:
    """One entry's state in one archived run (same fields as build.mjs history)."""
    quality = r.get("quality") if _ok(r.get("quality")) else None
    dash = r.get("dashboard") or {}
    robot = (r.get("quality") or {}).get("robot") or dash.get("robot") or {}
    oops = _ok(r.get("oops"))

    def q(key):
        v = (quality or {}).get(key)
        return v if v is not None else dash.get(key)

    return {
        "runId": run["id"],
        "at": run.get("finishedAt"),
        "score": r.get("score"),
        "grade": r.get("grade"),
        "fair": r.get("fair"),
        "version": version_label(r) or (r.get("ols") or {}).get("version") or (((r.get("github") or {}).get("latestRelease")) or {}).get("tag"),
        "terms": (r.get("ols") or {}).get("terms"),
        "stars": (r.get("github") or {}).get("stars"),
        "license": (r.get("obo") or {}).get("license") or (r.get("github") or {}).get("license"),
        "lastActivity": r.get("lastActivity"),
        "adopters": r.get("adopterCount"),
        "links": {k: l.get("state") for k, l in (r.get("links") or {}).items() if l},
        "archived": bool((r.get("github") or {}).get("archived")),
        "rubric": (run.get("evaluator") or {}).get("rubricVersion"),
        "crit": {k: b.get("score") for k, b in (r.get("breakdown") or {}).items()},
        "penalty": (r.get("penalty") or {}).get("score"),
        "metrics": {
            "consistent": q("consistent"),
            "unsatisfiable": q("unsatisfiable"),
            "owl2dl": q("owl2dl"),
            "robotErrors": robot.get("ERROR"),
            "robotWarnings": robot.get("WARN"),
            "criticalPitfalls": (oops or {}).get("critical"),
            "imports": r.get("importCount"),
            "reuse": r.get("reuseCount"),
        },
    }


def _fmt(v) -> str:
    if v is True:
        return "yes"
    if v is False:
        return "no"
    if v is None:
        return "—"
    return f"{v:,}" if isinstance(v, (int, float)) else str(v)


def changes(history: list[dict]) -> list[dict]:
    """What changed between consecutive runs, oldest first (port of build.mjs changes())."""
    out: list[dict] = []
    for a, b in zip(history, history[1:]):
        def add(what: str):
            out.append({"at": b["at"], "runId": b["runId"], "what": what})

        if a.get("version") != b.get("version") and b.get("version"):
            add(f"Evaluated version: {a.get('version') or '—'} → {b['version']}")
        if a.get("terms") is not None and b.get("terms") is not None and a["terms"] != b["terms"]:
            d = b["terms"] - a["terms"]
            add(f"Terms: {a['terms']:,} → {b['terms']:,} ({'+' if d > 0 else ''}{d:,})")
        if a.get("score") != b.get("score"):
            grade = f" (grade {a.get('grade')} → {b.get('grade')})" if a.get("grade") != b.get("grade") else ""
            rub = f" · rubric v{a.get('rubric')} → v{b.get('rubric')}" if a.get("rubric") != b.get("rubric") else ""
            add(f"Score: {a.get('score')} → {b.get('score')}{grade}{rub}")
        if a.get("license") != b.get("license"):
            add(f"License: {a.get('license') or 'none'} → {b.get('license') or 'none'}")
        if a.get("adopters") is not None and a.get("adopters") != b.get("adopters"):
            add(f"Documented adopters: {a['adopters']} → {b.get('adopters')}")
        for k in sorted(set(a.get("links") or {}) | set(b.get("links") or {})):
            x, y = (a.get("links") or {}).get(k), (b.get("links") or {}).get(k)
            if x != y:
                add(f"{k[:1].upper() + k[1:]} link: {x or '—'} → {y or '—'}")
        if not a.get("archived") and b.get("archived"):
            add("Repository archived")
        for k, label in CRIT_LABELS:
            x, y = (a.get("crit") or {}).get(k), (b.get("crit") or {}).get(k)
            if x is not None and y is not None and x != y:
                add(f"{label}: {x} → {y} ({'+' if y > x else ''}{y - x})")
        if a.get("penalty") is not None and b.get("penalty") is not None and a["penalty"] != b["penalty"]:
            add(f"Penalty: {a['penalty']} → {b['penalty']}")
        for k, label in METRIC_LABELS:
            x, y = (a.get("metrics") or {}).get(k), (b.get("metrics") or {}).get(k)
            if x is not None and y is not None and x != y:
                add(f"{label}: {_fmt(x)} → {_fmt(y)}")
    return out


def registries_of(entry: dict) -> list[str]:
    """Where the catalog record came from (same labels as the site's catalog filters)."""
    p = entry.get("provenance") or {}
    regs = []
    for x in p.get("registries") or []:
        if x.get("registry") and x["registry"] not in regs:
            regs.append(x["registry"])
    if p.get("source") == "curated" or p.get("curated"):
        regs.append("curated")
    curated_by = p.get("curatedBy") or (p.get("curated") or {}).get("curatedBy") or ""
    if curated_by.startswith("submission"):
        regs.append("submitted")
    if any(str(x.get("registry") or "").startswith("Discovered") for x in p.get("registries") or []):
        regs.append("discovered")
    if p.get("source") == "NeuroSchema catalog":
        regs.append("NeuroSchema")
    return regs
