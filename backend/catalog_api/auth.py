"""Sign-in with GitHub, session JWTs, personal access tokens and authenticated submissions.

Two kinds of credentials, both sent as `Authorization: Bearer …` (browsers also send the session as a cookie):
  - session JWTs (HS256), issued after GitHub sign-in, valid SESSION_HOURS; used by people and the site;
  - personal access tokens (<prefix>_pat_…), created on the account page, scoped (`api`, `mcp`), revocable.
"""
from __future__ import annotations

import json
import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from . import accounts, settings
from .accounts import User

SESSION_COOKIE = "session"
STATE_COOKIE = "oauth_state"


@dataclass
class Principal:
    user: User
    kind: str  # "session" | "token"
    scopes: list[str] = field(default_factory=list)


# ---------- JWT ----------
def issue_jwt(user: User) -> tuple[str, int]:
    exp = int(time.time() + settings.SESSION_HOURS * 3600)
    claims = {"sub": str(user.id), "login": user.login, "iat": int(time.time()), "exp": exp, "iss": settings.PUBLIC_SITE_URL or "catalog"}
    return jwt.encode(claims, settings.jwt_secret(), algorithm="HS256"), exp


def _from_jwt(token: str) -> Principal | None:
    try:
        claims = jwt.decode(token, settings.jwt_secret(), algorithms=["HS256"], options={"require": ["exp", "sub"]})
    except jwt.PyJWTError:
        return None
    user = accounts.get_user(int(claims["sub"]))
    return Principal(user, "session", list(accounts.SCOPES)) if user else None


def client_ip(scope) -> str:
    """The caller's IP: X-Forwarded-For's first address when the request comes through a trusted proxy (the site server)."""
    host = (scope.get("client") or ("", 0))[0]
    if host in settings.TRUSTED_PROXIES:
        for k, v in scope.get("headers") or []:
            if k == b"x-forwarded-for":
                return v.decode().split(",")[0].strip()
    return host


def _audit(request: Request, action: str, user: User | None, target: str | None = None, **details) -> None:
    accounts.audit(action, user, target, details or None, client_ip(request.scope), request.headers.get("user-agent"))


def resolve(request: Request) -> Principal | None:
    """Who is calling: a bearer token (JWT or PAT), else the session cookie. None for anonymous callers.
    Raises 401 when a credential is sent but is not valid (rather than silently treating the caller as anonymous)."""
    if "principal" in request.scope:
        return request.scope["principal"]
    auth = request.headers.get("authorization", "")
    principal = None
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        if token.startswith(settings.TOKEN_PREFIX):
            found = accounts.verify_token(token)
            principal = Principal(found[0], "token", found[1]) if found and found[0] else None
        else:
            principal = _from_jwt(token)
        if principal is None:
            raise HTTPException(401, "Invalid or expired token", headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})
    elif request.cookies.get(SESSION_COOKIE):
        principal = _from_jwt(request.cookies[SESSION_COOKIE])
    request.scope["principal"] = principal
    return principal


def optional_user(request: Request) -> Principal | None:
    return resolve(request)


def require_user(request: Request) -> Principal:
    p = resolve(request)
    if p is None:
        raise HTTPException(401, "Sign in, or send a bearer token", headers={"WWW-Authenticate": "Bearer"})
    return p


def require_session(request: Request) -> Principal:
    """Account management needs the person's own session, not a token (a leaked token can't mint more)."""
    p = require_user(request)
    if p.kind != "session":
        raise HTTPException(403, "Use a signed-in session (JWT) for this; personal access tokens can't manage accounts")
    return p


def _set_session(response: Response, user: User) -> None:
    token, exp = issue_jwt(user)
    response.set_cookie(
        SESSION_COOKIE, token, max_age=int(exp - time.time()), httponly=True, samesite="lax",
        secure=settings.COOKIE_SECURE, path="/",
    )


def _safe_next(url: str | None) -> str:
    """Only redirect back into the site (no open redirects)."""
    return url if url and re.match(r"^/(?!/)", url) else "/"


# ---------- routes ----------
router = APIRouter(prefix="/api")


@router.get("/auth/github/login", tags=["Auth"], summary="Sign in with GitHub")
def github_login(next: str | None = None):
    """Redirects to GitHub. After sign-in, GitHub returns to `/api/auth/github/callback`, which sets the session
    cookie and returns to `next` (a path on this site)."""
    if not settings.GITHUB_CLIENT_ID:
        raise HTTPException(503, "GitHub sign-in is not configured on this server (GITHUB_CLIENT_ID)")
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": settings.GITHUB_CLIENT_ID,
        "redirect_uri": f"{settings.PUBLIC_SITE_URL}/api/auth/github/callback",
        "scope": "read:user user:email",
        "state": state,
        "allow_signup": "true",
    }
    resp = RedirectResponse(f"https://github.com/login/oauth/authorize?{urlencode(params)}", status_code=302)
    resp.set_cookie(STATE_COOKIE, json.dumps({"s": state, "n": _safe_next(next)}), max_age=600, httponly=True, samesite="lax",
                    secure=settings.COOKIE_SECURE, path="/api/auth/github/")
    return resp


@router.get("/auth/github/callback", tags=["Auth"], include_in_schema=False)
async def github_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    try:
        saved = json.loads(request.cookies.get(STATE_COOKIE) or "{}")
    except json.JSONDecodeError:
        saved = {}
    if error:
        _audit(request, "auth.login_failed", None, details=error, method="github")
        return RedirectResponse(f"/login/?{urlencode({'error': error})}", status_code=302)
    if not code or not state or not secrets.compare_digest(state, saved.get("s", "")):
        raise HTTPException(400, "Sign-in expired or was started elsewhere. Please try again.")
    async with httpx.AsyncClient(timeout=15) as client:
        tok = (await client.post(
            "https://github.com/login/oauth/access_token",
            data={"client_id": settings.GITHUB_CLIENT_ID, "client_secret": settings.GITHUB_CLIENT_SECRET, "code": code,
                  "redirect_uri": f"{settings.PUBLIC_SITE_URL}/api/auth/github/callback"},
            headers={"Accept": "application/json"},
        )).json()
        if "access_token" not in tok:
            _audit(request, "auth.login_failed", None, method="github", reason=tok.get("error"))
            raise HTTPException(400, f"GitHub sign-in failed: {tok.get('error_description') or tok.get('error') or 'no token'}")
        gh_headers = {"Authorization": f"Bearer {tok['access_token']}", "Accept": "application/vnd.github+json"}
        gh = (await client.get("https://api.github.com/user", headers=gh_headers)).json()
        if not gh.get("email"):
            emails = (await client.get("https://api.github.com/user/emails", headers=gh_headers)).json()
            gh["email"] = next((e["email"] for e in emails if isinstance(e, dict) and e.get("primary") and e.get("verified")), None)
    # The GitHub access token is not kept: sign-in only needs the profile.
    user = accounts.upsert_user(gh)
    _audit(request, "auth.login", user, method="github")
    resp = RedirectResponse(saved.get("n") or "/", status_code=302)
    _set_session(resp, user)
    resp.delete_cookie(STATE_COOKIE, path="/api/auth/github/")
    return resp


@router.get("/auth/dev-login", tags=["Auth"], include_in_schema=False)
def dev_login(request: Request, login: str = "dev-user", next: str | None = None):
    """Local testing only (DEV_LOGIN=1): sign in as a made-up GitHub user without an OAuth app."""
    if not settings.DEV_LOGIN:
        raise HTTPException(404, "Not found")
    uid = 10**9 + int.from_bytes(login.encode()[:4].ljust(4, b"\0"), "big") % 10**8
    user = accounts.upsert_user({"id": uid, "login": login, "name": login.replace("-", " ").title(), "email": f"{login}@example.org",
                                 "avatar_url": None, "html_url": f"https://github.com/{login}"})
    _audit(request, "auth.login", user, method="dev")
    resp = RedirectResponse(_safe_next(next), status_code=302)
    _set_session(resp, user)
    return resp


@router.post("/auth/logout", tags=["Auth"], summary="Sign out", status_code=204)
def logout(request: Request):
    try:
        p = resolve(request)
    except HTTPException:
        p = None
    if p:
        _audit(request, "auth.logout", p.user)
    resp = Response(status_code=204)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


class Me(BaseModel):
    user: dict
    via: str
    scopes: list[str]
    rateLimit: dict


@router.get("/auth/me", tags=["Auth"], summary="Me", response_model=Me)
def me(p: Principal = Depends(require_user)):
    """The signed-in user, how the request was authenticated, and the rate limit that applies."""
    return {"user": p.user.public(), "via": p.kind, "scopes": p.scopes, "rateLimit": {"perMinute": settings.RATE_LIMIT_USER, "anonymousPerMinute": settings.RATE_LIMIT_ANON}}


@router.get("/auth/config", tags=["Auth"], summary="Auth config")
def auth_config():
    """Which sign-in methods this server offers, and the rate limits."""
    return {
        "github": bool(settings.GITHUB_CLIENT_ID), "devLogin": settings.DEV_LOGIN, "sessionHours": settings.SESSION_HOURS,
        "tokenPrefix": settings.TOKEN_PREFIX, "scopes": list(accounts.SCOPES),
        "rateLimit": {"anonymousPerMinute": settings.RATE_LIMIT_ANON, "authenticatedPerMinute": settings.RATE_LIMIT_USER},
    }


@router.post("/auth/token", tags=["Auth"], summary="Session JWT")
def session_token(request: Request, p: Principal = Depends(require_session)):
    """A session JWT for scripts, for the signed-in user (from the browser session). Valid for SESSION_HOURS."""
    token, exp = issue_jwt(p.user)
    _audit(request, "auth.jwt_issued", p.user)
    return {"token": token, "tokenType": "Bearer", "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))}


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, description="What the token is for, e.g. “Claude Desktop”")
    scopes: list[str] = Field(default_factory=lambda: ["api", "mcp"], description="`api` (HTTP API), `mcp` (MCP server)")
    expiresInDays: int | None = Field(90, ge=1, le=366, description="Omit or null for no expiry")


@router.get("/tokens", tags=["API tokens"], summary="List tokens")
def tokens(p: Principal = Depends(require_session)):
    """Your active personal access tokens (the tokens themselves are never shown again)."""
    return accounts.list_tokens(p.user)


@router.post("/tokens", tags=["API tokens"], summary="Create token", status_code=201)
def create_token(request: Request, body: TokenIn, p: Principal = Depends(require_session)):
    """Creates a personal access token. The `token` value is returned once: store it now."""
    bad = [s for s in body.scopes if s not in accounts.SCOPES]
    if bad or not body.scopes:
        raise HTTPException(422, f"Scopes must be a non-empty subset of {list(accounts.SCOPES)}")
    if len(accounts.list_tokens(p.user)) >= 25:
        raise HTTPException(409, "You have 25 active tokens; revoke one first")
    token, info = accounts.create_token(p.user, body.name.strip(), sorted(set(body.scopes)), body.expiresInDays)
    _audit(request, "token.create", p.user, info["id"], name=info["name"], scopes=info["scopes"], expiresAt=info["expiresAt"])
    return {"token": token, **info}


@router.delete("/tokens/{token_id}", tags=["API tokens"], summary="Revoke token", status_code=204)
def revoke_token(request: Request, token_id: str, p: Principal = Depends(require_session)):
    info = accounts.revoke_token(p.user, token_id)
    if not info:
        raise HTTPException(404, "No such active token")
    _audit(request, "token.revoke", p.user, token_id, name=info["name"])
    return Response(status_code=204)


# ---------- submissions ----------
class SubmissionIn(BaseModel):
    entry: dict = Field(description="The catalog entry, as built by the submission form")
    notes: str | None = Field(None, max_length=4000)
    updateId: str | None = Field(None, description="Id of the entry this corrects, for corrections")


def _problems(e: dict) -> list[str]:
    url = lambda s: not s or bool(re.match(r"^https?://\S+$", str(s)))  # noqa: E731
    p = []
    if not e.get("name"):
        p.append("Name is required.")
    if len(e.get("description") or "") < 40:
        p.append("Description should be at least 40 characters.")
    if not e.get("homepage") and not e.get("repository"):
        p.append("Give a homepage or a repository.")
    for k in ("homepage", "repository", "download"):
        if not url(e.get(k)):
            p.append(f"{k.capitalize()} must be an http(s) URL.")
    for u in e.get("usedBy") or []:
        if not u.get("name") or not url(u.get("url")) or not u.get("url"):
            p.append(f"Each “Used by” project needs a name and an http(s) URL ({u.get('name') or 'unnamed'}).")
    return p


@router.post("/submissions", tags=["Submissions"], summary="Submit an entry", status_code=201)
def submit(request: Request, body: SubmissionIn, p: Principal = Depends(require_user)):
    """Records the submission with the contributor's GitHub identity and returns a pre-filled GitHub issue URL.
    A workflow turns that issue into a pull request; maintainers review it there."""
    problems = _problems(body.entry)
    if problems:
        raise HTTPException(422, " ".join(problems))
    repo = settings.site_config().get("repository")
    if not repo:
        raise HTTPException(503, "No GitHub repository configured for submissions")
    u = p.user
    who = f"@{u.login}" + (f" ({u.name})" if u.name else "")
    issue_body = "\n".join([
        f"Correction to `{body.updateId}`" if body.updateId else "New catalog entry",
        "",
        "```json",
        json.dumps(body.entry, indent=2, ensure_ascii=False),
        "```",
        "",
        f"**Submitted by** {who} through {settings.PUBLIC_SITE_URL or 'the site'}/submit/",
        *([f"\n**Notes from submitter**\n\n{body.notes.strip()}"] if body.notes and body.notes.strip() else []),
    ])
    params = {"template": "add-resource.yml", "title": f"{'Update' if body.updateId else 'Add'}: {body.entry.get('acronym') or body.entry.get('name')}",
              "entry": issue_body, "update-id": body.updateId or ""}
    issue_url = f"{repo}/issues/new?{urlencode(params)}"
    sid = accounts.record_submission(u, body.entry, body.updateId, body.notes, issue_url)
    _audit(request, "submission.create", u, body.entry.get("id"), submission=sid, updateOf=body.updateId, name=body.entry.get("name"), via=p.kind)
    # GitHub limits URL length; the form falls back to copy-and-paste for very long entries.
    return {"id": sid, "issueUrl": issue_url, "issueBody": issue_body, "tooLong": len(issue_url) > 7500, "submittedBy": u.public()}


@router.get("/submissions", tags=["Submissions"], summary="My submissions")
def my_submissions(p: Principal = Depends(require_user)):
    return accounts.list_submissions(p.user)


# ---------- activity ----------
@router.get("/auth/activity", tags=["Auth"], summary="My activity")
def my_activity(limit: int = 50, before: int | None = None, p: Principal = Depends(require_user)):
    """Your own sign-ins, sign-outs, tokens and submissions, newest first. Page with `before` = the last id seen."""
    return accounts.audit_entries(p.user, limit=limit, before=before)


@router.get("/audit", tags=["Auth"], summary="Audit log (admins)")
def audit_log(action: str | None = None, limit: int = 100, before: int | None = None, p: Principal = Depends(require_user)):
    """Everything: who signed in or out, created or revoked tokens, submitted entries, and every data load.
    Filter with `action` (e.g. `auth.*`, `token.create`). Admins only (ADMIN_LOGINS)."""
    if not p.user.is_admin:
        raise HTTPException(403, "Admins only")
    return accounts.audit_entries(None, action=action, limit=limit, before=before)
