"""HTTP API (/api/...) and MCP endpoint (/mcp/) for the catalog.

    uvicorn catalog_api.app:app --reload --port 8000

`app` is the FastAPI application wrapped in the request guard (authentication, scopes, rate limits).
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from mcp.server.transport_security import TransportSecuritySettings

from . import auth, docs_text, store
from .guard import TITLES, Guard
from .mcp_server import mcp
from .settings import CORS_ORIGINS, MCP_ALLOWED_HOSTS, PUBLIC_API_URL, RATE_LIMIT_ANON, RATE_LIMIT_USER, TOKEN_PREFIX, site_config

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


BRAND = site_config().get("brand") or site_config().get("name", "Catalog")
TAGS = [
    {"name": "Catalog", "description": "Search and read entries, categories and how domains connect."},
    {"name": "Runs", "description": "Evaluation runs and each entry's history across them."},
    {"name": "Auth", "description": "Sign in with GitHub, sessions and who you are."},
    {"name": "API tokens", "description": "Personal access tokens for scripts and MCP clients."},
    {"name": "Submissions", "description": "Add or correct catalog entries (signed in)."},
    {"name": "Admin", "description": "Superadmins: rate limits for everyone and per user."},
    {"name": "Meta", "description": "Server, rubric and content metadata."},
]
api = FastAPI(
    title=f"{BRAND} API",
    description=f"Search the catalog, read entries with their automated evaluation, and follow scores across runs. "
    f"Anonymous use is limited to {RATE_LIMIT_ANON} requests per minute; signed-in users and personal access tokens get "
    f"{RATE_LIMIT_USER}. AI agents can use the same queries over MCP at /mcp/ with a token that has the `mcp` scope.",
    version="2.0.0",
    lifespan=lifespan,
    openapi_tags=TAGS,
    servers=[{"url": PUBLIC_API_URL}] if PUBLIC_API_URL else None,
)
api.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"], allow_headers=["*"],
                   expose_headers=["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"])
api.mount("/mcp", mcp_app)
api.include_router(auth.router)
app = Guard(api)


# Errors are RFC 7807 problem details.
def _problem(request: Request, status: int, detail, headers=None, **extra):
    body = {"type": "about:blank", "title": TITLES.get(status, "Error"), "status": status, "detail": detail, "instance": request.url.path, **extra}
    return JSONResponse(body, status_code=status, media_type="application/problem+json", headers=headers)


@api.exception_handler(StarletteHTTPException)
async def http_problem(request: Request, exc: StarletteHTTPException):
    return _problem(request, exc.status_code, exc.detail, getattr(exc, "headers", None))


@api.exception_handler(RequestValidationError)
async def validation_problem(request: Request, exc: RequestValidationError):
    errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()]
    return _problem(request, 422, "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in errors), errors=errors)


@api.exception_handler(store.NotIngested)
async def not_ingested(request: Request, exc: store.NotIngested):
    return _problem(request, 503, str(exc))


def custom_openapi():
    """OpenAPI with the two bearer schemes, so clients and the docs page show how to authenticate."""
    if api.openapi_schema:
        return api.openapi_schema
    from fastapi.openapi.utils import get_openapi

    schema = get_openapi(title=api.title, version=api.version, description=api.description, routes=api.routes, tags=TAGS, servers=api.servers)
    schema.setdefault("components", {})["securitySchemes"] = {
        "sessionJwt": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT", "description": "Session JWT from GitHub sign-in (POST /api/auth/token)."},
        "personalAccessToken": {"type": "http", "scheme": "bearer", "description": f"Personal access token ({TOKEN_PREFIX}…) from the account page."},
    }
    schema["security"] = [{}, {"sessionJwt": []}, {"personalAccessToken": []}]
    docs_text.apply(schema)
    api.openapi_schema = schema
    return schema


api.openapi = custom_openapi


@api.get("/api/health", tags=["Meta"], summary="Health")
def health():
    m = store.meta()
    return {"ok": True, "ingestedAt": m["ingestedAt"], "evaluation": m["evaluation"]}


@api.get("/api/meta", tags=["Meta"], summary="Meta & rubric")
def get_meta():
    """Site configuration, the latest evaluation run and the scoring rubric."""
    return store.meta()


@api.get("/api/content/{name}", tags=["Meta"], summary="Content document")
def get_content(name: str):
    """Data behind the content pages: `roadmap` (data/roadmap.json) and `validation` (data/validation/report.json)."""
    doc = store.content(name)
    if doc is None:
        raise HTTPException(404, f"No {name} document in this catalog")
    return doc


@api.get("/api/site-data", include_in_schema=False)
def get_site_data():
    """Bulk data for the web server's page templates (large; not meant for other clients)."""
    return Response(store.site_data(), media_type="application/json")


@api.get("/api/runs/{run_id}/snapshot", tags=["Runs"], summary="Run snapshot")
def get_run_snapshot(run_id: str):
    """The archived run file as written by the evaluator: every entry's facts and scores in that run."""
    f = store.run_file(run_id)
    if f is None:
        raise HTTPException(404, "Run not found")
    return FileResponse(f, media_type="application/json")


@api.get("/api/domain-graph", tags=["Catalog"], summary="Domain graph")
def get_domain_graph():
    """How domains connect: nodes (domains, with reach), weighted edges (shared resources + imports), bridges."""
    return store.domain_graph()


@api.get("/api/stats", tags=["Catalog"], summary="Stats")
def get_stats():
    return store.stats()


@api.get("/api/categories", tags=["Catalog"], summary="List categories")
def get_categories():
    return store.categories()


@api.get("/api/categories/{cat_id}", tags=["Catalog"], summary="Get category")
def get_category(cat_id: str):
    c = store.category(cat_id)
    if c is None:
        raise HTTPException(404, "Category not found")
    return c


# Note: routes under /api/entries/ take an entry id, so helper lists live at /api/top-entries etc.
# (an entry is literally called "top").
@api.get("/api/entries", tags=["Catalog"], summary="Search entries")
def list_entries(
    q: Optional[str] = Query(None, description="Free text; every word must match (prefix)"),
    category: Optional[str] = Query(None, description="Category id (primary or secondary domain)"),
    kind: Optional[str] = Query(None, description="Type: ontology, schema, vocabulary, atlas, data-standard or knowledge-base"),
    grade: Optional[str] = Query(None, description="A–E, or 'none' for not evaluated"),
    format: Optional[str] = Query(None, description="File format, e.g. OWL, OBO, JSON-LD, LinkML, JSON Schema"),
    registry: Optional[str] = Query(None, description="Where the record came from, e.g. OBO Foundry, OLS (EMBL-EBI), Bioregistry, curated"),
    legacy: bool = Query(True, description="Include legacy resources"),
    sort: Optional[store.SortKey] = Query(None, description="score, fair, name, activity or adopters; by default best match when q is given, else score"),
    page: int = Query(1, ge=1, description="Page number, from 1"),
    size: int = Query(24, ge=1, le=store.MAX_PAGE_SIZE, description="Results per page, up to 100"),
):
    return store.search(q=q, category=category, kind=kind, grade=grade, format=format, registry=registry, include_legacy=legacy, sort=sort, page=page, size=size)


@api.get("/api/top-entries", tags=["Catalog"], summary="Top entries")
def top_entries(n: int = Query(8, ge=1, le=50), category: Optional[str] = None):
    return store.top(n, category)


@api.get("/api/recent-entries", tags=["Catalog"], summary="Recently active")
def recent_entries(n: int = Query(8, ge=1, le=50)):
    return store.recently_active(n)


@api.get("/api/entry-ids", tags=["Catalog"], summary="Entry ids")
def entry_ids():
    """All entry ids (for sitemaps and bulk clients)."""
    return store.ids()


@api.get("/api/entries/{entry_id}", tags=["Catalog"], summary="Get entry")
def get_entry(entry_id: str):
    d = store.entry(entry_id)
    if d is None:
        raise HTTPException(404, "Entry not found")
    return d


@api.get("/api/entries/{entry_id}/history", tags=["Runs"], summary="Entry history")
def get_history(entry_id: str):
    from .derived import changes

    h = store.history(entry_id)
    return {"runs": h, "changes": changes(h)}


@api.get("/api/runs", tags=["Runs"], summary="List runs")
def list_runs(limit: int = Query(50, ge=1, le=500)):
    return store.runs(limit)


@api.get("/api/runs/{run_id}", tags=["Runs"], summary="Get run")
def get_run(run_id: str, page: int = Query(1, ge=1), size: int = Query(100, ge=1, le=500)):
    r = store.run(run_id, page, size)
    if r is None:
        raise HTTPException(404, "Run not found")
    return r
