import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { schema } from '@vadimlobanov/gaido-core';
import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import type { Paths } from './paths.js';
import type { WorkspaceManager } from './workspace.js';

/**
 * Built-in per-run static preview server. Long-lived, bound once at startup on
 * its own port, separate from the main gaido server so each previewed run gets
 * its own browser origin. Routes by Host header:
 *
 *   http://<runId-label>.<canvasSlug>.localhost:<port>/...
 *
 * `<runId-label>` is the run id with its `r_` prefix dropped (so the label is a
 * valid DNS label). The handler resolves the run's commit, lazily `git
 * archive`s it into `runs/.previews/<commit>/` (cached, deduped by commit), and
 * serves files from there. Giving each run its own subdomain origin means
 * root-absolute asset URLs (`/assets/app.js`) resolve correctly without any
 * rewriting — the reason this is subdomain- rather than path-routed.
 *
 * `*.localhost` resolves to loopback in Chrome and Firefox out of the box;
 * Safari / the macOS system resolver may need an `/etc/hosts` entry.
 */
export interface StaticPreviewHandle {
  /** Loopback base, e.g. `http://127.0.0.1:4289`. Per-run URLs use subdomains. */
  readonly baseUrl: string;
  readonly port: number;
  /** Stop the server. Idempotent. */
  stop(): Promise<void>;
}

interface StartOpts {
  db: Db;
  workspace: WorkspaceManager;
  paths: Paths;
  port: number;
  onLog?: (level: 'info' | 'error', line: string) => void;
}

/** runId (`r_<id>`) → DNS-safe subdomain label (`<id>`), dropping the `r_`. */
export function runIdToLabel(runId: string): string {
  return runId.replace(/^r_/, '');
}

/**
 * Build the per-run preview URL the UI links to. Kept here next to the Host
 * parser so the URL the orchestrator persists and the route the server matches
 * never drift apart.
 */
export function buildStaticPreviewUrl(
  port: number,
  runId: string,
  canvasSlug: string
): string {
  return `http://${runIdToLabel(runId)}.${canvasSlug}.localhost:${port}/`;
}

/** Extract the run-id label from `<label>.<canvasSlug>.localhost[:port]`. */
function runLabelFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0] ?? '';
  if (!hostname.endsWith('.localhost')) return null;
  const label = hostname.split('.')[0] ?? '';
  return label.length > 0 ? label : null;
}

export async function startStaticPreviewServer(
  opts: StartOpts
): Promise<StaticPreviewHandle> {
  const { db, workspace, paths, port, onLog } = opts;

  // In-flight archive promises, keyed by commit sha, so concurrent requests
  // for the same not-yet-cached commit await one `git archive`, not N.
  const archiving = new Map<string, Promise<string>>();

  const ensureArchive = (commit: string): Promise<string> => {
    const destDir = path.join(paths.previewsDir, commit);
    // Sibling marker (outside destDir, so it's never itself servable) written
    // only after archive completes — distinguishes "done" from the partial
    // dir `archiveCommit` mkdirs up front.
    const readyMarker = path.join(paths.previewsDir, `.ready-${commit}`);
    if (fs.existsSync(readyMarker)) return Promise.resolve(destDir);
    let inflight = archiving.get(commit);
    if (!inflight) {
      inflight = (async () => {
        await workspace.archiveCommit({ commitSha: commit, destDir });
        fs.writeFileSync(readyMarker, '');
        return destDir;
      })().finally(() => archiving.delete(commit));
      archiving.set(commit, inflight);
    }
    return inflight;
  };

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const label = runLabelFromHost(req.headers.host);
    if (!label) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(
        'gaido preview server. Open a run at ' +
          'http://<runId>.<canvas>.localhost:' +
          `${port}/ (the "Open live preview" link in the graph).`
      );
      return;
    }
    const runId = `r_${label}`;
    const run = db
      .select({
        id: schema.runs.id,
        nodeId: schema.runs.nodeId,
        commitSha: schema.runs.commitSha,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get();
    if (!run) {
      res.statusCode = 404;
      res.end(`gaido preview: no such run (${runId})`);
      return;
    }
    // A run that produced a diff carries its own immutable commit; a no-diff
    // run rendered its branch tip, so fall back to that.
    const commit = run.commitSha ?? (await workspace.resolveBranchTip(run.nodeId));
    if (!commit) {
      res.statusCode = 404;
      res.end('gaido preview: this run has no committed code to serve yet');
      return;
    }
    const root = await ensureArchive(commit);
    serveStatic(root, req, res);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.('error', `preview request failed: ${msg}`);
      if (!res.headersSent) res.statusCode = 500;
      res.end(msg);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `static preview port ${port} is already in use — set ` +
                `staticPreview.port in gaido.config.ts or disable it`
            )
          : err
      );
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      stopped = true;
      server.close(() => resolve());
    });

  return { baseUrl, port, stop };
}

/** Stream a file out of `root` for the request path. Path-traversal-safe. */
function serveStatic(
  root: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const resolvedRoot = path.resolve(root);
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const safeRel = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const filePath = path.join(
    resolvedRoot,
    safeRel === '' || safeRel === '/' ? 'index.html' : safeRel
  );
  // Resolved path must stay under root (defends against `..` escapes).
  if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  // SPA-style fallback: serve index.html for any missing non-asset path so
  // client-side routes work. A request that looks like a file (has an
  // extension) 404s as expected.
  if (!stat || stat.isDirectory()) {
    if (path.extname(filePath) === '') {
      const indexPath = path.join(resolvedRoot, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.setHeader('content-type', MIME['.html']!);
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
    }
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', mimeFor(filePath));
  // Previews are live and re-archived per commit; never cache stale bytes.
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(filePath).pipe(res);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
