import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PostCoderCheck } from '@gaido/core';

export interface CheckRunOk {
  ok: true;
}

export interface CheckRunFailed {
  ok: false;
  failedCheck: string;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type CheckRunResult = CheckRunOk | CheckRunFailed;

/**
 * Env vars gaido injects into every post-coder check subprocess. Also used
 * for `${VAR}` interpolation in argv strings. Lets the check command write
 * outputs into the run-specific artifacts directory without gaido needing to
 * understand the tool's CLI.
 */
export interface GaidoCheckEnv {
  GAIDO_RUN_ID: string;
  GAIDO_NODE_ID: string;
  GAIDO_WORKDIR: string;
  GAIDO_PROJECT_DIR: string;
  GAIDO_ARTIFACTS_DIR: string;
  GAIDO_RUN_ARTIFACTS_DIR: string;
}

export interface RunChecksOpts {
  checks: PostCoderCheck[];
  workdir: string;
  projectDir: string;
  artifactsDir: string;
  runId: string;
  nodeId: string;
  abortSignal: AbortSignal;
  /**
   * Cap on captured combined stdout+stderr per check, in bytes. The full
   * stream still flows; we only retain the tail. Default 8KB.
   */
  outputTailBytes?: number;
}

/**
 * Run checks in order, stopping at the first failure. Returns `{ok: true}`
 * if all pass. Streams are captured and returned as the combined tail on
 * failure — this is what gets fed back to the coder via `followUp`.
 */
export async function runChecks(opts: RunChecksOpts): Promise<CheckRunResult> {
  const tailBytes = opts.outputTailBytes ?? 8 * 1024;
  const gaidoEnv: GaidoCheckEnv = {
    GAIDO_RUN_ID: opts.runId,
    GAIDO_NODE_ID: opts.nodeId,
    GAIDO_WORKDIR: opts.workdir,
    GAIDO_PROJECT_DIR: opts.projectDir,
    GAIDO_ARTIFACTS_DIR: opts.artifactsDir,
    GAIDO_RUN_ARTIFACTS_DIR: path.join(opts.artifactsDir, opts.runId),
  };
  for (const check of opts.checks) {
    if (opts.abortSignal.aborted) {
      throw makeAbortError();
    }
    const cwd = check.cwd === 'project' ? opts.projectDir : opts.workdir;
    const result = await runOne(
      check,
      cwd,
      gaidoEnv,
      tailBytes,
      opts.abortSignal
    );
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Replace `${VAR}` (and `$VAR`) sequences in `s` with values from `env`. Only
 * `GAIDO_*` keys are eligible — we don't want a check's argv to leak the
 * user's PATH or similar. Unknown vars are left literal.
 */
export function interpolateArg(s: string, env: GaidoCheckEnv): string {
  return s.replace(
    /\$\{(GAIDO_[A-Z_]+)\}|\$(GAIDO_[A-Z_]+)/g,
    (_match, brace: string | undefined, bare: string | undefined) => {
      const key = (brace ?? bare) as keyof GaidoCheckEnv;
      return env[key] ?? _match;
    }
  );
}

async function runOne(
  check: PostCoderCheck,
  cwd: string,
  gaidoEnv: GaidoCheckEnv,
  tailBytes: number,
  abortSignal: AbortSignal
): Promise<CheckRunResult> {
  const rawArgs = check.command.map((a) => interpolateArg(a, gaidoEnv));
  const [bin, ...args] = rawArgs;
  if (!bin) {
    return {
      ok: false,
      failedCheck: check.name,
      output: `check '${check.name}': command is empty`,
      exitCode: null,
      signal: null,
    };
  }

  return new Promise<CheckRunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...gaidoEnv },
    });

    // Capture rolling tails of stdout and stderr, interleaved by arrival.
    let buf = '';
    const append = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > tailBytes * 2) {
        buf = buf.slice(-tailBytes);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const onAbort = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      abortSignal.removeEventListener('abort', onAbort);
      const message =
        err.code === 'ENOENT'
          ? `check '${check.name}': command not found: '${bin}'`
          : `check '${check.name}': spawn error: ${err.message}`;
      resolve({
        ok: false,
        failedCheck: check.name,
        output: message,
        exitCode: null,
        signal: null,
      });
    });

    child.on('close', (code, signal) => {
      abortSignal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const tail = buf.length > tailBytes ? buf.slice(-tailBytes) : buf;
        resolve({
          ok: false,
          failedCheck: check.name,
          output: tail.trim() || `(no output; exit ${code ?? 'signal ' + signal})`,
          exitCode: code,
          signal,
        });
      }
    });
  });
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Format a failed check result into the message sent back to the coder as
 * `followUp`. The coder sees the check name + recent output and is asked
 * to fix.
 */
export function formatFollowUp(result: CheckRunFailed): string {
  return [
    `Post-coder check '${result.failedCheck}' failed.`,
    '',
    'Output (tail):',
    '```',
    result.output,
    '```',
    '',
    'Please fix the issues above and stop. The check will re-run after you finish.',
  ].join('\n');
}
