// Account page: profile, overview (stats, submissions, recent activity), access tokens (create in a dialog, shown
// once; revoke with confirmation), connections (REST API and MCP setup with this site's own URLs) and activity.
// Superadmins get a link to the admin dashboard (/admin/). Data comes from the API on this origin, using the session cookie.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const page = $("[data-account-page]");
  if (!page) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }) : "—");
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const ORIGIN = location.origin;
  const SLUG = ($("[data-brand-slug]")?.innerHTML || "catalog").trim();
  const ENV = SLUG.toUpperCase().replace(/-/g, "_") + "_TOKEN";
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, ...opts });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(body?.detail || `HTTP ${r.status}`), { status: r.status, body });
    return body;
  };
  const toastEl = $("[data-toast]");
  const toast = (msg) => {
    toastEl.textContent = msg;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (toastEl.textContent = ""), 3200);
  };
  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = t), 1500); }
      toast("Copied to clipboard");
    } catch {
      toast("Copy failed: select the text and copy it instead.");
    }
  };

  // ---------- tabs (#overview, #tokens, #connections, #activity) ----------
  const TABS = ["overview", "tokens", "connections", "activity"];
  function showTab(id, push = true) {
    if (!TABS.includes(id)) id = "overview";
    $$(".acc-panel").forEach((p) => (p.hidden = p.id !== id));
    $$("[data-tab]").forEach((b) => { const on = b.dataset.tab === id; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; });
    if (push && location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  }
  $$("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const tabs = $$("[data-tab]").filter((t) => !t.hidden);
      const i = tabs.indexOf(b);
      const n = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      tabs[n].focus();
      showTab(tabs[n].dataset.tab);
    });
  });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));

  // ---------- load ----------
  api("/api/auth/session")
    .then((s) => {
      if (!s.user) return location.replace(`/api/auth/github/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
      const u = s.user;
      const initials = (u.name || u.login).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      $("[data-profile]").innerHTML = `
        ${u.avatarUrl ? `<img class="acc-avatar" src="${esc(u.avatarUrl)}&s=104" alt="" width="52" height="52">` : `<span class="acc-avatar">${esc(initials)}</span>`}
        <div><strong>${esc(u.name || u.login)}</strong><small><a href="${esc(u.url)}" rel="noopener">@${esc(u.login)}</a>${u.superadmin ? ' · <span class="acc-badge">superadmin</span>' : ""}</small></div>
        <span class="acc-connected">Connected with GitHub</span>
        ${u.superadmin ? '<a class="btn-ghost btn-sm acc-admin-link" href="/admin/">Admin dashboard →</a>' : ""}
        <button type="button" class="acc-signout" data-signout>Sign out</button>`;
      $("[data-my-limit]").textContent = fmt(s.rateLimit.perMinute);
      $("[data-anon-limit]").textContent = fmt(s.rateLimit.anonymousPerMinute);
      $("[data-account-body]").hidden = false;
      showTab(location.hash.slice(1) || "overview");
      let saved = "api";
      try { saved = sessionStorage.getItem("acc-conn") || "api"; } catch {}
      selectConnection(saved);
      loadTokens();
      loadSubmissions();
      loadActivity(true);
    })
    .catch((e) => ($("[data-account-intro]").textContent = `Couldn't load your account (${e.message}). Try reloading the page.`));

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.matches("[data-signout]")) {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/";
    } else if (t.dataset.goTab) showTab(t.dataset.goTab);
    else if (t.dataset.openConnection) {
      t.closest("dialog")?.close();
      showTab("connections");
      selectConnection(t.dataset.openConnection);
    } else if (t.matches("[data-close]")) t.closest("dialog").close();
    else if (t.matches("[data-create-token]")) {
      $("[data-token-error]").hidden = true;
      $("[data-create-dialog]").showModal();
    } else if (t.dataset.revoke) {
      pendingRevoke = t.dataset.revoke;
      $("[data-revoke-text]").textContent = `“${t.dataset.name}” stops working immediately, along with anything that uses it.`;
      $("[data-revoke-dialog]").showModal();
    } else if (t.matches("[data-confirm-revoke]")) revoke();
    else if (t.matches("[data-copy-secret]")) copy($("[data-token-value]").textContent, t);
    else if (t.matches("[data-copy-code]")) copy(codeText, t);
    else if (t.dataset.conn) selectConnection(t.dataset.conn);
  });

  // ---------- tokens ----------
  let pendingRevoke = null;
  async function loadTokens() {
    const tokens = await api("/api/tokens");
    $("[data-token-count]").textContent = tokens.length;
    $("[data-stat-tokens]").textContent = fmt(tokens.length);
    $("[data-tokens]").innerHTML = tokens.length
      ? tokens.map((t) => `<tr><td><b>${esc(t.name)}</b><small>Created ${day(t.createdAt)}</small></td><td><code>${esc(t.hint)}</code></td><td>${t.scopes.map((x) => `<span class="acc-badge">${x === "api" ? "REST API" : "MCP"}</span>`).join(" ")}</td><td>${t.lastUsedAt ? when(t.lastUsedAt) : '<span class="muted">Not used yet</span>'}</td><td>${t.expiresAt ? day(t.expiresAt) : "Never"}</td><td class="acc-right"><button type="button" class="acc-danger-link" data-revoke="${esc(t.id)}" data-name="${esc(t.name)}">Revoke</button></td></tr>`).join("")
      : `<tr><td colspan="6"><div class="acc-empty small"><b>No active tokens.</b> Create one to raise your rate limit and connect an AI client.</div></td></tr>`;
  }
  async function revoke() {
    $("[data-revoke-dialog]").close();
    try {
      await api(`/api/tokens/${encodeURIComponent(pendingRevoke)}`, { method: "DELETE" });
      toast("Token revoked");
    } catch (err) {
      toast(err.message);
    }
    pendingRevoke = null;
    loadTokens();
    loadActivity(true);
  }
  $("[data-token-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $("[data-token-error]");
    const scopes = $$('input[name="scope"]:checked', f).map((x) => x.value);
    if (!scopes.length) { err.textContent = "Choose REST API, MCP or both."; err.hidden = false; return; }
    try {
      const t = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: f.elements.name.value.trim(), scopes, expiresInDays: f.elements.expires.value ? Number(f.elements.expires.value) : null }) });
      $("[data-create-dialog]").close();
      f.reset();
      $("[data-token-value]").textContent = t.token;
      $("[data-secret-next]").textContent = scopes.includes("mcp")
        ? "Next: set up your AI client. The setup commands under Connections already include this token (in this browser tab only)."
        : "Next: send it as Authorization: Bearer <token> with your API requests.";
      newToken = t.token;
      // Lets the developer docs fill this token into their commands (this tab only).
      try { sessionStorage.setItem("new-mcp-token", t.token); } catch {}
      updateCode();
      $("[data-secret-dialog]").showModal();
      loadTokens();
      loadActivity(true);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  $("[data-secret-dialog]").addEventListener("close", () => ($("[data-token-value]").textContent = ""));

  // ---------- connections ----------
  let conn = "api";
  let newToken = (() => { try { return sessionStorage.getItem("new-mcp-token"); } catch { return null; } })();
  let codeText = "";
  const tok = () => newToken || "<your token>";
  const mcpUrl = `${ORIGIN}/mcp/`;
  const CLIENTS = {
    "claude-code": ["Claude Code · Terminal", () => `claude mcp add --transport http ${SLUG} ${mcpUrl} \\\n  --header "Authorization: Bearer ${tok()}"`, "Run it in a terminal, then start a new Claude Code session. `claude mcp list` should show the server."],
    "claude-desktop": ["Claude Desktop · claude_desktop_config.json", () => JSON.stringify({ mcpServers: { [SLUG]: { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${tok()}`] } } }, null, 2), "Settings → Developer → Edit config, add this, then restart Claude Desktop. Needs Node.js (mcp-remote connects to the remote server)."],
    cursor: ["Cursor · ~/.cursor/mcp.json", () => JSON.stringify({ mcpServers: { [SLUG]: { url: mcpUrl, headers: { Authorization: `Bearer ${tok()}` } } } }, null, 2), "Save the file, then turn the server on in Cursor Settings → MCP."],
    vscode: ["VS Code · .vscode/mcp.json", () => JSON.stringify({ servers: { [SLUG]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tok()}` } } } }, null, 2), "Save the file in your project, press Start above the server entry, then use Copilot Chat in agent mode."],
    codex: ["Codex · ~/.codex/config.toml", () => `[mcp_servers.${SLUG}]\nurl = "${mcpUrl}"\nbearer_token_env_var = "${ENV}"\n\n# then, in your shell:\nexport ${ENV}="${tok()}"`, "Restart Codex in a shell where the variable is set."],
    json: ["Other clients · JSON", () => JSON.stringify({ mcpServers: { [SLUG]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tok()}` } } } }, null, 2), "Any client that supports remote (streamable HTTP) MCP servers with a header."],
  };
  function selectConnection(type) {
    conn = type === "mcp" ? "mcp" : "api";
    try { sessionStorage.setItem("acc-conn", conn); } catch {}
    $$("[data-conn]").forEach((b) => { b.classList.toggle("active", b.dataset.conn === conn); b.setAttribute("aria-pressed", b.dataset.conn === conn); });
    $("[data-client-wrap]").hidden = conn === "api";
    $("[data-conn-eyebrow]").textContent = conn === "api" ? "For applications & scripts" : "For AI clients & agents";
    $("[data-conn-title]").textContent = conn === "api" ? "Build with structured knowledge." : "Give your AI client a trusted catalog.";
    $("[data-conn-desc]").innerHTML = conn === "api"
      ? `Reading is open to everyone. Send your token to get your higher rate limit, and keep it in an environment variable, never in your code. <a href="/api-docs/#api">API quickstart →</a>`
      : `Your assistant can then search the catalog, read evaluations and compare runs for you. Needs a token with <b>MCP</b> access. <a href="/api-docs/#connect">Step-by-step guide →</a>`;
    updateCode();
  }
  function updateCode() {
    let label, note;
    if (conn === "api") {
      label = "Authenticated request · cURL";
      codeText = `export ${ENV}="${tok()}"\n\ncurl "${ORIGIN}/api/entries?q=anatomy&sort=score&size=5" \\\n  -H "Authorization: Bearer $${ENV}"`;
      note = newToken ? "Your new token is filled in. It stays in this browser tab only." : "Replace <your token> with a token from Access tokens.";
    } else {
      const c = CLIENTS[$("[data-client]").value] || CLIENTS["claude-code"];
      label = c[0];
      codeText = c[1]();
      note = c[2] + (newToken ? " Your new token is filled in." : " Replace <your token> with a token that has MCP access.");
    }
    const masked = newToken ? codeText.split(newToken).join(`${newToken.slice(0, newToken.indexOf("_pat_") + 5)}…${newToken.slice(-4)}`) : codeText;
    $("[data-conn-code]").textContent = masked;
    $("[data-code-label]").textContent = label;
    $("[data-conn-note]").innerHTML = esc(note).replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  $("[data-client]").addEventListener("change", updateCode);

  // ---------- submissions ----------
  const STATUS = { pending: "In review", approved: "Approved", changes_requested: "Changes requested", rejected: "Not accepted" };
  async function loadSubmissions() {
    const rows = await api("/api/submissions");
    $("[data-stat-subs]").textContent = fmt(rows.length);
    $("[data-stat-subs-note]").textContent = rows.length ? `${rows.filter((x) => !x.updateOf).length} new, ${rows.filter((x) => x.updateOf).length} correction(s)` : "Your contributions start here";
    $("[data-submissions]").innerHTML = rows.length
      ? `<ul class="acc-list">${rows.slice(0, 6).map((x) => `<li><span class="acc-dot">${x.updateOf ? "✎" : "＋"}</span><div>${x.updateOf ? `Correction to <a href="/o/${esc(x.updateOf)}/">${esc(x.updateOf)}</a>` : `New entry <b>${esc(x.entryId || "")}</b>`}<small>${when(x.createdAt)}${x.issueUrl ? ` · <a href="${esc(x.issueUrl)}" rel="noopener">GitHub issue</a>` : ""}</small>${x.reviewNotes ? `<small class="acc-review">Reviewer: ${esc(x.reviewNotes)}</small>` : ""}</div><span class="acc-status s-${esc(x.status)}">${esc(STATUS[x.status] || x.status)}</span></li>`).join("")}</ul>`
      : `<div class="acc-empty"><div class="acc-empty-icon">＋</div><h3>Help the catalog grow</h3><p>Know an ontology, schema or vocabulary worth sharing, or spotted a mistake? Submissions are credited to you and reviewed in the open on GitHub.</p><a class="btn-ghost" href="/submit/">Submit a resource</a></div>`;
  }

  // ---------- activity ----------
  const ACTIONS = {
    "auth.login": "Signed in", "auth.logout": "Signed out", "auth.login_failed": "Sign-in failed", "auth.jwt_issued": "Session token issued",
    "token.create": "Token created", "token.revoke": "Token revoked", "submission.create": "Submitted an entry",
    "submission.approved": "Submission approved", "submission.changes_requested": "Changes requested on a submission", "submission.rejected": "Submission rejected", "submission.pending": "Submission reopened", "admin.export": "Exported the catalog",
    "admin.rate_limits": "Changed rate limits", "admin.user_rate_limit": "Changed a user's rate limit", "catalog.ingest": "Catalog data loaded",
  };
  const details = (a) => {
    const d = a.details || {};
    if (a.action.startsWith("token.")) return `${esc(d.name || "")}${d.scopes ? ` · ${esc(d.scopes.map((x) => (x === "api" ? "REST API" : "MCP")).join(", "))}` : ""}`;
    if (a.action === "submission.create") return `${esc(d.name || a.target || "")}${d.updateOf ? ` · correction to ${esc(d.updateOf)}` : ""}`;
    if (a.action === "admin.rate_limits") return `${fmt(d.before?.anonymousPerMinute)}/${fmt(d.before?.authenticatedPerMinute)} → ${fmt(d.after?.anonymousPerMinute)}/${fmt(d.after?.authenticatedPerMinute)} per min`;
    if (a.action === "admin.user_rate_limit") return `@${esc(a.target)}: ${d.perMinute == null ? "default" : fmt(d.perMinute) + "/min"}`;
    if (a.action === "catalog.ingest") return `${fmt(d.entries)} entries, ${fmt(d.runsAdded)} new run(s), by ${esc(d.operator || "system")}`;
    if (a.action.startsWith("auth.")) return esc(d.method === "dev" ? "Sandbox sign-in" : d.method === "github" ? "GitHub" : d.method || d.reason || "");
    return esc(JSON.stringify(d));
  };
  const icon = (a) => (a.action.startsWith("token.") ? "⚿" : a.action.startsWith("submission.") ? "＋" : a.action === "auth.logout" ? "↙" : "↗");
  const eventRow = (a) => `<div class="acc-event"><span class="acc-dot">${icon(a)}</span><div>${esc(ACTIONS[a.action] || a.action)}<small>${[details(a), a.ip ? `from ${esc(a.ip)}` : ""].filter(Boolean).join(" · ")}</small></div><time datetime="${esc(a.at)}">${when(a.at)}</time></div>`;
  let events = [];
  async function loadActivity(reset) {
    const before = reset || !events.length ? "" : `&before=${events[events.length - 1].id}`;
    const rows = await api(`/api/auth/activity?limit=50${before}`);
    events = reset ? rows : events.concat(rows);
    $("[data-activity-more]").hidden = rows.length < 50;
    $("[data-recent]").innerHTML = events.slice(0, 4).map(eventRow).join("") || `<p class="acc-empty small">No activity yet.</p>`;
    renderActivity();
  }
  function renderActivity() {
    const q = $("[data-activity-search]").value.trim().toLowerCase();
    const kind = $("[data-activity-filter]").value;
    const list = events.filter((a) => (!kind || a.action.startsWith(kind)) && (!q || `${ACTIONS[a.action] || a.action} ${details(a)} ${a.ip || ""}`.toLowerCase().includes(q)));
    $("[data-activity]").innerHTML = list.map(eventRow).join("") || `<p class="acc-empty small">No matching activity.</p>`;
  }
  $("[data-activity-search]").addEventListener("input", renderActivity);
  $("[data-activity-filter]").addEventListener("change", renderActivity);
  $("[data-activity-more]").addEventListener("click", () => loadActivity(false));

})();
