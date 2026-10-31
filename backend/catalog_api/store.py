"""Read-only queries over the ingested catalog. Used by both the HTTP API and the MCP tools."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from functools import lru_cache
from typing import Any, Literal

from . import derived
from .settings import DB_PATH

SortKey = Literal["relevance", "score", "name", "fair", "activity", "adopters"]
SORTS = {
    "score": "e.score IS NULL, e.score DESC, e.name COLLATE NOCASE",
    "name": "COALESCE(e.acronym, e.name) COLLATE NOCASE",
    "fair": "e.fair IS NULL, e.fair DESC, e.name COLLATE NOCASE",
    "activity": "e.last_activity IS NULL, e.last_activity DESC",
    "adopters": "e.adopters DESC, e.score IS NULL, e.score DESC",
}
MAX_PAGE_SIZE = 100


class NotIngested(RuntimeError):
    pass


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise NotIngested(f"No database at {DB_PATH}. Run `python -m catalog_api.ingest` first.")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


_local = threading.local()


def db() -> sqlite3.Connection:
    """A read-only connection per worker thread (a connection must not be shared by concurrent requests).
    The API never writes; a re-ingest is picked up by the next query."""
    con = getattr(_local, "con", None)
    if con is None:
        con = _local.con = connect()
    return con


def _generation() -> int:
    """Changes whenever the database is re-ingested, so cached lookups refresh without a restart."""
    try:
        return DB_PATH.stat().st_mtime_ns
    except FileNotFoundError:
        raise NotIngested(f"No database at {DB_PATH}. Run `python -m catalog_api.ingest` first.") from None


@lru_cache(maxsize=2)
def _meta_at(_gen: int) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in db().execute("SELECT key, value FROM meta")}


@lru_cache(maxsize=2)
def _categories_at(_gen: int) -> dict[str, dict]:
    return {r["id"]: json.loads(r["data"]) for r in db().execute("SELECT id, data FROM categories ORDER BY position")}


def _meta() -> dict:
    return _meta_at(_generation())


def _categories() -> dict[str, dict]:
    return _categories_at(_generation())


CONTENT = ("roadmap", "validation")


def content(name: str) -> Any:
    """A content document loaded from data/ (roadmap, rubric validation report), or None if this catalog has none."""
    return _meta().get(f"content:{name}") if name in CONTENT else None


def domain_graph() -> dict:
    """Domains as nodes, shared resources and imports as weighted edges, and the resources spanning most domains."""
    return _meta().get("domainGraph") or {"nodes": [], "edges": [], "bridges": []}


def meta() -> dict:
    m = _meta()
    return {"site": m.get("site"), "evaluation": m.get("evaluation"), "rubric": m.get("rubric"), "ingestedAt": m.get("ingestedAt")}


def _summary(row: sqlite3.Row) -> dict:
    e = json.loads(row["data"])
    facts = json.loads(row["facts"]) if row["facts"] else None
    cats = _categories()
    desc = e.get("description") or ""
    return {
        "id": e["id"],
        "acronym": e.get("acronym"),
        "name": e["name"],
        "description": desc if len(desc) <= 180 else desc[:177] + "…",
        "category": e["category"],
        "categoryName": cats.get(e["category"], {}).get("name"),
        "domains": e.get("domains") or [],
        "kind": e.get("kind"),
        "kindLabel": derived.KIND_LABEL.get(e.get("kind"), e.get("kind")),
        "formats": (e.get("formats") or [])[:4],
        "tags": (e.get("tags") or [])[:6],
        "species": (e.get("species") or [])[:2],
        "legacy": e.get("status") == "legacy",
        "grade": row["grade"],
        "score": row["score"],
        "fair": row["fair"],
        "lastActivity": row["last_activity"],
        "adopters": row["adopters"],
        "version": row["version"],
        "penalty": ((facts or {}).get("penalty") or {}).get("score"),
        "qualityPartial": bool((facts or {}).get("qualityPartial")),
        "qualityNotAssessed": (facts or {}).get("qualityNotAssessed"),
    }


def _fts_query(q: str) -> str | None:
    """User text → an FTS5 query: every word must match, as a prefix. Quotes keep FTS syntax out."""
    words = re.findall(r"[\w\-]+", q.lower())
    return " AND ".join(f'"{w}"*' for w in words[:12]) or None


def search(
    q: str | None = None,
    category: str | None = None,
    kind: str | None = None,
    grade: str | None = None,
    format: str | None = None,
    registry: str | None = None,
    include_legacy: bool = True,
    sort: SortKey | None = None,
    page: int = 1,
    size: int = 24,
) -> dict:
    """Search and filter the catalog. `category` matches the primary domain or any secondary domain."""
    size = max(1, min(size, MAX_PAGE_SIZE))
    page = max(1, page)
    where, args, join = [], [], ""
    fts = _fts_query(q) if q else None
    if q and not fts:
        return {"total": 0, "page": page, "size": size, "items": [], "facets": {}}
    if fts:
        join = "JOIN entries_fts f ON f.id = e.id"
        where.append("entries_fts MATCH ?")
        args.append(fts)
    filters: list[tuple[str, str, list]] = []
    if category:
        filters.append(("category", "e.id IN (SELECT entry_id FROM entry_domains WHERE category = ?)", [category]))
    if kind:
        filters.append(("kind", "e.kind = ?", [kind]))
    if grade:
        filters.append(("grade", "e.grade IS NULL" if grade == "none" else "e.grade = ?", [] if grade == "none" else [grade]))
    if format:
        filters.append(("format", "e.id IN (SELECT entry_id FROM entry_formats WHERE format = ?)", [format]))
    if registry:
        filters.append(("registry", "e.id IN (SELECT entry_id FROM entry_registries WHERE registry = ?)", [registry]))
    if not include_legacy:
        where.append("e.legacy = 0")

    def clause(skip: str | None = None):
        parts = where + [sql for name, sql, _ in filters if name != skip]
        params = args + [p for name, _, ps in filters if name != skip for p in ps]
        return ("WHERE " + " AND ".join(parts)) if parts else "", params

    w, params = clause()
    order = SORTS.get(sort or "", None)
    order_args: list = []
    if order is None and fts:
        # Exact acronym/name/id matches first, then names starting with the query, then bm25
        # (weights: id, acronym, name, description, extra; lower is better).
        text = " ".join(re.findall(r"[\w\-]+", q.lower()))
        order = (
            "CASE WHEN lower(e.acronym) = ? OR lower(e.name) = ? OR e.id = ? THEN 0 WHEN lower(e.name) LIKE ? THEN 1 ELSE 2 END, "
            "bm25(entries_fts, 0, 12.0, 6.0, 1.0, 2.0), e.score IS NULL, e.score DESC"
        )
        order_args = [text, text, text, text + "%"]
    elif order is None:
        order = SORTS["score"]
    con = db()
    total = con.execute(f"SELECT COUNT(*) FROM entries e {join} {w}", params).fetchone()[0]
    rows = con.execute(f"SELECT e.* FROM entries e {join} {w} ORDER BY {order} LIMIT ? OFFSET ?", [*params, *order_args, size, (page - 1) * size]).fetchall()

    # Facet counts: each facet ignores its own filter, so the UI can show what switching it would give.
    facets: dict[str, dict[str, int]] = {}
    for name, sql in [
        ("kind", "SELECT e.kind AS k, COUNT(*) FROM entries e {join} {w} GROUP BY k"),
        ("grade", "SELECT COALESCE(e.grade, 'none') AS k, COUNT(*) FROM entries e {join} {w} GROUP BY k"),
        ("category", "SELECT d.category AS k, COUNT(*) FROM entries e JOIN entry_domains d ON d.entry_id = e.id {join} {w} GROUP BY k"),
        ("format", "SELECT x.format AS k, COUNT(*) FROM entries e JOIN entry_formats x ON x.entry_id = e.id {join} {w} GROUP BY k"),
        ("registry", "SELECT x.registry AS k, COUNT(*) FROM entries e JOIN entry_registries x ON x.entry_id = e.id {join} {w} GROUP BY k"),
    ]:
        fw, fp = clause(skip=name)
        facets[name] = {r[0]: r[1] for r in con.execute(sql.format(join=join, w=fw), fp) if r[0] is not None}
    return {"total": total, "page": page, "size": size, "items": [_summary(r) for r in rows], "facets": facets}


def summaries(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    rows = db().execute(f"SELECT * FROM entries WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
    by_id = {r["id"]: _summary(r) for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def history(entry_id: str) -> list[dict]:
    rows = db().execute("SELECT point FROM history WHERE entry_id = ? ORDER BY at, run_id", (entry_id,)).fetchall()
    return [json.loads(r["point"]) for r in rows]


def _resolve(keys: list[str]) -> list[dict]:
    """Bioregistry-style prefixes → catalog entries where we have them, otherwise a Bioregistry link."""
    if not keys:
        return []
    found = {r["key"]: r for r in db().execute(
        f"SELECT k.key, e.id, e.acronym FROM entry_keys k JOIN entries e ON e.id = k.entry_id WHERE k.key IN ({','.join('?' * len(keys))})", keys
    )}
    return [
        {"key": k, "entryId": found[k]["id"], "label": found[k]["acronym"] or k.upper()} if k in found
        else {"key": k, "entryId": None, "label": k.upper(), "url": f"https://bioregistry.io/{k}"}
        for k in keys
    ]


def entry(entry_id: str) -> dict | None:
    """Everything the entry page shows: catalog record, evaluation facts, derived lists, history and related entries."""
    con = db()
    row = con.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if row is None:
        return None
    e = json.loads(row["data"])
    facts = json.loads(row["facts"]) if row["facts"] else None
    cats = _categories()
    h = history(entry_id)
    related = con.execute(
        f"SELECT * FROM entries e WHERE e.category = ? AND e.id != ? ORDER BY {SORTS['score']} LIMIT 5", (e["category"], entry_id)
    ).fetchall()
    return {
        "entry": e,
        "summary": _summary(row),
        "category": cats.get(e["category"]),
        "domains": [cats[d] for d in e.get("domains") or [] if d in cats],
        "facts": facts,
        "license": derived.license_of(e, facts),
        "adopters": derived.adopters(e, facts),
        "imports": _resolve(derived.imports(facts)) if facts else [],
        "reusedBy": _resolve(derived.reused_by(facts)) if facts else [],
        "history": h,
        "changes": list(reversed(derived.changes(h))),
        "related": [_summary(r) for r in related],
    }


def categories() -> list[dict]:
    con = db()
    primary = dict(con.execute("SELECT category, COUNT(*) FROM entries GROUP BY category").fetchall())
    reach = dict(con.execute("SELECT category, COUNT(*) FROM entry_domains GROUP BY category").fetchall())
    return [{**c, "count": primary.get(c["id"], 0), "reach": reach.get(c["id"], 0)} for c in _categories().values()]


def category(cat_id: str) -> dict | None:
    c = next((x for x in categories() if x["id"] == cat_id), None)
    return c


def runs(limit: int = 50) -> list[dict]:
    rows = db().execute("SELECT data, entries FROM runs ORDER BY finished_at DESC, id DESC LIMIT ?", (limit,)).fetchall()
    return [{**json.loads(r["data"]), "entryCount": r["entries"]} for r in rows]


def run(run_id: str, page: int = 1, size: int = 100) -> dict | None:
    con = db()
    row = con.execute("SELECT data, entries FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    size = max(1, min(size, 500))
    rows = con.execute(
        "SELECT entry_id, point FROM history WHERE run_id = ? ORDER BY entry_id LIMIT ? OFFSET ?", (run_id, size, (max(1, page) - 1) * size)
    ).fetchall()
    return {
        "run": json.loads(row["data"]),
        "total": row["entries"],
        "page": page,
        "size": size,
        "entries": [{"id": r["entry_id"], **json.loads(r["point"])} for r in rows],
    }


def stats() -> dict:
    con = db()
    one = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "entries": one("SELECT COUNT(*) FROM entries"),
        "evaluated": one("SELECT COUNT(*) FROM entries WHERE score IS NOT NULL"),
        "categories": one("SELECT COUNT(*) FROM categories"),
        "runs": one("SELECT COUNT(*) FROM runs"),
        "averageScore": con.execute("SELECT ROUND(AVG(score), 1) FROM entries WHERE score IS NOT NULL").fetchone()[0],
        "grades": dict(con.execute("SELECT COALESCE(grade, 'none'), COUNT(*) FROM entries GROUP BY 1").fetchall()),
        "kinds": dict(con.execute("SELECT kind, COUNT(*) FROM entries GROUP BY kind").fetchall()),
        "totalAdopters": one("SELECT COALESCE(SUM(adopters), 0) FROM entries"),
        "crossDomain": one("SELECT COUNT(*) FROM (SELECT entry_id FROM entry_domains GROUP BY entry_id HAVING COUNT(*) > 1)"),
        "evaluation": _meta().get("evaluation"),
    }


def top(n: int = 8, category: str | None = None) -> list[dict]:
    sql = f"SELECT * FROM entries e WHERE e.score IS NOT NULL {'AND e.id IN (SELECT entry_id FROM entry_domains WHERE category = ?)' if category else ''} ORDER BY {SORTS['score']} LIMIT ?"
    return [_summary(r) for r in db().execute(sql, ([category] if category else []) + [n])]


def recently_active(n: int = 8) -> list[dict]:
    return [_summary(r) for r in db().execute(f"SELECT * FROM entries e WHERE e.last_activity IS NOT NULL ORDER BY {SORTS['activity']} LIMIT ?", (n,))]


def ids() -> list[dict]:
    """Every entry id and its primary category, for sitemaps."""
    return [{"id": r[0], "category": r[1]} for r in db().execute("SELECT id, category FROM entries ORDER BY id")]


def compact(obj: Any) -> Any:
    """Drop empty values, for compact MCP responses."""
    if isinstance(obj, dict):
        return {k: compact(v) for k, v in obj.items() if v not in (None, "", [], {})}
    if isinstance(obj, list):
        return [compact(v) for v in obj]
    return obj
