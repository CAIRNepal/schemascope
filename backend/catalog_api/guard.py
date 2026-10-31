"""Request guard in front of the API and MCP: authentication, scopes, rate limits, problem+json errors.

- /api/…: anonymous callers get RATE_LIMIT_ANON requests per minute per IP; callers with a session JWT or an
  `api`-scoped personal access token get RATE_LIMIT_USER per minute per user.
- /mcp/…: requires a personal access token with the `mcp` scope.
- /api/site-data: only for the site server on a trusted host (it is the whole catalog at once).
Every response under /api and /mcp carries X-RateLimit-Limit / -Remaining / -Reset.
"""
from __future__ import annotations

import json
import threading
import time

from fastapi import HTTPException
from starlette.requests import Request

from . import settings
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


class Window:
    """Fixed one-minute windows per key. In memory: limits apply per API process."""

    def __init__(self):
        self.lock = threading.Lock()
        self.counts: dict[str, tuple[int, int]] = {}

    def hit(self, key: str, limit: int) -> tuple[bool, int, int]:
        minute = int(time.time() // 60)
        with self.lock:
            start, n = self.counts.get(key, (minute, 0))
            if start != minute:
                start, n = minute, 0
            n += 1
            self.counts[key] = (start, n)
            if len(self.counts) > 50_000:  # drop stale windows
                self.counts = {k: v for k, v in self.counts.items() if v[0] == minute}
        return n <= limit, max(0, limit - n), (minute + 1) * 60


window = Window()


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
        if not (is_api or is_mcp) or path.startswith(EXEMPT):
            return await self.app(scope, receive, send)
        if path == "/api/site-data":
            if is_internal(scope):
                return await self.app(scope, receive, send)
            return await self._reply(send, *problem(403, "Forbidden", "For the site server only. Use /api/entries and /api/entries/{id}.", path))

        request = Request(scope)
        try:
            principal = resolve(request)
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

        limit = limit_for(principal.user if principal else None)
        key = f"user:{principal.user.id}" if principal else f"ip:{client_ip(scope)}"
        ok, remaining, reset = window.hit(key, limit)
        rl = {"x-ratelimit-limit": str(limit), "x-ratelimit-remaining": str(remaining), "x-ratelimit-reset": str(reset)}
        if not ok:
            hint = "" if principal else f" Sign in and use a token for {rate_limits()['authenticatedPerMinute']} requests per minute: {settings.PUBLIC_SITE_URL}/account/"
            return await self._reply(send, *problem(429, TITLES[429], f"Rate limit of {limit} requests per minute exceeded.{hint}", path,
                                                    {**rl, "retry-after": str(max(1, reset - int(time.time())))}))

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
