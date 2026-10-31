"use client";
// Submission form: builds a catalog entry, validates it, and hands it to GitHub as a pre-filled issue
// (a workflow turns that issue into a pull request). Port of the static site's submit.js.
import { useMemo, useRef, useState } from "react";

type Option = { value: string; label: string };
export type Initial = Partial<Record<string, string>>;

const FIELDS = ["name", "acronym", "category", "kind", "description", "homepage", "repository", "download", "formats", "species", "maintainer", "license", "ols", "obo", "bioportal", "doi", "usedBy", "tags", "notes"] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string>;

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function buildEntry(v: Values) {
  const t = (k: Field) => v[k].trim();
  const e = {
    id: slug(t("acronym") || t("name")),
    acronym: t("acronym") || undefined,
    name: t("name"),
    category: t("category"),
    kind: t("kind"),
    description: t("description"),
    formats: list(v.formats),
    species: list(v.species),
    maintainer: t("maintainer") || undefined,
    license: t("license") || undefined,
    homepage: t("homepage") || undefined,
    repository: t("repository") || undefined,
    download: t("download") || undefined,
    ols: t("ols").toLowerCase() || undefined,
    obo: t("obo").toLowerCase() || undefined,
    bioportal: t("bioportal") || undefined,
    publications: t("doi") ? [{ title: "(filled in by reviewer from Crossref)", doi: t("doi").replace(/^https?:\/\/(dx\.)?doi\.org\//, "") }] : [],
    usedBy: v.usedBy
      .split("\n")
      .map((l) => l.split("|").map((s) => s.trim()))
      .filter((p) => p[0] && p[1])
      .map(([name, url, note]) => ({ name, url, ...(note ? { note } : {}) })),
    tags: list(v.tags),
  };
  return JSON.parse(JSON.stringify(e)) as typeof e; // drop undefined
}

function problems(e: ReturnType<typeof buildEntry>) {
  const p: string[] = [];
  const url = (s?: string) => !s || /^https?:\/\/\S+$/.test(s);
  if (!e.name) p.push("Name is required.");
  if (!e.description || e.description.length < 40) p.push("Description should be at least 40 characters.");
  if (!e.homepage && !e.repository) p.push("Give a homepage or a repository.");
  for (const k of ["homepage", "repository", "download"] as const) if (!url(e[k])) p.push(`${k[0].toUpperCase() + k.slice(1)} must be an http(s) URL.`);
  if (e.publications[0] && !/^10\.\d{4,9}\/\S+$/.test(e.publications[0].doi)) p.push("DOI should look like 10.xxxx/…");
  for (const u of e.usedBy) if (!url(u.url)) p.push(`“Used by” URL for ${u.name} must be an http(s) URL.`);
  return p;
}

export function SubmitForm({ repo, categories, kinds, initial, updateId, updateLabel }: {
  repo?: string; categories: Option[]; kinds: Option[]; initial: Initial; updateId?: string; updateLabel?: string;
}) {
  const [v, setV] = useState<Values>(() => {
    const base = Object.fromEntries(FIELDS.map((f) => [f, initial[f] ?? ""])) as Values;
    base.category ||= categories[0]?.value ?? "";
    base.kind ||= kinds[0]?.value ?? "";
    return base;
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const entry = useMemo(() => buildEntry(v), [v]);
  const formRef = useRef<HTMLFormElement>(null);

  const field = (name: Field) => ({ name, value: v[name], onChange: (ev: { target: { value: string } }) => setV((x) => ({ ...x, [name]: ev.target.value })) });
  const check = () => {
    const p = problems(entry);
    setErrors(p);
    return p.length ? null : entry;
  };

  const openIssue = (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = check();
    if (!e || !repo) return;
    const body = [
      updateId ? `Correction to \`${updateId}\`` : "New catalog entry",
      "",
      "```json",
      JSON.stringify(e, null, 2),
      "```",
      v.notes.trim() ? `\n**Notes from submitter**\n\n${v.notes.trim()}` : "",
    ].join("\n");
    const params = new URLSearchParams({ template: "add-resource.yml", title: `${updateId ? "Update" : "Add"}: ${e.acronym || e.name}`, entry: body, "update-id": updateId || "" });
    // GitHub limits URL length; long entries fall back to copy-paste.
    const url = `${repo}/issues/new?${params}`;
    if (url.length > 7500) {
      navigator.clipboard?.writeText(JSON.stringify(e, null, 2));
      alert("This entry is too long for a pre-filled link. The JSON was copied — paste it into the issue form that opens next.");
      window.open(`${repo}/issues/new?template=add-resource.yml`, "_blank", "noopener");
    } else window.open(url, "_blank", "noopener");
  };

  const copy = async () => {
    const e = check();
    if (!e) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(e, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      alert("Copy failed; select the preview text instead.");
    }
  };

  const download = () => {
    const e = check();
    if (!e) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(e, null, 2)], { type: "application/json" })), download: `${e.id || "entry"}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="wrap section submit-grid">
      <form ref={formRef} className="panel submit-form" noValidate onSubmit={openIssue}>
        <h2>{updateId ? `Suggest a correction to ${updateLabel || updateId}` : "Resource details"}</h2>
        <div className="row2">
          <label>Name *<input {...field("name")} required placeholder="Uber-anatomy Ontology" /></label>
          <label>Acronym<input {...field("acronym")} placeholder="UBERON" /></label>
        </div>
        <div className="row2">
          <label>Category *<select {...field("category")} required>{categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <label>Type *<select {...field("kind")} required>{kinds.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        </div>
        <label>Description * <small className="muted">1–3 sentences, at least 40 characters</small><textarea {...field("description")} rows={3} required /></label>
        <div className="row2">
          <label>Homepage *<input {...field("homepage")} type="url" required placeholder="https://…" /></label>
          <label>Repository<input {...field("repository")} type="url" placeholder="https://github.com/org/repo" /></label>
        </div>
        <label>Download / PURL <small className="muted">canonical machine-readable file</small><input {...field("download")} type="url" placeholder="http://purl.obolibrary.org/obo/xyz.owl" /></label>
        <div className="row2">
          <label>Formats <small className="muted">comma-separated</small><input {...field("formats")} placeholder="OWL, OBO, JSON-LD" /></label>
          <label>Species <small className="muted">comma-separated</small><input {...field("species")} placeholder="Mouse, Human" /></label>
        </div>
        <div className="row2">
          <label>Maintainer<input {...field("maintainer")} placeholder="Lab, institute or consortium" /></label>
          <label>License<input {...field("license")} placeholder="CC BY 4.0" /></label>
        </div>
        <div className="row3">
          <label>OLS id<input {...field("ols")} placeholder="uberon" /></label>
          <label>OBO id<input {...field("obo")} placeholder="uberon" /></label>
          <label>BioPortal acronym<input {...field("bioportal")} placeholder="UBERON" /></label>
        </div>
        <label>Reference paper DOI<input {...field("doi")} placeholder="10.1186/gb-2012-13-1-r5" /></label>
        <label>Used by <small className="muted">one per line: Project name | URL | how it is used</small><textarea {...field("usedBy")} rows={3} placeholder="Project | https://example.org | How it uses the resource" /></label>
        <label>Tags <small className="muted">comma-separated</small><input {...field("tags")} placeholder="brain regions, mouse" /></label>
        <label>Anything else reviewers should know?<textarea {...field("notes")} rows={2} /></label>
        {errors.length ? <p className="form-errors" role="alert">{errors.map((x) => <span key={x}>{x}</span>)}</p> : null}
        <div className="form-actions">
          {repo ? <button type="submit" className="btn">Open pre-filled GitHub issue</button> : <button type="submit" className="btn" disabled title="Set repository in site.config.json">GitHub repository not configured</button>}
          <button type="button" className="btn-ghost" onClick={copy}>{copied ? "Copied ✓" : "Copy JSON for a pull request"}</button>
          <button type="button" className="btn-ghost" onClick={download}>Download JSON</button>
        </div>
      </form>
      <aside className="submit-side">
        <div className="panel">
          <h2>Entry preview</h2>
          <pre className="json-preview"><code>{JSON.stringify(entry, null, 2)}</code></pre>
        </div>
        <div className="panel">
          <h2>Prefer Git directly?</h2>
          <p className="small">Fork the repository, add your entry to <code>data/catalog.json</code>, run <code>npm run validate</code> and open a pull request. The same checks run on every PR.</p>
          {repo ? (
            <p className="small">
              <a href={repo}>Repository</a> · <a href={`${repo}/issues/new?template=add-resource.yml`}>Issue form</a> · <a href={`${repo}/pulls`}>Open pull requests</a>
            </p>
          ) : null}
          {repo ? <p className="small muted">Entry format: <a href={`${repo}/blob/main/data/catalog.schema.json`}>catalog.schema.json</a> (JSON Schema).</p> : null}
        </div>
      </aside>
    </section>
  );
}
