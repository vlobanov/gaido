import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Coder, CoderInput, CoderResult, RunContext } from '@vadimlobanov/gaido-core';

export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export interface CodexCoderOpts {
  /** Path to the codex executable. Default: 'codex' (resolved via PATH). */
  bin?: string;
  /**
   * Model id (e.g. 'gpt-5.1-codex'). Omitted by default so codex falls back
   * to the model configured in ~/.codex/config.toml.
   */
  model?: string;
  /**
   * Reasoning effort, passed through as `-c model_reasoning_effort=<level>`
   * (e.g. 'minimal' | 'low' | 'medium' | 'high'). Typed loosely so new levels
   * work without an adapter bump; the CLI validates. Omitted when unset.
   */
  effort?: string;
  /**
   * Codex sandbox policy. Default: 'workspace-write' — fits the worktree
   * model where the agent owns its directory. 'danger-full-access' is the
   * analog of claude-code's bypassPermissions (also unblocks network access,
   * which workspace-write denies by default).
   */
  sandboxMode?: CodexSandboxMode;
  /** Extra CLI args appended to the spawn (after the standard flags). */
  extraArgs?: string[];
}

export function codexCoder(opts: CodexCoderOpts = {}): Coder {
  const cfg = {
    bin: opts.bin ?? 'codex',
    model: opts.model,
    effort: opts.effort,
    sandboxMode: opts.sandboxMode ?? 'workspace-write',
    extraArgs: opts.extraArgs ?? [],
  };

  return {
    kind: 'codex',
    run: (input, ctx) => runCoder(cfg, input, ctx),
  };
}

interface ResolvedConfig {
  bin: string;
  model?: string;
  effort?: string;
  sandboxMode: CodexSandboxMode;
  extraArgs: string[];
}

async function runCoder(
  cfg: ResolvedConfig,
  input: CoderInput,
  ctx: RunContext
): Promise<CoderResult> {
  // `followUp` is the next message in a resumed session — same contract as
  // the claude-code adapter. `codex exec resume <id>` picks up the prior
  // session's context, so the original instruction is already in scope.
  const prompt = input.followUp ?? input.instruction;

  // `codex exec resume` doesn't expose `-s/--sandbox`, so the sandbox policy
  // goes through the config-override flag on both forms for symmetry.
  const args = input.priorSessionId
    ? ['exec', 'resume', input.priorSessionId]
    : ['exec'];
  args.push(
    '--json',
    '--skip-git-repo-check',
    '-c',
    `sandbox_mode="${cfg.sandboxMode}"`
  );
  if (cfg.model) {
    args.push('--model', cfg.model);
  }
  if (cfg.effort) {
    args.push('-c', `model_reasoning_effort="${cfg.effort}"`);
  }
  args.push(...cfg.extraArgs);
  args.push(prompt);

  ctx.logger.info(
    `[codex] spawn ${cfg.bin} model=${cfg.model ?? 'default'}${cfg.effort ? ` effort=${cfg.effort}` : ''} sandbox=${cfg.sandboxMode} resume=${input.priorSessionId ?? 'none'} ${input.followUp ? 'follow-up ' : ''}cwd=${ctx.workdir}`
  );

  return new Promise<CoderResult>((resolve, reject) => {
    const child = spawn(cfg.bin, args, {
      cwd: ctx.workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sessionId: string | null = input.priorSessionId ?? null;
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    // Codex emits one `turn.completed` per turn with that turn's usage.
    // Accumulate across turns so the emitted totals are spawn-cumulative —
    // the orchestrator reads the last `token_usage` event as authoritative.
    const usageTotal: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    // `tool_call` is emitted on the first event mentioning an item (started
    // or completed, whichever arrives); the set keeps updates from
    // re-emitting the same call.
    const seenItems = new Set<string>();
    // Message from a `turn.failed` or `error` event — codex exits non-zero
    // afterwards, and this beats a raw stderr tail in the rejection.
    let errorMessage: string | null = null;

    // Tee raw subprocess streams to disk so postmortems don't depend on
    // re-parsing the structured event log. Append-mode in case the run loop
    // re-spawns codex for a check retry — each spawn extends the same file.
    const stdoutLogPath = path.join(ctx.logDir, 'coder.stdout.log');
    const stderrLogPath = path.join(ctx.logDir, 'coder.stderr.log');
    const stdoutLog = fs.createWriteStream(stdoutLogPath, { flags: 'a' });
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: 'a' });
    stdoutLog.on('error', (err) =>
      ctx.logger.warn(`[codex] stdout log write failed: ${err.message}`)
    );
    stderrLog.on('error', (err) =>
      ctx.logger.warn(`[codex] stderr log write failed: ${err.message}`)
    );

    const onAbort = () => {
      if (settled) return;
      ctx.logger.warn('[codex] aborting subprocess');
      child.kill('SIGTERM');
      // Backstop: SIGKILL if SIGTERM doesn't take effect.
      setTimeout(() => {
        if (!settled && !child.killed) child.kill('SIGKILL');
      }, 2000).unref();
    };
    if (ctx.abortSignal.aborted) {
      onAbort();
    } else {
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      ctx.abortSignal.removeEventListener('abort', onAbort);
      stdoutLog.end();
      stderrLog.end();
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLog.write(chunk);
      stdoutBuf += chunk.toString('utf8');
      // Process complete lines; leave any partial line in the buffer.
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(line);
        } catch {
          ctx.logger.warn(`[codex] non-JSON stdout line: ${line.slice(0, 120)}`);
          continue;
        }
        const captured = handleEvent(evt, ctx, usageTotal, seenItems);
        if (captured.sessionId) sessionId = captured.sessionId;
        if (captured.errorMessage) errorMessage = captured.errorMessage;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLog.write(chunk);
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `Codex CLI not found at '${cfg.bin}'. Install it (npm i -g @openai/codex) or set { bin } on codexCoder().`
            )
          );
        } else {
          reject(new Error(`spawn ${cfg.bin}: ${err.message}`));
        }
      });
    });

    child.on('close', (code, signal) => {
      settle(() => {
        if (ctx.abortSignal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        if (code === 0) {
          resolve({ sessionId });
          return;
        }
        const detail =
          errorMessage ??
          (stderrBuf.slice(-500).trim() || stdoutBuf.slice(-500).trim());
        reject(
          new Error(
            `codex exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ''}`
          )
        );
      });
    });
  });
}

interface HandleResult {
  sessionId?: string;
  errorMessage?: string;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Codex `--json` JSONL stream (experimental schema, codex-cli 0.125):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.updated"|"item.completed","item":{...}}
 *   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,...}}
 *   {"type":"turn.failed","error":{message}} / {"type":"error","message"}
 * Item types seen: agent_message, reasoning, command_execution, file_change,
 * mcp_tool_call, web_search, todo_list.
 */
function handleEvent(
  evt: unknown,
  ctx: RunContext,
  usageTotal: TurnUsage,
  seenItems: Set<string>
): HandleResult {
  if (!evt || typeof evt !== 'object') return {};
  const obj = evt as Record<string, unknown>;
  const result: HandleResult = {};

  switch (obj.type) {
    case 'thread.started': {
      if (typeof obj.thread_id === 'string') {
        result.sessionId = obj.thread_id;
      }
      break;
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      if (obj.item && typeof obj.item === 'object') {
        handleItem(
          obj.item as Record<string, unknown>,
          obj.type === 'item.completed',
          ctx,
          seenItems
        );
      }
      break;
    }
    case 'turn.completed': {
      const u = parseUsage(obj.usage);
      if (u) {
        usageTotal.inputTokens += u.inputTokens;
        usageTotal.outputTokens += u.outputTokens;
        usageTotal.cacheReadTokens += u.cacheReadTokens;
        ctx.emit({
          kind: 'token_usage',
          phase: 'coding',
          inputTokens: usageTotal.inputTokens,
          outputTokens: usageTotal.outputTokens,
          ...(usageTotal.cacheReadTokens > 0
            ? { cacheReadTokens: usageTotal.cacheReadTokens }
            : {}),
          // No costUsd: codex doesn't report billed cost (subscription auth).
        });
      }
      break;
    }
    case 'turn.failed': {
      const err = obj.error as Record<string, unknown> | undefined;
      if (err && typeof err.message === 'string') {
        result.errorMessage = err.message;
      }
      break;
    }
    case 'error': {
      if (typeof obj.message === 'string') {
        result.errorMessage = obj.message;
      }
      break;
    }
  }

  return result;
}

function handleItem(
  item: Record<string, unknown>,
  completed: boolean,
  ctx: RunContext,
  seenItems: Set<string>
): void {
  const id = typeof item.id === 'string' ? item.id : null;

  if (item.type === 'agent_message') {
    // Text arrives whole on item.completed (no token streaming in JSONL).
    if (completed && typeof item.text === 'string' && item.text.length > 0) {
      ctx.emit({ kind: 'agent_token', phase: 'coding', text: item.text });
    }
    return;
  }

  // Tool-ish items: emit one tool_call on first sight (item.started when the
  // stream sends it, otherwise item.completed).
  let tool: string | null = null;
  let preview: string | undefined;
  switch (item.type) {
    case 'command_execution':
      tool = 'shell';
      if (typeof item.command === 'string') preview = item.command;
      break;
    case 'file_change': {
      tool = 'apply_patch';
      if (Array.isArray(item.changes)) {
        preview = item.changes
          .map((c) => {
            if (!c || typeof c !== 'object') return null;
            const ch = c as Record<string, unknown>;
            return typeof ch.path === 'string' ? ch.path : null;
          })
          .filter(Boolean)
          .join(', ');
      }
      break;
    }
    case 'mcp_tool_call':
      tool =
        typeof item.tool === 'string'
          ? `${typeof item.server === 'string' ? `${item.server}.` : ''}${item.tool}`
          : 'mcp_tool_call';
      break;
    case 'web_search':
      tool = 'web_search';
      if (typeof item.query === 'string') preview = item.query;
      break;
    default:
      return; // reasoning, todo_list, …: not surfaced as events
  }

  const dedupeKey = id ?? `${tool}:${preview ?? ''}`;
  if (seenItems.has(dedupeKey)) return;
  seenItems.add(dedupeKey);
  ctx.emit({
    kind: 'tool_call',
    phase: 'coding',
    tool,
    ...(preview ? { argsPreview: preview.slice(0, 120) } : {}),
  });
}

function parseUsage(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const cached =
    typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0;
  if (input === 0 && output === 0 && cached === 0) return null;
  // Codex counts cached tokens inside input_tokens; the event payload keeps
  // them separate (claude-code semantics), so split them back out.
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheReadTokens: cached,
  };
}
