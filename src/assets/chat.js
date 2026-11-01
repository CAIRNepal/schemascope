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
  const finishBot = (el, text, data, model) => {
    el.querySelector(".cg-text").innerHTML = linkify(text, data.items);
    el.querySelector(".cg-extra").innerHTML = recsHtml(data);
    el.querySelector(".cg-actions").innerHTML = `<button type="button" data-copy-text>Copy</button>${model ? `<span>Written by ${esc(model)}</span>` : ""}`;
    el.querySelector("[data-copy-text]").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied ✓"; setTimeout(() => (e.target.textContent = "Copy"), 1500); } catch {}
    });
  };

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
    let text = "", data = {}, model = null, notice = "";
    try {
      const r = await fetch("/api/recommend/chat", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-8), ...(chatId ? { chat_id: chatId } : {}) }),
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
            const u = new URL(location.href); u.searchParams.delete("q"); u.searchParams.set("chat", chatId); window.history.replaceState(null, "", u);
          } else if (ev.type === "filters") data = { ...data, filters: ev.filters, relaxed: ev.relaxed, words: ev.words };
          else if (ev.type === "results") data.items = ev.items;
          else if (ev.type === "notice") notice = ev.text;
          else if (ev.type === "token") {
            text += ev.text;
            el.querySelector(".cg-text").innerHTML = (notice ? `<p class="cg-notice">${esc(notice)}</p>` : "") + linkify(text, data.items);
            toBottom();
          } else if (ev.type === "done") model = ev.model;
        }
      }
      finishBot(el, text, data, model);
      history.push({ role: "assistant", content: text });
      if (chatId) touchChat(chatId);
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
    if (!user) {
      list.innerHTML = `<p class="cg-side-note"><a href="/api/auth/github/login?next=${encodeURIComponent("/recommend/ask/")}">Sign in</a> to save your chats and come back to them later.</p>`;
      return;
    }
    list.innerHTML = chats.length
      ? chats.map((c) => `<div class="cg-item${c.id === chatId ? " active" : ""}" data-id="${esc(c.id)}"><a href="/recommend/ask/?chat=${encodeURIComponent(c.id)}" data-open>${esc(c.title)}</a><span class="cg-item-tools"><button type="button" data-rename title="Rename" aria-label="Rename">✎</button><button type="button" data-delete title="Delete" aria-label="Delete">✕</button></span></div>`).join("")
      : `<p class="cg-side-note">Your chats will appear here.</p>`;
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
    const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!r.ok) return newChat();
    const c = await r.json();
    chatId = c.id; history = []; log.innerHTML = ""; setEmpty(!c.messages.length); setTitle(c.title);
    for (const m of c.messages) {
      if (m.role === "user") userMsg(m.content);
      else finishBot(botMsg(), m.content, m.data || {}, m.data?.model);
      history.push({ role: m.role, content: m.content });
    }
    window.history.replaceState(null, "", `/recommend/ask/?chat=${encodeURIComponent(id)}`);
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
    $("[data-save-note]").textContent = user ? "Your chats are saved to your account." : "Sign in to save your chats.";
    if (user) chats = await fetch("/api/chats", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    renderList();
    if (user && params.get("chat")) await openChat(params.get("chat"));
    else setEmpty(true);
    if (params.get("q")) send(params.get("q"));
    else input.focus();
  });
})();
