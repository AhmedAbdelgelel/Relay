import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "hit" | "semantic" | "miss" | "bypass" | "disabled" | "neutral" | "accent";

const TONES: Record<BadgeTone, string> = {
  hit: "bg-ok-soft text-ok",
  semantic: "bg-accent-soft text-accent-ink",
  miss: "bg-warn-soft text-warn",
  bypass: "bg-neutral-soft text-ink-2",
  disabled: "bg-neutral-soft text-ink-3",
  neutral: "bg-neutral-soft text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
};

/** Verdict pill: hit=green, semantic=blue, miss=amber, bypass/disabled=gray. */
export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const Pill = Badge;

export function verdictTone(verdict: string | null | undefined): BadgeTone {
  switch (verdict) {
    case "HIT":
      return "hit";
    case "SEMANTIC_HIT":
      return "semantic";
    case "MISS":
      return "miss";
    case "BYPASS":
      return "bypass";
    case "DISABLED":
      return "disabled";
    default:
      return "neutral";
  }
}
