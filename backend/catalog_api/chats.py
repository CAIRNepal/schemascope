"""Saved recommendation chats for signed-in users: list, open, rename, delete, and append a turn."""
from __future__ import annotations

import secrets

from psycopg.types.json import Jsonb

from . import db
from .accounts import iso

MAX_CHATS = 200  # per user; the oldest are removed beyond this


def _title(question: str) -> str:
    t = " ".join(question.split())
    return t if len(t) <= 70 else t[:67].rstrip() + "…"


async def owned(user_id: int, chat_id: str) -> dict | None:
    return await db.one("SELECT * FROM chats WHERE id = %s AND user_id = %s", (chat_id, user_id))


async def start(user_id: int, question: str) -> dict:
    cid = secrets.token_urlsafe(9)
    row = await db.one("INSERT INTO chats (id, user_id, title) VALUES (%s, %s, %s) RETURNING *", (cid, user_id, _title(question)))
    await db.execute(
        "DELETE FROM chats WHERE user_id = %s AND id IN (SELECT id FROM chats WHERE user_id = %s ORDER BY updated_at DESC OFFSET %s)",
        (user_id, user_id, MAX_CHATS),
    )
    return row


async def add_turn(chat_id: str, question: str, answer: str, data: dict) -> None:
    await db.execute("INSERT INTO chat_messages (chat_id, role, content) VALUES (%s, 'user', %s)", (chat_id, question))
    await db.execute("INSERT INTO chat_messages (chat_id, role, content, data) VALUES (%s, 'assistant', %s, %s)", (chat_id, answer, Jsonb(data)))
    await db.execute("UPDATE chats SET updated_at = now() WHERE id = %s", (chat_id,))


async def list_for(user_id: int) -> list[dict]:
    rows = await db.rows("SELECT id, title, created_at, updated_at FROM chats WHERE user_id = %s ORDER BY updated_at DESC LIMIT %s", (user_id, MAX_CHATS))
    return [{"id": r["id"], "title": r["title"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"])} for r in rows]


async def get(user_id: int, chat_id: str) -> dict | None:
    c = await owned(user_id, chat_id)
    if not c:
        return None
    msgs = await db.rows("SELECT role, content, data, created_at FROM chat_messages WHERE chat_id = %s ORDER BY id", (chat_id,))
    return {"id": c["id"], "title": c["title"], "createdAt": iso(c["created_at"]), "updatedAt": iso(c["updated_at"]),
            "messages": [{"role": m["role"], "content": m["content"], "data": m["data"], "createdAt": iso(m["created_at"])} for m in msgs]}


async def rename(user_id: int, chat_id: str, title: str) -> bool:
    return bool(await db.one("UPDATE chats SET title = %s WHERE id = %s AND user_id = %s RETURNING id", (_title(title), chat_id, user_id)))


async def delete(user_id: int, chat_id: str) -> bool:
    return bool(await db.one("DELETE FROM chats WHERE id = %s AND user_id = %s RETURNING id", (chat_id, user_id)))


async def delete_all(user_id: int) -> int:
    return await db.execute("DELETE FROM chats WHERE user_id = %s", (user_id,))
