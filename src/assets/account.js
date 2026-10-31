// Sign-in page and account page: profile, tokens, MCP setup, submissions, activity and (superadmins) rate limits,
// users and the audit log. Everything comes from the API on this origin (/api/...), authenticated by the session cookie.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, ...opts });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(body?.detail || `HTTP ${r.status}`), { status: r.status, body });
    return body;
  };
  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      const t = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => (btn.textContent = t), 1500);
    } catch {
      alert("Copy failed; select the text instead.");
    }
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copy(b.closest(".code-block").querySelector("code").textContent, b);
  });

  // ---------- account page ----------
  const page = $("[data-account-page]");
  if (!page) return;
  const intro = $("[data-account-intro]");

  api("/api/auth/session")
    .then((s) => {
      if (!s.user) return location.replace(`/api/auth/github/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
      const u = s.user;
      intro.textContent = `Signed in with GitHub as @${u.login}.`;
      page.hidden = false;
      $("[data-profile]").innerHTML = `
        ${u.avatarUrl ? `<img class="avatar" src="${esc(u.avatarUrl)}&s=160" alt="" width="72" height="72">` : ""}
        <div><h2>${esc(u.name || u.login)}</h2><p class="small"><a href="${esc(u.url)}" rel="noopener">@${esc(u.login)}</a>${u.superadmin ? ' · <span class="badge">superadmin</span>' : ""}</p></div>`;
      $("[data-my-limit]").textContent = fmt(s.rateLimit.perMinute);
      $("[data-anon-limit]").textContent = fmt(s.rateLimit.anonymousPerMinute);
      mcpSetup();
      loadTokens();
      loadSubmissions();
      loadActivity();
      if (u.superadmin) admin();
    })
    .catch((e) => (intro.textContent = `Couldn't load your account (${e.message}).`));

  $("[data-signout]").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  });

  // MCP setup snippets use this site's own address.
  const brand = ($("[data-mcp-cmd]").textContent.match(/http (\S+)/) || [])[1] || "catalog";
  function mcpSetup(token = "<token>") {
    const url = `${location.origin}/mcp/`;
    $("[data-mcp-cmd]").textContent = `claude mcp add --transport http ${brand} ${url} --header "Authorization: Bearer ${token}"`;
    $("[data-mcp-json]").textContent = JSON.stringify({ mcpServers: { [brand]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }

  // Tokens
  async function loadTokens() {
    const tokens = await api("/api/tokens");
    $("[data-tokens]").innerHTML = tokens.length
      ? tokens.map((t) => `<tr><td>${esc(t.name)}</td><td><code>${esc(t.hint)}</code></td><td>${t.scopes.map((x) => `<span class="chip">${esc(x.toUpperCase())}</span>`).join(" ")}</td><td>${when(t.createdAt)}</td><td>${when(t.lastUsedAt)}</td><td>${t.expiresAt ? when(t.expiresAt) : "never"}</td><td><button type="button" class="btn-ghost btn-sm" data-revoke="${esc(t.id)}">Revoke</button></td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">No tokens yet.</td></tr>`;
  }
  $("[data-tokens]").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-revoke]")?.dataset.revoke;
    if (!id || !confirm("Revoke this token? Anything using it will stop working.")) return;
    await api(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }).catch((err) => alert(err.message));
    loadTokens();
    loadActivity();
  });
  $("[data-token-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const scopes = $$('input[name="scope"]:checked', f).map((x) => x.value);
    if (!scopes.length) return alert("Choose API, MCP or both.");
    try {
      const t = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: f.elements.name.value.trim(), scopes, expiresInDays: f.elements.expires.value ? Number(f.elements.expires.value) : null }) });
      $("[data-token-value]").textContent = t.token;
      $("[data-token-new]").hidden = false;
      if (scopes.includes("mcp")) {
        mcpSetup(t.token);
        // Lets the API & MCP guide fill this token into its commands (this tab only).
        try { sessionStorage.setItem("new-mcp-token", t.token); } catch {}
      }
      f.reset();
      loadTokens();
      loadActivity();
    } catch (err) {
      alert(err.message);
    }
  });
  $("[data-copy-token]").addEventListener("click", (e) => copy($("[data-token-value]").textContent, e.target));

  // Submissions and activity
  async function loadSubmissions() {
    const rows = await api("/api/submissions");
    $("[data-submissions]").innerHTML = rows.length
      ? rows.map((x) => `<tr><td>${when(x.createdAt)}</td><td>${x.entryId ? `<a href="/o/${esc(x.updateOf || x.entryId)}/">${esc(x.entryId)}</a>` : "—"}</td><td>${x.updateOf ? "Correction" : "New entry"}</td><td>${x.issueUrl ? `<a href="${esc(x.issueUrl)}" rel="noopener">Open issue form</a>` : "—"}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">No submissions yet.</td></tr>`;
  }
  const ACTIONS = {
    "auth.login": "Signed in", "auth.logout": "Signed out", "auth.login_failed": "Sign-in failed", "auth.jwt_issued": "Session token issued",
    "token.create": "Token created", "token.revoke": "Token revoked", "submission.create": "Submitted an entry",
    "admin.rate_limits": "Changed rate limits", "admin.user_rate_limit": "Changed a user's rate limit", "catalog.ingest": "Catalog data loaded",
  };
  const details = (a) => {
    const d = a.details || {};
    if (a.action.startsWith("token.")) return `${esc(d.name || "")}${d.scopes ? ` (${esc(d.scopes.join(", "))})` : ""}`;
    if (a.action === "submission.create") return `${esc(d.name || a.target || "")}${d.updateOf ? ` · correction to ${esc(d.updateOf)}` : ""}`;
    if (a.action === "admin.rate_limits") return `${fmt(d.before?.anonymousPerMinute)}/${fmt(d.before?.authenticatedPerMinute)} → ${fmt(d.after?.anonymousPerMinute)}/${fmt(d.after?.authenticatedPerMinute)} per min`;
    if (a.action === "admin.user_rate_limit") return `@${esc(a.target)}: ${d.perMinute == null ? "default" : fmt(d.perMinute) + "/min"}`;
    if (a.action === "catalog.ingest") return `${fmt(d.entries)} entries, ${fmt(d.runsAdded)} new run(s), by ${esc(d.operator || "system")}`;
    if (a.action.startsWith("auth.")) return esc(d.method || d.reason || "");
    return esc(JSON.stringify(d));
  };
  async function loadActivity() {
    const rows = await api("/api/auth/activity?limit=50");
    $("[data-activity]").innerHTML = rows.length
      ? rows.map((a) => `<tr><td>${when(a.at)}</td><td>${esc(ACTIONS[a.action] || a.action)}</td><td>${details(a)}</td><td class="muted small">${esc(a.ip || "")}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">No activity yet.</td></tr>`;
  }

  // Superadmin: rate limits, users, audit log
  function admin() {
    $("[data-admin]").hidden = false;
    const form = $("[data-limits-form]");
    api("/api/admin/settings").then((s) => {
      form.elements.anonymousPerMinute.value = s.rateLimit.anonymousPerMinute;
      form.elements.authenticatedPerMinute.value = s.rateLimit.authenticatedPerMinute;
      $("[data-limit-defaults]").textContent = `Defaults from the server's environment: ${fmt(s.defaults.anonymousPerMinute)} anonymous, ${fmt(s.defaults.authenticatedPerMinute)} signed in. Changes apply within seconds and are recorded in the audit log.`;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("[data-limits-status]");
      try {
        await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ anonymousPerMinute: Number(form.elements.anonymousPerMinute.value), authenticatedPerMinute: Number(form.elements.authenticatedPerMinute.value) }) });
        status.textContent = "Saved ✓";
        loadAudit(true);
      } catch (err) {
        status.textContent = err.message;
      }
      setTimeout(() => (status.textContent = ""), 3000);
    });

    let typing;
    const search = $("[data-user-search]");
    const loadUsers = async () => {
      const users = await api(`/api/admin/users${search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : ""}`);
      $("[data-users]").innerHTML = users.length
        ? users.map((u) => `<tr><td>${u.avatarUrl ? `<img class="avatar-sm" src="${esc(u.avatarUrl)}&s=40" alt="" width="20" height="20"> ` : ""}<a href="${esc(u.url)}" rel="noopener">@${esc(u.login)}</a>${u.superadmin ? ' <span class="badge">superadmin</span>' : ""}<br><span class="small muted">${esc(u.name || "")}</span></td><td class="small">${esc(u.email || "—")}</td><td class="small">${when(u.lastLoginAt)}</td><td class="num">${fmt(u.activeTokens)}</td>
            <td><form class="user-limit" data-user="${u.id}"><input type="number" min="1" name="perMinute" value="${u.rateLimit ?? ""}" placeholder="default" aria-label="Requests per minute for @${esc(u.login)}"><button class="btn-ghost btn-sm" type="submit">Set</button></form></td></tr>`).join("")
        : `<tr><td colspan="5" class="muted">No users.</td></tr>`;
    };
    search.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(loadUsers, 250);
    });
    $("[data-users]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.closest("form[data-user]");
      const v = f.elements.perMinute.value;
      try {
        await api(`/api/admin/users/${f.dataset.user}/rate-limit`, { method: "PUT", body: JSON.stringify({ perMinute: v ? Number(v) : null }) });
        f.querySelector("button").textContent = "Saved ✓";
        setTimeout(() => (f.querySelector("button").textContent = "Set"), 1500);
        loadAudit(true);
      } catch (err) {
        alert(err.message);
      }
    });
    loadUsers();

    let oldest = null;
    const more = $("[data-audit-more]");
    async function loadAudit(reset) {
      if (reset) oldest = null;
      const action = $("[data-audit-action]").value;
      const rows = await api(`/api/audit?limit=50${action ? `&action=${encodeURIComponent(action)}` : ""}${oldest ? `&before=${oldest}` : ""}`);
      const html = rows.map((a) => `<tr><td class="small">${when(a.at)}</td><td>${a.actor ? `@${esc(a.actor.login)}` : '<span class="muted">system</span>'}</td><td>${esc(ACTIONS[a.action] || a.action)}</td><td class="small">${esc(a.target || "")}</td><td class="small">${details(a)}</td><td class="muted small">${esc(a.ip || "")}</td></tr>`).join("");
      const body = $("[data-audit]");
      body.innerHTML = (reset || !oldest ? "" : body.innerHTML) + (html || (oldest ? "" : `<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`));
      if (rows.length) oldest = rows[rows.length - 1].id;
      more.hidden = rows.length < 50;
    }
    $("[data-audit-action]").addEventListener("change", () => loadAudit(true));
    more.addEventListener("click", () => loadAudit(false));
    loadAudit(true);
  }
})();
