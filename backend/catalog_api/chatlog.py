"""Anonymous chat log, used to improve search and recommendations (see the privacy policy).

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


async def summary(limit: int = 50) -> dict:
    """For superadmins: recent turns and how answers were rated."""
    counts = await db.one("SELECT COUNT(*) AS turns, COUNT(*) FILTER (WHERE rating = 1) AS good, COUNT(*) FILTER (WHERE rating = -1) AS bad, "
                          "COUNT(*) FILTER (WHERE comment IS NOT NULL) AS comments FROM chat_logs")
    rows = await db.rows("SELECT id, question, result_ids, model, rating, comment, created_at FROM chat_logs ORDER BY created_at DESC LIMIT %s", (limit,))
    from .accounts import iso

    return {**counts, "recent": [{**r, "created_at": iso(r["created_at"])} for r in rows]}
