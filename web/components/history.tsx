import type { HistoryPoint } from "@/lib/api";
import { CRIT_LABELS, METRIC_LABELS, fmtDate, fmtMetric } from "@/lib/format";

// Fewer is better for these.
const LOWER_BETTER = new Set(["m-unsatisfiable", "m-robotErrors", "m-robotWarnings", "m-criticalPitfalls"]);

// One column per run (newest first), a row per criterion and quality metric; cells that changed since the run before are marked.
export function MetricsAcrossRuns({ history, apiBase, max = 8 }: { history: HistoryPoint[]; apiBase: string; max?: number }) {
  const runs = [...history].reverse().slice(0, max);
  if (runs.length < 2) return null;
  const anyChange = runs.some((p, i) => i && JSON.stringify([p.crit, p.metrics]) !== JSON.stringify([runs[i - 1].crit, runs[i - 1].metrics]));

  const row = (key: string, label: string, get: (p: HistoryPoint) => unknown) => {
    const vals = runs.map(get);
    if (vals.every((v) => v == null)) return null;
    return (
      <tr key={key}>
        <th scope="row">{label}</th>
        {vals.map((v, i) => {
          const older = vals[i + 1];
          const changed = older != null && v != null && older !== v;
          // "up" = better, "down" = worse; yes/no changes are marked by value.
          const better = typeof v === "number" && typeof older === "number" ? v > older !== LOWER_BETTER.has(key) : typeof v === "boolean" ? v : null;
          const dir = better == null ? "" : better ? " up" : " down";
          return (
            <td key={i} className={`num${changed ? ` changed${dir}` : ""}`} title={changed ? `was ${fmtMetric(older)}` : undefined}>
              {fmtMetric(v)}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <details className="metrics-runs" open={anyChange}>
      <summary>Metrics across runs</summary>
      <div className="table-wrap">
        <table className="hist-table metrics-table">
          <thead>
            <tr>
              <th></th>
              {runs.map((p) => (
                <th key={p.runId} className="num">
                  <a href={`${apiBase}/api/runs/${encodeURIComponent(p.runId)}`}>{fmtDate(p.at)}</a>
                  <br />
                  <span className="muted">rubric v{p.rubric || "?"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("score", "Score", (p) => p.score)}
            {CRIT_LABELS.map(([k, label]) => row(k, label, (p) => p.crit?.[k] ?? null))}
            {row("penalty", "Penalty", (p) => p.penalty)}
            {METRIC_LABELS.map(([k, label]) => row(`m-${k}`, label, (p) => p.metrics?.[k] ?? null))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Newest run first. Highlighted cells changed since the run before; hover to see the earlier value. A rubric change alone can move points.</p>
    </details>
  );
}
