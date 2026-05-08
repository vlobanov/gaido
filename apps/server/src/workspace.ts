import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

export interface CommitRunArgs {
  nodeId: string;
  runId: string;
  message: string;
}

export interface EnsureNodeArgs {
  nodeId: string;
  parentId?: string;
}

export interface WorkspaceManager {
  /** Path to a node's worktree (does not check existence). */
  workspacePath(nodeId: string): string;
  /** True iff the bare git store at runs/.git is initialized. */
  isInitialized(): boolean;
  /** Initialize the bare store; seed `main` from skeleton. Idempotent. */
  initStore(): Promise<void>;
  /**
   * Create a worktree for `nodeId` if missing. Branch `node/<nodeId>` is cut
   * from `node/<parentId>`'s tip if parentId is given, otherwise from `main`.
   * Returns the worktree path. Idempotent.
   */
  ensureNodeWorkspace(args: EnsureNodeArgs): Promise<string>;
  /**
   * Stage and commit all changes in the node's worktree. Returns the new sha
   * or null if there were no changes to commit.
   */
  commitRun(args: CommitRunArgs): Promise<string | null>;
  /** Remove worktree + branch. Idempotent. */
  removeNodeWorkspace(nodeId: string): Promise<void>;
}

export interface CreateWorkspaceManagerOpts {
  runsDir: string;
  skeletonDir: string;
}

const GIT_IDENT_ENV = {
  GIT_AUTHOR_NAME: 'gaido',
  GIT_AUTHOR_EMAIL: 'gaido@local',
  GIT_COMMITTER_NAME: 'gaido',
  GIT_COMMITTER_EMAIL: 'gaido@local',
};

export function createWorkspaceManager(
  opts: CreateWorkspaceManagerOpts
): WorkspaceManager {
  const { runsDir, skeletonDir } = opts;
  const gitDir = path.join(runsDir, '.git');
  const branchOf = (nodeId: string) => `node/${nodeId}`;
  const env = () => ({ ...process.env, ...GIT_IDENT_ENV });

  // Run git against the bare store directly (no worktree context).
  const git = (...args: string[]) =>
    exec('git', ['--git-dir', gitDir, ...args], { env: env() });

  // Run git inside a worktree (uses worktree's .git pointer file).
  const gitIn = (cwd: string, ...args: string[]) =>
    exec('git', args, { cwd, env: env() });

  const isInitialized = (): boolean => fs.existsSync(path.join(gitDir, 'HEAD'));

  const initStore = async (): Promise<void> => {
    if (isInitialized()) return;

    fs.mkdirSync(runsDir, { recursive: true });
    const bootstrap = path.join(runsDir, '.bootstrap');
    if (fs.existsSync(bootstrap)) {
      fs.rmSync(bootstrap, { recursive: true, force: true });
    }
    fs.mkdirSync(bootstrap, { recursive: true });

    // git ≥ 2.28 supports `init -b <branch>`. Avoids "master" default.
    await exec('git', ['init', '-b', 'main', bootstrap], { env: env() });

    if (fs.existsSync(skeletonDir)) {
      copyDirContents(skeletonDir, bootstrap);
    }

    await exec('git', ['-C', bootstrap, 'add', '-A'], { env: env() });
    await exec(
      'git',
      ['-C', bootstrap, 'commit', '--allow-empty', '-m', 'seed: skeleton'],
      { env: env() }
    );

    await exec('git', ['clone', '--bare', bootstrap, gitDir], { env: env() });
    fs.rmSync(bootstrap, { recursive: true, force: true });
  };

  const branchExists = async (name: string): Promise<boolean> => {
    try {
      await git('show-ref', '--verify', '--quiet', `refs/heads/${name}`);
      return true;
    } catch {
      return false;
    }
  };

  const ensureNodeWorkspace = async (args: EnsureNodeArgs): Promise<string> => {
    await initStore();
    const wt = path.join(runsDir, args.nodeId);
    if (fs.existsSync(path.join(wt, '.git'))) return wt;

    // Clean up any orphaned worktree records (e.g., dir nuked manually).
    try {
      await git('worktree', 'prune');
    } catch {
      // ignore — prune is best-effort
    }

    const branch = branchOf(args.nodeId);
    if (await branchExists(branch)) {
      await git('worktree', 'add', wt, branch);
    } else {
      const from = args.parentId ? branchOf(args.parentId) : 'main';
      await git('worktree', 'add', '-b', branch, wt, from);
    }
    return wt;
  };

  const commitRun = async (args: CommitRunArgs): Promise<string | null> => {
    const wt = path.join(runsDir, args.nodeId);
    if (!fs.existsSync(path.join(wt, '.git'))) {
      throw new Error(`commitRun: worktree missing for ${args.nodeId}`);
    }
    await gitIn(wt, 'add', '-A');
    const { stdout: staged } = await gitIn(wt, 'diff', '--cached', '--name-only');
    if (staged.trim() === '') return null;
    await gitIn(wt, 'commit', '-m', args.message);
    const { stdout: sha } = await gitIn(wt, 'rev-parse', 'HEAD');
    return sha.trim();
  };

  const removeNodeWorkspace = async (nodeId: string): Promise<void> => {
    if (!isInitialized()) return;
    const wt = path.join(runsDir, nodeId);
    try {
      await git('worktree', 'remove', '--force', wt);
    } catch {
      // worktree may have been removed manually; fall through
    }
    try {
      await git('branch', '-D', branchOf(nodeId));
    } catch {
      // branch may not exist; ignore
    }
    if (fs.existsSync(wt)) {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  };

  return {
    workspacePath: (nodeId) => path.join(runsDir, nodeId),
    isInitialized,
    initStore,
    ensureNodeWorkspace,
    commitRun,
    removeNodeWorkspace,
  };
}

function copyDirContents(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      copyDirContents(sp, dp);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sp), dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}
