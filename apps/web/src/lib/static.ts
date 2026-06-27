import type { GaidoSnapshot } from '@vadimlobanov/gaido-core';
import { httpUrl } from './url';

declare global {
  interface Window {
    __GAIDO_SNAPSHOT__?: GaidoSnapshot;
  }
}

/**
 * Static (published) mode: the web app runs with no server. A single embedded
 * `GaidoSnapshot` answers every read query (see `static-link.ts`), all
 * mutations are disabled, and there is no WebSocket. Flipped at build time with
 * `VITE_GAIDO_STATIC=1`; the live dev/server build leaves it unset, so the app
 * behaves exactly as before.
 */
export const STATIC_MODE =
  import.meta.env.VITE_GAIDO_STATIC === '1' ||
  import.meta.env.VITE_GAIDO_STATIC === 'true';

/** No editing on a published canvas. Tracks STATIC_MODE 1:1 today. */
export const READ_ONLY = STATIC_MODE;

/**
 * Trimmed-chrome mode for iframe embeds — `?embed=1` hides the toolbar so a
 * published canvas drops cleanly into an `<iframe>`. Read once at load.
 */
export const EMBED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('embed') === '1';

let snapshot: GaidoSnapshot | null =
  (typeof window !== 'undefined' && window.__GAIDO_SNAPSHOT__) || null;

export function hasSnapshot(): boolean {
  return snapshot != null;
}

export function getSnapshot(): GaidoSnapshot {
  if (!snapshot) {
    throw new Error('[gaido] static mode is on but no snapshot is loaded');
  }
  return snapshot;
}

/** Inject a snapshot at runtime — used by the dev harness and tests. */
export function setSnapshot(s: GaidoSnapshot): void {
  snapshot = s;
}

/**
 * Resolve an artifact id to a playable URL. Static mode maps it to the
 * snapshot's published URL (R2/CDN); live mode hits the server's
 * `/artifacts/:id` route. Returns '' for a null id so callers keep their
 * existing presence guard.
 */
export function artifactUrl(id: string | null | undefined): string {
  if (!id) return '';
  if (STATIC_MODE) {
    return getSnapshot().artifacts.find((a) => a.id === id)?.url ?? '';
  }
  return `${httpUrl}/artifacts/${id}`;
}

/** Resolve a reference id to its image URL — snapshot-published or server route. */
export function referenceUrl(id: string | null | undefined): string {
  if (!id) return '';
  if (STATIC_MODE) {
    return getSnapshot().references.find((r) => r.id === id)?.url ?? '';
  }
  return `${httpUrl}/references/${id}`;
}
