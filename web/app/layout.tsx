import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SlashToSearch, ThemeToggle } from "@/components/client";
import { Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import "./extra.css";

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  const brand = site.brand || site.name;
  return {
    metadataBase: site.url ? new URL(site.url) : undefined,
    title: { default: `${brand} — ${site.tagline ?? ""}`, template: `%s · ${brand}` },
    description: site.description,
    openGraph: { siteName: brand, type: "website", images: [{ url: "/assets/og-image.png", width: 1200, height: 630, alt: brand }], locale: "en_US" },
    twitter: { card: "summary_large_image" },
    icons: { icon: [{ url: "/assets/favicon-32.png", sizes: "32x32" }, { url: "/assets/favicon-64.png", sizes: "64x64" }], apple: "/assets/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b1530" },
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
  ],
};

const NAV: [string, string][] = [
  ["/catalog/", "Catalog"],
  ["/categories/", "Categories"],
  ["/evaluation/", "Evaluation"],
  ["/submit/", "Submit"],
  ["/roadmap/", "Roadmap"],
  ["/about/", "About"],
  ["/contact/", "Contact"],
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { site, evaluation } = await api.meta();
  const brand = site.brand || site.name;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
        <link rel="stylesheet" href="/assets/style.css" />
        <script dangerouslySetInnerHTML={{ __html: 'try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}' }} />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site-header">
          <div className="wrap header-inner">
            <Link className="brand" href="/" aria-label={`${brand} home`}><Logo brand={brand} /></Link>
            <nav className="nav" aria-label="Main">
              {NAV.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="wrap footer-inner">
            <div className="footer-brand"><Logo brand={brand} className="logo-footer" /><p className="muted">{site.description}</p></div>
            <nav className="footer-links" aria-label="Footer">
              <Link href="/categories/">Categories</Link>
              <Link href="/evaluation/">Methodology</Link>
              <Link href="/evaluation/#runs">Run history</Link>
              <Link href="/submit/">Submit a resource</Link>
              <Link href="/roadmap/">Features &amp; roadmap</Link>
              <Link href="/contact/">Contact</Link>
              <Link href="/api-docs/">API &amp; MCP</Link>
              {site.repository ? <a href={site.repository}>GitHub</a> : null}
              {site.sister ? <a href={site.sister.url}>{site.sister.name}</a> : null}
              <Link href="/privacy/">Privacy</Link>
            </nav>
            <p className="muted small">
              Descriptions are summaries; each resource is owned by its maintainers and keeps its own license.
              {evaluation?.generatedAt ? ` Last evaluated ${fmtDate(evaluation.generatedAt)}.` : ""}
            </p>
          </div>
        </footer>
        <SlashToSearch />
      </body>
    </html>
  );
}
