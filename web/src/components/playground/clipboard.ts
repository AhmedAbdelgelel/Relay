/**
 * Clipboard helper mirroring legacy state.js `copyText()`: the async Clipboard
 * API first, a hidden-textarea `execCommand` fallback for contexts where the
 * API is unavailable or permission-gated.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "sr-only";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      return true;
    } catch {
      return false;
    }
  }
}
