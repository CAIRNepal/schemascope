// Typed client for the catalog API (backend/). Pages call it on the server.
import "server-only";

const API_URL = (process.env.API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
// Public base for links readers can open (machine-readable JSON); defaults to the same API.
export const PUBLIC_API_URL = (process.env.NEXT_PUBLIC_API_URL || API_URL).replace(/\/$/, "");
// Seconds a page's data may be reused before it is fetched again. Data changes once per evaluation run.
const REVALIDATE = Number(process.env.REVALIDATE_SECONDS || 300);

export class NotFound extends Error {}

async function get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = `${API_URL}${path}${qs.size ? `?${qs}` : ""}`;
  const res = await fetch(url, { next: { revalidate: REVALIDATE } });
  if (res.status === 404) throw new NotFound(path);
  if (!res.ok) throw new Error(`API ${res.status} for ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type Site = { name: string; brand?: string; url: string; tagline?: string; description?: string; repository?: string; gtmId?: string;
  // Home page headline: before <em>em</em> after.
  hero?: { before?: string; em?: string; after?: string };
  sister?: { name: string; url: string; eyebrow?: string; title?: string; blurb?: string };
  // About page: what the catalog covers (first paragraph).
  about?: string;
  // Roadmap kept elsewhere (e.g. shared with a sister catalog): /roadmap/ redirects there.
  roadmapUrl?: string;
  contact?: { name: string; role?: string; emails?: string[]; site?: string; github?: string };
  // GitHub logins not listed as contributors (e.g. AI assistants credited in commits).
  contributorsExclude?: string[];
};
export type RubricItem = { key: string; symbol: string; label: string; fair: boolean; max: number; formula: string; how: string; ontologyOnly?: boolean };
export type Rubric = { version: string; rubric: RubricItem[]; penalty: { label: string; formula: string; how: string }; fairMax: number; grades: { grade: string; min: number }[] };
export type RunInfo = { id: string; startedAt?: string; finishedAt?: string; trigger?: string; evaluator?: { version?: string; rubricVersion?: string }; [k: string]: unknown };
export type Meta = { site: Site; evaluation: { generatedAt?: string; rescoredAt?: string; rubricVersion?: string; run?: RunInfo }; rubric: Rubric | null; ingestedAt: string };

export type Category = { id: string; name: string; icon: string; blurb: string; count: number; reach: number };
export type Summary = {
  id: string; acronym: string | null; name: string; description: string; category: string; categoryName: string; domains: string[];
  kind: string; kindLabel: string; formats: string[]; tags: string[]; species: string[]; legacy: boolean;
  grade: string | null; score: number | null; fair: number | null; lastActivity: string | null; adopters: number; version: string | null;
  penalty: number | null; qualityPartial: boolean; qualityNotAssessed: number | null;
};
export type SearchResult = { total: number; page: number; size: number; items: Summary[]; facets: Record<string, Record<string, number>> };
export type HistoryPoint = {
  runId: string; at: string; score: number; grade: string; fair: number | null; version: string | null; terms: number | null; rubric?: string;
  crit: Record<string, number>; penalty: number | null; metrics: Record<string, number | boolean | null>;
};
export type Change = { at: string; runId: string; what: string };
export type Ref = { key: string; entryId: string | null; label: string; url?: string };
export type Adopter = { name: string; url: string; note?: string; source: string };
// The evaluation facts are a large, source-shaped record; pages read the parts they show.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Facts = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CatalogEntry = Record<string, any> & { id: string; name: string; acronym?: string; category: string; kind: string; description: string };
export type EntryDetail = {
  entry: CatalogEntry; summary: Summary; category: Category; domains: Category[]; facts: Facts | null; license: string | null;
  adopters: Adopter[]; imports: Ref[]; reusedBy: Ref[]; history: HistoryPoint[]; changes: Change[]; related: Summary[];
};
export type Stats = {
  entries: number; evaluated: number; categories: number; runs: number; averageScore: number | null; grades: Record<string, number>;
  kinds: Record<string, number>; crossDomain: number; totalAdopters?: number;
};
export type RunListItem = RunInfo & { entryCount: number };

export const api = {
  meta: () => get<Meta>("/api/meta"),
  stats: () => get<Stats>("/api/stats"),
  categories: () => get<Category[]>("/api/categories"),
  category: (id: string) => get<Category>(`/api/categories/${encodeURIComponent(id)}`),
  search: (p: { q?: string; category?: string; kind?: string; grade?: string; format?: string; registry?: string; legacy?: boolean; sort?: string; page?: number; size?: number }) =>
    get<SearchResult>("/api/entries", p),
  top: (n = 6, category?: string) => get<Summary[]>("/api/top-entries", { n, category }),
  recent: (n = 6) => get<Summary[]>("/api/recent-entries", { n }),
  entry: (id: string) => get<EntryDetail>(`/api/entries/${encodeURIComponent(id)}`),
  ids: () => get<{ id: string; category: string }[]>("/api/entry-ids"),
  // Content documents from data/ (roadmap, validation); null when this catalog has none.
  content: async <T,>(name: "roadmap" | "validation") => {
    try {
      return await get<T>(`/api/content/${name}`);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
  },
  runs: (limit = 50) => get<RunListItem[]>("/api/runs", { limit }),
};
