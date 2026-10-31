import type { Metadata } from "next";
import { Crumbs } from "@/components/ui";
import { PUBLIC_API_URL, api } from "@/lib/api";

export const metadata: Metadata = { title: "API & MCP", description: "Query the catalog over HTTP or connect an AI agent over MCP.", alternates: { canonical: "/api-docs/" } };

export default async function ApiDocs() {
  const { site } = await api.meta();
  const brand = site.brand || site.name;
  const rows: [string, string][] = [
    ["GET /api/entries?q=&category=&kind=&grade=&format=&registry=&sort=&page=&size=", "Search and filter, with facet counts"],
    ["GET /api/entries/{id}", "One entry: record, evaluation, adopters, imports, reuse, history, changes"],
    ["GET /api/entries/{id}/history", "Score, criteria and quality metrics in every run"],
    ["GET /api/categories", "Domains with counts"],
    ["GET /api/runs", "Evaluation runs, newest first"],
    ["GET /api/runs/{id}", "One run, paginated per entry"],
    ["GET /api/stats", "Catalog size, grades, average score"],
    ["GET /api/meta", "Site, latest run and the scoring rubric"],
  ];
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["API & MCP", "/api-docs/"]]} />
        <h1>API &amp; MCP</h1>
        <p className="lede">Everything on this site comes from a public JSON API. AI agents can use the same queries over the Model Context Protocol.</p>
      </section>
      <section className="wrap section api-note">
        <div className="panel">
          <h2>HTTP API</h2>
          <p className="small">Base URL <code>{PUBLIC_API_URL}</code> · interactive docs at <a href={`${PUBLIC_API_URL}/docs`}><code>/docs</code></a> · OpenAPI at <a href={`${PUBLIC_API_URL}/openapi.json`}><code>/openapi.json</code></a></p>
          <div className="table-wrap"><table className="hist-table"><tbody>{rows.map(([a, b]) => <tr key={a}><td><code>{a}</code></td><td>{b}</td></tr>)}</tbody></table></div>
        </div>
        <div className="panel">
          <h2>MCP server</h2>
          <p className="small">Streamable HTTP endpoint: <code>{PUBLIC_API_URL}/mcp/</code></p>
          <p className="small">Tools: <code>search_catalog</code>, <code>get_entry</code>, <code>get_entry_history</code>, <code>list_categories</code>, <code>catalog_stats</code>, <code>scoring_rubric</code>.</p>
          <p className="small">Claude Code: <code>claude mcp add --transport http {brand.toLowerCase()} {PUBLIC_API_URL}/mcp/</code></p>
        </div>
      </section>
    </>
  );
}
