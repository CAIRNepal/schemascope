import type { Metadata } from "next";
import Link from "next/link";
import { Crumbs, Icon, MiniList } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";

export const metadata: Metadata = { title: "Categories", alternates: { canonical: "/categories/" } };

export default async function CategoriesPage() {
  const [categories, stats] = await Promise.all([api.categories(), api.stats()]);
  const tops = await Promise.all(categories.map((c) => api.search({ category: c.id, sort: "score", size: 12 })));
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Categories", "/categories/"]]} />
        <h1>Categories</h1>
        <p className="lede">{categories.length} domains covering {fmtNum(stats.entries)} resources.</p>
      </section>
      <section className="wrap section">
        {categories.map((c, i) => (
          <div className="cat-row" key={c.id}>
            <div className="cat-row-head">
              <Icon name={c.icon} />
              <div><h2><Link href={`/category/${c.id}/`}>{c.name}</Link></h2><p className="muted">{c.blurb}</p></div>
            </div>
            <MiniList items={tops[i].items} />
            {tops[i].total > 12 ? <p className="small"><Link href={`/category/${c.id}/`}>All {fmtNum(tops[i].total)} in {c.name} →</Link></p> : null}
          </div>
        ))}
      </section>
    </>
  );
}
