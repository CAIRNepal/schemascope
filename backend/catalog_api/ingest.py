"""Load the catalog, the latest evaluation and archived runs from data/ into SQLite.

    python -m catalog_api.ingest            # incremental: runs already loaded are skipped
    python -m catalog_api.ingest --rebuild  # start from an empty database

Entries, categories and metadata are replaced on every ingest (they are small); run history only grows.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from . import derived
from .settings import DATA_DIR, DB_PATH, LOCAL_DATA_DIR, REPO_ROOT, site_config

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, position INTEGER, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, acronym TEXT, category TEXT NOT NULL, kind TEXT, legacy INTEGER NOT NULL DEFAULT 0,
  score INTEGER, grade TEXT, fair INTEGER, last_activity TEXT, adopters INTEGER NOT NULL DEFAULT 0, version TEXT,
  data TEXT NOT NULL, facts TEXT
);
CREATE INDEX IF NOT EXISTS entries_score ON entries (score DESC);
CREATE INDEX IF NOT EXISTS entries_category ON entries (category);
CREATE TABLE IF NOT EXISTS entry_domains (entry_id TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY (category, entry_id));
CREATE TABLE IF NOT EXISTS entry_formats (entry_id TEXT NOT NULL, format TEXT NOT NULL, PRIMARY KEY (format, entry_id));
CREATE TABLE IF NOT EXISTS entry_registries (entry_id TEXT NOT NULL, registry TEXT NOT NULL, PRIMARY KEY (registry, entry_id));
CREATE TABLE IF NOT EXISTS entry_keys (key TEXT PRIMARY KEY, entry_id TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (
  id UNINDEXED, acronym, name, description, extra, tokenize = 'unicode61 remove_diacritics 2'
);
-- Data files as they are on disk, for the web server's page templates (scripts/site.mjs).
CREATE TABLE IF NOT EXISTS raw (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, entries INTEGER, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (
  entry_id TEXT NOT NULL, run_id TEXT NOT NULL, at TEXT, point TEXT NOT NULL, PRIMARY KEY (entry_id, run_id)
);
"""


def _read(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def _stamp(ev: dict) -> str:
    g, r = str(ev.get("generatedAt") or ""), str(ev.get("rescoredAt") or "")
    return r if r > g else g


def latest_evaluation() -> tuple[dict, str]:
    """The newer of the published evaluation and a local preview (same rule as build.mjs), parsed and as text."""
    found = []
    for f in (DATA_DIR / "evaluation.json", LOCAL_DATA_DIR / "evaluation.json"):
        if f.exists():
            text = f.read_text()
            found.append((json.loads(text), text))
    return max(found, key=lambda x: _stamp(x[0])) if found else ({"entries": {}}, '{"entries": {}}')


def run_files() -> list[Path]:
    files: dict[str, Path] = {}
    for d in (DATA_DIR / "runs", LOCAL_DATA_DIR / "runs"):
        if d.is_dir():
            for f in d.glob("*.json"):
                files[f.name] = f
    return [files[k] for k in sorted(files)]


def rubric_meta() -> dict | None:
    """RUBRIC, PENALTY, GRADES etc. straight from scripts/rubric.mjs, so labels and weights never drift."""
    rubric = REPO_ROOT / "scripts" / "rubric.mjs"
    if not rubric.exists():
        return None
    code = (
        f"import * as r from {json.dumps(rubric.as_uri())};"
        "console.log(JSON.stringify({version: r.RUBRIC_VERSION, rubric: r.RUBRIC, penalty: r.PENALTY,"
        " fairMax: r.FAIR_MAX, grades: r.GRADES}))"
    )
    try:
        out = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True, timeout=60)
        return json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as err:
        print(f"warning: could not read rubric metadata from rubric.mjs ({err}); rubric labels will be missing", file=sys.stderr)
        return None


def domain_graph(catalog: list[dict], categories: list[dict], ev: dict) -> dict:
    """How domains connect (same model as the static site's cross-domain map).

    Edge weight between two domains: resources used in both, plus 0.5 per import link from a resource in one
    to a resource in the other. Node size: resources used in the domain at all (reach).
    """
    domains_of = lambda e: [e["category"], *[d for d in e.get("domains") or [] if d != e["category"]]]  # noqa: E731
    by_key = {str(k).lower(): x for x in catalog for k in (x["id"], x.get("obo"), x.get("ols"), x.get("bioregistry")) if k}
    weights: dict[tuple[str, str], float] = {}

    def bump(a: str, b: str, n: float = 1) -> None:
        if a != b:
            k = tuple(sorted((a, b)))
            weights[k] = weights.get(k, 0) + n

    for e in catalog:
        ds = domains_of(e)
        for i in range(len(ds)):
            for j in range(i + 1, len(ds)):
                bump(ds[i], ds[j])
        for k in ((ev.get(e["id"]) or {}).get("ols") or {}).get("importsFrom") or []:
            f = by_key.get(str(k).lower())
            if f and f["id"] != e["id"]:
                bump(e["category"], f["category"], 0.5)
    reach = {c["id"]: sum(1 for e in catalog if c["id"] in domains_of(e)) for c in categories}
    score = lambda e: (ev.get(e["id"]) or {}).get("score") or 0  # noqa: E731
    bridges = sorted(catalog, key=lambda e: (-len(domains_of(e)), -score(e)))[:7]
    return {
        "nodes": [{"id": c["id"], "name": c["name"], "icon": c.get("icon"), "reach": reach[c["id"]]} for c in categories],
        "edges": sorted(({"a": a, "b": b, "n": n} for (a, b), n in weights.items()), key=lambda x: -x["n"]),
        "bridges": [{"id": e["id"], "acronym": e.get("acronym"), "name": e["name"], "domains": domains_of(e)} for e in bridges],
    }


SITE_JS = REPO_ROOT / "scripts" / "site.mjs"
# Computes every entry's history point for one run file with the templates' own historyPoint().
HISTORY_JS = """
import { readFileSync } from "node:fs";
import { historyPoint } from %s;
const snap = JSON.parse(readFileSync(process.argv[1], "utf8"));
const out = {};
for (const [id, r] of Object.entries(snap.entries || {})) out[id] = historyPoint(snap.run, r);
process.stdout.write(JSON.stringify(out));
"""


def history_points(path: Path, snap: dict, run: dict) -> dict[str, str]:
    """entry id → history point (JSON text). Uses scripts/site.mjs when present so the API and the pages agree
    exactly; otherwise the Python port in derived.py."""
    if SITE_JS.exists():
        try:
            out = subprocess.run(
                ["node", "--input-type=module", "-e", HISTORY_JS % json.dumps(SITE_JS.as_uri()), str(path)],
                capture_output=True, text=True, check=True, timeout=600,
            )
            return {k: json.dumps(v, ensure_ascii=False) for k, v in json.loads(out.stdout).items()}
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as err:
            print(f"warning: history from site.mjs failed for {path.name} ({err}); using the Python port", file=sys.stderr)
    return {eid: json.dumps(derived.history_point(run, r), ensure_ascii=False) for eid, r in (snap.get("entries") or {}).items()}


def ingest(rebuild: bool = False, db_path: Path = DB_PATH) -> dict:
    t0 = time.time()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if rebuild and db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    categories = _read(DATA_DIR / "categories.json") or []
    catalog = _read(DATA_DIR / "catalog.json") or []
    evaluation, evaluation_text = latest_evaluation()
    ev = evaluation.get("entries") or {}
    cat_names = {c["id"]: c["name"] for c in categories}

    with con:
        for table in ("raw", "meta", "categories", "entries", "entry_domains", "entry_formats", "entry_registries", "entry_keys", "entries_fts"):
            con.execute(f"DELETE FROM {table}")
        meta = {
            "site": site_config(),
            "evaluation": {k: evaluation.get(k) for k in ("generatedAt", "rescoredAt", "rubricVersion", "run")},
            "rubric": rubric_meta(),
            "ingestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            # Content pages built from data files (absent in a repository → the page says so or redirects).
            "content:roadmap": _read(DATA_DIR / "roadmap.json"),
            "content:validation": _read(DATA_DIR / "validation" / "report.json"),
        }
        con.executemany("INSERT INTO meta VALUES (?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
        text = lambda f: f.read_text() if f.exists() else "null"  # noqa: E731
        raw = {
            "config": text(REPO_ROOT / "site.config.json"),
            "categories": text(DATA_DIR / "categories.json"),
            "catalog": text(DATA_DIR / "catalog.json"),
            "evaluation": evaluation_text,
            "roadmap": text(DATA_DIR / "roadmap.json"),
            "validation": text(DATA_DIR / "validation" / "report.json"),
            "catalogSchema": json.dumps(text(DATA_DIR / "catalog.schema.json")),
        }
        con.executemany("INSERT INTO raw VALUES (?, ?)", list(raw.items()))
        con.executemany("INSERT INTO categories VALUES (?, ?, ?)", [(c["id"], i, json.dumps(c)) for i, c in enumerate(categories)])

        for e in catalog:
            r = ev.get(e["id"])
            domains = [e["category"], *[d for d in e.get("domains") or [] if d != e["category"]]]
            con.execute(
                "INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    e["id"], e["name"], e.get("acronym"), e["category"], e.get("kind"), int(e.get("status") == "legacy"),
                    (r or {}).get("score"), (r or {}).get("grade"), (r or {}).get("fair"), (r or {}).get("lastActivity"),
                    (r or {}).get("adopterCount") if (r or {}).get("adopterCount") is not None else len(e.get("usedBy") or []),
                    derived.version_label(r), json.dumps(e), json.dumps(r) if r else None,
                ),
            )
            con.executemany("INSERT OR IGNORE INTO entry_domains VALUES (?, ?)", [(e["id"], d) for d in domains])
            con.executemany("INSERT OR IGNORE INTO entry_formats VALUES (?, ?)", [(e["id"], f) for f in e.get("formats") or []])
            con.executemany("INSERT OR IGNORE INTO entry_registries VALUES (?, ?)", [(e["id"], g) for g in derived.registries_of(e)])
            # Other identifiers (OBO, OLS, Bioregistry prefixes) resolve to the entry, for import/reuse links.
            keys = {str(k).lower() for k in (e["id"], e.get("obo"), e.get("ols"), e.get("bioregistry")) if k}
            con.executemany("INSERT OR IGNORE INTO entry_keys VALUES (?, ?)", [(k, e["id"]) for k in keys])
            extra = " ".join([
                e.get("maintainer") or "", *(e.get("tags") or []), *(e.get("species") or []), *(e.get("formats") or []),
                *(m.get("name", "") for m in e.get("modules") or []), *(cat_names.get(d, "") for d in domains),
            ])
            con.execute("INSERT INTO entries_fts VALUES (?, ?, ?, ?, ?)", (e["id"], e.get("acronym") or "", e["name"], e.get("description") or "", extra))

        con.execute("INSERT INTO meta VALUES (?, ?)", ("domainGraph", json.dumps(domain_graph(catalog, categories, ev))))

    known = {row[0] for row in con.execute("SELECT id FROM runs")}
    added = 0
    for f in run_files():
        if f.stem in known:
            continue
        snap = json.loads(f.read_text())
        run = snap.get("run") or {}
        run_id = run.get("id") or f.stem
        entries = snap.get("entries") or {}
        with con:
            con.execute(
                "INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?)",
                (run_id, run.get("startedAt"), run.get("finishedAt"), len(entries), json.dumps(run)),
            )
            points = history_points(f, snap, {**run, "id": run_id})
            con.executemany(
                "INSERT OR REPLACE INTO history VALUES (?, ?, ?, ?)",
                [(eid, run_id, run.get("finishedAt"), point) for eid, point in points.items()],
            )
        added += 1
        print(f"  loaded run {run_id} ({len(entries)} entries)")

    con.execute("INSERT INTO entries_fts(entries_fts) VALUES ('optimize')")
    con.commit()
    total_runs = con.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    con.close()
    summary = {"entries": len(catalog), "categories": len(categories), "runsAdded": added, "runs": total_runs, "seconds": round(time.time() - t0, 1), "db": str(db_path)}
    print(f"Ingested {summary['entries']} entries, {summary['categories']} categories, {added} new run(s) ({total_runs} total) into {db_path} in {summary['seconds']}s")
    return summary


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--rebuild", action="store_true", help="delete the database first and reload every run")
    ingest(rebuild=p.parse_args().rebuild)


if __name__ == "__main__":
    main()
