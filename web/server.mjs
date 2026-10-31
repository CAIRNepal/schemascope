#!/usr/bin/env node
// Web server for the site. Pages are rendered by the same templates as the static build (scripts/site.mjs),
// from data served by the API (backend/), so the site looks and behaves exactly as the static one did.
//
//   API_URL=http://127.0.0.1:8000 PORT=3000 node web/server.mjs
//
// Pages are rendered on first request and kept in a bounded cache. The server polls the API and switches to
// new data (a new evaluation run, an edited catalog) as soon as it has been ingested, without a restart.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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

// A response body with its ETag and, for text, a gzipped copy: compressed once, served many times.
const COMPRESSIBLE = /text|json|xml|javascript|svg|manifest/;
function prepare(body, type) {
  const gz = body.length > 1024 && COMPRESSIBLE.test(type) ? gzipSync(body, { level: 6 }) : null;
  return { body, gz, type, etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`, size: body.length + (gz?.length || 0) };
}

function render(site, key) {
  const hit = site.cache.get(key);
  if (hit) {
    site.cache.delete(key);
    site.cache.set(key, hit); // most recently used last
    return hit;
  }
  const make = site.files.get(key);
  if (!make) return null;
  const item = prepare(Buffer.from(make()), typeOf(key));
  site.cache.set(key, item);
  site.bytes += item.size;
  for (const [k, v] of site.cache) {
    if (site.bytes <= CACHE_MB * 1024 * 1024) break;
    site.cache.delete(k);
    site.bytes -= v.size;
  }
  return item;
}

// Static files (stylesheet, scripts, images, fonts), read and compressed once.
const staticCache = new Map();
function staticItem(file) {
  const mtime = statSync(file).mtimeMs;
  const hit = staticCache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const item = { ...prepare(readFileSync(file), typeOf(file)), mtime };
  staticCache.set(file, item);
  return item;
}

// ---------- API proxy ----------
// /api/, /mcp/ and the API docs are served by the API on the same origin, so sign-in cookies work and clients
// need one URL. The visitor's address goes along as X-Forwarded-For (rate limits are per visitor, not per server).
const PROXIED = /^\/(api|mcp)(\/|$)|^\/(docs|redoc|openapi\.json)(\/|$)/;
const api = new URL(API_URL);
function proxy(req, res) {
  if (req.url.startsWith("/api/site-data")) return send(req, res, 404, Buffer.from("Not found"), "text/plain");
  const headers = { ...req.headers, host: api.host, "x-forwarded-for": [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", "),
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "http", "x-forwarded-host": req.headers.host };
  const up = http.request({ hostname: api.hostname, port: api.port || 80, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (err) => {
    console.warn(`proxy: ${err.message}`);
    if (!res.headersSent) send(req, res, 502, Buffer.from(JSON.stringify({ type: "about:blank", title: "Bad Gateway", status: 502, detail: "The API is not reachable." })), "application/problem+json");
    else res.end();
  });
  req.pipe(up);
}

// ---------- HTTP ----------
function send(req, res, status, body, type, headers = {}) {
  sendItem(req, res, status, prepare(body, type), headers);
}

function sendItem(req, res, status, item, headers = {}) {
  if (status === 200 && req.headers["if-none-match"] === item.etag) {
    res.writeHead(304, { ETag: item.etag, ...headers });
    return res.end();
  }
  const gz = item.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const out = gz ? item.gz : item.body;
  res.writeHead(status, {
    "Content-Type": item.type, "Content-Length": out.length, ETag: item.etag, Vary: "Accept-Encoding",
    ...(gz ? { "Content-Encoding": "gzip" } : {}), ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : out);
}

function serveStatic(req, res, pathname, search) {
  for (const [prefix, dir] of STATIC_DIRS) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.join(dir, pathname.slice(prefix.length));
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) continue;
    // Pages link assets as /assets/x?v=<build id> and fonts by content hash: those never change, so cache them for a year.
    const immutable = /[?&]v=/.test(search) || pathname.startsWith("/assets/fonts/");
    sendItem(req, res, 200, staticItem(file), { ...extraHeaders(pathname), ...(immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : {}) });
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
    if (PROXIED.test(req.url)) return proxy(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, Buffer.from("Method not allowed"), "text/plain", { Allow: "GET, HEAD" });
    const url = new URL(req.url, "http://x");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    if (pathname.includes("\0") || pathname.split("/").includes("..")) return send(req, res, 400, Buffer.from("Bad request"), "text/plain");
    if (serveStatic(req, res, pathname, url.search)) return;

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
    const item = render(site, key);
    if (item) return sendItem(req, res, 200, item, { "Cache-Control": "public, max-age=0, must-revalidate", ...extraHeaders(pathname) });
    const notFound = render(site, "404.html");
    return notFound ? sendItem(req, res, 404, notFound) : send(req, res, 404, Buffer.from("Not found"), "text/plain; charset=utf-8");
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
