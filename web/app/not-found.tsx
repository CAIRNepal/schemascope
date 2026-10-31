import Link from "next/link";

export default function NotFound() {
  return (
    <section className="page-head wrap">
      <h1>Not found</h1>
      <p className="lede">There is no page here. Try the <Link href="/catalog/">catalog</Link> or the <Link href="/">home page</Link>.</p>
    </section>
  );
}
