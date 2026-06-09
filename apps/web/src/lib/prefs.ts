// Small localStorage-backed string preferences for remembering UI choices
// across sessions (e.g. the last skeleton/coder used to seed a root). Best
// effort: any failure (storage disabled, private mode, quota) silently falls
// back to no persistence rather than throwing into a render.

const PREFIX = 'gaido:';

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // best-effort; persistence is a convenience, not a requirement
  }
}
