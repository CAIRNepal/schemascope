// Submission form: builds a catalog entry, validates it, and hands it to GitHub
// as a pre-filled issue (a workflow turns that issue into a pull request).
(() => {
  const form = document.getElementById("submit-form");
  if (!form) return;
  const repo = form.dataset.repo;
  const preview = document.getElementById("json-preview");
  const errorsEl = document.getElementById("form-errors");
  const val = (n) => (form.elements[n]?.value || "").trim();
  const list = (n) => val(n).split(",").map((s) => s.trim()).filter(Boolean);
  const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

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
      usedBy: val("usedBy")
        .split("\n")
        .map((l) => l.split("|").map((s) => s.trim()))
        .filter((p) => p[0] && p[1])
        .map(([name, url, note]) => ({ name, url, ...(note ? { note } : {}) })),
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
    for (const u of e.usedBy) if (!url(u.url)) p.push(`“Used by” URL for ${u.name} must be an http(s) URL.`);
    return p;
  }

  function render() {
    preview.textContent = JSON.stringify(entry(), null, 2);
  }

  // Correction mode: /submit/?update=<id> prefills from the published entry.
  const updateId = new URLSearchParams(location.search).get("update");
  if (updateId) {
    form.elements.update.value = updateId;
    fetch(`/o/${encodeURIComponent(updateId)}/entry.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((e) => {
        if (!e) return;
        const set = (n, v) => form.elements[n] && v != null && (form.elements[n].value = Array.isArray(v) ? v.join(", ") : v);
        for (const k of ["name", "acronym", "category", "kind", "description", "homepage", "repository", "download", "maintainer", "license", "ols", "obo", "bioportal", "formats", "species", "tags"]) set(k, e[k]);
        set("doi", e.publications?.[0]?.doi);
        set("usedBy", (e.usedBy || []).map((u) => [u.name, u.url, u.note].filter(Boolean).join(" | ")).join("\n"));
        document.querySelector(".submit-form h2").textContent = `Suggest a correction to ${e.acronym || e.name}`;
        render();
      });
  }

  form.addEventListener("input", render);
  form.addEventListener("change", render);
  render();

  function check() {
    const e = entry();
    const p = problems(e);
    errorsEl.hidden = !p.length;
    errorsEl.innerHTML = p.map((x) => `<span>${x.replace(/</g, "&lt;")}</span>`).join("");
    return p.length ? null : e;
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const e = check();
    if (!e || !repo) return;
    const isUpdate = val("update");
    const body = [
      isUpdate ? `Correction to \`${isUpdate}\`` : "New catalog entry",
      "",
      "```json",
      JSON.stringify(e, null, 2),
      "```",
      val("notes") ? `\n**Notes from submitter**\n\n${val("notes")}` : "",
    ].join("\n");
    const params = new URLSearchParams({
      template: "add-resource.yml",
      title: `${isUpdate ? "Update" : "Add"}: ${e.acronym || e.name}`,
      entry: body,
      "update-id": isUpdate || "",
    });
    // GitHub limits URL length; long entries fall back to copy-paste.
    const url = `${repo}/issues/new?${params}`;
    if (url.length > 7500) {
      navigator.clipboard?.writeText(JSON.stringify(e, null, 2));
      alert("This entry is too long for a pre-filled link. The JSON was copied — paste it into the issue form that opens next.");
      window.open(`${repo}/issues/new?template=add-resource.yml`, "_blank", "noopener");
    } else window.open(url, "_blank", "noopener");
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
