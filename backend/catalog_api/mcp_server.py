"""MCP server: the catalog's queries as tools for AI agents.

Served by the API at /mcp/ (streamable HTTP). Run on its own over stdio with
`python -m catalog_api.mcp_server` (e.g. for Claude Desktop / Claude Code).
"""
from __future__ import annotations

from typing import Optional

from mcp.server.mcpserver import MCPServer

from . import store
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


@mcp.tool()
def search_catalog(
    query: Optional[str] = None,
    category: Optional[str] = None,
    kind: Optional[str] = None,
    grade: Optional[str] = None,
    format: Optional[str] = None,
    sort: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """Search the catalog.

    query: free text over acronym, name, description, tags, maintainer, formats and domains (every word must match).
    category: a category id from list_categories (matches primary or secondary domain).
    kind: ontology | schema | vocabulary | atlas | data-standard | knowledge-base.
    grade: A–E, or "none" for not evaluated. format: e.g. OWL, OBO, JSON Schema, LinkML.
    sort: relevance (default with a query) | score | name | fair | activity | adopters.
    """
    res = store.search(q=query, category=category, kind=kind, grade=grade, format=format, sort=sort, page=page, size=min(page_size, 50))
    base = _base_url()
    items = [
        store.compact({**{k: x[k] for k in ("id", "acronym", "name", "description", "kindLabel", "categoryName", "grade", "score", "fair", "version", "lastActivity", "formats")}, "url": f"{base}/o/{x['id']}/"})
        for x in res["items"]
    ]
    return {"total": res["total"], "page": res["page"], "pageSize": res["size"], "items": items}


@mcp.tool()
def get_entry(entry_id: str, include_evidence: bool = False) -> dict:
    """Full record for one resource: description, links, license, score and per-criterion breakdown with the steps
    behind each point, quality checks, adopters, imports and reuse. Set include_evidence=true for the raw facts
    fetched from each source (large)."""
    d = store.entry(entry_id)
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
def get_entry_history(entry_id: str) -> dict:
    """Score, grade, per-criterion points and quality metrics for one resource in every archived evaluation run,
    oldest first, plus a list of what changed between runs."""
    h = store.history(entry_id)
    if not h and store.entry(entry_id) is None:
        return {"error": f"No entry with id '{entry_id}'."}
    from .derived import changes

    return {"runs": h, "changes": changes(h)}


@mcp.tool()
def list_categories() -> list[dict]:
    """Domains of the catalog, with the number of resources whose primary domain it is (count) and the number that
    are used in it at all (reach)."""
    return [{k: c[k] for k in ("id", "name", "blurb", "count", "reach") if k in c} for c in store.categories()]


@mcp.tool()
def catalog_stats() -> dict:
    """Size of the catalog, grade distribution, average score, latest evaluation run and rubric version."""
    s = store.stats()
    s["rubricVersion"] = (store.meta().get("rubric") or {}).get("version")
    return s


@mcp.tool()
def scoring_rubric() -> dict:
    """How scores are computed: each criterion with its maximum points, formula and explanation, the penalties and
    the grade thresholds."""
    return store.meta().get("rubric") or {"error": "Rubric metadata was not ingested."}


if __name__ == "__main__":
    mcp.run()
