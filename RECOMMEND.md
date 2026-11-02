# Recommendations: architecture of "Find a resource" (Ask and Guided)

"Which ontology, schema or standard should I use?" is answered by one recommendation engine with two ways in:

- **Guided** (`/recommend/guided/`): people pick an area, type, format, must-haves, a minimum grade and an order.
- **Ask** (`/recommend/ask/`): people describe their need in a chat; a small language model explains the results.

Both are also available to programs: `GET /api/recommend`, `POST /api/recommend/chat`, and the MCP tool
`recommend_resources`. Everything is async and non-blocking (see `DECISIONS.md`).

```
                    ┌──────────────── /recommend/ (landing) ────────────────┐
                    │                                                       │
          /recommend/guided/                                      /recommend/ask/
          recommend.js                                            chat.js
                │ GET /api/recommend?q&filters&sort&page              │ POST /api/recommend/chat (NDJSON stream)
                ▼                                                     ▼
        ┌───────────────┐                                  ┌──────────────────────┐
        │ recommend.py  │◄─────────── filters ─────────────│ chat.py              │
        │ rank + reasons│                                  │ 1 words → filters    │
        └──────┬────────┘                                  │   (rules, no model)  │
               │ async SQL                                 │ 2 recommend()        │
               ▼                                           │ 3 small model writes │
        ┌───────────────┐                                  │   a short answer     │──► Ollama (LLM_URL, LLM_MODEL)
        │ Postgres      │◄── saved chats (signed in) ──────│ 4 save / log turn    │
        │ entries, …    │◄── chat_logs (anonymous) ────────└──────────────────────┘
        └───────────────┘
```

## 1. The ranking engine (`backend/catalog_api/recommend.py`)

**Relevance comes first.** If a resource isn't about what was asked, its grade doesn't matter.

1. **Words.** The question is split into words; stop words ("I", "need", "ontology", "best", …) are dropped.
2. **Word weights (IDF).** Each word counts by how rare it is in the catalog: `log((N+1)/(df+1))`, where `df` is
   the number of resources the word matches (as a prefix, over name, acronym, description, tags, formats, maintainer
   and domains). "gdpr" matches a handful of resources and weighs a lot; "data" matches hundreds and weighs little.
   Words that match nothing are dropped.
3. **Candidates (SQL).** Resources matching any word, after the filters, up to 200. Relevance is computed in the
   query: the sum of the weights of the words a resource matches, plus a third more when a word is in its name or
   acronym. The matched words come back too, for the reasons shown to people.
4. **Order.** `match = 0.85 × relevance + 0.15 × quality`, where quality = 0.6 × score + 0.25 × adopters (capped at 20)
   + 0.15 × recency (updated within 5 years). Quality only breaks near-ties between equally relevant resources.
   - `sort=score` ("best rated", "highest graded" in the chat, or *Order by: highest grade* in Guided): the relevant
     results (at least 60% as relevant as the best) are ordered by evaluation score; the rest follow.
   - With no words (Guided with only filters), results are ordered by quality.
5. **Filters** are hard: area (any of a resource's domains), type, format, minimum grade, actively maintained (updated
   in the last two years), open licence (CC0, CC BY, MIT, Apache, BSD, GPL, …), used by other projects. Legacy
   resources are never recommended.
6. **Relaxing.** If the filters leave nothing, they are dropped one at a time, most specific first (format, used,
   open licence, maintained, minimum grade, type, area), and the response lists what was relaxed.
7. **Reasons.** Each result carries `why`: the words it matched, its grade, adopters, last update, licence and
   formats; and `relevance` and `match` (0–1).

Example: "gdpr data sharing" → SMASHHIT Core (matches all three words, including the rare "gdpr" and "sharing")
first, then the other GDPR ontologies, regardless of their grades.

## 2. The chat (`backend/catalog_api/chat.py`)

One chat turn, streamed to the browser as newline-delimited JSON (NDJSON):

| Step | What happens | Event |
|---|---|---|
| 0 | Signed in: continue or start a saved chat | `chat` (id, title) |
| 1 | The question becomes filters by **rules**, not a model: area, type (only ontology, schema, atlas and knowledge base are strict; "vocabulary" and "standard" are used loosely), format, must-haves ("maintained", "open licence", "widely used"), "high quality" → minimum grade B, "best rated" → order by score. Earlier questions in the chat count as context. | `filters` |
| 2 | `recommend()` with those filters, top 6 | `results` |
| 3 | The model writes a short answer (≤180 tokens) from the top 5 results only, one line each; it is told to use only the facts given | `token` … |
| 4 | Save the turn to the account (signed in); log it anonymously (if allowed) | `log` (id for feedback) |
| 5 | | `done` (model, or null) |

**Why rules for step 1:** a second model call would double the time on a CPU server, and small models make mistakes
turning text into filters. Rules are instant and predictable; the model only does what it is good at, writing.

**Grounding:** the model sees only the candidates (name, type, grade, adopters, last update, licence, description) and
must not mention anything else. Resource names in its answer are turned into links in the browser, and the results it
used are always shown under the answer, so every claim can be checked.

**Without a model** (`LLM_URL` empty, the server unreachable, or busy): the chat answers with the top matches and
their reasons. **One answer at a time** (`LLM_CONCURRENCY=1`); a second question meanwhile gets the plain answer and a
notice. The chat has its own rate limit: `CHAT_RATE_ANON` (default 6/min per IP) and `CHAT_RATE_USER` (20/min).

**The model:** `llama3.2:1b` by default, served by Ollama, kept loaded for 30 minutes, context 2048 tokens, temperature
0.2. Chosen in a CPU-only benchmark of seven small models; see [BENCHMARK.md](BENCHMARK.md). Change it with `LLM_MODEL`.

## 3. Saving, logging and feedback

| | Signed out | Signed in |
|---|---|---|
| Chat history | In the browser, for the session (`sessionStorage`), listed in the sidebar | Saved to the account (`chats`, `chat_messages`): list, rename, delete |
| Anonymous logs (`chat_logs`, `search_logs`) | Always | On by default; *Help improve recommendations* in the account's **Settings** turns it off (`users.improve_search`, `PUT /api/auth/preferences`) |
| Feedback (👍 / 👎 / comment) on every answer | Yes | Yes. If the answer wasn't logged, giving feedback logs that one answer with it (`POST /api/recommend/chat/feedback`) |

**`chat_logs`**: question, filters, ids of the results shown, answer, model, a random per-browser-session id, time, and
feedback (`rating` 1/-1, `comment`). Saved chats keep the log id of each answer, so feedback works on reopened chats.

**`search_logs`**: searches from Guided (`guided`), the search bar (`search`) and the catalog filters (`catalog`): the
words, filters, result count, the top 20 result ids, which results were opened (`clicked`), the session id and time.
The browser logs a search once typing pauses (1.5 s) via `POST /api/logs/search`; opening a result is recorded with
`POST /api/logs/search/{id}/click` (or sent with the entry if it hadn't been logged yet). Shared helper:
`window.searchLog` in `src/assets/app.js`.

Neither table has a user id, IP address or link to saved chats, by design. Purpose: improve search (questions with 👎
or no results, click-through), build evaluation sets, and tune ranking, rules, prompts and models.

**Admin:** the dashboard's *Logs & feedback* view (`/admin/#logs`) shows ratings, searches per source with no-result
and click-through rates, the most common queries and the queries that found nothing, and filterable tables of chat
answers and searches. Export with `GET /api/admin/logs/export/{chats|searches}.{csv|jsonl}` (JSONL: one record per
line, for evaluation and training; exports are audit-logged). The privacy policy (`/privacy/#chat`) explains all of this.

## 4. Front end

- `src/assets/recommend.js`: Guided. Live results, ten per page with page numbers; while loading, the current results
  stay (dimmed) so nothing flickers; filters and page live in the URL so the chat can link to "Refine these filters".
- `src/assets/chat.js`: Ask. Sidebar of chats (account or session), centred conversation, composer at the bottom
  (Enter sends, Shift+Enter new line), streamed answers, recommendation cards under each answer, feedback.
- Questions started elsewhere (the landing page) are handed over in `sessionStorage`, never in the URL.

## 5. Deployment

- **Sandbox:** the API uses Ollama on the host (`LLM_URL=http://host.docker.internal:11434`).
- **Production:** an optional `llm` service (`--profile llm`) runs Ollama with one model, one request at a time and a
  2 GB memory cap; Caddy flushes streamed responses immediately. Without the profile, chat works with plain answers.

## 6. Extending

- **Better relevance:** add synonyms or embeddings (semantic search, on the roadmap) as another relevance term in
  `_candidates`; keep relevance first.
- **Learning from the log:** questions with 👎 or no results are the first evaluation set; rerun
  `backend/benchmarks/llm_bench.py` against them when changing the prompt or model.
- **Tests:** `backend/tests/test_api.py` covers ranking (relevance first, IDF, sort by score, relaxing), the chat
  stream, saving, logging, opt-out and feedback.
