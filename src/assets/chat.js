// Recommendation chat (/recommend/ask/), in the style of a chat assistant: saved chats in a sidebar (signed in),
// a centred conversation, and a composer at the bottom. Each turn streams from POST /api/recommend/chat as NDJSON:
// chat (saved chat id) → filters → results → token… → done. Answers carry the recommendations they were written from.
(() => {
  const app = document.querySelector("[data-chatapp]");
  if (!app) return;
  const $ = (s, r = app) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const log = $("[data-chat-log]"), scroller = $("[data-chat-scroll]"), empty = $("[data-chat-empty]"), list = $("[data-chat-list]");
  const form = $("[data-chat-form]"), input = form.elements.q, sendBtn = $(".cg-send");
  const KIND = { ontology: "Ontology", schema: "Schema", vocabulary: "Vocabulary", atlas: "Atlas", "data-standard": "Data standard", "knowledge-base": "Knowledge base" };
  const LABEL = { maintained: "Actively maintained", open_license: "Open licence", used: "Used by other projects" };
  let user = null, chatId = null, history = [], busy = false, chats = [];
  // Signed out: chats live in this browser tab's session storage (shown in the sidebar until the browser closes).
  const store = {
    get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const sessionId = store.get("chat-session", null) || (() => { const id = crypto.randomUUID?.() || String(Math.random()).slice(2); store.set("chat-session", id); return id; })();
  const localChats = () => store.get("chats-local", []);
  const saveLocal = (list) => store.set("chats-local", list.slice(0, 30));

  // ---------- layout helpers ----------
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = (force) => { if (force || atBottom()) scroller.scrollTop = scroller.scrollHeight; };
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const setEmpty = (on) => { empty.hidden = !on; log.hidden = on; };
  $("[data-chat-menu]").addEventListener("click", (e) => {
    const open = !app.classList.contains("side-open");
    app.classList.toggle("side-open", open);
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });

  // ---------- messages ----------
  const linkify = (text, items) => {
    let html = esc(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
    for (const x of items || []) {
      for (const n of [x.acronym, x.name].filter(Boolean).sort((a, b) => b.length - a.length)) {
        const rx = new RegExp(`(^|[^\\w>/])(${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w<])`, "g");
        if (rx.test(html)) { html = html.replace(rx, `$1<a href="/o/${esc(x.id)}/">$2</a>`); break; }
      }
    }
    return `<p>${html}</p>`;
  };
  const card = (x, i) => `<a class="cg-rec" href="/o/${esc(x.id)}/">
      <span class="cg-rec-n">${i + 1}</span>
      <span class="cg-rec-body"><span class="cg-rec-title"><b>${esc(x.acronym || x.name)}</b>${x.acronym ? ` <span>${esc(x.name)}</span>` : ""}</span>
        <span class="cg-rec-why">${(x.why || []).slice(0, 3).map(esc).join(" · ")}</span></span>
      ${x.grade ? `<span class="grade grade-${esc(x.grade)}"><b>${esc(x.grade)}</b><small>${x.score}</small></span>` : ""}
    </a>`;
  function recsHtml(d) {
    const items = d.items || [];
    if (!items.length) return "";
    const f = d.filters || {};
    const tags = [f.kind && (KIND[f.kind] || f.kind), f.format, f.min_grade && `Grade ${f.min_grade}+`, ...["maintained", "open_license", "used"].filter((k) => f[k]).map((k) => LABEL[k])].filter(Boolean);
    const q = new URLSearchParams(Object.entries({ ...f, q: (d.words || []).join(" ") }).filter(([, v]) => v).map(([k, v]) => [k, v === true ? "true" : v]));
    return `<div class="cg-recs">
      <div class="cg-recs-head"><span>Recommendations${tags.length ? ` · ${tags.map(esc).join(" · ")}` : ""}</span><a href="/recommend/guided/?${q}">Refine these filters →</a></div>
      ${(d.relaxed || []).length ? `<p class="cg-relaxed">No exact match, so these were relaxed: ${esc(d.relaxed.join(", "))}</p>` : ""}
      ${items.slice(0, 3).map(card).join("")}
      ${items.length > 3 ? `<details class="cg-more"><summary>Show ${items.length - 3} more</summary>${items.slice(3).map((x, i) => card(x, i + 3)).join("")}</details>` : ""}
    </div>`;
  }
  const userMsg = (text) => {
    const d = document.createElement("div");
    d.className = "cg-msg user";
    d.innerHTML = `<div class="cg-bubble">${esc(text).replace(/\n/g, "<br>")}</div>`;
    log.append(d);
  };
  const botMsg = () => {
    const d = document.createElement("div");
    d.className = "cg-msg bot";
    d.innerHTML = `<div class="cg-avatar" aria-hidden="true">✦</div><div class="cg-content"><div class="cg-text"><p class="cg-typing"><span></span><span></span><span></span></p></div><div class="cg-extra"></div><div class="cg-actions"></div></div>`;
    log.append(d);
    return d;
  };
  const finishBot = (el, text, data, model, logId, rating) => {
    el.querySelector(".cg-text").innerHTML = linkify(text, data.items);
    el.querySelector(".cg-extra").innerHTML = recsHtml(data);
    el.querySelector(".cg-actions").innerHTML = `<button type="button" data-copy-text title="Copy the answer">Copy</button>
      ${logId ? `<span class="cg-fb" role="group" aria-label="Was this helpful?"><button type="button" data-rate="1" aria-pressed="${rating === 1}" title="Good answer">👍</button><button type="button" data-rate="-1" aria-pressed="${rating === -1}" title="Bad answer">👎</button><button type="button" data-comment>Comment</button></span>` : ""}
      ${model ? `<span>Written by ${esc(model)}</span>` : ""}`;
    el.dataset.log = logId || "";
    el.querySelector("[data-copy-text]").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied ✓"; setTimeout(() => (e.target.textContent = "Copy"), 1500); } catch {}
    });
  };
  // Feedback: 👍 / 👎 and an optional comment, attached to the anonymous log of that answer.
  const sendFeedback = (logId, body) => fetch(`/api/recommend/chat/feedback/${encodeURIComponent(logId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const remember = (logId, patch) => {
    if (user) return;
    const list = localChats();
    for (const c of list) for (const m of c.messages) if (m.logId === logId) Object.assign(m, patch);
    saveLocal(list);
  };
  log.addEventListener("click", async (e) => {
    const msg = e.target.closest(".cg-msg.bot");
    const logId = msg?.dataset.log;
    if (!logId) return;
    const rate = e.target.closest("[data-rate]");
    if (rate) {
      const v = Number(rate.dataset.rate);
      msg.querySelectorAll("[data-rate]").forEach((b) => b.setAttribute("aria-pressed", String(b === rate)));
      await sendFeedback(logId, { rating: v }).catch(() => {});
      remember(logId, { rating: v });
      if (v === -1 && !msg.querySelector(".cg-fb-form")) openComment(msg, "What was wrong or missing?");
      else flash(msg, "Thanks for the feedback.");
    } else if (e.target.closest("[data-comment]") && !msg.querySelector(".cg-fb-form")) openComment(msg, "Tell us what would have helped");
  });
  const flash = (msg, text) => {
    let n = msg.querySelector(".cg-fb-thanks");
    if (!n) { n = document.createElement("span"); n.className = "cg-fb-thanks"; msg.querySelector(".cg-actions").append(n); }
    n.textContent = text;
  };
  function openComment(msg, placeholder) {
    const f = document.createElement("form");
    f.className = "cg-fb-form";
    f.innerHTML = `<textarea rows="2" maxlength="2000" placeholder="${esc(placeholder)}" required></textarea><div><button type="button" class="btn-ghost btn-sm" data-cancel>Cancel</button><button class="btn btn-sm" type="submit">Send</button></div>`;
    msg.querySelector(".cg-content").append(f);
    f.querySelector("textarea").focus();
    f.addEventListener("click", (e) => { if (e.target.closest("[data-cancel]")) f.remove(); });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      await sendFeedback(msg.dataset.log, { comment: f.querySelector("textarea").value }).catch(() => {});
      f.remove();
      flash(msg, "Thanks, that helps us improve.");
    });
  }

  // ---------- sending ----------
  async function send(q) {
    q = q.trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    setEmpty(false);
    userMsg(q);
    history.push({ role: "user", content: q });
    const el = botMsg();
    toBottom(true);
    let text = "", data = {}, model = null, notice = "", logId = null;
    try {
      const r = await fetch("/api/recommend/chat", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-8), session: sessionId, ...(user && chatId ? { chat_id: chatId } : {}) }),
      });
      if (!r.ok) {
        const p = await r.json().catch(() => ({}));
        throw new Error(p.detail || `Something went wrong (HTTP ${r.status}).`);
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "chat") {
            chatId = ev.id;
            if (ev.new) { setTitle(ev.title); upsertChat({ id: ev.id, title: ev.title }); }
            window.history.replaceState(null, "", `/recommend/ask/?chat=${encodeURIComponent(chatId)}`);
          } else if (ev.type === "filters") data = { ...data, filters: ev.filters, relaxed: ev.relaxed, words: ev.words };
          else if (ev.type === "results") data.items = ev.items;
          else if (ev.type === "notice") notice = ev.text;
          else if (ev.type === "token") {
            text += ev.text;
            el.querySelector(".cg-text").innerHTML = (notice ? `<p class="cg-notice">${esc(notice)}</p>` : "") + linkify(text, data.items);
            toBottom();
          } else if (ev.type === "log") logId = ev.id;
          else if (ev.type === "done") model = ev.model;
        }
      }
      finishBot(el, text, data, model, logId);
      history.push({ role: "assistant", content: text });
      if (user && chatId) touchChat(chatId);
      if (!user) {
        // Signed out: keep this chat for the session.
        const list = localChats();
        let c = list.find((x) => x.id === chatId);
        if (!c) { c = { id: `l-${Date.now().toString(36)}`, title: q.length > 70 ? q.slice(0, 67) + "…" : q, messages: [] }; list.unshift(c); chatId = c.id; setTitle(c.title); }
        c.messages.push({ role: "user", content: q }, { role: "assistant", content: text, data: { ...data, model }, logId });
        saveLocal([c, ...list.filter((x) => x.id !== c.id)]);
        chats = localChats().map(({ id, title }) => ({ id, title }));
        renderList();
      }
    } catch (err) {
      el.querySelector(".cg-text").innerHTML = `<p class="cg-error">${esc(err.message)}</p>`;
      history.pop();
    }
    busy = false;
    sendBtn.disabled = false;
    toBottom();
    input.focus();
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; grow(); send(q); });
  app.addEventListener("click", (e) => { const s = e.target.closest("[data-suggest]"); if (s) send(s.dataset.suggest); });

  // ---------- saved chats ----------
  const setTitle = (t) => ($("[data-chat-title]").textContent = t || "Find the right resource");
  function renderList() {
    const signIn = `<p class="cg-side-note"><a href="/api/auth/github/login?next=${encodeURIComponent("/recommend/ask/")}">Sign in</a> to keep your chats after you close the browser.</p>`;
    list.innerHTML = (chats.length
      ? chats.map((c) => `<div class="cg-item${c.id === chatId ? " active" : ""}" data-id="${esc(c.id)}"><a href="/recommend/ask/?chat=${encodeURIComponent(c.id)}" data-open>${esc(c.title)}</a><span class="cg-item-tools"><button type="button" data-rename title="Rename" aria-label="Rename">✎</button><button type="button" data-delete title="Delete" aria-label="Delete">✕</button></span></div>`).join("")
      : `<p class="cg-side-note">Your chats will appear here.</p>`) + (user ? "" : signIn);
    $(".cg-side-title").textContent = user ? "Your chats" : "This session";
  }
  const upsertChat = (c) => { chats = [c, ...chats.filter((x) => x.id !== c.id)]; renderList(); };
  const touchChat = (id) => { const c = chats.find((x) => x.id === id); if (c) upsertChat(c); };
  list.addEventListener("click", async (e) => {
    const item = e.target.closest(".cg-item");
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest("[data-open]")) {
      e.preventDefault();
      openChat(id);
      app.classList.remove("side-open");
    } else if (!user && (e.target.closest("[data-rename]") || e.target.closest("[data-delete]"))) {
      const list = localChats();
      const c = list.find((x) => x.id === id);
      if (e.target.closest("[data-delete]")) { if (!confirm("Remove this chat from this session?")) return; saveLocal(list.filter((x) => x.id !== id)); }
      else { const t = prompt("Rename chat", c?.title || ""); if (!t?.trim()) return; c.title = t.trim(); saveLocal(list); if (id === chatId) setTitle(c.title); }
      chats = localChats().map(({ id, title }) => ({ id, title }));
      if (id === chatId && !chats.some((x) => x.id === id)) newChat(); else renderList();
    } else if (e.target.closest("[data-rename]")) {
      const c = chats.find((x) => x.id === id);
      const t = prompt("Rename chat", c?.title || "");
      if (!t?.trim()) return;
      const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t.trim() }) });
      if (r.ok) { c.title = (await r.json()).title; renderList(); if (id === chatId) setTitle(c.title); }
    } else if (e.target.closest("[data-delete]")) {
      if (!confirm("Delete this chat? This can't be undone.")) return;
      const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
      if (r.ok) { chats = chats.filter((x) => x.id !== id); if (id === chatId) newChat(); else renderList(); }
    }
  });
  function newChat() {
    chatId = null; history = []; log.innerHTML = ""; setEmpty(true); setTitle();
    window.history.replaceState(null, "", "/recommend/ask/");
    renderList();
    input.focus();
  }
  $("[data-new-chat]").addEventListener("click", (e) => { e.preventDefault(); newChat(); app.classList.remove("side-open"); });
  async function openChat(id) {
    let c;
    if (id.startsWith("l-")) c = localChats().find((x) => x.id === id);
    else {
      const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, { credentials: "same-origin" });
      c = r.ok ? await r.json() : null;
    }
    if (!c) return newChat();
    chatId = c.id; history = []; log.innerHTML = ""; setEmpty(!c.messages.length); setTitle(c.title);
    for (const m of c.messages) {
      if (m.role === "user") userMsg(m.content);
      else finishBot(botMsg(), m.content, m.data || {}, m.data?.model, m.logId, m.rating);
      history.push({ role: m.role, content: m.content });
    }
    window.history.replaceState(null, "", id.startsWith("l-") ? "/recommend/ask/" : `/recommend/ask/?chat=${encodeURIComponent(id)}`);
    renderList();
    toBottom(true);
  }

  // ---------- start ----------
  fetch("/api/recommend/chat/status").then((r) => r.json()).then((s) => {
    $("[data-chat-status]").innerHTML = s.available ? `<span class="on">●</span> Assistant on` : `<span class="off">●</span> Matches only`;
    $("[data-chat-status]").title = s.available ? `Answers written by ${s.model}` : "The AI model is offline; answers list the best matches.";
  }).catch(() => {});
  const params = new URLSearchParams(location.search);
  fetch("/api/auth/session", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({})).then(async (s) => {
    user = s?.user || null;
    $("[data-save-note]").innerHTML = user
      ? `Your chats are saved to your account.${user.improveSearch ? " Questions and answers are also logged without your identity to improve search." : ""} <a href="/privacy/#chat">Privacy</a>`
      : `Chats are logged without your identity to improve search. <a href="/privacy/#chat">Privacy</a>`;
    if (user) {
      chats = await fetch("/api/chats", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      // "Help improve recommendations" (on by default): log chats without identity.
      const foot = $(".cg-side-foot");
      foot.insertAdjacentHTML("afterbegin", `<label class="cg-improve"><input type="checkbox" data-improve${user.improveSearch ? " checked" : ""}><span><b>Help improve recommendations</b><small>Log my questions and answers without my identity. <a href="/privacy/#chat">Privacy</a></small></span></label>`);
      foot.querySelector("[data-improve]").addEventListener("change", async (e) => {
        const on = e.target.checked;
        const r = await fetch("/api/auth/preferences", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ improveSearch: on }) });
        if (!r.ok) e.target.checked = !on; else user.improveSearch = on;
      });
    } else chats = localChats().map(({ id, title }) => ({ id, title }));
    renderList();
    if (user && params.get("chat")) await openChat(params.get("chat"));
    else if (!user && chats.length && !sessionStorage.getItem("ask-question")) setEmpty(true);
    else setEmpty(true);
    // A question handed over from another page (session storage, never the URL).
    let pending = null;
    try { pending = sessionStorage.getItem("ask-question"); sessionStorage.removeItem("ask-question"); } catch {}
    if (pending) { if (chatId) newChat(); send(pending); }
    else input.focus();
  });
})();
