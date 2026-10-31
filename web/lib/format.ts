export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—";

export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "—";

export const fmtNum = (n?: number | null) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

export const fmtMetric = (v: unknown) => (v === true ? "yes" : v === false ? "no" : v == null ? "—" : typeof v === "number" ? fmtNum(v) : String(v));

export const plural = (n: number, word: string, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;

export const host = (u?: string | null) => {
  try {
    return new URL(u || "").hostname.replace(/^www\./, "");
  } catch {
    return u || "";
  }
};

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const LICENSE_URLS: Record<string, string> = {
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY 3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  MIT: "https://opensource.org/licenses/MIT",
  "BSD-3-Clause": "https://opensource.org/licenses/BSD-3-Clause",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "LGPL-3.0": "https://www.gnu.org/licenses/lgpl-3.0.html",
  "GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html",
};

export const KIND_LABEL: Record<string, string> = {
  ontology: "Ontology",
  schema: "Schema",
  vocabulary: "Vocabulary",
  atlas: "Atlas",
  "data-standard": "Data standard",
  "knowledge-base": "Knowledge base",
};

export const REGISTRY_LABEL: Record<string, string> = {
  discovered: "Found by discovery",
  submitted: "Submitted by authors",
  curated: "Curated",
};

export const CRIT_LABELS: [string, string][] = [
  ["findable", "Findable"],
  ["accessible", "Accessible"],
  ["interoperable", "Interoperable"],
  ["reusable", "Reusable"],
  ["quality", "Quality"],
  ["maintenance", "Maintenance"],
  ["adoption", "Adoption"],
];

export const METRIC_LABELS: [string, string][] = [
  ["consistent", "Logically consistent"],
  ["unsatisfiable", "Unsatisfiable classes"],
  ["owl2dl", "In OWL 2 DL"],
  ["robotErrors", "ROBOT errors"],
  ["robotWarnings", "ROBOT warnings"],
  ["criticalPitfalls", "Critical pitfalls"],
  ["imports", "Imported vocabularies"],
  ["reuse", "Reused by"],
];
