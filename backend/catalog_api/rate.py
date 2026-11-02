"""Rate limiting and abuse protection, shared by all API workers.

- Keys: "user:<id>" for accounts (signed-in sessions and their tokens share one budget) and "ip:<hash>" for signed-out
  visitors. IP addresses are stored only as a keyed hash (HMAC with the server secret), never in plain text.
- Counting: each worker counts in memory (fast, no database write per request) and every RATE_SYNC_SECONDS adds its
  counts to `rate_usage` and reads back the totals, so every worker enforces the combined count. Usage is kept
  RATE_KEEP_DAYS for abuse investigation and for people to see their own usage.
- Order of checks (guard.py): the block list and a per-IP ceiling first (cheap, before any token lookup, so floods of
  fake tokens never reach the database), then the caller's own limit.
- Automatic blocks: a key that sends more than three times its limit in a minute, or goes over its limit three
  minutes running, is blocked for RATE_BLOCK_MINUTES. Blocks are stored in `rate_blocks` and in the audit log;
  superadmins can block and unblock by hand.

Large distributed attacks must be stopped before they reach the server (provider firewall or CDN); this protects the
API and database from what does get through.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import time

from . import db, settings

_local: dict[tuple[str, int], int] = {}      # (key, minute) → requests counted here since the last sync
_shared: dict[tuple[str, int], int] = {}     # (key, minute) → total from all workers at the last sync
_over: dict[str, list[int]] = {}             # key → recent minutes in which it went over its limit
_blocks: dict[str, float] = {}               # key → blocked until (epoch seconds)
_blocks_at = 0.0
_task: asyncio.Task | None = None


def ip_key(ip: str) -> str:
    digest = hmac.new(settings.jwt_secret().encode(), (ip or "?").encode(), hashlib.sha256).hexdigest()[:24]
    return f"ip:{digest}"


def user_key(user_id: int) -> str:
    return f"user:{user_id}"


def minute() -> int:
    return int(time.time() // 60)


def count(key: str) -> int:
    """Count one request for `key` this minute; returns the combined count so far (all workers, approximately)."""
    m = minute()
    _local[(key, m)] = _local.get((key, m), 0) + 1
    return _shared.get((key, m), 0) + _local[(key, m)]


def blocked(key: str) -> float:
    """Seconds left on a block, or 0."""
    until = _blocks.get(key, 0)
    return max(0.0, until - time.time())


async def note_over(key: str, n: int, limit: int, reason_ip: str | None = None) -> bool:
    """Called when `key` is over its limit; blocks it automatically when the abuse rule is met. True if blocked now."""
    m = minute()
    mins = [x for x in _over.get(key, []) if x >= m - 3]
    if m not in mins:
        mins.append(m)
    _over[key] = mins
    if n > 3 * limit or len([x for x in mins if x >= m - 2]) >= 3:
        reason = f"automatic: {n} requests in a minute (limit {limit})" if n > 3 * limit else f"automatic: over the limit of {limit} three minutes running"
        await block(key, settings.RATE_BLOCK_MINUTES, reason, auto=True, by=None)
        return True
    return False


async def block(key: str, minutes: int, reason: str, auto: bool = False, by: str | None = None) -> None:
    until = time.time() + minutes * 60
    _blocks[key] = until
    await db.execute(
        "INSERT INTO rate_blocks (key, until, reason, auto, created_by) VALUES (%s, to_timestamp(%s), %s, %s, %s) "
        "ON CONFLICT (key) DO UPDATE SET until = excluded.until, reason = excluded.reason, auto = excluded.auto, created_at = now(), created_by = excluded.created_by",
        (key, until, reason, auto, by),
    )
    from .accounts import audit

    await audit("security.block", None if by else None, key, {"minutes": minutes, "reason": reason, "auto": auto, "by": by})


async def unblock(key: str) -> bool:
    _blocks.pop(key, None)
    return bool(await db.one("DELETE FROM rate_blocks WHERE key = %s RETURNING key", (key,)))


async def sync() -> None:
    """Share this worker's counts and refresh totals and blocks from the database."""
    global _local, _blocks_at
    pending, _local = _local, {}
    m = minute()
    if pending:
        keys, minutes, counts = zip(*[(k, mm, n) for (k, mm), n in pending.items()])
        rows = await db.rows(
            "INSERT INTO rate_usage (key, minute, count) SELECT * FROM unnest(%s::text[], %s::bigint[], %s::int[]) "
            "ON CONFLICT (key, minute) DO UPDATE SET count = rate_usage.count + excluded.count RETURNING key, minute, count",
            (list(keys), list(minutes), list(counts)),
        )
        for r in rows:
            _shared[(r["key"], r["minute"])] = r["count"]
    for k in [k for k in _shared if k[1] < m - 1]:
        del _shared[k]
    if time.time() - _blocks_at > 10:
        _blocks.clear()
        for r in await db.rows("SELECT key, extract(epoch FROM until) AS until FROM rate_blocks WHERE until > now()"):
            _blocks[r["key"]] = float(r["until"])
        _blocks_at = time.time()
        if int(time.time()) % 3600 < 15:   # roughly hourly: drop old usage
            await db.execute("DELETE FROM rate_usage WHERE minute < %s", (m - settings.RATE_KEEP_DAYS * 1440,))


async def _loop() -> None:
    while True:
        await asyncio.sleep(settings.RATE_SYNC_SECONDS)
        try:
            await sync()
        except Exception:
            pass


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_running_loop().create_task(_loop())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
    try:
        await sync()
    except Exception:
        pass


def reset() -> None:
    """Tests: forget all in-memory state."""
    _local.clear(); _shared.clear(); _over.clear(); _blocks.clear()


# ---------- reading usage ----------
async def usage(key: str) -> dict:
    m = minute()
    r = await db.one("SELECT COALESCE(SUM(count) FILTER (WHERE minute >= %s), 0) AS hour, COALESCE(SUM(count) FILTER (WHERE minute >= %s), 0) AS day "
                     "FROM rate_usage WHERE key = %s AND minute >= %s", (m - 59, m - 1439, key, m - 1439))
    local = sum(n for (k, mm), n in _local.items() if k == key)
    return {"lastHour": int(r["hour"]) + local, "last24h": int(r["day"]) + local}


async def top(minutes: int = 60, limit: int = 30) -> list[dict]:
    m = minute()
    rows = await db.rows("SELECT key, SUM(count) AS n, MAX(count) AS peak FROM rate_usage WHERE minute >= %s GROUP BY key ORDER BY n DESC LIMIT %s",
                         (m - minutes + 1, limit))
    return [{"key": r["key"], "requests": int(r["n"]), "peakPerMinute": int(r["peak"])} for r in rows]


async def blocks() -> list[dict]:
    from .accounts import iso

    rows = await db.rows("SELECT * FROM rate_blocks WHERE until > now() ORDER BY created_at DESC")
    return [{"key": r["key"], "until": iso(r["until"]), "reason": r["reason"], "auto": r["auto"], "createdAt": iso(r["created_at"]), "by": r["created_by"]} for r in rows]
