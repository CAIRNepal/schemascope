# Decisions

## D-001: Static site generated from a curated catalog   (2026-10-25, status: accepted)
**Context** – New project for the schemascope.org domain: a single place to find neuroscience ontologies, schemas and data standards. The folder was empty. The site will be hosted on Vercel.
**Decision** – A zero-dependency Node build (`scripts/build.mjs`) turns `data/catalog.json` + `data/categories.json` into plain HTML in `dist/`. Every entry gets its own page (`/o/<id>/`), every category its own page (`/category/<id>/`), and the whole catalog is also published as `catalog.json` and DCAT JSON-LD (`catalog.jsonld`).
**Why** – Static output deploys anywhere (Vercel here), is fast, and has no server to maintain. No framework or npm dependencies means nothing to upgrade and the build runs on any Node ≥ 18. Rejected: Next.js/Astro (heavier, no need for client routing), a database-backed app (overkill for a ~50-entry catalog that changes by PR).
**Consequences** – Adding an entry is a JSON edit + PR. Client-side search/filter is plain JS over an embedded JSON index.

## D-002: Catalog links to canonical sources rather than mirroring files   (2026-10-25, status: accepted)
**Context** – "Hosting" third-party ontologies could mean copying their OWL/YAML files onto schemascope.org.
**Decision** – Each entry links to its canonical homepage, repository, download/PURL and browsers (OLS, BioPortal). Files are not mirrored.
**Why** – Mirrors go stale, can break licenses/attribution, and compete with the PURLs communities already cite. Rejected: periodic mirroring.
**Consequences** – If schemascope.org later publishes its *own* schemas, add them as entries with `hosted: true` and put files under `public/`; the build copies `public/` into `dist/` as-is.

## D-003: Automated evaluation stored as committed data   (2026-10-25, status: accepted)
**Context** – Users asked for automated evaluation, community adoption and sources per entry.
**Decision** – `scripts/evaluate.mjs` checks each entry (link health, GitHub activity/stars/license/releases, OLS term counts and versions, OBO Foundry status and registered usages) and writes `data/evaluation.json`. The build reads that file and shows a 0–100 score with a transparent breakdown. A scheduled GitHub Action re-runs it weekly and commits the result, which triggers a Vercel redeploy.
**Why** – Running network checks during every Vercel build would be slow, flaky and rate-limited (GitHub allows 60 unauthenticated requests/hour). Committed results are reproducible and diffable. Rejected: client-side live checks (CORS, rate limits, slow pages).
**Consequences** – Scores are as fresh as the last evaluation run (date shown on every page). Adoption = curated `usedBy` in the catalog + usages pulled from the OBO Foundry registry, each labelled with its source.

## D-004: Vercel hosting, GitHub Actions for CI and scheduled evaluation   (2026-10-25, status: accepted)
**Context** – The site is hosted on Vercel. Evaluation results must stay fresh without manual work (D-003).
**Decision** – `vercel.json` builds with `node scripts/build.mjs` into `dist/` (no install step, trailing-slash URLs, CORS on the JSON exports). `.github/workflows/ci.yml` builds and validates on every push/PR and evaluates the entries a PR changed. `.github/workflows/evaluate.yml` runs weekly, commits `data/evaluation.json`, and Vercel redeploys on that push.
**Why** – Vercel's Git integration already deploys every push, so GitHub Actions only has to keep data fresh and catch broken catalog edits. Rejected: Vercel cron functions (would need a server-side runtime for a static site).
**Consequences** – The evaluator keeps the previous value when a lookup fails (rate limit or outage), so a transient failure never lowers a score. The weekly job uses the built-in `GITHUB_TOKEN`, which avoids the 60 requests/hour unauthenticated limit.

## D-005: Visual design   (2026-10-25, status: accepted)
**Context** – The site should feel premium and credible to researchers.
**Decision** – Instrument Serif for display headings, Inter for body text and JetBrains Mono for code (Google Fonts). A dark hero with a deterministic, build-time SVG neural-network illustration (animated pulses that respect `prefers-reduced-motion`). Teal accent, A–D grade colours, light/dark themes with a toggle.
**Why** – A serif display face with a restrained palette reads as editorial and scientific rather than generic SaaS. The SVG is generated at build time, so there's no image asset or JS animation library.
**Consequences** – The only external request is to Google Fonts. Remove that `<link>` in `scripts/build.mjs` to fall back to system fonts.

## D-006: Brand — SchemaScope navy & gold   (2026-10-25, status: accepted; supersedes the teal palette in D-005)
**Context** – The owner supplied the SchemaScope emblem (navy network mark, gold nodes, serif wordmark) and asked to move away from green.
**Decision** – Logo assets are cut from the supplied PNG into transparent light/dark variants (`src/assets/brand/`), favicons, an apple-touch icon and a 1200×630 social image. The palette is navy `#13264f` / gold `#b8924f` on ivory, and the hero uses gold/ivory nodes on navy. Grades keep distinct semantic colours.
**Why** – It matches the logo and the existing serif display type. Rejected: keeping the teal accent, which clashed with the logo.
**Consequences** – The header shows two `<img>`s and CSS picks one per theme, so the manual dark toggle switches the logo too.

## D-007: FAIR-based rubric with progressive inactivity penalty   (2026-10-25, status: accepted; rubric v2.2)
**Context** – v1 scored accessibility, maintenance, license, interoperability and adoption. The owner asked to ground the scores in FAIR and to penalise inactive resources progressively.
**Decision** – `Score = max(0, F + A + I + R + M + U − P)`. FAIR is 4 × 15 points (F1/F4/F2, A1, I1/I2, R1.1/R1.2), M and U are 20 each, and P = min(30, min(20, 4·max(0, years − 1)) + 10·[archived/legacy/OBO-inactive]), or 5 if there's no activity evidence. Each criterion records its steps, so pages can show the working.
**Why** – FAIR is the vocabulary this community already uses. A flat cap on maintenance didn't distinguish "slightly stale" from "abandoned". Rejected: automated FAIR tools such as F-UJI or FOOPS!, which are heavier, need a running service, and mostly target datasets or single ontologies.
**Consequences** – `npm run rescore` re-derives scores from stored facts when weights change. Rubric changes show up as "rubric vX → vY" in entry change logs.

## D-008: Version tracking and run archive (provenance)   (2026-10-25, status: accepted; extends D-003)
**Context** – The owner asked that each evaluation record which version was evaluated, keep old results, and expose provenance.
**Decision** – The evaluator reads the start of each artefact for `owl:versionIRI`/`versionInfo`/`data-version`. It reads the default-branch commit and release tags from git's smart-HTTP endpoint, which uses no API quota. Every fact gets `source` and `fetchedAt`. Each run is written to `data/runs/<id>.json` and never rewritten. The build derives per-entry history, change logs and sparklines from these runs, and publishes them under `/runs/`. Entry JSON includes W3C PROV-O.
**Why** – Scores are only meaningful against a specific version. Append-only snapshots in git give a free, auditable history. Rejected: a database, which is unnecessary when git already versions the files.
**Consequences** – The repo grows by ~60 KB per run (~3 MB/year at weekly cadence). Failed lookups carry forward the last good value, with its original timestamp and a "carried forward" flag.

## D-009: Contributions only through Git with automated pre-merge checks   (2026-10-25, status: accepted)
**Context** – The owner wants users to submit resources, with everything tracked and checked before merge.
**Decision** – The `/submit/` form produces an entry and opens a pre-filled GitHub issue form. `submission.yml` converts the issue into a PR using `scripts/issue-to-entry.mjs`. `ci.yml` validates (offline and online), runs a FAIR evaluation preview, and comments on the PR. `evaluate.yml` re-evaluates on merge. Validation rules live in one place (`scripts/validate-lib.mjs`), mirrored by `data/catalog.schema.json`.
**Why** – Git gives review, history and attribution for free, and the static site needs no backend. Rejected: a form backend or database, which would need hosting, spam handling and a separate audit trail.
**Consequences** – Needs a `BOT_TOKEN` secret so bot PRs trigger checks, a `submission` label, and branch protection requiring the Checks status. PRs from forks get results in the job summary, because forks can't receive comments with the default token.

## D-010: Cross-portal data (OLS v2, TIB, BioPortal, Bioregistry, OBO Dashboard)   (2026-10-25, status: accepted)
**Context** – OLS shows much more than we captured (imports/exports, classes/properties/individuals, IRIs, languages). Other portals hold their own copies, sometimes different releases.
**Decision** – The evaluator uses the OLS v2 API, falling back to v1. It also queries the TIB Terminology Service (same software), Bioregistry and the OBO Dashboard. Bioregistry runs first, because its mappings give each resource's ID in the other portals; BioPortal is queried when `BIOPORTAL_API_KEY` is set. Entry pages show a Portals & registries panel. It has a per-portal version and count table, imports and reused-by links (internal where we catalog the ontology), dashboard quality results, and IDs in 10+ portals.
**Why** – No key or quota is needed except for BioPortal. Rejected: AberOWL (API redirects, so it's linked only via Bioregistry) and FAIRsharing (needs a login), which are linked only.
**Consequences** – Schemas without a Bioregistry prefix get fewer registry points. An optional `bioregistry` field in the catalog sets the prefix explicitly.

## D-011: Rubric v3 — strict, with ontology quality   (2026-10-25, status: accepted; supersedes D-007 weights)
**Context** – The owner wants a strict rubric where 100 is barely reachable, and that checks upper-ontology alignment, consistency and OOPS! results.
**Decision** – F/A/I/R are 12 points each. They add sub-criteria: number of registries (F4), metadata persistence (A2), imports (I3), version declared in the artefact (R1.2) and OBO principles pass rate (R1.3). Q (20) covers BFO/COB and RO imports, reasoner consistency, ROBOT report and OOPS! pitfalls. M (16) is recency plus release cadence, and U (16) is adopters, reuse and stars/citations. P is unchanged (progressive). Non-ontologies are scaled from 80 to 100, and grades now run A–E.
**Why** – Consistency evidence comes from the OBO Dashboard for OBO ontologies, and from our own ROBOT + ELK run in CI for the rest. OOPS! is unreachable from some networks and rate-limited, so when it's unavailable its 4 points are excluded and Q is rescaled rather than penalised. Unchecked consistency scores 0, so ontologies are rewarded for being checkable. Rejected: running HermiT (too slow on large ontologies) and FOOPS! (same availability problem as OOPS!).
**Consequences** – After this change the best score is 99 (CL). Non-OBO ontologies get Q = 0 for consistency/ROBOT until the first CI quality run writes `data/quality/<id>.json`.

## D-012: Landing shows highlights; dedicated catalog and search pages   (2026-10-25, status: accepted)
**Context** – The home page listed every resource, and search only filtered that list.
**Decision** – The home page shows the hero, domains, the top 6 by score and the 6 most recently updated. `/catalog/` holds the full filterable list, and `/search/?q=` is a ranked results page over `search-index.json`. Ranking weights matches by field: acronym > name > tags > modules > description. The schema.org SearchAction points to `/search/`.
**Consequences** – Links to `/#explore` were replaced by `/catalog/`.

## D-013: Consistency-centred quality, penalties for critical problems, local OOPS! + Python fallback   (2026-10-25, status: accepted; rubric v3.2)
**Context** – The public OOPS! service is often unreachable. The owner asked that logical consistency carry more weight, that critical problems count against a resource, and that processing not rely on one runtime or one external service.
**Decision** –
- Q is now "Ontology consistency & quality". Logical consistency is worth 10 of its 20 points; the rest is OWL 2 DL 2, BFO/COB 3, RO 1, ROBOT report 3 and a critical-pitfall check 1. Nothing is rescaled when a scanner is unavailable.
- Penalties (cap 50):
  - inconsistent −20, with the score capped at 54
  - unsatisfiable classes −5
  - critical pitfall types −3 each (max −12)
  - ROBOT errors −3/−6/−10
- Pitfall scanning runs in this order:
  1. the OOPS! CLI built from source at a pinned commit in `docker/oops`, run locally
  2. the public OOPS! service
  3. `scripts/pitfalls.py`, an rdflib scan of 11 structural OOPS! pitfalls with the same codes and severities: P06, P19, P39, P38, P41, P34, P35, P11, P10, P08, P13
- The same Python script converts OOPS! Turtle reports into JSON.
- `quality.mjs` records which engine produced each result and every failed attempt.

**Why** – Consistency is the property a reasoner can check objectively and that downstream users depend on most. A local OOPS! removes the external dependency. Python/rdflib keeps a pitfall check alive even without Docker or Java. Rejected: rescaling when a scan is unavailable, which hid problems.

**Consequences** – CI builds the OOPS! image (cached with buildx) and installs `requirements.txt`. OOPS! loads an ontology's imports, so very large ontologies may time out and fall back to the Python scan.

## D-014: The Evaluate Action is the only writer of evaluation results   (2026-10-25, status: accepted; supersedes the rebase-only mitigation)
**Context** – `data/evaluation.json` and `data/quality/*` conflicted twice. Both local runs and the scheduled Action wrote them, and each run rewrites the whole file, so git can never merge two versions.
**Decision** – Only the "Evaluate catalog" Action writes `data/evaluation.json`, `data/runs/` and `data/quality/` (signalled by `GITHUB_ACTIONS` / `SCHEMASCOPE_CI`; see `scripts/paths.mjs`). Local `evaluate`, `quality` and `rescore` write to `.local/data/` (git-ignored), and the build previews them when newer. Three guards enforce this: `.githooks/pre-commit` (enabled by `npm run setup` / `npm run dev`) blocks local commits of generated data; the Checks workflow fails PRs that change it; and the Action rebases before pushing, retrying on conflict. The Action also runs when evaluation code changes.
**Why** – With a single writer there is never a second version to conflict with. Rejected: a custom git merge driver, which needs per-clone config and would silently pick a side, and moving data to a separate branch, which would make the Vercel build fetch over the network.
**Consequences** – To change the published scores, push code or catalog changes and let the Action run, or start it manually. Merges that bring in the Action's commits are always allowed by the hook.
