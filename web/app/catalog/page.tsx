import type { Metadata } from "next";
import Link from "next/link";
import { AutoSubmitFilters } from "@/components/client";
import { Cards, Crumbs, Pager } from "@/components/ui";
import { api } from "@/lib/api";
import { KIND_LABEL, REGISTRY_LABEL, fmtNum } from "@/lib/format";

const PAGE_SIZE = 48;
const SORTS: [string, string][] = [
  ["", "Best match / highest score"],
  ["score", "Highest score"],
  ["fair", "Most FAIR"],
  ["name", "Name A–Z"],
  ["activity", "Recently active"],
  ["adopters", "Most adopted"],
];
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const q = one((await searchParams).q);
  return { title: q ? `“${q}” in the catalog` : "Catalog", alternates: { canonical: "/catalog/" } };
}

export default async function CatalogPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  // `cat` and `reg` are the static site's parameter names; keep them so old links still work.
  const f = {
    q: one(sp.q),
    category: one(sp.category) || one(sp.cat),
    kind: one(sp.kind),
    registry: one(sp.registry) || one(sp.reg),
    grade: one(sp.grade),
    format: one(sp.format),
    sort: one(sp.sort) === "adopt" ? "adopters" : one(sp.sort),
    hideLegacy: one(sp.active) === "1",
    page: Math.max(1, Number(one(sp.page)) || 1),
  };
  const [res, categories, { rubric }] = await Promise.all([
    api.search({ q: f.q, category: f.category, kind: f.kind, registry: f.registry, grade: f.grade, format: f.format, sort: f.sort, legacy: !f.hideLegacy, page: f.page, size: PAGE_SIZE }),
    api.categories(),
    api.meta(),
  ]);
  const href = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: f.q, category: f.category, kind: f.kind, registry: f.registry, grade: f.grade, format: f.format, sort: f.sort })) if (v) p.set(k, v);
    if (f.hideLegacy) p.set("active", "1");
    if (page > 1) p.set("page", String(page));
    return `/catalog/${p.size ? `?${p}` : ""}`;
  };
  const n = (facet: string, key: string) => res.facets[facet]?.[key];
  const opt = (facet: string, key: string, label: string) => (
    <option key={key} value={key}>{label}{n(facet, key) != null ? ` (${fmtNum(n(facet, key))})` : ""}</option>
  );
  const kinds = Object.keys({ ...KIND_LABEL, ...res.facets.kind });
  const registries = Object.keys(res.facets.registry || {}).sort((a, b) => (res.facets.registry[b] ?? 0) - (res.facets.registry[a] ?? 0));
  const formats = Object.entries(res.facets.format || {}).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k]) => k);
  const filtered = Boolean(f.q || f.category || f.kind || f.registry || f.grade || f.format || f.hideLegacy);

  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Catalog", "/catalog/"]]} />
        <h1>The catalog</h1>
        <p className="lede">Search and filter every resource by domain (including cross-domain use), type, source, format or grade, and sort by score, FAIRness, activity or adoption.</p>
      </section>
      <section className="wrap section" id="explore">
        <AutoSubmitFilters className="filters">
          <label className="grow">Search<input name="q" type="search" defaultValue={f.q} placeholder="Name, acronym, tag, format, maintainer…" autoComplete="off" /></label>
          <label>Category
            <select name="category" defaultValue={f.category}>
              <option value="">All</option>
              {categories.map((c) => opt("category", c.id, c.name))}
            </select>
          </label>
          <label>Type
            <select name="kind" defaultValue={f.kind}>
              <option value="">All</option>
              {kinds.map((k) => opt("kind", k, KIND_LABEL[k] || k))}
            </select>
          </label>
          <label>Source
            <select name="registry" defaultValue={f.registry}>
              <option value="">All</option>
              {registries.map((r) => opt("registry", r, REGISTRY_LABEL[r] || r.replace(/ \(.*\)/, "")))}
            </select>
          </label>
          <label>Format
            <select name="format" defaultValue={f.format}>
              <option value="">All</option>
              {formats.map((x) => opt("format", x, x))}
            </select>
          </label>
          <label>Grade
            <select name="grade" defaultValue={f.grade}>
              <option value="">All</option>
              {(rubric?.grades || []).map((g) => opt("grade", g.grade, `${g.grade} (${g.min}+)`))}
              {opt("grade", "none", "Not evaluated")}
            </select>
          </label>
          <label>Sort
            <select name="sort" defaultValue={f.sort}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" name="active" value="1" defaultChecked={f.hideLegacy} /> Hide legacy</label>
          <noscript><button className="btn" type="submit">Apply</button></noscript>
          {filtered ? <Link className="btn-ghost" href="/catalog/">Reset</Link> : null}
        </AutoSubmitFilters>
        <p className="muted small result-count" aria-live="polite">
          <span>{fmtNum(res.total)} resource{res.total === 1 ? "" : "s"}{f.q ? ` matching “${f.q}”` : ""}{res.total > PAGE_SIZE ? ` · page ${res.page} of ${Math.ceil(res.total / PAGE_SIZE)}` : ""}</span>
        </p>
        {res.items.length ? <Cards items={res.items} fairMax={rubric?.fairMax} /> : <p className="empty">No resources match. <Link href="/catalog/">Clear filters</Link></p>}
        <Pager page={res.page} size={PAGE_SIZE} total={res.total} href={href} />
      </section>
    </>
  );
}
