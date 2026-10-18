"use client";

/**
 * Accessible switch (role="switch") with the dsh pill treatment — shared by
 * the composer's streaming toggle and Settings → Advanced.
 */

import { cn } from "@/lib/cn";

export function Switch({
  checked,
  onToggle,
  labelledBy,
  className,
}: {
  checked: boolean;
  onToggle: () => void;
  labelledBy?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-line transition-colors duration-150",
        checked ? "bg-btn" : "bg-sunken",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-3.5 rounded-full transition-transform duration-150",
          checked ? "translate-x-[18px] bg-btn-text" : "translate-x-[2px] bg-ink-3",
        )}
      />
    </button>
  );
}
