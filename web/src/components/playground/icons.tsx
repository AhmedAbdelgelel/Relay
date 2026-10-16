/**
 * Playground-only icons (inline SVG, 16px default, stroke 1.5, currentColor —
 * same contract as @/components/ui/icons, kept local so the shared icon set
 * stays untouched).
 */

import type { ReactNode } from "react";
import type { IconProps } from "@/components/ui/icons";

function Base({
  size = 16,
  className,
  strokeWidth = 1.5,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Send (↑), mirrors the legacy #sendLabel glyph. */
export function IconArrowUp(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 19V5" />
      <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
    </Base>
  );
}

/** Stop (■), shown while a request is running. */
export function IconStopSquare(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </Base>
  );
}
