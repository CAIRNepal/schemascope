# Decisions

SchemaScope began as a copy of NeuroSchema (neuroschema.org); see that repository's DECISIONS.md for D-001–D-015, which still apply: static build, FAIR + quality rubric, provenance and run archive, Git-based submissions, local evaluation.

## S-001: Cross-domain fork of NeuroSchema   (2026-10-25, status: accepted)
**Context** – The owner wants the same catalog and evaluation for every domain, not only neuroscience.
**Decision** – SchemaScope reuses the NeuroSchema code with its own brand: the SchemaScope logo, a navy/teal/blue/amber palette and its own domain list. Records have a primary domain plus secondary `domains`, which the landing page uses for a cross-domain map and "strongest bridges". The landing page shows only highlights, and the full catalog is paginated.
**Why** – One codebase, proven scoring, and less to maintain. Rejected: one site with a neuroscience filter, because NeuroSchema keeps its own curated depth and audience.

## S-002: Exhaustive coverage by harvesting registries   (2026-10-25, status: accepted)
**Context** – Hand-curation can't reach thousands of ontologies.
**Decision** – `scripts/harvest.py` harvests Bioregistry (semantic artefacts only), OBO Foundry, OLS, TIB, LOV and NeuroSchema, and merges records by prefix, cross-mappings, IRI, and same name on the same host. Domains come from the registries' own subject labels plus keyword rules. Each record keeps per-field provenance (registry, URL, time). `data/sources.json` and `data/sources/*.gz` archive every download, so `--offline` rebuilds are reproducible. Curated values in `data/curated.json` win over registry values.
**Why** – Registries are maintained by their communities, and combining them gives breadth plus cross-checks. Rejected: scraping web pages, which is fragile, and copying a single registry, which leaves gaps (e.g. LOV covers semantic-web vocabularies that biomedical registries don't).
**Consequences** – BioPortal, AgroPortal, MatPortal, IndustryPortal and other OntoPortal instances need API keys and will be added as sources once keys are configured. FAIRsharing needs a login.

## S-003: Discovery by dereferencing   (2026-10-25, status: accepted)
**Context** – Many ontologies (privacy, security, CS, manufacturing, project ontologies such as smashHitCore) are in no registry.
**Decision** – `scripts/discover.py` takes candidates from prefix.cc, w3id.org, Zenodo, GitHub topics (with a token) and `data/candidates.txt` (e.g. from papers, with the DOI). It requests RDF and accepts only artefacts that declare an ontology or vocabulary with a title and ≥ 5 terms. Metadata is read from the artefact itself, ignoring titles that merged-in W3C vocabularies leave behind. Probe results are cached for 30 days.
**Why** – Content negotiation tells us objectively whether something is a published ontology. Rejected: listing every namespace without checking it, which would be noisy and full of dead links.

## S-004: Privacy, Security & Law domain   (2026-10-25, status: accepted)
**Decision** – A dedicated domain for data protection, GDPR, consent, contracts, cybersecurity and legal ontologies. It is fed by LOV's Security and Contracts tags and keyword rules.

## S-005: Submissions are saved as curated entries   (2026-10-26, status: accepted)
**Context** – The submission bot (`scripts/issue-to-entry.mjs`) wrote only to `data/catalog.json`, which `scripts/harvest.py` rebuilds from the registries plus `data/curated.json`. The next harvest would have dropped every submitted entry. The bot also wrote the catalog with 2-space indentation while the harvest uses 1, so each submission PR reformatted all ~2,700 entries. And, as in NeuroSchema, the workflow only ran for issues carrying a `submission` label that didn't exist in the repo.
**Decision** – The bot writes the entry to both files. A new entry gets `provenance.source: "curated"` with `curatedAt` and `curatedBy: "submission #N"`. A correction records the submitted fields under `provenance.overrides`, which the harvest applies on top of registry values. Submitter-supplied `provenance` is ignored. Both files keep the harvest's formatting. The workflow passes `ISSUE_NUMBER`, commits `data/curated.json` too, and runs on the form's JSON field as well as the label, creating the label when missing.
**Why** – `curated.json` is already the place harvest-proof values live. Rejected: making the harvest keep every non-harvest catalog entry, which would also keep entries a registry has removed or renamed.
**Consequences** – Entries submitted before this change that aren't in `curated.json` must be copied there by hand before the next harvest.

## S-006: Check DOIs against several registries, and keep the optional score preview optional   (2026-10-27, status: accepted)
**Context** – `scripts/validate.mjs --online` checked DOIs in Crossref only, with no timeout, and treated any failed request as "not found". On a PR, a valid DOI (10.1038/s41597-024-03559-8) failed because Crossref didn't answer the CI runner. In `.github/workflows/ci.yml` the "FAIR evaluation preview" step ran with `if: always()`, so it kept running after the checks had failed or the run was cancelled.
**Decision** – Look each DOI up in Crossref, DataCite, OpenAlex, Semantic Scholar and the doi.org handle API at once, with timeouts and one retry. Found in any of them: pass, and match the title against the closest one. Fail only when doi.org, or every source, says 404. If they're unreachable, warn and show ⚠️ in the report. OLS lookups and the download sniff also get timeouts. In CI, the preview runs only after the checks pass, can't fail the job, and has a 15-minute limit. The online checks get 10 minutes and the job 30. A new push cancels the older run.
**Why** – One registry having an outage or rate-limiting CI shouldn't block a correct submission. Rejected: retrying Crossref only, since it's still a single point of failure and misses DataCite DOIs (Zenodo, figshare).
**Consequences** – PR checks no longer fail on a DOI they couldn't reach. Those cases show as warnings for the reviewer to check. PRs whose checks fail no longer get a score preview.
