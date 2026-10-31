// Crawl a running site and report every internal link (and API link) that does not work.
//   node scripts/check-links.mjs http://localhost:3000 [http://localhost:8000]
// Follows links from the home page. Entry, category and catalog-query pages are sampled (MAX_PER_GROUP)
// so a crawl of thousands of entries stays quick; every other page is visited.
const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const apiBase = (process.argv[3] || "").replace(/\/$/, "");
const MAX_PER_GROUP = Number(process.env.MAX_PER_GROUP || 25);

const group = (p) => {
  const u = new URL(p, base);
  if (u.pathname.startsWith("/o/")) return "/o/*";
  if (u.pathname.startsWith("/category/")) return u.search ? "/category/*?…" : "/category/*";
  if (u.pathname.startsWith("/api/entries/")) return "/api/entries/*";
  if (u.pathname.startsWith("/api/runs/")) return "/api/runs/*";
  return u.search ? `${u.pathname}?…` : u.pathname;
};

const seen = new Set();
const perGroup = new Map();
const failures = [];
const queue = [["/", "(start)"]];
let checked = 0;

function enqueue(href, from) {
  let url;
  try {
    url = new URL(href, base + from);
  } catch {
    return;
  }
  const isSite = url.origin === new URL(base).origin;
  const isApi = apiBase && url.href.startsWith(apiBase);
  if (!isSite && !isApi) return;
  if (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/assets/") && !isApi) return;
  url.hash = "";
  const key = isApi ? url.href : url.pathname + url.search;
  if (seen.has(key)) return;
  const g = (isApi ? "api:" : "") + group(isApi ? url.pathname : key);
  const n = perGroup.get(g) || 0;
  if (n >= MAX_PER_GROUP) return;
  perGroup.set(g, n + 1);
  seen.add(key);
  queue.push([key, from]);
}

while (queue.length) {
  const batch = queue.splice(0, 8);
  await Promise.all(
    batch.map(async ([key, from]) => {
      const url = key.startsWith("http") ? key : base + key;
      checked++;
      let res;
      try {
        res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
      } catch (err) {
        failures.push({ url: key, from, status: `error: ${err.message}` });
        return;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) failures.push({ url: key, from, status: `${res.status} without Location` });
        else enqueue(loc, key.startsWith("http") ? "/" : key);
        return;
      }
      if (res.status >= 400) {
        failures.push({ url: key, from, status: res.status });
        return;
      }
      if (!(res.headers.get("content-type") || "").includes("text/html")) return;
      const html = await res.text();
      for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
        const href = m[1].replace(/&amp;/g, "&");
        if (/^(mailto:|tel:|javascript:|#)/.test(href)) continue;
        enqueue(href, key.startsWith("http") ? "/" : key);
      }
    }),
  );
}

console.log(`Checked ${checked} URLs on ${base}${apiBase ? ` and ${apiBase}` : ""} (${perGroup.size} groups, up to ${MAX_PER_GROUP} each).`);
for (const [g, n] of [...perGroup].sort()) console.log(`  ${String(n).padStart(4)}  ${g}`);
if (failures.length) {
  console.log(`\n${failures.length} broken:`);
  for (const f of failures) console.log(`  ${f.status}  ${f.url}  (linked from ${f.from})`);
  process.exit(1);
}
console.log("\nNo broken links.");
