"""CPU-only benchmark of small models on the recommendation-answer task (emulating a small server).

    cd backend && uv run python benchmarks/llm_bench.py "llama3.2:1b,qwen2.5:1.5b" "2,4" results.json

Needs Ollama on localhost:11434 with the models pulled, and the catalog database (DATABASE_URL).
"""
import json, re, sys, time, urllib.request
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from catalog_api import chat, recommend

QUESTIONS = [
    "I need a well-maintained ontology for mouse brain anatomy",
    "Which schema should I use to describe research datasets with an open licence?",
    "Best vocabulary for chemical compounds",
    "What should I use for cell types in single-cell RNA-seq data?",
]
MODELS = sys.argv[1].split(",")
THREADS = [int(x) for x in sys.argv[2].split(",")]

def call(model, messages, threads):
    body = {"model": model, "messages": messages, "stream": False, "keep_alive": "5m",
            "options": {"temperature": 0.2, "num_predict": 180, "num_ctx": 2048, "num_gpu": 0, "num_thread": threads}}
    req = urllib.request.Request("http://localhost:11434/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t0 = time.time(); d = json.load(urllib.request.urlopen(req, timeout=600)); wall = time.time() - t0
    ns = 1e9
    return {"wall": wall, "load": d.get("load_duration", 0) / ns, "p_tok": d.get("prompt_eval_count", 0), "p_s": d.get("prompt_eval_duration", 0) / ns,
            "e_tok": d.get("eval_count", 0), "e_s": d.get("eval_duration", 1) / ns, "text": d["message"]["content"]}

cases = []
for q in QUESTIONS:
    f = chat.parse(q)
    r = recommend.recommend(q, limit=6, **f)
    names = {n.lower() for x in r["items"][:5] for n in [x.get("acronym") or "", x["name"], x["id"]] if n}
    cases.append((q, chat.prompt(q, r["items"], r["relaxed"]), names, f))

out = []
for m in MODELS:
    for th in THREADS:
        urllib.request.urlopen(urllib.request.Request("http://localhost:11434/api/generate", data=json.dumps({"model": m, "keep_alive": 0}).encode()))  # unload
        rows = []
        for i, (q, msgs, names, f) in enumerate(cases):
            r = call(m, msgs, th)
            ttft = r["load"] + r["p_s"] if i == 0 else r["p_s"]
            # Hallucination check: capitalised acronym-like tokens that are not among the candidates.
            toks = set(re.findall(r"\b[A-Z][A-Za-z0-9-]{2,}\b", r["text"]))
            stray = sorted(t for t in toks if t.lower() not in names and not any(t.lower() in n for n in names) and t.lower() not in {"grade", "the", "this", "it", "for", "use", "used", "both", "however", "licence", "license", "open", "mouse", "brain", "anatomy", "schema", "ontology", "vocabulary", "data", "chemical", "cell", "single-cell", "rna-seq", "if", "while", "consider", "updated", "projects", "but", "its", "best", "with", "they", "these", "also", "is", "an", "as", "although"})
            rows.append(dict(q=q, filters=f, ttft=ttft, load=r["load"], p_tok=r["p_tok"], p_rate=r["p_tok"] / max(r["p_s"], 1e-6), e_tok=r["e_tok"], e_rate=r["e_tok"] / max(r["e_s"], 1e-6), wall=r["wall"], stray=stray, text=r["text"]))
        ps = json.load(urllib.request.urlopen("http://localhost:11434/api/ps"))
        mem = next((x.get("size", 0) for x in ps.get("models", []) if x["name"].startswith(m)), 0) / 1e9
        warm = rows[1:]
        summary = dict(model=m, threads=th, mem_gb=round(mem, 2), cold_first_token=round(rows[0]["ttft"], 1),
                       warm_first_token=round(sum(r["ttft"] for r in warm) / len(warm), 1),
                       prompt_tok_s=round(sum(r["p_rate"] for r in warm) / len(warm), 1), gen_tok_s=round(sum(r["e_rate"] for r in warm) / len(warm), 1),
                       warm_total_s=round(sum(r["wall"] for r in warm) / len(warm), 1), stray=sum(len(r["stray"]) for r in rows))
        print(json.dumps(summary), flush=True)
        out.append(dict(summary=summary, rows=rows))
json.dump(out, open(sys.argv[3], "w"), indent=1)
