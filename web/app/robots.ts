import type { MetadataRoute } from "next";
import { api } from "@/lib/api";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { site } = await api.meta();
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${site.url}/sitemap.xml` };
}
