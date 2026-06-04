import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

/** Worktree subdir for artist references — excluded from commits. */
export const REFERENCES_DIRNAME = 'references';

export interface CommitRunArgs {
  nodeId: string;
  canvasSlug: string;
  runId: string;
  message: string;
}

export interface EnsureNodeArgs {
  nodeId: string;
  canvasSlug: string;
  /**
   * Commit SHA (or any ref) to root this node's branch at. Used only on
   * first creation of the worktree — subsequent calls return the existing
   * path. Pass the ancestor coder's `runs.commitSha` so forks land off the
   * specific iteration the user chose, not the latest tip of that coder's
   * shared branch. Omit for root nodes — `seedSkeleton` is consulted then.
   */
  basisCommit?: string;
  /**
   * Skeleton preset to seed the worktree from when this is a root node
   * (i.e., no `basisCommit`). Resolves to a branch `seed/<name>` in the
   * bare store, lazy-created the first time the name is used. Defaults to
   * `'default'`. Ignored when `basisCommit` is set.
   */
  seedSkeleton?: string;
}

export interface WorkspacePathArgs {
  nodeId: string;
  canvasSlug: string;
}

export interface ArchiveCommitArgs {
  /** Commit SHA (or any tree-ish) in the bare store to extract. */
  commitSha: string;
  /** Destination directory; created if missing. Receives the tree contents. */
  destDir: string;
}

export interface RemoveNodeArgs {
  nodeId: string;
  canvasSlug: string;
}

export interface WorkspaceManager {
  /** Path to a node's worktree (does not check existence). */
  workspacePath(args: WorkspacePathArgs): string;
  /** True iff the bare git store at runs/.git is initialized. */
  isInitialized(): boolean;
  /** Initialize the bare store (empty — seed branches are created lazily). */
  initStore(): Promise<void>;
  /**
   * Create a worktree for `nodeId` if missing. Branch `node/<nodeId>` is cut
   * from `node/<branchParentId>`'s tip if given, otherwise from the seed
   * branch for `seedSkeleton` (defaulting to `'default'`). Returns the
   * worktree path. Idempotent.
   */
  ensureNodeWorkspace(args: EnsureNodeArgs): Promise<string>;
  /**
   * Stage and commit all changes in the node's worktree. Returns the new sha
   * or null if there were no changes to commit.
   */
  commitRun(args: CommitRunArgs): Promise<string | null>;
  /**
   * Extract a commit's tree from the bare store into `destDir` (read-only
   * snapshot, no working-tree coupling). Used to copy another run's code into
   * a node's `references/` folder without ever touching the source worktree.
   */
  archiveCommit(args: ArchiveCommitArgs): Promise<void>;
  /** Remove worktree + branch. Idempotent. */
  removeNodeWorkspace(args: RemoveNodeArgs): Promise<void>;
}

export interface CreateWorkspaceManagerOpts {
  runsDir: string;
  /**
   * Resolves a skeleton name to an absolute directory whose contents are
   * copied into the seed branch. Returns null when the name isn't found —
   * the seed branch is still created, just empty.
   */
  resolveSkeleton: (name: string) => string | null;
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
  const { runsDir, resolveSkeleton } = opts;
  const gitDir = path.join(runsDir, '.git');
  const branchOf = (nodeId: string) => `node/${nodeId}`;
  const seedBranchOf = (name: string) => `seed/${name}`;
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
    await exec('git', ['init', '--bare', gitDir], { env: env() });
  };

  const branchExists = async (name: string): Promise<boolean> => {
    try {
      await git('show-ref', '--verify', '--quiet', `refs/heads/${name}`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Lazy-create a seed branch for `name` in the bare store. Bootstraps a
   * temp working repo, copies the skeleton's contents (if resolved), makes a
   * single seed commit, pushes the branch into the bare repo, cleans up.
   */
  const ensureSeedBranch = async (name: string): Promise<string> => {
    await initStore();
    const branch = seedBranchOf(name);
    if (await branchExists(branch)) return branch;

    const source = resolveSkeleton(name);
    const bootstrap = path.join(runsDir, '.bootstrap');
    if (fs.existsSync(bootstrap)) {
      fs.rmSync(bootstrap, { recursive: true, force: true });
    }
    fs.mkdirSync(bootstrap, { recursive: true });

    await exec('git', ['init', '-b', branch, bootstrap], { env: env() });
    if (source && fs.existsSync(source)) {
      copyDirContents(source, bootstrap);
    }
    await exec('git', ['-C', bootstrap, 'add', '-A'], { env: env() });
    await exec(
      'git',
      ['-C', bootstrap, 'commit', '--allow-empty', '-m', `seed: ${name}`],
      { env: env() }
    );
    await exec(
      'git',
      ['-C', bootstrap, 'push', gitDir, `${branch}:${branch}`],
      { env: env() }
    );
    fs.rmSync(bootstrap, { recursive: true, force: true });
    return branch;
  };

  const ensureNodeWorkspace = async (args: EnsureNodeArgs): Promise<string> => {
    await initStore();
    const canvasDir = path.join(runsDir, args.canvasSlug);
    const wt = path.join(canvasDir, args.nodeId);
    if (fs.existsSync(path.join(wt, '.git'))) return wt;

    // Ensure the canvas-slug parent exists so `git worktree add` has a valid
    // target path (git creates the leaf, not intermediate dirs).
    fs.mkdirSync(canvasDir, { recursive: true });

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
      const from =
        args.basisCommit ?? (await ensureSeedBranch(args.seedSkeleton ?? 'default'));
      await git('worktree', 'add', '-b', branch, wt, from);
    }
    return wt;
  };

  const commitRun = async (args: CommitRunArgs): Promise<string | null> => {
    const wt = path.join(runsDir, args.canvasSlug, args.nodeId);
    if (!fs.existsSync(path.join(wt, '.git'))) {
      throw new Error(`commitRun: worktree missing for ${args.nodeId}`);
    }
    // Exclude `references/` — it holds artist-provided inputs (images, other
    // runs' code) materialized in for the coder to read. They're context, not
    // output, so they stay out of the node's branch and out of forks.
    await gitIn(wt, 'add', '-A', '--', '.', `:(exclude)${REFERENCES_DIRNAME}`);
    const { stdout: staged } = await gitIn(wt, 'diff', '--cached', '--name-only');
    if (staged.trim() === '') return null;
    await gitIn(wt, 'commit', '-m', args.message);
    const { stdout: sha } = await gitIn(wt, 'rev-parse', 'HEAD');
    return sha.trim();
  };

  const archiveCommit = async (args: ArchiveCommitArgs): Promise<void> => {
    fs.mkdirSync(args.destDir, { recursive: true });
    // `git archive` writes the exact tree at the commit — no index, no HEAD
    // mutation, nothing that could write back into the source. Stage to a tar
    // then extract, avoiding a shell pipe.
    const tarPath = path.join(args.destDir, '.gaido-archive.tar');
    await git('archive', '--format=tar', '-o', tarPath, args.commitSha);
    await exec('tar', ['-xf', tarPath, '-C', args.destDir]);
    fs.rmSync(tarPath, { force: true });
  };

  const removeNodeWorkspace = async (args: RemoveNodeArgs): Promise<void> => {
    if (!isInitialized()) return;
    const wt = path.join(runsDir, args.canvasSlug, args.nodeId);
    try {
      await git('worktree', 'remove', '--force', wt);
    } catch {
      // worktree may have been removed manually; fall through
    }
    try {
      await git('branch', '-D', branchOf(args.nodeId));
    } catch {
      // branch may not exist; ignore
    }
    if (fs.existsSync(wt)) {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  };

  return {
    workspacePath: (args) => path.join(runsDir, args.canvasSlug, args.nodeId),
    isInitialized,
    initStore,
    ensureNodeWorkspace,
    commitRun,
    archiveCommit,
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
