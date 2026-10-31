import Link from "next/link";
import type { ReactNode } from "react";
import type { HistoryPoint, Summary } from "@/lib/api";
import { fmtDate, truncate } from "@/lib/format";

const ICONS: Record<string, ReactNode> = {
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  shield: <><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  tag: <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z" /><circle cx="8" cy="8" r="1.5" /></>,
  dna: <><path d="M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12" /><path d="M8.5 7h7M8.5 17h7M10 12h4" /></>,
  flask: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" /><path d="M7.5 15h9" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  leaf: <><path d="M5 19c0-9 6-15 15-15 0 9-6 15-15 15Z" /><path d="M5 19 14 10" /></>,
  atom: <><circle cx="12" cy="12" r="1.6" /><ellipse cx="12" cy="12" rx="9" ry="3.6" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  people: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15 14.5c3 0 6 2 6 5" /></>,
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a2 2 0 0 0-3-2Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />,
  grid: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16M12 4v16" /></>,
  cell: <><circle cx="12" cy="12" r="3" /><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4" /></>,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  pulse: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  molecule: <><circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="17" r="2.5" /><path d="M8.2 8.3 10.5 15M15.8 8.3 13.5 15M8.5 7h7" /></>,
  scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><circle cx="12" cy="12" r="4" /></>,
  wave: <path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5" />,
  node: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><circle cx="12" cy="12" r="2" /><path d="M7 12h3M14 11l3.3-3.6M14 13l3.3 3.6" /></>,
  graph: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8M6 8v8M18 8v8M8 18h8M7.5 7.5l9 9" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></>,
};

export function Icon({ name, className = "icon" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] || ICONS.book}
    </svg>
  );
}

export const ExtIcon = () => (
  <svg className="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

export function Logo({ brand, className = "" }: { brand: string; className?: string }) {
  return (
    <span className={`logo ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="logo-light" src="/assets/brand/logo-horizontal.png" alt={brand} width={262} height={40} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="logo-dark" src="/assets/brand/logo-horizontal-dark.png" alt="" aria-hidden="true" width={262} height={40} />
    </span>
  );
}

type Gradeable = Pick<Summary, "grade" | "score" | "qualityPartial" | "qualityNotAssessed">;
export function GradeBadge({ r, size = "" }: { r: Gradeable | null; size?: string }) {
  if (!r || !r.grade) return <span className={`grade grade-none ${size}`} title="Not evaluated yet">–</span>;
  const partial = r.qualityPartial ? `; quality partially assessed (${r.qualityNotAssessed} of 20 Q points could not be checked)` : "";
  return (
    <span className={`grade grade-${r.grade} ${size}`} title={`Evaluation score ${r.score}/100${partial}`}>
      <b>{r.grade}</b>
      <small>{r.score}</small>
      {r.qualityPartial ? <sup className="q-partial" aria-label="quality partially assessed">*</sup> : null}
    </span>
  );
}

export function Card({ e, fairMax }: { e: Summary; fairMax?: number }) {
  return (
    <article className="card">
      <div className="card-top">
        <span className="kind">{e.kindLabel}</span>
        {e.legacy ? <span className="pill-legacy">Legacy</span> : e.penalty != null && e.penalty <= -8 ? <span className="pill-stale" title={`Inactivity penalty ${e.penalty}`}>Inactive</span> : null}
        <GradeBadge r={e} />
      </div>
      <h3>
        <Link href={`/o/${e.id}/`}>
          <span className="acr">{e.acronym || e.name}</span>
          {e.acronym && e.acronym !== e.name ? <span className="nm">{e.name}</span> : null}
        </Link>
      </h3>
      <p className="desc">{e.description}</p>
      <div className="card-meta">
        <Link className="cat-link" href={`/category/${e.category}/`}>{e.categoryName}</Link>
        {e.domains.length ? <span className="xdomains">+{e.domains.length} domain{e.domains.length === 1 ? "" : "s"}</span> : null}
        {e.version ? <span className="ver" title="Version evaluated">{truncate(e.version, 24)}</span> : <span>{e.species.join(", ")}</span>}
      </div>
      <div className="card-foot">
        <span className="chips">{e.formats.slice(0, 3).map((f) => <span className="chip" key={f}>{f}</span>)}</span>
        <span className="stat">
          {e.fair != null ? <span title="FAIR subtotal">FAIR {e.fair}{fairMax ? `/${fairMax}` : ""} · </span> : null}
          {e.adopters} adopter{e.adopters === 1 ? "" : "s"}
        </span>
      </div>
    </article>
  );
}

export function Cards({ items, fairMax }: { items: Summary[]; fairMax?: number }) {
  return <div className="cards">{items.map((e) => <Card key={e.id} e={e} fairMax={fairMax} />)}</div>;
}

export function MiniList({ items }: { items: Summary[] }) {
  return (
    <ul className="mini-list">
      {items.map((x) => (
        <li key={x.id}>
          <Link href={`/o/${x.id}/`}><span className="acr">{x.acronym || x.name}</span> <span className="muted">{x.name}</span></Link>
          <GradeBadge r={x} size="sm" />
        </li>
      ))}
    </ul>
  );
}

export function Crumbs({ trail }: { trail: [string, string][] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {trail.map(([name, href], i) => (
        <span key={href}>
          {i > 0 ? " / " : ""}
          {i === trail.length - 1 ? <span aria-current="page">{name}</span> : <Link href={href}>{name}</Link>}
        </span>
      ))}
    </nav>
  );
}

export function SearchForm({ id, value = "", className = "search" }: { id: string; value?: string; className?: string }) {
  return (
    <form className={className} role="search" action="/catalog/" method="get">
      <label className="sr" htmlFor={id}>Search the catalog</label>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input id={id} name="q" type="search" defaultValue={value} placeholder="Search e.g. “units of measure”, “cell types”, “provenance”, “soil”…" autoComplete="off" />
    </form>
  );
}

export function Sparkline({ points, w = 260, h = 56 }: { points: HistoryPoint[]; w?: number; h?: number }) {
  if (points.length < 2) return null;
  const xs = (i: number) => 6 + (i * (w - 12)) / (points.length - 1);
  const ys = (v: number) => h - 6 - (v / 100) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`).join("");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score over ${points.length} runs`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={p.runId} cx={xs(i).toFixed(1)} cy={ys(p.score).toFixed(1)} r={3}>
          <title>{`${fmtDate(p.at)}: ${p.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function Pager({ page, size, total, href }: { page: number; size: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  const around = [1, page - 2, page - 1, page, page + 1, page + 2, pages].filter((p, i, a) => p >= 1 && p <= pages && a.indexOf(p) === i).sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="Pages">
      {page > 1 ? <Link className="btn-ghost" href={href(page - 1)} rel="prev">← Previous</Link> : null}
      {around.map((p, i) => (
        <span key={p}>
          {i > 0 && p - around[i - 1] > 1 ? <span className="muted"> … </span> : null}
          {p === page ? <span className="pager-current" aria-current="page">{p}</span> : <Link href={href(p)}>{p}</Link>}
        </span>
      ))}
      {page < pages ? <Link className="btn-ghost" href={href(page + 1)} rel="next">Next →</Link> : null}
    </nav>
  );
}
