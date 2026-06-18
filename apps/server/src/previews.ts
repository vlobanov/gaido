import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.js';
import type { WorkspaceManager } from './workspace.js';

/**
 * Materializes a run's code on demand by `git archive`-ing its commit into
 * `runs/.previews/<commit>/`. Shared by the built-in static preview server
 * (which serves files from there) and the "Reveal code" action (which opens the
 * folder in the OS file manager). Keyed by commit sha, so runs/retries that
 * share a tip dedupe to a single archive; an in-flight map collapses concurrent
 * requests for the same not-yet-cached commit onto one `git archive`.
 */
export interface PreviewArchiver {
  /**
   * Ensure the commit's tree is extracted under `runs/.previews/<commit>/` and
   * return that directory. Idempotent and concurrency-safe.
   */
  ensureArchive(commit: string): Promise<string>;
}

export function createPreviewArchiver(deps: {
  workspace: WorkspaceManager;
  paths: Paths;
}): PreviewArchiver {
  const { workspace, paths } = deps;
  // In-flight archive promises, keyed by commit sha, so concurrent callers for
  // the same not-yet-cached commit await one `git archive`, not N.
  const archiving = new Map<string, Promise<string>>();

  const ensureArchive = (commit: string): Promise<string> => {
    const destDir = path.join(paths.previewsDir, commit);
    // Sibling marker (outside destDir, so it's never itself servable) written
    // only after archive completes — distinguishes "done" from the partial dir
    // `archiveCommit` mkdirs up front.
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

  return { ensureArchive };
}

/**
 * Open a path in the OS file manager (Finder / Explorer / the freedesktop
 * default). gaido is local-first and single-user — the server runs on the
 * artist's own machine, so this surfaces a folder on their desktop. The path is
 * always server-derived (never user input), so there is nothing to inject.
 */
export function openInFileManager(targetPath: string): Promise<void> {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [targetPath], { stdio: 'ignore', detached: true });
    // 'spawn' fires once the child is up; don't await its exit — explorer.exe
    // returns non-zero even on success, and opening a window is fire-and-forget.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}
