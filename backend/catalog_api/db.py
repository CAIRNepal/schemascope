"""Postgres: connection pool, schema and small query helpers.

One database holds the catalog (rebuilt by ingest), run history (grows), and accounts, tokens, submissions and the
audit log (kept across ingests). Start it with `docker compose up -d db`; the API reads DATABASE_URL.
"""
from __future__ import annotations

import threading
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

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
"""

_pool: ConnectionPool | None = None
_lock = threading.Lock()
_ready = False


class Unavailable(RuntimeError):
    pass


def pool() -> ConnectionPool:
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


def close() -> None:
    global _pool, _ready
    with _lock:
        if _pool is not None:
            _pool.close()
        _pool, _ready = None, False


def rows(sql: str, params: Any = ()) -> list[dict]:
    with pool().connection() as con:
        return con.execute(sql, params).fetchall()


def one(sql: str, params: Any = ()) -> dict | None:
    with pool().connection() as con:
        return con.execute(sql, params).fetchone()


def value(sql: str, params: Any = ()) -> Any:
    r = one(sql, params)
    return next(iter(r.values())) if r else None


def execute(sql: str, params: Any = ()) -> int:
    """Run a write; returns the affected row count."""
    with pool().connection() as con:
        return con.execute(sql, params).rowcount
