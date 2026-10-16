"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconChevronDown } from "@/components/ui/icons";

/**
 * Native <details> inspector styled as a card. aria-expanded is kept in sync
 * with the open attribute and aria-controls points at the content panel
 * (inventory #21 — disclosures must expose their state).
 */
export function InspectorDisclosure({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 rounded-card border border-line bg-surface shadow-card"
    >
      <summary
        aria-expanded={open}
        aria-controls={panelId}
        className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-card p-5 text-[13px] font-medium text-ink select-none [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0">{title}</span>
        <IconChevronDown
          size={14}
          className={cn(
            "shrink-0 text-ink-3 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </summary>
      <div id={panelId} className="px-5 pb-5">
        {children}
      </div>
    </details>
  );
}
