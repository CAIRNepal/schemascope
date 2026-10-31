import Link from "next/link";
import { Cards, Icon, SearchForm } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";

export default async function Home() {
  const [{ site, rubric }, stats, categories, top, recent] = await Promise.all([api.meta(), api.stats(), api.categories(), api.top(6), api.recent(12)]);
  const topIds = new Set(top.map((e) => e.id));
  const recentOnly = recent.filter((e) => !topIds.has(e.id)).slice(0, 6);
  return (
    <>
      <section className="hero">
        <div className="wrap hero-inner">
          <p className="eyebrow">{site.tagline}</p>
          <h1>See how the world&rsquo;s <em>schemas</em> fit together.</h1>
          <p className="lede">
            {site.description} Every entry is scored against the FAIR principles, ontology quality, maintenance and community adoption, with the exact
            version evaluated and full provenance.
          </p>
          <SearchForm id="hero-q" />
          <dl className="stats">
            <div><dt>Resources</dt><dd>{fmtNum(stats.entries)}</dd></div>
            <div><dt>Categories</dt><dd>{stats.categories}</dd></div>
            <div><dt>Adopting projects</dt><dd>{fmtNum(stats.totalAdopters)}</dd></div>
            <div><dt>Avg. score</dt><dd>{stats.averageScore != null ? Math.round(stats.averageScore) : "—"}</dd></div>
          </dl>
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head"><h2>Browse by domain</h2><Link href="/categories/">All domains →</Link></div>
        <div className="cat-grid">
          {categories.map((c) => (
            <Link key={c.id} className="cat-tile" href={`/category/${c.id}/`}>
              <Icon name={c.icon} />
              <span className="cat-name">{c.name}</span>
              <span className="cat-blurb">{c.blurb}</span>
              <span className="cat-count">
                {c.count} resource{c.count === 1 ? "" : "s"}
                {c.reach > c.count ? <> <span className="xcount">+ {c.reach - c.count} from other domains</span></> : null}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head"><h2>Highest rated</h2><Link href="/catalog/?sort=score">See all {fmtNum(stats.entries)} →</Link></div>
        <Cards items={top} fairMax={rubric?.fairMax} />
      </section>

      <section className="wrap section">
        <div className="section-head"><h2>Recently updated</h2><Link href="/catalog/?sort=activity">See all →</Link></div>
        <Cards items={recentOnly} fairMax={rubric?.fairMax} />
      </section>

      <section className="wrap section browse-all">
        <Link className="btn" href="/catalog/">Browse the full catalog</Link> <Link className="btn-ghost" href="/evaluation/">How we score</Link>
      </section>

      <section className="wrap section cta">
        <div className="cta-inner">
          <div>
            <h2>Missing a schema or ontology?</h2>
            <p className="muted">Submit it through {site.repository ? <a href={site.repository} rel="noopener">GitHub</a> : "GitHub"}. Every addition is reviewed, validated and evaluated automatically before it is merged.</p>
          </div>
          <Link className="btn" href="/submit/">Submit a resource</Link>
        </div>
      </section>
    </>
  );
}
