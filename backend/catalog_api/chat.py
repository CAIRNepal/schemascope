"""Recommendation chat, built for a small CPU-only server.

1. The user's words become filters with simple rules (areas, types, formats and must-haves are matched by name); no
   model call is needed for this step.
2. The recommender (recommend.py) returns ranked candidates with reasons.
3. A small instruction model (Ollama, LLM_MODEL) writes a short answer that may only use those candidates. The prompt
   is kept to a few hundred tokens and the answer is capped, and only LLM_CONCURRENCY answers are generated at once.

Without a model (LLM_URL empty, the server unreachable or busy) the chat still answers with the ranked matches.
Responses stream as NDJSON events: filters, results, token…, done.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import AsyncIterator

import httpx

from . import recommend, settings, store

_slots = asyncio.Semaphore(max(1, settings.LLM_CONCURRENCY))
_status = {"at": 0.0, "ok": False}


async def available() -> bool:
    """Whether the model server answers (checked at most every 30 s)."""
    if not settings.LLM_URL:
        return False
    if time.monotonic() - _status["at"] < 30:
        return _status["ok"]
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{settings.LLM_URL}/api/tags")
            names = [m.get("name") for m in r.json().get("models", [])]
            ok = r.status_code == 200 and any(n == settings.LLM_MODEL or n.split(":")[0] == settings.LLM_MODEL for n in names)
    except Exception:
        ok = False
    _status.update(at=time.monotonic(), ok=ok)
    return ok


# ---------- 1. words → filters (rules, no model) ----------
NEEDS = {
    "maintained": r"\b(maintained|active(ly)?|up[- ]to[- ]date|recent(ly)?|current|alive|updated)\b",
    "open_license": r"\b(open[- ]?(licen[cs]e|source|access)?|free(ly)? (to )?(use|reuse)|cc0|cc[- ]by|permissive|reusable)\b",
    "used": r"\b(widely used|popular|adopted|community|used by|established|well[- ]known|standard choice)\b",
}
# "best" is not a filter (ranking already prefers high scores); only an explicit quality ask is.
GRADE_WORDS = r"\b(high[- ]quality|high[- ]grade|grade [ab]|well[- ]evaluated)\b"
# People say "vocabulary" or "standard" loosely, so only these types become a hard filter.
STRICT_KINDS = {"ontology", "schema", "atlas", "knowledge-base"}


def parse(text: str, history: list[str] | None = None) -> dict:
    """Filters from the user's latest message (with earlier user messages as context for follow-ups)."""
    opts = recommend.options()
    t = text.lower()
    ctx = " ".join([*(history or [])[-3:], text]).lower()
    f: dict = {}
    for a in opts["areas"]:
        names = {a["id"].lower(), a["name"].lower(), a["name"].lower().split(" & ")[0], a["name"].lower().split(",")[0]}
        if any(n and len(n) > 3 and re.search(rf"\b{re.escape(n)}\b", ctx) for n in names):
            f["category"] = a["id"]
            break
    for k in [k for k in opts["kinds"] if k["id"] in STRICT_KINDS]:
        stem = k["id"].split("-")[0]
        if re.search(rf"\b{re.escape(k['name'].lower())}s?\b|\b{re.escape(stem)}(s|ies|y)?\b", t) and stem not in ("data",):
            f["kind"] = k["id"]
            break
    for fm in opts["formats"]:
        if re.search(rf"(?<![\w-]){re.escape(fm['id'].lower())}(?![\w-])", ctx):
            f["format"] = fm["id"]
            break
    for key, rx in NEEDS.items():
        if re.search(rx, ctx):
            f[key] = True
    if re.search(GRADE_WORDS, t):
        f["min_grade"] = "B"
    return f


# ---------- 3. the answer (model) ----------
def _brand() -> str:
    cfg = settings.site_config()
    return cfg.get("brand") or cfg.get("name") or "the catalog"


def prompt(question: str, items: list[dict], relaxed: list[str]) -> list[dict]:
    """A compact prompt: the question and up to five candidates, one line each."""
    lines = []
    for i, x in enumerate(items[:5], 1):
        lines.append(
            f"{i}. {x.get('acronym') or x['name']} ({x['name']}) | {x.get('kindLabel') or x.get('kind')} | grade {x.get('grade') or 'not evaluated'}"
            f"{f' ({x['score']}/100)' if x.get('score') is not None else ''} | used by {x.get('adopters') or 0} projects | "
            f"updated {(x.get('lastActivity') or 'unknown')[:7]} | licence {x.get('license') or 'unknown'} | {x.get('description') or ''}"
        )
    note = f"\nNote: no exact match, so these filters were relaxed: {', '.join(relaxed)}." if relaxed else ""
    system = (
        f"You help researchers choose resources from {_brand()}, a catalog of evaluated ontologies, schemas and standards. "
        "Recommend only from the CANDIDATES list; never mention anything else. Pick the best one to three for the question. "
        "For each, give one short sentence on why it fits, using the facts given (grade, use, updates, licence). "
        "Mention a trade-off if there is one. Only state facts that appear in the list; do not call a resource widely used "
        "unless it is used by several projects. Be brief: at most 110 words, plain text, no headings, no lists of fields, "
        "and do not mention the word CANDIDATES."
    )
    user = f"QUESTION: {question}\n\nCANDIDATES:\n" + ("\n".join(lines) or "(none)") + note
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def _generate(messages: list[dict]) -> AsyncIterator[str]:
    body = {
        "model": settings.LLM_MODEL, "messages": messages, "stream": True, "keep_alive": "30m",
        "options": {"temperature": 0.2, "num_predict": settings.LLM_MAX_TOKENS, "num_ctx": 2048, **({"num_thread": settings.LLM_THREADS} if settings.LLM_THREADS else {})},
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(settings.LLM_TIMEOUT, connect=5)) as c:
        async with c.stream("POST", f"{settings.LLM_URL}/api/chat", json=body) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line:
                    continue
                d = json.loads(line)
                if d.get("message", {}).get("content"):
                    yield d["message"]["content"]
                if d.get("done"):
                    break


def _plain_answer(items: list[dict], relaxed: list[str]) -> str:
    """The answer when no model is available: the top matches with their strongest reasons."""
    if not items:
        return "I couldn't find a matching resource. Try fewer or different words, or browse the catalog."
    top = items[:3]
    parts = [f"{x.get('acronym') or x['name']}: {'; '.join(x['why'][:3])}." for x in top]
    lead = f"No exact match ({', '.join(relaxed)} relaxed), but these come closest. " if relaxed else "Best matches: "
    return lead + " ".join(parts)


async def stream(messages: list[dict]) -> AsyncIterator[bytes]:
    """NDJSON events for one chat turn."""
    def ev(**d) -> bytes:
        return (json.dumps(d, ensure_ascii=False) + "\n").encode()

    users = [m["content"] for m in messages if m.get("role") == "user" and m.get("content")]
    question = users[-1].strip()[:600]
    filters = parse(question, users[:-1])
    rec = recommend.recommend(question, limit=6, **filters)
    yield ev(type="filters", filters=rec["filters"], relaxed=rec["relaxed"], words=rec["words"])
    yield ev(type="results", items=rec["items"])
    model = None
    if rec["items"] and await available() and not _slots.locked():
        async with _slots:
            try:
                model = settings.LLM_MODEL
                got = False
                async for piece in _generate(prompt(question, rec["items"], rec["relaxed"])):
                    got = True
                    yield ev(type="token", text=piece)
                if not got:
                    raise RuntimeError("empty answer")
            except Exception:
                _status.update(at=time.monotonic(), ok=False)
                model = None
                yield ev(type="token", text=_plain_answer(rec["items"], rec["relaxed"]))
    else:
        if rec["items"] and settings.LLM_URL and _slots.locked():
            yield ev(type="notice", text="The assistant is busy, so here are the best matches directly.")
        yield ev(type="token", text=_plain_answer(rec["items"], rec["relaxed"]))
    yield ev(type="done", model=model)


def status() -> dict:
    return {"configured": bool(settings.LLM_URL), "model": settings.LLM_MODEL if settings.LLM_URL else None}


def _store_ok() -> bool:  # used by tests
    return bool(store.stats())
