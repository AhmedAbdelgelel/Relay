// Minimal JSON logger.

export function log(fields: Record<string, unknown>): void {
  // One JSON object per line so logs stay greppable without a framework.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
