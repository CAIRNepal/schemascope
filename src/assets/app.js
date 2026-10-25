// Progressive enhancement: theme toggle, catalog search/filter/sort, sortable tables.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Theme
  const root = document.documentElement;
  const btn = $(".theme-toggle");
  btn?.addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  });

  // Catalog explorer: data-driven, paginated (thousands of entries). The first page is server-rendered.
  const grid = $("#cards");
  const q = $("#q");
  if (grid && q && grid.dataset.index) {
    const f = { cat: $("#f-cat"), kind: $("#f-kind"), reg: $("#f-reg"), grade: $("#f-grade"), sort: $("#f-sort"), active: $("#f-active") };
    const count = $("#count"), empty = $("#empty"), more = $("#more");
    const PAGE = 48;
    let all = [], view = [], shown = 0;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const params = new URLSearchParams(location.search);
    q.value = params.get("q") || "";
    for (const k of ["cat", "kind", "reg", "grade", "sort"]) if (params.get(k) && f[k]) f[k].value = params.get(k);
    f.active.checked = params.get("active") === "1";
    const sorters = {
      score: (a, b) => (b.s ?? -1) - (a.s ?? -1) || a.n.localeCompare(b.n),
      name: (a, b) => (a.a || a.n).localeCompare(b.a || b.n),
      activity: (a, b) => (b.t || "").localeCompare(a.t || ""),
      adopt: (a, b) => (b.u || 0) - (a.u || 0) || (b.s ?? -1) - (a.s ?? -1),
      fair: (a, b) => (b.f ?? -1) - (a.f ?? -1) || (b.s ?? -1) - (a.s ?? -1),
    };
    const card = (e) => `<article class="card">
  <div class="card-top"><span class="kind">${esc(e.k)}</span>${e.l ? '<span class="pill-legacy">Legacy</span>' : ""}${e.g ? `<span class="grade grade-${e.g}"><b>${e.g}</b><small>${e.s}</small></span>` : '<span class="grade grade-none">–</span>'}</div>
  <h3><a href="/o/${encodeURIComponent(e.id)}/"><span class="acr">${esc(e.a || e.n)}</span>${e.a && e.a !== e.n ? `<span class="nm">${esc(e.n)}</span>` : ""}</a></h3>
  <p class="desc">${esc(e.d)}</p>
  <div class="card-meta"><a class="cat-link" href="/category/${e.c}/">${esc(e.cn)}</a>${e.x?.length ? `<span class="xdomains" title="Also used in: ${esc(e.xn.join(", "))}">+${e.x.length} domain${e.x.length === 1 ? "" : "s"}</span>` : ""}${e.v ? `<span class="ver">${esc(e.v.length > 22 ? e.v.slice(0, 21) + "…" : e.v)}</span>` : ""}</div>
  <div class="card-foot"><span class="chips">${(e.fm || []).slice(0, 3).map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</span><span class="stat" title="Listed in: ${esc(e.r.join(", "))}">${e.f != null ? `FAIR ${e.f} · ` : ""}${e.r.length} source${e.r.length === 1 ? "" : "s"}</span></div>
</article>`;
    function apply(push = true) {
      const terms = q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      view = all.filter((e) =>
        terms.every((t) => e.text.includes(t)) &&
        (!f.cat.value || e.c === f.cat.value || (e.x || []).includes(f.cat.value)) &&
        (!f.kind.value || e.kid === f.kind.value) &&
        (!f.reg.value || e.r.includes(f.reg.value)) &&
        (!f.grade.value || e.g === f.grade.value) &&
        (!f.active.checked || !e.l)
      ).sort(sorters[f.sort.value] || sorters.score);
      shown = 0;
      grid.innerHTML = "";
      page();
      count.textContent = `${view.length.toLocaleString()} of ${all.length.toLocaleString()} resources`;
      empty.hidden = view.length > 0;
      if (push) {
        const p = new URLSearchParams();
        if (q.value.trim()) p.set("q", q.value.trim());
        for (const k of ["cat", "kind", "reg", "grade"]) if (f[k]?.value) p.set(k, f[k].value);
        if (f.sort.value !== "score") p.set("sort", f.sort.value);
        if (f.active.checked) p.set("active", "1");
        const s = p.toString();
        history.replaceState(null, "", s ? `?${s}` : location.pathname);
      }
    }
    function page() {
      grid.insertAdjacentHTML("beforeend", view.slice(shown, shown + PAGE).map(card).join(""));
      shown = Math.min(view.length, shown + PAGE);
      more.hidden = shown >= view.length;
      more.textContent = `Load more (${(view.length - shown).toLocaleString()} more)`;
    }
    more.addEventListener("click", page);
    fetch(grid.dataset.index).then((r) => r.json()).then((d) => {
      all = d.map((e) => ({ ...e, text: [e.a, e.n, e.d, e.cn, ...(e.xn || []), ...(e.tg || []), ...(e.fm || []), ...e.r].join(" ").toLowerCase() }));
      apply(false);
    });
    let typing;
    q.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(apply, 120);
    });
    Object.values(f).forEach((el) => el?.addEventListener("change", () => apply()));
    const reset = () => {
      q.value = "";
      for (const k of ["cat", "kind", "reg", "grade"]) if (f[k]) f[k].value = "";
      f.sort.value = "score";
      f.active.checked = false;
      apply();
    };
    $("#f-reset")?.addEventListener("click", reset);
    $("#f-reset2")?.addEventListener("click", reset);
  }

  // "/" focuses the page's search or filter box
  addEventListener("keydown", (e) => {
    const box = document.getElementById("q") || document.querySelector("[data-search]");
    if (box && e.key === "/" && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      box.focus();
    }
  });

  // Sortable tables
  for (const table of $$("table.sortable")) {
    const ths = $$("th", table);
    ths.forEach((th, i) => {
      th.tabIndex = 0;
      const sort = () => {
        const dir = th.getAttribute("aria-sort") === "descending" ? "ascending" : "descending";
        ths.forEach((x) => x.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", dir);
        const num = th.dataset.sort === "num";
        const val = (tr) => {
          const td = tr.children[i];
          const v = td.dataset.v ?? td.textContent.trim();
          return num ? parseFloat(v) || 0 : v.toLowerCase();
        };
        const tbody = table.tBodies[0];
        [...tbody.rows]
          .sort((a, b) => {
            const x = val(a), y = val(b);
            const r = num ? x - y : String(x).localeCompare(String(y));
            return dir === "ascending" ? r : -r;
          })
          .forEach((tr) => tbody.appendChild(tr));
      };
      th.addEventListener("click", sort);
      th.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), sort()));
    });
  }
})();
