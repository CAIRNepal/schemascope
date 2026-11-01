"""MCP server: the catalog's queries as tools for AI agents.

Served by the API at /mcp/ (streamable HTTP). Run on its own over stdio with
`python -m catalog_api.mcp_server` (e.g. for Claude Desktop / Claude Code).
"""
from __future__ import annotations

from typing import Optional

from mcp.server.mcpserver import Context, MCPServer

from . import chatlog, store
from .settings import site_config

_site = site_config().get("name", "Catalog")
mcp = MCPServer(
    _site,
    instructions=(
        f"{_site} is a catalog of ontologies, schemas, vocabularies and data standards, each scored automatically "
        "(0–100, grades A–E) on FAIR principles, ontology quality, maintenance and adoption. Use search_catalog to find "
        "resources, get_entry for the full evaluation of one, get_entry_history to see how it changed across runs."
    ),
    website_url=site_config().get("url") or None,
)


def _base_url() -> str:
    return site_config().get("url", "")


async def _log(ctx: Context | None, tool: str, query: str | None = None, filters: dict | None = None,
               result_ids: list[str] | tuple = (), count: int | None = None) -> None:
    """Add the call to the anonymous search log (source "mcp"), like searches on the site: the tool, its query and
    filters, how many results and the top ones. No token, user or IP is stored. Skipped when the token's owner turned
    "Help improve recommendations" off, and for local stdio runs (no HTTP request). Never fails the tool call."""
    try:
        req = getattr(ctx.request_context, "request", None) if ctx is not None else None
        if req is None:
            return
        p = req.scope.get("principal")
        if p is not None and not p.user.improve_search:
            return
        used = {k: v for k, v in (filters or {}).items() if v not in (None, False, "")}
        ids = [str(x) for x in result_ids][:20]
        await chatlog.log_search(None, "mcp", query, {"tool": tool, **used}, len(ids) if count is None else count, ids)
    except Exception:
        pass


@mcp.tool()
async def search_catalog(
    query: Optional[str] = None,
    category: Optional[str] = None,
    kind: Optional[str] = None,
    grade: Optional[str] = None,
    format: Optional[str] = None,
    sort: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    ctx: Context | None = None,
) -> dict:
    """Search the catalog.

    query: free text over acronym, name, description, tags, maintainer, formats and domains (every word must match).
    category: a category id from list_categories (matches primary or secondary domain).
    kind: ontology | schema | vocabulary | atlas | data-standard | knowledge-base.
    grade: A–E, or "none" for not evaluated. format: e.g. OWL, OBO, JSON Schema, LinkML.
    sort: relevance (default with a query) | score | name | fair | activity | adopters.
    """
    res = await store.search(q=query, category=category, kind=kind, grade=grade, format=format, sort=sort, page=page, size=min(page_size, 50))
    base = _base_url()
    items = [
        store.compact({**{k: x[k] for k in ("id", "acronym", "name", "description", "kindLabel", "categoryName", "grade", "score", "fair", "version", "lastActivity", "formats")}, "url": f"{base}/o/{x['id']}/"})
        for x in res["items"]
    ]
    await _log(ctx, "search_catalog", query, {"category": category, "kind": kind, "grade": grade, "format": format, "sort": sort,
                                             "page": page if page > 1 else None}, [x["id"] for x in items], res["total"])
    return {"total": res["total"], "page": res["page"], "pageSize": res["size"], "items": items}


@mcp.tool()
async def get_entry(entry_id: str, include_evidence: bool = False, ctx: Context | None = None) -> dict:
    """Full record for one resource: description, links, license, score and per-criterion breakdown with the steps
    behind each point, quality checks, adopters, imports and reuse. Set include_evidence=true for the raw facts
    fetched from each source (large)."""
    d = await store.entry(entry_id)
    await _log(ctx, "get_entry", entry_id, {"include_evidence": include_evidence}, [entry_id] if d else [])
    if d is None:
        return {"error": f"No entry with id '{entry_id}'. Use search_catalog to find ids."}
    facts = d["facts"] or {}
    out = {
        "entry": d["entry"],
        "url": f"{_base_url()}/o/{entry_id}/",
        "license": d["license"],
        "evaluation": {
            k: facts.get(k)
            for k in ("score", "grade", "fair", "earned", "possible", "gross", "penalty", "breakdown", "qualityPartial", "evaluatedVersion", "evaluatedAt", "lastActivity", "runId")
        } if facts else None,
        "quality": {k: facts.get(k) for k in ("quality", "oops", "dashboardComparison")} if facts else None,
        "adopters": d["adopters"],
        "imports": d["imports"],
        "reusedBy": d["reusedBy"],
        "runs": len(d["history"]),
        "recentChanges": d["changes"][:10],
    }
    if include_evidence:
        out["evidence"] = facts
    return store.compact(out)


@mcp.tool()
async def get_entry_history(entry_id: str, ctx: Context | None = None) -> dict:
    """Score, grade, per-criterion points and quality metrics for one resource in every archived evaluation run,
    oldest first, plus a list of what changed between runs."""
    h = await store.history(entry_id)
    missing = not h and await store.entry(entry_id) is None
    await _log(ctx, "get_entry_history", entry_id, None, [] if missing else [entry_id])
    if missing:
        return {"error": f"No entry with id '{entry_id}'."}
    from .derived import changes

    return {"runs": h, "changes": changes(h)}


@mcp.tool()
async def list_categories(ctx: Context | None = None) -> list[dict]:
    """Domains of the catalog, with the number of resources whose primary domain it is (count) and the number that
    are used in it at all (reach)."""
    cats = [{k: c[k] for k in ("id", "name", "blurb", "count", "reach") if k in c} for c in await store.categories()]
    await _log(ctx, "list_categories", count=len(cats))
    return cats


@mcp.tool()
async def catalog_stats(ctx: Context | None = None) -> dict:
    """Size of the catalog, grade distribution, average score, latest evaluation run and rubric version."""
    s = await store.stats()
    s["rubricVersion"] = ((await store.meta()).get("rubric") or {}).get("version")
    await _log(ctx, "catalog_stats", count=1)
    return s


@mcp.tool()
async def scoring_rubric(ctx: Context | None = None) -> dict:
    """How scores are computed: each criterion with its maximum points, formula and explanation, the penalties and
    the grade thresholds."""
    await _log(ctx, "scoring_rubric", count=1)
    return (await store.meta()).get("rubric") or {"error": "Rubric metadata was not ingested."}


@mcp.tool()
async def recommend_resources(
    need: str,
    category: Optional[str] = None,
    kind: Optional[str] = None,
    format: Optional[str] = None,
    maintained: bool = False,
    open_license: bool = False,
    used: bool = False,
    min_grade: Optional[str] = None,
    limit: int = 5,
    ctx: Context | None = None,
) -> dict:
    """Recommend resources for a need, best first, each with the reasons it was chosen.

    need: what the user wants to describe or do, in a few words (e.g. "mouse brain anatomy").
    category: a category id from list_categories. kind: ontology | schema | vocabulary | atlas | data-standard | knowledge-base.
    format: e.g. OWL, OBO, JSON Schema. maintained: updated in the last two years. open_license: open licences only.
    used: at least one known adopter. min_grade: A (best) to E. If nothing matches, filters are relaxed and listed in `relaxed`.
    """
    from . import recommend as rec

    r = await rec.recommend(need, limit=min(max(limit, 1), 10), category=category, kind=kind, format=format, min_grade=min_grade,
                      maintained=maintained, open_license=open_license, used=used)
    base = _base_url()
    for x in r["items"]:
        x["url"] = f"{base}/o/{x['id']}/"
    await _log(ctx, "recommend_resources", need, {"category": category, "kind": kind, "format": format, "maintained": maintained,
                                                  "open_license": open_license, "used": used, "min_grade": min_grade},
               [x["id"] for x in r["items"]])
    return r


# Last, so every tool above is registered before the stdio server starts.
if __name__ == "__main__":
    mcp.run()
