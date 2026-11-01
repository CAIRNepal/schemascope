"""Postgres: connection pool, schema and small query helpers.

One database holds the catalog (rebuilt by ingest), run history (grows), and accounts, tokens, submissions and the
audit log (kept across ingests). Start it with `docker compose up -d db`; the API reads DATABASE_URL.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from . import settings

SCHEMA = """
-- Catalog (replaced on every ingest)
CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS raw (key text PRIMARY KEY, value text NOT NULL);   -- data files as on disk, for the page templates
CREATE TABLE IF NOT EXISTS categories (id text PRIMARY KEY, position int NOT NULL, data text NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  id text PRIMARY KEY, position int NOT NULL, name text NOT NULL, acronym text, category text NOT NULL, kind text,
  legacy boolean NOT NULL DEFAULT false, score int, grade text, fair int, last_activity text, adopters int NOT NULL DEFAULT 0,
  version text, data text NOT NULL, facts text, search tsvector
);
CREATE INDEX IF NOT EXISTS entries_search ON entries USING gin (search);
CREATE INDEX IF NOT EXISTS entries_score ON entries (score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS entries_category ON entries (category);
CREATE TABLE IF NOT EXISTS entry_domains (entry_id text NOT NULL, category text NOT NULL, PRIMARY KEY (category, entry_id));
CREATE TABLE IF NOT EXISTS entry_formats (entry_id text NOT NULL, format text NOT NULL, PRIMARY KEY (format, entry_id));
CREATE TABLE IF NOT EXISTS entry_registries (entry_id text NOT NULL, registry text NOT NULL, PRIMARY KEY (registry, entry_id));
CREATE TABLE IF NOT EXISTS entry_keys (key text PRIMARY KEY, entry_id text NOT NULL);

-- Run history (incremental)
CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, started_at text, finished_at text, entries int, data text NOT NULL);
CREATE TABLE IF NOT EXISTS history (
  entry_id text NOT NULL, run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE, at text, point text NOT NULL,
  PRIMARY KEY (entry_id, run_id)
);
CREATE INDEX IF NOT EXISTS history_run ON history (run_id);

-- Accounts (kept across ingests)
CREATE TABLE IF NOT EXISTS users (
  id bigint PRIMARY KEY,                 -- GitHub user id
  login text NOT NULL, name text, email text, avatar_url text, html_url text,
  created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS tokens (
  id text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), name text NOT NULL,
  hint text NOT NULL, hash text NOT NULL UNIQUE, scopes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_limit int;   -- per-user override (requests/minute), set by a superadmin
-- Runtime settings changed by superadmins (e.g. rate limits); env vars are the defaults.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by bigint
);
CREATE TABLE IF NOT EXISTS submissions (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), entry_id text, update_of text,
  payload jsonb NOT NULL, notes text, issue_url text, created_at timestamptz NOT NULL DEFAULT now()
);
-- Who did what, and when: sign-ins, sign-outs, tokens, submissions, data loads.
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  actor_id bigint, actor_login text,     -- null actor = the system (e.g. an ingest run)
  action text NOT NULL, target text, details jsonb, ip text, user_agent text
);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log (action, at DESC);
-- Editorial review of submissions (admin dashboard): pending → approved | changes_requested | rejected.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS review_notes text;
-- Saved recommendation chats (signed-in users only). Assistant messages keep the results they showed (data).
CREATE TABLE IF NOT EXISTS chats (
  id text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_user ON chats (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role text NOT NULL,
  content text NOT NULL, data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (chat_id, id);
-- Chat log for improving search and recommendations. Deliberately has no user id, IP or chat id: only an anonymous
-- per-browser-session id, the question, what was understood and shown, the answer and any feedback.
CREATE TABLE IF NOT EXISTS chat_logs (
  id text PRIMARY KEY, session text, question text NOT NULL, filters jsonb, result_ids text[], answer text, model text,
  rating smallint, comment text, created_at timestamptz NOT NULL DEFAULT now(), feedback_at timestamptz
);
CREATE INDEX IF NOT EXISTS chat_logs_created ON chat_logs (created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS improve_search boolean NOT NULL DEFAULT true;   -- may chats be logged (no identity)
"""

_pool: ConnectionPool | None = None
_lock = threading.Lock()
_ready = False

# The API uses an async pool (non-blocking: queries are awaited on the event loop). The ingest CLI, schema setup and
# the OpenAPI document use the small synchronous pool below.
_apool: AsyncConnectionPool | None = None
_apool_loop: asyncio.AbstractEventLoop | None = None
_alock: asyncio.Lock | None = None


class Unavailable(RuntimeError):
    pass


def pool() -> ConnectionPool:
    """Synchronous pool (ingest and one-off work); creates the schema on first use."""
    global _pool, _ready
    with _lock:
        if _pool is None:
            _pool = ConnectionPool(
                settings.DATABASE_URL, min_size=1, max_size=settings.DB_POOL_SIZE, open=True, timeout=10,
                kwargs={"autocommit": True, "row_factory": dict_row},
            )
        if not _ready:
            with _pool.connection() as con:
                con.execute(SCHEMA)
            _ready = True
    return _pool


async def apool() -> AsyncConnectionPool:
    """The async pool for the API, opened on first use in the running event loop."""
    global _apool, _apool_loop, _alock, _ready
    loop = asyncio.get_running_loop()
    if _apool is not None and _apool_loop is loop:
        return _apool
    if _alock is None or _apool_loop is not loop:
        _alock = asyncio.Lock()
    async with _alock:
        if _apool is None or _apool_loop is not loop:
            # A new event loop (tests start one per client) gets its own pool; the old one belongs to a closed loop.
            p = AsyncConnectionPool(settings.DATABASE_URL, min_size=1, max_size=settings.DB_POOL_SIZE, open=False, timeout=10,
                                    kwargs={"autocommit": True, "row_factory": dict_row})
            await p.open()
            if not _ready:
                async with p.connection() as con:
                    await con.execute(SCHEMA)
                _ready = True
            _apool, _apool_loop = p, loop
    return _apool


async def aclose() -> None:
    global _apool, _apool_loop
    if _apool is not None:
        await _apool.close()
    _apool, _apool_loop = None, None


def close() -> None:
    global _pool, _ready
    with _lock:
        if _pool is not None:
            _pool.close()
        _pool, _ready = None, False


# ---------- async helpers (API) ----------
async def rows(sql: str, params: Any = ()) -> list[dict]:
    async with (await apool()).connection() as con:
        return await (await con.execute(sql, params)).fetchall()


async def one(sql: str, params: Any = ()) -> dict | None:
    async with (await apool()).connection() as con:
        return await (await con.execute(sql, params)).fetchone()


async def value(sql: str, params: Any = ()) -> Any:
    r = await one(sql, params)
    return next(iter(r.values())) if r else None


async def execute(sql: str, params: Any = ()) -> int:
    """Run a write; returns the affected row count."""
    async with (await apool()).connection() as con:
        return (await con.execute(sql, params)).rowcount


# ---------- sync helpers (ingest CLI, OpenAPI) ----------
def rows_sync(sql: str, params: Any = ()) -> list[dict]:
    with pool().connection() as con:
        return con.execute(sql, params).fetchall()


def value_sync(sql: str, params: Any = ()) -> Any:
    with pool().connection() as con:
        r = con.execute(sql, params).fetchone()
    return next(iter(r.values())) if r else None


def execute_sync(sql: str, params: Any = ()) -> int:
    with pool().connection() as con:
        return con.execute(sql, params).rowcount
