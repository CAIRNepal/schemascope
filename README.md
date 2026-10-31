# SchemaScope — schemascope.org

A cross-domain catalog of ontologies, vocabularies, schemas and data standards. It is harvested from the major registries, extended by discovering ontologies that no registry lists, and evaluated automatically for FAIRness, ontology quality, maintenance and adoption. Every record keeps its provenance. The site is served by a FastAPI backend (JSON API + MCP server) and a server-rendered Next.js UI; the evaluation pipeline is Node.

<img width="1508" height="833" alt="Screenshot 2026-10-26 at 4 42 34 PM" src="https://github.com/user-attachments/assets/70ef4c4d-9f32-4343-b466-d4998de99caf" />


## Quick start

```bash
pip install -r requirements.txt     # rdflib, for harvesting, discovery and pitfall scans
npm run harvest                     # registries → data/catalog.json (+ data/sources.json)
npm run discover                    # dereference prefix.cc, w3id.org, Zenodo, GitHub, data/candidates.txt
npm run refresh                     # quality checks + evaluation + build + commit (add -- --push to publish)
npm run quality:all                 # ROBOT, pitfalls and imports for every ontology; resumable (QUALITY_JOBS=2 for two at a time)
npm run rescore                     # recompute scores from stored facts after a rubric change (no network)
npm run validate:rubric             # weight sensitivity, OBO Dashboard agreement, expert ratings → data/validation/report.json
npm run serve                       # preview at http://localhost:3300
```

Requirements: Node ≥ 18, Python 3 with rdflib, and Docker. Docker runs OOPS! and ROBOT locally, so Java isn't needed. Set `GITHUB_TOKEN` (or log in with `gh`) before evaluating; it raises GitHub's API limit and enables the GitHub discovery channel.

## Where the catalog comes from

| Source | What is taken | How |
|---|---|---|
| Bioregistry | semantic-artefact prefixes, metadata, cross-registry mappings | `registry.json` export |
| OBO Foundry | ontologies, domains, status, licences | registry JSON-LD |
| OLS (EMBL-EBI), TIB Terminology Service | every loaded ontology, counts, imports | OLS v2 API |
| LOV | ~900 semantic-web vocabularies, tags, reuse counts, version files | full RDF dump |
| NeuroSchema | curated neuroscience entries | `neuroschema.org/catalog.json` |
| Discovery | ontologies no registry lists | `scripts/discover.py` dereferences every prefix.cc and w3id.org namespace, Zenodo ontology files, GitHub ontology repositories and `data/candidates.txt` (e.g. ontologies found in papers). A candidate is accepted only if its artefact declares an ontology with a title and ≥ 5 terms. |

Records are merged across sources by prefix, cross-registry mappings, ontology or namespace IRI, and normalised name on the same host. Curated entries and overrides in `data/curated.json` take precedence over registry values.

**Provenance.**
- **Per field:** each catalog record lists every registry that supplied it, with URL and retrieval time, and which registry supplied each field.
- **Per download:** `data/sources.json` records each registry download (URL, SHA-256, size, licence), and `data/sources/*.gz` archives the raw files, so `python3 scripts/harvest.py --offline` reproduces the catalog exactly.
- **Per evaluation:** each evaluation run is archived in `data/runs/`.

## API, MCP and UI

```
data/*.json ──ingest──▶ SQLite (.local/catalog.db) ──▶ FastAPI  /api/…  (JSON, OpenAPI at /docs)
 (evaluate,                                              │       /mcp/   (MCP, streamable HTTP)
  rescore, quality)                                      └──▶ Next.js UI (web/, server-rendered)
```

```bash
npm run ingest        # load data/ into .local/catalog.db (incremental; --rebuild to start over). refresh.sh runs it too
npm run api           # API + MCP on http://127.0.0.1:8000  (needs uv: https://docs.astral.sh/uv/)
npm run web           # UI on http://localhost:3000, reading the API
npm run test:api      # backend tests
cd web && npm run check-links -- http://localhost:3000 http://127.0.0.1:8000   # crawl the running site for broken links
```

- **API** (`backend/catalog_api/`): `/api/entries` (search with `q`, filters `category`, `kind`, `grade`, `format`, `registry`, `legacy`, `sort`, pagination and facet counts), `/api/entries/{id}`, `/api/entries/{id}/history`, `/api/categories`, `/api/runs`, `/api/runs/{id}`, `/api/stats`, `/api/meta`.
- **MCP** at `/mcp/`: tools `search_catalog`, `get_entry`, `get_entry_history`, `list_categories`, `catalog_stats`, `scoring_rubric`. Add it to Claude Code with `claude mcp add --transport http schemascope http://127.0.0.1:8000/mcp/`, or run it over stdio with `npm run mcp:stdio`.
- **UI** (`web/`): Next.js App Router. Stylesheet and brand images come from `src/assets/` (copied on build). Pages not ported yet are proxied to the static build when `LEGACY_SITE_URL` is set.

Environment: `CATALOG_REPO` (repository root; default: parent of `backend/`), `CATALOG_DB`, `CORS_ORIGINS`, `MCP_ALLOWED_HOSTS` (public host name(s) of the API, e.g. `api.schemascope.org`; localhost always works) for the API; `API_URL` (server-side), `NEXT_PUBLIC_API_URL` (links shown to readers), `REVALIDATE_SECONDS`, `LEGACY_SITE_URL` for the UI. The UI build pre-renders some pages, so the API must be reachable during `next build`.

## Domains

There are 15 domains, from foundational ontologies to privacy & law (see `data/categories.json`). Each record has a primary domain and optional secondary domains, which drive the cross-domain map on the home page. Domains come from OBO Foundry domains, LOV tags, TIB classifications and keyword rules.

## Scoring

`Score = max(0, 100 · (F + A + I + R + Q + M + U) / possible − P)`. FAIR is 4 × 12 points. Q (ontology consistency & quality, 20) applies to ontologies only; for other resources `possible` is 80 and the result is scaled. Q checks SchemaScope couldn't run are left out of `possible` too (rubric v4, "not assessed"), and such grades are marked with *. M is maintenance (16), U is adoption (16), and P is penalties for inactivity, inconsistency and critical pitfalls. The rules are in `scripts/rubric.mjs`, and the site's `/evaluation/` page shows the formula and a worked example.

## Contributing

Use the site's `/submit/` form, which opens a GitHub issue that a bot turns into a pull request. You can also add a URL to `data/candidates.txt`, or edit `data/curated.json`, and open a pull request. CI validates every PR and posts a scoring preview. Evaluation results are produced only by the maintainer's local `npm run refresh`, so they never conflict.

## Deploy

Two processes: the API (`uvicorn catalog_api.app:app`, Python ≥ 3.11, with `.local/catalog.db` built by `npm run ingest`) and the UI (`cd web && npm run build && npm start`, with `API_URL` pointing at the API). The static build (`node scripts/build.mjs` → `dist/`, `vercel.json`) still works and serves the pages that are not ported yet; see S-014 in DECISIONS.md.

## License

The SchemaScope code and site are licensed under the [Apache License 2.0](LICENSE). Catalogued ontologies and schemas belong to their maintainers and keep their own licences, which are shown on each record. Registry data keeps the licence recorded in `data/sources.json`.
