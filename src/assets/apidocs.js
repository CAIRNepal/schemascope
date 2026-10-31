// Developer hub (/api-docs/): overview, REST API (quickstart, guides, every endpoint from /openapi.json with live
// "Try it"), and MCP server (client setup, tools, workflow, troubleshooting). Hash-routed, rendered in the browser.
// Every URL is this site's own address; nothing is hard-coded.
(() => {
  const root = document.querySelector("[data-devhub]");
  if (!root) return;
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const D = root.dataset;
  const BRAND = D.brand, SLUG = D.slug, ORIGIN = location.origin;
  const ENV = SLUG.toUpperCase().replace(/-/g, "_") + "_TOKEN";
  const token = () => { try { return sessionStorage.getItem("new-mcp-token"); } catch { return null; } };
  const state = { open: new Set(), cfg: { tokenPrefix: "…_pat_", rateLimit: {} }, spec: null, session: null, client: store.get("dh-client") || "claude-code", lang: store.get("dh-lang") || "cURL" };
  const SAMPLE = { entry_id: D.entry, cat_id: D.category, run_id: D.run, name: "roadmap" };

  // ---------- building blocks ----------
  // A code block; with `run` (a path on this site) it gets a Run button that shows the live response below it.
  // Tokens are shown masked (prefix…last 4); Copy still copies the full text.
  const mask = (t) => `${t.slice(0, t.indexOf("_pat_") + 5 || 8)}…${t.slice(-4)}`;
  const code = (text, label = "cURL", { raw = false, run = null } = {}) => {
    const secrets = [token(), savedToken()].filter((x) => x && x.length > 12 && text.includes(x));
    const shown = secrets.reduce((acc, x) => acc.split(x).join(mask(x)), text);
    return `<div class="dh-code"><div class="dh-codehead"><span>${esc(label)}</span><span class="dh-actions">${run ? `<button type="button" class="dh-run" data-run="${esc(run)}">Run ▶</button>` : ""}<button type="button" class="dh-copy" data-copy${secrets.length ? ` data-full="${esc(text)}"` : ""}>Copy</button></span></div><pre>${raw ? shown : esc(shown)}</pre></div>${run ? `<div class="dh-out" data-run-out></div>` : ""}`;
  };
  const savedToken = () => { try { return sessionStorage.getItem("dh-token") || ""; } catch { return ""; } };
  // Calls this site's API (same origin: your signed-in session is used, or the token you entered on this page).
  async function call(path, { method = "GET", body = null } = {}) {
    const headers = { Accept: "application/json" };
    if (savedToken()) headers.Authorization = `Bearer ${savedToken()}`;
    if (body) headers["Content-Type"] = "application/json";
    const t0 = performance.now();
    const r = await fetch(path, { method, headers, body: body || undefined, credentials: "same-origin" });
    const ms = Math.round(performance.now() - t0);
    const raw = await r.text();
    let text = raw;
    try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
    if (text.length > 8000) text = text.slice(0, 8000) + "\n… (truncated)";
    const lim = r.headers.get("x-ratelimit-limit"), left = r.headers.get("x-ratelimit-remaining");
    return `<div class="dh-response ${r.ok ? "ok" : "err"}"><div class="dh-codehead"><span><b class="dh-status">${r.status} ${esc(r.statusText || "")}</b> · ${esc(method)} ${esc(path)} · ${ms} ms${lim ? ` · ${left}/${lim} requests left this minute` : ""}</span><button type="button" class="dh-copy" data-copy>Copy</button></div><pre>${esc(text || "(empty response)")}</pre></div>`;
  }
  const step = (n, t, html) => `<section class="dh-step"><div class="dh-step-n">${n}</div><div class="dh-step-body"><h3>${t}</h3>${html}</div></section>`;
  const outcome = (html) => `<div class="dh-outcome"><span>What you get back</span><p>${html}</p></div>`;
  const facts = (items) => `<div class="dh-facts">${items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
  const tokenBox = () => `<div class="dh-tokenbox"><label>Your token <small>optional · kept in this tab only</small><input type="password" data-token-input placeholder="${esc(state.cfg.tokenPrefix)}…" value="${esc(savedToken())}" autocomplete="off"></label><span class="dh-muted">${state.session?.user ? `Signed in as @${esc(state.session.user.login)}: requests from this page use your session.` : `Not signed in: requests run anonymously unless you paste a token.`}</span></div>`;
  const hero = (label, title, desc) => `<section class="dh-hero"><div class="dh-hero-copy"><div class="dh-eyebrow"><span></span>${esc(label)}</div><h1>${title}</h1><p class="dh-lead">${desc}</p></div>
    <div class="dh-orbital" aria-hidden="true"><div class="dh-orbit o1"></div><div class="dh-orbit o2"></div><div class="dh-orbit o3"></div><span class="dh-star s1"></span><span class="dh-star s2"></span><span class="dh-star s3"></span>
      <div class="dh-core"><svg viewBox="0 0 70 70" fill="none" stroke="currentColor"><path d="m35 12 23 13v22L35 60 12 47V25zM12 25l23 13 23-13M35 38v22M35 12v26M12 47l23-13 23 13"/><circle cx="35" cy="12" r="3"/><circle cx="58" cy="25" r="3"/><circle cx="12" cy="47" r="3"/><circle cx="35" cy="60" r="3"/></svg></div>
      <span class="dh-olabel l1">SCHEMAS</span><span class="dh-olabel l2">ONTOLOGIES</span><span class="dh-olabel l3">STANDARDS</span></div>
    <div class="dh-meta"><a href="#api">REST API <i>↗</i></a><b></b><a href="#mcp">MODEL CONTEXT PROTOCOL <i>↗</i></a></div></section>`;
  const title = (t, sub = "") => `<div class="dh-title"><h2>${t}</h2>${sub ? `<span>${sub}</span>` : ""}</div>`;
  const callout = (html, kind = "") => `<div class="dh-callout ${kind}">${html}</div>`;
  const resources = (items) => `<div class="dh-resources">${items.map(([href, t, d]) => `<a class="dh-resource" href="${href}"><div><b>${t}</b>${d ? `<p>${d}</p>` : ""}</div><span>↗</span></a>`).join("")}</div>`;
  const tokenText = () => token() || "<your token>";
  const signin = () => (state.session?.user ? `/account/#tokens` : `/api/auth/github/login?next=${encodeURIComponent("/account/#tokens")}`);

  // ---------- navigation ----------
  const endpointPages = () => {
    if (!state.spec) return [];
    const out = [];
    for (const tag of state.spec.tags || []) {
      const ops = [];
      for (const [path, item] of Object.entries(state.spec.paths))
        for (const [method, op] of Object.entries(item))
          if ((op.tags || [])[0] === tag.name) ops.push([`ep-${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`, op.summary || path, method, path, op]);
      if (ops.length) out.push([tag.name, ops]);
    }
    return out;
  };
  const GROUPS = () => ({
    overview: [["Get started", [["overview", "Overview"], ["api", "REST API"], ["mcp", "MCP server"]]], ["Explore", [["guide", "Choose your integration"], ["examples", "Examples"]]]],
    api: [["REST API", [["api", "Quickstart"], ["authentication", "Authentication"], ["rate-limits", "Rate limits"], ["pagination", "Search & pagination"]]],
      ...endpointPages().map(([tag, ops]) => [`Reference · ${tag}`, ops.map(([id, name, method]) => [id, name, method])]),
      ["Support", [["errors", "Errors & responses"]]]],
    mcp: [["MCP server", [["mcp", "Overview"], ["connect", "Connect your client"]]], ["Reference", [["tools", "Available tools"], ["workflow", "Example workflow"]]], ["Support", [["troubleshooting", "Troubleshooting"]]]],
  });
  const sectionOf = (page) => {
    const g = GROUPS();
    for (const s of ["api", "mcp"]) if (g[s].some(([, items]) => items.some(([id]) => id === page))) return s;
    return "overview";
  };
  const exists = (page) => Object.values(GROUPS()).some((g) => g.some(([, items]) => items.some(([id]) => id === page)));
  let page = "overview", section = "overview";

  // Toggle one group without losing the reader's place in the sidebar.
  function renderNavKeep(group, open) {
    const side = $("[data-dh-side]");
    const top = side.scrollTop;
    if (open) state.open.add(group); else { state.open.delete(group); state.forceClosed = group; }
    renderNav();
    side.scrollTop = top;
  }
  function renderNav() {
    $("[data-dh-switch]").innerHTML = [["overview", "Overview"], ["api", "REST API"], ["mcp", "MCP"]]
      .map(([s, l]) => `<button type="button" role="tab" aria-selected="${section === s}" class="${section === s ? "active" : ""}" data-go="${s}">${l}</button>`).join("");
    const q = $("[data-dh-search]").value.trim().toLowerCase();
    const groups = q ? Object.values(GROUPS()).flat() : GROUPS()[section];
    const seen = new Set();
    // Reference groups fold to a heading with a count, so the whole sidebar fits; the current page's group is open.
    const html = groups.map(([label, items]) => {
      const list = items.filter(([id, name]) => !seen.has(id) && (!q || name.toLowerCase().includes(q) || id.includes(q)));
      list.forEach(([id]) => seen.add(id));
      if (!list.length) return "";
      const links = list.map(([id, name, method]) => `<a class="dh-item${page === id ? " active" : ""}" href="#${id}">${method ? `<span class="dh-mini m-${method}">${method.toUpperCase()}</span>` : ""}${esc(name)}</a>`).join("");
      if (!label.startsWith("Reference")) return `<div class="dh-label">${esc(label)}</div>${links}`;
      const open = q || state.open.has(label) || (state.forceClosed !== label && list.some(([id]) => id === page));
      return `<button type="button" class="dh-group" data-group="${esc(label)}" aria-expanded="${!!open}"><span>${esc(label.replace("Reference · ", ""))}</span><small>${list.length}</small></button>${open ? `<div class="dh-group-items">${links}</div>` : ""}`;
    }).join("");
    $("[data-dh-nav]").innerHTML = html || `<div class="dh-empty">No matching pages.</div>`;
  }

  // ---------- pages ----------
  const first = () => `curl "${ORIGIN}/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}&sort=score&size=5"`;
  const P = {};
  P.overview = () => hero(`${BRAND} developer hub`, `Build on <em>connected</em><br>knowledge.`, `Bring ontologies, schemas and standards into your applications and AI workflows. One catalog, two ways to connect.`) + `
    <div class="dh-cards">
      <a class="dh-card" href="#api"><span class="dh-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/></svg></span><span class="dh-index">01 / PROGRAMMATIC ACCESS</span>
        <h2>REST API</h2><p>Search the catalog, read every resource's evaluation and follow scores across runs, from code.</p><span class="dh-tag">Applications &amp; data pipelines</span><span class="dh-cta">Explore the API <span>↗</span></span></a>
      <a class="dh-card mcp" href="#mcp"><span class="dh-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3h8v6H8zM2 15h8v6H2zm12 0h8v6h-8zM12 9v3M6 15v-3h12v3"/></svg></span><span class="dh-index">02 / AGENT INTEGRATION</span>
        <h2>MCP server</h2><p>Give AI assistants and agents the catalog, scores and the evidence behind them.</p><span class="dh-tag">AI assistants &amp; agent workflows</span><span class="dh-cta">Connect your client <span>↗</span></span></a>
    </div>
    ${title("Your first request", "No account needed to read the catalog.")}
    <div class="dh-quick"><div class="dh-quick-text"><div class="dh-number">01 / REST API QUICKSTART</div><h3>Find resources on a topic</h3><p>Search ${esc(BRAND)} and get each resource's score, grade and the version evaluated.</p><a class="dh-link" href="#api">Follow the quickstart →</a></div>${code(first())}</div>
    ${resources([["#authentication", "Authentication", "Tokens for higher limits and your account."], ["#tools", "Explore MCP tools", "Discover what your agent can do."], ["#examples", "Integration examples", "Turn a first connection into a workflow."]])}`;
  P.guide = () => hero("Developer guide", "Choose your <em>integration.</em>", "Two connections, one catalog.") + `
    ${title("Which one?")}
    <div class="dh-quick two"><div class="dh-quick-text"><div class="dh-number">REST API</div><h3>Explicit requests from code</h3><p>Applications, scripts, notebooks and data pipelines. Reading is open; a token raises your rate limit.</p><a class="dh-link" href="#api">Open the API quickstart →</a></div>
      <div class="dh-quick-text alt"><div class="dh-number">MCP SERVER</div><h3>Let an AI assistant call tools</h3><p>Claude, Cursor, VS Code, Codex and other MCP clients search the catalog and read evidence for you. Needs a token with MCP access.</p><a class="dh-link" href="#connect">Connect your client →</a></div></div>`;
  P.examples = () => hero("Developer guide", "Integration <em>examples.</em>", "A starting point for your next workflow.") + `
    ${title("In an application", "query → results → details")}
    ${code(`curl "${ORIGIN}/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}&kind=ontology&sort=score&size=3"\ncurl "${ORIGIN}/api/entries/${D.entry}"\ncurl "${ORIGIN}/api/entries/${D.entry}/history"`, "cURL")}
    ${title("In an AI workflow", "prompt → tool call → grounded answer")}
    ${code(`Find the best-scored ontologies in ${BRAND} for ${D.topic}.\nWhy does ${D.entryName} score what it does? Show the evidence per criterion.\nHow has its score changed across evaluation runs?`, "Prompts")}
    <a class="dh-link" href="#connect">Connect your client →</a>`;

  P.api = () => hero("REST API", `Structured knowledge.<br><em>Ready to build.</em>`, `JSON over HTTPS. Search with facets, read entries with their full evaluation, and follow history across runs.`) +
    facts([["Base URL", `<code>${esc(ORIGIN)}</code>`], ["Format", "JSON"], ["Errors", "problem+json"], ["Reading", "No token needed"]]) + `
    <p class="dh-intro">This quickstart takes about five minutes. Each step shows the request, explains what it does and what comes back, and has a <b>Run</b> button that calls this site's API right here, so you see the real response before writing any code.</p>
    ${step(1, "Search the catalog", `<p class="dh-p"><code>/api/entries</code> searches every resource. <code>q</code> matches each word you give (as a prefix) against acronyms, names, descriptions, tags, formats, maintainers and domains; <code>sort=score</code> puts the best-evaluated first and <code>size</code> caps the page.</p>
      ${code(first(), "cURL", { run: `/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}&sort=score&size=5` })}
      ${outcome(`<code>total</code> matches, the page of <code>items</code> (id, name, score 0–100, grade A–E, the version evaluated…) and <code>facets</code>: counts per type, grade, domain and format, ready for building filters.`)}`)}
    ${step(2, "Read a resource", `<p class="dh-p">Use an <code>id</code> from the search (the last part of an entry page's URL) to get everything about one resource: its catalog record, the facts gathered from each source, the points earned per criterion and why, adopters, imports and reuse.</p>
      ${code(`curl "${ORIGIN}/api/entries/${D.entry}"`, "cURL", { run: `/api/entries/${encodeURIComponent(D.entry)}` })}
      ${outcome(`<code>entry</code> (the record), <code>facts</code> (with <code>breakdown</code>: each criterion's score and the steps behind it), <code>adopters</code>, <code>imports</code>, <code>reusedBy</code>, <code>history</code> and <code>changes</code>.`)}`)}
    ${step(3, "Follow its history", `<p class="dh-p">Every evaluation run is archived. The history shows how the score, each criterion and the quality checks changed, and lists what changed between runs (a new version, a license, a broken link…).</p>
      ${code(`curl "${ORIGIN}/api/entries/${D.entry}/history"`, "cURL", { run: `/api/entries/${encodeURIComponent(D.entry)}/history` })}
      ${outcome(`<code>runs</code>, oldest first, each with score, grade, per-criterion points and metrics; and <code>changes</code>, one line per difference.`)}`)}
    ${step(4, "Add a token for a higher limit", `<p class="dh-p">Without a token you get <b>${fmt(state.cfg.rateLimit.anonymousPerMinute)}</b> requests per minute per IP address; with one, <b>${fmt(state.cfg.rateLimit.authenticatedPerMinute)}</b> per minute. <a href="${signin()}">Sign in with GitHub</a>, create a token with <b>API</b> access, and send it as a bearer token. Keep it in an environment variable, never in code. Please read <a href="#rate-limits">fair use</a>: cache responses and use bulk data for bulk work.</p>
      ${code(`export ${ENV}="${tokenText()}"\ncurl "${ORIGIN}/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}" \\\n  -H "Authorization: Bearer $${ENV}"`, "Shell")}
      <p class="dh-p">Paste it here to use it for every request you send from this page:</p>${tokenBox()}`)}
    ${title("Next")}
    ${resources([["#" + (endpointPages()[0]?.[1][0]?.[0] || "api"), "Endpoint reference", "Every endpoint, with a form to try it."], ["#pagination", "Search & pagination", "Filters, sorting and facets."], ["#errors", "Handle errors", "Status codes and problem details."]])}`;
  P.authentication = () => hero("REST API", "Authentication", "Reading is open. Sign in for tokens, submissions and a higher limit.") + `
    ${title("Two kinds of bearer token")}
    <div class="dh-quick two"><div class="dh-quick-text"><div class="dh-number">PERSONAL ACCESS TOKENS</div><h3><code>${esc(state.cfg.tokenPrefix)}…</code></h3><p>For scripts and AI agents. Scoped (<b>API</b>, <b>MCP</b>), expiring and revocable. Create them on your account page; a token is shown once.</p><a class="dh-link" href="${signin()}">Create a token →</a></div>
      <div class="dh-quick-text alt"><div class="dh-number">SESSION JWT</div><h3>From GitHub sign-in</h3><p>This site keeps it in a secure cookie, so requests you send from this page are already authenticated when you're signed in. For scripts, <code>POST /api/auth/token</code> returns one, valid for ${esc(state.cfg.sessionHours ?? "a few")} hours.</p></div></div>
    ${title("Check who you are", "Never fails: returns you, or null")}
    ${tokenBox()}
    ${code(`curl "${ORIGIN}/api/auth/session" \\\n  -H "Authorization: Bearer ${tokenText()}"`, "cURL", { run: "/api/auth/session" })}
    ${callout(`Keep tokens in environment variables, not in code. Account endpoints (tokens, settings) accept only a signed-in session, so a leaked token can't create more tokens.`)}`;
  P["rate-limits"] = () => hero("REST API", "Rate limits &amp; <em>fair use.</em>", `${esc(BRAND)} is a free, public service. Limits keep it fast and available for everyone.`) + `
    <div class="dh-stats"><div><span>Without a token</span><b>${fmt(state.cfg.rateLimit.anonymousPerMinute)}</b><small>requests per minute, per IP address</small></div><div><span>Signed in or with a token</span><b>${fmt(state.cfg.rateLimit.authenticatedPerMinute)}</b><small>requests per minute, per account</small></div></div>
    ${title("Why there are limits")}
    <p class="dh-p">The catalog, its evaluations and this API are shared by researchers, tools and AI agents, and served from modest infrastructure at no cost to anyone. Without limits, one runaway script or crawler could slow the service down or take it offline for everyone else. Limits also let us see, through tokens, who depends on the API, so we can plan capacity, warn about changes, and reach out before anything breaks.</p>
    ${title("Fair use", "What we ask")}
    <div class="dh-fair">
      <div><b>Cache what you fetch</b><p>Scores change only when the catalog is re-evaluated (see <code>/api/runs</code>), so most responses can be cached for hours.</p></div>
      <div><b>Use bulk data for bulk work</b><p>Need everything? Use <a href="/catalog.json">catalog.json</a>, <code>/api/entry-ids</code> or a run snapshot (<code>/api/runs/{id}/snapshot</code>) rather than paging through every entry.</p></div>
      <div><b>Back off when asked</b><p>On <code>429</code>, wait the seconds in <code>Retry-After</code> before retrying, and slow down rather than retrying in a tight loop.</p></div>
      <div><b>Identify yourself</b><p>Send a token, even for light use. It raises your limit and lets us contact you if something goes wrong.</p></div>
      <div><b>Don't work around the limits</b><p>Rotating IP addresses or accounts to exceed them, or reselling access, isn't allowed; tokens used that way may be revoked.</p></div>
      <div><b>Credit the source</b><p>Each resource belongs to its maintainers and keeps its own license; scores and evaluations come from ${esc(BRAND)}. Link back when you republish them.</p></div>
    </div>
    ${title("Where you stand", "Sent with every response")}
    <table class="dh-table"><thead><tr><th>Header</th><th>Meaning</th></tr></thead><tbody><tr><td><code>X-RateLimit-Limit</code></td><td>Requests allowed this minute</td></tr><tr><td><code>X-RateLimit-Remaining</code></td><td>Requests left this minute</td></tr><tr><td><code>X-RateLimit-Reset</code></td><td>When the window resets (Unix time)</td></tr><tr><td><code>Retry-After</code></td><td>Seconds to wait, on 429</td></tr></tbody></table>
    ${code(`curl -i "${ORIGIN}/api/stats"`, "cURL", { run: "/api/stats" })}
    ${callout(`Building something that needs more? <a href="/contact/">Tell us about your project</a>: limits can be raised per account, and we'd like to hear what you're building.`)}`;
  P.pagination = () => hero("REST API", "Search &amp; pagination", "Filters, sorting and facet counts in one call.") + `
    <table class="dh-table"><thead><tr><th>Parameter</th><th>Description</th></tr></thead><tbody>
      <tr><td><code>q</code></td><td>Free text; every word must match (as a prefix) across acronym, name, description, tags, formats, maintainer and domains</td></tr>
      <tr><td><code>category</code></td><td>Category id, primary or secondary domain</td></tr><tr><td><code>kind</code> · <code>grade</code> · <code>format</code> · <code>registry</code></td><td>Filters; <code>grade=none</code> for not evaluated</td></tr>
      <tr><td><code>legacy</code></td><td><code>false</code> to leave out legacy resources</td></tr><tr><td><code>sort</code></td><td><code>score</code>, <code>fair</code>, <code>name</code>, <code>activity</code> or <code>adopters</code></td></tr>
      <tr><td><code>page</code> · <code>size</code></td><td>From 1; up to 100 per page. The response has <code>total</code></td></tr></tbody></table>
    ${code(`{\n  "total": 428, "page": 1, "size": 24,\n  "items": [ { "id": "${D.entry}", "score": 91, "grade": "A", … } ],\n  "facets": { "kind": { "ontology": 364, … }, "grade": { … } }\n}`, "JSON · response shape")}`;
  P.errors = () => hero("REST API", "Errors &amp; responses", "RFC 7807 problem details, with a standard status code.") + `
    <table class="dh-table"><thead><tr><th>Status</th><th>Meaning</th></tr></thead><tbody>${[["400", "Bad request"], ["401", "Missing, invalid or expired token"], ["403", "The token lacks the scope (API or MCP), or not allowed"], ["404", "No such entry, run or category"], ["422", "Invalid parameters or entry"], ["429", "Rate limit exceeded: wait for Retry-After"], ["503", "Catalog not loaded or a service is down"]].map(([c, m]) => `<tr><td><code>${c}</code></td><td>${m}</td></tr>`).join("")}</tbody></table>
    ${code(`{\n  "type": "about:blank",\n  "title": "Too Many Requests",\n  "status": 429,\n  "detail": "Rate limit of ${state.cfg.rateLimit.anonymousPerMinute ?? 60} requests per minute exceeded.",\n  "instance": "/api/entries"\n}`, "JSON · application/problem+json")}`;

  // Endpoint pages from the OpenAPI document: one page, no tabs. What it is for, the parameters, a filled-in form
  // that sends the request from this page (public GET requests run as soon as the page opens), the response, and code.
  // Descriptions come from the OpenAPI document (backend/catalog_api/docs_text.py): paragraphs, `code` and **bold**.
  const md = (t) => esc(t || "").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const opById = (id) => endpointPages().flatMap(([, ops]) => ops).find(([pid]) => pid === id);
  const authNeeded = (path) => /^\/api\/(tokens|submissions|admin|audit|auth\/(me|token|activity))/.test(path);
  const typeOf = (sch = {}) => sch.type || (sch.anyOf || []).map((x) => x.type).filter((t) => t && t !== "null").join(" | ") || "string";
  const sampleFor = (p) => {
    if (SAMPLE[p.name]) return SAMPLE[p.name];
    if (p.name === "q") return D.topic.split(" ")[0];
    if (p.name === "size") return "5";
    if (p.name === "n" || p.name === "limit") return "5";
    if (p.schema?.default != null && p.in === "path") return String(p.schema.default);
    return "";
  };
  // Builds the request from the form (or the samples when the form isn't there yet).
  function currentRequest(id) {
    const [, , method, path, op] = opById(id);
    // Only read the form when it belongs to this endpoint (while navigating, the previous page's form is still there).
    const found = $("[data-ep-form]");
    const form = found && found.dataset.ep === id ? found : null;
    const val = (name, fallback) => (form ? form.elements[`p_${name}`]?.value ?? "" : fallback);
    let p = path;
    const qs = new URLSearchParams();
    for (const prm of op.parameters || []) {
      const v = val(prm.name, sampleFor(prm)).trim();
      if (prm.in === "path") p = p.replace(`{${prm.name}}`, encodeURIComponent(v || `<${prm.name}>`));
      else if (prm.in === "query" && v !== "") qs.set(prm.name, v);
    }
    const bodyEl = form?.elements.body;
    const body = op.requestBody ? (bodyEl ? bodyEl.value : null) : null;
    return { method: method.toUpperCase(), url: p + (qs.size ? `?${qs}` : ""), body };
  }
  function examples(id) {
    const [, , , path] = opById(id);
    const { method, url, body } = currentRequest(id);
    const full = ORIGIN + url;
    const auth = authNeeded(path) || savedToken() ? `Bearer ${savedToken() || "<your token>"}` : null;
    let bodyJson = null;
    try { bodyJson = body ? JSON.stringify(JSON.parse(body)) : null; } catch { bodyJson = body; }
    return {
      cURL: [`curl${method === "GET" ? "" : ` -X ${method}`} "${full}"`, auth && `  -H "Authorization: ${auth}"`, bodyJson && `  -H "Content-Type: application/json"`, bodyJson && `  -d '${bodyJson}'`].filter(Boolean).join(" \\\n"),
      Python: `import requests\n\nresponse = requests.${method.toLowerCase()}(\n    "${full}",${auth ? `\n    headers={"Authorization": "${auth}"},` : ""}${bodyJson ? `\n    json=${bodyJson},` : ""}\n)\nresponse.raise_for_status()\nprint(response.json())`,
      JavaScript: `const response = await fetch("${full}", {${method !== "GET" ? `\n  method: "${method}",` : ""}${auth || bodyJson ? `\n  headers: { ${[auth && `Authorization: "${auth}"`, bodyJson && `"Content-Type": "application/json"`].filter(Boolean).join(", ")} },` : ""}${bodyJson ? `\n  body: JSON.stringify(${bodyJson}),` : ""}\n});\nconst data = await response.json();`,
    };
  }
  const endpoint = (id) => {
    const [, name, method, path, op] = opById(id);
    const ps = op.parameters || [];
    const ref = op.requestBody?.content?.["application/json"]?.schema?.$ref;
    const body = ref ? state.spec.components.schemas[ref.split("/").pop()] : null;
    const sampleBody = body ? JSON.stringify(Object.fromEntries(Object.entries(body.properties || {}).map(([k, v]) => [k, v.default ?? (v.type === "array" ? [] : v.type === "integer" ? 90 : v.type === "object" ? {} : k === "name" ? "My script" : "")])), null, 2) : "";
    const desc = (op.description || op.summary || "").split(/\n\s*\n/).map((t) => `<p>${md(t.trim())}</p>`).join("");
    const needs = authNeeded(path);
    const ex = examples(id);
    return hero("API reference", esc(name), `<code>${esc(method.toUpperCase())} ${esc(path)}</code>`) + `
      <div class="dh-endpoint"><span class="dh-method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code><span class="dh-auth">${needs ? "Needs sign-in or a token" : "Public · no token needed"}</span></div>
      ${desc ? `<div class="dh-about">${desc}</div>` : ""}
      ${title("Parameters")}
      ${ps.length ? `<table class="dh-table"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${ps.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(typeOf(p.schema))} · ${p.in}${p.required ? " · <b>required</b>" : ""}</td><td>${md(p.description || p.schema?.description || (p.schema?.enum ? `One of: ${p.schema.enum.join(", ")}` : ""))}${p.schema?.default != null ? ` <span class="dh-muted">Default ${esc(p.schema.default)}.</span>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="dh-p dh-muted">None.</p>`}
      ${body ? `${title("Request body", "JSON")}<table class="dh-table"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${Object.entries(body.properties || {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code>${(body.required || []).includes(k) ? " · <b>required</b>" : ""}</td><td>${esc(typeOf(v))}</td><td>${md(v.description || "")}</td></tr>`).join("")}</tbody></table>` : ""}
      ${title("Try it", "Sends the request from this page")}
      <form class="dh-try" data-ep-form data-ep="${esc(id)}">
        ${ps.length ? `<div class="dh-try-grid">${ps.map((p) => `<label>${esc(p.name)}${p.required ? " *" : ""}<small>${p.in}</small>${p.schema?.enum ? `<select name="p_${esc(p.name)}"><option value=""></option>${p.schema.enum.map((o) => `<option${o === sampleFor(p) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>` : `<input name="p_${esc(p.name)}" value="${esc(sampleFor(p))}" placeholder="${esc(p.schema?.default ?? "")}" autocomplete="off">`}</label>`).join("")}</div>` : ""}
        ${body ? `<label class="dh-try-body">Body<textarea name="body" rows="${Math.min(10, sampleBody.split("\n").length + 1)}" spellcheck="false">${esc(sampleBody)}</textarea></label>` : ""}
        ${needs ? tokenBox() : ""}
        <div class="dh-try-bar"><button class="dh-btn" type="submit">Send ${method.toUpperCase()} ▶</button><code class="dh-try-url" data-try-url>${esc(ORIGIN + currentRequest(id).url)}</code></div>
      </form>
      <div class="dh-out" data-ep-out>${!needs && method === "get" ? `<p class="dh-p dh-muted">Loading the live response…</p>` : `<p class="dh-p dh-muted">Press Send to see the response here.</p>`}</div>
      ${title("Code", "Matches the form above")}
      <div class="dh-clientbar">${["cURL", "Python", "JavaScript"].map((l) => `<button type="button" class="${state.lang === l ? "active" : ""}" data-lang="${l}">${l}</button>`).join("")}</div>
      <div data-ep-code>${code(ex[state.lang] || ex.cURL, state.lang)}</div>`;
  };
  async function sendEndpoint() {
    const form = $("[data-ep-form]");
    if (!form) return;
    const id = form.dataset.ep;
    const { method, url, body } = currentRequest(id);
    const out = $("[data-ep-out]");
    if (url.includes("%3C") || url.includes("<")) { out.innerHTML = `<p class="dh-p">Fill in the path parameters first.</p>`; return; }
    out.innerHTML = `<p class="dh-p dh-muted">Sending…</p>`;
    try { out.innerHTML = await call(url, { method, body: method === "GET" ? null : body }); }
    catch (err) { out.innerHTML = `<p class="dh-p">Request failed: ${esc(err.message)}</p>`; }
  }
  function refreshEndpoint() {
    const form = $("[data-ep-form]");
    if (!form) return;
    const id = form.dataset.ep;
    $("[data-try-url]").textContent = ORIGIN + currentRequest(id).url;
    const ex = examples(id);
    $("[data-ep-code]").innerHTML = code(ex[state.lang] || ex.cURL, state.lang);
  }

  // MCP
  const CLIENTS = {
    "claude-code": ["Claude Code", "Terminal", () => `claude mcp add --transport http ${SLUG} ${ORIGIN}/mcp/ \\\n  --header "Authorization: Bearer ${tokenText()}"`, "Then start a new session; <code>claude mcp list</code> should show it."],
    "claude-desktop": ["Claude Desktop", "claude_desktop_config.json", () => JSON.stringify({ mcpServers: { [SLUG]: { command: "npx", args: ["-y", "mcp-remote", `${ORIGIN}/mcp/`, "--header", `Authorization: Bearer ${tokenText()}`] } } }, null, 2), "Settings → Developer → Edit config, then restart Claude Desktop. <code>mcp-remote</code> bridges the remote server."],
    cursor: ["Cursor", "~/.cursor/mcp.json", () => JSON.stringify({ mcpServers: { [SLUG]: { url: `${ORIGIN}/mcp/`, headers: { Authorization: `Bearer ${tokenText()}` } } } }, null, 2), "Then enable the server in Cursor's MCP settings."],
    vscode: ["VS Code", ".vscode/mcp.json", () => JSON.stringify({ servers: { [SLUG]: { type: "http", url: `${ORIGIN}/mcp/`, headers: { Authorization: `Bearer ${tokenText()}` } } } }, null, 2), "Then start the server from the MCP view or the file's code lens."],
    codex: ["Codex", "~/.codex/config.toml", () => `[mcp_servers.${SLUG}]\nurl = "${ORIGIN}/mcp/"\nbearer_token_env_var = "${ENV}"\n\n# in your shell:\nexport ${ENV}="${tokenText()}"`, "Restart Codex with the variable set."],
    generic: ["Other client", "Settings", () => `Server name: ${BRAND}\nServer URL:  ${ORIGIN}/mcp/\nTransport:   Streamable HTTP\nHeader:      Authorization: Bearer ${tokenText()}`, "Any MCP client that supports remote (streamable HTTP) servers with a header."],
  };
  P.mcp = () => hero("Model Context Protocol", `Your AI.<br><em>A world of context.</em>`, `Connect an MCP client and ask about ontologies, schemas and standards in plain language, with the scores and evidence behind every answer.`) + `
    ${callout(`Needs a personal access token with <b>MCP</b> access. <a href="${signin()}">${state.session?.user ? "Create one on your account page" : "Sign in with GitHub to create one"}</a>; it is filled in below once created in this tab.`)}
    ${connectBlock()}
    ${title("Then, start a conversation")}
    <div class="dh-quick two"><div class="dh-quick-text"><div class="dh-number">TRY A PROMPT</div><h3>“Find the best-scored ${esc(BRAND)} ontologies for ${esc(D.topic)}.”</h3><p>Your assistant calls <code>search_catalog</code> and answers with grades and links.</p><a class="dh-link" href="#tools">Explore available tools →</a></div>
      <div class="dh-quick-text alt"><div class="dh-number">A TYPICAL WORKFLOW</div><p>01 &nbsp; Find relevant resources<br>02 &nbsp; Inspect a score and its evidence<br>03 &nbsp; Compare runs and versions</p><a class="dh-link" href="#workflow">See the workflow →</a></div></div>`;
  const connectBlock = () => {
    const c = CLIENTS[state.client] || CLIENTS["claude-code"];
    return `${title("Connect your client", "Choose your client")}<div class="dh-clientbar" data-client-bar>${Object.entries(CLIENTS).map(([k, [n]]) => `<button class="${state.client === k ? "active" : ""}" data-client="${k}">${n}</button>`).join("")}</div>${code(c[2](), `${c[0]} · ${c[1]}`)}<p class="dh-p dh-muted">${c[3]}</p>`;
  };
  P.connect = () => hero("MCP server", "Connect your <em>client.</em>", `Add ${esc(BRAND)} to your assistant with your token.`) + connectBlock() +
    callout(`Verify: ask <b>“Which ${esc(BRAND)} tools do you have?”</b> Your assistant should list the six tools below.`) + resources([["#tools", "Available tools", ""], ["#troubleshooting", "Troubleshooting", ""], [signin(), "Your tokens", ""]]);
  const TOOLS = [
    ["search_catalog", "Search by topic, domain, type, grade or format; returns scores, grades and links."],
    ["get_entry", "One resource's record and evaluation: points per criterion with the step behind each, quality checks, adopters, imports and reuse."],
    ["get_entry_history", "Score, criteria and quality metrics in every evaluation run, and what changed."],
    ["list_categories", "The catalog's domains, with how many resources belong to and are used in each."],
    ["catalog_stats", "Catalog size, grade distribution, average score, latest run and rubric version."],
    ["scoring_rubric", "How scores are computed: each criterion's maximum, formula and explanation; penalties and grades."],
  ];
  P.tools = () => hero("MCP reference", "Available <em>tools.</em>", "A focused set of read-only tools; nothing your assistant does changes the catalog.") +
    `<table class="dh-table"><thead><tr><th>Tool</th><th>What it does</th></tr></thead><tbody>${TOOLS.map(([t, d]) => `<tr><td><code>${t}</code></td><td>${d}</td></tr>`).join("")}</tbody></table>`;
  P.workflow = () => hero("MCP reference", "Example <em>workflow.</em>", "From a question to resources you can rely on.") +
    `${title("Ask, in order")}${code(`Find the best-scored ${BRAND} ontologies for ${D.topic}, with their grades.\nWhy does ${D.entryName} score what it does? Show the evidence behind each criterion.\nHow has ${D.entryName}'s score changed across evaluation runs?`, "Prompts")}
    ${callout(`Expected: a short list with scores (0–100) and grades (A–E); then points per criterion with the reason for each, as on <a href="/o/${encodeURIComponent(D.entry)}/#evaluation">${esc(D.entryName)}'s page</a>; then the score in each run.`, "ok")}`;
  P.troubleshooting = () => hero("MCP support", "Troubleshooting", "Get your connection working.") +
    `<table class="dh-table"><thead><tr><th>What you see</th><th>What to do</th></tr></thead><tbody>${[
      ["No tools in the assistant", "Start a new session or restart the client; most load MCP servers only at start-up."],
      ["401 Unauthorized", `The token is missing, mistyped, expired or revoked. <a href="${signin()}">Create a new one</a>.`],
      ["403 Forbidden", "The token doesn't have MCP access. Create one with MCP ticked."],
      ["429 Too Many Requests", `Rate limit (${fmt(state.cfg.rateLimit.authenticatedPerMinute)} per minute with a token). Wait a minute.`],
      ["No results", "Try fewer or broader words; every word must match."],
    ].map(([a, b]) => `<tr><td><b>${a}</b></td><td>${b}</td></tr>`).join("")}</tbody></table>`;

  // ---------- render & route ----------
  const crumbs = () => {
    const pageName = Object.values(GROUPS()).flat().flatMap(([, i]) => i).find(([id]) => id === page)?.[1];
    return `<div class="dh-crumbs"><a href="#overview">Developers</a> <span>/</span> ${section === "overview" ? "Overview" : section === "api" ? "REST API" : "MCP server"}${!["overview", "api", "mcp"].includes(page) && pageName ? ` <span>/</span> <b>${esc(pageName)}</b>` : ""}</div>`;
  };
  function render() {
    renderNav();
    const html = page.startsWith("ep-") ? (state.spec ? endpoint(page) : `<p class="dh-p dh-muted">Loading…</p>`) : (P[page] || P.overview)();
    $("[data-dh-content]").innerHTML = crumbs() + html;
  }
  // Right rail: "On this page" (with the section in view highlighted), what you need, useful links and a next step.
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) $$("[data-rail-toc] a").forEach((a) => a.classList.toggle("active", a.getAttribute("data-target") === en.target.id));
  }, { rootMargin: "-20% 0px -70% 0px" });
  function renderRail() {
    const rail = $("[data-dh-rail]");
    if (!rail) return;
    spy.disconnect();
    const heads = $$(".dh-title h2, .dh-step h3", $("[data-dh-content]"));
    heads.forEach((h, i) => (h.id ||= `s-${i}-${h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`));
    const signedIn = !!state.session?.user;
    const needs = section === "mcp"
      ? ["An MCP client: Claude Code, Claude Desktop, Cursor, VS Code, Codex…", "A GitHub account, to sign in", "A token with MCP access"]
      : ["Nothing, to read the catalog", "A GitHub account and a token, for a higher rate limit", "Sign-in, for tokens and submissions"];
    const links = section === "mcp"
      ? [["#connect", "Connect your client"], ["#tools", "Available tools"], ["#troubleshooting", "Troubleshooting"], ["/account/#tokens", "Your tokens"]]
      : [["#api", "Quickstart"], ["#authentication", "Authentication"], ["#rate-limits", "Rate limits"], ["#errors", "Errors"], ["/account/#tokens", "Your tokens"]];
    rail.innerHTML = `
      ${heads.length > 1 ? `<p class="dh-rail-title">On this page</p><nav class="dh-rail-toc" data-rail-toc>${heads.map((h) => `<a href="#${esc(page)}" data-target="${esc(h.id)}">${esc(h.textContent.trim())}</a>`).join("")}</nav>` : ""}
      <div class="dh-rail-card"><h3>✓ What you need</h3><ul>${needs.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>
      <div class="dh-rail-card"><h3>↗ Useful links</h3>${links.filter(([h]) => h !== `#${page}`).map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join("")}<a href="/contact/">Get in touch</a></div>
      <div class="dh-rail-card cta"><h3>→ ${signedIn ? "Create a token" : "Get a token"}</h3><p>${signedIn ? `Signed in as @${esc(state.session.user.login)}. Tokens raise your limit to ${fmt(state.cfg.rateLimit.authenticatedPerMinute)} requests a minute and connect MCP clients.` : "Sign in with GitHub to create tokens for the API and MCP. It takes a minute."}</p><a class="dh-btn" href="${signin()}">${signedIn ? "Your tokens →" : "Sign in with GitHub →"}</a></div>`;
    heads.forEach((h) => spy.observe(h));
  }
  function afterRender() {
    renderRail();
    const form = $("[data-ep-form]");
    if (form) {
      const [, , method, path] = opById(form.dataset.ep);
      if (method === "get" && !authNeeded(path)) sendEndpoint();
    }
  }
  function route() {
    state.forceClosed = null;
    const want = location.hash.slice(1) || "overview";
    page = exists(want) || (want.startsWith("ep-") && !state.spec) ? want : "overview";
    section = page.startsWith("ep-") ? "api" : sectionOf(page);
    $("[data-dh-search]").value = "";
    render();
    afterRender();
    root.classList.remove("side-open");
    $("[data-dh-menu]").setAttribute("aria-expanded", "false");
    window.scrollTo({ top: root.offsetTop - 70 });
  }

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-rail-toc] a");
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.go) location.hash = t.dataset.go;
    else if (t.dataset.group) renderNavKeep(t.dataset.group, t.getAttribute("aria-expanded") !== "true");
    else if (t.dataset.client) { state.client = t.dataset.client; store.set("dh-client", state.client); render(); }
    else if (t.dataset.lang) { state.lang = t.dataset.lang; store.set("dh-lang", state.lang); $$("[data-lang]").forEach((b) => b.classList.toggle("active", b === t)); refreshEndpoint(); }
    else if (t.dataset.run) {
      const out = t.closest(".dh-code").nextElementSibling;
      t.disabled = true;
      out.innerHTML = `<p class="dh-p dh-muted">Running…</p>`;
      try { out.innerHTML = await call(t.dataset.run); } catch (err) { out.innerHTML = `<p class="dh-p">Request failed: ${esc(err.message)}</p>`; }
      t.disabled = false;
    }
    else if (t.hasAttribute("data-copy")) {
      try { await navigator.clipboard.writeText(t.dataset.full ?? (t.closest(".dh-code") || t.closest(".dh-response")).querySelector("pre").textContent); t.textContent = "Copied ✓"; } catch { t.textContent = "Select text to copy"; }
      setTimeout(() => (t.textContent = "Copy"), 1800);
    }
    else if (t.hasAttribute("data-dh-menu")) {
      const open = !root.classList.contains("side-open");
      root.classList.toggle("side-open", open);
      t.setAttribute("aria-expanded", String(open));
    }
  });
  $("[data-dh-search]").addEventListener("input", renderNav);
  root.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-ep-form]")) return;
    e.preventDefault();
    sendEndpoint();
  });
  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-token-input]")) {
      try { sessionStorage.setItem("dh-token", e.target.value.trim()); } catch {}
      refreshEndpoint();
    } else if (e.target.closest("[data-ep-form]")) refreshEndpoint();
  });
  window.addEventListener("hashchange", route);

  route();
  Promise.all([
    fetch("/api/auth/config").then((r) => r.json()).then((c) => (state.cfg = c)).catch(() => {}),
    fetch("/api/auth/session").then((r) => r.json()).then((s) => (state.session = s)).catch(() => {}),
    fetch("/openapi.json").then((r) => r.json()).then((s) => (state.spec = s)).catch(() => {}),
  ]).then(() => { if (!$("[data-ep-form]") || !state.loadedOnce) route(); state.loadedOnce = true; });
})();
