import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Pages not yet ported are served from the static build while the move is in progress:
// any path the app does not handle is proxied to LEGACY_SITE_URL (optional).
const legacy = process.env.LEGACY_SITE_URL?.replace(/\/$/, "");
// Where readers' browsers reach the API (the static site's JSON files now live there).
const api = (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
let repository = "";
try {
  repository = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8")).repository || "";
} catch {}

// Keep the static site's URLs (/o/<id>/, /category/<id>/ …) so existing links and search rankings carry over.
const config: NextConfig = {
  trailingSlash: true,
  poweredByHeader: false,
  async redirects() {
    return [
      // The old client-side search page is now the server-side catalog search.
      { source: "/search", destination: "/catalog/", permanent: true },
      // Machine-readable files of the static site → their API equivalents.
      { source: "/o/:id/entry.json", destination: `${api}/api/entries/:id`, permanent: false },
      { source: "/runs/index.json", destination: `${api}/api/runs`, permanent: false },
      { source: "/runs/:id([^/]+)\\.json", destination: `${api}/api/runs/:id`, permanent: false },
      { source: "/catalog.json", destination: `${api}/api/entries?size=100`, permanent: false },
      { source: "/catalog-index.json", destination: `${api}/api/entries?size=100`, permanent: false },
      { source: "/search-index.json", destination: `${api}/api/entries?size=100`, permanent: false },
      ...(repository ? [{ source: "/catalog.schema.json", destination: `${repository}/blob/main/data/catalog.schema.json`, permanent: false }] : []),
    ];
  },
  async rewrites() {
    return legacy ? { beforeFiles: [], afterFiles: [], fallback: [{ source: "/:path*", destination: `${legacy}/:path*` }] } : [];
  },
};

export default config;
