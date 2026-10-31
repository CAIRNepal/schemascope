// Copy the site's stylesheet, icons and brand images from ../src/assets (shared with the static build) into public/.
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(web, "..", "src", "assets");
const to = path.join(web, "public", "assets");
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true, filter: (src) => !/\.(js)$/.test(src) });
console.log(`assets: ${path.relative(web, from)} → ${path.relative(web, to)}`);
