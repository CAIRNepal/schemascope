"""Anonymous chat and search logs, used to improve search and recommendations (see the privacy policy).

Nothing here identifies a person: no user id, no IP address, no link to saved chats. A random per-browser-session id
groups the turns of one conversation. Signed-out turns are always logged; signed-in users are logged unless they turn
"Help improve recommendations" off. Feedback (good/bad and a comment) is attached to the logged turn.
"""
from __future__ import annotations

import secrets

from . import db


async def log_turn(session: str | None, question: str, filters: dict, result_ids: list[str], answer: str, model: str | None) -> str:
    from psycopg.types.json import Jsonb

    lid = secrets.token_urlsafe(12)
    await db.execute(
        "INSERT INTO chat_logs (id, session, question, filters, result_ids, answer, model) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (lid, (session or "")[:64] or None, question[:2000], Jsonb(filters), result_ids[:20], answer[:8000], model),
    )
    return lid


async def feedback(log_id: str, rating: int | None, comment: str | None) -> bool:
    return bool(await db.one(
        "UPDATE chat_logs SET rating = COALESCE(%s, rating), comment = COALESCE(%s, comment), feedback_at = now() WHERE id = %s RETURNING id",
        (rating, (comment or "").strip()[:2000] or None, log_id),
    ))


SOURCES = ("guided", "search", "catalog", "mcp")   # mcp: tool calls from AI agents (logged server-side)


async def log_search(session: str | None, source: str, query: str | None, filters: dict, result_count: int, result_ids: list[str]) -> str:
    from psycopg.types.json import Jsonb

    lid = secrets.token_urlsafe(12)
    await db.execute(
        "INSERT INTO search_logs (id, session, source, query, filters, result_count, result_ids) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (lid, (session or "")[:64] or None, source, (query or "")[:500] or None, Jsonb(filters or {}), result_count, result_ids[:20]),
    )
    return lid


async def click(log_id: str, entry_id: str) -> bool:
    return bool(await db.one(
        "UPDATE search_logs SET clicked = array_append(clicked, %s) WHERE id = %s AND cardinality(clicked) < 20 RETURNING id",
        (entry_id[:100], log_id),
    ))


def _iso(t):
    from .accounts import iso

    return iso(t)


async def summary() -> dict:
    """For superadmins: how answers are rated and how much each kind of search is used."""
    chats = await db.one("SELECT COUNT(*) AS turns, COUNT(*) FILTER (WHERE rating = 1) AS good, COUNT(*) FILTER (WHERE rating = -1) AS bad, "
                         "COUNT(*) FILTER (WHERE comment IS NOT NULL) AS comments, COUNT(DISTINCT session) AS sessions FROM chat_logs")
    searches = {r["source"]: {"count": r["n"], "noResults": r["none"], "clicked": r["clicked"]} for r in await db.rows(
        "SELECT source, COUNT(*) AS n, COUNT(*) FILTER (WHERE result_count = 0) AS none, COUNT(*) FILTER (WHERE cardinality(clicked) > 0) AS clicked "
        "FROM search_logs GROUP BY source")}
    top = await db.rows("SELECT lower(query) AS q, COUNT(*) AS n, MIN(result_count) AS fewest FROM search_logs WHERE query IS NOT NULL "
                        "GROUP BY 1 ORDER BY 2 DESC LIMIT 15")
    empty = await db.rows("SELECT lower(query) AS q, COUNT(*) AS n FROM search_logs WHERE query IS NOT NULL AND result_count = 0 "
                          "GROUP BY 1 ORDER BY 2 DESC LIMIT 15")
    return {"chats": chats, "searches": searches, "topQueries": top, "noResultQueries": empty}


async def chat_rows(rating: str | None = None, q: str | None = None, before: str | None = None, limit: int = 50) -> list[dict]:
    where, args = [], []
    if rating == "good":
        where.append("rating = 1")
    elif rating == "bad":
        where.append("rating = -1")
    elif rating == "comment":
        where.append("comment IS NOT NULL")
    elif rating == "rated":
        where.append("rating IS NOT NULL OR comment IS NOT NULL")
    if q:
        where.append("question ILIKE %s")
        args.append(f"%{q}%")
    if before:
        where.append("created_at < %s::timestamptz")
        args.append(before)
    rows = await db.rows(f"SELECT * FROM chat_logs {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY created_at DESC LIMIT %s",
                         (*args, min(max(limit, 1), 10000)))
    return [{"id": r["id"], "session": r["session"], "question": r["question"], "filters": r["filters"], "resultIds": r["result_ids"],
             "answer": r["answer"], "model": r["model"], "rating": r["rating"], "comment": r["comment"],
             "createdAt": _iso(r["created_at"]), "feedbackAt": _iso(r["feedback_at"])} for r in rows]


async def search_rows(source: str | None = None, q: str | None = None, before: str | None = None, limit: int = 50, empty: bool = False) -> list[dict]:
    where, args = [], []
    if source in SOURCES:
        where.append("source = %s")
        args.append(source)
    if q:
        where.append("query ILIKE %s")
        args.append(f"%{q}%")
    if empty:
        where.append("result_count = 0")
    if before:
        where.append("created_at < %s::timestamptz")
        args.append(before)
    rows = await db.rows(f"SELECT * FROM search_logs {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY created_at DESC LIMIT %s",
                         (*args, min(max(limit, 1), 10000)))
    return [{"id": r["id"], "session": r["session"], "source": r["source"], "query": r["query"], "filters": r["filters"],
             "resultCount": r["result_count"], "resultIds": r["result_ids"], "clicked": r["clicked"], "createdAt": _iso(r["created_at"])} for r in rows]
