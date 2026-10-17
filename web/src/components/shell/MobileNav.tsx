"use client";

/**
 * Mobile navigation state for the shell (≤767px): the Topbar hamburger opens
 * the Sidebar as a slide-over drawer. Pure chrome state — kept in its own
 * context so Topbar (trigger) and Sidebar (drawer) stay decoupled and the app
 * store stays about data, not layout.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { usePathname } from "next/navigation";

interface DrawerState {
  /** Route the drawer state was last synced to. */
  path: string;
  open: boolean;
}

interface MobileNav {
  open: boolean;
  /** Open the drawer from the hamburger. */
  show: () => void;
  /** Close and return focus to the hamburger (backdrop, Escape, toggle). */
  close: () => void;
  /** Hamburger ref: focus returns here whenever the drawer closes. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const MobileNavContext = createContext<MobileNav | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<DrawerState>({ path: pathname, open: false });

  // Route change closes the drawer: adjusting state during render is the
  // documented alternative to a close-effect, and it never steals focus from
  // the page just navigated to.
  if (drawer.path !== pathname) {
    setDrawer({ path: pathname, open: false });
  }

  const open = drawer.open;
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const show = useCallback(() => {
    setDrawer((prev) => (prev.open ? prev : { path: prev.path, open: true }));
  }, []);
  const close = useCallback(() => {
    setDrawer((prev) => (prev.open ? { path: prev.path, open: false } : prev));
    triggerRef.current?.focus();
  }, []);

  // While open: Escape closes and the page behind the drawer cannot scroll.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // imperative scroll lock, not design styling
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  // Crossing into the md+ desktop layout while the drawer is open would leave
  // the scroll lock with no visible close affordance — close it instead.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const onChange = () => {
      if (!desktop.matches) return;
      setDrawer((prev) => (prev.open ? { path: prev.path, open: false } : prev));
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  const value = useMemo<MobileNav>(
    () => ({ open, show, close, triggerRef }),
    [open, show, close],
  );

  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

export function useMobileNav(): MobileNav {
  const nav = useContext(MobileNavContext);
  if (!nav) throw new Error("useMobileNav must be used within <MobileNavProvider>");
  return nav;
}
