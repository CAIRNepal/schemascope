// Recommend pages: /recommend/guided/ (questions → GET /api/recommend, live) and /recommend/ask/ (chat → POST
// /api/recommend/chat, streamed as NDJSON: filters → results → answer text). Both render the same result cards.
// The guided page reads its filters from the URL, so a chat answer can link to "refine these filters".
(() => {
  const root = document.querySelector("[data-recommend]");
  if (!root) return;
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const guide = $("[data-guide]"), list = $("[data-rec-results]"), summary = $("[data-rec-summary]"), understood = $("[data-understood]");
  const log = $("[data-chat-log]"), ask = $("[data-chat-form]"), input = ask?.elements.q;
  const KEYS = ["q", "category", "kind", "format", "min_grade", "maintained", "open_license", "used"];
  const LABEL = { maintained: "Actively maintained", open_license: "Open licence", used: "Used by other projects" };
  const KIND = { ontology: "Ontology", schema: "Schema", vocabulary: "Vocabulary", atlas: "Atlas", "data-standard": "Data standard", "knowledge-base": "Knowledge base" };
  const areaNames = {};
  fetch("/api/recommend/options").then((r) => r.json()).then((o) => o.areas.forEach((a) => (areaNames[a.id] = a.name))).catch(() => {});

  // ---------- results ----------
  function render(r) {
    const items = r.items || [];
    summary.textContent = items.length ? `${items.length} of ${r.total.toLocaleString("en-US")} matching` : "";
    list.innerHTML = items.length
      ? items.map((x, i) => `<li class="rec-card">
          <div class="rec-rank">${i + 1}</div>
          <div class="rec-body">
            <div class="rec-title"><a href="/o/${esc(x.id)}/"><b>${esc(x.acronym || x.name)}</b></a>${x.acronym ? `<span class="muted">${esc(x.name)}</span>` : ""}</div>
            <div class="rec-meta">${x.grade ? `<span class="grade grade-${esc(x.grade)}"><b>${esc(x.grade)}</b><small>${x.score}</small></span>` : '<span class="muted small">Not evaluated</span>'}<span>${esc(x.kindLabel || x.kind || "")}</span><span>${esc(x.categoryName || "")}</span></div>
            ${x.description ? `<p class="rec-desc">${esc(x.description)}</p>` : ""}
            <ul class="rec-why">${(x.why || []).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
          </div>
          <div class="rec-actions"><a class="btn-ghost btn-sm" href="/o/${esc(x.id)}/">Details</a>${x.homepage ? `<a class="rec-home small" href="${esc(x.homepage)}" rel="noopener">Homepage ↗</a>` : ""}</div>
        </li>`).join("")
      : `<li class="rec-empty">Nothing matches yet. Try fewer filters or different words.</li>`;
    const chips = [];
    const f = r.filters || {};
    if (f.category) chips.push(guide?.elements.category.querySelector(`option[value="${CSS.escape(f.category)}"]`)?.textContent || areaNames[f.category] || f.category);
    if (f.kind) chips.push(KIND[f.kind] || f.kind);
    if (f.format) chips.push(f.format);
    if (f.min_grade) chips.push(`Grade ${f.min_grade} or better`);
    for (const k of ["maintained", "open_license", "used"]) if (f[k]) chips.push(LABEL[k]);
    const relaxed = (r.relaxed || []).length ? `<span class="rec-relaxed">No exact match, so relaxed: ${esc(r.relaxed.join(", "))}</span>` : "";
    understood.hidden = !chips.length && !relaxed;
    const refine = !guide ? ` <a class="rec-refine small" href="/recommend/guided/?${new URLSearchParams(Object.entries({ ...f, q: (r.words || []).join(" ") }).filter(([, v]) => v).map(([k, v]) => [k, v === true ? "true" : v]))}">Refine these filters →</a>` : "";
    understood.hidden = !chips.length && !relaxed && !refine;
    understood.innerHTML = (chips.length ? `<span class="muted small">${guide ? "Filtering by" : "Understood"}</span>${chips.map((c) => `<span class="rec-tag">${esc(c)}</span>`).join("")}` : "") + relaxed + refine;
  }

  // ---------- guided ----------
  const params = () => {
    const p = new URLSearchParams({ limit: "8" });
    const fd = new FormData(guide);
    for (const k of KEYS) {
      const v = fd.get(k);
      if (v === "on") p.set(k, "true");
      else if (v) p.set(k, String(v).trim());
    }
    return p;
  };
  let seq = 0, typing;
  async function run() {
    const n = ++seq;
    list.classList.add("loading");
    try {
      const r = await (await fetch(`/api/recommend?${params()}`)).json();
      if (n === seq) render(r);
    } catch { if (n === seq) list.innerHTML = `<li class="rec-empty">Couldn't load recommendations. Please try again.</li>`; }
    list.classList.remove("loading");
  }
  if (guide) {
    guide.addEventListener("input", (e) => { clearTimeout(typing); typing = setTimeout(run, e.target.name === "q" ? 300 : 0); });
    guide.addEventListener("reset", () => setTimeout(run, 0));
    // Start from the URL (?category=…&kind=…&maintained=true…), e.g. "Refine these filters" from the chat.
    const u = new URLSearchParams(location.search);
    applyFilters(Object.fromEntries([...u].map(([k, v]) => [k, v === "true" ? true : v])), u.get("q") || "");
    run();
  }
  // Copy what the assistant understood into the form, so people can adjust it by hand.
  function applyFilters(f, q) {
    if (!guide) return;
    guide.reset();
    guide.elements.q.value = q || "";
    if (f.category) guide.elements.category.value = f.category;
    if (f.format) guide.elements.format.value = f.format;
    const radio = (name, v) => { const el = $(`input[name="${name}"][value="${CSS.escape(v || "")}"]`); if (el) el.checked = true; };
    radio("kind", f.kind); radio("min_grade", f.min_grade);
    for (const k of ["maintained", "open_license", "used"]) guide.elements[k].checked = !!f[k];
  }

  // ---------- chat ----------
  const history = [];
  if (ask) {
  fetch("/api/recommend/chat/status").then((r) => r.json()).then((s) => {
    $("[data-chat-status]").innerHTML = s.available ? `<span class="on">●</span> AI assistant on` : `<span class="off">●</span> Matches only (AI assistant offline)`;
  }).catch(() => {});
  const bubble = (who, html) => {
    const d = document.createElement("div");
    d.className = `rec-msg ${who}`;
    d.innerHTML = html;
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };
  // Resource names in the answer become links to their pages.
  const linkify = (text, items) => {
    let html = esc(text).replace(/\n+/g, "<br>");
    for (const x of items) {
      for (const n of [x.acronym, x.name].filter(Boolean).sort((a, b) => b.length - a.length)) {
        const rx = new RegExp(`(^|[^\\w>/])(${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w<])`, "g");
        if (rx.test(html)) { html = html.replace(rx, `$1<a href="/o/${esc(x.id)}/">$2</a>`); break; }
      }
    }
    return html;
  };
  async function send(q) {
    q = q.trim();
    if (!q) return;
    $("[data-examples]").hidden = true;
    bubble("user", `<p>${esc(q)}</p>`);
    history.push({ role: "user", content: q });
    const out = bubble("bot", `<p class="rec-typing"><span></span><span></span><span></span></p>`);
    ask.querySelector("button").disabled = true;
    let text = "", items = [], notice = "";
    try {
      const r = await fetch("/api/recommend/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history.slice(-8) }) });
      if (!r.ok) {
        const p = await r.json().catch(() => ({}));
        throw new Error(p.detail || `Something went wrong (HTTP ${r.status}).`);
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "filters") pending = ev;
          else if (ev.type === "results") { items = ev.items; $("[data-ask-results]").hidden = false; render({ ...pending, items, total: items.length }); }
          else if (ev.type === "notice") notice = ev.text;
          else if (ev.type === "token") { text += ev.text; out.innerHTML = `${notice ? `<p class="muted small">${esc(notice)}</p>` : ""}<p>${linkify(text, items)}</p>`; log.scrollTop = log.scrollHeight; }
          else if (ev.type === "done" && ev.model) out.insertAdjacentHTML("beforeend", `<p class="rec-model">Written by ${esc(ev.model)} from the results below.</p>`);
        }
      }
      history.push({ role: "assistant", content: text });
    } catch (err) {
      out.innerHTML = `<p>${esc(err.message)}</p>`;
      history.pop();
    }
    ask.querySelector("button").disabled = false;
  }
  let pending = {};
  ask.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; send(q); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask.requestSubmit(); } });
  $("[data-examples]").addEventListener("click", (e) => { const b = e.target.closest(".rec-example"); if (b) send(b.textContent); });
  // /recommend/ask/?q=… asks straight away (from the landing page's box or its examples).
  const start = new URLSearchParams(location.search).get("q");
  if (start) send(start);
  }
})();
