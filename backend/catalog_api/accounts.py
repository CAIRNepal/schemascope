"""Users (from GitHub sign-in), personal access tokens, submissions and the audit log, in Postgres.

Tokens are stored only as SHA-256 hashes; the token itself is shown once, when it is created.
Every change a person makes (and every data load) is written to audit_log: who, what, when, from where.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

from . import db, settings

SCOPES = ("api", "mcp")


def iso(t: datetime | None) -> str | None:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


@dataclass
class User:
    id: int
    login: str
    name: str | None
    email: str | None
    avatar_url: str | None
    html_url: str | None
    rate_limit: int | None = None
    improve_search: bool = True

    @property
    def is_admin(self) -> bool:
        """Superadmin: the account's email is listed in SUPERADMIN_EMAILS."""
        return bool(self.email) and self.email.lower() in settings.SUPERADMIN_EMAILS

    def public(self) -> dict:
        return {"id": self.id, "login": self.login, "name": self.name, "avatarUrl": self.avatar_url, "url": self.html_url, "superadmin": self.is_admin,
                "improveSearch": self.improve_search}


def _user(r) -> User | None:
    return User(r["id"], r["login"], r["name"], r["email"], r["avatar_url"], r["html_url"], r.get("rate_limit"), r.get("improve_search", True)) if r else None


# ---------- runtime settings (superadmin) ----------
import time as _time

_settings_cache = {"at": 0.0, "value": {}}


async def app_settings() -> dict:
    """Settings changed at runtime, read at most every 5 s (all API workers pick up a change within seconds)."""
    if _time.time() - _settings_cache["at"] > 5:
        _settings_cache["value"] = {r["key"]: r["value"] for r in await db.rows("SELECT key, value FROM app_settings")}
        _settings_cache["at"] = _time.time()
    return _settings_cache["value"]


async def set_app_setting(key: str, value, user: User) -> None:
    await db.execute(
        "INSERT INTO app_settings (key, value, updated_by) VALUES (%s, %s, %s) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by",
        (key, Jsonb(value), user.id),
    )
    _settings_cache["at"] = 0.0


async def rate_limits() -> dict:
    s = await app_settings()
    return {"anonymousPerMinute": int(s.get("rate_limit_anon", settings.RATE_LIMIT_ANON)), "authenticatedPerMinute": int(s.get("rate_limit_user", settings.RATE_LIMIT_USER))}


async def limit_for(user: User | None) -> int:
    lim = await rate_limits()
    if user is None:
        return lim["anonymousPerMinute"]
    return user.rate_limit if user.rate_limit is not None else lim["authenticatedPerMinute"]


async def list_users(limit: int = 200, q: str | None = None) -> list[dict]:
    rows = await db.rows(
        "SELECT u.*, (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens FROM users u "
        + ("WHERE u.login ILIKE %s OR u.name ILIKE %s OR u.email ILIKE %s " if q else "")
        + "ORDER BY u.last_login_at DESC NULLS LAST LIMIT %s",
        ((f"%{q}%",) * 3 if q else ()) + (limit,),
    )
    return [{**_user(r).public(), "email": r["email"], "rateLimit": r["rate_limit"], "activeTokens": r["tokens"],
             "createdAt": iso(r["created_at"]), "lastLoginAt": iso(r["last_login_at"])} for r in rows]


async def set_user_rate_limit(user_id: int, per_minute: int | None) -> User | None:
    return _user(await db.one("UPDATE users SET rate_limit = %s WHERE id = %s RETURNING *", (per_minute, user_id)))


async def upsert_user(gh: dict) -> User:
    """Create or update a user from GitHub's /user response."""
    return _user(await db.one(
        """INSERT INTO users (id, login, name, email, avatar_url, html_url, last_login_at) VALUES (%s,%s,%s,%s,%s,%s, now())
           ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, email = COALESCE(excluded.email, users.email),
           avatar_url = excluded.avatar_url, html_url = excluded.html_url, last_login_at = now()
           RETURNING *""",
        (gh["id"], gh["login"], gh.get("name"), gh.get("email"), gh.get("avatar_url"), gh.get("html_url")),
    ))


async def get_user(user_id: int) -> User | None:
    return _user(await db.one("SELECT * FROM users WHERE id = %s", (user_id,)))


# ---------- audit log ----------
async def audit(action: str, user: User | None, target: str | None = None, details: dict | None = None, ip: str | None = None, user_agent: str | None = None) -> None:
    """Record who did what. `user` None means the system (e.g. an ingest run)."""
    await db.execute(
        "INSERT INTO audit_log (actor_id, actor_login, action, target, details, ip, user_agent) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (user.id if user else None, user.login if user else None, action, target, Jsonb(details) if details else None, ip, (user_agent or "")[:300] or None),
    )


async def audit_entries(user: User | None = None, action: str | None = None, limit: int = 100, before: int | None = None) -> list[dict]:
    """Newest first. With `user`, only that user's own activity."""
    where, args = [], []
    if user:
        where.append("actor_id = %s")
        args.append(user.id)
    if action:
        where.append("action LIKE %s")
        args.append(action.rstrip("*") + "%")
    if before:
        where.append("id < %s")
        args.append(before)
    rows = await db.rows(
        f"SELECT * FROM audit_log {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY id DESC LIMIT %s", (*args, min(max(limit, 1), 500)),
    )
    return [
        {"id": r["id"], "at": iso(r["at"]), "actor": {"id": r["actor_id"], "login": r["actor_login"]} if r["actor_id"] else None,
         "action": r["action"], "target": r["target"], "details": r["details"], "ip": r["ip"], "userAgent": r["user_agent"]}
        for r in rows
    ]


# ---------- personal access tokens ----------
def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _token_dict(r) -> dict:
    return {
        "id": r["id"], "name": r["name"], "hint": r["hint"], "scopes": r["scopes"].split(), "createdAt": iso(r["created_at"]),
        "expiresAt": iso(r["expires_at"]), "lastUsedAt": iso(r["last_used_at"]), "revokedAt": iso(r["revoked_at"]),
    }


async def create_token(user: User, name: str, scopes: list[str], expires_days: int | None) -> tuple[str, dict]:
    token = settings.TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=expires_days) if expires_days else None
    r = await db.one(
        "INSERT INTO tokens (id, user_id, name, hint, hash, scopes, expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
        (secrets.token_hex(8), user.id, name, f"{settings.TOKEN_PREFIX}…{token[-4:]}", _hash(token), " ".join(scopes), expires),
    )
    return token, _token_dict(r)


async def list_tokens(user: User) -> list[dict]:
    return [_token_dict(r) for r in await db.rows("SELECT * FROM tokens WHERE user_id = %s AND revoked_at IS NULL ORDER BY created_at DESC", (user.id,))]


async def revoke_token(user: User, tid: str) -> dict | None:
    r = await db.one("UPDATE tokens SET revoked_at = now() WHERE id = %s AND user_id = %s AND revoked_at IS NULL RETURNING *", (tid, user.id))
    return _token_dict(r) if r else None


async def verify_token(token: str) -> tuple[User, list[str]] | None:
    """The token's user and scopes, if the token exists, is not revoked and has not expired."""
    r = await db.one(
        "SELECT * FROM tokens WHERE hash = %s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", (_hash(token),)
    )
    if not r:
        return None
    # Record use at most once a minute per token, to keep writes cheap.
    if not r["last_used_at"] or (datetime.now(timezone.utc) - r["last_used_at"]).total_seconds() > 60:
        await db.execute("UPDATE tokens SET last_used_at = now() WHERE id = %s", (r["id"],))
    return await get_user(r["user_id"]), r["scopes"].split()


# ---------- submissions ----------
async def record_submission(user: User, entry: dict, update_of: str | None, notes: str | None, issue_url: str) -> int:
    return await db.value(
        "INSERT INTO submissions (user_id, entry_id, update_of, payload, notes, issue_url) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
        (user.id, entry.get("id"), update_of, Jsonb(entry), notes, issue_url),
    )


async def list_submissions(user: User) -> list[dict]:
    rows = await db.rows("SELECT * FROM submissions WHERE user_id = %s ORDER BY id DESC LIMIT 100", (user.id,))
    return [_submission(r) for r in rows]


def _submission(r: dict, with_payload: bool = False) -> dict:
    out = {"id": r["id"], "entryId": r["entry_id"], "updateOf": r["update_of"], "issueUrl": r["issue_url"], "createdAt": iso(r["created_at"]),
           "status": r.get("status") or "pending", "reviewNotes": r.get("review_notes"), "reviewedBy": r.get("reviewed_by"), "reviewedAt": iso(r.get("reviewed_at"))}
    if with_payload:
        p = r["payload"] or {}
        out.update({"name": p.get("name"), "acronym": p.get("acronym"), "kind": p.get("kind"), "category": p.get("category"),
                    "description": p.get("description"), "homepage": p.get("homepage"), "repository": p.get("repository"),
                    "notes": r.get("notes"), "entry": p,
                    "submittedBy": {"login": r.get("login"), "name": r.get("uname"), "avatarUrl": r.get("avatar_url"), "url": r.get("html_url")}})
    return out


REVIEW_STATUSES = ("pending", "approved", "changes_requested", "rejected")


async def all_submissions(status: str | None = None, q: str | None = None, limit: int = 200) -> list[dict]:
    where, args = [], []
    if status and status != "all":
        where.append("s.status = %s")
        args.append(status)
    if q:
        where.append("(s.payload->>'name' ILIKE %s OR s.entry_id ILIKE %s OR u.login ILIKE %s)")
        args += [f"%{q}%"] * 3
    rows = await db.rows(
        "SELECT s.*, u.login, u.name AS uname, u.avatar_url, u.html_url FROM submissions s JOIN users u ON u.id = s.user_id "
        f"{'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY s.id DESC LIMIT %s", (*args, min(max(limit, 1), 500)))
    return [_submission(r, with_payload=True) for r in rows]


async def review_submission(sid: int, status: str, notes: str | None, reviewer: User) -> dict | None:
    row = await db.one(
        "UPDATE submissions SET status = %s, review_notes = %s, reviewed_by = %s, reviewed_at = now() WHERE id = %s RETURNING *",
        (status, notes, reviewer.login, sid))
    return _submission(row) if row else None


async def admin_counts() -> dict:
    return {
        "users": await db.value("SELECT COUNT(*) FROM users"),
        "activeUsers30d": await db.value("SELECT COUNT(*) FROM users WHERE last_login_at > now() - interval '30 days'"),
        "activeTokens": await db.value("SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())"),
        "submissions": {r["status"]: r["n"] for r in await db.rows("SELECT status, COUNT(*) AS n FROM submissions GROUP BY status")},
        "events24h": await db.value("SELECT COUNT(*) FROM audit_log WHERE at > now() - interval '24 hours'"),
    }


async def set_improve_search(user: User, on: bool) -> None:
    await db.execute("UPDATE users SET improve_search = %s WHERE id = %s", (on, user.id))
