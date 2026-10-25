# SchemaScope — schemascope.org

A curated catalog of ontologies, schemas, vocabularies and data standards. Every entry is evaluated automatically against the FAIR principles, maintenance and community adoption, with a progressive inactivity penalty. Each run records the exact version evaluated and keeps full provenance. The site is fully static, with no runtime dependencies.

## Quick start

```bash
npm run dev               # build + preview at http://localhost:4321 (PORT=3200 npm run dev for another port)
npm run build             # build into dist/ (also validates the catalog)
npm run validate          # structural checks: fields, ids, URLs, DOIs format, duplicates
npm run validate:online   # + links resolve, DOIs exist in Crossref, OLS ids are real
npm run evaluate          # run the evaluation → data/evaluation.json + data/runs/<run>.json
docker build -t schemascope/oops docker/oops     # OOPS! pitfall scanner, built from source
OOPS_IMAGE=schemascope/oops ROBOT_JAR=robot.jar node scripts/quality.mjs   # quality checks; CI runs this weekly
python3 scripts/pitfalls.py scan ontology.owl   # Python pitfall scan (fallback when OOPS! can't run)
npm run rescore           # recompute scores from stored facts after a rubric change (no network)
```

Requires Node ≥ 18. There's nothing to `npm install`. Set `GITHUB_TOKEN` locally to avoid GitHub's 60 requests/hour limit when running `npm run evaluate`.

## How scoring works (rubric v3, deliberately strict)

`Score = max(0, 100 · (F + A + I + R + Q + M + U) / possible − P)`. Here `possible` is 100 for ontologies and 80 for everything else, because Q only applies to ontologies.

| | Criterion | Max | Measures |
|---|---|---|---|
| F | Findable | 12 | PID, number of portals/registries indexing it, citable reference |
| A | Accessible | 12 | homepage, artefact over HTTP(S), metadata persists in a registry |
| I | Interoperable | 12 | formal format, semantic-web IRIs, imports other vocabularies |
| R | Reusable | 12 | open license, version declared *inside* the artefact, OBO principles pass rate |
| Q | Ontology consistency & quality | 20 | **logical consistency (10)**, OWL 2 DL, BFO/COB + RO, ROBOT report, critical pitfalls |
| M | Maintenance | 16 | recency + releases in the last 12 months |
| U | Adoption | 16 | adopting projects, reuse by other ontologies, stars/citations |
| P | Penalties | −50 | inactivity (−4/year after 1 year, max −20; −10 if archived/legacy/OBO-inactive), inconsistent −20 (score capped at 54), unsatisfiable classes −5, critical pitfalls −3 each (max −12), ROBOT errors up to −10 |

Grades: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, E < 40. The rules live in [`scripts/rubric.mjs`](scripts/rubric.mjs).

**Data sources:**
- link checks
- the artefact itself (version IRI)
- git refs (commit, tags)
- GitHub
- OLS v2 (classes, properties, individuals, imports/exports, IRIs, languages)
- TIB Terminology Service
- BioPortal (with an API key)
- Bioregistry (cross-portal IDs, dependencies, reuse)
- OBO Foundry registry and OBO Dashboard (principle checks, ROBOT report, consistency, reuse)
- Crossref
- `scripts/quality.mjs` in CI: ROBOT ELK reasoning and report for ontologies outside the OBO Dashboard, plus the OOPS! pitfall scanner

**Versions and provenance.** Each run records the exact version evaluated: the version IRI/info in the artefact, or else the OLS version, release tag or commit. Every fact stores its source URL and retrieval time. Runs are archived, unchanged, in `data/runs/`, which feeds the per-entry history. Failed lookups carry forward the last good value, flagged.

> **Generated data has a single writer.** `data/evaluation.json`, `data/runs/` and `data/quality/` are written only by the **Evaluate catalog** Action, so they never conflict. Local `npm run evaluate` / `rescore` / quality runs go to `.local/data/` (git-ignored), and `npm run dev` previews them. Run `npm run setup` once per clone: it enables a pre-commit hook that blocks committing generated data, and makes `git pull` rebase. To publish new scores, push code or catalog changes (the Action runs automatically) or start the Action manually.

## Layout

| Path | What |
|---|---|
| `data/catalog.json` | The curated catalog (edit via PR or the submission flow) |
| `data/catalog.schema.json` | JSON Schema for entries |
| `data/categories.json` | Domains |
| `data/evaluation.json` | Latest evaluation (generated) |
| `data/runs/*.json` | Archived run snapshots (generated, append-only) |
| `scripts/` | build, validate, evaluate, rubric, issue → entry, PR report |
| `src/assets/` | CSS, JS, logos, favicons, social image |
| `.github/` | issue form, PR template, workflows |

## Contributions (all through Git)

1. A contributor fills in **schemascope.org/submit**, which opens a pre-filled GitHub issue. They can also open the issue form directly, or send a pull request editing `data/catalog.json`.
2. **Submission to pull request** (`.github/workflows/submission.yml`) converts the issue into a pull request. It fills paper titles from Crossref and comments on the issue with the PR link, or with what needs fixing.
3. **Checks** (`.github/workflows/ci.yml`) runs on every PR. It validates the catalog and runs online checks for the changed entries: links, DOIs and OLS IDs. It runs a FAIR evaluation preview, then posts a summary as a PR comment and in the job summary.
4. A maintainer reviews and merges. **Evaluate catalog** runs on merge and every Monday. It commits `data/evaluation.json` plus a new `data/runs/` snapshot, and Vercel redeploys.

### Repository setup

- **Secrets:** add `BOT_TOKEN`, a fine-grained personal access token for this repo with *Contents*, *Pull requests* and *Issues* set to read & write. PRs opened by the bot then trigger the Checks workflow; with only the built-in token, GitHub doesn't run workflows on bot-created PRs. The token also raises the GitHub API limit for evaluations. `BIOPORTAL_API_KEY` is optional.
- **Labels:** create a `submission` label (the issue form applies it).
- **Branch protection on `main`:** require pull requests, and require the "Checks / validate-and-build" status to pass before merging.
- **Actions → General:** allow GitHub Actions to create pull requests.
- Set `"repository"` in `site.config.json` to the GitHub URL so the site links to the issue form.

## Deploy on Vercel

Import the repository. `vercel.json` already sets the build command and output directory. Then add `schemascope.org` under **Settings → Domains**: an `A` record to `76.76.21.21` for the apex domain, and a `CNAME` record to `cname.vercel-dns.com` for `www`.

## SEO

Every page has a canonical URL, Open Graph/Twitter cards and a JSON-LD `@graph`. The graph includes Organization, WebSite with SearchAction, BreadcrumbList, and, depending on the page, Dataset/DefinedTermSet, DataCatalog, ItemList or CollectionPage. The site also publishes `sitemap.xml`, `robots.txt`, a web manifest, `catalog.jsonld` (W3C DCAT), and per-entry PROV-O provenance in `/o/<id>/entry.json`.
