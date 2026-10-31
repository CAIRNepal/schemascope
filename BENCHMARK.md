# Language model benchmark for the recommendation chat

**Date:** 31 October 2026 · **Script:** [`backend/benchmarks/llm_bench.py`](backend/benchmarks/llm_bench.py) ·
**Raw results:** [`backend/benchmarks/llm_results_2026-10-31.json`](backend/benchmarks/llm_results_2026-10-31.json)

The chat on `/recommend/` uses a small instruction model to write a short answer from the catalog's own search results.
The production server is small and has no GPU, so the question was: **which model is light enough to answer quickly on
a few CPU cores, and still good enough to trust?**

## Result

| | |
|---|---|
| **Default** | **`llama3.2:1b`** (Llama 3.2 1B Instruct): 1.7 GB of memory, an answer in about 3 s here, plain-text answers that stay with the facts given. |
| Less memory | `qwen2.5:1.5b`: 1.3 GB and similar speed, but slower to read the prompt and answers in Markdown. |
| Best answers, if the server allows | `llama3.2:3b`: the most careful answers, but 4–6× slower (about 18 s here; expect 40 s or more on a small server). Use it with 4+ dedicated cores and 4 GB of memory to spare. |
| Not recommended | `qwen2.5:0.5b` (fast but gets facts wrong), `gemma3:1b` (invents details), `smollm2:1.7b` (copies the input instead of answering), `qwen2.5:3b` (terse, misnames resources). |

Change the model with `LLM_MODEL` (see `infrastructure/production/.env.example`). Without a model, the chat still
answers with the ranked matches and their reasons.

## Method

- **Task:** the real chat prompt (`backend/catalog_api/chat.py`): a system instruction plus the question and the top five
  candidates from the recommender, one line each (about 450–600 tokens). The answer is capped at 180 tokens.
- **Questions** (on the SchemaScope catalog):
  1. I need a well-maintained ontology for mouse brain anatomy
  2. Which schema should I use to describe research datasets with an open licence?
  3. Best vocabulary for chemical compounds
  4. What should I use for cell types in single-cell RNA-seq data?
- **Hardware:** Apple M4, **CPU only** (GPU off with `num_gpu: 0`), limited to **2 and 4 threads** to stand in for a
  small server; Ollama 0.40, Q4_K_M quantised models, `num_ctx` 2048, temperature 0.2.
- **Measured:** memory once loaded, time to the first word (cold: model not loaded yet; warm: already loaded), how fast
  the prompt is read and the answer written (tokens per second), and the total time per answer (warm, averaged over
  questions 2–4).
- **Quality:** every answer was read by hand against the candidate list. (The script also counts capitalised words that
  are not candidate names; that count is noisy and only flags answers to read.)

**How this maps to a server:** the M4's cores are fast. On a typical 2–4 vCPU cloud server, expect roughly **2–3× the
times below**. The two `llama3.2:3b` and `qwen2.5:3b` runs at 4 threads overlapped with other work on the machine, so
their 4-thread numbers are pessimistic; the 2-thread numbers are the cleaner comparison.

## Speed and memory

| Model | Memory | Threads | First word (cold) | First word (warm) | Reading (tok/s) | Writing (tok/s) | Answer (warm) |
|---|---:|---:|---:|---:|---:|---:|---:|
| qwen2.5:0.5b | 0.6 GB | 2 | 1.4 s | 0.5 s | 1,004 | 99 | 1.0 s |
| | | 4 | 1.0 s | 0.4 s | 1,133 | 130 | 0.7 s |
| gemma3:1b | 1.2 GB | 2 | 7.0 s | 1.2 s | 348 | 48 | 4.2 s |
| | | 4 | 2.0 s | 0.9 s | 453 | 65 | 2.7 s |
| **llama3.2:1b** | **1.7 GB** | **2** | **9.2 s** | **1.4 s** | **350** | **45** | **3.2 s** |
| | | **4** | **2.7 s** | **0.9 s** | **573** | **44** | **3.3 s** |
| qwen2.5:1.5b | 1.3 GB | 2 | 5.3 s | 2.8 s | 172 | 46 | 4.9 s |
| | | 4 | 4.1 s | 2.1 s | 226 | 46 | 4.2 s |
| smollm2:1.7b | 2.4 GB | 2 | 7.1 s | 3.2 s | 155 | 25 | 9.0 s |
| | | 4 | 6.1 s | 2.2 s | 228 | 25 | 8.6 s |
| qwen2.5:3b | 2.4 GB | 2 | 12.8 s | 7.5 s | 65 | 16 | 10.3 s |
| | | 4 | 10.0 s | 5.3 s | 94 | 18 | 11.4 s |
| llama3.2:3b | 2.7 GB | 2 | 14.4 s | 7.4 s | 65 | 14 | 18.4 s |
| | | 4 | 12.9 s | 4.9 s | 96 | 10 | 19.6 s |

"Cold" includes loading the model from disk; the chat keeps the model loaded for 30 minutes after the last question
(`keep_alive`), so most people get the warm times. Answers stream, so people see the first words after the "first word"
time rather than waiting for the whole answer.

## Answer quality (read by hand)

| Model | Verdict | What we saw |
|---|---|---|
| qwen2.5:0.5b | Poor | Short and fast, but wrong facts: called CL the "Cell *Line* Ontology", recommended an antibody database for chemical compounds. |
| gemma3:1b | Poor | Fluent but invents details not in the data (called EMAPA "potentially expensive"); Markdown and long lists. |
| **llama3.2:1b** | **Good for its size** | Plain text, picks sensible resources and gives reasons from the data. Occasional slips (called FBbt, a fruit-fly ontology, a fit for mouse anatomy while noting the species trade-off; once called a resource "widely used" when it had no adopters). The prompt now forbids that claim. |
| qwen2.5:1.5b | Good | Sensible picks and reasons; answers in Markdown with headings (the page shows plain text), and once said CL had "a lower grade" when it is grade A. |
| smollm2:1.7b | Unusable | Mostly repeats the candidate lines back instead of answering. |
| qwen2.5:3b | Fair | Dense, fact-heavy fragments; misnamed UBERON as "Uberanatomy" and stated a limitation that isn't in the data. |
| llama3.2:3b | Best | Careful reasoning and accurate trade-offs (e.g. UBERON broader than mouse-only); sometimes too long and once echoed the word "CANDIDATES" from the prompt (now forbidden). |

## Changes made because of this benchmark

- **Filters from words are stricter about what they infer:** "best" no longer means "grade B or better" (the ranking
  already prefers high scores), and "vocabulary" or "standard" no longer forces the resource type, because people use
  them loosely. Before this, "Best vocabulary for chemical compounds" excluded ChEBI (an ontology); now ChEBI, CHEMINF
  and CHMO are among the results.
- **The prompt** now forbids stating facts not in the list, calling a resource widely used without adopters, field
  lists, and mentioning "CANDIDATES".
- **Small-server defaults:** one answer generated at a time (`LLM_CONCURRENCY=1`), answers capped at 180 tokens,
  context 2048 tokens, and the model capped at 2 GB of memory in production (`LLM_MEMORY`).

## Rerun

```bash
ollama pull llama3.2:1b qwen2.5:1.5b llama3.2:3b
cd backend && uv run python benchmarks/llm_bench.py "llama3.2:1b,qwen2.5:1.5b,llama3.2:3b" "2,4" results.json
```

On the target server itself, run it there (with `localhost:11434` pointing at that server's Ollama) to get real numbers.
