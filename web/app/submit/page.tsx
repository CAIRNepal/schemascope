import type { Metadata } from "next";
import { Crumbs } from "@/components/ui";
import { SubmitForm, type Initial } from "@/components/submit-form";
import { NotFound, api } from "@/lib/api";
import { KIND_LABEL } from "@/lib/format";

type SP = Promise<{ update?: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await api.meta();
  return {
    title: "Submit a resource",
    description: `Submit an ontology, schema or data standard to ${site.brand || site.name} through GitHub. Every submission is validated, FAIR-evaluated and reviewed before merge.`,
    alternates: { canonical: "/submit/" },
  };
}

// Correction mode (/submit/?update=<id>): the form starts from the published entry.
async function initialFor(id?: string): Promise<{ initial: Initial; label?: string; found: boolean }> {
  if (!id) return { initial: {}, found: false };
  try {
    const { entry: e } = await api.entry(id);
    const join = (x?: string[]) => (x || []).join(", ");
    return {
      found: true,
      label: e.acronym || e.name,
      initial: {
        name: e.name, acronym: e.acronym, category: e.category, kind: e.kind, description: e.description,
        homepage: e.homepage, repository: e.repository, download: e.download, maintainer: e.maintainer, license: e.license,
        ols: e.ols, obo: e.obo, bioportal: e.bioportal, formats: join(e.formats), species: join(e.species), tags: join(e.tags),
        doi: e.publications?.[0]?.doi,
        usedBy: (e.usedBy || []).map((u: { name: string; url: string; note?: string }) => [u.name, u.url, u.note].filter(Boolean).join(" | ")).join("\n"),
      },
    };
  } catch (err) {
    if (err instanceof NotFound) return { initial: {}, found: false };
    throw err;
  }
}

export default async function SubmitPage({ searchParams }: { searchParams: SP }) {
  const { update } = await searchParams;
  const [{ site }, categories, pre] = await Promise.all([api.meta(), api.categories(), initialFor(update)]);
  const repo = site.repository;
  const issueUrl = repo ? `${repo}/issues/new?template=add-resource.yml` : null;
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Submit", "/submit/"]]} />
        <h1>Submit a resource</h1>
        <p className="lede">
          All additions and corrections go through {repo ? <a href={repo} rel="noopener">GitHub</a> : "GitHub"}, so every change is reviewed, tracked and checked automatically before it is merged.
        </p>
        {update && !pre.found ? <p className="small muted">No entry with id <code>{update}</code>; starting a new submission instead.</p> : null}
      </section>

      <section className="wrap section">
        <ol className="flow">
          <li><b>1. Describe it</b><span>Fill in the form below, or open the {issueUrl ? <a href={issueUrl} rel="noopener">GitHub issue form</a> : "GitHub issue form"} directly.</span></li>
          <li><b>2. Issue → pull request</b><span>A bot turns your issue into a pull request that adds the entry to <code>data/catalog.json</code>.</span></li>
          <li><b>3. Automated checks</b><span>CI validates the entry, checks links and DOIs for duplicates, runs the FAIR evaluation and posts the score on the PR.</span></li>
          <li><b>4. Review &amp; merge</b><span>A maintainer reviews and merges. The site updates, and the next evaluation run archives it.</span></li>
        </ol>
      </section>

      <SubmitForm
        key={update || "new"}
        repo={repo}
        categories={categories.map((c) => ({ value: c.id, label: c.name }))}
        kinds={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
        initial={pre.initial}
        updateId={pre.found ? update : undefined}
        updateLabel={pre.label}
      />
    </>
  );
}
