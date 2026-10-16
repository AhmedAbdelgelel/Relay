import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  title,
  detail,
  className,
}: {
  icon?: ReactNode;
  title: string;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="text-ink-3">{icon}</div> : null}
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {detail ? <div className="max-w-md text-[12px] text-ink-3">{detail}</div> : null}
    </div>
  );
}
