import type { ReactNode } from "react";

/**
 * Shared page frame for the control-plane routes: the same head pattern as the
 * Overview page (h1 + sub + right actions) plus the page-enter animation, so
 * every route opens the same way (inventory #19 — consistent page pattern).
 */
export function PageShell({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page-enter mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-5 py-6 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-[13px] text-ink-2">{sub}</p>
        </div>
        {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
