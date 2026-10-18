/**
 * Route-switch draft for the playground form (rough edge #12: the legacy app
 * lost the composer draft and form tweaks on every route change).
 *
 * A module-scoped object survives App Router client-side navigation because
 * the module stays in the browser's module registry, while a full reload
 * intentionally starts fresh — same as the legacy form, and nothing lands in
 * localStorage.
 *
 * SSR determinism: the object is only mutated from event handlers, which never
 * run on the server, so prerendered HTML and the first client render both read
 * the initial (empty) draft.
 */

import { DEFAULTS } from "./catalog";

export interface PlaygroundDraft {
  model: string;
  stream: boolean;
  system: string;
  user: string;
}

const DRAFT: PlaygroundDraft = {
  model: DEFAULTS.model,
  stream: DEFAULTS.stream,
  system: "",
  user: "",
};

export function getDraft(): PlaygroundDraft {
  return DRAFT;
}

/** Replace the draft wholesale (called only from event handlers). */
export function setDraft(next: PlaygroundDraft): void {
  Object.assign(DRAFT, next);
}
