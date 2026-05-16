import { spawn, type ChildProcess } from 'node:child_process';
import type { PreviewServerConfig } from '@gaido/core';

export interface PreviewServerHandle {
  /**
   * Internal base URL the server is reachable on from this machine, e.g.
   * 'http://127.0.0.1:3004'. Used server-side (Playwright renderer, readiness
   * probes). Never sent to remote browsers.
   */
  readonly baseUrl: string;
  /** Stop the subprocess. Idempotent. */
  stop(): Promise<void>;
}

interface StartOpts {
  config: PreviewServerConfig;
  /**
   * Default cwd if `config.cwd` is unset — typically the project root. The
   * subprocess inherits this so projects can use bare commands like
   * `pnpm exec serve` without absolute paths.
   */
  defaultCwd: string;
  /**
   * Absolute path the subprocess should treat as its scratch / per-run state
   * directory. Wired through `config.outDirEnv` when set, AND exposed as
   * the standard `GAIDO_ARTIFACTS_DIR` env var so projects can pick it up
   * generically. Usually `<project>/runs/.artifacts`. The orchestrator
   * writes per-run outputs under `<outDir>/<canvasSlug>/<runId>/`.
   */
  outDir: string;
  /** Absolute path to the gaido project root. Exposed as GAIDO_PROJECT_DIR. */
  projectDir: string;
  /**
   * Called for each stdout/stderr line. Use for surfacing logs via gaido's
   * logger so the user sees what their dev server is doing.
   */
  onLog?: (level: 'info' | 'error', line: string) => void;
}

/**
 * Spawn the project's dev server, wait for `ready` to respond 2xx, return a
 * handle. Crashes during startup propagate; crashes after startup are logged
 * but don't auto-restart (the user can fix and re-launch gaido — same
 * semantics as a crashed coder config).
 *
 * The subprocess inherits gaido's process group so SIGTERM/SIGINT during
 * shutdown reaches it; we additionally call `.kill()` to be sure.
 */
export async function startPreviewServer(
  opts: StartOpts
): Promise<PreviewServerHandle> {
  const { config, defaultCwd, outDir, projectDir, onLog } = opts;
  const [bin, ...args] = config.command;
  if (!bin) {
    throw new Error('previewServer.command must be a non-empty argv array');
  }

  const env = {
    ...process.env,
    GAIDO_PROJECT_DIR: projectDir,
    GAIDO_ARTIFACTS_DIR: outDir,
    ...(config.env ?? {}),
    ...(config.outDirEnv ? { [config.outDirEnv]: outDir } : {}),
  };

  const cwd = config.cwd ?? defaultCwd;
  const child: ChildProcess = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so we can SIGTERM the whole tree (e.g. when the dev
    // server itself spawns esbuild / vite under it).
    detached: false,
  });

  // Stream logs line-by-line so users see startup output and crashes.
  pipeLines(child.stdout, (line) => onLog?.('info', line));
  pipeLines(child.stderr, (line) => onLog?.('error', line));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    // Backstop: SIGKILL if SIGTERM doesn't take in 3s.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  const baseUrl = `http://127.0.0.1:${config.port}`;
  const readyPath = config.ready ?? '/';
  const readyUrl = `${baseUrl}${readyPath.startsWith('/') ? readyPath : `/${readyPath}`}`;

  // If the subprocess crashes during startup, surface that instead of
  // waiting for ready forever.
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (stopped) return;
      reject(
        new Error(
          `preview server '${bin}' exited before becoming ready ` +
            `(${signal ?? `code ${code}`})`
        )
      );
    });
    child.once('error', (err) => {
      if (stopped) return;
      reject(new Error(`preview server spawn failed: ${err.message}`));
    });
  });

  try {
    await Promise.race([waitForReady(readyUrl, 30_000), earlyExit]);
  } catch (err) {
    await stop();
    throw err;
  }

  // After ready: surface unexpected exits as warnings — but don't take the
  // whole gaido server down with them. Users can ctrl-c and restart.
  child.once('exit', (code, signal) => {
    if (stopped) return;
    onLog?.(
      'error',
      `preview server exited unexpectedly (${signal ?? `code ${code}`}); ` +
        `restart gaido to bring it back`
    );
  });

  return { baseUrl, stop };
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`preview server readiness probe timed out at ${url}: ${msg}`);
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void
): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) onLine(buf);
  });
}
