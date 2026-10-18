/**
 * Mobile drawer contract (≤767px): the hamburger opens the slide-over with a
 * scrim and a body scroll lock; Escape and the backdrop close it and return
 * focus to the trigger; navigating away closes it; crossing into the desktop
 * breakpoint closes it so a stale scroll lock never strands the page.
 *
 * jsdom ignores `display`, so the visible-only classes that make this a
 * mobile-only drawer (`md:hidden` trigger, `max-md:*` sidebar) are asserted
 * as class names — the computed-CSS behaviour was verified in the browser.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavProvider } from "@/components/shell/MobileNav";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { AppProvider } from "@/lib/store";

let mockPathname = "/";
let desktopMatches = false;
const pushMock = vi.fn();
const mediaListeners: Array<() => void> = [];

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}));

// Fresh element per render: rerendering an identical element reference lets
// React bail out of the subtree, which would hide route-change behaviour.
const shell = () => (
  <AppProvider>
    <MobileNavProvider>
      <Topbar />
      <Sidebar />
    </MobileNavProvider>
  </AppProvider>
);

function openDrawer() {
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  window.localStorage.clear();
  mockPathname = "/";
  desktopMatches = false;
  mediaListeners.length = 0;
  pushMock.mockClear();
  window.matchMedia = vi.fn((query: string) => ({
    get matches() {
      return desktopMatches;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      mediaListeners.push(listener);
    },
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe("mobile drawer", () => {
  it("opens from the hamburger with scrim, scroll lock and aria state", () => {
    render(shell());
    const trigger = openDrawer();

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAccessibleName("Close navigation");
    expect(trigger.className).toContain("md:hidden");

    const scrim = document.querySelector("div.bg-scrim");
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute("aria-hidden", "true");

    expect(document.body.style.overflow).toBe("hidden");

    const sidebar = document.getElementById("app-sidebar");
    expect(sidebar?.className).toContain("max-md:fixed");
    expect(sidebar?.className).toContain("max-md:translate-x-0");
    expect(sidebar?.className).not.toContain("max-md:invisible");
  });

  it("Escape closes it, restores scrolling and returns focus to the trigger", () => {
    render(shell());
    const trigger = openDrawer();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("div.bg-scrim")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);

    const sidebar = document.getElementById("app-sidebar");
    expect(sidebar?.className).toContain("max-md:invisible");
  });

  it("the backdrop closes it too", () => {
    render(shell());
    const trigger = openDrawer();

    const scrim = document.querySelector("div.bg-scrim");
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("div.bg-scrim")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("navigating to another route closes it", () => {
    const view = render(shell());
    const trigger = openDrawer();

    mockPathname = "/cache";
    view.rerender(shell());

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");
  });

  it("crossing into the desktop breakpoint closes it and releases the lock", () => {
    render(shell());
    const trigger = openDrawer();

    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 48rem)");
    expect(mediaListeners.length).toBeGreaterThan(0);

    desktopMatches = true;
    act(() => {
      for (const listener of mediaListeners) listener();
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");
  });
});
