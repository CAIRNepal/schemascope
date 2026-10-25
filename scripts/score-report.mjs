#!/usr/bin/env node
// Markdown summary of evaluation results for the entries in ONLY (used in PR comments).
import { readFileSync } from "node:fs";
import { RUBRIC, FAIR_MAX } from "./rubric.mjs";

const ids = (process.env.ONLY || "").split(",").filter(Boolean);
import { existsSync } from "node:fs";
// In CI, PR previews are written to .local/data/ (never to tracked results); read whichever is newer.
const files = [".local/data/evaluation.json", "data/evaluation.json"].filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
const ev = (files.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] || { entries: {} }).entries;
const lines = ["### 🧪 FAIR evaluation preview", ""];
if (!ids.length) lines.push("No catalog entries changed.");
for (const id of ids) {
  const r = ev[id];
  if (!r) {
    lines.push(`- \`${id}\`: not evaluated`);
    continue;
  }
  lines.push(`#### \`${id}\` — **${r.score}/100 (grade ${r.grade})**, FAIR ${r.fair}/${FAIR_MAX}`);
  if (r.penalty?.score) lines.push(`⚠️ Inactivity penalty ${r.penalty.score}: ${r.penalty.reason}`, "");
  lines.push(`Version evaluated: **${r.evaluatedVersion?.label ?? "not detected"}**${r.evaluatedVersion ? ` (${r.evaluatedVersion.from})` : ""}`, "");
  lines.push(`| ${RUBRIC.map((x) => `${x.symbol} ${x.label}`).join(" | ")} |`, `|${RUBRIC.map(() => "---").join("|")}|`, `| ${RUBRIC.map((x) => `${r.breakdown[x.key].score}/${x.max}`).join(" | ")} |`, "");
  const missing = RUBRIC.flatMap((x) => r.breakdown[x.key].steps.filter((s) => s.max > 0 && s.pts < s.max).map((s) => `${x.symbol}: ${s.label} — ${s.detail}`));
  if (missing.length) lines.push("<details><summary>Points not earned (how to improve)</summary>", "", ...missing.map((m) => `- ${m}`), "", "</details>", "");
}
console.log(lines.join("\n"));
