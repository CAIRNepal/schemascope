"""Plain-language descriptions for every endpoint and parameter in the OpenAPI document.

Kept in one place so the developer hub, /docs and generated clients all read the same text. Each operation has
paragraphs separated by blank lines: what it does, when to use it, and what comes back. `code` and **bold** are
rendered by the developer hub.
"""
from __future__ import annotations

ENTRY_ID = "The resource's id, as it appears in the catalog URL (`/o/<id>/`) and in search results, e.g. `uberon`."
RUN_ID = "A run id from `GET /api/runs`, e.g. `2026-10-31T17-31-10Z` (the run's start time)."
N = "How many resources to return, from 1 to 50."
BEFORE = "Paging: pass the `id` of the last item you received to get the next, older page. Leave empty for the newest."

# (method, path) -> {"d": description, "p": {parameter: description}}
OPS: dict[tuple[str, str], dict] = {
    # ---------- Catalog ----------
    ("get", "/api/entries"): {
        "d": "Search and filter every resource in the catalog. This is the endpoint most applications start with.\n\n"
             "Every word in `q` must match, as a prefix, somewhere in the acronym, name, description, tags, formats, "
             "maintainer or domains, so `q=anat` finds anatomy ontologies. Add filters to narrow the results; they combine "
             "with AND.\n\n"
             "**Returns** one page of results (`items`) with the `total` number of matches, and `facets`: for each filter, "
             "how many results each value would give. Use the facets to build filter menus without extra calls.",
        "p": {
            "q": "Words to search for. Every word must match (as a prefix), e.g. `brain anatomy`. Leave empty to list everything.",
            "category": "Only resources in this domain, as primary or secondary domain. Use an id from `GET /api/categories`, e.g. `{category}`.",
            "kind": "Only this type of resource: `ontology`, `schema`, `vocabulary`, `atlas`, `data-standard` or `knowledge-base`.",
            "grade": "Only resources with this evaluation grade, `A` (best) to `E`, or `none` for resources not evaluated yet.",
            "format": "Only resources published in this file format, e.g. `OWL`, `OBO`, `JSON-LD`, `LinkML` or `JSON Schema`.",
            "registry": "Only resources listed by this registry, e.g. `OBO Foundry`, `OLS (EMBL-EBI)`, `Bioregistry` or `curated`.",
            "legacy": "Include deprecated or unmaintained (legacy) resources. Set `false` to hide them.",
            "sort": "Order of results: `score` (best evaluated first), `fair` (FAIR score), `name` (A–Z), `activity` (most recently "
                    "updated) or `adopters` (most used). By default, best match when `q` is given, otherwise `score`.",
            "page": "Which page of results to return, starting at 1.",
            "size": "How many results per page, from 1 to 100.",
        },
    },
    ("get", "/api/entries/{entry_id}"): {
        "d": "Everything about one resource in a single call: use it for a detail page, or to check a resource's score before "
             "you rely on it.\n\n"
             "**Returns** the catalog record (`entry`: name, description, links, license, formats, publications), a short "
             "`summary` with the grade and score, the `facts` the evaluator collected, who uses it (`adopters`), what it "
             "`imports` and which resources reuse it (`reusedBy`), its score `history` across runs with the `changes` between "
             "them, and `related` resources.",
        "p": {"entry_id": ENTRY_ID},
    },
    ("get", "/api/entries/{entry_id}/history"): {
        "d": "How one resource's evaluation changed over time.\n\n"
             "**Returns** `runs`: one point per evaluation run, oldest first, with the score, grade, FAIR score, version, "
             "term count and the points per criterion; and `changes`: a readable list of what changed between runs "
             "(e.g. a new release, a score going up). Use it to draw a score chart or to watch a resource for regressions.",
        "p": {"entry_id": ENTRY_ID},
    },
    ("get", "/api/categories"): {
        "d": "The domains the catalog is organised into, such as foundational ontologies or life sciences.\n\n"
             "**Returns** every domain with its `id` (use it as the `category` filter in search), name, a one-line `blurb`, "
             "`count` (resources whose main domain it is) and `reach` (resources used in it, including those whose main domain "
             "is elsewhere).",
    },
    ("get", "/api/categories/{cat_id}"): {
        "d": "One domain, with its description and how many resources it has.\n\n"
             "**Returns** the same fields as one item of `GET /api/categories`. To list the resources in a domain, call "
             "`GET /api/entries?category=<id>`.",
        "p": {"cat_id": "The domain's id from `GET /api/categories`, e.g. `{category}`."},
    },
    ("get", "/api/stats"): {
        "d": "Catalog-wide numbers for a dashboard or a summary line.\n\n"
             "**Returns** how many resources there are and how many were evaluated, how many domains and runs, the average "
             "score, counts per grade and per type, total adopters, how many resources span more than one domain, and "
             "details of the latest evaluation run.",
    },
    ("get", "/api/top-entries"): {
        "d": "The best-scored resources, highest first: a quick “where to start” list, for the whole catalog or one domain.\n\n"
             "**Returns** a list of resource summaries (id, name, description, grade, score, formats, adopters).",
        "p": {"n": N, "category": "Only resources in this domain (id from `GET /api/categories`). Leave empty for the whole catalog."},
    },
    ("get", "/api/recent-entries"): {
        "d": "Resources with the most recent activity, such as a new commit, release or dated file: useful for a “what's new” "
             "feed.\n\n"
             "**Returns** a list of resource summaries, most recently active first, each with its `lastActivity` date.",
        "p": {"n": N},
    },
    ("get", "/api/entry-ids"): {
        "d": "Every resource id in the catalog, with its main domain. Use it to build a sitemap, or as the starting list "
             "for bulk processing (then fetch each resource, staying within your rate limit).\n\n"
             "**Returns** a list of `{id, category}`.",
    },
    ("get", "/api/domain-graph"): {
        "d": "How the domains of the catalog connect to each other, for a network diagram.\n\n"
             "**Returns** `nodes` (domains, with their reach), weighted `edges` between pairs of domains (`n` = resources they "
             "share plus imports between them), and `bridges`: the resources used across the most domains.",
    },
    # ---------- Runs ----------
    ("get", "/api/runs"): {
        "d": "Evaluation runs, newest first. Each run re-checks the resources in the catalog and scores them with the rubric "
             "version shown.\n\n"
             "**Returns** for each run its `id`, start and finish time, scope (full or partial), how many resources it "
             "covered, the evaluator and rubric versions, and the sources it checked.",
        "p": {"limit": "How many runs to return, from 1 to 500."},
    },
    ("get", "/api/runs/{run_id}"): {
        "d": "The scores of every resource in one evaluation run, page by page. Use it to compare runs or to export a run's "
             "results.\n\n"
             "**Returns** the `run` details, the `total` number of resources in it, and one page of `entries`, each with its "
             "score, grade, FAIR score and points per criterion.",
        "p": {"run_id": RUN_ID, "page": "Which page to return, starting at 1.", "size": "How many resources per page, from 1 to 500."},
    },
    ("get", "/api/runs/{run_id}/snapshot"): {
        "d": "The complete archived file of one run, exactly as the evaluator wrote it: every resource's collected facts and "
             "scores. It is large (several megabytes), so download it once and keep it rather than calling it repeatedly.\n\n"
             "**Returns** the run file as JSON.",
        "p": {"run_id": RUN_ID},
    },
    # ---------- Meta ----------
    ("get", "/api/health"): {
        "d": "Whether the API is up and when its data was last loaded. Use it for monitoring or before a batch job.\n\n"
             "**Returns** `ok`, `ingestedAt` (when the data was loaded) and the latest evaluation run.",
    },
    ("get", "/api/meta"): {
        "d": "How resources are scored, and the site's own details.\n\n"
             "**Returns** `site` (name, URL, repository, contact), the latest `evaluation` run, and the scoring `rubric`: "
             "every criterion with its points, the penalties, the FAIR maximum and the score range for each grade. Read it "
             "to explain a score to your users.",
    },
    ("get", "/api/content/{name}"): {
        "d": "The data behind the site's content pages.\n\n"
             "**Returns** the document as JSON: `roadmap` lists planned and finished features; `validation` is the latest "
             "report on how well the automatic evaluation matches expert judgement.",
        "p": {"name": "Which document: `roadmap` or `validation`."},
    },
    # ---------- Auth ----------
    ("get", "/api/auth/github/login"): {
        "d": "Starts sign-in with GitHub. Open this URL in a browser (it is not for scripts): it sends you to GitHub, and after "
             "you approve, back to this site, signed in.\n\n"
             "Signing in lets you create tokens, submit entries and get a higher rate limit. We read your public GitHub "
             "profile and verified email only.",
        "p": {"next": "Where to return after sign-in: a path on this site, e.g. `/account/`. Defaults to the home page."},
    },
    ("post", "/api/auth/logout"): {
        "d": "Signs you out of this browser by clearing the session cookie. Tokens you created keep working until you revoke "
             "them.\n\n**Returns** nothing (status 204).",
    },
    ("get", "/api/auth/session"): {
        "d": "Who is signed in, if anyone. It never fails with 401, so a page can call it to decide whether to show “Sign in” "
             "or the user's name.\n\n"
             "**Returns** `user` (or `null` when signed out), how you are authenticated (`via`), and the rate limits that "
             "apply.",
    },
    ("get", "/api/auth/me"): {
        "d": "Checks a token or session: who it belongs to, what it may do and your rate limit. Unlike "
             "`/api/auth/session`, it answers 401 when there is no valid credential, which makes it a good first call to "
             "test a token.\n\n"
             "**Returns** `user`, `via` (`session` for the browser cookie or a session JWT, `token` for a personal access token), `scopes` (`api`, `mcp`) and `rateLimit`.",
    },
    ("get", "/api/auth/config"): {
        "d": "How this server handles sign-in: whether GitHub sign-in is set up, how long sessions last, the token prefix, the "
             "token scopes you can choose, and the current rate limits.",
    },
    ("post", "/api/auth/token"): {
        "d": "Gives a short-lived token (a JWT) for the account you are signed in with in this browser, to use in a quick "
             "script. It expires with your session; for anything longer-lived, create a personal access token instead.\n\n"
             "**Returns** `token`, `tokenType` (`Bearer`) and `expiresAt`.",
    },
    ("get", "/api/auth/activity"): {
        "d": "Your own account history, newest first: sign-ins and sign-outs, tokens created and revoked, and submissions. "
             "Use it to check that nothing unexpected happened on your account.\n\n"
             "**Returns** a list of events, each with an `id`, `action`, time, IP address and details.",
        "p": {"limit": "How many events to return, from 1 to 500.", "before": BEFORE},
    },
    ("get", "/api/audit"): {
        "d": "**Superadmins only.** The full audit log for the site: who signed in or out, created or revoked tokens, submitted "
             "entries, changed rate limits, and every data load.\n\n"
             "**Returns** a list of events, newest first.",
        "p": {
            "action": "Only events of this kind, e.g. `token.create`, or a family with `*`, e.g. `auth.*`. Leave empty for all.",
            "limit": "How many events to return, from 1 to 500.",
            "before": BEFORE,
        },
    },
    # ---------- Tokens ----------
    ("get", "/api/tokens"): {
        "d": "Your active personal access tokens. The secret token values are never shown again after creation; this list "
             "shows each token's name, scopes, last use and expiry so you can tell them apart and revoke old ones.\n\n"
             "Needs you to be signed in on this site (a browser session).",
    },
    ("post", "/api/tokens"): {
        "d": "Creates a personal access token for scripts, applications and AI assistants. Send it as "
             "`Authorization: Bearer <token>` to get the signed-in rate limit, and to connect MCP clients.\n\n"
             "**Returns** the `token` itself, **once**: copy it now, it cannot be shown again. Needs a signed-in browser session; "
             "you can have up to 25 active tokens.",
    },
    ("delete", "/api/tokens/{token_id}"): {
        "d": "Revokes a token immediately: any script or assistant using it stops working. Do this when a token is no longer "
             "needed or may have leaked.\n\n**Returns** nothing (status 204).",
        "p": {"token_id": "The token's `id` from `GET /api/tokens` (not the secret token value)."},
    },
    # ---------- Submissions ----------
    ("get", "/api/submissions"): {
        "d": "The entries and corrections you have submitted, newest first, so you can follow them up.\n\n"
             "**Returns** up to 100 submissions, each with the resource id (`entryId`), the id it corrects (`updateOf`, empty "
             "for new resources), when you sent it (`createdAt`) and the link to its GitHub issue (`issueUrl`), where "
             "maintainers review it.",
    },
    ("post", "/api/submissions"): {
        "d": "Proposes a new resource for the catalog, or a correction to an existing one. The submission is recorded with "
             "your GitHub identity, so you are credited.\n\n"
             "The entry is checked first (a name, a description of at least 40 characters, a homepage or repository, valid "
             "links). **Returns** a pre-filled GitHub issue link (`issueUrl`): open it to finish the submission; maintainers "
             "review it there before it joins the catalog. Most people use the form at `/submit/` instead.",
    },
    # ---------- Admin ----------
    ("get", "/api/admin/settings"): {
        "d": "**Superadmins only.** The rate limits in force for everyone, and the defaults set in the server's environment.",
    },
    ("put", "/api/admin/settings"): {
        "d": "**Superadmins only.** Changes the default rate limits for everyone. Send only the values you want to change. "
             "Takes effect within seconds and is recorded in the audit log.",
    },
    ("get", "/api/admin/users"): {
        "d": "**Superadmins only.** Everyone who has signed in, with their own rate limit (if one is set) and how many active "
             "tokens they have.",
        "p": {"q": "Only users whose GitHub login, name or email contains this text."},
    },
    ("put", "/api/admin/users/{user_id}/rate-limit"): {
        "d": "**Superadmins only.** Gives one user, and all their tokens, a different rate limit, for example a partner "
             "project that needs more. Send `null` to return them to the default. Recorded in the audit log.",
        "p": {"user_id": "The user's numeric `id` from `GET /api/admin/users`."},
    },
    ("get", "/api/admin/overview"): {
        "d": "**Superadmins only.** The admin dashboard in one call: catalog size and evaluation coverage, the review queue, "
             "accounts and active users, score changes between the two latest runs, resources that need attention, and service "
             "health (database latency, when data was loaded, the latest run).",
    },
    ("get", "/api/admin/submissions"): {
        "d": "**Superadmins only.** Every contributor's submissions with the proposed entry, newest first, for review.",
        "p": {"status": "`pending` (default), `approved`, `changes_requested`, `rejected` or `all`.",
              "q": "Only submissions whose name, id or contributor's login contains this text."},
    },
    ("post", "/api/admin/submissions/{submission_id}/review"): {
        "d": "**Superadmins only.** Records an editorial decision on a submission: approve, request changes or reject, with notes "
             "for the contributor (required unless approving). The contributor sees the decision on their account page, and it is "
             "recorded in the audit log. Merging the entry still happens through its pull request on GitHub.",
        "p": {"submission_id": "The submission's `id` from `GET /api/admin/submissions`."},
    },
    ("get", "/api/admin/catalog.csv"): {
        "d": "**Superadmins only.** Downloads every resource as CSV: id, acronym, name, type, domain, grade, score, FAIR score, "
             "adopters, version, last activity and whether it is legacy.",
    },
    # ---------- Recommend ----------
    ("get", "/api/recommend/options"): {
        "d": "The choices for guided recommendations: the areas (domains), types and file formats in the catalog with how many "
             "resources each has, and the must-haves you can ask for (actively maintained, open licence, used by other projects).",
    },
    ("get", "/api/recommend"): {
        "d": "Recommends resources for a need, best first, with the reasons for each. Describe the need in a few words, choose "
             "filters, or both.\n\n"
             "Results are ranked by how well they match your words, their evaluation score, how widely they are used and how "
             "recently they were updated. If the filters leave nothing, they are relaxed one at a time (most specific first) and "
             "`relaxed` lists which.\n\n"
             "**Returns** `items` (each with `match`, a 0–1 ranking score, and `why`, the reasons in words), `filters` as applied, "
             "`relaxed` and `total`.",
        "p": {
            "q": "The need in your own words, e.g. `mouse brain anatomy` or `describe research datasets`.",
            "category": "Only this area (domain id from `GET /api/recommend/options`).",
            "kind": "Only this type, e.g. `ontology` or `schema`.",
            "format": "Only resources available in this format, e.g. `OWL` or `JSON Schema`.",
            "min_grade": "Only resources graded this well or better: `A` (best) to `E`.",
            "maintained": "Only resources updated in the last two years.",
            "open_license": "Only resources under an open licence (CC0, CC BY, MIT, Apache, BSD, GPL and similar).",
            "used": "Only resources with at least one known adopter.",
            "limit": "How many recommendations per page, from 1 to 20.",
            "page": "Which page of recommendations, starting at 1 (the best 200 matches are ranked).",
            "sort": "`relevance` (default): best match to your words first, quality only breaks ties. `score`: the relevant "
                    "results ordered by evaluation score.",
        },
    },
    ("post", "/api/recommend/chat/feedback/{log_id}"): {
        "d": "Rate a chat answer: `rating` 1 (good) or -1 (bad), and/or a `comment`. Feedback is stored with the anonymous chat "
             "log (no identity) and used to improve recommendations.",
        "p": {"log_id": "The id from the `log` event of the chat stream."},
    },
    ("post", "/api/recommend/chat/feedback"): {
        "d": "Rate an answer that wasn't logged (for example with *Help improve recommendations* off): the question and answer "
             "are logged once, without identity, together with your `rating` and/or `comment`. **Returns** the new log `id`, "
             "for further feedback on the same answer.",
    },
    ("put", "/api/auth/preferences"): {
        "d": "Your preferences. `improveSearch` (default on): let your chats, searches and MCP tool calls be logged, without your identity, to improve "
             "recommendations. Turn it off and your chats are only kept in your account.",
    },
    ("get", "/api/auth/usage"): {"d": "How many requests your account (session and all your tokens together) made in the last hour and the last 24 hours, and your limit per minute."},
    ("get", "/api/admin/rate"): {
        "d": "**Superadmins only.** Who used the API most in the last `minutes` (accounts by login; signed-out visitors by a hash of their IP, never the IP itself), with their peak per minute, and the active blocks.",
        "p": {"minutes": "The window to report, from 1 to 1440 (default 60)."},
    },
    ("post", "/api/admin/rate/blocks"): {"d": "**Superadmins only.** Block an account (`@login`), an IP address (stored as a hash) or a key from the usage list for `minutes`. Blocked callers get 429 until it ends. Recorded in the audit log."},
    ("delete", "/api/admin/rate/blocks/{key}"): {"d": "**Superadmins only.** Lift a block early.", "p": {"key": "The block's `key` from `GET /api/admin/rate`."}},
    ("post", "/api/logs/search"): {
        "d": "Used by the site to log a search (guided recommendations, the search bar, catalog filters) without identity: the "
             "words, filters, number of results and the top results. Signed-in users with *Help improve recommendations* off are "
             "not logged (the response `id` is null). **Returns** the log `id`, for recording which result was clicked.",
    },
    ("post", "/api/logs/search/{log_id}/click"): {"d": "Records which result of a logged search was opened.", "p": {"log_id": "The `id` from `POST /api/logs/search`."}},
    ("get", "/api/admin/logs/summary"): {"d": "**Superadmins only.** Chat ratings and comments, searches per source (with no-result and click-through counts), the most common queries and the queries that found nothing."},
    ("get", "/api/admin/logs/chats"): {
        "d": "**Superadmins only.** Logged chat turns, newest first: question, what was understood, results shown, answer, model and feedback.",
        "p": {"rating": "`good`, `bad`, `comment` (has a comment) or `rated` (any feedback).", "q": "Only questions containing this text.",
              "before": "Paging: the `createdAt` of the last item you received.", "limit": "How many, from 1 to 500."},
    },
    ("get", "/api/admin/logs/searches"): {
        "d": "**Superadmins only.** Logged searches, newest first.",
        "p": {"source": "`guided`, `search`, `catalog` or `mcp` (tool calls from AI agents; the tool is in `filters.tool`).", "q": "Only queries containing this text.", "empty": "Only searches that found nothing.",
              "before": "Paging: the `createdAt` of the last item you received.", "limit": "How many, from 1 to 500."},
    },
    ("get", "/api/admin/logs/export/{kind}.{fmt}"): {
        "d": "**Superadmins only.** Download a log (up to the latest 10,000 records): `chats` or `searches`, as `csv` or `jsonl` "
             "(one JSON record per line, convenient for evaluation and training). Exports are recorded in the audit log.",
        "p": {"kind": "`chats` or `searches`.", "fmt": "`csv` or `jsonl`."},
    },
    ("get", "/api/chats"): {"d": "Your saved recommendation chats, most recent first. Chats are saved automatically when you are signed in."},
    ("get", "/api/chats/{chat_id}"): {"d": "One saved chat with every question, answer and the recommendations that were shown.", "p": {"chat_id": "The chat's `id` from `GET /api/chats`."}},
    ("patch", "/api/chats/{chat_id}"): {"d": "Renames a saved chat.", "p": {"chat_id": "The chat's `id` from `GET /api/chats`."}},
    ("delete", "/api/chats/{chat_id}"): {"d": "Deletes a saved chat and its messages. This cannot be undone.", "p": {"chat_id": "The chat's `id` from `GET /api/chats`."}},
    ("get", "/api/recommend/chat/status"): {
        "d": "Whether the chat assistant's language model is configured and reachable. Without it, the chat still answers with "
             "ranked matches.",
    },
    ("post", "/api/recommend/chat"): {
        "d": "Ask for a recommendation in plain language, as a conversation. Your words are turned into filters, the catalog is "
             "searched, and a small language model writes a short answer that may only use the resources found.\n\n"
             "**Returns** a stream of JSON lines (`application/x-ndjson`): `filters` (what was understood), `results` (the ranked "
             "resources with reasons), then `token` events with the answer text as it is written, and `done`. Signed out: a few "
             "questions per minute; signed in: more.",
    },
}

# Request body fields without their own description.
BODY_FIELDS = {
    "SubmissionIn": {
        "notes": "Anything maintainers should know, e.g. where the information came from. Shown on the GitHub issue.",
    },
}


def apply(schema: dict) -> dict:
    """Fills in descriptions on an OpenAPI document generated by FastAPI. `{category}` becomes a real domain id of
    this catalog, so the examples work as written."""
    try:
        from . import db

        category = db.rows_sync("SELECT id FROM categories ORDER BY position LIMIT 1")[0]["id"]
    except Exception:
        category = "<category id>"
    fill = lambda t: t.replace("{category}", category)  # noqa: E731
    for path, methods in schema.get("paths", {}).items():
        for method, op in methods.items():
            text = OPS.get((method, path))
            if not text:
                continue
            op["description"] = fill(text["d"])
            for prm in op.get("parameters", []):
                if prm["name"] in text.get("p", {}):
                    prm["description"] = fill(text["p"][prm["name"]])
    for name, fields in BODY_FIELDS.items():
        props = schema.get("components", {}).get("schemas", {}).get(name, {}).get("properties", {})
        for k, v in fields.items():
            if k in props and not props[k].get("description"):
                props[k]["description"] = v
    return schema
