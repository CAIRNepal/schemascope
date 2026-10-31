// Submission form (signed in with GitHub): builds a catalog entry, validates it, records it with the contributor's
// GitHub identity (POST /api/submissions) and opens the pre-filled GitHub issue that a workflow turns into a pull request.
(() => {
  const form = document.getElementById("submit-form");
  if (!form) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const preview = document.getElementById("json-preview");
  const errorsEl = document.getElementById("form-errors");
  const val = (n) => (form.elements[n]?.value || "").trim();
  const list = (n) => val(n).split(",").map((s) => s.trim()).filter(Boolean);
  const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const updateId = new URLSearchParams(location.search).get("update");
  let user = null;

  // ---------- sign-in gate ----------
  const gate = $("[data-signin-gate]");
  $("[data-signin-link]").href = `/api/auth/github/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { user: null }))
    .catch(() => ({ user: null }))
    .then((s) => {
      user = s.user;
      gate.hidden = !!user;
      form.hidden = !user;
      if (user) {
        const who = $("[data-submitter]");
        who.innerHTML = `${user.avatarUrl ? `<img src="${user.avatarUrl}&s=40" alt="" width="20" height="20">` : ""}<span></span>`;
        who.querySelector("span").textContent = `Submitting as @${user.login}${user.name ? ` (${user.name})` : ""}. You'll be credited on the GitHub issue.`;
        who.hidden = false;
      }
    });

  // ---------- "Used by": one row per project ----------
  const rowsBox = $("[data-usedby]");
  const tpl = $("[data-usedby-row]");
  const addRow = (u = {}) => {
    const row = tpl.content.firstElementChild.cloneNode(true);
    for (const k of ["name", "url", "note"]) row.querySelector(`[data-f="${k}"]`).value = u[k] || "";
    rowsBox.appendChild(row);
    return row;
  };
  $("[data-usedby-add]").addEventListener("click", () => {
    addRow().querySelector("input").focus();
    render();
  });
  rowsBox.addEventListener("click", (e) => {
    if (!e.target.closest("[data-usedby-remove]")) return;
    e.target.closest(".usedby-row").remove();
    if (!rowsBox.children.length) addRow();
    render();
  });
  addRow();
  const usedBy = () =>
    $$(".usedby-row", rowsBox)
      .map((r) => Object.fromEntries(["name", "url", "note"].map((k) => [k, r.querySelector(`[data-f="${k}"]`).value.trim()])))
      .filter((u) => u.name || u.url || u.note)
      .map(({ name, url, note }) => ({ name, url, ...(note ? { note } : {}) }));

  function entry() {
    const e = {
      id: slug(val("acronym") || val("name")),
      acronym: val("acronym") || undefined,
      name: val("name"),
      category: val("category"),
      kind: val("kind"),
      description: val("description"),
      formats: list("formats"),
      species: list("species"),
      maintainer: val("maintainer") || undefined,
      license: val("license") || undefined,
      homepage: val("homepage") || undefined,
      repository: val("repository") || undefined,
      download: val("download") || undefined,
      ols: val("ols").toLowerCase() || undefined,
      obo: val("obo").toLowerCase() || undefined,
      bioportal: val("bioportal") || undefined,
      publications: val("doi") ? [{ title: "(filled in by reviewer from Crossref)", doi: val("doi").replace(/^https?:\/\/(dx\.)?doi\.org\//, "") }] : [],
      usedBy: usedBy(),
      tags: list("tags"),
    };
    return JSON.parse(JSON.stringify(e)); // drop undefined
  }

  function problems(e) {
    const p = [];
    const url = (s) => !s || /^https?:\/\/\S+$/.test(s);
    if (!e.name) p.push("Name is required.");
    if (!e.description || e.description.length < 40) p.push("Description should be at least 40 characters.");
    if (!e.homepage && !e.repository) p.push("Give a homepage or a repository.");
    for (const k of ["homepage", "repository", "download"]) if (!url(e[k])) p.push(`${k[0].toUpperCase() + k.slice(1)} must be an http(s) URL.`);
    if (e.publications[0] && !/^10\.\d{4,9}\/\S+$/.test(e.publications[0].doi)) p.push("DOI should look like 10.xxxx/…");
    for (const u of e.usedBy) {
      if (!u.name) p.push("Each “Used by” project needs a name.");
      if (!u.url || !url(u.url)) p.push(`“Used by”: give an http(s) URL for ${u.name || "each project"}.`);
    }
    return [...new Set(p)];
  }

  const render = () => (preview.textContent = JSON.stringify(entry(), null, 2));
  const showErrors = (p) => {
    errorsEl.hidden = !p.length;
    errorsEl.innerHTML = p.map((x) => `<span>${x.replace(/</g, "&lt;")}</span>`).join("");
  };
  const check = () => {
    const e = entry();
    const p = problems(e);
    showErrors(p);
    return p.length ? null : e;
  };

  // Correction mode: /submit/?update=<id> prefills from the published entry.
  if (updateId) {
    form.elements.update.value = updateId;
    fetch(`/o/${encodeURIComponent(updateId)}/entry.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((e) => {
        if (!e) return;
        const set = (n, v) => form.elements[n] && v != null && (form.elements[n].value = Array.isArray(v) ? v.join(", ") : v);
        for (const k of ["name", "acronym", "category", "kind", "description", "homepage", "repository", "download", "maintainer", "license", "ols", "obo", "bioportal", "formats", "species", "tags"]) set(k, e[k]);
        set("doi", e.publications?.[0]?.doi);
        if ((e.usedBy || []).length) {
          rowsBox.innerHTML = "";
          e.usedBy.forEach(addRow);
        }
        $(".submit-form h2").textContent = `Suggest a correction to ${e.acronym || e.name}`;
        render();
      });
  }

  form.addEventListener("input", render);
  form.addEventListener("change", render);
  render();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const e = check();
    if (!e) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await fetch("/api/submissions", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: e, notes: val("notes") || null, updateId: val("update") || null }),
      });
      const res = await r.json().catch(() => ({}));
      if (r.status === 401) return (location.href = `/api/auth/github/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      if (!r.ok) return showErrors([res.detail || `Submission failed (HTTP ${r.status}).`]);
      // GitHub limits URL length; long entries fall back to copy-paste.
      if (res.tooLong) {
        await navigator.clipboard?.writeText(res.issueBody).catch(() => {});
        alert("This entry is too long for a pre-filled link. The issue text was copied: paste it into the form that opens next.");
        window.open(res.issueUrl.split("?")[0] + "?template=add-resource.yml", "_blank", "noopener");
      } else window.open(res.issueUrl, "_blank", "noopener");
      showErrors([]);
      $("[data-submitter] span").textContent = `Thanks, @${user.login}! Your submission is recorded; finish it on GitHub in the tab that opened. Track it on your account page.`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("copy-json")?.addEventListener("click", async (ev) => {
    const e = check();
    if (!e) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(e, null, 2));
      ev.target.textContent = "Copied ✓";
      setTimeout(() => (ev.target.textContent = "Copy JSON for a pull request"), 1800);
    } catch {
      alert("Copy failed; select the preview text instead.");
    }
  });

  document.getElementById("download-json")?.addEventListener("click", () => {
    const e = check();
    if (!e) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(e, null, 2)], { type: "application/json" })), download: `${e.id || "entry"}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
