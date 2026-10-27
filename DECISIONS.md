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

## S-007: NeuroSchema's values win in the harvest   (2026-10-27, status: accepted)
**Context** – `scripts/harvest.py` kept the first value it found for each field, and NeuroSchema is read last. So edits made in NeuroSchema (descriptions, links, publications) didn't reach entries also listed in Bioregistry, OBO, OLS, TIB or LOV. Six entries (`bids`, `nwb`, `hed`, `openminds`, `neuroml`, `dandi-schema`) were also frozen as "NeuroSchema catalog" snapshots in `data/curated.json`, which override every harvest.
**Decision** – NeuroSchema's values replace other registries' values for any field it gives. When NeuroSchema is harvested for an entry, the snapshot in `curated.json` keeps only its SchemaScope domain (category, domains). Entries curated in SchemaScope itself (`source: curated`) and their overrides still win. Harvest now lists new, updated and removed entries, with the fields that changed, and prints the `ONLY=` list to rescore.
**Why** – NeuroSchema is curated by hand and is the source of truth for neuroscience entries. Rejected: updating the snapshots in `curated.json` by hand after each NeuroSchema change, which is easy to forget.
**Consequences** – About 30 shared entries (e.g. `cl`, `uberon`, `go`) now show NeuroSchema's name/description/links instead of Bioregistry's. The six snapshots in `curated.json` are now only fallbacks and could be deleted later. Rescore changed entries after a harvest.
