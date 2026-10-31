import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Cards, Crumbs, Icon, Pager } from "@/components/ui";
import { NotFound, api, type Category } from "@/lib/api";
import { fmtNum } from "@/lib/format";

const PAGE_SIZE = 48;
type P = { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> };

async function load(id: string): Promise<Category> {
  try {
    return await api.category(id);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const c = await load((await params).id);
  return { title: `${c.name} ontologies & schemas`, description: `${c.name}: ${c.blurb} ${c.count} resources.`, alternates: { canonical: `/category/${c.id}/` } };
}

export default async function CategoryPage({ params, searchParams }: P) {
  const { id } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const [c, all, primary, { rubric }] = await Promise.all([
    load(id),
    api.categories(),
    api.search({ category: id, sort: "score", page, size: PAGE_SIZE }),
    api.meta(),
  ]);
  const primaryItems = primary.items.filter((e) => e.category === id);
  const alsoItems = primary.items.filter((e) => e.category !== id);
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Categories", "/categories/"], [c.name, `/category/${c.id}/`]]} />
        <div className="title-row"><Icon name={c.icon} className="icon icon-lg" /><h1>{c.name}</h1></div>
        <p className="lede">{c.blurb}</p>
      </section>
      <section className="wrap section">
        <div className="section-head">
          <h2>{fmtNum(c.count)} resource{c.count === 1 ? "" : "s"}{c.reach > c.count ? ` + ${fmtNum(c.reach - c.count)} from other domains` : ""}</h2>
          <span className="muted">Sorted by evaluation score</span>
        </div>
        <Cards items={primaryItems} fairMax={rubric?.fairMax} />
        {alsoItems.length ? (
          <>
            <div className="section-head also-head"><h2>Also used in {c.name}</h2><span className="muted">from other domains</span></div>
            <Cards items={alsoItems} fairMax={rubric?.fairMax} />
          </>
        ) : null}
        <Pager page={page} size={PAGE_SIZE} total={primary.total} href={(p) => `/category/${id}/${p > 1 ? `?page=${p}` : ""}`} />
        <p className="muted other-cats">
          Other categories:{" "}
          {all.filter((x) => x.id !== id).map((x, i) => (
            <span key={x.id}>{i ? " · " : ""}<Link href={`/category/${x.id}/`}>{x.name}</Link></span>
          ))}
        </p>
      </section>
    </>
  );
}
