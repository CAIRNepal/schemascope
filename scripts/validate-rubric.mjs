#!/usr/bin/env node
// Validate the rubric from stored facts (no network), and write data/validation/report.json for the site.
//   1. Weight sensitivity: how much scores, rankings and grades move when criterion weights change.
//   2. Agreement with the OBO Dashboard: our ROBOT results vs the Dashboard's, check by check.
//   3. Expert ratings (optional): data/validation/expert-ratings.csv, columns id,rater,overall[,notes],
//      overall on a 1–5 scale; reports how well our scores agree with the raters.
//   npm run validate:rubric            DRAWS=1000 (random weightings), SPREAD=0.3 (±30%)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUBRIC, RUBRIC_VERSION, GRADES, PENALTY, scoreEntry } from "./rubric.mjs";
import { root, outData, trackedData } from "./paths.mjs";

const DRAWS = Number(process.env.DRAWS || 1000);
const SPREAD = Number(process.env.SPREAD || 0.3);
const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const evFile = [path.join(outData, "evaluation.json"), path.join(trackedData, "evaluation.json")]
  .filter(existsSync)
  .map((f) => ({ f, ev: JSON.parse(readFileSync(f, "utf8")) }))
  .sort((a, b) => String(b.ev.generatedAt).localeCompare(String(a.ev.generatedAt)))[0];
if (!evFile) throw new Error("No evaluation data found; run npm run evaluate first.");

// Score every entry with the current rubric from its stored facts.
const rows = [];
for (const e of catalog) {
  const f = evFile.ev.entries[e.id];
  if (!f) continue;
  const r = scoreEntry(e, structuredClone(f));
  rows.push({ id: e.id, name: e.name, obo: !!(e.obo || (f.dashboard && !f.dashboard.error)), r, facts: f });
}
const KEYS = RUBRIC.map((x) => x.key);
const gradeOf = (score) => GRADES.find((g) => score >= g.min).grade;

// Recompute a score with criterion weights w (w = 1 everywhere reproduces the rubric's score).
function weighted({ r }, w) {
  let earned = 0, possible = 0;
  for (const k of KEYS) {
    if (k === "quality" && !r.qualityApplies) continue;
    earned += w[k] * r.breakdown[k].score;
    possible += w[k] * r.breakdown[k].max;
  }
  let score = Math.max(0, Math.round((earned * 100) / (possible || 1)) + (r.penalty?.score || 0));
  if (r.qualityApplies && r.consistent === false) score = Math.min(score, PENALTY.inconsistentCap);
  return score;
}

// Spearman rank correlation, with tied values given their average rank.
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}
// A small seeded generator, so the report is the same every time for the same data.
let seed = 20261027;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

// 1. Sensitivity
const ones = Object.fromEntries(KEYS.map((k) => [k, 1]));
const base = rows.map((x) => weighted(x, ones));
const mismatches = rows.filter((x, i) => base[i] !== x.r.score).length; // should be 0: the reweighting reproduces the rubric
const baseGrades = base.map(gradeOf);
const draws = [];
for (let d = 0; d < DRAWS; d++) {
  const w = Object.fromEntries(KEYS.map((k) => [k, 1 - SPREAD + 2 * SPREAD * rand()]));
  const s = rows.map((x) => weighted(x, w));
  draws.push({ rho: spearman(base, s), sameGrade: s.filter((v, i) => gradeOf(v) === baseGrades[i]).length / rows.length, meanAbs: s.reduce((t, v, i) => t + Math.abs(v - base[i]), 0) / rows.length });
}
const summarise = (xs) => ({ mean: round(xs.reduce((s, x) => s + x, 0) / xs.length), p05: round(pct(xs, 0.05)), min: round(Math.min(...xs)) });
const oneAtATime = KEYS.map((k) => {
  const out = { key: k, label: RUBRIC.find((x) => x.key === k).label };
  for (const [name, factor] of [["minus", 1 - SPREAD], ["plus", 1 + SPREAD], ["dropped", 0]]) {
    const s = rows.map((x) => weighted(x, { ...ones, [k]: factor }));
    out[name] = { rho: round(spearman(base, s)), gradeChanges: s.filter((v, i) => gradeOf(v) !== baseGrades[i]).length, meanAbsChange: round(s.reduce((t, v, i) => t + Math.abs(v - base[i]), 0) / rows.length, 2) };
  }
  return out;
});
// Entries whose grade is least stable under random weights (share of draws where the grade changes).
const flips = new Array(rows.length).fill(0);
seed = 20261027;
for (let d = 0; d < Math.min(DRAWS, 300); d++) {
  const w = Object.fromEntries(KEYS.map((k) => [k, 1 - SPREAD + 2 * SPREAD * rand()]));
  rows.forEach((x, i) => { if (gradeOf(weighted(x, w)) !== baseGrades[i]) flips[i]++; });
}
const nFlipDraws = Math.min(DRAWS, 300);
const borderline = rows.map((x, i) => ({ id: x.id, name: x.name, score: base[i], grade: baseGrades[i], flipShare: round(flips[i] / nFlipDraws, 2) })).filter((x) => x.flipShare >= 0.25).sort((a, b) => b.flipShare - a.flipShare);

// 2. Agreement with the OBO Dashboard
const CHECKS = [
  ["consistent", "Logically consistent", (q) => q.consistent, (d) => d.consistent],
  ["unsatisfiable", "Unsatisfiable classes", (q) => q.unsatisfiable, (d) => d.unsatisfiable],
  ["owl2dl", "In OWL 2 DL", (q) => q.owl2dl, (d) => d.owl2dl],
  ["robotErrorsZero", "No ROBOT errors", (q) => (q.robot ? !q.robot.ERROR : null), (d) => (d.robot ? !d.robot.ERROR : null)],
];
const both = rows.filter((x) => x.facts.quality && !x.facts.quality.error && x.facts.quality.consistent !== undefined && x.facts.dashboard && !x.facts.dashboard.error);
const agreement = CHECKS.map(([key, label, ours, theirs]) => {
  const pairs = both.map((x) => [ours(x.facts.quality), theirs(x.facts.dashboard), x.id]).filter(([a, b]) => a != null && b != null);
  const differ = pairs.filter(([a, b]) => a !== b);
  return { key, label, compared: pairs.length, agree: pairs.length - differ.length, rate: pairs.length ? round((pairs.length - differ.length) / pairs.length) : null, differing: differ.slice(0, 20).map(([a, b, id]) => ({ id, ours: a, dashboard: b })) };
});
const robotErr = both.filter((x) => x.facts.quality.robot && x.facts.dashboard.robot).map((x) => [x.facts.quality.robot.ERROR || 0, x.facts.dashboard.robot.ERROR || 0]);

// 3. Expert ratings
const csvFile = path.join(root, "data/validation/expert-ratings.csv");
let experts = { file: "data/validation/expert-ratings.csv", ratings: 0, entries: 0, raters: 0, rho: null, byGrade: null };
if (existsSync(csvFile)) {
  const lines = (await readFile(csvFile, "utf8")).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const head = lines.shift()?.split(",").map((x) => x.trim().toLowerCase()) || [];
  const col = (n) => head.indexOf(n);
  const recs = lines.map((l) => l.split(",")).map((c) => ({ id: c[col("id")]?.trim(), rater: c[col("rater")]?.trim(), overall: Number(c[col("overall")]) })).filter((x) => x.id && x.overall >= 1 && x.overall <= 5);
  const byId = {};
  for (const x of recs) (byId[x.id] ??= []).push(x.overall);
  const ids = Object.keys(byId).filter((id) => rows.some((r) => r.id === id));
  const ours = ids.map((id) => rows.find((r) => r.id === id).r.score);
  const theirs = ids.map((id) => byId[id].reduce((s, v) => s + v, 0) / byId[id].length);
  experts = {
    ...experts,
    ratings: recs.length,
    entries: ids.length,
    raters: new Set(recs.map((x) => x.rater)).size,
    rho: ids.length >= 5 ? round(spearman(ours, theirs)) : null,
    byGrade: GRADES.map((g) => {
      const v = ids.map((id, i) => [rows.find((r) => r.id === id).r.grade, theirs[i]]).filter(([gr]) => gr === g.grade).map(([, t]) => t);
      return { grade: g.grade, n: v.length, meanRating: v.length ? round(v.reduce((s, x) => s + x, 0) / v.length, 2) : null };
    }),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  rubricVersion: RUBRIC_VERSION,
  evaluation: { generatedAt: evFile.ev.generatedAt, runId: evFile.ev.run?.id || null, file: path.relative(root, evFile.f) },
  entries: rows.length,
  sensitivity: {
    method: `Each criterion's weight drawn uniformly from ${1 - SPREAD}–${1 + SPREAD} (${DRAWS} draws, fixed seed); scores recomputed from the stored points. Penalties and the inconsistency cap are unchanged.`,
    reproduces: mismatches === 0,
    spearman: summarise(draws.map((d) => d.rho)),
    sameGradeShare: summarise(draws.map((d) => d.sameGrade)),
    meanAbsScoreChange: summarise(draws.map((d) => d.meanAbs)),
    oneAtATime,
    borderline: { threshold: 0.25, count: borderline.length, examples: borderline.slice(0, 15) },
  },
  dashboardAgreement: {
    method: "Ontologies with both a SchemaScope ROBOT run and an OBO Dashboard result. The two may check different files (the Dashboard usually checks the -base release).",
    ontologies: both.length,
    checks: agreement,
    robotErrors: robotErr.length ? { compared: robotErr.length, oursHigher: robotErr.filter(([a, b]) => a > b).length, equal: robotErr.filter(([a, b]) => a === b).length, oursLower: robotErr.filter(([a, b]) => a < b).length, spearman: round(spearman(robotErr.map((x) => x[0]), robotErr.map((x) => x[1]))) } : null,
  },
  experts,
};
await mkdir(path.join(root, "data/validation"), { recursive: true });
await writeFile(path.join(root, "data/validation/report.json"), JSON.stringify(report, null, 2) + "\n");

const s = report.sensitivity;
console.log(`Rubric v${RUBRIC_VERSION}, ${rows.length} entries (evaluation ${report.evaluation.generatedAt}).${s.reproduces ? "" : ` Warning: ${mismatches} scores not reproduced by the reweighting.`}`);
console.log(`Sensitivity (weights ±${SPREAD * 100}%, ${DRAWS} draws): rank correlation mean ${s.spearman.mean} (5th percentile ${s.spearman.p05}); same grade for ${(s.sameGradeShare.mean * 100).toFixed(1)}% of entries on average (worst draw ${(s.sameGradeShare.min * 100).toFixed(1)}%); mean score change ${s.meanAbsScoreChange.mean} points.`);
for (const x of s.oneAtATime) console.log(`  ${x.label.padEnd(32)} −${SPREAD * 100}%: ${x.minus.gradeChanges} grade changes · +${SPREAD * 100}%: ${x.plus.gradeChanges} · dropped: ${x.dropped.gradeChanges} (rank corr. ${x.dropped.rho})`);
console.log(`  ${s.borderline.count} entries change grade in at least 25% of draws (borderline).`);
console.log(`OBO Dashboard agreement on ${both.length} ontologies: ${agreement.map((a) => `${a.label} ${a.compared ? `${a.agree}/${a.compared}` : "—"}`).join("; ")}.`);
console.log(experts.ratings ? `Expert ratings: ${experts.ratings} ratings of ${experts.entries} entries by ${experts.raters} raters; rank correlation with our scores ${experts.rho ?? "(need at least 5 entries)"}.` : `Expert ratings: none yet (add them to ${experts.file}).`);
console.log("Wrote data/validation/report.json");
