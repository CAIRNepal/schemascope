# SchemaScope — schemascope.org

A cross-domain catalog of ontologies, vocabularies, schemas and data standards. It is harvested from the major registries, extended by discovering ontologies that no registry lists, and evaluated automatically for FAIRness, ontology quality, maintenance and adoption. Every record keeps its provenance. The site is fully static.

## Quick start

```bash
pip install -r requirements.txt     # rdflib, for harvesting, discovery and pitfall scans
npm run harvest                     # registries → data/catalog.json (+ data/sources.json)
npm run discover                    # dereference prefix.cc, w3id.org, Zenodo, GitHub, data/candidates.txt
npm run refresh                     # quality checks + evaluation + build + commit (add -- --push to publish)
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

## Domains

There are 15 domains, from foundational ontologies to privacy & law (see `data/categories.json`). Each record has a primary domain and optional secondary domains, which drive the cross-domain map on the home page. Domains come from OBO Foundry domains, LOV tags, TIB classifications and keyword rules.

## Scoring

`Score = max(0, 100 · (F + A + I + R + Q + M + U) / possible − P)`. FAIR is 4 × 12 points. Q (ontology consistency & quality, 20) applies to ontologies only; for other resources `possible` is 80 and the result is scaled. M is maintenance (16), U is adoption (16), and P is penalties for inactivity, inconsistency, critical pitfalls and ROBOT errors. The rules are in `scripts/rubric.mjs`, and the site's `/evaluation/` page shows the formula and a worked example.

## Contributing

Use the site's `/submit/` form, which opens a GitHub issue that a bot turns into a pull request. You can also add a URL to `data/candidates.txt`, or edit `data/curated.json`, and open a pull request. CI validates every PR and posts a scoring preview. Evaluation results are produced only by the maintainer's local `npm run refresh`, so they never conflict.

## Deploy

Vercel builds the site with `node scripts/build.mjs` into `dist/` (see `vercel.json`). Set the Application Preset to **Other** and leave the install command empty.

## License

The SchemaScope code and site are licensed under the [Apache License 2.0](LICENSE). Catalogued ontologies and schemas belong to their maintainers and keep their own licences, which are shown on each record. Registry data keeps the licence recorded in `data/sources.json`.
