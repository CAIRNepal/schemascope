// Admin dashboard (/admin/), superadmins only: overview, submission review, catalog, evaluation runs, users and rate
// limits, and the activity log. Hash-routed views; all data from /api/admin/... and the public API on this origin.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = $("[data-admin-page]");
  if (!root) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const ago = (iso) => {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 172800) return "yesterday";
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(body?.detail || `HTTP ${r.status}`), { status: r.status });
    return body;
  };
  const toastEl = $("[data-toast]");
  const toast = (m) => { toastEl.textContent = m; clearTimeout(toast.t); toast.t = setTimeout(() => (toastEl.textContent = ""), 3200); };
  const KIND = { ontology: "Ontology", schema: "Schema", vocabulary: "Vocabulary", atlas: "Atlas", "data-standard": "Data standard", "knowledge-base": "Knowledge base" };
  const STATUS = { pending: ["Pending", "amber"], approved: ["Approved", "green"], changes_requested: ["Changes requested", "amber"], rejected: ["Rejected", "red"] };
  const pill = (st) => { const [t, c] = STATUS[st] || [st, ""]; return `<span class="adm-pill ${c}">${esc(t)}</span>`; };
  const gradePill = (g) => (g ? `<span class="grade grade-${esc(g)}"><b>${esc(g)}</b></span>` : '<span class="muted">—</span>');
  $("[data-adm-date]").textContent = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  // ---------- views ----------
  const VIEWS = ["overview", "submissions", "catalog", "evaluations", "users", "logs", "activity"];
  const loaded = new Set();
  function show(id) {
    if (!VIEWS.includes(id)) id = "overview";
    $$(".adm-view").forEach((v) => (v.hidden = v.id !== id));
    $$("[data-view-link]").forEach((a) => { const on = a.dataset.viewLink === id; a.classList.toggle("active", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
    $("[data-adm-crumb]").textContent = $(`[data-view-link="${id}"] span`).textContent;
    root.classList.remove("side-open");
    $("[data-adm-menu]").setAttribute("aria-expanded", "false");
    if (!loaded.has(id)) { loaded.add(id); LOAD[id]?.(); }
  }
  $("[data-adm-menu]").addEventListener("click", (e) => {
    const open = !root.classList.contains("side-open");
    root.classList.toggle("side-open", open);
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  $$("[data-adm-signout]").forEach((b) => b.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    location.href = "/";
  }));
  // Run ids are start times (2026-10-31T17-31-10Z); show them as dates.
  const runDate = (id) => {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(id || "");
    return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : id;
  };

  // ---------- start: superadmins only ----------
  api("/api/auth/session").then((s) => {
    if (!s.user) return location.replace(`/api/auth/github/login?next=${encodeURIComponent("/admin/" + location.hash)}`);
    const u = s.user;
    $("[data-admin-me]").innerHTML = `${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}&s=64" alt="" width="30" height="30">` : ""}<div><b>${esc(u.name || u.login)}</b><small>Superadmin</small></div>`;
    if (!u.superadmin) { $("[data-adm-denied]").hidden = false; return; }
    $("[data-adm-views]").hidden = false;
    show(location.hash.slice(1) || "overview");
  });

  // ---------- overview ----------
  async function overview() {
    const o = await api("/api/admin/overview");
    const st = o.stats, ac = o.accounts, pending = ac.submissions.pending || 0;
    const coverage = st.entries ? (100 * st.evaluated) / st.entries : 0;
    badge(pending);
    const stat = (label, value, note, icon) => `<div class="acc-stat"><span class="acc-eyebrow">${label}</span><span class="acc-stat-icon">${icon}</span><strong>${value}</strong><p>${note}</p></div>`;
    const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    $("[data-stats]").innerHTML = [
      stat("Published resources", fmt(st.entries), `In ${fmt(st.categories)} domains${st.crossDomain ? ` · ${fmt(st.crossDomain)} span several` : ""}`, svg('<path d="M4 4h16v16H4zM8 4v16"/>')),
      stat("Awaiting review", fmt(pending), `${fmt(ac.submissions.changes_requested || 0)} waiting on contributors`, svg('<path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5"/>')),
      stat("Evaluation coverage", `${coverage.toFixed(1)}<small>%</small>`, `${fmt(st.evaluated)} of ${fmt(st.entries)} evaluated · average ${st.averageScore ?? "—"}`, svg('<path d="m4 12 5 5L20 6"/>')),
      stat("Active users", fmt(ac.activeUsers30d), `Signed in in the last 30 days · ${fmt(ac.users)} in total`, svg('<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3"/>')),
    ].join("");
    const att = o.attention;
    const alert = $("[data-alert]");
    alert.hidden = !att.unevaluated;
    alert.innerHTML = att.unevaluated ? `<span>ⓘ</span><span><b>${fmt(att.unevaluated)} resource${att.unevaluated === 1 ? " has" : "s have"} no evaluation yet</b>, for example ${att.unevaluatedSample.slice(0, 3).map((x) => `<a href="/o/${esc(x.id)}/">${esc(x.name)}</a>`).join(", ")}. They are scored in the next full run.</span><a class="acc-link" href="#catalog" data-filter-grade="none">View them →</a>` : "";
    $("[data-queue-count]").textContent = `${fmt(pending)} pending`;
    $("[data-queue]").innerHTML = o.queue.length
      ? o.queue.map((x) => `<tr><td><b>${esc(x.acronym || x.name || x.entryId)}</b><small>${x.updateOf ? `Correction to ${esc(x.updateOf)}` : "New resource"} · @${esc(x.submittedBy.login)}</small></td><td>${esc(KIND[x.kind] || x.kind || "—")}</td><td class="small">${ago(x.createdAt)}</td><td class="acc-right"><button type="button" class="acc-link" data-review="${x.id}">Review →</button></td></tr>`).join("")
      : `<tr><td colspan="4"><div class="acc-empty small">Nothing to review. New submissions appear here.</div></td></tr>`;
    queueCache = Object.fromEntries(o.queue.map((x) => [x.id, x]));
    const h = o.health, ev = h.evaluation || {};
    const rows = [
      ["Database", `Responded in ${h.database.ms} ms`, h.database.ok],
      ["REST API", "Answering (this page uses it)", true],
      ["MCP server", `${location.origin}/mcp/`, true],
      ["Catalog data", `Loaded ${ago(h.ingestedAt)}`, !!h.ingestedAt],
      ["Latest evaluation", ev.run ? `Run of ${runDate(ev.run.id)} · rubric ${ev.rubricVersion}` : "No run loaded", !!ev.run],
      ["GitHub sign-in", h.github ? "Configured" : "Not configured (sandbox test sign-in)", h.github],
    ];
    $("[data-health]").innerHTML = rows.map(([t, d, ok]) => `<div class="adm-health-row"><span>${t}<small>${esc(d)}</small></span><b class="${ok ? "ok" : "warn"}">${ok ? "OK" : "Check"}</b></div>`).join("");
    const allOk = rows.slice(0, 4).every((r) => r[2]);
    const hp = $("[data-health-pill]");
    hp.textContent = allOk ? "Operational" : "Needs attention";
    hp.className = `adm-pill ${allOk ? "green" : "amber"}`;
    const ch = o.changes;
    $("[data-changes-sub]").textContent = ch.previous ? `${fmt(ch.changed)} ${ch.changed === 1 ? "resource" : "resources"} changed score between the runs of ${runDate(ch.previous)} and ${runDate(ch.latest)}.` : "Needs at least two runs.";
    $("[data-changes]").innerHTML = ch.changes.length
      ? ch.changes.map((c) => { const d = (c.score ?? 0) - (c.before ?? 0); return `<tr><td><a href="/o/${esc(c.id)}/"><b>${esc(c.name)}</b></a><small>${esc(KIND[c.kind] || c.kind || "")}</small></td><td>${c.gradeBefore && c.gradeBefore !== c.grade ? `${gradePill(c.gradeBefore)} → ` : ""}${gradePill(c.grade)}</td><td class="num">${c.before ?? "—"} → <b>${c.score ?? "—"}</b></td><td class="num"><span class="adm-delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d}</span></td></tr>`; }).join("")
      : `<tr><td colspan="4"><div class="acc-empty small">No score changes between the last two runs.</div></td></tr>`;
    const kinds = Object.entries(st.kinds).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...kinds.map((k) => k[1]), 1);
    const grades = ["A", "B", "C", "D", "E"].map((g) => [g, st.grades[g] || 0]);
    $("[data-comp-total]").textContent = `${fmt(st.entries)} resources`;
    $("[data-composition]").innerHTML = kinds.map(([k, n]) => `<div class="adm-bar-row"><span>${esc(KIND[k] || k)}</span><div class="adm-track"><div style="width:${(100 * n) / max}%"></div></div><b>${fmt(n)}</b></div>`).join("") +
      `<p class="adm-sub adm-grades-title">By grade</p><div class="adm-grades">${grades.map(([g, n]) => `<div><span class="grade grade-${g}"><b>${g}</b></span><b>${fmt(n)}</b></div>`).join("")}</div>`;
  }
  const badge = (n) => { const b = $("[data-queue-badge]"); b.textContent = n; b.hidden = !n; };

  // ---------- submissions ----------
  let queueCache = {};
  async function submissions() {
    const status = $("[data-sub-status]").value, q = $("[data-sub-search]").value.trim();
    const rows = await api(`/api/admin/submissions?status=${encodeURIComponent(status)}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    rows.forEach((x) => (queueCache[x.id] = x));
    $("[data-subs]").innerHTML = rows.length
      ? rows.map((x) => `<tr><td><b>${esc(x.acronym || x.name || x.entryId)}</b><small>${x.updateOf ? `Correction to <a href="/o/${esc(x.updateOf)}/">${esc(x.updateOf)}</a>` : "New resource"}</small></td><td>${esc(KIND[x.kind] || x.kind || "—")}</td><td>${x.submittedBy.avatarUrl ? `<img class="avatar-sm" src="${esc(x.submittedBy.avatarUrl)}&s=40" alt="" width="20" height="20"> ` : ""}<a href="${esc(x.submittedBy.url)}" rel="noopener">@${esc(x.submittedBy.login)}</a></td><td class="small">${ago(x.createdAt)}</td><td>${pill(x.status)}</td><td class="acc-right"><button type="button" class="acc-link" data-review="${x.id}">${x.status === "pending" ? "Review →" : "View"}</button></td></tr>`).join("")
      : `<tr><td colspan="6"><div class="acc-empty small">No ${status === "all" ? "" : (STATUS[status]?.[0] || "").toLowerCase() + " "}submissions${q ? " matching your search" : ""}.</div></td></tr>`;
    $("[data-subs-foot]").textContent = `${fmt(rows.length)} submission${rows.length === 1 ? "" : "s"}`;
  }
  let typing;
  $("[data-sub-search]").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(submissions, 250); });
  $("[data-sub-status]").addEventListener("change", submissions);

  let reviewing = null;
  function openReview(id) {
    const x = queueCache[id];
    if (!x) return;
    reviewing = x;
    const f = $("[data-review-form]");
    $("[data-review-title]").textContent = x.acronym ? `${x.acronym}: ${x.name}` : x.name || x.entryId;
    const link = (u) => (u ? `<a href="${esc(u)}" rel="noopener">${esc(u)}</a>` : "—");
    $("[data-review-details]").innerHTML = `
      <div class="adm-dgrid"><div><span>Submitted by</span><b><a href="${esc(x.submittedBy.url)}" rel="noopener">@${esc(x.submittedBy.login)}</a>${x.submittedBy.name ? ` (${esc(x.submittedBy.name)})` : ""}</b></div><div><span>Received</span><b>${when(x.createdAt)}</b></div>
        <div><span>Type · domain</span><b>${esc(KIND[x.kind] || x.kind || "—")} · ${esc(x.category || "—")}</b></div><div><span>Kind of change</span><b>${x.updateOf ? `Correction to <a href="/o/${esc(x.updateOf)}/">${esc(x.updateOf)}</a>` : "New resource"}</b></div>
        <div><span>Homepage</span><b>${link(x.homepage)}</b></div><div><span>Repository</span><b>${link(x.repository)}</b></div></div>
      <p class="adm-desc">${esc(x.description || "No description.")}</p>
      ${x.notes ? `<p class="adm-desc"><b>Contributor's notes:</b> ${esc(x.notes)}</p>` : ""}
      ${x.reviewedBy ? `<p class="small muted">Last decision: ${esc(STATUS[x.status]?.[0] || x.status)} by @${esc(x.reviewedBy)}, ${when(x.reviewedAt)}.</p>` : ""}
      <details class="adm-json"><summary>Full entry (JSON)</summary><pre>${esc(JSON.stringify(x.entry, null, 2))}</pre></details>
      ${x.issueUrl ? `<p class="small"><a href="${esc(x.issueUrl)}" rel="noopener">Open the GitHub issue form ↗</a> · merging happens through the pull request.</p>` : ""}`;
    f.elements.decision.value = x.status === "pending" ? "approved" : x.status;
    f.elements.notes.value = x.reviewNotes || "";
    $("[data-review-error]").hidden = true;
    $("[data-review-dialog]").showModal();
  }
  $("[data-review-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $("[data-review-error]");
    try {
      await api(`/api/admin/submissions/${reviewing.id}/review`, { method: "POST", body: JSON.stringify({ decision: f.elements.decision.value, notes: f.elements.notes.value }) });
      $("[data-review-dialog]").close();
      toast("Decision saved. The contributor sees it on their account page.");
      loaded.delete("activity");
      if (!$("#submissions").hidden) submissions();
      overview();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  // ---------- catalog ----------
  let catPage = 1;
  async function catalog(more = false) {
    catPage = more ? catPage + 1 : 1;
    const q = $("[data-cat-search]").value.trim(), kind = $("[data-cat-kind]").value, grade = $("[data-cat-grade]").value;
    const params = new URLSearchParams({ size: "50", page: String(catPage), sort: q ? "" : "name" });
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (grade) params.set("grade", grade);
    if (!params.get("sort")) params.delete("sort");
    const r = await api(`/api/entries?${params}`);
    const html = r.items.map((x) => `<tr><td><a href="/o/${esc(x.id)}/"><b>${esc(x.acronym || x.name)}</b></a><small>${esc(x.acronym ? x.name : x.id)}</small></td><td>${esc(x.kindLabel || x.kind || "—")}</td><td class="small">${esc(x.categoryName || x.category)}</td><td>${gradePill(x.grade)}</td><td class="num">${x.score ?? "—"}</td><td class="acc-right"><a class="acc-link" href="/o/${esc(x.id)}/">Open →</a></td></tr>`).join("");
    const body = $("[data-cat]");
    body.innerHTML = (more ? body.innerHTML : "") + (html || `<tr><td colspan="6"><div class="acc-empty small">No matching resources.</div></td></tr>`);
    const shown = Math.min(catPage * 50, r.total);
    $("[data-cat-foot]").textContent = `Showing ${fmt(shown)} of ${fmt(r.total)}`;
    $("[data-cat-more]").hidden = shown >= r.total;
  }
  $("[data-cat-search]").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => catalog(), 250); });
  $("[data-cat-kind]").addEventListener("change", () => catalog());
  $("[data-cat-grade]").addEventListener("change", () => catalog());
  $("[data-cat-more]").addEventListener("click", () => catalog(true));

  // ---------- evaluations ----------
  async function evaluations() {
    const runs = await api("/api/runs?limit=100");
    $("[data-runs]").innerHTML = runs.length
      ? runs.map((r) => `<tr><td><b>${esc(runDate(r.id))}</b><small>${esc(r.id)}</small></td><td class="small">${when(r.finishedAt)}</td><td>${esc(r.scope || "—")}</td><td class="num">${fmt(r.entryCount)}</td><td>${esc(r.evaluator?.rubricVersion || r.rubricVersion || "—")}</td><td class="small">${esc(r.trigger || "—")}</td><td class="acc-right"><a class="acc-link" href="/api/runs/${encodeURIComponent(r.id)}/snapshot" download>Snapshot ↓</a></td></tr>`).join("")
      : `<tr><td colspan="7"><div class="acc-empty small">No runs loaded yet.</div></td></tr>`;
  }

  // ---------- users & rate limits ----------
  async function users() {
    const form = $("[data-limits-form]");
    const s = await api("/api/admin/settings");
    form.elements.anonymousPerMinute.value = s.rateLimit.anonymousPerMinute;
    form.elements.authenticatedPerMinute.value = s.rateLimit.authenticatedPerMinute;
    $("[data-limit-defaults]").textContent = `Defaults from the server's environment: ${fmt(s.defaults.anonymousPerMinute)} anonymous, ${fmt(s.defaults.authenticatedPerMinute)} signed in. Changes apply within seconds and are recorded in the activity log.`;
    loadUsers();
    loadRate();
  }
  async function loadRate() {
    const r = await api("/api/admin/rate?minutes=60");
    $("[data-blocks]").innerHTML = r.blocks.length
      ? r.blocks.map((b) => `<tr><td>${esc(b.label)}<small>${b.auto ? "automatic" : `by @${esc(b.by || "?")}`}</small></td><td class="small">${when(b.until)}</td><td class="small">${esc(b.reason || "")}</td><td class="acc-right"><button type="button" class="acc-link" data-unblock="${esc(b.key)}">Unblock</button></td></tr>`).join("")
      : `<tr><td colspan="4"><div class="acc-empty small">Nobody is blocked.</div></td></tr>`;
    $("[data-usage]").innerHTML = r.top.length
      ? r.top.map((u) => `<tr><td>${esc(u.label)}</td><td class="num">${fmt(u.requests)}</td><td class="num">${fmt(u.peakPerMinute)}</td><td class="acc-right"><button type="button" class="acc-link" data-block-key="${esc(u.key)}">Block…</button></td></tr>`).join("")
      : `<tr><td colspan="4"><div class="acc-empty small">No API use in the last hour.</div></td></tr>`;
  }
  $("[data-block-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("/api/admin/rate/blocks", { method: "POST", body: JSON.stringify({ target: f.elements.target.value.trim(), minutes: Number(f.elements.minutes.value), reason: f.elements.reason.value.trim() }) });
      toast("Blocked");
      f.reset();
      loadRate();
      loaded.delete("activity");
    } catch (err) { toast(err.message); }
  });
  document.addEventListener("click", async (e) => {
    const un = e.target.closest("[data-unblock]");
    const bk = e.target.closest("[data-block-key]");
    if (un) {
      try { await api(`/api/admin/rate/blocks/${encodeURIComponent(un.dataset.unblock)}`, { method: "DELETE" }); toast("Unblocked"); loadRate(); loaded.delete("activity"); } catch (err) { toast(err.message); }
    } else if (bk) {
      const f = $("[data-block-form]");
      f.elements.target.value = bk.dataset.blockKey;
      f.elements.reason.focus();
    }
  });
  async function loadUsers() {
    const q = $("[data-user-search]").value.trim();
    const list = await api(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    $("[data-users]").innerHTML = list.length
      ? list.map((u) => `<tr><td>${u.avatarUrl ? `<img class="avatar-sm" src="${esc(u.avatarUrl)}&s=40" alt="" width="20" height="20"> ` : ""}<a href="${esc(u.url)}" rel="noopener">@${esc(u.login)}</a>${u.superadmin ? ' <span class="acc-badge">superadmin</span>' : ""}<small>${esc(u.name || "")}</small></td><td class="small">${esc(u.email || "—")}</td><td class="small">${ago(u.lastLoginAt)}</td><td class="num">${fmt(u.activeTokens)}</td>
          <td><form class="user-limit" data-user="${u.id}"><input type="number" min="1" name="perMinute" value="${u.rateLimit ?? ""}" placeholder="default" aria-label="Requests per minute for @${esc(u.login)}"><button class="btn-ghost btn-sm" type="submit">Set</button></form></td></tr>`).join("")
      : `<tr><td colspan="5"><div class="acc-empty small">No users found.</div></td></tr>`;
  }
  $("[data-user-search]").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(loadUsers, 250); });
  $("[data-limits-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ anonymousPerMinute: Number(f.elements.anonymousPerMinute.value), authenticatedPerMinute: Number(f.elements.authenticatedPerMinute.value) }) });
      toast("Rate limits saved");
      loaded.delete("activity");
    } catch (err) { toast(err.message); }
  });
  $("[data-users]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.closest("form[data-user]");
    const v = f.elements.perMinute.value;
    try {
      await api(`/api/admin/users/${f.dataset.user}/rate-limit`, { method: "PUT", body: JSON.stringify({ perMinute: v ? Number(v) : null }) });
      toast(v ? "Rate limit saved" : "Back to the default rate limit");
      loaded.delete("activity");
    } catch (err) { toast(err.message); }
  });

  // ---------- activity log ----------
  const ACTIONS = {
    "auth.login": "Signed in", "auth.logout": "Signed out", "auth.login_failed": "Sign-in failed", "auth.jwt_issued": "Session token issued",
    "token.create": "Token created", "token.revoke": "Token revoked", "submission.create": "Submitted an entry",
    "submission.approved": "Approved a submission", "submission.changes_requested": "Requested changes", "submission.rejected": "Rejected a submission", "submission.pending": "Reopened a submission",
    "admin.rate_limits": "Changed rate limits", "admin.user_rate_limit": "Changed a user's rate limit", "admin.export": "Exported data", "admin.block": "Blocked a caller", "admin.unblock": "Unblocked a caller", "security.block": "Blocked automatically", "account.preferences": "Changed settings", "catalog.ingest": "Catalog data loaded",
  };
  const ICON = (a) => (a.startsWith("token.") ? "⚿" : a.startsWith("submission.") ? "✎" : a.startsWith("admin.") ? "⚙" : a.startsWith("catalog.") ? "⟳" : a === "auth.logout" ? "↙" : "↗");
  const detail = (a) => {
    const d = a.details || {};
    if (a.action.startsWith("token.")) return [d.name, d.scopes && d.scopes.join(", ")].filter(Boolean).join(" · ");
    if (a.action === "submission.create") return [d.name || a.target, d.updateOf && `correction to ${d.updateOf}`].filter(Boolean).join(" · ");
    if (a.action.startsWith("submission.")) return [a.target, d.notes].filter(Boolean).join(" · ");
    if (a.action === "admin.rate_limits") return `${fmt(d.before?.anonymousPerMinute)}/${fmt(d.before?.authenticatedPerMinute)} → ${fmt(d.after?.anonymousPerMinute)}/${fmt(d.after?.authenticatedPerMinute)} per minute`;
    if (a.action === "admin.user_rate_limit") return `@${a.target}: ${d.perMinute == null ? "default" : fmt(d.perMinute) + " per minute"}`;
    if (a.action === "catalog.ingest") return `${fmt(d.entries)} entries, ${fmt(d.runsAdded)} new run(s), by ${d.operator || "system"}`;
    if (a.action.startsWith("auth.")) return d.method === "dev" ? "Sandbox sign-in" : d.method === "github" ? "GitHub" : d.method || d.reason || "";
    return a.target || "";
  };
  let audit = [];
  async function activity(more = false) {
    const action = $("[data-audit-action]").value;
    const before = more && audit.length ? `&before=${audit[audit.length - 1].id}` : "";
    const rows = await api(`/api/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}${before}`);
    audit = more ? audit.concat(rows) : rows;
    $("[data-audit-more]").hidden = rows.length < 100;
    renderAudit();
  }
  function renderAudit() {
    const q = $("[data-audit-search]").value.trim().toLowerCase();
    const list = audit.filter((a) => !q || `${ACTIONS[a.action] || a.action} ${detail(a)} ${a.actor?.login || "system"} ${a.ip || ""}`.toLowerCase().includes(q));
    $("[data-audit]").innerHTML = list.map((a) => `<div class="acc-event"><span class="acc-dot">${ICON(a.action)}</span><div><b>${a.actor ? `@${esc(a.actor.login)}` : "System"}</b> · ${esc(ACTIONS[a.action] || a.action)}<small>${esc([detail(a), a.ip && `from ${a.ip}`].filter(Boolean).join(" · "))}</small></div><time datetime="${esc(a.at)}">${when(a.at)}</time></div>`).join("") || `<p class="acc-empty small">No matching activity.</p>`;
  }
  $("[data-audit-action]").addEventListener("change", () => activity());
  $("[data-audit-search]").addEventListener("input", renderAudit);
  $("[data-audit-more]").addEventListener("click", () => activity(true));

  // ---------- logs & feedback ----------
  const SRC = { guided: "Guided", search: "Search bar", catalog: "Catalog filters", mcp: "MCP" };
  async function logs() {
    const s = await api("/api/admin/logs/summary");
    const c = s.chats || {};
    const card = (label, value, note) => `<div class="acc-stat"><span class="acc-eyebrow">${label}</span><strong>${fmt(value)}</strong><p>${note}</p></div>`;
    const src = (k) => s.searches[k] || { count: 0, noResults: 0, clicked: 0 };
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
    $("[data-log-stats]").innerHTML = [
      card("Chat answers", c.turns, `${fmt(c.sessions)} sessions · ${fmt(c.good)} 👍 · ${fmt(c.bad)} 👎 · ${fmt(c.comments)} comments`),
      ...["guided", "search", "catalog"].map((k) => card(`${SRC[k]} searches`, src(k).count, `${pct(src(k).noResults, src(k).count)} found nothing · ${pct(src(k).clicked, src(k).count)} opened a result`)),
      card("MCP tool calls", src("mcp").count, `From AI agents · ${pct(src("mcp").noResults, src("mcp").count)} found nothing`),
    ].join("");
    const ql = (rows, extra) => rows.length ? rows.map((r) => `<li>${esc(r.q)}<span>${fmt(r.n)}×${extra ? extra(r) : ""}</span></li>`).join("") : `<li class="muted">Nothing yet.</li>`;
    $("[data-top-queries]").innerHTML = ql(s.topQueries, (r) => (r.fewest === 0 ? " · sometimes no results" : ""));
    $("[data-empty-queries]").innerHTML = ql(s.noResultQueries);
    chatlog(true);
    searchlog(true);
  }
  let chatRows = [], searchRows = [];
  async function chatlog(reset) {
    const q = $("[data-chatlog-q]").value.trim(), rating = $("[data-chatlog-rating]").value;
    const before = !reset && chatRows.length ? `&before=${encodeURIComponent(chatRows[chatRows.length - 1].createdAt)}` : "";
    const rows = await api(`/api/admin/logs/chats?limit=50${rating ? `&rating=${rating}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${before}`);
    chatRows = reset ? rows : chatRows.concat(rows);
    $("[data-chatlog]").innerHTML = chatRows.length ? chatRows.map((r) => `<tr>
        <td class="small">${when(r.createdAt)}</td>
        <td class="q">${esc(r.question)}${Object.keys(r.filters || {}).length ? `<small>${esc(Object.entries(r.filters).map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(" · "))}</small>` : ""}</td>
        <td class="a"><div>${esc(r.answer || "")}</div>${(r.answer || "").length > 220 ? `<details><summary>Full answer</summary>${esc(r.answer)}</details>` : ""}<small>${esc(r.model || "no model")}</small></td>
        <td class="small">${(r.resultIds || []).slice(0, 5).map((id) => `<a href="/o/${esc(id)}/">${esc(id)}</a>`).join(", ")}</td>
        <td>${r.rating === 1 ? "👍" : r.rating === -1 ? "👎" : ""}${r.comment ? `<small>${esc(r.comment)}</small>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="5"><div class="acc-empty small">No chat answers logged${rating || q ? " for this filter" : " yet"}.</div></td></tr>`;
    $("[data-chatlog-more]").hidden = rows.length < 50;
  }
  async function searchlog(reset) {
    const q = $("[data-searchlog-q]").value.trim(), source = $("[data-searchlog-source]").value, empty = $("[data-searchlog-empty]").checked;
    const before = !reset && searchRows.length ? `&before=${encodeURIComponent(searchRows[searchRows.length - 1].createdAt)}` : "";
    const rows = await api(`/api/admin/logs/searches?limit=50${source ? `&source=${source}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${empty ? "&empty=true" : ""}${before}`);
    searchRows = reset ? rows : searchRows.concat(rows);
    $("[data-searchlog]").innerHTML = searchRows.length ? searchRows.map((r) => `<tr>
        <td class="small">${when(r.createdAt)}</td><td>${esc(SRC[r.source] || r.source)}${r.source === "mcp" && r.filters?.tool ? `<br><small class="muted">${esc(r.filters.tool)}</small>` : ""}</td><td class="q">${esc(r.query || "—")}</td>
        <td class="small">${esc(Object.entries(r.filters || {}).map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(" · ") || "—")}</td>
        <td class="num">${fmt(r.resultCount)}</td>
        <td class="small">${(r.clicked || []).map((id) => `<a href="/o/${esc(id)}/">${esc(id)}</a>`).join(", ") || "—"}</td></tr>`).join("")
      : `<tr><td colspan="6"><div class="acc-empty small">No searches logged${q || source || empty ? " for this filter" : " yet"}.</div></td></tr>`;
    $("[data-searchlog-more]").hidden = rows.length < 50;
  }
  $("[data-chatlog-q]").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => chatlog(true), 300); });
  $("[data-chatlog-rating]").addEventListener("change", () => chatlog(true));
  $("[data-chatlog-more]").addEventListener("click", () => chatlog(false));
  $("[data-searchlog-q]").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => searchlog(true), 300); });
  $("[data-searchlog-source]").addEventListener("change", () => searchlog(true));
  $("[data-searchlog-empty]").addEventListener("change", () => searchlog(true));
  $("[data-searchlog-more]").addEventListener("click", () => searchlog(false));

  const LOAD = { overview, submissions, catalog, evaluations, users, logs, activity };

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-review], [data-close], [data-filter-grade]");
    if (!t) return;
    if (t.dataset.review) openReview(Number(t.dataset.review));
    else if (t.hasAttribute("data-close")) t.closest("dialog").close();
    else if (t.dataset.filterGrade) { $("[data-cat-grade]").value = t.dataset.filterGrade; loaded.add("catalog"); catalog(); }
  });
})();
