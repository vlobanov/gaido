/**
 * Resolve the base URL of the Gaido server, plus a derived WebSocket URL for
 * tRPC subscriptions. Reads VITE_GAIDO_URL when set (useful for dev mode where
 * Vite runs at :5173 and the server is at :4288); otherwise uses the same
 * origin as the page (production: the server serves the bundled UI).
 */
const RAW = (
  import.meta.env.VITE_GAIDO_URL ?? window.location.origin
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
