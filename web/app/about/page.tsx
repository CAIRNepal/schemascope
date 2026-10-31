import type { Metadata } from "next";
import Link from "next/link";
import { Crumbs } from "@/components/ui";
import { PUBLIC_API_URL, api } from "@/lib/api";

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  const brand = site.brand || site.name;
  return { title: "About", description: `About ${brand}: what it catalogs, how contributions are reviewed through GitHub, and how to use the catalog data, API and MCP server.`, alternates: { canonical: "/about/" } };
}

export default async function AboutPage() {
  const { site } = await api.meta();
  const brand = site.brand || site.name;
  const repo = site.repository;
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["About", "/about/"]]} />
        <h1>About {brand}</h1>
        <p className="lede">{site.description}</p>
      </section>
      <section className="wrap section prose">
        <h2>What this is</h2>
        <p>
          {site.about ??
            `Research data is described with ontologies, controlled vocabularies, metadata schemas and data standards, maintained by different communities and spread across registries such as OLS, BioPortal, the OBO Foundry, Bioregistry and FAIRsharing. ${brand} brings them into one catalog, organised by domain, so you can see what exists, which version is current, how FAIR and well maintained it is, and who already uses it.`}
        </p>
        <p>Each resource stays with its maintainers. This catalog links to the canonical homepage, repository, download PURL and ontology browsers; it does not copy or re-license their files.</p>

        <h2 id="contribute">Contributing</h2>
        <p>
          Everything is tracked in Git. Use the <Link href="/submit/">submission form</Link>, which opens a pre-filled GitHub issue that a bot converts into a pull request, or edit <code>data/catalog.json</code> and open a pull request yourself on {repo ? <a href={repo} rel="noopener">GitHub</a> : "GitHub"}. Every pull request is validated, link-checked, de-duplicated and FAIR-evaluated in CI before a maintainer reviews and merges it.
        </p>

        <h2>Use the data</h2>
        <ul>
          <li><a href={`${PUBLIC_API_URL}/api/entries`}><code>/api/entries</code></a>: search and filter every entry, with its latest score and evaluated version.</li>
          <li><code>/api/entries/&lt;id&gt;</code>: a single entry with its full evaluation, history across runs and what changed.</li>
          <li><a href={`${PUBLIC_API_URL}/api/runs`}><code>/api/runs</code></a>: every archived evaluation run.</li>
          <li><a href={`${PUBLIC_API_URL}/docs`}><code>/docs</code></a>: interactive API documentation (OpenAPI).</li>
          <li>An MCP server for AI agents: see <Link href="/api-docs/">API &amp; MCP</Link>.</li>
          {repo ? <li><a href={`${repo}/blob/main/data/catalog.schema.json`}><code>catalog.schema.json</code></a>: JSON Schema for catalog entries.</li> : null}
        </ul>
        <p>Entry pages embed schema.org JSON-LD (Dataset) so search engines, including Google Dataset Search, can index the catalog.</p>
      </section>
    </>
  );
}
