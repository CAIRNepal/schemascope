import type { Metadata } from "next";
import Link from "next/link";
import { Crumbs } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Report = Record<string, any>;

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  return {
    title: "Rubric validation",
    description: `How robust ${site.brand || site.name}'s scores are: sensitivity of grades to the rubric weights, agreement of our quality checks with the OBO Dashboard, and agreement with expert ratings.`,
    alternates: { canonical: "/evaluation/validation/" },
  };
}

const pc = (x?: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const n = (x?: number | null) => (x == null ? "—" : String(x));

export default async function ValidationPage() {
  const [{ site }, v] = await Promise.all([api.meta(), api.content<Report>("validation")]);
  const brand = site.brand || site.name;
  const sens = v?.sensitivity;
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Evaluation", "/evaluation/"], ["Rubric validation", "/evaluation/validation/"]]} />
        <h1>Rubric validation</h1>
        <p className="lede">How robust {brand}&rsquo;s scores are: how much they move when the weights change, how well our own quality checks agree with the OBO Dashboard, and how well scores agree with expert ratings.</p>
        {v ? (
          <p className="small muted">
            Rubric v{v.rubricVersion} · {fmtNum(v.entries)} resources · computed {fmtDate(v.generatedAt)} from the evaluation of {fmtDate(v.evaluation?.generatedAt)}. Reproduce with <code>npm run validate:rubric</code>.
          </p>
        ) : null}
      </section>
      {!v ? (
        <section className="wrap section"><p className="muted">No validation report for this catalog yet.</p></section>
      ) : (
        <>
          <section className="wrap section">
            <h2>Sensitivity to the weights</h2>
            <p className="muted">{sens.method}</p>
            <div className="stat-grid">
              <div className="stat"><b>{n(sens.spearman.mean)}</b><span>mean rank correlation with the published ranking (worst 5%: {n(sens.spearman.p05)})</span></div>
              <div className="stat"><b>{pc(sens.sameGradeShare.mean)}</b><span>of resources keep their grade on average (worst draw {pc(sens.sameGradeShare.min)})</span></div>
              <div className="stat"><b>{n(sens.meanAbsScoreChange.mean)}</b><span>points mean score change</span></div>
              <div className="stat"><b>{fmtNum(sens.borderline.count)}</b><span>borderline resources: grade changes in ≥ {Math.round(sens.borderline.threshold * 100)}% of draws</span></div>
            </div>
            <h3>One criterion at a time</h3>
            <div className="table-wrap">
              <table className="hist-table">
                <thead><tr><th>Criterion</th><th className="num">Grade changes, weight −30%</th><th className="num">+30%</th><th className="num">Criterion dropped</th><th className="num">Rank correlation if dropped</th></tr></thead>
                <tbody>
                  {sens.oneAtATime.map((x: Report) => (
                    <tr key={x.label}><td>{x.label}</td><td className="num">{fmtNum(x.minus.gradeChanges)}</td><td className="num">{fmtNum(x.plus.gradeChanges)}</td><td className="num">{fmtNum(x.dropped.gradeChanges)}</td><td className="num">{n(x.dropped.rho)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sens.borderline.examples?.length ? (
              <details>
                <summary>Most borderline resources</summary>
                <ul className="changes">
                  {sens.borderline.examples.map((x: Report) => (
                    <li key={x.id}><span><Link href={`/o/${x.id}/`}>{x.name}</Link></span><span className="muted">{x.score} ({x.grade}), grade changes in {Math.round(x.flipShare * 100)}% of draws</span></li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
          <section className="wrap section">
            <h2>Our quality checks vs the OBO Dashboard</h2>
            <p className="muted">{v.dashboardAgreement.method}</p>
            {v.dashboardAgreement.ontologies ? (
              <>
                <div className="table-wrap">
                  <table className="hist-table">
                    <thead><tr><th>Check</th><th className="num">Compared</th><th className="num">Agree</th><th className="num">Agreement</th><th>Differing (examples)</th></tr></thead>
                    <tbody>
                      {v.dashboardAgreement.checks.map((c: Report) => (
                        <tr key={c.label}>
                          <td>{c.label}</td><td className="num">{fmtNum(c.compared)}</td><td className="num">{fmtNum(c.agree)}</td><td className="num">{pc(c.rate)}</td>
                          <td>{c.differing.length ? c.differing.slice(0, 6).map((d: Report, i: number) => <span key={d.id}>{i ? ", " : ""}<Link href={`/o/${d.id}/#robot-compare`}>{d.id}</Link></span>) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {v.dashboardAgreement.robotErrors ? (
                  <p className="small muted">
                    ROBOT error counts on {fmtNum(v.dashboardAgreement.robotErrors.compared)} ontologies: ours higher for {fmtNum(v.dashboardAgreement.robotErrors.oursHigher)}, equal for {fmtNum(v.dashboardAgreement.robotErrors.equal)}, lower for {fmtNum(v.dashboardAgreement.robotErrors.oursLower)} (rank correlation {n(v.dashboardAgreement.robotErrors.spearman)}). We check the full download, which often includes imported terms.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted">No ontology has both results yet. This fills in as our quality checks run and the catalog is re-evaluated.</p>
            )}
          </section>
          <section className="wrap section">
            <h2>Agreement with expert ratings</h2>
            {v.experts.ratings ? (
              <>
                <p>{fmtNum(v.experts.ratings)} ratings of {fmtNum(v.experts.entries)} resources by {fmtNum(v.experts.raters)} rater{v.experts.raters === 1 ? "" : "s"}. Rank correlation between our score and the mean rating: <b>{n(v.experts.rho)}</b>.</p>
                <div className="table-wrap">
                  <table className="hist-table">
                    <thead><tr><th>Our grade</th><th className="num">Resources rated</th><th className="num">Mean expert rating (1–5)</th></tr></thead>
                    <tbody>{v.experts.byGrade.map((g: Report) => <tr key={g.grade}><td>{g.grade}</td><td className="num">{fmtNum(g.n)}</td><td className="num">{n(g.meanRating)}</td></tr>)}</tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="muted">No expert ratings yet. Ratings (1–5 per resource) go in <code>{v.experts.file}</code>; the comparison appears here once at least five resources are rated. Would you like to rate resources in your field? <Link href="/contact/">Get in touch</Link>.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
