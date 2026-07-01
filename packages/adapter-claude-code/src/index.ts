import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Coder, CoderInput, CoderResult, RunContext } from '@vadimlobanov/gaido-core';

export { claudeCodeCritic, type ClaudeCodeCriticOpts } from './critic.js';

export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

export interface ClaudeCodeCoderOpts {
  /** Path to the claude executable. Default: 'claude' (resolved via PATH). */
  bin?: string;
  /** Model id. Default: 'claude-sonnet-4-6'. */
  model?: string;
  /**
   * Effort level for the session, passed through as `--effort <level>` (e.g.
   * 'low' | 'medium' | 'high' | 'max'). Typed loosely so new levels work
   * without an adapter bump; the CLI validates. Omitted flag when unset.
   */
  effort?: string;
  /**
   * Permission mode passed to claude. Default: 'bypassPermissions' — fits the
   * sandboxed worktree model where the agent owns its directory. Use
   * 'acceptEdits' to require approval for non-edit tools, or 'default' for
   * fully interactive (will hang in non-tty contexts).
   */
  permissionMode?: ClaudeCodePermissionMode;
  /**
   * Whether Claude Code's automatic memory is active for this coder. Default:
   * `false` — the adapter sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the spawn
   * so the user's global/project auto-memory doesn't leak into the creative
   * coding turn (or accrue new memory from it). Set `true` to let Claude Code
   * manage memory normally; the config wins over any ambient env flag.
   */
  autoMemory?: boolean;
  /** Extra CLI args appended to the spawn (after the standard flags). */
  extraArgs?: string[];
}

export function claudeCodeCoder(opts: ClaudeCodeCoderOpts = {}): Coder {
  const cfg = {
    bin: opts.bin ?? 'claude',
    model: opts.model ?? 'claude-sonnet-4-6',
    permissionMode: opts.permissionMode ?? 'bypassPermissions',
    effort: opts.effort,
    autoMemory: opts.autoMemory ?? false,
    extraArgs: opts.extraArgs ?? [],
  };

  return {
    kind: 'claude-code',
    run: (input, ctx) => runCoder(cfg, input, ctx),
  };
}

interface ResolvedConfig {
  bin: string;
  model: string;
  permissionMode: ClaudeCodePermissionMode;
  effort?: string;
  autoMemory: boolean;
  extraArgs: string[];
}

/**
 * Build the child env for a `claude` spawn, applying the auto-memory policy.
 * When `autoMemory` is false (the adapter default) we set
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` so Claude Code's automatic memory doesn't
 * bleed the user's global/project memory into the run — or accrue new memory
 * from it. When true we clear any ambient disable flag, so the adapter config,
 * not the surrounding shell, decides. Shared by the coder and the critic.
 */
export function claudeSpawnEnv(autoMemory: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (autoMemory) {
    delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  } else {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }
  return env;
}

async function runCoder(
  cfg: ResolvedConfig,
  input: CoderInput,
  ctx: RunContext
): Promise<CoderResult> {
  // `followUp` is the next message in a resumed session. When set, it
  // replaces `instruction` as the prompt — the orchestrator uses it after
  // a post-coder check failure. claude-code's --resume picks up the prior
  // session's context, so the original instruction is already in scope.
  const prompt = input.followUp ?? input.instruction;
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    cfg.model,
    '--permission-mode',
    cfg.permissionMode,
  ];
  if (cfg.effort) {
    args.push('--effort', cfg.effort);
  }
  if (input.priorSessionId) {
    args.push('--resume', input.priorSessionId);
  }
  args.push(...cfg.extraArgs);

  ctx.logger.info(
    `[claude-code] spawn ${cfg.bin} model=${cfg.model}${cfg.effort ? ` effort=${cfg.effort}` : ''} mem=${cfg.autoMemory ? 'on' : 'off'} resume=${input.priorSessionId ?? 'none'} ${input.followUp ? 'follow-up ' : ''}cwd=${ctx.workdir}`
  );

  return new Promise<CoderResult>((resolve, reject) => {
    const child = spawn(cfg.bin, args, {
      cwd: ctx.workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: claudeSpawnEnv(cfg.autoMemory),
    });

    let sessionId: string | null = input.priorSessionId ?? null;
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    // Claude Code emits multiple stream-json events per assistant message
    // (one per content block) and repeats the same `usage` block on each.
    // Track usage keyed by message id and sum across messages, so we don't
    // multiply-count a single turn.
    const usageByMessage = new Map<string, MessageUsage>();
    // Overrides the per-message sum once the final `result` event arrives —
    // its `usage` is the authoritative run total (matches what the API billed).
    let usageOverride: MessageUsage | null = null;
    // Authoritative billed cost from the final `result` event. Folded into
    // the closing `token_usage` emit so the orchestrator can persist it on
    // the run row.
    let costUsd: number | null = null;

    // Tee raw subprocess streams to disk so postmortems don't depend on
    // re-parsing the structured event log. Append-mode in case the run loop
    // re-spawns claude for a check retry — each spawn extends the same file.
    const stdoutLogPath = path.join(ctx.logDir, 'coder.stdout.log');
    const stderrLogPath = path.join(ctx.logDir, 'coder.stderr.log');
    const stdoutLog = fs.createWriteStream(stdoutLogPath, { flags: 'a' });
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: 'a' });
    stdoutLog.on('error', (err) =>
      ctx.logger.warn(`[claude-code] stdout log write failed: ${err.message}`)
    );
    stderrLog.on('error', (err) =>
      ctx.logger.warn(`[claude-code] stderr log write failed: ${err.message}`)
    );

    const onAbort = () => {
      if (settled) return;
      ctx.logger.warn('[claude-code] aborting subprocess');
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
          ctx.logger.warn(
            `[claude-code] non-JSON stdout line: ${line.slice(0, 120)}`
          );
          continue;
        }
        const captured = handleEvent(evt, ctx, usageByMessage, usageOverride, costUsd);
        if (captured.sessionId) sessionId = captured.sessionId;
        if (captured.usageOverride) usageOverride = captured.usageOverride;
        if (typeof captured.costUsd === 'number') costUsd = captured.costUsd;
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
              `Claude Code CLI not found at '${cfg.bin}'. Install it (https://claude.com/claude-code) or set { bin } on claudeCodeCoder().`
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
        const tail =
          stderrBuf.slice(-500).trim() || stdoutBuf.slice(-500).trim();
        reject(
          new Error(
            `claude exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ''}`
          )
        );
      });
    });
  });
}

interface HandleResult {
  sessionId?: string;
  usageOverride?: MessageUsage;
  costUsd?: number;
}

interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function handleEvent(
  evt: unknown,
  ctx: RunContext,
  usageByMessage: Map<string, MessageUsage>,
  usageOverride: MessageUsage | null,
  costUsd: number | null
): HandleResult {
  if (!evt || typeof evt !== 'object') return {};
  const obj = evt as Record<string, unknown>;
  const result: HandleResult = {};

  // session_id appears on system/init and result events; sometimes also on
  // intermediate frames.
  if (typeof obj.session_id === 'string') {
    result.sessionId = obj.session_id;
  }

  if (
    obj.type === 'assistant' &&
    obj.message &&
    typeof obj.message === 'object'
  ) {
    const message = obj.message as {
      id?: unknown;
      content?: unknown;
      usage?: unknown;
    };
    if (Array.isArray(message.content)) {
      for (const raw of message.content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          ctx.emit({ kind: 'agent_token', phase: 'coding', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          let preview: string | undefined;
          try {
            preview = JSON.stringify(block.input).slice(0, 120);
          } catch {
            preview = undefined;
          }
          ctx.emit({
            kind: 'tool_call',
            phase: 'coding',
            tool: block.name,
            ...(preview ? { argsPreview: preview } : {}),
          });
        }
      }
    }
    // One assistant turn can show up as multiple stream-json events (one per
    // content block) carrying the same `usage`. Keyed write avoids double
    // counting. Emit the running total after each update so the UI ticks up.
    const msgId = typeof message.id === 'string' ? message.id : null;
    const parsed = parseUsage(message.usage);
    if (msgId && parsed) {
      usageByMessage.set(msgId, parsed);
      emitUsage(ctx, sumUsage(usageByMessage, usageOverride), costUsd);
    }
  } else if (obj.type === 'result') {
    // Final result event carries the authoritative run total. Anchor on it so
    // the closing emit shows the exact billed numbers. `total_cost_usd` is
    // the dollars Anthropic billed; surface it on the closing emit so the
    // orchestrator can persist it on the run row.
    const parsed = parseUsage(obj.usage);
    const finalCost =
      typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
    if (finalCost !== null) {
      result.costUsd = finalCost;
    }
    if (parsed) {
      result.usageOverride = parsed;
      emitUsage(ctx, parsed, finalCost ?? costUsd);
    }
  }

  return result;
}

function parseUsage(raw: unknown): MessageUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const cacheCreation =
    typeof u.cache_creation_input_tokens === 'number'
      ? u.cache_creation_input_tokens
      : 0;
  const cacheRead =
    typeof u.cache_read_input_tokens === 'number'
      ? u.cache_read_input_tokens
      : 0;
  if (
    input === 0 &&
    output === 0 &&
    cacheCreation === 0 &&
    cacheRead === 0
  ) {
    return null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
  };
}

function sumUsage(
  byMessage: Map<string, MessageUsage>,
  override: MessageUsage | null
): MessageUsage {
  if (override) return override;
  const sum: MessageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  for (const u of byMessage.values()) {
    sum.inputTokens += u.inputTokens;
    sum.outputTokens += u.outputTokens;
    sum.cacheCreationTokens += u.cacheCreationTokens;
    sum.cacheReadTokens += u.cacheReadTokens;
  }
  return sum;
}

function emitUsage(
  ctx: RunContext,
  u: MessageUsage,
  costUsd: number | null
): void {
  ctx.emit({
    kind: 'token_usage',
    phase: 'coding',
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheCreationTokens > 0
      ? { cacheCreationTokens: u.cacheCreationTokens }
      : {}),
    ...(u.cacheReadTokens > 0
      ? { cacheReadTokens: u.cacheReadTokens }
      : {}),
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
  });
}
