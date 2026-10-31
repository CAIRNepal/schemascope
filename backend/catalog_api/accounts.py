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

    @property
    def is_admin(self) -> bool:
        return self.login.lower() in settings.ADMIN_LOGINS

    def public(self) -> dict:
        return {"id": self.id, "login": self.login, "name": self.name, "avatarUrl": self.avatar_url, "url": self.html_url, "admin": self.is_admin}


def _user(r) -> User | None:
    return User(r["id"], r["login"], r["name"], r["email"], r["avatar_url"], r["html_url"]) if r else None


def upsert_user(gh: dict) -> User:
    """Create or update a user from GitHub's /user response."""
    return _user(db.one(
        """INSERT INTO users (id, login, name, email, avatar_url, html_url, last_login_at) VALUES (%s,%s,%s,%s,%s,%s, now())
           ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, email = COALESCE(excluded.email, users.email),
           avatar_url = excluded.avatar_url, html_url = excluded.html_url, last_login_at = now()
           RETURNING *""",
        (gh["id"], gh["login"], gh.get("name"), gh.get("email"), gh.get("avatar_url"), gh.get("html_url")),
    ))


def get_user(user_id: int) -> User | None:
    return _user(db.one("SELECT * FROM users WHERE id = %s", (user_id,)))


# ---------- audit log ----------
def audit(action: str, user: User | None, target: str | None = None, details: dict | None = None, ip: str | None = None, user_agent: str | None = None) -> None:
    """Record who did what. `user` None means the system (e.g. an ingest run)."""
    db.execute(
        "INSERT INTO audit_log (actor_id, actor_login, action, target, details, ip, user_agent) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (user.id if user else None, user.login if user else None, action, target, Jsonb(details) if details else None, ip, (user_agent or "")[:300] or None),
    )


def audit_entries(user: User | None = None, action: str | None = None, limit: int = 100, before: int | None = None) -> list[dict]:
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
    rows = db.rows(
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


def create_token(user: User, name: str, scopes: list[str], expires_days: int | None) -> tuple[str, dict]:
    token = settings.TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=expires_days) if expires_days else None
    r = db.one(
        "INSERT INTO tokens (id, user_id, name, hint, hash, scopes, expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
        (secrets.token_hex(8), user.id, name, f"{settings.TOKEN_PREFIX}…{token[-4:]}", _hash(token), " ".join(scopes), expires),
    )
    return token, _token_dict(r)


def list_tokens(user: User) -> list[dict]:
    return [_token_dict(r) for r in db.rows("SELECT * FROM tokens WHERE user_id = %s AND revoked_at IS NULL ORDER BY created_at DESC", (user.id,))]


def revoke_token(user: User, tid: str) -> dict | None:
    r = db.one("UPDATE tokens SET revoked_at = now() WHERE id = %s AND user_id = %s AND revoked_at IS NULL RETURNING *", (tid, user.id))
    return _token_dict(r) if r else None


def verify_token(token: str) -> tuple[User, list[str]] | None:
    """The token's user and scopes, if the token exists, is not revoked and has not expired."""
    r = db.one(
        "SELECT * FROM tokens WHERE hash = %s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", (_hash(token),)
    )
    if not r:
        return None
    # Record use at most once a minute per token, to keep writes cheap.
    if not r["last_used_at"] or (datetime.now(timezone.utc) - r["last_used_at"]).total_seconds() > 60:
        db.execute("UPDATE tokens SET last_used_at = now() WHERE id = %s", (r["id"],))
    return get_user(r["user_id"]), r["scopes"].split()


# ---------- submissions ----------
def record_submission(user: User, entry: dict, update_of: str | None, notes: str | None, issue_url: str) -> int:
    return db.value(
        "INSERT INTO submissions (user_id, entry_id, update_of, payload, notes, issue_url) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
        (user.id, entry.get("id"), update_of, Jsonb(entry), notes, issue_url),
    )


def list_submissions(user: User) -> list[dict]:
    rows = db.rows("SELECT * FROM submissions WHERE user_id = %s ORDER BY id DESC LIMIT 100", (user.id,))
    return [{"id": r["id"], "entryId": r["entry_id"], "updateOf": r["update_of"], "issueUrl": r["issue_url"], "createdAt": iso(r["created_at"])} for r in rows]
