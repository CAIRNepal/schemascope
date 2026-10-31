"""HTTP API (/api/...) and MCP endpoint (/mcp/) for the catalog.

    uvicorn catalog_api.app:app --reload --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mcp.server.transport_security import TransportSecuritySettings

from . import store
from .mcp_server import mcp
from .settings import CORS_ORIGINS, MCP_ALLOWED_HOSTS, site_config

_local_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
mcp_app = mcp.streamable_http_app(
    streamable_http_path="/",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(
        allowed_hosts=_local_hosts + [h for x in MCP_ALLOWED_HOSTS for h in (x, f"{x}:*")],
        allowed_origins=[f"http://{h}" for h in _local_hosts] + [f"https://{x}" for x in MCP_ALLOWED_HOSTS],
    ),
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(
    title=f"{site_config().get('name', 'Catalog')} API",
    description="Search the catalog, read entries with their automated evaluation, and follow scores across runs. "
    "The same queries are available to AI agents over MCP at /mcp/.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
app.mount("/mcp", mcp_app)


@app.exception_handler(store.NotIngested)
async def not_ingested(_req, exc: store.NotIngested):
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.get("/api/health")
def health():
    m = store.meta()
    return {"ok": True, "ingestedAt": m["ingestedAt"], "evaluation": m["evaluation"]}


@app.get("/api/meta")
def get_meta():
    """Site configuration, the latest evaluation run and the scoring rubric."""
    return store.meta()


@app.get("/api/content/{name}")
def get_content(name: str):
    """Data behind the content pages: `roadmap` (data/roadmap.json) and `validation` (data/validation/report.json)."""
    doc = store.content(name)
    if doc is None:
        raise HTTPException(404, f"No {name} document in this catalog")
    return doc


@app.get("/api/stats")
def get_stats():
    return store.stats()


@app.get("/api/categories")
def get_categories():
    return store.categories()


@app.get("/api/categories/{cat_id}")
def get_category(cat_id: str):
    c = store.category(cat_id)
    if c is None:
        raise HTTPException(404, "Category not found")
    return c


# Note: routes under /api/entries/ take an entry id, so helper lists live at /api/top-entries etc.
# (an entry is literally called "top").
@app.get("/api/entries")
def list_entries(
    q: Optional[str] = Query(None, description="Free text; every word must match (prefix)"),
    category: Optional[str] = Query(None, description="Category id (primary or secondary domain)"),
    kind: Optional[str] = None,
    grade: Optional[str] = Query(None, description="A–E, or 'none' for not evaluated"),
    format: Optional[str] = None,
    registry: Optional[str] = None,
    legacy: bool = Query(True, description="Include legacy resources"),
    sort: Optional[store.SortKey] = None,
    page: int = Query(1, ge=1),
    size: int = Query(24, ge=1, le=store.MAX_PAGE_SIZE),
):
    return store.search(q=q, category=category, kind=kind, grade=grade, format=format, registry=registry, include_legacy=legacy, sort=sort, page=page, size=size)


@app.get("/api/top-entries")
def top_entries(n: int = Query(8, ge=1, le=50), category: Optional[str] = None):
    return store.top(n, category)


@app.get("/api/recent-entries")
def recent_entries(n: int = Query(8, ge=1, le=50)):
    return store.recently_active(n)


@app.get("/api/entry-ids")
def entry_ids():
    """All entry ids (for sitemaps and bulk clients)."""
    return store.ids()


@app.get("/api/entries/{entry_id}")
def get_entry(entry_id: str):
    d = store.entry(entry_id)
    if d is None:
        raise HTTPException(404, "Entry not found")
    return d


@app.get("/api/entries/{entry_id}/history")
def get_history(entry_id: str):
    from .derived import changes

    h = store.history(entry_id)
    return {"runs": h, "changes": changes(h)}


@app.get("/api/runs")
def list_runs(limit: int = Query(50, ge=1, le=500)):
    return store.runs(limit)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, page: int = Query(1, ge=1), size: int = Query(100, ge=1, le=500)):
    r = store.run(run_id, page, size)
    if r is None:
        raise HTTPException(404, "Run not found")
    return r
