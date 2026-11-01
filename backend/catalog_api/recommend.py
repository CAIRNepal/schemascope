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


def options() -> dict:
    """Everything the guided form needs: areas, types and formats with counts, and the must-haves."""
    cats = store.categories()
    kinds = db.rows("SELECT kind AS k, COUNT(*) AS n FROM entries WHERE NOT legacy GROUP BY 1 ORDER BY 2 DESC")
    formats = db.rows("SELECT f.format AS k, COUNT(*) AS n FROM entry_formats f JOIN entries e ON e.id = f.entry_id WHERE NOT e.legacy GROUP BY 1 ORDER BY 2 DESC LIMIT 16")
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


def _candidates(words: list[str], f: dict, limit: int = 200) -> list[dict]:
    where, args = ["NOT e.legacy"], []
    rank = "0"
    rank_args: list = []
    if words:
        tsq = " | ".join(f"{w}:*" for w in words)
        where.append("e.search @@ to_tsquery('simple', %s)")
        args.append(tsq)
        rank = "ts_rank_cd(e.search, to_tsquery('simple', %s), 32)"
        rank_args = [tsq]
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
    rows = db.rows(
        f"SELECT e.*, {rank} AS rel FROM entries e WHERE {' AND '.join(where)} ORDER BY rel DESC, e.score DESC NULLS LAST LIMIT %s",
        [*rank_args, *args, limit],
    )
    if f.get("open_license"):
        rows = [r for r in rows if OPEN_LICENSE.search(str(json.loads(r["data"]).get("license") or ""))]
    return rows


def _rank(rows: list[dict], words: list[str]) -> list[dict]:
    if not rows:
        return []
    top_rel = max(float(r["rel"] or 0) for r in rows) or 1.0
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        data = json.loads(r["data"])
        rel = float(r["rel"] or 0) / top_rel if words else 0.0
        score = (r["score"] or 0) / 100
        adopt = min(r["adopters"] or 0, 20) / 20
        recent = 0.0
        if r["last_activity"]:
            try:
                age = (now - datetime.fromisoformat(r["last_activity"].replace("Z", "+00:00"))).days / 365
                recent = max(0.0, 1 - age / 5)
            except ValueError:
                pass
        # Coverage: the share of the user's words the resource matches (a mouse-anatomy question prefers mouse anatomy).
        text = " ".join([data.get("acronym") or "", data.get("name") or "", data.get("description") or "", " ".join(data.get("tags") or []),
                         " ".join(data.get("species") or [])]).lower()
        coverage = sum(1 for w in words if w in text) / len(words) if words else 0.0
        match = (0.3 * rel + 0.3 * coverage + 0.25 * score + 0.1 * adopt + 0.05 * recent) if words else (0.65 * score + 0.2 * adopt + 0.15 * recent)
        s = store._summary(r)
        s["license"] = data.get("license")
        s["homepage"] = data.get("homepage")
        s["match"] = round(match, 3)
        s["why"] = _reasons(s, words, data)
        out.append(s)
    out.sort(key=lambda x: x["match"], reverse=True)
    return out


def _reasons(s: dict, words: list[str], data: dict) -> list[str]:
    why = []
    if words:
        text = " ".join([s.get("acronym") or "", s["name"], data.get("description") or "", " ".join(data.get("tags") or [])]).lower()
        hit = [w for w in words if w in text]
        if hit:
            why.append("Matches " + ", ".join(f"“{w}”" for w in hit[:3]))
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


def recommend(q: str | None = None, limit: int = 8, page: int = 1, **filters) -> dict:
    """Ranked recommendations with reasons. Empty results relax the filters one at a time (most specific first)."""
    f = {k: v for k, v in filters.items() if v not in (None, "", False)}
    words = _words(q)
    relaxed: list[str] = []
    rows = _candidates(words, f)
    for key, label in RELAX_ORDER:
        if rows:
            break
        if key in f:
            f.pop(key)
            relaxed.append(label)
            rows = _candidates(words, f)
    if not rows and words:  # last resort: the words alone, any word
        rows = _candidates(words, {})
    size = max(1, min(limit, 20))
    page = max(1, page)
    ranked = _rank(rows, words)
    items = ranked[(page - 1) * size: page * size]
    return {"query": q or "", "words": words, "filters": f, "relaxed": relaxed, "total": len(ranked), "page": page, "size": size,
            "pages": max(1, -(-len(ranked) // size)), "capped": len(ranked) >= 200, "items": items}
