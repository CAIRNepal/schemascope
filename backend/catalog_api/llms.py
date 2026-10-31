"""Docs for LLMs, following the llms.txt convention (https://llmstxt.org):

- `/llms.txt`: a short Markdown index (what the catalog is, how to access it, one line per endpoint and tool).
- `/llms-full.txt`: the complete reference in one Markdown file, to paste into an AI assistant or add to an editor's
  docs index, so it can write working integration code.

Both are generated from the OpenAPI document (with the descriptions in docs_text.py) and the MCP tools' docstrings,
so they never drift from the API. URLs use PUBLIC_SITE_URL.
"""
from __future__ import annotations

import inspect
import time

from . import accounts, mcp_server, settings, store

TOOLS = ["search_catalog", "get_entry", "get_entry_history", "list_categories", "catalog_stats", "scoring_rubric"]
_cache: dict[str, tuple[float, str]] = {}
TTL = 60


def _site() -> tuple[str, str, str]:
    cfg = settings.site_config()
    brand = cfg.get("brand") or cfg.get("name") or "Catalog"
    return brand, (settings.PUBLIC_SITE_URL or cfg.get("url", "")).rstrip("/"), cfg.get("description", "")


def _limits() -> dict:
    try:
        return accounts.rate_limits()
    except Exception:
        return {"anonymousPerMinute": settings.RATE_LIMIT_ANON, "authenticatedPerMinute": settings.RATE_LIMIT_USER}


def _samples() -> dict:
    s = {"name": "roadmap"}
    try:
        top = store.top(1, None)
        if top:
            s["entry_id"] = top[0]["id"]
        cats = store.categories()
        if cats:
            s["cat_id"] = s["category"] = cats[0]["id"]
        runs = store.runs(1)
        if runs:
            s["run_id"] = runs[0]["id"]
    except Exception:
        pass
    return s


def _ops(spec: dict):
    """(tag, method, path, op) in the order of the tags."""
    for tag in spec.get("tags", []):
        for path, item in spec["paths"].items():
            for method, op in item.items():
                if (op.get("tags") or [""])[0] == tag["name"]:
                    yield tag["name"], method, path, op


def _needs_auth(path: str) -> bool:
    return path.startswith(("/api/tokens", "/api/submissions", "/api/admin", "/api/audit", "/api/auth/me", "/api/auth/token", "/api/auth/activity"))


def _example(origin: str, method: str, path: str, op: dict, samples: dict) -> str:
    url = path
    query = []
    for p in op.get("parameters", []):
        v = samples.get(p["name"])
        if p["in"] == "path":
            url = url.replace("{" + p["name"] + "}", v or f"<{p['name']}>")
        elif p["name"] == "q":
            query.append("q=anatomy")
        elif p["name"] in ("size", "n", "limit"):
            query.append(f"{p['name']}=5")
    url = origin + url + ("?" + "&".join(query) if query else "")
    lines = [f'curl{"" if method == "get" else " -X " + method.upper()} "{url}"']
    if _needs_auth(path):
        lines.append('  -H "Authorization: Bearer $TOKEN"')
    if op.get("requestBody"):
        lines.append('  -H "Content-Type: application/json" -d \'{…}\'')
    return " \\\n".join(lines)


def _type(sch: dict) -> str:
    return sch.get("type") or " | ".join(x.get("type") for x in sch.get("anyOf", []) if x.get("type") and x.get("type") != "null") or "string"


def _tool_doc(name: str) -> tuple[str, str]:
    fn = getattr(mcp_server, name)
    sig = ", ".join(
        p.name + ("" if p.default is inspect.Parameter.empty else f"={p.default!r}") for p in inspect.signature(fn).parameters.values()
    )
    return f"{name}({sig})", inspect.cleandoc(fn.__doc__ or "")


def _cached(key: str, build) -> str:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    text = build()
    _cache[key] = (time.monotonic(), text)
    return text


def llms_txt(spec: dict) -> str:
    return _cached("index", lambda: _index(spec))


def llms_full_txt(spec: dict) -> str:
    return _cached("full", lambda: _full(spec))


def _index(spec: dict) -> str:
    brand, origin, desc = _site()
    lim = _limits()
    out = [
        f"# {brand}",
        "",
        f"> {desc}".rstrip(),
        "",
        f"{brand} has a public REST API (JSON over HTTPS) and an MCP server for AI assistants. Reading the catalog needs no "
        f"account: {lim['anonymousPerMinute']} requests per minute per IP. A personal access token (sign in with GitHub at "
        f"{origin}/account/) raises this to {lim['authenticatedPerMinute']} per minute and is required for the MCP server. "
        "Send it as `Authorization: Bearer <token>`. Errors are RFC 7807 problem+json.",
        "",
        "## Docs",
        "",
        f"- [Full reference for LLMs]({origin}/llms-full.txt): every endpoint, parameter and MCP tool in one Markdown file",
        f"- [Developer hub]({origin}/api-docs/): quickstart, authentication, rate limits and fair use, interactive endpoint pages",
        f"- [OpenAPI document]({origin}/openapi.json): machine-readable API description",
        "",
        "## REST API",
        "",
    ]
    for _tag, method, path, op in _ops(spec):
        first = (op.get("description") or op.get("summary") or "").split("\n\n")[0]
        out.append(f"- `{method.upper()} {path}`: {op.get('summary', '')}. {first}".rstrip())
    out += ["", "## MCP server", "", f"Endpoint: `{origin}/mcp/` (streamable HTTP, header `Authorization: Bearer <token with MCP access>`). Tools:", ""]
    for name in TOOLS:
        sig, doc = _tool_doc(name)
        out.append(f"- `{name}`: {doc.splitlines()[0] if doc else ''}")
    out += ["", "## Optional", "", f"- [Scoring rubric and site details]({origin}/api/meta)", f"- [Catalog statistics]({origin}/api/stats)", ""]
    return "\n".join(out)


def _full(spec: dict) -> str:
    brand, origin, desc = _site()
    lim = _limits()
    samples = _samples()
    prefix = settings.TOKEN_PREFIX
    env = "".join(c if c.isalnum() else "_" for c in brand.upper()) + "_TOKEN"
    out = [
        f"# {brand} API and MCP reference",
        "",
        f"> {desc}".rstrip(),
        "",
        "This file is written for AI assistants and the developers using them: paste it into a chat, or add its URL to "
        "your editor's docs, so the assistant can write working code against this API. It is generated from the live "
        f"API description and is always current. Human-friendly docs with interactive examples: {origin}/api-docs/",
        "",
        "## Essentials",
        "",
        f"- Base URL: `{origin}`. All endpoints are under `/api/` and return JSON.",
        "- Reading the catalog is public; no account is needed.",
        f"- Rate limits: {lim['anonymousPerMinute']} requests per minute per IP without a token; {lim['authenticatedPerMinute']} "
        "per minute per user with a token. Every response has `X-RateLimit-Limit`, `X-RateLimit-Remaining` and "
        "`X-RateLimit-Reset`. Over the limit you get `429` with `Retry-After` (seconds): wait that long, then retry.",
        f"- Tokens: sign in with GitHub at {origin}/account/ and create a personal access token (starts with `{prefix}`). "
        "Choose `api` access for the REST API and `mcp` access for the MCP server. Send `Authorization: Bearer <token>`. "
        "Keep it in an environment variable, never in code.",
        "- Errors are `application/problem+json` (RFC 7807): `{\"type\", \"title\", \"status\", \"detail\", \"instance\"}`. "
        "401 = missing or invalid token, 403 = token lacks the scope, 404 = not found, 422 = invalid parameters, "
        "429 = rate limited, 503 = catalog not loaded.",
        "- Lists: `GET /api/entries` pages with `page` (from 1) and `size` (up to 100) and returns `total`; loop until "
        "`page * size >= total`.",
        "",
        "## Fair use",
        "",
        "This is a free, shared service. Please: cache responses (data changes after each evaluation run, not by the "
        "minute); use `GET /api/entry-ids` or a run snapshot for bulk work instead of crawling; back off on 429; send a "
        "token so usage can be attributed; do not work around the limits with many IPs or tokens; credit the catalog and "
        f"each resource's own license. Need more? Ask: {origin}/contact/",
        "",
        "## Typical integration",
        "",
        "1. Search: `GET /api/entries?q=<words>&sort=score&size=10` returns `items` (id, name, grade, score, formats) and `facets`.",
        "2. Details: `GET /api/entries/{entry_id}` returns the record, evaluation facts, adopters, imports and related resources.",
        "3. History: `GET /api/entries/{entry_id}/history` returns the score in every evaluation run and what changed.",
        "4. Domains: `GET /api/categories` gives the ids to use as the `category` filter.",
        "",
        "```python",
        "import os, requests",
        "",
        f'BASE = "{origin}"',
        f'TOKEN = os.environ.get("{env}")  # optional: a personal access token raises the rate limit',
        'headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}',
        "",
        'r = requests.get(f"{BASE}/api/entries", params={"q": "anatomy", "sort": "score", "size": 5}, headers=headers)',
        "r.raise_for_status()",
        'for item in r.json()["items"]:',
        '    print(item["id"], item["grade"], item["score"], item["name"])',
        "```",
        "",
        "## REST API endpoints",
        "",
    ]
    schemas = spec.get("components", {}).get("schemas", {})
    current = None
    for tag, method, path, op in _ops(spec):
        if tag != current:
            out += [f"### {tag}", ""]
            current = tag
        out += [f"#### {op.get('summary', path)}: `{method.upper()} {path}`", ""]
        out.append("Authentication: " + ("required (signed-in session or token)." if _needs_auth(path) else "none needed (a token raises the rate limit)."))
        out += ["", (op.get("description") or "").strip(), ""]
        params = op.get("parameters", [])
        if params:
            out += ["| Parameter | In | Type | Required | Description |", "|---|---|---|---|---|"]
            for p in params:
                sch = p.get("schema", {})
                d = (p.get("description") or "").replace("|", "\\|")
                if sch.get("default") is not None:
                    d += f" Default: `{sch['default']}`."
                out.append(f"| `{p['name']}` | {p['in']} | {_type(sch)} | {'yes' if p.get('required') else 'no'} | {d} |")
            out.append("")
        ref = (op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {}) or {}).get("$ref")
        if ref:
            body = schemas.get(ref.split("/")[-1], {})
            out += ["Request body (JSON):", "", "| Field | Type | Required | Description |", "|---|---|---|---|"]
            for k, v in body.get("properties", {}).items():
                out.append(f"| `{k}` | {_type(v)} | {'yes' if k in body.get('required', []) else 'no'} | {(v.get('description') or '').replace('|', chr(92) + '|')} |")
            out.append("")
        out += ["```bash", _example(origin, method, path, op, samples), "```", ""]
    out += [
        "## MCP server",
        "",
        f"- URL: `{origin}/mcp/` (streamable HTTP transport).",
        "- Header: `Authorization: Bearer <token>`; the token needs `mcp` access.",
        "- All tools are read-only.",
        "",
        "Claude Code:",
        "",
        "```bash",
        f'claude mcp add --transport http {brand.lower().replace(" ", "-")} {origin}/mcp/ --header "Authorization: Bearer ${env}"',
        "```",
        "",
        "Cursor (`~/.cursor/mcp.json`) and most JSON-configured clients:",
        "",
        "```json",
        "{ \"mcpServers\": { \"" + brand.lower().replace(" ", "-") + "\": { \"url\": \"" + origin + "/mcp/\", \"headers\": { \"Authorization\": \"Bearer <token>\" } } } }",
        "```",
        "",
        "### Tools",
        "",
    ]
    for name in TOOLS:
        sig, doc = _tool_doc(name)
        out += [f"#### `{sig}`", "", doc, ""]
    return "\n".join(out).rstrip() + "\n"
