#!/usr/bin/env node
// Ontology quality checks, run locally by the maintainer: writes data/quality/<id>.json.
// ROBOT runs from ROBOT_JAR (needs Java) or from a Docker image (ROBOT_IMAGE, built from docker/robot).
//   - ROBOT reason (ELK): logical consistency and unsatisfiable classes
//   - ROBOT report: errors / warnings / info
//   - OOPS! (OntOlogy Pitfall Scanner) REST service: critical / important / minor pitfalls
// Ontologies already checked by the OBO Dashboard skip the ROBOT step (the dashboard result is used).
// Env: ROBOT_JAR (path to robot.jar), ONLY=id1,id2, MAX_MB (default 150), SKIP_OOPS=1
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync, createWriteStream, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { isOntology } from "./rubric.mjs";
import { outData, trackedData } from "./paths.mjs";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const outDir = path.join(outData, "quality");
const trackedDir = path.join(trackedData, "quality");
const work = path.join(os.tmpdir(), "schemascope-quality");
const ROBOT_JAR = process.env.ROBOT_JAR || null;
const ROBOT_IMAGE = process.env.ROBOT_IMAGE || null;
const ROBOT = ROBOT_JAR || ROBOT_IMAGE;
// Run a ROBOT command; host paths under `work` are mapped to /work inside the container.
// Run a container with a unique name and kill it on timeout (killing the docker client alone leaves it running).
let seq = 0;
async function dockerRun(image, volume, args, timeoutMs) {
  const name = `${path.basename(root)}-q-${process.pid}-${++seq}`;
  try {
    return await run("docker", ["run", "--rm", "--name", name, "--memory", process.env.DOCKER_MEMORY || "8g", "-v", volume, image, ...args], { maxBuffer: 1 << 28, timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (e) {
    await run("docker", ["kill", name]).catch(() => {});
    throw e;
  }
}

function robot(args, opts = {}) {
  if (ROBOT_JAR) return run("java", ["-Xmx6G", "-jar", ROBOT_JAR, ...args], opts);
  const mapped = args.map((a) => (typeof a === "string" && a.startsWith(work) ? "/work" + a.slice(work.length) : a));
  return dockerRun(ROBOT_IMAGE, `${work}:/work`, mapped, opts.timeout || 30 * 60e3);
}
const MAX_MB = Number(process.env.MAX_MB || 150);
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
await mkdir(outDir, { recursive: true });
await mkdir(work, { recursive: true });

const dash = await fetch("https://dashboard.obofoundry.org/dashboard/dashboard-results.json").then((r) => r.json()).catch(() => ({ ontologies: [] }));
const onDashboard = new Set((dash.ontologies || []).map((o) => o.namespace));

const robotVersion = ROBOT ? (await robot(["--version"]).catch(() => ({ stdout: "" }))).stdout.trim() || null : null;

async function download(url, file) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "schemascope-quality/1.0 (+https://schemascope.org)", Accept: "text/turtle, application/rdf+xml;q=0.9, application/owl+xml;q=0.8, application/ld+json;q=0.7, */*;q=0.1" } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_MB * 1e6) throw new Error(`file is ${(len / 1e6).toFixed(0)} MB (limit ${MAX_MB} MB)`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const head = (await readFile(file, { encoding: "utf8" })).slice(0, 2000).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) throw new Error(`resolves to an HTML page (${res.url}), not the ontology file`);
  const size = (await stat(file)).size;
  if (size > MAX_MB * 1e6) throw new Error(`file is ${(size / 1e6).toFixed(0)} MB (limit ${MAX_MB} MB)`);
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

// One chained ROBOT run (the ontology is loaded once): report → reason (ELK) → validate-profile (OWL 2 DL).
// The chain stops at the first failing step, which tells us which check failed.
async function robotChecks(file) {
  const result = { reasoner: "ELK", robotVersion };
  const rep = path.join(work, "report.tsv"), unsat = path.join(work, "unsat.ofn"), prof = path.join(work, "profile.txt");
  for (const f of [rep, unsat, prof]) await rm(f, { force: true });
  const opts = { maxBuffer: 1 << 26, timeout: 30 * 60e3 };
  const r = await robot(["report", "--input", file, "--fail-on", "none", "--output", rep,
    "reason", "--reasoner", "ELK", "--equivalent-classes-allowed", "all", "--dump-unsatisfiable", unsat,
    "validate-profile", "--profile", "DL", "--output", prof], opts).then(
    () => ({ ok: true, out: "" }),
    (e) => ({ ok: false, out: `${e.stdout || ""}${e.stderr || ""}`, killed: e.killed })
  );
  const reasoned = existsSync(prof); // validate-profile only runs after a successful reason step
  if (r.ok) Object.assign(result, { consistent: true, unsatisfiable: 0, owl2dl: true });
  else if (reasoned) Object.assign(result, { consistent: true, unsatisfiable: 0, owl2dl: false });
  else if (/inconsistent/i.test(r.out)) Object.assign(result, { consistent: false, unsatisfiable: null });
  else if (/unsatisfiable/i.test(r.out)) {
    const n = existsSync(unsat) ? ((await readFile(unsat, "utf8")).match(/^Declaration\(Class/gm) || []).length : null;
    Object.assign(result, { consistent: true, unsatisfiable: n ?? 1 });
  } else Object.assign(result, { consistent: null, reasonError: (r.killed ? "timed out; " : "") + r.out.slice(-400) });
  // If the reasoner stopped the chain, the profile wasn't checked yet.
  if (result.owl2dl === undefined && result.consistent !== null)
    result.owl2dl = await robot(["validate-profile", "--input", file, "--profile", "DL", "--output", prof], opts).then(() => true, () => false);
  if (existsSync(rep)) {
    const rows = (await readFile(rep, "utf8")).split("\n").slice(1).filter(Boolean);
    const count = (lvl) => rows.filter((l) => l.startsWith(lvl)).length;
    result.robot = { ERROR: count("ERROR"), WARN: count("WARN"), INFO: count("INFO") };
  }
  for (const f of [rep, unsat, prof]) await rm(f, { force: true });
  return result;
}

// OOPS! REST: POST XML, response lists pitfalls with an importance level.
async function oops(url) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><OOPSRequest><OntologyURI></OntologyURI><OntologyContent></OntologyContent><OntologyUrl>${url}</OntologyUrl><Pitfalls></Pitfalls><OutputFormat>RDF/XML</OutputFormat></OOPSRequest>`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180e3);
  try {
    const res = await fetch("https://oops.linkeddata.es/rest", { method: "POST", headers: { "Content-Type": "application/xml" }, body, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    const xml = await res.text();
    const levels = [...xml.matchAll(/hasImportanceLevel[^>]*>\s*(Critical|Important|Minor)\s*</gi)].map((m) => m[1].toLowerCase());
    const codes = [...xml.matchAll(/hasCode[^>]*>\s*(P\d+)\s*</gi)].map((m) => m[1]);
    return { critical: levels.filter((l) => l === "critical").length, important: levels.filter((l) => l === "important").length, minor: levels.filter((l) => l === "minor").length, pitfalls: codes, service: "https://oops.linkeddata.es/rest", checkedAt: new Date().toISOString() };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(t);
  }
}

// Pitfall scan, in order of preference:
//   1. OOPS! CLI in a local Docker container (OOPS_IMAGE, built from docker/oops) — no external dependency
//   2. the public OOPS! web service
//   3. SchemaScope's Python scan of the OOPS! pitfalls that are purely structural (scripts/pitfalls.py)
const OOPS_IMAGE = process.env.OOPS_IMAGE || null;
// Use the first Python that has rdflib (PYTHON env var wins); see requirements.txt.
const PY = await (async () => {
  for (const py of [process.env.PYTHON, "python3", "/opt/homebrew/bin/python3", "/opt/anaconda3/bin/python3", "/usr/local/bin/python3", "python"].filter(Boolean)) {
    try {
      await run(py, ["-c", "import rdflib"]);
      return py;
    } catch {}
  }
  console.warn("! No Python with rdflib found (pip install -r requirements.txt); OOPS! reports can't be parsed and the Python scan is unavailable.");
  return "python3";
})();
const PY_MAX_MB = Number(process.env.PY_MAX_MB || 80);
const pyJson = async (args) => JSON.parse((await run(PY, [path.join(root, "scripts/pitfalls.py"), ...args], { maxBuffer: 1 << 26, timeout: 30 * 60e3 })).stdout);

async function oopsDocker(file) {
  const dir = path.dirname(file);
  const report = path.join(dir, "tstOut.model.ttl");
  await rm(report, { force: true });
  await dockerRun(OOPS_IMAGE, `${dir}:/work`, ["--input-file", `/work/${path.basename(file)}`], Number(process.env.OOPS_TIMEOUT_MIN || 10) * 60e3);
  if (!existsSync(report)) throw new Error("OOPS! produced no report");
  const r = await pyJson(["parse-oops", report]);
  await rm(report, { force: true });
  if (r.error) throw new Error(r.error);
  return r;
}

async function pitfallScan(e, file) {
  const attempts = [];
  if (OOPS_IMAGE && file && (await stat(file)).size <= Number(process.env.OOPS_MAX_MB || 20) * 1e6) {
    try {
      return { ...(await oopsDocker(file)), engine: "OOPS! (local Docker)", attempts };
    } catch (err) {
      attempts.push(`local OOPS!: ${err.message.slice(0, 200)}`);
    }
  }
  if (!process.env.SKIP_OOPS_WEB) {
    const o = await oops(e.download);
    if (!o.error) return { ...o, engine: "OOPS! web service", attempts };
    attempts.push(`OOPS! web service: ${o.error}`);
  }
  if (file && (await stat(file)).size <= PY_MAX_MB * 1e6) {
    try {
      const r = await pyJson(["scan", file]);
      if (!r.error) return { ...r, attempts };
      attempts.push(`Python scan: ${r.error}`);
    } catch (err) {
      attempts.push(`Python scan: ${err.message.slice(0, 200)}`);
    }
  } else if (file) attempts.push(`Python scan: file larger than ${PY_MAX_MB} MB`);
  return { error: "no pitfall scanner succeeded", attempts };
}

// Incremental: never-checked ontologies first, then the oldest checks; stop when the time budget runs out.
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 120);
const deadline = Date.now() + MAX_MINUTES * 60e3;
const lastChecked = (id) => {
  for (const d of [outDir, trackedDir]) {
    const f = path.join(d, `${id}.json`);
    if (existsSync(f)) try { return JSON.parse(readFileSync(f, "utf8")).checkedAt || ""; } catch {}
  }
  return "";
};
const targets = catalog
  .filter((e) => isOntology(e) && e.download && (!only || only.has(e.id)))
  .map((e) => ({ e, at: lastChecked(e.id) }))
  .sort((a, b) => a.at.localeCompare(b.at))
  .map((x) => x.e);
console.log(`Quality checks for ${targets.length} ontologies (ROBOT: ${robotVersion || "not available"}; OOPS! image: ${OOPS_IMAGE || "none"})`);
let checked = 0;
for (const e of targets) {
  if (Date.now() > deadline) {
    console.log(`Time budget of ${MAX_MINUTES} min reached after ${checked} ontologies; the rest will be checked first next run.`);
    break;
  }
  checked++;
  const out = path.join(outDir, `${e.id}.json`);
  const prevFile = [out, path.join(trackedDir, `${e.id}.json`)].find(existsSync);
  const prev = prevFile ? JSON.parse(await readFile(prevFile, "utf8")) : {};
  const rec = { id: e.id, artefact: e.download, checkedAt: new Date().toISOString() };
  const dir = path.join(work, e.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "ontology.owl");
  let have = false;
  try {
    rec.sha256 = await download(e.download, file);
    have = true;
  } catch (err) {
    rec.downloadError = err.message;
  }
  // Consistency: OBO Dashboard ontologies are already reasoned over there.
  if (ROBOT && have && !onDashboard.has(e.obo)) {
    try {
      rec.robot = { ...(await robotChecks(file)), checkedAt: new Date().toISOString(), sha256: rec.sha256 };
    } catch (err) {
      rec.robot = prev.robot ? { ...prev.robot, stale: true, staleReason: err.message } : { error: err.message };
    }
  } else if (prev.robot) rec.robot = prev.robot;
  if (!process.env.SKIP_OOPS) {
    const o = await pitfallScan(e, have ? file : null);
    rec.oops = o.error && prev.oops && !prev.oops.error ? { ...prev.oops, stale: true, staleReason: o.attempts?.join("; ") } : { ...o, checkedAt: new Date().toISOString(), sha256: rec.sha256 };
  } else if (prev.oops) rec.oops = prev.oops;
  await rm(dir, { recursive: true, force: true });
  await writeFile(out, JSON.stringify(rec, null, 2) + "\n");
  console.log(`  ${e.id}: ${rec.robot ? (rec.robot.error ? `robot error (${rec.robot.error})` : `consistent=${rec.robot.consistent} unsat=${rec.robot.unsatisfiable} dl=${rec.robot.owl2dl} report=${JSON.stringify(rec.robot.robot || {})}`) : "robot skipped"}; pitfalls ${rec.oops?.error ? `unavailable (${rec.oops.attempts?.join(" | ")})` : rec.oops ? `${rec.oops.critical}C/${rec.oops.important}I/${rec.oops.minor}M via ${rec.oops.engine}` : "skipped"}`);
}
