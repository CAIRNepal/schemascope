// Guided recommendations (/recommend/guided/): questions → GET /api/recommend, ten per page with page numbers.
// While a new page or filter loads, the current results stay in place (dimmed) instead of being replaced, so the list
// doesn't flicker or jump. Filters and the page live in the URL, so a chat answer can link here with its filters.
(() => {
  const root = document.querySelector("[data-recommend]");
  const guide = root?.querySelector("[data-guide]");
  if (!guide) return;
  const $ = (s, r = root) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const list = $("[data-rec-results]"), summary = $("[data-rec-summary]"), understood = $("[data-understood]");
  const KEYS = ["q", "category", "kind", "format", "min_grade", "maintained", "open_license", "used"];
  const SIZE = 10;
  let page = 1, seq = 0, typing;

  // A pager under the list (created once).
  const pager = document.createElement("nav");
  pager.className = "rec-pager";
  pager.setAttribute("aria-label", "Pages");
  list.after(pager);

  const card = (x, i) => `<li class="rec-card">
      <div class="rec-rank">${i}</div>
      <div class="rec-body">
        <div class="rec-title"><a href="/o/${esc(x.id)}/"><b>${esc(x.acronym || x.name)}</b></a>${x.acronym ? `<span class="muted">${esc(x.name)}</span>` : ""}</div>
        <div class="rec-meta">${x.grade ? `<span class="grade grade-${esc(x.grade)}"><b>${esc(x.grade)}</b><small>${x.score}</small></span>` : '<span class="muted small">Not evaluated</span>'}<span>${esc(x.kindLabel || x.kind || "")}</span><span>${esc(x.categoryName || "")}</span></div>
        ${x.description ? `<p class="rec-desc">${esc(x.description)}</p>` : ""}
        <ul class="rec-why">${(x.why || []).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
      </div>
      <div class="rec-actions"><a class="btn-ghost btn-sm" href="/o/${esc(x.id)}/">Details</a>${x.homepage ? `<a class="rec-home small" href="${esc(x.homepage)}" rel="noopener">Homepage ↗</a>` : ""}</div>
    </li>`;

  function render(r) {
    const items = r.items || [];
    const from = (r.page - 1) * r.size + 1;
    summary.textContent = items.length ? `${from}–${from + items.length - 1} of ${r.capped ? "the top " : ""}${r.total.toLocaleString("en-US")}` : "";
    list.innerHTML = items.length ? items.map((x, i) => card(x, from + i)).join("") : `<li class="rec-empty">Nothing matches yet. Try fewer filters or different words.</li>`;
    understood.hidden = !(r.relaxed || []).length;
    understood.innerHTML = (r.relaxed || []).length ? `<span class="rec-relaxed">No exact match, so these were relaxed: ${esc(r.relaxed.join(", "))}</span>` : "";
    // Page numbers: first, last, and two either side of the current page.
    const n = r.pages || 1;
    if (n <= 1) { pager.innerHTML = ""; return; }
    const nums = [...new Set([1, n, ...[-2, -1, 0, 1, 2].map((d) => r.page + d)])].filter((x) => x >= 1 && x <= n).sort((a, b) => a - b);
    let html = `<button type="button" data-page="${r.page - 1}"${r.page === 1 ? " disabled" : ""}>← Previous</button><span class="rec-pages">`;
    nums.forEach((x, i) => {
      if (i && x - nums[i - 1] > 1) html += `<span class="rec-gap">…</span>`;
      html += `<button type="button" data-page="${x}"${x === r.page ? ' aria-current="page"' : ""}>${x}</button>`;
    });
    pager.innerHTML = html + `</span><button type="button" data-page="${r.page + 1}"${r.page === n ? " disabled" : ""}>Next →</button>`;
  }

  const params = () => {
    const p = new URLSearchParams();
    const fd = new FormData(guide);
    for (const k of KEYS) {
      const v = fd.get(k);
      if (v === "on") p.set(k, "true");
      else if (v) p.set(k, String(v).trim());
    }
    return p;
  };
  async function run(scroll = false) {
    const n = ++seq;
    const p = params();
    const shown = new URLSearchParams([...p, ...(page > 1 ? [["page", String(page)]] : [])]).toString();
    window.history.replaceState(null, "", shown ? `?${shown}` : location.pathname);
    list.classList.add("loading");
    list.setAttribute("aria-busy", "true");
    try {
      const r = await (await fetch(`/api/recommend?${p}&limit=${SIZE}&page=${page}`)).json();
      if (n !== seq) return;
      render(r);
      if (scroll) $(".rec-results-head").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      if (n === seq) list.innerHTML = `<li class="rec-empty">Couldn't load recommendations. Please try again.</li>`;
    }
    if (n === seq) { list.classList.remove("loading"); list.removeAttribute("aria-busy"); }
  }

  guide.addEventListener("input", (e) => { page = 1; clearTimeout(typing); typing = setTimeout(run, e.target.name === "q" ? 350 : 0); });
  guide.addEventListener("reset", () => { page = 1; setTimeout(run, 0); });
  pager.addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (!b || b.disabled) return; page = Number(b.dataset.page); run(true); });

  // Start from the URL (?category=…&kind=…&maintained=true&page=2), e.g. "Refine these filters" from the chat.
  const u = new URLSearchParams(location.search);
  for (const k of KEYS) {
    const v = u.get(k);
    if (!v) continue;
    const el = guide.elements[k];
    if (!el) continue;
    if (el instanceof RadioNodeList) { const r = [...el].find((x) => x.value === v); if (r) r.checked = true; }
    else if (el.type === "checkbox") el.checked = v === "true";
    else el.value = v;
  }
  page = Math.max(1, Number(u.get("page")) || 1);
  run();
})();
