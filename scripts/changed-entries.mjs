#!/usr/bin/env node
// Prints the ids of catalog entries that differ from a git ref (default: origin/main).
// Usage: node scripts/changed-entries.mjs [ref]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ref = process.argv[2] || "origin/main";
const now = JSON.parse(readFileSync("data/catalog.json", "utf8"));
let before = [];
try {
  before = JSON.parse(execFileSync("git", ["show", `${ref}:data/catalog.json`], { encoding: "utf8" }));
} catch {}
const old = Object.fromEntries(before.map((e) => [e.id, JSON.stringify(e)]));
console.log(now.filter((e) => old[e.id] !== JSON.stringify(e)).map((e) => e.id).join(","));
