import type { NextConfig } from "next";

// Pages not yet ported (submit, about, contact, roadmap, privacy, methodology text) are served from the
// static build while the move is in progress: any path the app does not handle is proxied to LEGACY_SITE_URL.
const legacy = process.env.LEGACY_SITE_URL?.replace(/\/$/, "");

// Keep the static site's URLs (/o/<id>/, /category/<id>/ …) so existing links and search rankings carry over.
const config: NextConfig = {
  trailingSlash: true,
  poweredByHeader: false,
  async redirects() {
    // The old client-side search page is now the server-side catalog search.
    return [{ source: "/search", destination: "/catalog/", permanent: true }];
  },
  async rewrites() {
    return legacy ? { beforeFiles: [], afterFiles: [], fallback: [{ source: "/:path*", destination: `${legacy}/:path*` }] } : [];
  },
};

export default config;
