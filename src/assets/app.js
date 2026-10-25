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

  // Catalog explorer (home page)
  const grid = $("#cards");
  const q = $("#q");
  if (grid && q) {
    const cards = $$(".card", grid);
    const f = { cat: $("#f-cat"), kind: $("#f-kind"), species: $("#f-species"), grade: $("#f-grade"), sort: $("#f-sort"), active: $("#f-active") };
    const count = $("#count");
    const empty = $("#empty");
    const explore = $("#explore");

    // Read state from the URL so filtered views can be shared.
    const params = new URLSearchParams(location.search);
    q.value = params.get("q") || "";
    for (const k of ["cat", "kind", "species", "grade", "sort"]) if (params.get(k)) f[k].value = params.get(k);
    f.active.checked = params.get("active") === "1";

    const sorters = {
      score: (a, b) => b.dataset.score - a.dataset.score || a.dataset.name.localeCompare(b.dataset.name),
      name: (a, b) => a.dataset.name.localeCompare(b.dataset.name),
      activity: (a, b) => (b.dataset.activity || "").localeCompare(a.dataset.activity || ""),
      adopt: (a, b) => b.dataset.adopt - a.dataset.adopt || b.dataset.score - a.dataset.score,
      fair: (a, b) => b.dataset.fair - a.dataset.fair || b.dataset.score - a.dataset.score,
    };

    function apply(push = true) {
      const terms = q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      let n = 0;
      for (const c of cards) {
        const d = c.dataset;
        const show =
          terms.every((t) => d.text.includes(t)) &&
          (!f.cat.value || d.cat === f.cat.value) &&
          (!f.kind.value || d.kind === f.kind.value) &&
          (!f.species.value || d.species.split("|").includes(f.species.value)) &&
          (!f.grade.value || d.grade === f.grade.value) &&
          (!f.active.checked || d.status !== "legacy");
        c.hidden = !show;
        if (show) n++;
      }
      cards.sort(sorters[f.sort.value] || sorters.score).forEach((c) => grid.appendChild(c));
      count.textContent = `${n} of ${cards.length} resources`;
      empty.hidden = n > 0;
      if (push) {
        const p = new URLSearchParams();
        if (q.value.trim()) p.set("q", q.value.trim());
        for (const k of ["cat", "kind", "species", "grade"]) if (f[k].value) p.set(k, f[k].value);
        if (f.sort.value !== "score") p.set("sort", f.sort.value);
        if (f.active.checked) p.set("active", "1");
        const s = p.toString();
        history.replaceState(null, "", s ? `?${s}` : location.pathname);
      }
    }

    let typing;
    q.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(apply, 80);

    });

    Object.values(f).forEach((el) => el.addEventListener("change", () => apply()));
    const reset = () => {
      q.value = "";
      for (const k of ["cat", "kind", "species", "grade"]) f[k].value = "";
      f.sort.value = "score";
      f.active.checked = false;
      apply();
    };
    $("#f-reset")?.addEventListener("click", reset);
    $("#f-reset2")?.addEventListener("click", reset);
    if (params.toString()) apply(false);

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
