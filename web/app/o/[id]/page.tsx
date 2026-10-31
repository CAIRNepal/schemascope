import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { MetricsAcrossRuns } from "@/components/history";
import { Crumbs, ExtIcon, GradeBadge, MiniList, Sparkline } from "@/components/ui";
import { NotFound, PUBLIC_API_URL, api, type EntryDetail, type Facts, type Ref, type Rubric } from "@/lib/api";
import { KIND_LABEL, LICENSE_URLS, fmtDate, fmtDateTime, fmtNum, host, truncate } from "@/lib/format";

type P = { params: Promise<{ id: string }> };

async function load(id: string): Promise<EntryDetail> {
  try {
    return await api.entry(id);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const [d, { site }] = await Promise.all([load((await params).id), api.meta()]);
  const e = d.entry, s = d.summary;
  const title = `${e.acronym && e.acronym !== e.name ? `${e.acronym} – ` : ""}${e.name}`;
  const desc = `${e.description}${s.score != null ? ` ${site.brand || site.name} score ${s.score}/100 (grade ${s.grade}, FAIR ${s.fair})${s.version ? `, version ${s.version}` : ""}.` : ""}`;
  return { title, description: truncate(desc, 300), alternates: { canonical: `/o/${e.id}/` } };
}

const LinkRow = ({ label, url, sub }: { label: string; url?: string; sub?: string }) =>
  url ? (
    <a className="link-btn" href={url} rel="noopener">
      <span className="lb-t">{label}<ExtIcon /></span>
      <small>{sub || host(url)}</small>
    </a>
  ) : null;

const ok = (x: Facts | undefined | null) => (x && !x.error ? x : null);
const yesNo = (x: unknown) => (x == null ? "—" : x === true ? "yes" : x === false ? "no" : fmtNum(x as number));

function RefChips({ refs }: { refs: Ref[] }) {
  return (
    <>
      {refs.map((r) =>
        r.entryId ? (
          <span key={r.key}><Link className="chip chip-link" href={`/o/${r.entryId}/`}>{r.label}</Link> </span>
        ) : (
          <span key={r.key}><a className="chip" href={r.url} rel="noopener nofollow">{r.label}</a> </span>
        ),
      )}
    </>
  );
}

const MAP_URL: Record<string, (v: string) => string> = {
  bioportal: (v) => `https://bioportal.bioontology.org/ontologies/${v}`,
  ols: (v) => `https://www.ebi.ac.uk/ols4/ontologies/${v}`,
  "tib.ts": (v) => `https://terminology.tib.eu/ts/ontologies/${v}`,
  fairsharing: (v) => `https://fairsharing.org/${v}`,
  "wikidata.entity": (v) => `https://www.wikidata.org/wiki/${v}`,
  obofoundry: (v) => `https://obofoundry.org/ontology/${String(v).toLowerCase()}.html`,
  ontobee: (v) => `https://ontobee.org/ontology/${v}`,
  aberowl: (v) => `http://aber-owl.net/ontology/${v}/`,
  agroportal: (v) => `https://agroportal.lirmm.fr/ontologies/${v}`,
  biodivportal: (v) => `https://biodivportal.gfbio.org/ontologies/${v}`,
};

function PortalsPanel({ d }: { d: EntryDetail }) {
  const r = d.facts;
  if (!r) return null;
  const rows: ReactNode[] = [];
  for (const p of [r.ols, r.tib]) {
    if (!ok(p)) continue;
    rows.push(
      <tr key={p.portal}>
        <td><a href={p.page} rel="noopener">{p.portal}</a></td><td><code>{p.id}</code></td><td>{p.version || "—"}</td>
        <td className="num">{fmtNum(p.terms)}</td><td className="num">{fmtNum(p.properties)}</td><td className="num">{fmtNum(p.individuals)}</td><td>{fmtDate(p.loaded)}</td>
      </tr>,
    );
  }
  const bp = ok(r.bioportal);
  if (bp)
    rows.push(
      <tr key="bioportal">
        <td><a href={bp.page} rel="noopener">BioPortal</a></td><td><code>{bp.acronym}</code></td><td>{bp.version || "—"}</td>
        <td className="num">{fmtNum(bp.terms)}</td><td className="num">{fmtNum(bp.properties)}</td><td className="num">{fmtNum(bp.individuals)}</td><td>{fmtDate(bp.released)}</td>
      </tr>,
    );
  const dash = ok(r.dashboard);
  if (dash)
    rows.push(
      <tr key="dashboard">
        <td><a href={dash.page} rel="noopener">OBO Dashboard</a></td><td><code>{dash.ns}</code></td><td>{(String(dash.checkedVersion || "").match(/\d{4}-\d{2}-\d{2}/) || ["—"])[0]}</td>
        <td className="num">{fmtNum(dash.classes)}</td><td className="num">—</td><td className="num">—</td><td>{fmtDate(dash.checkedAt)}</td>
      </tr>,
    );
  const br = ok(r.bioregistry);
  const mappings = br ? Object.entries(br.mappings || {}).filter(([k]) => MAP_URL[k]) : [];
  const langs: string[] | null = r.ols?.languages?.length ? r.ols.languages : null;
  const q = r.quality;
  const oops = ok(r.oops);
  if (!rows.length && !mappings.length && !d.imports.length && !d.reusedBy.length) return null;
  return (
    <div className="panel" id="portals">
      <h2>Portals &amp; registries</h2>
      {rows.length ? (
        <div className="table-wrap">
          <table className="portal-table">
            <thead><tr><th>Source</th><th>ID</th><th>Version</th><th className="num">Classes</th><th className="num">Properties</th><th className="num">Individuals</th><th>Loaded</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      ) : null}
      {r.ols?.iri ? (
        <p className="small"><span className="muted">Ontology IRI</span> <code>{r.ols.iri}</code>{r.ols.versionIri ? <><br /><span className="muted">Version IRI</span> <code>{r.ols.versionIri}</code></> : null}</p>
      ) : null}
      {langs ? <p className="small"><span className="muted">Languages</span> {langs.map((l) => <span className="chip" key={l}>{l}</span>)}</p> : null}
      {d.imports.length ? <p className="small"><span className="muted">Imports from ({d.imports.length})</span><br /><RefChips refs={d.imports} /></p> : null}
      {d.reusedBy.length ? <p className="small"><span className="muted">Reused by ({d.reusedBy.length})</span><br /><RefChips refs={d.reusedBy} /></p> : null}
      {dash ? (
        <dl className="facts compact quality-facts">
          <div><dt>Logical consistency</dt><dd>{dash.consistent === true ? "consistent" : dash.consistent === false ? "INCONSISTENT" : "—"}{dash.unsatisfiable != null ? ` · ${fmtNum(dash.unsatisfiable)} unsatisfiable` : ""}</dd></div>
          <div><dt>OWL 2 DL</dt><dd>{yesNo(dash.owl2dl)}</dd></div>
          <div><dt>ROBOT report</dt><dd>{dash.robot ? `${fmtNum(dash.robot.ERROR)} errors · ${fmtNum(dash.robot.WARN)} warnings · ${fmtNum(dash.robot.INFO)} info` : "—"}</dd></div>
          <div>
            <dt>OBO principles</dt>
            <dd>
              {dash.checks
                ? Object.entries(dash.checks as Record<string, string>).filter(([k]) => /^FP/.test(k)).map(([k, v]) => (
                    <span key={k}><span className={`fp fp-${String(v).toLowerCase()}`} title={`${k}: ${v}`}>{k.split(" ")[0]}</span> </span>
                  ))
                : "—"}
            </dd>
          </div>
          {dash.axioms ? <div><dt>Axioms</dt><dd>{fmtNum(dash.axioms)}{dash.reusedPct != null ? ` · ${dash.reusedPct}% entities reused` : ""}</dd></div> : null}
        </dl>
      ) : q ? (
        <dl className="facts compact quality-facts">
          <div><dt>Logical consistency (ROBOT {q.reasoner || "ELK"})</dt><dd>{q.consistent === true ? "consistent" : q.consistent === false ? "INCONSISTENT" : "—"}{q.unsatisfiable != null ? ` · ${fmtNum(q.unsatisfiable)} unsatisfiable` : ""}</dd></div>
          {q.robot ? <div><dt>ROBOT report</dt><dd>{fmtNum(q.robot.ERROR)} errors · {fmtNum(q.robot.WARN)} warnings</dd></div> : null}
        </dl>
      ) : null}
      {oops ? <p className="small">OOPS!: {oops.critical} critical · {oops.important} important · {oops.minor} minor pitfall types{oops.stale ? <> <span className="pill-stale">carried forward</span></> : null}</p> : null}
      {mappings.length ? (
        <p className="small">
          <span className="muted">Also registered as</span><br />
          {mappings.map(([k, v]) => <span key={k}><a className="chip chip-link" href={MAP_URL[k](String(v))} rel="noopener nofollow">{k}: {String(v)}</a> </span>)}
        </p>
      ) : null}
    </div>
  );
}

function RobotCompare({ r, brand }: { r: Facts | null; brand: string }) {
  const c = r?.dashboardComparison;
  if (!c?.rows?.length) return null;
  const file = (u?: string) => (u ? <code>{String(u).split("/").pop()}</code> : "—");
  return (
    <div className="panel" id="robot-compare">
      <h2>Our checks vs the OBO Dashboard</h2>
      <p className="small muted">
        {c.differences.length ? `${c.differences.length} of ${c.rows.length} checks differ: ${c.differences.join(", ")}.` : `All ${c.rows.length} checks agree.`} Scores use {brand}&rsquo;s own ROBOT run; the Dashboard is shown for comparison. The two may check different files (the Dashboard usually checks the <code>-base</code> release), which alone can change warning counts.
      </p>
      <div className="table-wrap">
        <table className="portal-table">
          <thead><tr><th>Check</th><th>{brand} (ROBOT + ELK)</th><th><a href={c.dashboard.page || "https://dashboard.obofoundry.org/"} rel="noopener">OBO Dashboard</a></th><th></th></tr></thead>
          <tbody>
            {c.rows.map((x: Facts) => (
              <tr key={x.check}><td>{x.check}</td><td>{yesNo(x.ours)}</td><td>{yesNo(x.dashboard)}</td><td>{x.differs ? <b>differs</b> : x.ours != null && x.dashboard != null ? "same" : ""}</td></tr>
            ))}
            <tr><td className="muted">File checked</td><td>{file(c.ours.artefact)}</td><td>{file(c.dashboard.artefact)}</td><td></td></tr>
            <tr><td className="muted">Checked on</td><td>{fmtDate(c.ours.checkedAt)}</td><td>{fmtDate(c.dashboard.checkedAt)}</td><td></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Breakdown({ r, rubric }: { r: Facts; rubric: Rubric | null }) {
  const items = rubric?.rubric || Object.keys(r.breakdown || {}).map((key) => ({ key, symbol: key[0].toUpperCase(), label: key, fair: false, max: r.breakdown[key].max }));
  return (
    <div className="breakdown">
      {items.map((rb) => {
        const b = r.breakdown?.[rb.key];
        if (!b) return null;
        const na = b.applicable === false;
        const pct = na ? 0 : Math.max(0, Math.round((b.score / b.max) * 100));
        return (
          <div key={rb.key} className={`bd-row${na ? " is-na" : ""}`}>
            <div className="bd-label">
              <span><b className="sym">{rb.symbol}</b> {rb.label}{rb.fair ? <> <span className="fair-tag">FAIR</span></> : null}</span>
              <span className="bd-num">{na ? "n/a" : <>{b.score}<small>/{b.max}</small></>}</span>
            </div>
            <div className={`bar${rb.fair ? " bar-fair" : ""}`} role="img" aria-label={`${rb.label}: ${b.score} of ${b.max}`}><span style={{ width: `${pct}%` }} /></div>
            <ul className="bd-steps">
              {(b.steps || []).map((s: Facts, i: number) => (
                <li key={i} className={s.notAssessed ? "na" : undefined}>
                  <span>{s.label}</span><span className="muted">{s.detail}</span>
                  <b>{s.notAssessed ? <>n/a<span className="muted"> ({s.outOf})</span></> : `${s.pts > 0 ? "+" : ""}${s.pts}`}</b>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function provenanceRows(r: Facts, brand: string) {
  const rows: { what: string; src?: string; at?: string; stale?: Facts }[] = [];
  for (const [k, l] of Object.entries((r.links || {}) as Record<string, Facts | null>)) if (l) rows.push({ what: `${k[0].toUpperCase() + k.slice(1)} link check (HTTP ${l.code || l.error})`, src: l.url, at: l.checkedAt });
  if (ok(r.artifact)) rows.push({ what: `Artefact header${r.artifact.versionIri ? " (version IRI)" : r.artifact.versionInfo ? " (version info)" : ""}`, src: r.artifact.source, at: r.artifact.fetchedAt, stale: r.artifact });
  if (ok(r.git)) rows.push({ what: `Git refs (commit ${String(r.git.commit).slice(0, 7)}${r.git.latestTag ? `, latest tag ${r.git.latestTag.name}` : ""})`, src: r.git.url, at: r.git.fetchedAt, stale: r.git });
  if (ok(r.github)) rows.push({ what: "GitHub repository statistics", src: r.github.source, at: r.github.fetchedAt, stale: r.github });
  if (ok(r.ols)) rows.push({ what: "OLS classes, imports, version & release", src: r.ols.source, at: r.ols.fetchedAt, stale: r.ols });
  if (ok(r.obo)) rows.push({ what: "OBO Foundry status, license & usages", src: r.obo.source, at: r.obo.fetchedAt, stale: r.obo });
  if (ok(r.tib)) rows.push({ what: "TIB Terminology Service metrics", src: r.tib.source, at: r.tib.fetchedAt, stale: r.tib });
  if (ok(r.bioregistry)) rows.push({ what: "Bioregistry mappings, dependencies & reuse", src: r.bioregistry.source, at: r.bioregistry.fetchedAt, stale: r.bioregistry });
  if (ok(r.dashboard)) rows.push({ what: `OBO Dashboard (checked ${fmtDate(r.dashboard.checkedAt)})`, src: r.dashboard.page, at: r.dashboard.fetchedAt, stale: r.dashboard });
  if (r.quality) rows.push({ what: `ROBOT reason/report run by ${brand}`, at: r.quality.checkedAt, stale: r.quality });
  if (ok(r.oops)) rows.push({ what: "OOPS! pitfall scan", src: "https://oops.linkeddata.es", at: r.oops.checkedAt, stale: r.oops });
  if (ok(r.bioportal)) rows.push({ what: "BioPortal release", src: r.bioportal.source, at: r.bioportal.fetchedAt, stale: r.bioportal });
  for (const c of r.citations || []) if (c.count != null) rows.push({ what: `Crossref citations (doi:${c.doi})`, src: c.source, at: c.fetchedAt, stale: c });
  return rows;
}

export default async function EntryPage({ params }: P) {
  const { id } = await params;
  const [d, { site, rubric, evaluation }] = await Promise.all([load(id), api.meta()]);
  const brand = site.brand || site.name;
  const { entry: e, facts: r, summary: s, category: cat } = d;
  const h = d.history;
  const browse: [string, string, string][] = [
    e.ols && (!r || r.ols?.terms) ? ["OLS", `https://www.ebi.ac.uk/ols4/ontologies/${e.ols}`, "EMBL-EBI Ontology Lookup Service"] : null,
    e.bioportal ? ["BioPortal", `https://bioportal.bioontology.org/ontologies/${e.bioportal}`, "NCBO BioPortal"] : null,
    e.obo ? ["OBO Foundry", `https://obofoundry.org/ontology/${e.obo}.html`, "OBO Foundry registry"] : null,
  ].filter((x): x is [string, string, string] => Boolean(x));
  const lic = d.license;
  const facts: [string, ReactNode][] = (
    [
      ["Type", KIND_LABEL[e.kind] || e.kind],
      ["Primary domain", <Link key="c" href={`/category/${cat.id}/`}>{cat.name}</Link>],
      d.domains.length ? ["Also used in", <span key="d">{d.domains.map((x) => <span key={x.id}><Link className="chip chip-link" href={`/category/${x.id}/`}>{x.name}</Link> </span>)}</span>] : null,
      ["Status", e.status === "legacy" ? "Legacy" : r?.obo?.status ? `${r.obo.status[0].toUpperCase()}${r.obo.status.slice(1)} (OBO Foundry)` : "Active"],
      ["Version evaluated", s.version],
      ["Maintainer", e.maintainer],
      [
        "License",
        lic ? (
          <span key="l">
            {LICENSE_URLS[lic] ? <a href={LICENSE_URLS[lic]} rel="license noopener">{lic}</a> : lic}
            {!e.license ? <span className="muted">{r?.obo?.license ? " (OBO Foundry)" : " (detected by GitHub)"}</span> : null}
          </span>
        ) : "Not stated — check the source",
      ],
      ["Formats", (e.formats || []).join(", ")],
      ["Species", (e.species || []).join(", ")],
      r?.ols?.terms ? ["Terms (OLS)", fmtNum(r.ols.terms)] : null,
      r?.lastActivity ? ["Last activity", fmtDate(r.lastActivity)] : null,
      ok(r?.github) ? ["GitHub", `★ ${fmtNum(r!.github.stars)} · ${fmtNum(r!.github.forks)} forks · ${fmtNum(r!.github.openIssues)} open issues${r!.github.archived ? " · archived" : ""}`] : null,
      r?.git?.latestTag ? ["Latest release tag", <a key="t" href={r.git.latestTag.url} rel="noopener">{r.git.latestTag.name}</a>] : null,
    ] as ([string, ReactNode] | null)[]
  ).filter((x): x is [string, ReactNode] => Boolean(x && x[1]));
  const linkHealth = r ? Object.entries((r.links || {}) as Record<string, Facts | null>).filter(([, l]) => l) : [];
  const v = r?.evaluatedVersion;
  const p = e.provenance;
  const jsonUrl = `${PUBLIC_API_URL}/api/entries/${encodeURIComponent(e.id)}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${site.url}/o/${e.id}/#dataset`,
    name: e.name,
    alternateName: e.acronym || undefined,
    description: e.description,
    url: `${site.url}/o/${e.id}/`,
    license: lic && LICENSE_URLS[lic] ? LICENSE_URLS[lic] : undefined,
    keywords: e.tags,
    version: s.version || undefined,
    encodingFormat: e.formats,
    sameAs: [e.homepage, e.repository].filter(Boolean),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} />
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], [cat.name, `/category/${cat.id}/`], [e.acronym || e.name, `/o/${e.id}/`]]} />
        <div className="entry-head">
          <div>
            <p className="eyebrow">{KIND_LABEL[e.kind] || e.kind}{e.status === "legacy" ? " · Legacy" : ""}</p>
            <h1>{e.acronym || e.name}</h1>
            {e.acronym && e.acronym !== e.name ? <p className="subtitle">{e.name}</p> : null}
            <p className="lede">{e.description}</p>
            <div className="tags">{(e.tags || []).map((t: string) => <span className="chip" key={t}>{t}</span>)}</div>
          </div>
          <div className="score-card">
            <GradeBadge r={s} size="lg" />
            {r ? <p className="fair-line"><span className="fair-tag">FAIR</span> <b>{r.fair}</b>/{rubric?.fairMax ?? "—"}</p> : null}
            {r?.qualityPartial ? <p className="small q-partial-note">* Q partially assessed: {r.qualityNotAssessed} of 20 points could not be checked and are left out of the total.</p> : null}
            {s.version ? <p className="muted small">Version {truncate(s.version, 28)}</p> : null}
            <p className="muted small">{r ? `Evaluated ${fmtDate(r.evaluatedAt || evaluation?.generatedAt)}` : "Not evaluated"}</p>
            <Link className="small" href="/evaluation/#formula">How scores work</Link>
          </div>
        </div>
      </section>

      <section className="wrap section entry-grid">
        <div className="entry-main">
          <div className="panel">
            <h2>Source &amp; access</h2>
            <div className="link-grid">
              <LinkRow label="Homepage" url={e.homepage} />
              {e.repository && e.repository !== e.homepage ? <LinkRow label="Repository" url={e.repository} /> : null}
              <LinkRow label="Download" url={e.download} sub="Canonical file / PURL" />
              {browse.map(([l, u, sub]) => <LinkRow key={l} label={`Browse in ${l}`} url={u} sub={sub} />)}
            </div>
            {linkHealth.length ? (
              <ul className="link-health" aria-label="Link health">
                {linkHealth.map(([k, l]) => (
                  <li key={k}>
                    <span className={`dot dot-${l!.state}`} title={`${{ ok: "Reachable", blocked: "Reachable (refused automated check)", dead: "Unreachable" }[l!.state as string] ?? l!.state} — HTTP ${l!.code || l!.error}`} />
                    <span className="lh-k">{k}</span> <a href={l!.url} rel="noopener">{host(l!.url)}</a> <span className="muted">HTTP {l!.code || l!.error}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <PortalsPanel d={d} />
          <RobotCompare r={r} brand={brand} />

          {e.modules?.length ? (
            <div className="panel">
              <h2>Schemas &amp; modules <span className="count">{e.modules.length}</span></h2>
              <ul className="modules">{e.modules.map((m: Facts) => <li key={m.url}><a href={m.url} rel="noopener">{m.name}<ExtIcon /></a><span className="muted">{m.note || ""}</span></li>)}</ul>
            </div>
          ) : null}

          <div className="panel" id="evaluation">
            <h2>Automated evaluation</h2>
            {r ? <Breakdown r={r} rubric={rubric} /> : <p className="muted">Not evaluated yet.</p>}
            {r?.penalty ? (
              <div className={`bd-row bd-penalty${r.penalty.score ? " is-hit" : ""}`}>
                <div className="bd-label"><span><b className="sym">P</b> {rubric?.penalty.label ?? "Penalties"}</span><span className="bd-num">{r.penalty.score}</span></div>
                <ul className="bd-steps">
                  {(r.penalty.steps || [{ label: "Activity status", detail: r.penalty.reason, pts: r.penalty.score }]).map((st: Facts, i: number) => (
                    <li key={i}><span>{st.label}</span><span className="muted">{st.detail}</span><b>{st.pts || 0}</b></li>
                  ))}
                </ul>
              </div>
            ) : null}
            {r ? (
              <p className="bd-total">
                FAIR subtotal <b>{r.fair}</b>/{rubric?.fairMax ?? "—"} · earned {r.earned ?? r.gross}/{r.possible ?? 100}
                {(r.possible ?? 100) !== 100 ? ` → scaled ${r.gross}` : ""}{r.penalty?.score ? ` − ${-r.penalty.score} inactivity` : ""} = <b>{r.score}</b>/100 → grade <b>{r.grade}</b>
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h2>Community adoption <span className="count">{d.adopters.length}</span></h2>
            {d.adopters.length ? (
              <ul className="adopters">
                {d.adopters.map((u) => (
                  <li key={u.url}>
                    <a href={u.url} rel="noopener">{u.name}</a>
                    {u.note ? <p>{truncate(u.note, 240)}</p> : null}
                    <span className="src">{u.source === "curated" ? `Curated by ${brand}` : `Source: ${u.source}`}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No adopting projects documented yet.</p>}
            <p className="small muted">Know a project that uses {e.acronym || e.name}? <a href={`/submit/?update=${encodeURIComponent(e.id)}`}>Suggest it</a>.</p>
          </div>

          {e.tools?.length ? (
            <div className="panel">
              <h2>Tooling</h2>
              <ul className="modules">{e.tools.map((t: Facts) => <li key={t.url}><a href={t.url} rel="noopener">{t.name}<ExtIcon /></a><span className="muted">{t.note || ""}</span></li>)}</ul>
            </div>
          ) : null}

          <div className="panel" id="history">
            <h2>History &amp; changes <span className="count">{h.length} run{h.length === 1 ? "" : "s"}</span></h2>
            {h.length >= 2 ? <div className="spark-wrap"><Sparkline points={h} /><span className="muted small">Score over time</span></div> : null}
            <MetricsAcrossRuns history={h} apiBase={PUBLIC_API_URL} />
            {d.changes.length ? (
              <ul className="changes">{d.changes.slice(0, 20).map((c, i) => <li key={i}><time dateTime={c.at}>{fmtDate(c.at)}</time><span>{c.what}</span></li>)}</ul>
            ) : (
              <p className="muted small">{h.length < 2 ? "History starts with the first archived run; changes appear after the next evaluation." : "No changes detected between runs."}</p>
            )}
            {h.length ? (
              <div className="table-wrap">
                <table className="hist-table">
                  <thead><tr><th>Run</th><th className="num">Score</th><th className="num">FAIR</th><th>Version evaluated</th><th className="num">Terms</th><th>Snapshot</th></tr></thead>
                  <tbody>
                    {[...h].reverse().slice(0, 10).map((pt) => (
                      <tr key={pt.runId}>
                        <td>{fmtDateTime(pt.at)}</td><td className="num">{pt.score} <span className="muted">{pt.grade}</span></td><td className="num">{pt.fair ?? "—"}</td>
                        <td>{pt.version ?? "—"}</td><td className="num">{fmtNum(pt.terms)}</td><td><a href={`${PUBLIC_API_URL}/api/runs/${encodeURIComponent(pt.runId)}`}>JSON</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          {r ? (
            <div className="panel" id="provenance">
              <h2>Provenance</h2>
              <p className="small muted">Every fact on this page was fetched automatically. Each row shows where it came from and when. If a source fails, the last good value is kept and marked “carried forward”.</p>
              <div className="table-wrap">
                <table className="prov-table">
                  <thead><tr><th>Fact</th><th>Source</th><th>Retrieved</th></tr></thead>
                  <tbody>
                    {provenanceRows(r, brand).map((row, i) => (
                      <tr key={i}>
                        <td>{row.what}</td>
                        <td>{row.src ? <a href={row.src} rel="noopener nofollow">{host(row.src)}</a> : "—"}</td>
                        <td>{fmtDateTime(row.at)}{row.stale?.stale ? <> <span className="pill-stale" title={`Last attempt ${fmtDateTime(row.stale.lastAttemptAt)} failed: ${row.stale.staleReason}`}>carried forward</span></> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">
                Run <code>{r.runId || evaluation?.run?.id || "—"}</code> · evaluator v{evaluation?.run?.evaluator?.version || "—"} · rubric v{evaluation?.rubricVersion} · <a href={jsonUrl}>JSON</a>
              </p>
            </div>
          ) : null}

          {e.publications?.length ? (
            <div className="panel">
              <h2>How to cite</h2>
              <ul className="pubs">
                {e.publications.map((pub: Facts) => {
                  const c = r?.citations?.find((x: Facts) => x.doi === pub.doi)?.count;
                  return (
                    <li key={pub.doi}>
                      <a href={`https://doi.org/${pub.doi}`} rel="noopener">{pub.title}</a>{" "}
                      <span className="muted">({pub.year}) · doi:{pub.doi}{c != null ? <> · <b>{fmtNum(c)}</b> citations</> : null}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>

        <aside className="entry-side">
          <div className="panel version">
            <h2>Version evaluated</h2>
            {v ? (
              <>
                <p className="ver-big">{v.label}</p>
                <p className="small muted">Detected from: {v.from} · evaluated {fmtDateTime(r?.evaluatedAt)}</p>
                <dl className="facts compact">
                  {(v.all || []).map((c: Facts, i: number) => (
                    <div key={i}><dt>{c.from}</dt><dd>{/^https?:\/\//.test(c.value || "") ? <a href={c.value} rel="noopener">{c.value}</a> : c.value}</dd></div>
                  ))}
                  {r?.artifact?.etag ? <div><dt>Artefact ETag</dt><dd><code>{r.artifact.etag}</code></dd></div> : null}
                </dl>
              </>
            ) : (
              <p className="muted small">No version information could be detected for this resource: it has no machine-readable artefact, release tag or registry entry to read a version from.</p>
            )}
          </div>
          {p ? (
            <div className="panel recprov">
              <h2>Record source</h2>
              <p className="small"><b>{p.source === "curated" ? `Curated by ${brand}` : p.source}</b>{p.page || p.url ? <> · <a href={p.page || p.url} rel="noopener">{host(p.page || p.url)}</a></> : null}</p>
              <p className="small muted">{p.source === "curated" ? "Curated" : "Retrieved"} {fmtDateTime(p.retrievedAt || p.curatedAt)}{p.curatedBy ? ` by ${p.curatedBy}` : ""}</p>
              {p.fields?.length ? <p className="small"><span className="muted">Fields from {p.source}:</span> {p.fields.map((f: string) => <code key={f}>{f} </code>)}</p> : null}
              {p.note ? <p className="small muted">{p.note}</p> : null}
            </div>
          ) : null}
          <div className="panel">
            <h2>At a glance</h2>
            <dl className="facts">{facts.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
          </div>
          <div className="panel">
            <h2>Machine-readable</h2>
            <p className="small"><a href={jsonUrl}><code>/api/entries/{e.id}</code></a></p>
            <p className="small muted">Catalog record, evaluation, history and changes for this resource. Also available to AI agents over <Link href="/api-docs/">MCP</Link>.</p>
            <p className="small"><a href={`/submit/?update=${encodeURIComponent(e.id)}`}>Suggest a correction</a></p>
          </div>
          {d.related.length ? <div className="panel"><h2>Related</h2><MiniList items={d.related} /></div> : null}
        </aside>
      </section>
    </>
  );
}
