"""API tests against a throwaway Postgres database loaded from a small fixture repository.

Needs Postgres: `docker compose -f infrastructure/sandbox/docker-compose.yml up -d db` (or set TEST_DATABASE_URL to
any server where the user may create databases). Tests are skipped when no server is reachable.
"""
from __future__ import annotations

import importlib
import json
import os
import secrets
import sys

import pytest

ADMIN_URL = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or "postgresql://catalog:catalog@127.0.0.1:5433/catalog"


@pytest.fixture(scope="module")
def database():
    psycopg = pytest.importorskip("psycopg")
    try:
        admin = psycopg.connect(ADMIN_URL, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as err:
        pytest.skip(f"Postgres not reachable at {ADMIN_URL} ({err.__class__.__name__}); start it with docker compose")
    name = f"test_{secrets.token_hex(6)}"
    admin.execute(f'CREATE DATABASE "{name}"')
    base, _, _ = ADMIN_URL.rpartition("/")
    yield f"{base}/{name}"
    admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    admin.close()

CATEGORIES = [
    {"id": "life", "name": "Life Sciences", "icon": "dna", "blurb": "Genes and cells."},
    {"id": "earth", "name": "Earth Science", "icon": "globe", "blurb": "Planet."},
]
def run(coro):
    """Run one of the API's async functions from a test."""
    import asyncio

    return asyncio.run(coro)


CATALOG = [
    {"id": "go", "acronym": "GO", "name": "Gene Ontology", "category": "life", "kind": "ontology", "description": "Gene function.",
     "formats": ["OWL", "OBO"], "tags": ["genes"], "obo": "go", "domains": ["earth"], "usedBy": [{"name": "UniProt", "url": "https://uniprot.org"}]},
    {"id": "envo", "acronym": "ENVO", "name": "Environment Ontology", "category": "earth", "kind": "ontology", "description": "Environments.",
     "formats": ["OWL"], "status": "legacy"},
    {"id": "top", "name": "Top Ontology", "category": "earth", "kind": "ontology", "description": "Named like a route."},
    {"id": "sch", "name": "Some Schema", "category": "life", "kind": "schema", "description": "A JSON schema.", "formats": ["JSON Schema"]},
]


def facts(score, grade, crit):
    return {"score": score, "grade": grade, "fair": 30, "breakdown": {k: {"score": v, "max": 12} for k, v in crit.items()},
            "ols": {"importsFrom": ["envo", "bfo"]}, "links": {"homepage": {"state": "ok"}}}


@pytest.fixture(scope="module")
def client(tmp_path_factory, database):
    repo = tmp_path_factory.mktemp("repo")
    data = repo / "data"
    (data / "runs").mkdir(parents=True)
    (repo / "site.config.json").write_text(json.dumps({"name": "TestScope", "url": "https://example.org", "repository": "https://github.com/example/catalog"}))
    (data / "categories.json").write_text(json.dumps(CATEGORIES))
    (data / "catalog.json").write_text(json.dumps(CATALOG))
    r1 = {"go": facts(70, "B", {"findable": 8}), "envo": facts(40, "D", {"findable": 4})}
    r2 = {"go": facts(80, "B", {"findable": 10}), "envo": facts(40, "D", {"findable": 4})}
    (data / "runs" / "r1.json").write_text(json.dumps({"run": {"id": "r1", "finishedAt": "2026-01-01T00:00:00Z", "evaluator": {"rubricVersion": "4.0"}}, "entries": r1}))
    (data / "runs" / "r2.json").write_text(json.dumps({"run": {"id": "r2", "finishedAt": "2026-02-01T00:00:00Z", "evaluator": {"rubricVersion": "4.1"}}, "entries": r2}))
    (data / "roadmap.json").write_text(json.dumps({"updated": "2026-01-01", "sections": []}))
    (data / "evaluation.json").write_text(json.dumps({"generatedAt": "2026-02-01T00:00:00Z", "entries": r2}))

    mp = pytest.MonkeyPatch()
    mp.setenv("CATALOG_REPO", str(repo))
    mp.setenv("DATABASE_URL", database)
    mp.setenv("MCP_ALLOWED_HOSTS", "testserver")
    mp.setenv("JWT_SECRET", "test-secret-" + "x" * 32)
    mp.setenv("SUPERADMIN_EMAILS", "ada@example.org")
    mp.setenv("DEV_LOGIN", "1")
    mp.setenv("TRUSTED_PROXIES", "testclient")
    mp.setenv("RATE_LIMIT_ANON", "1000")
    mp.setenv("PUBLIC_SITE_URL", "http://testserver")
    for m in [m for m in sys.modules if m.startswith("catalog_api")]:
        del sys.modules[m]
    ingest = importlib.import_module("catalog_api.ingest")
    ingest.ingest(rebuild=True)
    from fastapi.testclient import TestClient

    app = importlib.import_module("catalog_api.app").app
    with TestClient(app) as c:
        yield c
    importlib.import_module("catalog_api.db").close()
    mp.undo()


def test_search_and_facets(client):
    r = client.get("/api/entries", params={"q": "gene"}).json()
    assert r["total"] == 1 and r["items"][0]["id"] == "go"
    all_ = client.get("/api/entries", params={"sort": "score"}).json()
    assert [x["id"] for x in all_["items"]] == ["go", "envo", "sch", "top"]
    assert all_["facets"]["kind"] == {"ontology": 3, "schema": 1}
    # Secondary domains count for the category filter.
    earth = client.get("/api/entries", params={"category": "earth"}).json()
    assert {x["id"] for x in earth["items"]} == {"go", "envo", "top"}
    assert client.get("/api/entries", params={"legacy": "false"}).json()["total"] == 3
    assert [x["id"] for x in client.get("/api/entries", params={"grade": "none", "sort": "name"}).json()["items"]] == ["sch", "top"]


def test_entry_history_and_changes(client):
    d = client.get("/api/entries/go").json()
    assert d["summary"]["score"] == 80
    assert [p["score"] for p in d["history"]] == [70, 80]
    assert any("Findable: 8 → 10" in c["what"] for c in d["changes"])
    assert {"key": "envo", "entryId": "envo", "label": "ENVO"} in d["imports"]
    assert d["adopters"][0]["name"] == "UniProt"
    assert client.get("/api/entries/nope").status_code == 404


def test_runs_stats_categories(client):
    assert [r["id"] for r in client.get("/api/runs").json()] == ["r2", "r1"]
    assert client.get("/api/runs/r1").json()["total"] == 2
    s = client.get("/api/stats").json()
    assert s["entries"] == 4 and s["runs"] == 2 and s["crossDomain"] == 1
    cats = {c["id"]: c for c in client.get("/api/categories").json()}
    assert cats["earth"]["count"] == 2 and cats["earth"]["reach"] == 3


def test_mcp_tools(client):
    from catalog_api import mcp_server

    assert run(mcp_server.search_catalog(query="environment"))["items"][0]["url"] == "https://example.org/o/envo/"
    assert run(mcp_server.get_entry("go"))["evaluation"]["score"] == 80
    assert len(run(mcp_server.get_entry_history("go"))["runs"]) == 2
    assert "error" in run(mcp_server.get_entry("nope"))


def _signed_in():
    """A separate client signed in through the dev login (sets the session cookie)."""
    from fastapi.testclient import TestClient
    from catalog_api.app import app

    c = TestClient(app)
    assert c.get("/api/auth/dev-login", params={"login": "ada", "next": "/submit/"}, follow_redirects=False).status_code == 302
    return c


def _token(scopes=("api", "mcp")):
    c = _signed_in()
    r = c.post("/api/tokens", json={"name": "test", "scopes": list(scopes)})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def test_mcp_endpoint_lists_tools(client):
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json", "Authorization": f"Bearer {_token()}"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}
    assert client.post("/mcp/", json=init, headers=headers).status_code == 200
    r = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=headers)
    assert r.status_code == 200 and "search_catalog" in r.text


def test_concurrent_requests(client):
    # Requests run in worker threads; each must get its own SQLite connection.
    from concurrent.futures import ThreadPoolExecutor

    paths = ["/api/entries?q=gene", "/api/entries?category=earth", "/api/entries/go", "/api/stats", "/api/categories"] * 8
    with ThreadPoolExecutor(max_workers=16) as pool:
        codes = list(pool.map(lambda p: client.get(p).status_code, paths))
    assert set(codes) == {200}


def test_content(client):
    assert client.get("/api/content/roadmap").json()["sections"] == []
    assert client.get("/api/content/validation").status_code == 404
    assert client.get("/api/content/secrets").status_code == 404


def test_entry_ids_that_look_like_routes(client):
    # An entry may be called "top"; helper lists must not shadow it.
    assert client.get("/api/entries/top").json()["entry"]["name"] == "Top Ontology"
    assert [x["id"] for x in client.get("/api/top-entries").json()] == ["go", "envo"]
    assert {x["id"] for x in client.get("/api/entry-ids").json()} == {"go", "envo", "sch", "top"}
    assert client.get("/api/recent-entries").status_code == 200


def test_domain_graph(client):
    g = client.get("/api/domain-graph").json()
    assert {n["id"]: n["reach"] for n in g["nodes"]} == {"life": 2, "earth": 3}
    # go spans life+earth (1) and imports envo across domains (0.5).
    assert g["edges"] == [{"a": "earth", "b": "life", "n": 1.5}]
    assert g["bridges"][0]["id"] == "go"


def test_site_data_and_snapshot(client):
    d = client.get("/api/site-data").json()
    assert d["config"]["name"] == "TestScope" and len(d["catalog"]) == 4
    assert d["evaluation"]["entries"]["go"]["score"] == 80
    assert [x["score"] for x in d["history"]["go"]] == [70, 80]
    assert [r["run"]["id"] for r in d["runs"]] == ["r1", "r2"] and sorted(d["runs"][0]["scores"]) == [40, 70]
    assert d["roadmap"]["sections"] == [] and d["validation"] is None
    assert client.get("/api/runs/r1/snapshot").json()["run"]["id"] == "r1"
    assert client.get("/api/runs/nope/snapshot").status_code == 404


def test_mcp_requires_mcp_token(client):
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}
    h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    r = client.post("/mcp/", json=init, headers=h)
    assert r.status_code == 401 and r.headers["content-type"] == "application/problem+json"
    r = client.post("/mcp/", json=init, headers={**h, "Authorization": f"Bearer {_token(['api'])}"})
    assert r.status_code == 403


def test_sessions_tokens_and_scopes(client):
    c = _signed_in()
    me = c.get("/api/auth/me").json()
    assert me["user"]["login"] == "ada" and me["via"] == "session"
    jwt_token = c.post("/api/auth/token").json()["token"]
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {jwt_token}"}).json()["via"] == "session"
    created = c.post("/api/tokens", json={"name": "script", "scopes": ["api"], "expiresInDays": 7}).json()
    pat = created["token"]
    assert pat.startswith(created["hint"].split("…")[0]) and "token" not in c.get("/api/tokens").json()[0]
    r = client.get("/api/stats", headers={"Authorization": f"Bearer {pat}"})
    assert r.status_code == 200 and r.headers["x-ratelimit-limit"] == "1000"
    # Tokens can't manage tokens; revoked tokens stop working; bad tokens are rejected, not ignored.
    assert client.post("/api/tokens", json={"name": "x"}, headers={"Authorization": f"Bearer {pat}"}).status_code == 403
    assert c.delete(f"/api/tokens/{created['id']}").status_code == 204
    assert client.get("/api/stats", headers={"Authorization": f"Bearer {pat}"}).status_code == 401
    assert client.get("/api/stats", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_rate_limit_and_problem_details(client):
    from catalog_api import settings
    from catalog_api.guard import window

    old = settings.RATE_LIMIT_ANON
    settings.RATE_LIMIT_ANON = 3
    window.counts.clear()
    try:
        codes = [client.get("/api/stats", headers={"X-Forwarded-For": "203.0.113.9"}).status_code for _ in range(4)]
        assert codes == [200, 200, 200, 429]
        r = client.get("/api/stats", headers={"X-Forwarded-For": "203.0.113.9"})
        assert r.headers["content-type"] == "application/problem+json" and r.json()["status"] == 429 and "retry-after" in r.headers
        assert client.get("/api/stats", headers={"X-Forwarded-For": "203.0.113.10"}).status_code == 200  # other IP
    finally:
        settings.RATE_LIMIT_ANON = old
        window.counts.clear()
    p = client.get("/api/entries/nope").json()
    assert p["status"] == 404 and p["title"] == "Not Found" and p["instance"] == "/api/entries/nope"
    assert client.get("/api/entries", params={"page": 0}).json()["status"] == 422
    # The whole-catalog dump is only for the site server, not for visitors coming through it.
    assert client.get("/api/site-data", headers={"X-Forwarded-For": "203.0.113.9"}).status_code == 403


def test_submission_records_contributor(client):
    entry = {"id": "newont", "name": "New Ontology", "category": "life", "kind": "ontology",
             "description": "A new ontology that describes something in enough words.", "homepage": "https://example.org/new",
             "usedBy": [{"name": "Project", "url": "https://example.org/p", "note": "Annotations"}]}
    assert client.post("/api/submissions", json={"entry": entry}).status_code == 401
    c = _signed_in()
    r = c.post("/api/submissions", json={"entry": entry, "notes": "Please review"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["submittedBy"]["login"] == "ada" and "Submitted by** @ada" in body["issueBody"] and "/issues/new?" in body["issueUrl"]
    assert c.get("/api/submissions").json()[0]["entryId"] == "newont"
    bad = c.post("/api/submissions", json={"entry": {**entry, "usedBy": [{"name": "X", "url": "not-a-url"}]}})
    assert bad.status_code == 422 and "Used by" in bad.json()["detail"]


def test_audit_log(client):
    c = _signed_in()
    c.post("/api/tokens", json={"name": "audited", "scopes": ["api"]})
    c.post("/api/auth/logout")
    mine = _signed_in().get("/api/auth/activity").json()
    actions = [a["action"] for a in mine]
    assert {"auth.login", "token.create", "auth.logout"} <= set(actions)
    assert all(a["actor"]["login"] == "ada" for a in mine) and mine[0]["ip"]
    log = _signed_in().get("/api/audit", params={"action": "catalog.*"}).json()  # ada is a superadmin in this test
    assert log and log[-1]["action"] == "catalog.ingest" and log[-1]["actor"] is None and log[-1]["details"]["entries"] == 4


def test_superadmin_rate_limits(client):
    admin = _signed_in()  # ada@example.org is a superadmin
    assert admin.get("/api/auth/me").json()["user"]["superadmin"] is True
    r = admin.put("/api/admin/settings", json={"authenticatedPerMinute": 5})
    assert r.status_code == 200 and r.json()["rateLimit"]["authenticatedPerMinute"] == 5
    from fastapi.testclient import TestClient
    from catalog_api.app import app
    bob = TestClient(app)
    bob.get("/api/auth/dev-login", params={"login": "bob"}, follow_redirects=False)
    assert bob.get("/api/admin/settings").status_code == 403
    bob_id = bob.get("/api/auth/me").json()["user"]["id"]
    assert bob.get("/api/stats").headers["x-ratelimit-limit"] == "5"
    assert admin.put(f"/api/admin/users/{bob_id}/rate-limit", json={"perMinute": 7}).status_code == 200
    from catalog_api import accounts
    accounts._settings_cache["at"] = 0
    assert bob.get("/api/stats").headers["x-ratelimit-limit"] == "7"
    assert any(u["login"] == "bob" and u["rateLimit"] == 7 for u in admin.get("/api/admin/users").json())
    admin.put("/api/admin/settings", json={"authenticatedPerMinute": 1000})
    from catalog_api.guard import window
    window.counts.clear()
    accounts._settings_cache["at"] = 0
    actions = [a["action"] for a in admin.get("/api/audit", params={"action": "admin.*"}).json()]
    assert "admin.rate_limits" in actions and "admin.user_rate_limit" in actions


def test_admin_dashboard_and_review(client):
    admin = _signed_in()
    from fastapi.testclient import TestClient
    from catalog_api.app import app
    carol = TestClient(app)
    carol.get("/api/auth/dev-login", params={"login": "carol"}, follow_redirects=False)
    entry = {"id": "rev", "name": "Review Ontology", "description": "An ontology submitted to test the editorial review flow end to end.",
             "homepage": "https://example.org/rev", "category": "neuro", "kind": "ontology"}
    sid = carol.post("/api/submissions", json={"entry": entry}).json()["id"]
    assert carol.get("/api/admin/overview").status_code == 403
    o = admin.get("/api/admin/overview").json()
    assert o["stats"]["entries"] > 0 and o["health"]["database"]["ok"] and any(s["id"] == sid for s in o["queue"])
    queue = admin.get("/api/admin/submissions", params={"status": "pending", "q": "Review"}).json()
    assert queue[0]["name"] == "Review Ontology" and queue[0]["submittedBy"]["login"] == "carol"
    assert admin.post(f"/api/admin/submissions/{sid}/review", json={"decision": "rejected"}).status_code == 422  # note required
    r = admin.post(f"/api/admin/submissions/{sid}/review", json={"decision": "changes_requested", "notes": "Add a license."})
    assert r.status_code == 200 and r.json()["status"] == "changes_requested"
    mine = carol.get("/api/submissions").json()
    assert mine[0]["status"] == "changes_requested" and mine[0]["reviewNotes"] == "Add a license."
    csv = admin.get("/api/admin/catalog.csv")
    assert csv.status_code == 200 and csv.text.startswith("id,acronym,name")
    assert "submission.changes_requested" in [a["action"] for a in admin.get("/api/audit", params={"action": "submission.*"}).json()]


def test_recommend(client):
    o = client.get("/api/recommend/options").json()
    assert {a["id"] for a in o["areas"]} >= {"life", "earth"} and any(k["id"] == "schema" for k in o["kinds"])
    r = client.get("/api/recommend", params={"q": "gene function"}).json()
    assert r["items"][0]["id"] == "go" and any("gene" in w.lower() for w in r["items"][0]["why"])
    assert all(x["id"] != "envo" for x in r["items"])  # legacy resources are not recommended
    # Filters that leave nothing are relaxed, most specific first, and reported.
    r = client.get("/api/recommend", params={"q": "gene", "format": "SHACL"}).json()
    assert r["relaxed"] == ["format"] and r["items"][0]["id"] == "go"
    r = client.get("/api/recommend", params={"kind": "schema"}).json()
    assert [x["id"] for x in r["items"]] == ["sch"]


def test_recommend_chat_without_model(client):
    from catalog_api import chat, settings

    assert run(chat.parse("an actively maintained open schema in JSON Schema for life sciences")) == {
        "category": "life", "kind": "schema", "format": "JSON Schema", "maintained": True, "open_license": True}
    assert client.get("/api/recommend/chat/status").json()["available"] is False
    r = client.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "Which ontology for gene function?"}]})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in r.text.splitlines()]
    assert [e["type"] for e in events][:2] == ["filters", "results"] and events[-1] == {"type": "done", "model": None}
    assert events[1]["items"][0]["id"] == "go" and "GO" in "".join(e["text"] for e in events if e["type"] == "token")
    assert client.post("/api/recommend/chat", json={"messages": [{"role": "assistant", "content": "hi"}]}).status_code == 422
    # Chat turns have their own, tighter per-minute limit.
    from catalog_api.app import _chat_window
    _chat_window.counts.clear()
    codes = [client.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "gene"}]}).status_code for _ in range(settings.CHAT_RATE_ANON + 1)]
    assert codes[-1] == 429 and set(codes[:-1]) == {200}
    _chat_window.counts.clear()


def test_mcp_recommend_tool(client):
    from catalog_api import mcp_server

    r = run(mcp_server.recommend_resources("gene function"))
    assert r["items"][0]["id"] == "go" and r["items"][0]["url"].endswith("/o/go/")


def test_saved_chats(client):
    me = _signed_in()
    r = me.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "Which ontology for gene function?"}]})
    events = [json.loads(line) for line in r.text.splitlines()]
    assert events[0]["type"] == "chat" and events[0]["new"] is True
    cid = events[0]["id"]
    r = me.post("/api/recommend/chat", json={"chat_id": cid, "messages": [{"role": "user", "content": "Which ontology for gene function?"},
                                                                        {"role": "assistant", "content": "GO."}, {"role": "user", "content": "Only OWL ones"}]})
    assert json.loads(r.text.splitlines()[0]) == {"type": "chat", "id": cid, "new": False}
    lst = me.get("/api/chats").json()
    assert lst[0]["id"] == cid and lst[0]["title"] == "Which ontology for gene function?"
    c = me.get(f"/api/chats/{cid}").json()
    assert [m["role"] for m in c["messages"]] == ["user", "assistant", "user", "assistant"] and c["messages"][1]["data"]["items"][0]["id"] == "go"
    assert me.patch(f"/api/chats/{cid}", json={"title": "Genes"}).json()["title"] == "Genes"
    # Other people can't see it; signed out, nothing is saved.
    from fastapi.testclient import TestClient
    from catalog_api.app import app
    other = TestClient(app)
    other.get("/api/auth/dev-login", params={"login": "dave"}, follow_redirects=False)
    assert other.get(f"/api/chats/{cid}").status_code == 404 and other.delete(f"/api/chats/{cid}").status_code == 404
    from catalog_api.app import _chat_window
    _chat_window.counts.clear()
    anon = TestClient(app)
    first = json.loads(anon.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "gene"}]}).text.splitlines()[0])
    assert first["type"] == "filters"
    assert me.delete(f"/api/chats/{cid}").status_code == 204 and me.get("/api/chats").json() == []
    r = client.get("/api/recommend", params={"limit": 2, "page": 2}).json()
    assert r["page"] == 2 and r["pages"] == 2 and len(r["items"]) == 1


def test_every_endpoint_is_async(client):
    """All API routes are async and query the database with the async pool (nothing blocks the event loop)."""
    import inspect

    from fastapi.routing import APIRoute
    from catalog_api.app import api

    sync = [r.path for r in api.routes if isinstance(r, APIRoute) and not inspect.iscoroutinefunction(r.endpoint)]
    assert sync == []
    from catalog_api import mcp_server
    for name in ["search_catalog", "get_entry", "get_entry_history", "list_categories", "catalog_stats", "scoring_rubric", "recommend_resources"]:
        assert inspect.iscoroutinefunction(getattr(mcp_server, name))


def test_chat_log_feedback_and_opt_out(client):
    from catalog_api import db
    from catalog_api.app import _chat_window
    _chat_window.counts.clear()
    # Signed out: always logged, with no identity; the log id comes back for feedback.
    anon = client.post("/api/recommend/chat", json={"session": "s1", "messages": [{"role": "user", "content": "best rated ontology for gene function"}]})
    ev = [json.loads(line) for line in anon.text.splitlines()]
    log = next(e for e in ev if e["type"] == "log")["id"]
    assert client.post(f"/api/recommend/chat/feedback/{log}", json={"rating": -1, "comment": "Wanted GO first"}).status_code == 204
    assert client.post(f"/api/recommend/chat/feedback/{log}", json={}).status_code == 422
    assert client.post("/api/recommend/chat/feedback/nope", json={"rating": 1}).status_code == 404
    row = run(db.one("SELECT * FROM chat_logs WHERE id = %s", (log,)))
    assert row["session"] == "s1" and row["rating"] == -1 and row["result_ids"][0] == "go" and row["filters"].get("sort") == "score"
    assert "user_id" not in row and "ip" not in row
    # Signed in: logged by default; turning "improve search" off stops logging (the chat is still saved to the account).
    me = _signed_in()
    assert me.get("/api/auth/session").json()["user"]["improveSearch"] is True
    assert any(json.loads(l)["type"] == "log" for l in me.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "gene"}]}).text.splitlines())
    assert me.put("/api/auth/preferences", json={"improveSearch": False}).json() == {"improveSearch": False}
    types = [json.loads(l)["type"] for l in me.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "gene"}]}).text.splitlines()]
    assert "log" not in types and types[0] == "chat"
    me.put("/api/auth/preferences", json={"improveSearch": True})
    _chat_window.counts.clear()


def test_relevance_first(client):
    # Rare words outweigh common ones, and relevance comes before quality.
    r = client.get("/api/recommend", params={"q": "gene environments"}).json()
    assert r["items"][0]["relevance"] >= r["items"][-1]["relevance"]
    r = client.get("/api/recommend", params={"q": "ontology", "sort": "score"}).json()
    scores = [x["score"] or -1 for x in r["items"]]
    assert scores == sorted(scores, reverse=True)


def test_feedback_on_unlogged_answer(client):
    r = client.post("/api/recommend/chat/feedback", json={"question": "gene?", "answer": "GO", "resultIds": ["go"], "rating": 1})
    assert r.status_code == 201
    lid = r.json()["id"]
    assert client.post(f"/api/recommend/chat/feedback/{lid}", json={"comment": "great"}).status_code == 204
    me = _signed_in()
    from catalog_api.app import _chat_window
    _chat_window.counts.clear()
    ev = [json.loads(l) for l in me.post("/api/recommend/chat", json={"messages": [{"role": "user", "content": "gene"}]}).text.splitlines()]
    cid = ev[0]["id"]
    log = next(e["id"] for e in ev if e["type"] == "log")
    assert me.get(f"/api/chats/{cid}").json()["messages"][1]["data"]["logId"] == log


def test_search_logs_and_admin_exports(client):
    r = client.post("/api/logs/search", json={"source": "guided", "q": "gene", "filters": {"kind": "ontology"}, "resultCount": 2, "resultIds": ["go", "top"], "session": "s9"})
    lid = r.json()["id"]
    assert lid and client.post(f"/api/logs/search/{lid}/click", json={"entryId": "go"}).status_code == 204
    client.post("/api/logs/search", json={"source": "search", "q": "zzzz", "resultCount": 0})
    assert client.post("/api/logs/search", json={"source": "elsewhere"}).status_code == 422
    admin = _signed_in()
    assert client.get("/api/admin/logs/summary").status_code == 401
    s = admin.get("/api/admin/logs/summary").json()
    assert s["searches"]["guided"]["clicked"] >= 1 and any(x["q"] == "zzzz" for x in s["noResultQueries"])
    rows = admin.get("/api/admin/logs/searches", params={"source": "guided"}).json()
    assert rows[0]["clicked"] == ["go"] and rows[0]["filters"] == {"kind": "ontology"}
    csv = admin.get("/api/admin/logs/export/searches.csv")
    assert csv.status_code == 200 and csv.text.startswith("id,session,source,query")
    jl = admin.get("/api/admin/logs/export/chats.jsonl")
    assert jl.status_code == 200 and all(json.loads(l)["question"] for l in jl.text.splitlines())
    assert admin.get("/api/admin/logs/export/users.csv").status_code == 404
    # Opted out: not logged.
    admin.put("/api/auth/preferences", json={"improveSearch": False})
    assert admin.post("/api/logs/search", json={"source": "catalog", "q": "x"}).json() == {"id": None}
    admin.put("/api/auth/preferences", json={"improveSearch": True})
