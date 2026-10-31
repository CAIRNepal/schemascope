import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Crumbs } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";

type Roadmap = { updated?: string; sections: { id: string; title: string; items: { status: string; title: string; text: string }[] }[] };
const LABEL: Record<string, string> = { done: "Available", "in-progress": "In progress", planned: "Planned" };

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  return { title: "Features & roadmap", description: `${site.brand || site.name}'s features and development roadmap.`, alternates: { canonical: "/roadmap/" } };
}

export default async function RoadmapPage() {
  const [{ site }, roadmap] = await Promise.all([api.meta(), api.content<Roadmap>("roadmap")]);
  // A catalog can share another site's roadmap (NeuroSchema uses SchemaScope's).
  if (!roadmap) {
    if (site.roadmapUrl) redirect(site.roadmapUrl);
    notFound();
  }
  const brand = site.brand || site.name;
  const all = roadmap.sections.flatMap((x) => x.items);
  const count = (st: string) => all.filter((i) => i.status === st).length;
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Features & roadmap", "/roadmap/"]]} />
        <h1>Features &amp; roadmap</h1>
        <p className="lede">What {brand} does today, and what we plan to build next.</p>
        <p className="small muted">{count("done")} available · {count("in-progress")} in progress · {count("planned")} planned{roadmap.updated ? ` · updated ${fmtDate(roadmap.updated)}` : ""}</p>
      </section>
      <section className="wrap section">
        {roadmap.sections.map((sec) => (
          <div className="roadmap-sec" id={sec.id} key={sec.id}>
            <h2>{sec.title}</h2>
            <ul className="roadmap">
              {sec.items.map((i) => (
                <li className={`rm-${i.status}`} key={i.title}>
                  <span className="rm-status">{LABEL[i.status] || i.status}</span>
                  <div><b>{i.title}</b><p>{i.text}</p></div>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="small muted">
          Ideas or priorities you&rsquo;d like to see? <Link href="/contact/">Get in touch</Link>
          {site.repository ? <> or <a href={`${site.repository}/issues/new?template=idea.yml`} rel="noopener">suggest an idea on GitHub</a></> : null}.
        </p>
      </section>
    </>
  );
}
