#!/usr/bin/env node
// Ontology quality checks, run locally by the maintainer: writes data/quality/<id>.json.
// ROBOT runs from ROBOT_JAR (needs Java) or from a Docker image (ROBOT_IMAGE, built from docker/robot).
//   - ROBOT reason (ELK): logical consistency and unsatisfiable classes
//   - ROBOT report: errors / warnings / info
//   - OOPS! (OntOlogy Pitfall Scanner) REST service: critical / important / minor pitfalls
// Ontologies already checked by the OBO Dashboard skip the ROBOT step (the dashboard result is used).
// Env: ROBOT_JAR (path to robot.jar), ONLY=id1,id2, MAX_MB (default 5000), PY_MAX_MB (default 5000), SKIP_OOPS=1
import { readFile, writeFile, mkdir, rm, stat, open } from "node:fs/promises";
import { existsSync, createWriteStream, createReadStream, readFileSync } from "node:fs";
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
import { scanArtefact, namespaceMap } from "./artefact-scan.mjs";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, "data/catalog.json"), "utf8"));
const outDir = path.join(outData, "quality");
const trackedDir = path.join(trackedData, "quality");
const work = path.join(os.tmpdir(), "schemascope-quality");
const ROBOT_JAR = process.env.ROBOT_JAR || null;
const ROBOT_IMAGE = process.env.ROBOT_IMAGE || null;
const ROBOT = ROBOT_JAR || ROBOT_IMAGE;
// Java heap for ROBOT: large ontologies (GO, MONDO, FMA) need a lot. By default, 2 GB less than Docker has
// (between 4 and 12 GB); with Docker Desktop, raise its memory limit to check the biggest ontologies.
const dockerGb = ROBOT_IMAGE ? Math.floor(Number((await run("docker", ["info", "--format", "{{.MemTotal}}"]).catch(() => ({ stdout: "0" }))).stdout.trim()) / 2 ** 30) : 0;
// Ontologies checked at once (QUALITY_JOBS, default 1). Docker's memory is shared between them.
const JOBS = Math.max(1, Number(process.env.QUALITY_JOBS || 1));
const ROBOT_HEAP = process.env.ROBOT_HEAP || `${dockerGb ? Math.max(2, Math.min(12, Math.floor((dockerGb - 2) / JOBS))) : 6}g`;
// Run a ROBOT command; host paths under `work` are mapped to /work inside the container.
// Run a container with a unique name and kill it on timeout (killing the docker client alone leaves it running).
let seq = 0;
async function dockerRun(image, volume, args, timeoutMs, { memory = process.env.DOCKER_MEMORY || "8g", env = {} } = {}) {
  const name = `${path.basename(root)}-q-${process.pid}-${++seq}`;
  try {
    return await run("docker", ["run", "--rm", "--name", name, "--memory", memory, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-v", volume, image, ...args], { maxBuffer: 1 << 28, timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (e) {
    await run("docker", ["kill", name]).catch(() => {});
    throw e;
  }
}

function robot(args, opts = {}) {
  if (ROBOT_JAR) return run("java", [`-Xmx${ROBOT_HEAP}`, "-jar", ROBOT_JAR, ...args], opts);
  const mapped = args.map((a) => (typeof a === "string" && a.startsWith(work) ? "/work" + a.slice(work.length) : a));
  return dockerRun(ROBOT_IMAGE, `${work}:/work`, mapped, opts.timeout || 30 * 60e3, { memory: process.env.DOCKER_MEMORY || `${(parseInt(ROBOT_HEAP, 10) || 6) + 2}g`, env: { ROBOT_HEAP } });
}
const MAX_MB = Number(process.env.MAX_MB || 5000); // download limit (5 GB)
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
await mkdir(outDir, { recursive: true });
await mkdir(work, { recursive: true });


const robotVersion = ROBOT ? (await robot(["--version"]).catch(() => ({ stdout: "" }))).stdout.trim() || null : null;

async function download(url, file) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "schemascope-quality/1.0 (+https://schemascope.org)", Accept: "text/turtle, application/rdf+xml;q=0.9, application/owl+xml;q=0.8, application/ld+json;q=0.7, */*;q=0.1" } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_MB * 1e6) throw new Error(`file is ${(len / 1e6).toFixed(0)} MB (limit ${MAX_MB} MB)`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  // Read just the start and stream the hash: large files don't fit in memory as one string or buffer.
  const fh = await open(file);
  const { buffer, bytesRead } = await fh.read(Buffer.alloc(2000), 0, 2000, 0);
  await fh.close();
  const head = buffer.subarray(0, bytesRead).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) throw new Error(`resolves to an HTML page (${res.url}), not the ontology file`);
  const size = (await stat(file)).size;
  if (size > MAX_MB * 1e6) throw new Error(`file is ${(size / 1e6).toFixed(0)} MB (limit ${MAX_MB} MB)`);
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
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
const PY_MAX_MB = Number(process.env.PY_MAX_MB || 5000); // Python pitfall scan limit (5 GB; large files need a lot of memory)
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
// QUALITY_SKIP_DAYS=N skips ontologies checked in the last N days, so a long run can be stopped and resumed.
const skipDays = Number(process.env.QUALITY_SKIP_DAYS || 0);
const fresh = (id) => skipDays > 0 && Date.parse(lastChecked(id) || 0) > Date.now() - skipDays * 864e5;
const targets = catalog
  .filter((e) => isOntology(e) && e.download && (!only || only.has(e.id)) && !fresh(e.id))
  .map((e) => ({ e, at: lastChecked(e.id) }))
  .sort((a, b) => a.at.localeCompare(b.at))
  .map((x) => x.e);
console.log(`Quality checks for ${targets.length} ontologies (ROBOT: ${robotVersion ? `${robotVersion}, ${ROBOT_HEAP} heap` : "not available"}; OOPS! image: ${OOPS_IMAGE || "none"})`);
const nsMap = namespaceMap(catalog);
let checked = 0, stopped = false;
async function checkOne(e) {
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
  // What the file imports and whose terms it uses (for I3 and upper-ontology alignment).
  if (have) {
    try {
      rec.artefactScan = { ...(await scanArtefact(file, { nsMap, self: [e.id, e.obo, e.ols, e.bioregistry], selfHosts: [e.download, e.homepage].filter(Boolean) })), sha256: rec.sha256 };
    } catch (err) {
      rec.artefactScan = { error: err.message };
    }
  } else if (prev.artefactScan) rec.artefactScan = { ...prev.artefactScan, stale: true };
  // Every ontology is reasoned over here, OBO Dashboard ones too, so scores don't depend on an outside service.
  if (ROBOT && have) {
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
  const scan = rec.artefactScan && !rec.artefactScan.error ? `; imports ${rec.artefactScan.imports.length}, uses ${Object.keys(rec.artefactScan.uses).length} vocabularies` : "";
  console.log(`  ${e.id}: ${rec.downloadError ? `download failed (${rec.downloadError}); ` : ""}${rec.robot ? (rec.robot.error ? `robot error (${rec.robot.error})` : `consistent=${rec.robot.consistent} unsat=${rec.robot.unsatisfiable} dl=${rec.robot.owl2dl} report=${JSON.stringify(rec.robot.robot || {})}`) : "robot skipped"}; pitfalls ${rec.oops?.error ? `unavailable (${rec.oops.attempts?.join(" | ") || "nothing to scan"})` : rec.oops ? `${rec.oops.critical}C/${rec.oops.important}I/${rec.oops.minor}M via ${rec.oops.engine}` : "skipped"}${scan}`);
}
// A small worker pool: each worker takes the next ontology until the list or the time budget runs out.
const queue = [...targets];
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) {
    if (Date.now() > deadline) {
      stopped = true;
      return;
    }
    const e = queue.shift();
    checked++;
    try {
      await checkOne(e);
    } catch (err) {
      console.log(`  ${e.id}: check failed (${err.message.slice(0, 200)})`);
    }
  }
}));
if (stopped) console.log(`Time budget of ${MAX_MINUTES} min reached after ${checked} ontologies; the rest will be checked first next run.`);

// Coverage across the whole catalog, so it's clear how far the checks have got.
{
  const all = catalog.filter((e) => isOntology(e) && e.download);
  let robotDone = 0, scanDone = 0, never = 0, failed = 0;
  for (const e of all) {
    const f = [path.join(outDir, `${e.id}.json`), path.join(trackedDir, `${e.id}.json`)].find(existsSync);
    if (!f) { never++; continue; }
    const q = JSON.parse(readFileSync(f, "utf8"));
    if (q.robot && !q.robot.error && q.robot.consistent !== undefined) robotDone++;
    else failed++;
    if (q.artefactScan && !q.artefactScan.error) scanDone++;
  }
  console.log(`Coverage: ${all.length} ontologies with a download; ROBOT results for ${robotDone}, imports read for ${scanDone}, checked without a ROBOT result ${failed}, never checked ${never}.`);
}
