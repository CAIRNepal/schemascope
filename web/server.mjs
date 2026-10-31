#!/usr/bin/env node
// Web server for the site. Pages are rendered by the same templates as the static build (scripts/site.mjs),
// from data served by the API (backend/), so the site looks and behaves exactly as the static one did.
//
//   API_URL=http://127.0.0.1:8000 PORT=3000 node web/server.mjs
//
// Pages are rendered on first request and kept in a bounded cache. The server polls the API and switches to
// new data (a new evaluation run, an edited catalog) as soon as it has been ingested, without a restart.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createSite } from "../scripts/site.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_URL = (process.env.API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const CACHE_MB = Number(process.env.CACHE_MB || 128);
const STATIC_DIRS = [["/assets/", path.join(root, "src/assets")], ["/", path.join(root, "public")]];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".jsonld": "application/ld+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";

// Response headers from vercel.json, so CORS and caching match the static deployment.
const headerRules = (() => {
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
    return (cfg.headers || []).map((h) => ({
      re: new RegExp("^" + h.source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+\\\*/g, ".*").replace(/:\w+/g, "[^/]+") + "$"),
      headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])),
    }));
  } catch {
    return [];
  }
})();
const extraHeaders = (pathname) => Object.assign({}, ...headerRules.filter((r) => r.re.test(pathname)).map((r) => r.headers));

// ---------- site (data from the API, templates from scripts/site.mjs) ----------
let current = null; // { files, ingestedAt, cache: Map(path → Buffer), bytes }
let loading = null;

async function loadSite() {
  const t0 = Date.now();
  const res = await fetch(`${API_URL}/api/site-data`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const { files } = await createSite({ ...data, strict: false, buildId: Date.now().toString(36) });
  console.log(`site ready: ${files.size} files, data ingested ${data.ingestedAt}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { files, ingestedAt: data.ingestedAt, cache: new Map(), bytes: 0 };
}

async function ensureSite() {
  if (current) return current;
  loading ??= loadSite().finally(() => (loading = null));
  current = await loading;
  return current;
}

// Swap in new data once the API has ingested it; keep serving the old pages until the new ones are ready.
async function poll() {
  try {
    const h = await (await fetch(`${API_URL}/api/health`)).json();
    if (current && h.ingestedAt !== current.ingestedAt && !loading) {
      loading = loadSite();
      current = await loading;
      loading = null;
    }
  } catch (err) {
    loading = null;
    console.warn(`poll: ${err.message}`);
  }
}
setInterval(poll, POLL_SECONDS * 1000).unref();

function render(site, key) {
  const hit = site.cache.get(key);
  if (hit) {
    site.cache.delete(key);
    site.cache.set(key, hit); // most recently used last
    return hit;
  }
  const make = site.files.get(key);
  if (!make) return null;
  const body = Buffer.from(make());
  site.cache.set(key, body);
  site.bytes += body.length;
  for (const [k, v] of site.cache) {
    if (site.bytes <= CACHE_MB * 1024 * 1024) break;
    site.cache.delete(k);
    site.bytes -= v.length;
  }
  return body;
}

// ---------- HTTP ----------
function send(req, res, status, body, type, headers = {}) {
  const gz = body.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /text|json|xml|javascript|svg|manifest/.test(type);
  const out = gz ? gzipSync(body) : body;
  res.writeHead(status, { "Content-Type": type, "Content-Length": out.length, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}), ...headers });
  res.end(req.method === "HEAD" ? undefined : out);
}

function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of STATIC_DIRS) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.join(dir, pathname.slice(prefix.length));
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) continue;
    res.writeHead(200, { "Content-Type": typeOf(file), "Content-Length": statSync(file).size, ...extraHeaders(pathname) });
    if (req.method === "HEAD") return res.end(), true;
    createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

async function proxyRun(req, res, runId) {
  const r = await fetch(`${API_URL}/api/runs/${encodeURIComponent(runId)}/snapshot`);
  if (!r.ok) return false;
  send(req, res, 200, Buffer.from(await r.arrayBuffer()), "application/json; charset=utf-8", extraHeaders(`/runs/${runId}.json`));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, Buffer.from("Method not allowed"), "text/plain", { Allow: "GET, HEAD" });
    const url = new URL(req.url, "http://x");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    if (pathname.includes("\0") || pathname.split("/").includes("..")) return send(req, res, 400, Buffer.from("Bad request"), "text/plain");
    if (serveStatic(req, res, pathname)) return;

    // Archived run snapshots are large and immutable: stream them from the API instead of re-rendering.
    const run = pathname.match(/^\/runs\/([^/]+)\.json$/);
    if (run && run[1] !== "index" && (await proxyRun(req, res, run[1]))) return;

    const site = await ensureSite();
    const key = pathname === "/" ? "index.html" : pathname.endsWith("/") ? pathname.slice(1) + "index.html" : pathname.slice(1);
    // Same URLs as the static deployment (trailingSlash: true): /o/go → /o/go/.
    if (!pathname.endsWith("/") && !site.files.has(key) && site.files.has(key + "/index.html")) {
      res.writeHead(308, { Location: pathname + "/" + url.search });
      return res.end();
    }
    const body = render(site, key);
    if (body) return send(req, res, 200, body, typeOf(key), { "Cache-Control": "public, max-age=0, must-revalidate", ...extraHeaders(pathname) });
    const notFound = render(site, "404.html");
    return send(req, res, 404, notFound || Buffer.from("Not found"), "text/html; charset=utf-8");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(req, res, 503, Buffer.from("The catalog is temporarily unavailable."), "text/plain; charset=utf-8");
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`web: http://${HOST}:${PORT} (API ${API_URL})`);
  ensureSite().catch((err) => console.error(`first load failed (will retry on request): ${err.message}`));
});
