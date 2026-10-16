"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { THEME_KEY } from "@/lib/store";
import { IconMoon, IconSun } from "@/components/ui/icons";

const ROUTE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/overview": "Overview",
  "/playground": "Playground",
  "/requests": "Requests",
  "/cache": "Cache",
  "/providers": "Providers",
};

function routeTitle(pathname: string): string {
  const known = ROUTE_TITLES[pathname];
  if (known) return known;
  const segment = pathname.split("/").filter(Boolean).pop();
  return segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : "Overview";
}

/** Keep every theme-color meta in step with the active theme (inventory #21). */
function syncThemeColor(theme: "light" | "dark") {
  const color = theme === "dark" ? "#0a0a0a" : "#f9f8f8";
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = color;
    });
}

function ThemeToggle() {
  // Icons are driven purely by CSS (`dark:` variant) so there is no hydration
  // mismatch: the pre-paint script sets data-theme before first render.
  useEffect(() => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    syncThemeColor(current);
  }, []);

  const toggle = () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage disabled: theme still applies for this session */
    }
    syncThemeColor(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      title="Toggle theme"
      className="grid size-8 place-items-center rounded-[8px] text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink"
    >
      <IconSun size={16} className="hidden dark:block" />
      <IconMoon size={16} className="block dark:hidden" />
    </button>
  );
}

export function Topbar() {
  const pathname = usePathname();
  const title = routeTitle(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-translucent px-4 backdrop-blur-md">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="font-medium text-ink">relay</span>
        <span aria-hidden="true" className="text-ink-3">
          /
        </span>
        <span aria-current="page" className="truncate text-ink-2">
          {title}
        </span>
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
