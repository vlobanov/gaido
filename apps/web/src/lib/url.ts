/**
 * Resolve the base URL of the Gaido server, plus a derived WebSocket URL for
 * tRPC subscriptions. Precedence:
 *   1. VITE_GAIDO_URL env var (override, e.g. for non-default ports).
 *   2. Dev mode (`vite dev` at :5173): default to http://127.0.0.1:4288.
 *   3. Production: same origin as the page (server serves the bundled UI).
 */
const DEFAULT_DEV_URL = 'http://127.0.0.1:4288';
const RAW = (
  import.meta.env.VITE_GAIDO_URL ??
  (import.meta.env.DEV ? DEFAULT_DEV_URL : window.location.origin)
).replace(/\/+$/, '');

export const httpUrl = RAW;
export const trpcHttpUrl = `${RAW}/trpc`;

export const wsUrl = (() => {
  try {
    const u = new URL(RAW);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = u.pathname.replace(/\/+$/, '') + '/trpc';
    return u.toString();
  } catch {
    return `ws://${window.location.host}/trpc`;
  }
})();
