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
  const state = { cfg: { tokenPrefix: "…_pat_", rateLimit: {} }, spec: null, session: null, client: store.get("dh-client") || "claude-code", lang: store.get("dh-lang") || "cURL" };
  const SAMPLE = { entry_id: D.entry, cat_id: D.category, run_id: D.run, name: "roadmap" };

  // ---------- building blocks ----------
  const code = (text, label = "cURL", { raw = false } = {}) =>
    `<div class="dh-code"><div class="dh-codehead"><span>${esc(label)}</span><button type="button" class="dh-copy" data-copy>Copy</button></div><pre>${raw ? text : esc(text)}</pre></div>`;
  const hero = (label, title, desc) => `<section class="dh-hero"><div class="dh-hero-copy"><div class="dh-eyebrow"><span></span>${esc(label)}</div><h1>${title}</h1><p class="dh-lead">${desc}</p></div>
    <div class="dh-orbital" aria-hidden="true"><div class="dh-orbit o1"></div><div class="dh-orbit o2"></div><div class="dh-orbit o3"></div><span class="dh-star s1"></span><span class="dh-star s2"></span><span class="dh-star s3"></span>
      <div class="dh-core"><svg viewBox="0 0 70 70" fill="none" stroke="currentColor"><path d="m35 12 23 13v22L35 60 12 47V25zM12 25l23 13 23-13M35 38v22M35 12v26M12 47l23-13 23 13"/><circle cx="35" cy="12" r="3"/><circle cx="58" cy="25" r="3"/><circle cx="12" cy="47" r="3"/><circle cx="35" cy="60" r="3"/></svg></div>
      <span class="dh-olabel l1">SCHEMAS</span><span class="dh-olabel l2">ONTOLOGIES</span><span class="dh-olabel l3">STANDARDS</span></div>
    <div class="dh-meta"><a href="#api">REST API <i>↗</i></a><b></b><a href="#mcp">MODEL CONTEXT PROTOCOL <i>↗</i></a><span class="dh-note">Developer documentation</span></div></section>`;
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

  function renderNav() {
    $("[data-dh-switch]").innerHTML = [["overview", "Overview"], ["api", "REST API"], ["mcp", "MCP"]]
      .map(([s, l]) => `<button type="button" role="tab" aria-selected="${section === s}" class="${section === s ? "active" : ""}" data-go="${s}">${l}</button>`).join("");
    const q = $("[data-dh-search]").value.trim().toLowerCase();
    const groups = q ? Object.values(GROUPS()).flat() : GROUPS()[section];
    const seen = new Set();
    const html = groups.map(([label, items]) => {
      const list = items.filter(([id, name]) => !seen.has(id) && (!q || name.toLowerCase().includes(q) || id.includes(q)));
      list.forEach(([id]) => seen.add(id));
      return list.length ? `<div class="dh-label">${esc(label)}</div>` + list.map(([id, name, method]) => `<a class="dh-item${page === id ? " active" : ""}" href="#${id}">${method ? `<span class="dh-mini m-${method}">${method.toUpperCase()}</span>` : ""}${esc(name)}</a>`).join("") : "";
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

  P.api = () => hero("REST API", `Structured knowledge.<br><em>Ready to build.</em>`, `JSON over HTTPS. Search with facets, read entries with their full evaluation, and follow history across runs.`) + `
    ${callout(`Base URL <code>${esc(ORIGIN)}</code> · JSON · errors as <code>application/problem+json</code> · <a href="/openapi.json" download="openapi.json">OpenAPI</a> · <a href="/docs">interactive console</a>`)}
    ${title("1. Make your first request", "No token needed")}
    ${code(first())}
    ${title("2. Read a resource", `${esc(D.entryName)}, with its evaluation and history`)}
    ${code(`curl "${ORIGIN}/api/entries/${D.entry}"`)}
    ${title("3. Add a token for a higher limit", `${fmt(state.cfg.rateLimit.anonymousPerMinute)} → ${fmt(state.cfg.rateLimit.authenticatedPerMinute)} requests per minute`)}
    <p class="dh-p"><a href="${signin()}">Sign in with GitHub</a> and create a token with <b>API</b> access, then keep it in your environment.</p>
    ${code(`export ${ENV}="${tokenText()}"\ncurl "${ORIGIN}/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}" \\\n  -H "Authorization: Bearer $${ENV}"`, "Shell")}
    ${resources([["#" + (endpointPages()[0]?.[1][0]?.[0] || "api"), "Endpoint reference", "Every endpoint, with live examples."], ["#rate-limits", "Rate limits", "Headers and what to do on 429."], ["#errors", "Handle errors", "Problem details and status codes."]])}`;
  P.authentication = () => hero("REST API", "Authentication", "Reading is open. Sign in for tokens, submissions and a higher limit.") + `
    ${title("Two kinds of bearer token")}
    <div class="dh-quick two"><div class="dh-quick-text"><div class="dh-number">PERSONAL ACCESS TOKENS</div><h3><code>${esc(state.cfg.tokenPrefix)}…</code></h3><p>For scripts and AI agents. Scoped (<b>API</b>, <b>MCP</b>), expiring and revocable. Create them on your account page; a token is shown once.</p><a class="dh-link" href="${signin()}">Create a token →</a></div>
      <div class="dh-quick-text alt"><div class="dh-number">SESSION JWT</div><h3>From GitHub sign-in</h3><p>This site keeps it in a secure cookie. For scripts, <code>POST /api/auth/token</code> while signed in returns one, valid for ${esc(state.cfg.sessionHours ?? "a few")} hours.</p></div></div>
    ${code(`curl "${ORIGIN}/api/auth/me" \\\n  -H "Authorization: Bearer ${tokenText()}"`)}
    ${callout(`Keep tokens in environment variables, not in code. Account endpoints (tokens, settings) accept only a signed-in session, so a leaked token can't create more tokens.`)}`;
  P["rate-limits"] = () => hero("REST API", "Rate limits", "Per minute. Every response tells you where you stand.") + `
    <div class="dh-stats"><div><span>Without a token</span><b>${fmt(state.cfg.rateLimit.anonymousPerMinute)}</b><small>per minute, per IP</small></div><div><span>Signed in or with a token</span><b>${fmt(state.cfg.rateLimit.authenticatedPerMinute)}</b><small>per minute, per user</small></div></div>
    <table class="dh-table"><thead><tr><th>Header</th><th>Meaning</th></tr></thead><tbody><tr><td><code>X-RateLimit-Limit</code></td><td>Requests allowed this minute</td></tr><tr><td><code>X-RateLimit-Remaining</code></td><td>Requests left</td></tr><tr><td><code>X-RateLimit-Reset</code></td><td>When the window resets (Unix time)</td></tr><tr><td><code>Retry-After</code></td><td>Seconds to wait, on 429</td></tr></tbody></table>
    ${callout(`Need more for a project? <a href="/contact/">Get in touch</a>; limits can be raised per account.`)}`;
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

  // Endpoint pages from the OpenAPI document, with a live "Try it" for GET requests.
  const endpoint = (id) => {
    const [, name, method, path, op] = endpointPages().flatMap(([, ops]) => ops).find(([pid]) => pid === id);
    const needsAuth = /^\/api\/(tokens|submissions|admin|audit|auth\/(me|token|activity))/.test(path);
    const ps = op.parameters || [];
    const sample = path.replace(/\{(\w+)\}/g, (_, n) => SAMPLE[n] || `<${n}>`);
    const query = ps.filter((p) => p.in === "query" && (p.required || ["q", "size"].includes(p.name))).map((p) => `${p.name}=${p.name === "q" ? encodeURIComponent(D.topic.split(" ")[0]) : p.name === "size" ? 3 : "…"}`).join("&");
    const url = `${ORIGIN}${sample}${query ? `?${query}` : ""}`;
    const body = op.requestBody?.content?.["application/json"]?.schema?.$ref ? state.spec.components.schemas[op.requestBody.content["application/json"].schema.$ref.split("/").pop()] : null;
    const bodyObj = body ? Object.fromEntries(Object.entries(body.properties || {}).map(([k, v]) => [k, v.type === "array" ? [] : v.type === "integer" ? 90 : v.type === "object" ? {} : `<${k}>`])) : null;
    const auth = needsAuth ? `Bearer ${tokenText()}` : null;
    const ex = {
      cURL: [`curl${method === "get" ? "" : ` -X ${method.toUpperCase()}`} "${url}"`, auth && `  -H "Authorization: ${auth}"`, bodyObj && `  -H "Content-Type: application/json"`, bodyObj && `  -d '${JSON.stringify(bodyObj)}'`].filter(Boolean).join(" \\\n"),
      Python: `import requests\n\nresponse = requests.${method}(\n    "${url}",${auth ? `\n    headers={"Authorization": "${auth}"},` : ""}${bodyObj ? `\n    json=${JSON.stringify(bodyObj)},` : ""}\n)\nresponse.raise_for_status()\nprint(response.json())`,
      JavaScript: `const response = await fetch("${url}", {${method !== "get" ? `\n  method: "${method.toUpperCase()}",` : ""}${auth || bodyObj ? `\n  headers: { ${[auth && `Authorization: "${auth}"`, bodyObj && `"Content-Type": "application/json"`].filter(Boolean).join(", ")} },` : ""}${bodyObj ? `\n  body: JSON.stringify(${JSON.stringify(bodyObj)}),` : ""}\n});\nconst data = await response.json();`,
    };
    const params = ps.length
      ? `<table class="dh-table"><thead><tr><th>Parameter</th><th>Type</th><th>Description</th></tr></thead><tbody>${ps.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.schema?.type || (p.schema?.anyOf || []).map((x) => x.type).filter((t) => t !== "null").join(" | ") || "string")} · ${p.in}${p.required ? " · required" : ""}</td><td>${esc(p.description || p.schema?.description || (p.schema?.enum ? p.schema.enum.join(" · ") : ""))}${p.schema?.default != null ? ` <span class="dh-muted">(default ${esc(p.schema.default)})</span>` : ""}</td></tr>`).join("")}</tbody></table>`
      : `<p class="dh-p dh-muted">No parameters.</p>`;
    const desc = esc(op.description || "").replace(/`([^`]+)`/g, "<code>$1</code>");
    return hero("API reference", esc(name), desc || esc(path)) + `
      <div class="dh-endpoint"><span class="dh-method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code>${needsAuth ? `<span class="dh-auth">Requires sign-in or token</span>` : ""}</div>
      <div class="dh-tabs" role="tablist"><button class="active" data-tab="params">Parameters</button><button data-tab="response">Response</button>${body ? `<button data-tab="body">Request body</button>` : ""}</div>
      <div data-tabpane="params">${params}</div>
      <div data-tabpane="response" hidden>${method === "get" && !needsAuth && !sample.includes("<") ? `<p class="dh-p">A live response from this site, for <code>${esc(sample)}</code>:</p><button class="dh-btn" data-try="${esc(`${sample}${query && !query.includes("…") ? `?${query}` : ""}`)}">Try it</button><div data-try-out></div>` : `<p class="dh-p dh-muted">${needsAuth ? "Needs your token; try it in the <a href='/docs'>interactive console</a> while signed in." : "See the schema in the <a href='/docs'>interactive console</a>."}</p>`}</div>
      ${body ? `<div data-tabpane="body" hidden><table class="dh-table"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${Object.entries(body.properties || {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code>${(body.required || []).includes(k) ? " · required" : ""}</td><td>${esc(v.type || (v.anyOf || []).map((x) => x.type).join(" | "))}</td><td>${esc(v.description || "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${title("Request example")}
      <div class="dh-clientbar" data-lang-bar>${["cURL", "Python", "JavaScript"].map((l) => `<button class="${state.lang === l ? "active" : ""}" data-lang="${l}">${l}</button>`).join("")}</div>
      ${code(ex[state.lang] || ex.cURL, state.lang)}`;
  };

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
    $("[data-dh-content]").innerHTML = crumbs() + html + `<footer class="dh-footer"><span>© ${esc(BRAND)} · Developer documentation</span><span><a href="/openapi.json">OpenAPI</a> · <a href="/docs">Interactive console</a>${D.repo ? ` · <a href="${esc(D.repo)}">GitHub</a>` : ""}</span></footer>`;
  }
  function route() {
    const want = location.hash.slice(1) || "overview";
    page = exists(want) || (want.startsWith("ep-") && !state.spec) ? want : "overview";
    section = page.startsWith("ep-") ? "api" : sectionOf(page);
    $("[data-dh-search]").value = "";
    render();
    root.classList.remove("side-open");
    $("[data-dh-menu]").setAttribute("aria-expanded", "false");
    window.scrollTo({ top: root.offsetTop - 70 });
  }

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.go) location.hash = t.dataset.go;
    else if (t.dataset.client) { state.client = t.dataset.client; store.set("dh-client", state.client); render(); }
    else if (t.dataset.lang) { state.lang = t.dataset.lang; store.set("dh-lang", state.lang); render(); }
    else if (t.dataset.tab) {
      $$("[data-tab]").forEach((b) => b.classList.toggle("active", b === t));
      $$("[data-tabpane]").forEach((p) => (p.hidden = p.dataset.tabpane !== t.dataset.tab));
    } else if (t.dataset.try) {
      const out = $("[data-try-out]");
      t.disabled = true;
      try {
        const r = await fetch(t.dataset.try);
        const text = JSON.stringify(await r.json(), null, 2);
        out.innerHTML = code(text.length > 6000 ? text.slice(0, 6000) + "\n…" : text, `JSON · ${r.status} · X-RateLimit-Remaining ${r.headers.get("x-ratelimit-remaining") ?? "—"}`);
      } catch (err) { out.innerHTML = `<p class="dh-p">Request failed: ${esc(err.message)}</p>`; }
      t.disabled = false;
    } else if (t.hasAttribute("data-copy")) {
      try { await navigator.clipboard.writeText(t.closest(".dh-code").querySelector("pre").textContent); t.textContent = "Copied ✓"; } catch { t.textContent = "Select text to copy"; }
      setTimeout(() => (t.textContent = "Copy"), 1800);
    } else if (t.hasAttribute("data-dh-menu")) {
      const open = !root.classList.contains("side-open");
      root.classList.toggle("side-open", open);
      t.setAttribute("aria-expanded", String(open));
    }
  });
  $("[data-dh-search]").addEventListener("input", renderNav);
  window.addEventListener("hashchange", route);

  route();
  Promise.all([
    fetch("/api/auth/config").then((r) => r.json()).then((c) => (state.cfg = c)).catch(() => {}),
    fetch("/api/auth/session").then((r) => r.json()).then((s) => (state.session = s)).catch(() => {}),
    fetch("/openapi.json").then((r) => r.json()).then((s) => (state.spec = s)).catch(() => {}),
  ]).then(() => route());
})();
