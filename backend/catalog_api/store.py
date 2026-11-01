"""Read-only queries over the ingested catalog (Postgres). Used by both the HTTP API and the MCP tools."""
from __future__ import annotations

import json
import re
import time
from typing import Any, Literal

from . import db, derived

SortKey = Literal["relevance", "score", "name", "fair", "activity", "adopters"]
SORTS = {
    "score": "e.score DESC NULLS LAST, lower(e.name)",
    "name": "lower(COALESCE(e.acronym, e.name))",
    "fair": "e.fair DESC NULLS LAST, lower(e.name)",
    "activity": "e.last_activity DESC NULLS LAST",
    "adopters": "e.adopters DESC, e.score DESC NULLS LAST",
}
MAX_PAGE_SIZE = 100


class NotIngested(RuntimeError):
    pass


_gen = {"value": None, "checked": 0.0}
_cache: dict[str, Any] = {}


async def _generation() -> str:
    """The time of the last ingest, re-read at most every 2 s, so cached lookups refresh without a restart."""
    if time.time() - _gen["checked"] > 2:
        v = await db.value("SELECT value FROM meta WHERE key = 'ingestedAt'")
        if v is None:
            raise NotIngested("The catalog has not been loaded. Run `python -m catalog_api.ingest` first.")
        _gen["value"], _gen["checked"] = v, time.time()
    return _gen["value"]


def reset() -> None:
    _gen["checked"] = 0.0
    _cache.clear()


async def _cached(name: str, sql: str, build) -> Any:
    """A small table read once per ingest (meta, categories)."""
    gen = await _generation()
    hit = _cache.get(name)
    if hit and hit[0] == gen:
        return hit[1]
    value = build(await db.rows(sql))
    _cache[name] = (gen, value)
    return value


async def _meta() -> dict:
    return await _cached("meta", "SELECT key, value FROM meta", lambda rs: {r["key"]: json.loads(r["value"]) for r in rs})


async def _categories() -> dict[str, dict]:
    return await _cached("categories", "SELECT id, data FROM categories ORDER BY position", lambda rs: {r["id"]: json.loads(r["data"]) for r in rs})


CONTENT = ("roadmap", "validation")


async def content(name: str) -> Any:
    """A content document loaded from data/ (roadmap, rubric validation report), or None if this catalog has none."""
    return (await _meta()).get(f"content:{name}") if name in CONTENT else None


async def site_data() -> str:
    """Everything the page templates (scripts/site.mjs) need, as one JSON document. Data files are passed through
    as stored; history and per-run scores come from the history table. Built as text: the evaluation alone is
    tens of MB, and re-encoding it would only cost time."""
    raw = {r["key"]: r["value"] for r in await db.rows("SELECT key, value FROM raw")}
    if not raw:
        raise NotIngested("No raw data in the database. Re-run `python -m catalog_api.ingest`.")
    runs, history = [], {}
    run_rows = await db.rows("SELECT id, data FROM runs ORDER BY id")
    scores: dict[str, list] = {r["id"]: [] for r in run_rows}
    for h in await db.rows("SELECT entry_id, run_id, point FROM history ORDER BY entry_id, run_id"):
        history.setdefault(h["entry_id"], []).append(h["point"])
        scores[h["run_id"]].append(json.loads(h["point"]).get("score"))
    for r in run_rows:
        runs.append('{"run":%s,"scores":%s}' % (r["data"], json.dumps(scores[r["id"]])))
    hist = ",".join(f"{json.dumps(k)}:[{','.join(v)}]" for k, v in history.items())
    parts = [f'"{k}":{raw[k]}' for k in ("config", "categories", "catalog", "evaluation", "roadmap", "validation", "catalogSchema")]
    parts += [f'"runs":[{",".join(runs)}]', f'"history":{{{hist}}}', f'"ingestedAt":{json.dumps((await _meta()).get("ingestedAt"))}']
    return "{" + ",".join(parts) + "}"


def run_file(run_id: str):
    """Path of an archived run snapshot, published or local preview."""
    from .ingest import run_files

    return next((f for f in reversed(run_files()) if f.stem == run_id), None)


async def domain_graph() -> dict:
    """Domains as nodes, shared resources and imports as weighted edges, and the resources spanning most domains."""
    return (await _meta()).get("domainGraph") or {"nodes": [], "edges": [], "bridges": []}


async def meta() -> dict:
    m = await _meta()
    return {"site": m.get("site"), "evaluation": m.get("evaluation"), "rubric": m.get("rubric"), "ingestedAt": m.get("ingestedAt")}


async def _summary(row: dict) -> dict:
    e = json.loads(row["data"])
    facts = json.loads(row["facts"]) if row["facts"] else None
    cats = await _categories()
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


def _ts_query(q: str) -> str | None:
    """User text → a tsquery: every word must match, as a prefix (words only, so no tsquery syntax gets through)."""
    words = re.findall(r"\w+", q.lower())
    return " & ".join(f"{w}:*" for w in words[:12]) or None


async def search(
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
    where, args = [], []
    tsq = _ts_query(q) if q else None
    if q and not tsq:
        return {"total": 0, "page": page, "size": size, "items": [], "facets": {}}
    if tsq:
        where.append("e.search @@ to_tsquery('simple', %s)")
        args.append(tsq)
    filters: list[tuple[str, str, list]] = []
    if category:
        filters.append(("category", "e.id IN (SELECT entry_id FROM entry_domains WHERE category = %s)", [category]))
    if kind:
        filters.append(("kind", "e.kind = %s", [kind]))
    if grade:
        filters.append(("grade", "e.grade IS NULL" if grade == "none" else "e.grade = %s", [] if grade == "none" else [grade]))
    if format:
        filters.append(("format", "e.id IN (SELECT entry_id FROM entry_formats WHERE format = %s)", [format]))
    if registry:
        filters.append(("registry", "e.id IN (SELECT entry_id FROM entry_registries WHERE registry = %s)", [registry]))
    if not include_legacy:
        where.append("NOT e.legacy")

    def clause(skip: str | None = None):
        parts = where + [sql for name, sql, _ in filters if name != skip]
        params = args + [p for name, _, ps in filters if name != skip for p in ps]
        return ("WHERE " + " AND ".join(parts)) if parts else "", params

    w, params = clause()
    order = SORTS.get(sort or "", None)
    order_args: list = []
    if order is None and tsq:
        # Exact acronym/name/id matches first, then names starting with the query, then text rank (weights A–D).
        text = " ".join(re.findall(r"\w+", q.lower()))
        order = (
            "CASE WHEN lower(e.acronym) = %s OR lower(e.name) = %s OR e.id = %s THEN 0 WHEN lower(e.name) LIKE %s THEN 1 ELSE 2 END, "
            "ts_rank(e.search, to_tsquery('simple', %s)) DESC, e.score DESC NULLS LAST"
        )
        order_args = [text, text, text, text + "%", tsq]
    elif order is None:
        order = SORTS["score"]
    total = await db.value(f"SELECT COUNT(*) FROM entries e {w}", params)
    rows = await db.rows(f"SELECT e.* FROM entries e {w} ORDER BY {order} LIMIT %s OFFSET %s", [*params, *order_args, size, (page - 1) * size])

    # Facet counts: each facet ignores its own filter, so the UI can show what switching it would give.
    facets: dict[str, dict[str, int]] = {}
    for name, sql in [
        ("kind", "SELECT e.kind AS k, COUNT(*) AS n FROM entries e {w} GROUP BY 1"),
        ("grade", "SELECT COALESCE(e.grade, 'none') AS k, COUNT(*) AS n FROM entries e {w} GROUP BY 1"),
        ("category", "SELECT d.category AS k, COUNT(*) AS n FROM entries e JOIN entry_domains d ON d.entry_id = e.id {w} GROUP BY 1"),
        ("format", "SELECT x.format AS k, COUNT(*) AS n FROM entries e JOIN entry_formats x ON x.entry_id = e.id {w} GROUP BY 1"),
        ("registry", "SELECT x.registry AS k, COUNT(*) AS n FROM entries e JOIN entry_registries x ON x.entry_id = e.id {w} GROUP BY 1"),
    ]:
        fw, fp = clause(skip=name)
        facets[name] = {r["k"]: r["n"] for r in await db.rows(sql.format(w=fw), fp) if r["k"] is not None}
    return {"total": total, "page": page, "size": size, "items": [await _summary(r) for r in rows], "facets": facets}


async def summaries(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    by_id = {r["id"]: await _summary(r) for r in await db.rows("SELECT * FROM entries WHERE id = ANY(%s)", (ids,))}
    return [by_id[i] for i in ids if i in by_id]


async def history(entry_id: str) -> list[dict]:
    rows = await db.rows("SELECT point FROM history WHERE entry_id = %s ORDER BY run_id", (entry_id,))
    return [json.loads(r["point"]) for r in rows]


async def _resolve(keys: list[str]) -> list[dict]:
    """Bioregistry-style prefixes → catalog entries where we have them, otherwise a Bioregistry link."""
    if not keys:
        return []
    found = {r["key"]: r for r in await db.rows(
        "SELECT k.key, e.id, e.acronym FROM entry_keys k JOIN entries e ON e.id = k.entry_id WHERE k.key = ANY(%s)", (keys,)
    )}
    return [
        {"key": k, "entryId": found[k]["id"], "label": found[k]["acronym"] or k.upper()} if k in found
        else {"key": k, "entryId": None, "label": k.upper(), "url": f"https://bioregistry.io/{k}"}
        for k in keys
    ]


async def entry(entry_id: str) -> dict | None:
    """Everything the entry page shows: catalog record, evaluation facts, derived lists, history and related entries."""
    row = await db.one("SELECT * FROM entries WHERE id = %s", (entry_id,))
    if row is None:
        return None
    e = json.loads(row["data"])
    facts = json.loads(row["facts"]) if row["facts"] else None
    cats = await _categories()
    h = await history(entry_id)
    related = await db.rows(f"SELECT * FROM entries e WHERE e.category = %s AND e.id <> %s ORDER BY {SORTS['score']} LIMIT 5", (e["category"], entry_id))
    return {
        "entry": e,
        "summary": await _summary(row),
        "category": cats.get(e["category"]),
        "domains": [cats[d] for d in e.get("domains") or [] if d in cats],
        "facts": facts,
        "license": derived.license_of(e, facts),
        "adopters": derived.adopters(e, facts),
        "imports": await _resolve(derived.imports(facts)) if facts else [],
        "reusedBy": await _resolve(derived.reused_by(facts)) if facts else [],
        "history": h,
        "changes": list(reversed(derived.changes(h))),
        "related": [await _summary(r) for r in related],
    }


async def categories() -> list[dict]:
    primary = {r["category"]: r["n"] for r in await db.rows("SELECT category, COUNT(*) AS n FROM entries GROUP BY category")}
    reach = {r["category"]: r["n"] for r in await db.rows("SELECT category, COUNT(*) AS n FROM entry_domains GROUP BY category")}
    return [{**c, "count": primary.get(c["id"], 0), "reach": reach.get(c["id"], 0)} for c in (await _categories()).values()]


async def category(cat_id: str) -> dict | None:
    c = next((x for x in await categories() if x["id"] == cat_id), None)
    return c


async def runs(limit: int = 50) -> list[dict]:
    rows = await db.rows("SELECT data, entries FROM runs ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT %s", (limit,))
    return [{**json.loads(r["data"]), "entryCount": r["entries"]} for r in rows]


async def run(run_id: str, page: int = 1, size: int = 100) -> dict | None:
    row = await db.one("SELECT data, entries FROM runs WHERE id = %s", (run_id,))
    if row is None:
        return None
    size = max(1, min(size, 500))
    rows = await db.rows("SELECT entry_id, point FROM history WHERE run_id = %s ORDER BY entry_id LIMIT %s OFFSET %s", (run_id, size, (max(1, page) - 1) * size))
    return {
        "run": json.loads(row["data"]),
        "total": row["entries"],
        "page": page,
        "size": size,
        "entries": [{"id": r["entry_id"], **json.loads(r["point"])} for r in rows],
    }


async def stats() -> dict:
    v = db.value
    avg = await v("SELECT ROUND(AVG(score)::numeric, 1) FROM entries WHERE score IS NOT NULL")
    return {
        "entries": await v("SELECT COUNT(*) FROM entries"),
        "evaluated": await v("SELECT COUNT(*) FROM entries WHERE score IS NOT NULL"),
        "categories": await v("SELECT COUNT(*) FROM categories"),
        "runs": await v("SELECT COUNT(*) FROM runs"),
        "averageScore": float(avg) if avg is not None else None,
        "grades": {r["k"]: r["n"] for r in await db.rows("SELECT COALESCE(grade, 'none') AS k, COUNT(*) AS n FROM entries GROUP BY 1")},
        "kinds": {r["k"]: r["n"] for r in await db.rows("SELECT kind AS k, COUNT(*) AS n FROM entries GROUP BY 1")},
        "totalAdopters": await v("SELECT COALESCE(SUM(adopters), 0) FROM entries"),
        "crossDomain": await v("SELECT COUNT(*) FROM (SELECT entry_id FROM entry_domains GROUP BY entry_id HAVING COUNT(*) > 1) x"),
        "evaluation": (await _meta()).get("evaluation"),
    }


async def top(n: int = 8, category: str | None = None) -> list[dict]:
    cat = "AND e.id IN (SELECT entry_id FROM entry_domains WHERE category = %s)" if category else ""
    return [await _summary(r) for r in await db.rows(f"SELECT * FROM entries e WHERE e.score IS NOT NULL {cat} ORDER BY {SORTS['score']} LIMIT %s", ([category] if category else []) + [n])]


async def recently_active(n: int = 8) -> list[dict]:
    return [await _summary(r) for r in await db.rows(f"SELECT * FROM entries e WHERE e.last_activity IS NOT NULL ORDER BY {SORTS['activity']} LIMIT %s", (n,))]


async def ids() -> list[dict]:
    """Every entry id and its primary category, for sitemaps."""
    return await db.rows("SELECT id, category FROM entries ORDER BY id")


def compact(obj: Any) -> Any:
    """Drop empty values, for compact MCP responses."""
    if isinstance(obj, dict):
        return {k: compact(v) for k, v in obj.items() if v not in (None, "", [], {})}
    if isinstance(obj, list):
        return [compact(v) for v in obj]
    return obj


# ---------- admin dashboard ----------
async def score_changes(limit: int = 8) -> dict:
    """Resources whose score changed between the two latest runs, biggest change first."""
    ids = [r["id"] for r in await db.rows("SELECT id FROM runs ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 2")]
    if len(ids) < 2:
        return {"latest": ids[0] if ids else None, "previous": None, "changes": []}
    rows = await db.rows(
        """SELECT e.id, e.name, e.acronym, e.kind, (h1.point::jsonb->>'score')::int AS now, (h0.point::jsonb->>'score')::int AS before,
                  h1.point::jsonb->>'grade' AS grade, h0.point::jsonb->>'grade' AS grade_before, h1.at
           FROM history h1 JOIN history h0 ON h0.entry_id = h1.entry_id AND h0.run_id = %s
           JOIN entries e ON e.id = h1.entry_id
           WHERE h1.run_id = %s AND (h1.point::jsonb->>'score') IS DISTINCT FROM (h0.point::jsonb->>'score')
           ORDER BY ABS(COALESCE((h1.point::jsonb->>'score')::int, 0) - COALESCE((h0.point::jsonb->>'score')::int, 0)) DESC, e.name
           LIMIT %s""", (ids[1], ids[0], limit))
    count = await db.value(
        """SELECT COUNT(*) FROM history h1 JOIN history h0 ON h0.entry_id = h1.entry_id AND h0.run_id = %s
           WHERE h1.run_id = %s AND (h1.point::jsonb->>'score') IS DISTINCT FROM (h0.point::jsonb->>'score')""", (ids[1], ids[0]))
    return {"latest": ids[0], "previous": ids[1], "changed": count, "changes": [
        {"id": r["id"], "name": r["acronym"] or r["name"], "fullName": r["name"], "kind": r["kind"], "score": r["now"], "before": r["before"],
         "grade": r["grade"], "gradeBefore": r["grade_before"], "at": r["at"]} for r in rows]}


async def attention(limit: int = 8) -> dict:
    """Resources that need a look: not evaluated, or with a grade E and recent adopters (widely used but weak)."""
    unevaluated = await db.rows("SELECT id, name, acronym, kind, category FROM entries WHERE score IS NULL ORDER BY name LIMIT %s", (limit,))
    return {
        "unevaluated": await db.value("SELECT COUNT(*) FROM entries WHERE score IS NULL"),
        "unevaluatedSample": [{"id": r["id"], "name": r["acronym"] or r["name"], "kind": r["kind"], "category": r["category"]} for r in unevaluated],
        "weakButUsed": await db.value("SELECT COUNT(*) FROM entries WHERE grade = 'E' AND adopters > 0"),
    }


CSV_FIELDS = ["id", "acronym", "name", "kind", "category", "grade", "score", "fair", "adopters", "version", "last_activity", "legacy"]


async def catalog_rows():
    return await db.rows(f"SELECT {', '.join(CSV_FIELDS)} FROM entries ORDER BY position")
