#!/usr/bin/env node
// Tiny local preview server for dist/ (mirrors Vercel's trailing-slash routing).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");
const port = Number(process.env.PORT || 3300);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jsonld": "application/ld+json", ".svg": "image/svg+xml", ".xml": "application/xml", ".txt": "text/plain" };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, p);
  if (!file.startsWith(dist)) return res.writeHead(400).end();
  try {
    if ((await stat(file)).isDirectory()) {
      if (!p.endsWith("/")) return res.writeHead(308, { Location: p + "/" }).end();
      file = path.join(file, "index.html");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": types[".html"] }).end(await readFile(path.join(dist, "404.html")).catch(() => "Not found"));
  }
}).listen(port, () => console.log(`Preview at http://localhost:${port}`));
