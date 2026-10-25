// Search results page: ranked full-text search over /search-index.json.
(() => {
  const input = document.getElementById("search-q");
  const list = document.getElementById("results");
  const status = document.getElementById("search-status");
  if (!input || !list) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const STOP = new Set(["the", "a", "an", "of", "for", "and", "in", "on", "to", "with", "ontology", "ontologies", "schema", "schemas"]);
  let index = [];

  // Field weights: where a word matches matters more than how often.
  const FIELDS = [
    ["acronym", 24], ["name", 16], ["tags", 10], ["modules", 8], ["category", 6], ["kind", 5], ["species", 6], ["formats", 6], ["maintainer", 4], ["description", 3],
  ];

  function rank(q) {
    const phrase = norm(q).trim();
    const terms = phrase.split(/[^a-z0-9.+-]+/).filter((t) => t && !STOP.has(t));
    if (!phrase) return [];
    const out = [];
    for (const e of index) {
      const f = Object.fromEntries(FIELDS.map(([k]) => [k, norm(Array.isArray(e[k]) ? e[k].join(" · ") : e[k])]));
      let score = 0;
      if (f.acronym === phrase || e.id === phrase) score += 120;
      else if (f.acronym.startsWith(phrase)) score += 50;
      if (f.name.includes(phrase)) score += 40;
      let all = true;
      for (const t of terms) {
        let best = 0;
        for (const [k, w] of FIELDS) {
          const v = f[k];
          if (!v) continue;
          const word = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(v);
          if (word) best = Math.max(best, w);
          else if (v.includes(t)) best = Math.max(best, w / 3);
        }
        if (!best) all = false;
        score += best;
      }
      if (terms.length && !all) continue;
      if (!score) continue;
      score += (e.score ?? 0) / 25; // gentle tie-break towards better-evaluated resources
      if (e.legacy) score -= 5;
      out.push({ e, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function highlight(text, q) {
    const terms = norm(q).split(/[^a-z0-9.+-]+/).filter((t) => t.length > 1 && !STOP.has(t));
    let html = esc(text);
    for (const t of terms) html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return html;
  }

  function render() {
    const q = input.value;
    const results = rank(q);
    const url = new URL(location.href);
    if (q.trim()) url.searchParams.set("q", q.trim());
    else url.searchParams.delete("q");
    history.replaceState(null, "", url);
    document.title = q.trim() ? `“${q.trim()}” · Search · SchemaScope` : "Search · SchemaScope";
    if (!q.trim()) {
      list.innerHTML = "";
      status.textContent = `Type to search ${index.length} resources by name, acronym, tag, species, format, schema module or maintainer.`;
      return;
    }
    status.innerHTML = results.length
      ? `<b>${results.length}</b> result${results.length === 1 ? "" : "s"} for “${esc(q.trim())}”`
      : `No results for “${esc(q.trim())}”. Try fewer words, or <a href="/catalog/">browse the catalog</a>.`;
    list.innerHTML = results
      .map(({ e }) => {
        const mods = e.modules.filter((m) => norm(q).split(/\s+/).some((t) => t.length > 2 && norm(m).includes(t)));
        return `<li class="result">
  <a class="result-title" href="/o/${encodeURIComponent(e.id)}/"><span class="acr">${highlight(e.acronym || e.name, q)}</span>${e.acronym && e.acronym !== e.name ? ` <span class="nm">${highlight(e.name, q)}</span>` : ""}</a>
  ${e.grade ? `<span class="grade grade-${e.grade} sm"><b>${e.grade}</b><small>${e.score}</small></span>` : ""}
  <p class="result-meta">${esc(e.kind)} · ${esc(e.category)}${e.version ? ` · <span class="ver">${esc(e.version.length > 24 ? e.version.slice(0, 23) + "…" : e.version)}</span>` : ""}${e.legacy ? " · legacy" : ""}</p>
  <p class="result-desc">${highlight(e.description, q)}</p>
  ${mods.length ? `<p class="result-extra">Modules: ${mods.map((m) => highlight(m, q)).join(", ")}</p>` : ""}
  <p class="result-extra">${e.tags.slice(0, 6).map((t) => `<span class="chip">${highlight(t, q)}</span>`).join(" ")}</p>
</li>`;
      })
      .join("");
  }

  input.value = new URLSearchParams(location.search).get("q") || "";
  fetch("/search-index.json")
    .then((r) => r.json())
    .then((data) => {
      index = data;
      render();
    });
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(render, 60);
  });
  input.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    render();
  });
  input.focus();
})();
