import type { MetadataRoute } from "next";
import { api } from "@/lib/api";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [{ site, evaluation }, ids, categories] = await Promise.all([api.meta(), api.ids(), api.categories()]);
  const at = evaluation?.generatedAt ? new Date(evaluation.generatedAt) : undefined;
  const u = (p: string) => `${site.url}${p}`;
  return [
    ...["/", "/catalog/", "/categories/", "/evaluation/", "/api-docs/"].map((p) => ({ url: u(p), lastModified: at })),
    ...categories.map((c) => ({ url: u(`/category/${c.id}/`), lastModified: at })),
    ...ids.map((e) => ({ url: u(`/o/${e.id}/`), lastModified: at })),
  ];
}
