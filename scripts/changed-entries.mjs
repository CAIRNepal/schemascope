#!/usr/bin/env node
// Prints the ids of catalog entries that differ from a git ref (default: origin/main).
// Usage: node scripts/changed-entries.mjs [ref]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ref = process.argv[2] || "origin/main";
const now = JSON.parse(readFileSync("data/catalog.json", "utf8"));
let before = [];
try {
  // The default 1 MB output limit is smaller than the catalog; hitting it made every entry look changed.
  before = JSON.parse(execFileSync("git", ["show", `${ref}:data/catalog.json`], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
} catch (err) {
  // No catalog at that ref (e.g. a new repo): every entry is new. Anything else is a real error.
  if (!/does not exist|exists on disk, but not in|invalid object name|unknown revision/i.test(String(err.stderr || err.message))) throw err;
}
const old = Object.fromEntries(before.map((e) => [e.id, JSON.stringify(e)]));
console.log(now.filter((e) => old[e.id] !== JSON.stringify(e)).map((e) => e.id).join(","));
