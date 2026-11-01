// Developer docs (/api-docs/): REST API (quickstart, guides, every endpoint from /openapi.json with live
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
  // Two pages share this script: the REST API docs (/api-docs/) and the MCP docs (/mcp-docs/). A link to the other
  // section's page goes to that page.
  const HOME = D.section === "mcp" ? "mcp" : "api";
  const PATHS = { api: "/api-docs/", mcp: "/mcp-docs/" };
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
    let r = await fetch(path, { method, headers, body: body || undefined, credentials: "same-origin" });
    let dropped = false;
    if (r.status === 401 && headers.Authorization) {
      try { sessionStorage.removeItem("dh-token"); } catch {}
      $$("[data-token-input]").forEach((i) => (i.value = ""));
      delete headers.Authorization;
      dropped = true;
      r = await fetch(path, { method, headers, body: body || undefined, credentials: "same-origin" });
    }
    const ms = Math.round(performance.now() - t0);
    const raw = await r.text();
    let text = raw;
    try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
    if (text.length > 8000) text = text.slice(0, 8000) + "\n… (truncated)";
    const lim = r.headers.get("x-ratelimit-limit"), left = r.headers.get("x-ratelimit-remaining");
    return `${dropped ? `<p class="dh-p dh-muted">The token saved on this page was not accepted (expired or revoked), so it was removed and the request was sent without it.</p>` : ""}<div class="dh-response ${r.ok ? "ok" : "err"}"><div class="dh-codehead"><span><b class="dh-status">${r.status} ${esc(r.statusText || "")}</b> · ${esc(method)} ${esc(path)} · ${ms} ms${lim ? ` · ${left}/${lim} requests left this minute` : ""}</span><button type="button" class="dh-copy" data-copy>Copy</button></div><pre>${esc(text || "(empty response)")}</pre></div>`;
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
    api: [["REST API", [["api", "Quickstart"], ["authentication", "Authentication"], ["rate-limits", "Rate limits"], ["pagination", "Search & pagination"], ["examples", "Examples"]]],
      ...endpointPages().map(([tag, ops]) => [`Reference · ${tag}`, ops.map(([id, name, method]) => [id, name, method])]),
      ["Support", [["errors", "Errors & responses"]]]],
    mcp: [["MCP server", [["mcp", "Overview"], ["connect", "Connect your client"]]], ["Tools", [["tools", "Available tools"], ["workflow", "Example workflow"]]], ["Support", [["troubleshooting", "Troubleshooting"]]]],
  });
  const sectionOf = (page) => {
    const g = GROUPS();
    return g.mcp.some(([, items]) => items.some(([id]) => id === page)) ? "mcp" : "api";
  };
  const exists = (page) => Object.values(GROUPS()).some((g) => g.some(([, items]) => items.some(([id]) => id === page)));
  let page = HOME, section = HOME;

  // Toggle one group without losing the reader's place in the sidebar.
  function renderNavKeep(group, open) {
    const side = $("[data-dh-side]");
    const top = side.scrollTop;
    if (open) state.open.add(group); else { state.open.delete(group); state.forceClosed = group; }
    renderNav();
    side.scrollTop = top;
    fitSticky();
  }
  function renderNav() {
    const q = $("[data-dh-search]").value.trim().toLowerCase();
    const groups = q ? Object.values(GROUPS()).flat() : GROUPS()[section];
    const seen = new Set();
    // Reference groups fold to a heading with a count, so the whole sidebar fits; the current page's group is open.
    const html = groups.map(([label, items]) => {
      const list = items.filter(([id, name]) => !seen.has(id) && (!q || name.toLowerCase().includes(q) || id.includes(q)));
      list.forEach(([id]) => seen.add(id));
      if (!list.length) return "";
      const links = list.map(([id, name, method]) => `<a class="dh-item${page === id ? " active" : ""}" href="${sectionOf(id) === HOME ? "" : PATHS[sectionOf(id)]}#${id}">${method ? `<span class="dh-mini m-${method}">${method.toUpperCase()}</span>` : ""}${esc(name)}</a>`).join("");
      if (!label.startsWith("Reference")) return `<div class="dh-label">${esc(label)}</div>${links}`;
      const open = q || state.open.has(label) || (state.forceClosed !== label && list.some(([id]) => id === page));
      return `<button type="button" class="dh-group" data-group="${esc(label)}" aria-expanded="${!!open}"><span>${esc(label.replace("Reference · ", ""))}</span><small>${list.length}</small></button>${open ? `<div class="dh-group-items">${links}</div>` : ""}`;
    }).join("");
    $("[data-dh-nav]").innerHTML = html || `<div class="dh-empty">No matching pages.</div>`;
  }

  // ---------- pages ----------
  const first = () => `curl "${ORIGIN}/api/entries?q=${encodeURIComponent(D.topic.split(" ")[0])}&sort=score&size=5"`;
  const P = {};
  P.examples = () => hero("REST API", "Integration <em>examples.</em>", "A starting point for your next workflow.") + `
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
    ${title("How limits are counted")}
    <ul class="dh-list">
      <li><b>Per account when signed in.</b> Your browser session and all your tokens share one budget of ${fmt(state.cfg.rateLimit.authenticatedPerMinute)} requests per minute; more tokens don't give more requests. See your usage on your <a href="/account/">account page</a>.</li>
      <li><b>Per network when signed out:</b> ${fmt(state.cfg.rateLimit.anonymousPerMinute)} requests per minute per IP address.</li>
      <li><b>A ceiling per IP address</b> applies to everyone, signed in or not, and is checked before anything else, so floods are turned away early.</li>
      <li><b>Automatic blocks:</b> sending more than three times your limit in a minute, or going over it three minutes running, blocks you for a short time (the error says how long). Contact us if you were blocked by mistake.</li>
      <li>Counts are shared by all of our servers and kept for a few days to protect the service; IP addresses are stored only as a one-way hash.</li>
    </ul>
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
  // Status codes with a plain-language explanation and what to do, for people who don't read HTTP codes every day.
  const ERRORS = () => [
    ["200", "OK", "It worked. The answer is in the response body.", "Nothing."],
    ["400", "Bad request", "The request itself is malformed, for example broken JSON in the body.", "Check the request against the examples on the endpoint's page."],
    ["401", "Missing, invalid or expired token", "We couldn't tell who you are: the token is missing a character, has expired or was revoked. Reading the catalog doesn't need a token at all.", `Remove the token to read anonymously, or <a href="${signin()}">create a new one</a>.`],
    ["403", "The token lacks the scope (API or MCP), or not allowed", "We know who you are, but this token or account isn't allowed to do this, for example an MCP-only token calling the REST API, or a non-admin calling an admin endpoint.", "Create a token with the right access ticked (REST API, MCP or both)."],
    ["404", "No such entry, run or category", "What you asked for doesn't exist: usually a typo in an id, or an id that was renamed.", "Check the id by searching with <code>GET /api/entries?q=…</code>."],
    ["422", "Invalid parameters or entry", "The request is well formed but a value isn't allowed, for example <code>size=500</code> when the maximum is 100, or a submission without a description.", "Read <code>detail</code> in the response: it says which value to fix."],
    ["429", "Rate limit exceeded: wait for Retry-After", `You sent more requests in one minute than your limit allows (${fmt(state.cfg.rateLimit.anonymousPerMinute)} without a token, ${fmt(state.cfg.rateLimit.authenticatedPerMinute)} with one). Nothing is broken and nothing is blocked for long.`, `Wait the number of seconds in the <code>Retry-After</code> header, then try again. Cache results, or <a href="#rate-limits">use a token</a> for a higher limit.`],
    ["503", "Catalog not loaded or a service is down", "Our side has a problem, for example the catalog is being reloaded. It's not caused by your request.", "Wait a minute and retry. If it lasts, <a href=\"/contact/\">let us know</a>."],
  ];
  P.errors = () => hero("REST API", "Errors &amp; responses", "Every response has a standard status code; errors also explain themselves in a small JSON body.") + `
    <p class="dh-p">The status code says, in a number, how the request went: <b>2xx</b> means it worked, <b>4xx</b> means something about the request needs changing, and <b>5xx</b> means the problem is on our side. Every error response also has a <code>detail</code> field that says, in words, what went wrong.</p>
    <table class="dh-table dh-errors"><thead><tr><th>Status</th><th>What it means</th><th>What to do</th></tr></thead><tbody>${ERRORS().map(([c, t, plain, fix]) => `<tr><td><code>${c}</code></td><td><b>${t}</b><br><span class="dh-muted">${plain}</span></td><td>${fix}</td></tr>`).join("")}</tbody></table>
    ${title("What an error looks like", "RFC 7807 problem details")}
    <p class="dh-p">Errors use a standard format, so most HTTP libraries can read them. <code>title</code> names the problem, <code>status</code> repeats the code, <code>detail</code> explains this case and <code>instance</code> is the path you called.</p>
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


  // One endpoint as Markdown, for pasting into an assistant.
  function endpointMarkdown(id) {
    const [, name, method, path, op] = opById(id);
    const rows = (op.parameters || []).map((p) => `| \`${p.name}\` | ${p.in} | ${typeOf(p.schema)} | ${p.required ? "yes" : "no"} | ${(p.description || "").replace(/\|/g, "\\|")} |`);
    return [`## ${name}: \`${method.toUpperCase()} ${path}\``, "", `Base URL: ${ORIGIN}. Authentication: ${authNeeded(path) ? "required (Authorization: Bearer <token>)" : "none needed; a token raises the rate limit"}.`, "",
      op.description || "", "", ...(rows.length ? ["| Parameter | In | Type | Required | Description |", "|---|---|---|---|---|", ...rows, ""] : []),
      "```bash", examples(id).cURL, "```", "", `Full reference: ${ORIGIN}/llms-full.txt`].join("\n");
  }

  // Every page as Markdown ("Copy for LLM" / "View as Markdown"). Endpoint pages use their own summary; other pages
  // are converted from what is on screen (headings, text, tables, lists, code; tokens stay masked).
  function pageMarkdown() {
    const form = $("[data-ep-form]");
    if (form) return endpointMarkdown(form.dataset.ep);
    const main = $("[data-dh-content]");
    const abs = (h) => { try { return new URL(h, location.href).href; } catch { return h; } };
    const inline = (el) => [...el.childNodes].map((n) => {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, " ");
      if (n.nodeType !== 1) return "";
      if (n.tagName === "CODE") return "`" + n.textContent + "`";
      if (n.tagName === "A") return `[${inline(n).trim()}](${abs(n.getAttribute("href"))})`;
      if (n.tagName === "B" || n.tagName === "STRONG") return `**${inline(n).trim()}**`;
      if (n.tagName === "BR") return "\n";
      return inline(n);
    }).join("");
    const cell = (c) => inline(c).trim().replace(/\|/g, "\\|");
    const h1 = $(".dh-hero h1", main);
    const out = [`# ${h1 ? inline(h1).replace(/\s+/g, " ").trim() : BRAND}`, "", inline($(".dh-hero .dh-lead", main) || document.createElement("p")).trim(), "", `Source: ${location.href}`];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(".dh-crumbs, .dh-hero, .dh-pagebar, .dh-out, .dh-response, form, button, .dh-clientbar, .dh-actions, .dh-tokenbox, .dh-step-body > h3, script")) continue;
        if (/^H[1-4]$/.test(c.tagName)) out.push("", `${"#".repeat(Math.max(2, +c.tagName[1]))} ${c.textContent.trim()}`);
        else if (c.tagName === "P") { const t = inline(c).trim(); if (t) out.push("", t); }
        else if (c.matches(".dh-code")) out.push("", "```" + ($(".dh-codehead span", c)?.textContent.trim().toLowerCase().startsWith("curl") ? "bash" : ""), $("pre", c).textContent.trim(), "```");
        else if (c.tagName === "TABLE") {
          const head = [...c.querySelectorAll("thead th")].map(cell);
          out.push("", `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...[...c.querySelectorAll("tbody tr")].map((r) => `| ${[...r.children].map(cell).join(" | ")} |`));
        } else if (c.tagName === "UL" || c.tagName === "OL") out.push("", ...[...c.children].map((li, i) => `${c.tagName === "OL" ? `${i + 1}.` : "-"} ${inline(li).trim()}`));
        else if (c.matches(".dh-step")) { out.push("", `## ${$(".dh-step-n", c).textContent.trim()}. ${$("h3", c).textContent.trim()}`); walk($(".dh-step-body", c)); continue; }
        else walk(c);
      }
    };
    walk(main);
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + `\n\nFull reference for LLMs: ${ORIGIN}/llms-full.txt\n`;
  }
  // Under each page title: copy or view the page as Markdown, or set up an agent (as on docs.stripe.com).
  const pageBar = () => `<div class="dh-pagebar" role="toolbar" aria-label="Page tools">
    <button type="button" data-copy-md><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>Copy for LLM</button>
    <button type="button" data-view-md><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6M17 9v6m-2-2 2 2 2-2"/></svg>View as Markdown</button>
    <a href="#connect"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2"/></svg>Set up agent</a>
    <a href="/llms-full.txt" target="_blank" rel="noopener" title="The whole API and MCP reference in one Markdown file, for AI assistants"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h5"/></svg>Full reference (.txt)</a>
  </div>`;

  // MCP
  const CLIENTS = {
    "claude-code": ["Claude Code", "Terminal", () => `claude mcp add --transport http ${SLUG} ${ORIGIN}/mcp/ \\\n  --header "Authorization: Bearer ${tokenText()}"`, "Then start a new session; <code>claude mcp list</code> should show it."],
    "claude-desktop": ["Claude Desktop", "claude_desktop_config.json", () => JSON.stringify({ mcpServers: { [SLUG]: { command: "npx", args: ["-y", "mcp-remote", `${ORIGIN}/mcp/`, "--header", `Authorization: Bearer ${tokenText()}`] } } }, null, 2), "Settings → Developer → Edit config, then restart Claude Desktop. <code>mcp-remote</code> bridges the remote server."],
    cursor: ["Cursor", "~/.cursor/mcp.json", () => JSON.stringify({ mcpServers: { [SLUG]: { url: `${ORIGIN}/mcp/`, headers: { Authorization: `Bearer ${tokenText()}` } } } }, null, 2), "Then enable the server in Cursor's MCP settings."],
    vscode: ["VS Code", ".vscode/mcp.json", () => JSON.stringify({ servers: { [SLUG]: { type: "http", url: `${ORIGIN}/mcp/`, headers: { Authorization: `Bearer ${tokenText()}` } } } }, null, 2), "Then start the server from the MCP view or the file's code lens."],
    codex: ["Codex", "~/.codex/config.toml", () => `[mcp_servers.${SLUG}]\nurl = "${ORIGIN}/mcp/"\nbearer_token_env_var = "${ENV}"\n\n# in your shell:\nexport ${ENV}="${tokenText()}"`, "Restart Codex with the variable set."],
    generic: ["Other client", "Settings", () => `Server name: ${BRAND}\nServer URL:  ${ORIGIN}/mcp/\nTransport:   Streamable HTTP\nHeader:      Authorization: Bearer ${tokenText()}`, "Any MCP client that supports remote (streamable HTTP) servers with a header."],
  };
  // Step-by-step setup per client, for people who have never added an MCP server before.
  const CLIENT_STEPS = {
    "claude-code": [
      "Open a terminal (on any folder; the server is added for your user).",
      "Paste the command above and press Enter.",
      "Start a new Claude Code session with <code>claude</code>. Type <code>/mcp</code>: the server should be listed as connected. <code>claude mcp list</code> shows it from the terminal too.",
    ],
    "claude-desktop": [
      "Install <a href=\"https://nodejs.org\" rel=\"noopener\">Node.js</a> (version 18 or later) if you don't have it. Claude Desktop uses it to run <code>mcp-remote</code>, a small bridge to remote servers.",
      "In Claude Desktop open <b>Settings → Developer → Edit Config</b>. This opens <code>claude_desktop_config.json</code>.",
      "Paste the configuration above. If the file already has an <code>mcpServers</code> section, add the inner entry to it instead of replacing the file.",
      "Save, then quit Claude Desktop completely and open it again. The tools appear in the tools menu of the message box.",
    ],
    cursor: [
      "Open <b>Cursor Settings → MCP</b> and choose <b>Add new MCP server</b>, or open <code>~/.cursor/mcp.json</code> directly.",
      "Paste the configuration above (merge it into <code>mcpServers</code> if the file has other servers) and save.",
      "Back in the MCP settings, turn the server on. A green dot means it connected. Use it from the chat in Agent mode.",
    ],
    vscode: [
      "In your project, create the file <code>.vscode/mcp.json</code> (or run <b>MCP: Add Server</b> from the Command Palette).",
      "Paste the configuration above and save.",
      "Click <b>Start</b> above the server entry in the file. Then open Copilot Chat, switch to <b>Agent</b> mode, and check the tools button: the six tools should be listed.",
    ],
    codex: [
      "Open (or create) <code>~/.codex/config.toml</code> and paste the first lines above.",
      `Set the token in your shell, as in the last line. To keep it, add that line to your shell profile (for example <code>~/.zshrc</code>).`,
      "Start Codex from that shell. Type <code>/mcp</code> to see the server and its tools.",
    ],
    generic: [
      "Find where your client adds a <b>remote</b> MCP server (sometimes called a custom connector or HTTP server).",
      "Enter the server URL and add the <code>Authorization</code> header shown above. Choose the <b>Streamable HTTP</b> transport if asked.",
      "Restart or reload the client so it picks up the new server.",
    ],
  };
  P.mcp = () => hero("Model Context Protocol", `Your AI.<br><em>A world of context.</em>`, `Connect an AI assistant to ${esc(BRAND)} and ask about ontologies, schemas and standards in plain language, with the scores and evidence behind every answer.`) + `
    ${title("What is MCP?")}
    <p class="dh-p">The <b>Model Context Protocol</b> (MCP) is an open standard that lets AI assistants such as Claude, Cursor, VS Code Copilot and Codex use outside tools. Once you connect ${esc(BRAND)}, your assistant can look things up in the catalog by itself while it answers you, instead of relying on what it remembers, which may be out of date or wrong.</p>
    <div class="dh-quick two"><div class="dh-quick-text"><div class="dh-number">WITHOUT MCP</div><h3>“Which ontology should I use for ${esc(D.topic)}?”</h3><p>The assistant answers from memory: no scores, no sources, possibly outdated.</p></div>
      <div class="dh-quick-text alt"><div class="dh-number">WITH ${esc(BRAND.toUpperCase())}</div><h3>Same question</h3><p>The assistant searches the catalog, reads each candidate's evaluation and answers with grades, links and the reasons behind them.</p></div></div>
    ${title("How it works")}
    ${step(1, "You ask a question", `<p class="dh-p">In your usual assistant, in plain language. Nothing changes in how you work.</p>`)}
    ${step(2, "The assistant calls a tool", `<p class="dh-p">It picks one of ${esc(BRAND)}'s <a href="#tools">six read-only tools</a>, for example <code>search_catalog</code>, and sends the request with your token. Many clients ask you to approve the first call.</p>`)}
    ${step(3, "It answers with evidence", `<p class="dh-p">The tool returns catalog data: scores, grades, criteria and links. The assistant uses it in its answer, so you can check every claim on the resource's page.</p>`)}
    ${title("What you need")}
    <ul class="dh-list"><li>An MCP client: Claude Code, Claude Desktop, Cursor, VS Code with Copilot, Codex or another client that supports remote servers.</li><li>A free GitHub account, to sign in to ${esc(BRAND)}.</li><li>A personal access token with <b>MCP</b> access. It identifies you and gives you ${fmt(state.cfg.rateLimit.authenticatedPerMinute)} requests per minute.</li></ul>
    ${callout(`Ready? <a href="#connect">Connect your client step by step →</a> It takes about five minutes.`, "ok")}
    ${title("Is it safe?")}
    <p class="dh-p">The tools only <b>read</b> public catalog data; your assistant cannot change anything. ${esc(BRAND)} sees the requests your assistant makes (for example the search words) and logs them against your token for rate limiting, not your conversation. You can revoke a token at any time on your account page.</p>`;
  const connectBlock = () => {
    const c = CLIENTS[state.client] || CLIENTS["claude-code"];
    return `<div class="dh-clientbar" data-client-bar>${Object.entries(CLIENTS).map(([k, [n]]) => `<button class="${state.client === k ? "active" : ""}" data-client="${k}">${n}</button>`).join("")}</div>${code(c[2](), `${c[0]} · ${c[1]}`)}
      <ol class="dh-steps-list">${(CLIENT_STEPS[state.client] || CLIENT_STEPS["claude-code"]).map((t) => `<li>${t}</li>`).join("")}</ol>`;
  };
  P.connect = () => {
    const have = !!token();
    return hero("MCP server", "Connect your <em>client.</em>", `Four steps, about five minutes. No programming needed.`) + `
    ${step(1, "Create a token with MCP access", `<p class="dh-p">${state.session?.user ? `You're signed in as <b>@${esc(state.session.user.login)}</b>.` : "Sign in with your GitHub account (there's nothing else to register)."} On your account page, open <b>Access tokens → Create token</b>, give it a name such as “Claude on my laptop”, keep <b>MCP</b> ticked and copy the token. It is shown only once.</p>
      <p class="dh-p">${have ? `<b>✓ Your new token is filled in below</b> (in this browser tab only).` : `<a class="dh-btn" href="${signin()}">${state.session?.user ? "Create a token →" : "Sign in with GitHub →"}</a>`}</p>`)}
    ${step(2, "Add the server to your client", `<p class="dh-p">Choose your assistant. Copy what's shown and follow the steps under it.${have ? "" : " Replace <code>&lt;your token&gt;</code> with the token from step 1."}</p>${connectBlock()}`)}
    ${step(3, "Check that it works", `<p class="dh-p">In a new conversation, ask <b>“Which ${esc(BRAND)} tools do you have?”</b> The assistant should list six tools, such as <code>search_catalog</code> and <code>get_entry</code>. If it doesn't, see <a href="#troubleshooting">Troubleshooting</a>.</p>`)}
    ${step(4, "Ask a real question", `<p class="dh-p">Try one of these. Your client may ask you to allow the tool the first time.</p>${code(`Find the best-scored ${BRAND} ontologies for ${D.topic}, with their grades.\nWhy does ${D.entryName} score what it does? Show the evidence per criterion.\nHow has ${D.entryName}'s score changed across evaluation runs?`, "Prompts")}`)}
    ${callout(`Keep your token private: anyone with it can use your rate limit. If it leaks, revoke it on your account page and create a new one.`)}
    ${resources([["#tools", "Available tools", "What your assistant can look up."], ["#workflow", "Example workflow", "From a question to resources you can rely on."], ["#troubleshooting", "Troubleshooting", "If the tools don't show up."]])}`;
  };
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
    return `<div class="dh-crumbs"><a href="#${HOME}">Developers</a> <span>/</span> ${section === "api" ? "REST API" : "MCP server"}${!["api", "mcp"].includes(page) && pageName ? ` <span>/</span> <b>${esc(pageName)}</b>` : ""}</div>`;
  };
  function render() {
    renderNav();
    const html = page.startsWith("ep-") ? (state.spec ? endpoint(page) : `<p class="dh-p dh-muted">Loading…</p>`) : (P[page] || P[HOME])();
    $("[data-dh-content]").innerHTML = crumbs() + html;
    $(".dh-hero", $("[data-dh-content]"))?.insertAdjacentHTML("afterend", pageBar());
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
  // Sticky sidebars that are taller than the window stick by their bottom edge, so every item can be reached.
  const HEADER = 64;
  function fitSticky() {
    for (const el of [$("[data-dh-side]"), $("[data-dh-rail]")]) {
      if (!el) continue;
      el.style.top = `${Math.min(HEADER, window.innerHeight - el.offsetHeight)}px`;
    }
  }
  window.addEventListener("resize", fitSticky);
  function afterRender() {
    renderRail();
    fitSticky();
    const form = $("[data-ep-form]");
    if (form) {
      const [, , method, path] = opById(form.dataset.ep);
      if (method === "get" && !authNeeded(path)) sendEndpoint();
    }
  }
  function route() {
    state.forceClosed = null;
    const want = location.hash.slice(1) || HOME;
    const wantSection = want.startsWith("ep-") ? "api" : exists(want) ? sectionOf(want) : HOME;
    if (wantSection !== HOME) return location.replace(`${PATHS[wantSection]}#${want}`);
    page = exists(want) || (want.startsWith("ep-") && !state.spec) ? want : HOME;
    section = HOME;
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
    else if (t.hasAttribute("data-view-md")) {
      const url = URL.createObjectURL(new Blob([pageMarkdown()], { type: "text/plain;charset=utf-8" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    else if (t.dataset.copyUrl || t.hasAttribute("data-copy-md")) {
      const label = t.innerHTML;
      try {
        const text = t.dataset.copyUrl ? await (await fetch(t.dataset.copyUrl)).text() : pageMarkdown();
        await navigator.clipboard.writeText(text);
        t.textContent = "Copied ✓";
      } catch { t.textContent = "Copy failed: use Open"; }
      setTimeout(() => (t.innerHTML = label), 1800);
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
  $("[data-dh-search]").addEventListener("input", () => { renderNav(); fitSticky(); });
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
    (async () => {
      for (let i = 0; i < 4 && !state.spec; i++) {
        try { const r = await fetch("/openapi.json"); if (r.ok) state.spec = await r.json(); } catch {}
        if (!state.spec) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      }
    })(),
  ]).then(() => { if (!$("[data-ep-form]") || !state.loadedOnce) route(); state.loadedOnce = true; });
})();
