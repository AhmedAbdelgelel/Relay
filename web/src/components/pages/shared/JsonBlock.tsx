import { cn } from "@/lib/cn";

/**
 * Scrollable monospace block for inspector payloads. Long unbroken values
 * (sha256 hashes, base URLs) wrap instead of forcing a horizontal scrollbar.
 */
export function JsonBlock({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-[280px] overflow-y-auto rounded-control border border-line bg-sunken p-3 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-ink-2",
        className,
      )}
    >
      {text}
    </pre>
  );
}
