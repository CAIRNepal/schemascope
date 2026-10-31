import type { Metadata } from "next";
import { Crumbs } from "@/components/ui";
import { PUBLIC_API_URL, api } from "@/lib/api";
import { fmtDateTime, fmtNum } from "@/lib/format";

export const metadata: Metadata = { title: "Evaluation", description: "How resources are scored: the rubric, penalties, grades and every evaluation run.", alternates: { canonical: "/evaluation/" } };

export default async function EvaluationPage() {
  const [{ rubric, evaluation }, runs, stats] = await Promise.all([api.meta(), api.runs(100), api.stats()]);
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Evaluation", "/evaluation/"]]} />
        <h1>How scores work</h1>
        <p className="lede">
          Every resource is scored out of 100 by an automated evaluation{rubric ? ` (rubric v${rubric.version})` : ""}. {fmtNum(stats.evaluated)} of {fmtNum(stats.entries)} resources are evaluated; the average score is {stats.averageScore ?? "—"}.
        </p>
      </section>
      {rubric ? (
        <section className="wrap section" id="formula">
          <div className="section-head"><h2>Criteria</h2><span className="muted">FAIR subtotal out of {rubric.fairMax}</span></div>
          <div className="table-wrap">
            <table className="hist-table">
              <thead><tr><th></th><th>Criterion</th><th className="num">Max</th><th>Formula</th></tr></thead>
              <tbody>
                {rubric.rubric.map((r) => (
                  <tr key={r.key}>
                    <td><b className="sym">{r.symbol}</b></td>
                    <td>{r.label}{r.fair ? <> <span className="fair-tag">FAIR</span></> : null}<p className="small muted">{r.how}</p></td>
                    <td className="num">{r.max}</td>
                    <td><code>{r.formula}</code></td>
                  </tr>
                ))}
                <tr>
                  <td><b className="sym">P</b></td>
                  <td>{rubric.penalty.label}<p className="small muted">{rubric.penalty.how}</p></td>
                  <td className="num">—</td>
                  <td><code>{rubric.penalty.formula}</code></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">Grades: {rubric.grades.map((g) => `${g.grade} ≥ ${g.min}`).join(" · ")}. Grade counts: {Object.entries(stats.grades).sort().map(([g, n]) => `${g === "none" ? "not evaluated" : g} ${fmtNum(n)}`).join(" · ")}.</p>
        </section>
      ) : null}
      <section className="wrap section" id="runs">
        <div className="section-head"><h2>Run history</h2><a href={`${PUBLIC_API_URL}/api/runs`}>/api/runs</a></div>
        <div className="table-wrap">
          <table className="hist-table">
            <thead><tr><th>Run</th><th>Finished</th><th className="num">Entries</th><th>Rubric</th><th>Data</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.id}</code>{evaluation?.run?.id === r.id ? <span className="muted"> · latest</span> : null}</td>
                  <td>{fmtDateTime(r.finishedAt)}</td>
                  <td className="num">{fmtNum(r.entryCount)}</td>
                  <td>v{r.evaluator?.rubricVersion ?? "?"}</td>
                  <td><a href={`${PUBLIC_API_URL}/api/runs/${encodeURIComponent(r.id)}`}>JSON</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
