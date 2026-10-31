import type { Metadata } from "next";
import { Crumbs } from "@/components/ui";

export const metadata: Metadata = { title: "Privacy", description: "How this site handles analytics, cookies and your data.", alternates: { canonical: "/privacy/" } };

export default function PrivacyPage() {
  return (
    <>
      <section className="page-head wrap">
        <Crumbs trail={[["Home", "/"], ["Privacy", "/privacy/"]]} />
        <h1>Privacy</h1>
        <p className="lede">This site has no accounts, stores nothing you type, and does not track you.</p>
      </section>
      <section className="wrap section prose">
        <h2>Analytics and cookies</h2>
        <p>This site does not use analytics or tracking cookies.</p>
        <p>The theme preference (light/dark) is kept in your browser&rsquo;s local storage. It is never sent anywhere.</p>
        <h2>Submissions</h2>
        <p>
          The submission form runs in your browser and sends nothing to our servers: it opens a pre-filled GitHub issue. Issues and pull requests are subject to{" "}
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" rel="noopener">GitHub&rsquo;s privacy statement</a>.
        </p>
        <h2>Hosting</h2>
        <p>The site and its API are run on hosting that may log technical request data (such as IP addresses) for security and operations.</p>
      </section>
    </>
  );
}
