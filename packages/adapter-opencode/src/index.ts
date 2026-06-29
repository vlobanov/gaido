import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { Coder, CoderInput, CoderResult, RunContext } from '@vadimlobanov/gaido-core';

export interface OpencodeCoderOpts {
  /** Path to the opencode executable. Default: 'opencode' (resolved via PATH). */
  bin?: string;
  /**
   * Model id in opencode's `provider/model` form (e.g.
   * 'anthropic/claude-sonnet-4-5', 'opencode/deepseek-v4-flash-free',
   * 'ollama/qwen2.5-coder:7b'). Omitted by default so opencode falls back to
   * the model configured in its own config. The provider must be configured
   * in opencode (its auth / `opencode.json`), not in Gaido.
   */
  model?: string;
  /**
   * Reasoning effort, passed through as `--variant <level>` (opencode's
   * "model variant", e.g. 'minimal' | 'low' | 'high' | 'max'). Typed loosely
   * so new levels work without an adapter bump; the CLI validates. Omitted
   * when unset.
   */
  effort?: string;
  /**
   * opencode agent to run as (`--agent <name>`, e.g. 'build' | 'plan'). The
   * default agent ('build', full tool access) fits the worktree model, so
   * this is omitted unless you want a constrained agent.
   */
  agent?: string;
  /**
   * Auto-approve tool permissions (`--dangerously-skip-permissions`). Default
   * true — fits the sandboxed worktree model where the agent owns its
   * directory, and is required for non-interactive `run` to edit files (an
   * unapproved tool is denied, never prompted, in headless mode). Set false
   * to defer to opencode's own permission config.
   */
  skipPermissions?: boolean;
  /** Extra CLI args appended to the spawn (after the standard flags). */
  extraArgs?: string[];
}

export function opencodeCoder(opts: OpencodeCoderOpts = {}): Coder {
  const cfg: ResolvedConfig = {
    bin: opts.bin ?? 'opencode',
    model: opts.model,
    effort: opts.effort,
    agent: opts.agent,
    skipPermissions: opts.skipPermissions ?? true,
    extraArgs: opts.extraArgs ?? [],
  };

  return {
    kind: 'opencode',
    run: (input, ctx) => runCoder(cfg, input, ctx),
  };
}

interface ResolvedConfig {
  bin: string;
  model?: string;
  effort?: string;
  agent?: string;
  skipPermissions: boolean;
  extraArgs: string[];
}

/**
 * Unlike claude-code and codex, opencode's structured `--format json` stream
 * is unusable here: when spawned as a subprocess it hangs without emitting the
 * stream (opencode#11891, #17516). So this adapter drives the *default* output
 * mode, which exits cleanly and writes the worktree, and harvests structured
 * data from two reliable side-channels instead:
 *   - `--print-logs` writes structured key=value logs to stderr; the
 *     `message=created id=ses_…` line yields the session id (live).
 *   - `opencode export <sessionId>` dumps the finished session as one JSON
 *     object; we replay its tool parts as `tool_call` events and its usage as
 *     a closing `token_usage` (post-run, once the process has exited cleanly).
 * Assistant text streams live from stdout as `agent_token`.
 */
async function runCoder(
  cfg: ResolvedConfig,
  input: CoderInput,
  ctx: RunContext
): Promise<CoderResult> {
  // `followUp` is the next message in a resumed session — same contract as the
  // other coder adapters. `--session <id>` resumes that session, so the
  // original instruction is already in scope.
  const prompt = input.followUp ?? input.instruction;

  // `--dir` pins the working directory explicitly. opencode derives its
  // project dir from the inherited `$PWD`, NOT the spawn `cwd` — and the
  // orchestrator's `$PWD` is the project root, not this node's worktree — so
  // without this opencode would read/write the wrong tree. We also overwrite
  // `PWD` in the child env to match (belt and suspenders).
  const args = ['run', '--print-logs', '--log-level', 'INFO', '--dir', ctx.workdir];
  if (cfg.model) {
    args.push('--model', cfg.model);
  }
  if (cfg.effort) {
    args.push('--variant', cfg.effort);
  }
  if (cfg.agent) {
    args.push('--agent', cfg.agent);
  }
  if (cfg.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (input.priorSessionId) {
    args.push('--session', input.priorSessionId);
  }
  args.push(...cfg.extraArgs);
  // Prompt is the positional `message`; keep it last so flags parse first.
  args.push(prompt);

  ctx.logger.info(
    `[opencode] spawn ${cfg.bin} model=${cfg.model ?? 'default'}${cfg.effort ? ` variant=${cfg.effort}` : ''}${cfg.agent ? ` agent=${cfg.agent}` : ''} resume=${input.priorSessionId ?? 'none'} ${input.followUp ? 'follow-up ' : ''}cwd=${ctx.workdir}`
  );

  // Snapshot the session BEFORE this turn. `opencode export` reports
  // whole-session cumulative usage, so on a resumed/continued node we must
  // diff against this baseline to attribute only THIS run's cost/tokens/tool
  // calls. Fresh sessions get a zero baseline; a resumed session whose
  // baseline can't be read yields 'unknown' (usage then skipped, not
  // over-reported). Done before spawn so nothing else can touch the session
  // in between.
  const baseline = await captureBaseline(cfg, input.priorSessionId ?? null, ctx);

  return new Promise<CoderResult>((resolve, reject) => {
    const child = spawn(cfg.bin, args, {
      cwd: ctx.workdir,
      env: { ...process.env, PWD: ctx.workdir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // On resume the id is already known; on a fresh run the `message=created`
    // log line below fills it in.
    let sessionId: string | null = input.priorSessionId ?? null;
    let stderrBuf = '';
    let stdoutTail = '';
    let settled = false;

    // Tee raw subprocess streams to disk so postmortems don't depend on
    // re-parsing the structured event log. Append-mode in case the run loop
    // re-spawns opencode for a check retry — each spawn extends the same file.
    const stdoutLogPath = path.join(ctx.logDir, 'coder.stdout.log');
    const stderrLogPath = path.join(ctx.logDir, 'coder.stderr.log');
    const stdoutLog = fs.createWriteStream(stdoutLogPath, { flags: 'a' });
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: 'a' });
    stdoutLog.on('error', (err) =>
      ctx.logger.warn(`[opencode] stdout log write failed: ${err.message}`)
    );
    stderrLog.on('error', (err) =>
      ctx.logger.warn(`[opencode] stderr log write failed: ${err.message}`)
    );

    const onAbort = () => {
      if (settled) return;
      ctx.logger.warn('[opencode] aborting subprocess');
      child.kill('SIGTERM');
      // Backstop: SIGKILL if SIGTERM doesn't take effect. opencode is known to
      // occasionally not exit on its own (opencode#17516), so don't wait long.
      setTimeout(() => {
        if (!settled && !child.killed) child.kill('SIGKILL');
      }, 2000).unref();
    };
    if (ctx.abortSignal.aborted) {
      onAbort();
    } else {
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      ctx.abortSignal.removeEventListener('abort', onAbort);
      stdoutLog.end();
      stderrLog.end();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLog.write(chunk);
      const text = chunk.toString('utf8');
      // Default-mode stdout is the assistant's reply text (no envelope). Stream
      // it as agent_token so the UI ticks while the run is live.
      if (text.length > 0) {
        ctx.emit({ kind: 'agent_token', phase: 'coding', text });
      }
      stdoutTail = (stdoutTail + text).slice(-500);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLog.write(chunk);
      stderrBuf += chunk.toString('utf8');
      // Pull the session id out of the structured `message=created` log line
      // the first time it appears. Only fresh runs log it; resumes already
      // carry priorSessionId.
      if (!input.priorSessionId) {
        const m = stderrBuf.match(/message=created\s+id=(ses_[A-Za-z0-9]+)/);
        if (m && m[1]) sessionId = m[1];
      }
      // Bound the buffer; keep enough tail for an error message.
      if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-32_000);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `OpenCode CLI not found at '${cfg.bin}'. Install it (https://opencode.ai) or set { bin } on opencodeCoder().`
          )
        );
      } else {
        reject(new Error(`spawn ${cfg.bin}: ${err.message}`));
      }
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ctx.abortSignal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      if (code !== 0) {
        const tail =
          tailErrors(stderrBuf) || stdoutTail.trim();
        reject(
          new Error(
            `opencode exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ''}`
          )
        );
        return;
      }
      // Clean exit: harvest this run's tool calls + token usage from the
      // finished session, then resolve. Enrichment failure is non-fatal — the
      // worktree mutation (the actual deliverable) already happened.
      enrichFromExport(cfg, sessionId, baseline, ctx).finally(() =>
        resolve({ sessionId })
      );
    });
  });
}

/** Extract the most useful error lines from opencode's key=value stderr log. */
function tailErrors(stderr: string): string {
  const errs = stderr
    .split('\n')
    .filter((l) => /level=(ERROR|WARN)/.test(l) || /\berror=/.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  if (errs.length > 0) return errs.slice(-3).join(' | ').slice(-500);
  return stderr.slice(-500).trim();
}

interface SessionUsage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_USAGE: SessionUsage = {
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Pre-turn snapshot of the session, used to attribute post-run usage to THIS
 * run alone. `opencode export` reports whole-session cumulative totals, so a
 * resumed/continued node would otherwise report the running session total
 * instead of its own slice. `'unknown'` means the baseline couldn't be read on
 * a resumed session — usage is then skipped rather than over-reported.
 */
interface Baseline {
  priorIds: Set<string>;
  priorUsage: SessionUsage;
}
type BaselineResult = Baseline | 'unknown';

const FRESH_BASELINE: Baseline = { priorIds: new Set(), priorUsage: ZERO_USAGE };

/** Snapshot a resumed session before its next turn; zero for a fresh one. */
async function captureBaseline(
  cfg: ResolvedConfig,
  priorSessionId: string | null,
  ctx: RunContext
): Promise<BaselineResult> {
  if (!priorSessionId) return FRESH_BASELINE;
  if (ctx.abortSignal.aborted) return 'unknown';
  const data = await runExport(
    cfg,
    priorSessionId,
    ctx,
    'opencode.export.baseline.json'
  );
  if (!data) {
    ctx.logger.warn(
      `[opencode] baseline export ${priorSessionId} unavailable — skipping this run's usage to avoid over-counting the resumed session`
    );
    return 'unknown';
  }
  return {
    priorIds: collectMessageIds(data),
    priorUsage: readSessionUsage(data),
  };
}

/**
 * Run `opencode export <sessionId>`, persist the raw output to the run's log
 * dir for postmortem, and return the parsed object (or null on any failure,
 * having logged a reason). Usage capture is the thing most likely to silently
 * break, so the raw export always lands on disk where it can be inspected —
 * the previous version swallowed failures to the server console only.
 */
function runExport(
  cfg: ResolvedConfig,
  sessionId: string,
  ctx: RunContext,
  dumpName: string
): Promise<ExportShape | null> {
  return new Promise<ExportShape | null>((resolve) => {
    execFile(
      cfg.bin,
      ['export', sessionId],
      { maxBuffer: 64 * 1024 * 1024, signal: ctx.abortSignal },
      (err, stdout) => {
        const raw = typeof stdout === 'string' ? stdout : '';
        writeRunLog(ctx, dumpName, raw);
        if (err) {
          ctx.logger.warn(`[opencode] export ${sessionId} failed: ${err.message}`);
          resolve(null);
          return;
        }
        // `opencode export` prefixes a human line before the JSON object;
        // start parsing at the first brace.
        const start = raw.indexOf('{');
        if (start < 0) {
          ctx.logger.warn(
            `[opencode] export ${sessionId}: no JSON object in output (raw → ${dumpName})`
          );
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw.slice(start)) as ExportShape);
        } catch (e) {
          ctx.logger.warn(
            `[opencode] export ${sessionId} parse failed: ${(e as Error).message} (raw → ${dumpName})`
          );
          resolve(null);
        }
      }
    );
  });
}

/**
 * Replay this run's tool calls and emit its usage as the delta over the
 * baseline. Best-effort: any failure is logged and swallowed so it never fails
 * an otherwise-successful coder run.
 */
async function enrichFromExport(
  cfg: ResolvedConfig,
  sessionId: string | null,
  baseline: BaselineResult,
  ctx: RunContext
): Promise<void> {
  if (!sessionId) return;
  const data = await runExport(cfg, sessionId, ctx, 'opencode.export.json');
  if (!data) return;
  if (baseline === 'unknown') {
    // Couldn't read the pre-turn baseline; emitting the cumulative session
    // total would over-report a resumed node, so skip usage and tool calls
    // (we can't tell which are new). The raw export is on disk if needed.
    return;
  }
  emitRunDelta(data, baseline, ctx);
}

interface ExportShape {
  info?: {
    /**
     * Billed cost in USD for the session, when opencode has visibility into
     * it (a paid provider configured with the user's own key). Free hosted
     * `opencode/*` models and local `ollama/*` report 0 — omitted from the
     * emit so those runs show "tokens only" rather than a noisy $0.00.
     */
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  messages?: Array<{
    /** `info.id` (e.g. `msg_…`) identifies each message; used to tell this
     * run's new turns from those already present at baseline. */
    info?: { id?: string };
    parts?: Array<Record<string, unknown>>;
  }>;
}

function emitRunDelta(
  data: ExportShape,
  baseline: Baseline,
  ctx: RunContext
): void {
  // Tool calls for messages that didn't exist at baseline — i.e. this run's,
  // in session order. (A message with no id is treated as new.)
  for (const msg of data.messages ?? []) {
    const id = msg.info?.id;
    if (id && baseline.priorIds.has(id)) continue;
    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool') continue;
      const tool = typeof part.tool === 'string' ? part.tool : 'tool';
      const preview = toolArgsPreview(part);
      ctx.emit({
        kind: 'tool_call',
        phase: 'coding',
        tool,
        ...(preview ? { argsPreview: preview.slice(0, 120) } : {}),
      });
    }
  }

  // Usage as this run's delta over the baseline cumulative. opencode reports
  // billed `cost` on the session info for paid providers (own key); free
  // hosted / local auth reports 0, which we drop so the run shows tokens-only.
  const total = readSessionUsage(data);
  const base = baseline.priorUsage;
  const input = Math.max(0, total.input - base.input);
  const output = Math.max(0, total.output - base.output);
  const cacheRead = Math.max(0, total.cacheRead - base.cacheRead);
  const cacheWrite = Math.max(0, total.cacheWrite - base.cacheWrite);
  const cost = Math.max(0, total.cost - base.cost);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;
  ctx.emit({
    kind: 'token_usage',
    phase: 'coding',
    inputTokens: input,
    outputTokens: output,
    ...(cacheWrite > 0 ? { cacheCreationTokens: cacheWrite } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cost > 0 ? { costUsd: cost } : {}),
  });
}

function collectMessageIds(data: ExportShape): Set<string> {
  const ids = new Set<string>();
  for (const msg of data.messages ?? []) {
    const id = msg.info?.id;
    if (id) ids.add(id);
  }
  return ids;
}

function readSessionUsage(data: ExportShape): SessionUsage {
  const t = data.info?.tokens;
  return {
    cost: typeof data.info?.cost === 'number' ? data.info.cost : 0,
    input: typeof t?.input === 'number' ? t.input : 0,
    output: typeof t?.output === 'number' ? t.output : 0,
    cacheRead: typeof t?.cache?.read === 'number' ? t.cache.read : 0,
    cacheWrite: typeof t?.cache?.write === 'number' ? t.cache.write : 0,
  };
}

/** Best-effort write of a raw artifact into the run's log dir. */
function writeRunLog(ctx: RunContext, name: string, content: string): void {
  try {
    fs.writeFileSync(path.join(ctx.logDir, name), content);
  } catch (e) {
    ctx.logger.warn(`[opencode] could not write ${name}: ${(e as Error).message}`);
  }
}

/** Best-effort one-line preview of a tool part's input. */
function toolArgsPreview(part: Record<string, unknown>): string | undefined {
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input ?? (part as Record<string, unknown>).input;
  if (input == null) return undefined;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

