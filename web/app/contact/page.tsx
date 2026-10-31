import type { Metadata } from "next";
import Link from "next/link";
import { Crumbs } from "@/components/ui";
import { api } from "@/lib/api";

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  return { title: "Contact", description: `Contact the ${site.brand || site.name} maintainer, and the people who have contributed to it on GitHub.`, alternates: { canonical: "/contact/" } };
}

const ICON = {
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>,
  flag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5" /></svg>,
  code: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg>,
};

type Contributor = { login: string; url: string; avatar: string; name?: string };

// Contributors from the GitHub API (bots and excluded accounts left out), cached for a day.
// Any failure (rate limit, offline) just hides the list; the page links to GitHub instead.
async function contributors(repo: string | undefined, exclude: string[]): Promise<Contributor[]> {
  const m = String(repo || "").match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return [];
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/contributors?per_page=100`, { headers, next: { revalidate: 86400 }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const list = ((await r.json()) as { login: string; html_url: string; avatar_url: string; type: string }[])
      .filter((c) => c.type !== "Bot" && !/\[bot\]$/.test(c.login) && !skip.has(c.login.toLowerCase()))
      .map((c) => ({ login: c.login, url: c.html_url, avatar: c.avatar_url }) as Contributor);
    await Promise.all(
      list.slice(0, 30).map(async (c) => {
        const u = await fetch(`https://api.github.com/users/${c.login}`, { headers, next: { revalidate: 86400 }, signal: AbortSignal.timeout(8000) })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null);
        if (u?.name) c.name = u.name;
      }),
    );
    return list;
  } catch {
    return [];
  }
}

export default async function ContactPage() {
  const { site } = await api.meta();
  const brand = site.brand || site.name;
  const repo = site.repository;
  const c = site.contact;
  const people = await contributors(repo, site.contributorsExclude ?? ["claude"]);
  const ways = [
    { icon: ICON.plus, title: "Add or update a resource", text: "Use the submission form. A bot turns it into a pull request for review.", href: "/submit/", cta: "Submission form" },
    repo ? { icon: ICON.flag, title: "Report a problem", text: "Wrong score or metadata, a broken link, or a bug on the site?", href: `${repo}/issues/new?template=report-problem.yml`, cta: "Report a problem" } : null,
    repo ? { icon: ICON.code, title: "Suggest an idea", text: "A feature, a scoring improvement or a collaboration. The code is open source too.", href: `${repo}/issues/new?template=idea.yml`, cta: "Suggest an idea" } : null,
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));
  const bare = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Contact", "/contact/"]]} />
        <h1>Contact</h1>
        <p className="lede">Questions, corrections or ideas for collaboration? We&rsquo;d like to hear from you.</p>
      </section>
      <section className="wrap section contact">
        <div className="contact-grid">
          {c ? (
            <article className="contact-card maintainer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {c.github ? <img className="portrait" src={`https://github.com/${c.github}.png?size=240`} alt={c.name} width={112} height={112} /> : null}
              <div>
                <p className="eyebrow">{c.role ?? "Maintainer"}</p>
                <h2>{c.name}</h2>
                <div className="contact-links">
                  {(c.emails || []).map((x) => <a key={x} className="contact-link" href={`mailto:${x}`}>{ICON.mail}<span>{x}</span></a>)}
                  {c.site ? <a className="contact-link" href={c.site} rel="noopener">{ICON.globe}<span>{bare(c.site)}</span></a> : null}
                </div>
              </div>
            </article>
          ) : null}
          <div className="ways">
            {ways.map((w) => {
              const inner = (
                <>
                  <span className="way-icon">{w.icon}</span>
                  <span><b>{w.title}</b><span className="muted">{w.text}</span><span className="way-cta">{w.cta} →</span></span>
                </>
              );
              return w.href.startsWith("http") ? <a key={w.title} className="way" href={w.href} rel="noopener">{inner}</a> : <Link key={w.title} className="way" href={w.href}>{inner}</Link>;
            })}
          </div>
        </div>
        {people.length || repo ? (
          <div className="contributors-block" id="contributors">
            <h2>Contributors</h2>
            <p className="muted">Everyone who has contributed to {brand} on GitHub.</p>
            {people.length ? (
              <ul className="people">
                {people.map((p) => (
                  <li key={p.login}>
                    <a href={p.url} rel="noopener">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`${p.avatar}&s=160`} alt="" width={64} height={64} loading="lazy" />
                      <b>{p.name || p.login}</b>
                      {p.name ? <small>@{p.login}</small> : null}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {repo ? <p className="small muted"><a href={`${repo}/graphs/contributors`} rel="noopener">See all contributions on GitHub</a></p> : null}
          </div>
        ) : null}
      </section>
    </>
  );
}
