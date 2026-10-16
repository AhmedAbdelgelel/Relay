import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Card } from "./Card";

/** Metric card: 12px label, 24px/600 tabular value, 12px detail. */
export function StatCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <Card padded={false} className={cn("p-4", className)}>
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-1.5 text-[24px] leading-8 font-semibold text-ink tabular-nums">
        {value}
      </div>
      {detail ? <div className="mt-1 text-[12px] text-ink-3 tabular-nums">{detail}</div> : null}
    </Card>
  );
}
