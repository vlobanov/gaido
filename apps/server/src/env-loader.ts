import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LoadEnvResult {
  loaded: string[];
  applied: number;
}

/**
 * Load `.env` files in precedence order:
 *   1. `~/.gaido/.env` — shared across projects (e.g., API keys).
 *   2. `<projectDir>/.env` — per-project, overrides shared.
 *
 * Existing `process.env` values always win — both files are non-destructive.
 * Returns the absolute paths of the files that were actually loaded.
 */
export function loadEnv(projectDir: string): LoadEnvResult {
  const candidates = [
    path.join(os.homedir(), '.gaido', '.env'),
    path.join(projectDir, '.env'),
  ];
  const loaded: string[] = [];
  let applied = 0;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseDotenv(text);
    for (const [k, v] of Object.entries(parsed)) {
      // Per-project file is loaded after shared, so it overrides shared
      // (within this loader's domain). Existing process.env still wins —
      // a user's exported var should not get clobbered by a checked-in
      // file.
      if (k in process.env) continue;
      process.env[k] = v;
      applied++;
    }
    loaded.push(file);
  }
  return { loaded, applied };
}

/**
 * Minimal .env parser. Handles KEY=value, KEY="value" (with \" escapes),
 * KEY='value' (literal), comments (# at line start or after whitespace),
 * and trailing whitespace. No interpolation.
 */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // Strip an inline comment if value isn't quoted.
    if (
      val.length > 0 &&
      val[0] !== '"' &&
      val[0] !== "'"
    ) {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      const quote = val[0];
      const inner = val.slice(1, -1);
      val =
        quote === '"'
          ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : inner;
    }
    out[key] = val;
  }
  return out;
}
