"""HTTP API (/api/...) and MCP endpoint (/mcp/) for the catalog.

    uvicorn catalog_api.app:app --reload --port 8000

`app` is the FastAPI application wrapped in the request guard (authentication, scopes, rate limits).
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from mcp.server.transport_security import TransportSecuritySettings

from . import auth, chat, docs_text, llms, recommend, settings, store
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
    from anyio import to_thread

    from . import db

    # Build the OpenAPI document once, off the event loop (it reads one category id with the sync pool).
    try:
        await to_thread.run_sync(api.openapi)
    except Exception:
        api.openapi_schema = None
    async with mcp.session_manager.run():
        yield
    await db.aclose()


BRAND = site_config().get("brand") or site_config().get("name", "Catalog")
TAGS = [
    {"name": "Catalog", "description": "Search and read entries, categories and how domains connect."},
    {"name": "Runs", "description": "Evaluation runs and each entry's history across them."},
    {"name": "Auth", "description": "Sign in with GitHub, sessions and who you are."},
    {"name": "API tokens", "description": "Personal access tokens for scripts and MCP clients."},
    {"name": "Submissions", "description": "Add or correct catalog entries (signed in)."},
    {"name": "Admin", "description": "Superadmins: rate limits for everyone and per user."},
    {"name": "Recommend", "description": "Which resource should I use? Guided recommendations and a chat assistant."},
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
api.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["*"],
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


# Docs for LLMs (llms.txt convention): a short index and the full reference as Markdown, from the OpenAPI document.
@api.get("/llms.txt", include_in_schema=False)
async def get_llms_txt():
    return PlainTextResponse(await llms.llms_txt(api.openapi()), media_type="text/plain; charset=utf-8", headers={"Cache-Control": "public, max-age=300"})


@api.get("/llms-full.txt", include_in_schema=False)
async def get_llms_full_txt():
    return PlainTextResponse(await llms.llms_full_txt(api.openapi()), media_type="text/plain; charset=utf-8", headers={"Cache-Control": "public, max-age=300"})


@api.get("/api/health", tags=["Meta"], summary="Health")
async def health():
    m = await store.meta()
    return {"ok": True, "ingestedAt": m["ingestedAt"], "evaluation": m["evaluation"]}


@api.get("/api/meta", tags=["Meta"], summary="Meta & rubric")
async def get_meta():
    """Site configuration, the latest evaluation run and the scoring rubric."""
    return await store.meta()


@api.get("/api/content/{name}", tags=["Meta"], summary="Content document")
async def get_content(name: str):
    """Data behind the content pages: `roadmap` (data/roadmap.json) and `validation` (data/validation/report.json)."""
    doc = await store.content(name)
    if doc is None:
        raise HTTPException(404, f"No {name} document in this catalog")
    return doc


@api.get("/api/site-data", include_in_schema=False)
async def get_site_data():
    """Bulk data for the web server's page templates (large; not meant for other clients)."""
    return Response(await store.site_data(), media_type="application/json")


@api.get("/api/runs/{run_id}/snapshot", tags=["Runs"], summary="Run snapshot")
async def get_run_snapshot(run_id: str):
    """The archived run file as written by the evaluator: every entry's facts and scores in that run."""
    f = store.run_file(run_id)
    if f is None:
        raise HTTPException(404, "Run not found")
    return FileResponse(f, media_type="application/json")


@api.get("/api/domain-graph", tags=["Catalog"], summary="Domain graph")
async def get_domain_graph():
    """How domains connect: nodes (domains, with reach), weighted edges (shared resources + imports), bridges."""
    return await store.domain_graph()


@api.get("/api/stats", tags=["Catalog"], summary="Stats")
async def get_stats():
    return await store.stats()


@api.get("/api/categories", tags=["Catalog"], summary="List categories")
async def get_categories():
    return await store.categories()


@api.get("/api/categories/{cat_id}", tags=["Catalog"], summary="Get category")
async def get_category(cat_id: str):
    c = await store.category(cat_id)
    if c is None:
        raise HTTPException(404, "Category not found")
    return c


# Note: routes under /api/entries/ take an entry id, so helper lists live at /api/top-entries etc.
# (an entry is literally called "top").
@api.get("/api/entries", tags=["Catalog"], summary="Search entries")
async def list_entries(
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
    return await store.search(q=q, category=category, kind=kind, grade=grade, format=format, registry=registry, include_legacy=legacy, sort=sort, page=page, size=size)


@api.get("/api/top-entries", tags=["Catalog"], summary="Top entries")
async def top_entries(n: int = Query(8, ge=1, le=50), category: Optional[str] = None):
    return await store.top(n, category)


@api.get("/api/recent-entries", tags=["Catalog"], summary="Recently active")
async def recent_entries(n: int = Query(8, ge=1, le=50)):
    return await store.recently_active(n)


@api.get("/api/entry-ids", tags=["Catalog"], summary="Entry ids")
async def entry_ids():
    """All entry ids (for sitemaps and bulk clients)."""
    return await store.ids()


@api.get("/api/entries/{entry_id}", tags=["Catalog"], summary="Get entry")
async def get_entry(entry_id: str):
    d = await store.entry(entry_id)
    if d is None:
        raise HTTPException(404, "Entry not found")
    return d


@api.get("/api/entries/{entry_id}/history", tags=["Runs"], summary="Entry history")
async def get_history(entry_id: str):
    from .derived import changes

    h = await store.history(entry_id)
    return {"runs": h, "changes": changes(h)}


@api.get("/api/runs", tags=["Runs"], summary="List runs")
async def list_runs(limit: int = Query(50, ge=1, le=500)):
    return await store.runs(limit)


@api.get("/api/runs/{run_id}", tags=["Runs"], summary="Get run")
async def get_run(run_id: str, page: int = Query(1, ge=1), size: int = Query(100, ge=1, le=500)):
    r = await store.run(run_id, page, size)
    if r is None:
        raise HTTPException(404, "Run not found")
    return r


# ---------- recommendations ----------
from pydantic import BaseModel, Field  # noqa: E402


@api.get("/api/recommend/options", tags=["Recommend"], summary="Recommendation options")
async def recommend_options():
    return await recommend.options()


@api.get("/api/recommend", tags=["Recommend"], summary="Recommend resources")
async def get_recommendations(
    q: Optional[str] = Query(None, max_length=600),
    category: Optional[str] = None,
    kind: Optional[str] = None,
    format: Optional[str] = None,
    min_grade: Optional[str] = Query(None, pattern="^[A-E]$"),
    maintained: bool = False,
    open_license: bool = False,
    used: bool = False,
    limit: int = Query(8, ge=1, le=20),
    page: int = Query(1, ge=1, le=20),
    sort: Optional[str] = Query(None, pattern="^(relevance|score)$"),
):
    return await recommend.recommend(q, limit=limit, page=page, sort=sort, category=category, kind=kind, format=format, min_grade=min_grade,
                               maintained=maintained, open_license=open_license, used=used)


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=2000)


class ChatIn(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=20, description="The conversation so far; the last message is the user's question.")
    chat_id: Optional[str] = Field(None, max_length=40, description="Signed in: the saved chat to continue. Omit to start a new one.")
    session: Optional[str] = Field(None, max_length=64, description="A random id for this browser session, grouping turns in the anonymous chat log.")


class _ChatWindow:
    """Chat turns per minute, per user or IP (answers cost CPU time, so this is tighter than the API limit)."""

    def __init__(self):
        self.counts: dict[str, tuple[int, int]] = {}

    def hit(self, key: str, limit: int) -> int:
        import time as _t

        minute = int(_t.time() // 60)
        m, n = self.counts.get(key, (minute, 0))
        n = n + 1 if m == minute else 1
        self.counts[key] = (minute, n)
        if len(self.counts) > 20000:
            self.counts = {k: v for k, v in self.counts.items() if v[0] == minute}
        return 0 if n <= limit else 60 - int(_t.time() % 60)


_chat_window = _ChatWindow()


@api.get("/api/recommend/chat/status", tags=["Recommend"], summary="Chat status")
async def chat_status():
    return {**chat.status(), "available": await chat.available()}


@api.post("/api/recommend/chat", tags=["Recommend"], summary="Ask for a recommendation")
async def chat_turn(request: Request, body: ChatIn):
    p = await auth.resolve(request)
    key, limit = (f"u{p.user.id}", settings.CHAT_RATE_USER) if p else (f"ip{auth.client_ip(request.scope)}", settings.CHAT_RATE_ANON)
    wait = _chat_window.hit(key, limit)
    if wait:
        raise HTTPException(429, f"Chat limit of {limit} questions per minute reached. Please wait {wait} seconds"
                                 + ("" if p else ", or sign in for a higher limit") + ".", headers={"Retry-After": str(wait)})
    if not any(m.role == "user" and m.content.strip() for m in body.messages[-1:]):
        raise HTTPException(422, "The last message must be the user's question")
    log = p.user.improve_search if p else True
    return StreamingResponse(chat.stream([m.model_dump() for m in body.messages], p.user.id if p else None, body.chat_id, log=log, session=body.session),
                             media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ---------- saved chats (signed in) ----------
from . import chats as chat_store  # noqa: E402


class ChatTitleIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)


@api.get("/api/chats", tags=["Recommend"], summary="My saved chats")
async def list_chats(p: auth.Principal = Depends(auth.require_user)):
    return await chat_store.list_for(p.user.id)


@api.get("/api/chats/{chat_id}", tags=["Recommend"], summary="Open a saved chat")
async def get_chat(chat_id: str, p: auth.Principal = Depends(auth.require_user)):
    c = await chat_store.get(p.user.id, chat_id)
    if not c:
        raise HTTPException(404, "No such chat")
    return c


@api.patch("/api/chats/{chat_id}", tags=["Recommend"], summary="Rename a saved chat")
async def rename_chat(chat_id: str, body: ChatTitleIn, p: auth.Principal = Depends(auth.require_user)):
    if not await chat_store.rename(p.user.id, chat_id, body.title):
        raise HTTPException(404, "No such chat")
    return {"id": chat_id, "title": body.title.strip()}


@api.delete("/api/chats/{chat_id}", tags=["Recommend"], summary="Delete a saved chat", status_code=204)
async def delete_chat(chat_id: str, p: auth.Principal = Depends(auth.require_user)):
    if not await chat_store.delete(p.user.id, chat_id):
        raise HTTPException(404, "No such chat")
    return Response(status_code=204)


# ---------- chat feedback and logging preference ----------
from . import chatlog  # noqa: E402


class FeedbackIn(BaseModel):
    rating: Optional[int] = Field(None, ge=-1, le=1, description="1 good, -1 bad")
    comment: Optional[str] = Field(None, max_length=2000)


class TurnFeedbackIn(FeedbackIn):
    question: str = Field(max_length=2000)
    answer: str = Field("", max_length=8000)
    resultIds: list[str] = Field(default_factory=list, max_length=20)
    session: Optional[str] = Field(None, max_length=64)


@api.post("/api/recommend/chat/feedback", tags=["Recommend"], summary="Rate an answer that wasn't logged", status_code=201)
async def chat_feedback_new(body: TurnFeedbackIn):
    """For answers that weren't logged (logging off, or older saved chats): giving feedback logs that one question and
    answer, without identity, together with the feedback."""
    if body.rating is None and not (body.comment or "").strip():
        raise HTTPException(422, "Send a rating, a comment or both")
    lid = await chatlog.log_turn(body.session, body.question, {}, body.resultIds, body.answer, None)
    await chatlog.feedback(lid, body.rating, body.comment)
    return {"id": lid}


@api.post("/api/recommend/chat/feedback/{log_id}", tags=["Recommend"], summary="Rate an answer", status_code=204)
async def chat_feedback(log_id: str, body: FeedbackIn):
    if body.rating is None and not (body.comment or "").strip():
        raise HTTPException(422, "Send a rating, a comment or both")
    if not await chatlog.feedback(log_id, body.rating, body.comment):
        raise HTTPException(404, "No such answer (it may not have been logged)")
    return Response(status_code=204)


class PrefsIn(BaseModel):
    improveSearch: bool = Field(description="Let your chats be logged, without your identity, to improve recommendations.")


@api.put("/api/auth/preferences", tags=["Auth"], summary="Update preferences")
async def update_prefs(request: Request, body: PrefsIn, p: auth.Principal = Depends(auth.require_user)):
    from . import accounts

    await accounts.set_improve_search(p.user, body.improveSearch)
    await auth._audit(request, "account.preferences", p.user, improveSearch=body.improveSearch)
    return {"improveSearch": body.improveSearch}


# ---------- search logs (anonymous) ----------
class SearchLogIn(BaseModel):
    source: str = Field(pattern="^(guided|search|catalog)$", description="Where the search happened")
    q: Optional[str] = Field(None, max_length=500)
    filters: dict = Field(default_factory=dict)
    resultCount: int = Field(0, ge=0)
    resultIds: list[str] = Field(default_factory=list, max_length=20)
    clicked: list[str] = Field(default_factory=list, max_length=5, description="A result opened before the search was logged")
    session: Optional[str] = Field(None, max_length=64)


class ClickIn(BaseModel):
    entryId: str = Field(max_length=100)


async def _may_log(request: Request) -> bool:
    try:
        p = await auth.resolve(request)
    except HTTPException:
        p = None
    return p.user.improve_search if p else True


@api.post("/api/logs/search", tags=["Recommend"], summary="Log a search")
async def log_search(request: Request, body: SearchLogIn):
    if not await _may_log(request):
        return {"id": None}
    filters = {k: v for k, v in body.filters.items() if isinstance(k, str) and len(k) < 40 and isinstance(v, (str, bool, int)) and len(str(v)) < 200}
    lid = await chatlog.log_search(body.session, body.source, body.q, filters, body.resultCount, body.resultIds)
    for c in body.clicked:
        await chatlog.click(lid, c)
    return {"id": lid}


@api.post("/api/logs/search/{log_id}/click", tags=["Recommend"], summary="Log a click on a search result", status_code=204)
async def log_click(log_id: str, body: ClickIn):
    await chatlog.click(log_id, body.entryId)
    return Response(status_code=204)


# ---------- superadmin: logs and feedback, with exports ----------
def _export(rows: list[dict], fmt: str, name: str) -> Response:
    import csv
    import io

    if fmt == "jsonl":
        text = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + ("\n" if rows else "")
        return Response(text, media_type="application/x-ndjson; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}.jsonl"'})
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0]))
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v) for k, v in r.items()})
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


async def _admin(request: Request) -> auth.Principal:
    p = await auth.require_session(request)
    auth.require_superadmin(p)
    return p


@api.get("/api/admin/logs/summary", tags=["Admin"], summary="Logs and feedback summary")
async def admin_logs_summary(p: auth.Principal = Depends(_admin)):
    return await chatlog.summary()


@api.get("/api/admin/logs/chats", tags=["Admin"], summary="Chat log")
async def admin_logs_chats(rating: Optional[str] = Query(None, pattern="^(good|bad|comment|rated)$"), q: Optional[str] = None,
                           before: Optional[str] = None, limit: int = Query(50, ge=1, le=500), p: auth.Principal = Depends(_admin)):
    return await chatlog.chat_rows(rating, q, before, limit)


@api.get("/api/admin/logs/searches", tags=["Admin"], summary="Search log")
async def admin_logs_searches(source: Optional[str] = Query(None, pattern="^(guided|search|catalog)$"), q: Optional[str] = None, empty: bool = False,
                              before: Optional[str] = None, limit: int = Query(50, ge=1, le=500), p: auth.Principal = Depends(_admin)):
    return await chatlog.search_rows(source, q, before, limit, empty)


@api.get("/api/admin/logs/export/{kind}.{fmt}", tags=["Admin"], summary="Export logs")
async def admin_logs_export(request: Request, kind: str, fmt: str, p: auth.Principal = Depends(_admin)):
    if kind not in ("chats", "searches") or fmt not in ("csv", "jsonl"):
        raise HTTPException(404, "Use chats or searches, and csv or jsonl")
    rows = await (chatlog.chat_rows(limit=10000) if kind == "chats" else chatlog.search_rows(limit=10000))
    await auth._audit(request, "admin.export", p.user, f"{kind}.{fmt}", rows=len(rows))
    return _export(rows, fmt, f"{kind}-log")
