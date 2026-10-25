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
