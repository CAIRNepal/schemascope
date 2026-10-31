"use client";
// Small interactive pieces; everything else renders on the server.
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export function ThemeToggle() {
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      onClick={() => {
        const root = document.documentElement;
        const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
        root.dataset.theme = dark ? "light" : "dark";
        try {
          localStorage.setItem("theme", root.dataset.theme);
        } catch {}
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
    </button>
  );
}

// "/" focuses the first search box on the page.
export function SlashToSearch() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const input = document.querySelector<HTMLInputElement>('input[type="search"]');
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

// Catalog filters are a plain GET form (works without JavaScript); with JavaScript, changes apply immediately.
export function AutoSubmitFilters({ children, className }: { children: React.ReactNode; className?: string }) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const go = () => {
    const form = ref.current;
    if (!form) return;
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string" && v !== "") params.set(k, v);
    router.replace(`/catalog/${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  return (
    <form
      ref={ref}
      className={className}
      action="/catalog/"
      method="get"
      role="search"
      onChange={(e) => {
        if (timer.current) clearTimeout(timer.current);
        // Typing waits for a pause; selects and checkboxes apply at once.
        const t = e.target as unknown as HTMLInputElement;
        timer.current = setTimeout(go, t.tagName === "INPUT" && t.type === "search" ? 300 : 0);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      {children}
    </form>
  );
}
