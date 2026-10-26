// Cookie consent for Google Tag Manager / Google Analytics.
// Nothing from Google loads until the visitor accepts. The choice is stored in localStorage
// ("cookie-consent" = "granted" | "denied") and can be changed via "Cookie settings" in the footer.
(() => {
  const KEY = "cookie-consent";
  const banner = document.getElementById("consent");
  if (!banner) return;
  const get = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const set = (v) => {
    try { localStorage.setItem(KEY, v); } catch {}
  };
  const show = () => { banner.hidden = false; };
  const hide = () => { banner.hidden = true; };

  // Remove Google Analytics cookies when consent is withdrawn.
  const clearAnalyticsCookies = () => {
    const host = location.hostname.replace(/^www\./, "");
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0].trim();
      if (/^(_ga|_gid|_gat|_gcl)/.test(name))
        for (const d of [host, "." + host, location.hostname, ""])
          document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ""}`;
    }
  };

  banner.querySelector("[data-consent=accept]").addEventListener("click", () => {
    set("granted");
    hide();
    window.gtag?.("consent", "update", { analytics_storage: "granted" });
    window.__loadGTM?.();
  });
  banner.querySelector("[data-consent=reject]").addEventListener("click", () => {
    const wasGranted = get() === "granted";
    set("denied");
    hide();
    window.gtag?.("consent", "update", { analytics_storage: "denied" });
    if (wasGranted) {
      clearAnalyticsCookies();
      location.reload(); // unload the already-running tag manager
    }
  });
  for (const el of document.querySelectorAll("[data-consent-open]"))
    el.addEventListener("click", (e) => {
      e.preventDefault();
      show();
    });
  if (!get()) show();
})();
