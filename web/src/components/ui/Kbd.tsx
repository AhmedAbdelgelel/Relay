import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Keyboard hint chip, e.g. <Kbd>↵</Kbd> or <Kbd>Esc</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] border border-line bg-surface px-1.5 font-sans text-[11px] text-ink-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
