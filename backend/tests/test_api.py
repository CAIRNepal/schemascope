"""Smoke tests against a database built from a small fixture repository."""
from __future__ import annotations

import importlib
import json
import sys

import pytest

CATEGORIES = [
    {"id": "life", "name": "Life Sciences", "icon": "dna", "blurb": "Genes and cells."},
    {"id": "earth", "name": "Earth Science", "icon": "globe", "blurb": "Planet."},
]
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
def client(tmp_path_factory):
    repo = tmp_path_factory.mktemp("repo")
    data = repo / "data"
    (data / "runs").mkdir(parents=True)
    (repo / "site.config.json").write_text(json.dumps({"name": "TestScope", "url": "https://example.org"}))
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
    mp.setenv("CATALOG_DB", str(repo / "test.db"))
    mp.setenv("MCP_ALLOWED_HOSTS", "testserver")
    for m in [m for m in sys.modules if m.startswith("catalog_api")]:
        del sys.modules[m]
    ingest = importlib.import_module("catalog_api.ingest")
    ingest.ingest(rebuild=True)
    from fastapi.testclient import TestClient

    app = importlib.import_module("catalog_api.app").app
    with TestClient(app) as c:
        yield c
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

    assert mcp_server.search_catalog(query="environment")["items"][0]["url"] == "https://example.org/o/envo/"
    assert mcp_server.get_entry("go")["evaluation"]["score"] == 80
    assert len(mcp_server.get_entry_history("go")["runs"]) == 2
    assert "error" in mcp_server.get_entry("nope")


def test_mcp_endpoint_lists_tools(client):
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
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
