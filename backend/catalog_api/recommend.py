"""Recommendations: "which resource should I use?"

Two ways in, one engine:
- Guided (faceted): the user answers a few questions (area, type, format, must-haves) and gets a ranked list.
- Chat: a small language model turns the user's words into the same filters, then explains the results (chat.py).

Ranking is deterministic and explainable: relevance to the words given, the evaluation score, adoption and recent
activity, with a list of reasons per result. When the filters leave nothing, they are relaxed one at a time and the
response says which were relaxed.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone

from . import db, store

OPEN_LICENSE = re.compile(r"\b(CC0|CC[- ]BY(?![- ]?NC)(?![- ]?ND)|MIT|Apache|BSD|GPL|LGPL|MPL|ODbL|ODC|PDDL|public domain|Unlicense)\b", re.I)
STOPWORDS = set("""a an and are as at be best but by can do does for from good have i if in into is it its looking me my need
needs of on or our please recommend recommendation should some something suggest that the their them there these this to
use used using want we what which with would you your ontology ontologies schema schemas vocabulary vocabularies standard
standards resource resources find show give""".split())
GRADES = ["A", "B", "C", "D", "E"]
MAINTAINED_YEARS = 2


def _words(q: str | None) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (q or "").lower()) if len(w) > 1 and w not in STOPWORDS][:10]


async def options() -> dict:
    """Everything the guided form needs: areas, types and formats with counts, and the must-haves."""
    cats = await store.categories()
    kinds = await db.rows("SELECT kind AS k, COUNT(*) AS n FROM entries WHERE NOT legacy GROUP BY 1 ORDER BY 2 DESC")
    formats = await db.rows("SELECT f.format AS k, COUNT(*) AS n FROM entry_formats f JOIN entries e ON e.id = f.entry_id WHERE NOT e.legacy GROUP BY 1 ORDER BY 2 DESC LIMIT 16")
    from .derived import KIND_LABEL

    return {
        "areas": [{"id": c["id"], "name": c["name"], "blurb": c.get("blurb"), "count": c.get("reach") or c.get("count")} for c in cats],
        "kinds": [{"id": r["k"], "name": KIND_LABEL.get(r["k"], r["k"]), "count": r["n"]} for r in kinds if r["k"]],
        "formats": [{"id": r["k"], "count": r["n"]} for r in formats],
        "needs": [
            {"id": "maintained", "name": "Actively maintained", "help": f"Updated in the last {MAINTAINED_YEARS} years"},
            {"id": "open_license", "name": "Open licence", "help": "CC0, CC BY, MIT, Apache, BSD, GPL and similar"},
            {"id": "used", "name": "Used by other projects", "help": "At least one known adopter"},
        ],
        "grades": GRADES,
    }


async def _weights(words: list[str]) -> dict[str, float]:
    """How much each word counts: rare words (“gdpr”) far more than common ones (“data”). Inverse document frequency
    over the catalog; words that match nothing are dropped."""
    if not words:
        return {}
    cols = ", ".join(f"COUNT(*) FILTER (WHERE search @@ to_tsquery('simple', %s)) AS d{i}" for i in range(len(words)))
    r = await db.one(f"SELECT COUNT(*) AS n, {cols} FROM entries WHERE NOT legacy", [f"{w}:*" for w in words])
    n = r["n"] or 1
    return {w: math.log((n + 1) / (r[f"d{i}"] + 1)) + 0.05 for i, w in enumerate(words) if r[f"d{i}"]}


async def _candidates(weights: dict[str, float], f: dict, limit: int = 200) -> list[dict]:
    """Resources matching the words (any of them) and the filters, most relevant first.

    Relevance is computed in SQL: the summed weights of the words a resource matches, plus a third more for a word in
    its name or acronym (tsvector weight A). `hits` lists the matched words, for the reasons shown to people."""
    where, args = ["NOT e.legacy"], []
    rel, rel_args, hits, hit_args = "0", [], "ARRAY[]::text[]", []
    words = list(weights)
    if words:
        tsq = " | ".join(f"{w}:*" for w in words)
        where.append("e.search @@ to_tsquery('simple', %s)")
        args.append(tsq)
        parts = []
        for w, wt in weights.items():
            parts.append(f"(CASE WHEN e.search @@ to_tsquery('simple', %s) THEN {wt:.4f} ELSE 0 END)")
            parts.append(f"(CASE WHEN e.search @@ to_tsquery('simple', %s) THEN {wt / 3:.4f} ELSE 0 END)")
            rel_args += [f"{w}:*", f"{w}:*A"]
        rel = " + ".join(parts)
        hits = "ARRAY_REMOVE(ARRAY[" + ", ".join("CASE WHEN e.search @@ to_tsquery('simple', %s) THEN %s END" for _ in words) + "], NULL)"
        for w in words:
            hit_args += [f"{w}:*", w]
    if f.get("category"):
        where.append("e.id IN (SELECT entry_id FROM entry_domains WHERE category = %s)")
        args.append(f["category"])
    if f.get("kind"):
        where.append("e.kind = %s")
        args.append(f["kind"])
    if f.get("format"):
        where.append("e.id IN (SELECT entry_id FROM entry_formats WHERE lower(format) = lower(%s))")
        args.append(f["format"])
    if f.get("min_grade") in GRADES:
        where.append("e.grade IS NOT NULL AND e.grade <= %s")
        args.append(f["min_grade"])
    if f.get("maintained"):
        since = (datetime.now(timezone.utc) - timedelta(days=365 * MAINTAINED_YEARS)).strftime("%Y-%m-%d")
        where.append("e.last_activity >= %s")
        args.append(since)
    if f.get("used"):
        where.append("e.adopters > 0")
    rows = await db.rows(
        f"SELECT e.*, {rel} AS rel, {hits} AS hits FROM entries e WHERE {' AND '.join(where)} "
        f"ORDER BY rel DESC, e.score DESC NULLS LAST LIMIT %s",
        [*rel_args, *hit_args, *args, limit],
    )
    if f.get("open_license"):
        rows = [r for r in rows if OPEN_LICENSE.search(str(json.loads(r["data"]).get("license") or ""))]
    return rows


def _quality(r: dict, now: datetime) -> float:
    """Evaluation score, adoption and recent activity, 0–1. Used to break ties between equally relevant results."""
    score = (r["score"] or 0) / 100
    adopt = min(r["adopters"] or 0, 20) / 20
    recent = 0.0
    if r["last_activity"]:
        try:
            age = (now - datetime.fromisoformat(r["last_activity"].replace("Z", "+00:00"))).days / 365
            recent = max(0.0, 1 - age / 5)
        except ValueError:
            pass
    return 0.6 * score + 0.25 * adopt + 0.15 * recent


async def _rank(rows: list[dict], weights: dict[str, float], sort: str | None = None) -> list[dict]:
    """Relevance first. Quality only nudges results that are about equally relevant; with sort="score", the relevant
    results (at least 60% as relevant as the best) are ordered by evaluation score instead."""
    if not rows:
        return []
    full = sum(weights.values()) * (4 / 3) or 1.0
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        data = json.loads(r["data"])
        rel = min(1.0, float(r["rel"] or 0) / full) if weights else 0.0
        q = _quality(r, now)
        s = await store._summary(r)
        s["license"] = data.get("license")
        s["homepage"] = data.get("homepage")
        s["relevance"] = round(rel, 3)
        s["match"] = round(0.85 * rel + 0.15 * q, 3) if weights else round(q, 3)
        s["why"] = _reasons(s, list(r.get("hits") or []))
        out.append(s)
    out.sort(key=lambda x: x["match"], reverse=True)
    if sort == "score" and weights:
        top = max(x["relevance"] for x in out)
        relevant = [x for x in out if x["relevance"] >= 0.6 * top]
        rest = [x for x in out if x["relevance"] < 0.6 * top]
        relevant.sort(key=lambda x: (x["score"] or -1, x["relevance"]), reverse=True)
        out = relevant + rest
    return out


def _reasons(s: dict, hits: list[str]) -> list[str]:
    why = []
    if hits:
        why.append("Matches " + ", ".join(f"“{w}”" for w in hits[:4]))
    if s.get("grade"):
        why.append(f"Grade {s['grade']} ({s['score']}/100)")
    if s.get("adopters"):
        why.append(f"Used by {s['adopters']} project{'s' if s['adopters'] != 1 else ''}")
    if s.get("lastActivity"):
        why.append(f"Last updated {s['lastActivity'][:7]}")
    if s.get("license"):
        why.append(f"{'Open licence' if OPEN_LICENSE.search(str(s['license'])) else 'Licence'}: {s['license']}")
    if s.get("formats"):
        why.append("Formats: " + ", ".join(s["formats"][:3]))
    return why


RELAX_ORDER = [("format", "format"), ("used", "used by other projects"), ("open_license", "open licence"),
               ("maintained", "actively maintained"), ("min_grade", "minimum grade"), ("kind", "type"), ("category", "area")]


async def recommend(q: str | None = None, limit: int = 8, page: int = 1, sort: str | None = None, **filters) -> dict:
    """Ranked recommendations with reasons: relevance to the words first, quality to break ties (or to order the
    relevant results, with sort="score"). Empty results relax the filters one at a time (most specific first)."""
    f = {k: v for k, v in filters.items() if v not in (None, "", False)}
    words = _words(q)
    weights = await _weights(words)
    relaxed: list[str] = []
    rows = await _candidates(weights, f)
    for key, label in RELAX_ORDER:
        if rows:
            break
        if key in f:
            f.pop(key)
            relaxed.append(label)
            rows = await _candidates(weights, f)
    size = max(1, min(limit, 20))
    page = max(1, page)
    ranked = await _rank(rows, weights, sort)
    items = ranked[(page - 1) * size: page * size]
    return {"query": q or "", "words": list(weights) or words, "filters": f, "relaxed": relaxed, "sort": sort or "relevance",
            "total": len(ranked), "page": page, "size": size, "pages": max(1, -(-len(ranked) // size)),
            "capped": len(ranked) >= 200, "items": items}
