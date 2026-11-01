"""Request guard in front of the API and MCP: authentication, scopes, rate limits, problem+json errors.

- /api/…: anonymous callers get RATE_LIMIT_ANON requests per minute per IP; callers with a session JWT or an
  `api`-scoped personal access token get RATE_LIMIT_USER per minute per user.
- /mcp/…: requires a personal access token with the `mcp` scope.
- /api/site-data: only for the site server on a trusted host (it is the whole catalog at once).
Every response under /api and /mcp carries X-RateLimit-Limit / -Remaining / -Reset.

Counting and abuse protection live in rate.py: counts are shared by all workers through the database, keyed by account
(or a hash of the IP when signed out); the block list and a per-IP ceiling are checked before any token lookup.
"""
from __future__ import annotations

import json
import time

from fastapi import HTTPException
from starlette.requests import Request

from . import rate, settings
from .accounts import limit_for, rate_limits
from .auth import client_ip, resolve

# Sign-in, health checks and the superadmin endpoints never count (a superadmin must always be able to undo a
# limit that was set too low); the admin endpoints still require a superadmin session.
EXEMPT = ("/api/health", "/api/auth/", "/api/admin/")


def problem(status: int, title: str, detail: str, instance: str = "", headers: dict | None = None) -> tuple[int, dict, bytes]:
    body = json.dumps({"type": "about:blank", "title": title, "status": status, "detail": detail, "instance": instance}).encode()
    return status, {"content-type": "application/problem+json", **(headers or {})}, body


TITLES = {400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
          422: "Unprocessable Content", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable"}




def is_internal(scope) -> bool:
    """A direct request from the site server (trusted host, not forwarded on behalf of a visitor)."""
    host = (scope.get("client") or ("", 0))[0]
    return settings.is_trusted_proxy(host) and not any(k == b"x-forwarded-for" for k, _ in scope.get("headers") or [])


class Guard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        is_api, is_mcp = path.startswith("/api/"), path == "/mcp" or path.startswith("/mcp/")
        if not (is_api or is_mcp) or path == "/api/health":
            return await self.app(scope, receive, send)
        if path == "/api/site-data":
            if is_internal(scope):
                return await self.app(scope, receive, send)
            return await self._reply(send, *problem(403, "Forbidden", "For the site server only. Use /api/entries and /api/entries/{id}.", path))

        # 1. Before anything touches the database: the block list and the per-IP ceiling (applies to every path, sign-in
        #    and admin included, so floods of requests or fake tokens are refused cheaply).
        reset_at = (rate.minute() + 1) * 60
        ipk = rate.ip_key(client_ip(scope)) if not is_internal(scope) else None
        if ipk:
            wait = rate.blocked(ipk)
            if wait:
                return await self._reply(send, *problem(429, TITLES[429], f"Too many requests from your network; temporarily blocked for {int(wait // 60) + 1} more minute(s).",
                                                        path, {"retry-after": str(int(wait) + 1)}))
            n_ip = rate.count(ipk)
            if n_ip > settings.RATE_IP_CEILING:
                await rate.note_over(ipk, n_ip, settings.RATE_IP_CEILING)
                return await self._reply(send, *problem(429, TITLES[429], f"Too many requests from your network ({settings.RATE_IP_CEILING} per minute at most).",
                                                        path, {"retry-after": str(max(1, reset_at - int(time.time())))}))
        if path.startswith(EXEMPT):
            return await self.app(scope, receive, send)

        # 2. Who is calling (token or session), scopes.
        request = Request(scope)
        try:
            principal = await resolve(request)
        except HTTPException as e:
            return await self._reply(send, *problem(e.status_code, TITLES.get(e.status_code, "Error"), e.detail, path, e.headers))
        if is_mcp:
            if principal is None or principal.kind != "token" or "mcp" not in principal.scopes:
                detail = ("Send a personal access token with the `mcp` scope: Authorization: Bearer "
                          f"{settings.TOKEN_PREFIX}…  Create one at {settings.PUBLIC_SITE_URL}/account/")
                return await self._reply(send, *problem(401 if principal is None else 403, TITLES[401 if principal is None else 403], detail, path,
                                                        {"www-authenticate": 'Bearer realm="mcp"'}))
        elif principal and principal.kind == "token" and "api" not in principal.scopes:
            return await self._reply(send, *problem(403, "Forbidden", "This token does not have the `api` scope.", path))

        # 3. The caller's own limit: per account (sessions and tokens share it), or per IP when signed out.
        limit = await limit_for(principal.user if principal else None)
        if principal:
            key = rate.user_key(principal.user.id)
            wait = rate.blocked(key)
            if wait:
                return await self._reply(send, *problem(429, TITLES[429], f"This account is temporarily blocked for {int(wait // 60) + 1} more minute(s) after too many requests.",
                                                        path, {"retry-after": str(int(wait) + 1)}))
            n = rate.count(key)
        else:
            key, n = (ipk, n_ip) if ipk else (None, 0)
        rl = {"x-ratelimit-limit": str(limit), "x-ratelimit-remaining": str(max(0, limit - n)), "x-ratelimit-reset": str(reset_at)}
        if key and n > limit:
            now_blocked = await rate.note_over(key, n, limit)
            hint = "" if principal else f" Sign in and use a token for {(await rate_limits())['authenticatedPerMinute']} requests per minute: {settings.PUBLIC_SITE_URL}/account/"
            extra = f" Blocked for {settings.RATE_BLOCK_MINUTES} minutes for sending far too many." if now_blocked else ""
            return await self._reply(send, *problem(429, TITLES[429], f"Rate limit of {limit} requests per minute exceeded.{extra}{hint}", path,
                                                    {**rl, "retry-after": str(max(1, reset_at - int(time.time())))}))

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers") or []) + [(k.encode(), v.encode()) for k, v in rl.items()]
            await send(message)

        return await self.app(scope, receive, send_with_headers)

    @staticmethod
    async def _reply(send, status, headers, body):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(k.encode(), v.encode()) for k, v in {**headers, "content-length": str(len(body))}.items()]})
        await send({"type": "http.response.body", "body": body})
