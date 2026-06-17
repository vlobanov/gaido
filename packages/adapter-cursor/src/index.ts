import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Coder, CoderInput, CoderResult, RunContext } from '@vadimlobanov/gaido-core';

export interface CursorCoderOpts {
  /** Path to the cursor-agent executable. Default: 'cursor-agent' (resolved via PATH). */
  bin?: string;
  /**
   * Model id. Omitted by default so cursor-agent falls back to the model
   * configured for your account (`composer-2.5-fast` at time of writing).
   * Cursor encodes the reasoning/thinking level **in the model id** rather
   * than a separate flag — e.g. `gpt-5.3-codex-high`,
   * `claude-opus-4-8-thinking-high`, `auto` — so there is no `effort` option
   * here; pick the variant directly. Discover valid ids with
   * `cursor-agent models` (or `--list-models`); short aliases like `sonnet-4`
   * also work.
   */
  model?: string;
  /**
   * Auto-approve everything for headless edits. Default true — adds `--force`
   * (run tools/commands without per-action approval) **and** `--trust` (trust
   * the workspace folder without prompting; only valid with `--print`).
   * Together these are the bypassPermissions analog, and both are required for
   * a fresh Gaido worktree: without them cursor-agent waits on prompts that
   * never come in a non-tty subprocess. Set false to defer to cursor-agent's
   * own permission/trust handling.
   */
  force?: boolean;
  /**
   * Override cursor-agent's sandbox setting (`--sandbox enabled|disabled`).
   * Omitted by default so cursor-agent uses its configured policy. The agent
   * owns its worktree under Gaido, so `'disabled'` matches the other adapters'
   * full-access posture if your config sandboxes by default.
   */
  sandbox?: 'enabled' | 'disabled';
  /** Extra CLI args appended to the spawn (after the standard flags, before the prompt). */
  extraArgs?: string[];
}

export function cursorCoder(opts: CursorCoderOpts = {}): Coder {
  const cfg: ResolvedConfig = {
    bin: opts.bin ?? 'cursor-agent',
    model: opts.model,
    force: opts.force ?? true,
    sandbox: opts.sandbox,
    extraArgs: opts.extraArgs ?? [],
  };

  return {
    kind: 'cursor',
    run: (input, ctx) => runCoder(cfg, input, ctx),
  };
}

interface ResolvedConfig {
  bin: string;
  model?: string;
  force: boolean;
  sandbox?: 'enabled' | 'disabled';
  extraArgs: string[];
}

async function runCoder(
  cfg: ResolvedConfig,
  input: CoderInput,
  ctx: RunContext
): Promise<CoderResult> {
  // `followUp` is the next message in a resumed session — same contract as the
  // other coder adapters. `--resume <chatId>` picks up the prior session's
  // context, so the original instruction is already in scope.
  const prompt = input.followUp ?? input.instruction;

  // `-p` is a boolean (print/non-interactive); the prompt is a positional arg,
  // kept LAST so every flag parses first and a prompt beginning with '-' can't
  // be mistaken for one. `--workspace` pins the working dir explicitly (it
  // defaults to cwd, but being explicit matches the spawn cwd unambiguously).
  // We deliberately do NOT pass `-w/--worktree`: Gaido manages its own git
  // worktrees, and cursor's would create a second one under ~/.cursor.
  const args = ['-p', '--output-format', 'stream-json', '--workspace', ctx.workdir];
  if (cfg.model) {
    args.push('--model', cfg.model);
  }
  if (cfg.force) {
    args.push('--force', '--trust');
  }
  if (cfg.sandbox) {
    args.push('--sandbox', cfg.sandbox);
  }
  if (input.priorSessionId) {
    args.push('--resume', input.priorSessionId);
  }
  args.push(...cfg.extraArgs);
  args.push(prompt);

  ctx.logger.info(
    `[cursor] spawn ${cfg.bin} model=${cfg.model ?? 'default'} force=${cfg.force}${cfg.sandbox ? ` sandbox=${cfg.sandbox}` : ''} resume=${input.priorSessionId ?? 'none'} ${input.followUp ? 'follow-up ' : ''}cwd=${ctx.workdir}`
  );

  return new Promise<CoderResult>((resolve, reject) => {
    const child = spawn(cfg.bin, args, {
      cwd: ctx.workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // session_id (== resumable chatId) appears on every stream event; capture
    // it as it streams. On resume it's already known.
    let sessionId: string | null = input.priorSessionId ?? null;
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    // Dedupe tool_call emits: cursor sends a `started` then a `completed` event
    // per call (same call_id); we emit once, on `started`.
    const seenToolCalls = new Set<string>();
    // Message from a `result` with is_error / an `error` event — beats a raw
    // stderr tail in the rejection when cursor exits non-zero.
    let errorMessage: string | null = null;

    // Tee raw subprocess streams to disk so postmortems don't depend on
    // re-parsing the structured event log. Append-mode in case the run loop
    // re-spawns cursor-agent for a check retry — each spawn extends the file.
    const stdoutLogPath = path.join(ctx.logDir, 'coder.stdout.log');
    const stderrLogPath = path.join(ctx.logDir, 'coder.stderr.log');
    const stdoutLog = fs.createWriteStream(stdoutLogPath, { flags: 'a' });
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: 'a' });
    stdoutLog.on('error', (err) =>
      ctx.logger.warn(`[cursor] stdout log write failed: ${err.message}`)
    );
    stderrLog.on('error', (err) =>
      ctx.logger.warn(`[cursor] stderr log write failed: ${err.message}`)
    );

    const onAbort = () => {
      if (settled) return;
      ctx.logger.warn('[cursor] aborting subprocess');
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
          ctx.logger.warn(`[cursor] non-JSON stdout line: ${line.slice(0, 120)}`);
          continue;
        }
        const captured = handleEvent(evt, ctx, seenToolCalls);
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
              `Cursor CLI not found at '${cfg.bin}'. Install it (https://cursor.com/cli) or set { bin } on cursorCoder().`
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
            `cursor-agent exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ''}`
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

/**
 * cursor-agent `stream-json` JSONL stream (cursor-agent 2026.06):
 *   {"type":"system","subtype":"init","session_id":"<uuid>","model":...}
 *   {"type":"user","message":{role,content:[{type:"text",text}]},"session_id":...}
 *   {"type":"tool_call","subtype":"started"|"completed","call_id":"tool_…",
 *     "tool_call":{"<name>ToolCall":{"args":{…}},"toolCallId":"tool_…"},…}
 *   {"type":"assistant","message":{role,content:[{type:"text",text}]},"session_id":…}
 *   {"type":"result","subtype":"success","is_error":false,"result":"<final text>",
 *     "session_id":…,"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}
 * session_id is the chatId passed back to `--resume`. Token usage rides the
 * final `result` event only; there's no per-message usage and no cost
 * (subscription/login auth doesn't report billed dollars).
 */
function handleEvent(
  evt: unknown,
  ctx: RunContext,
  seenToolCalls: Set<string>
): HandleResult {
  if (!evt || typeof evt !== 'object') return {};
  const obj = evt as Record<string, unknown>;
  const result: HandleResult = {};

  // session_id rides every event; first sight is enough.
  if (typeof obj.session_id === 'string') {
    result.sessionId = obj.session_id;
  }

  switch (obj.type) {
    case 'assistant': {
      // Stream assistant text as it arrives. The `user` echo has the same
      // shape but a different `type`, so it's skipped here; the `result`
      // event's `result` field duplicates this text, so it's not re-emitted.
      const message = obj.message as { content?: unknown } | undefined;
      if (message && Array.isArray(message.content)) {
        for (const raw of message.content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as Record<string, unknown>;
          if (
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.length > 0
          ) {
            ctx.emit({ kind: 'agent_token', phase: 'coding', text: block.text });
          }
        }
      }
      break;
    }
    case 'tool_call': {
      // Emit once, on `started`; `completed` repeats the same call_id.
      if (obj.subtype !== 'started') break;
      const callId = typeof obj.call_id === 'string' ? obj.call_id : null;
      if (callId) {
        if (seenToolCalls.has(callId)) break;
        seenToolCalls.add(callId);
      }
      const extracted = extractToolCall(obj.tool_call);
      if (extracted) {
        ctx.emit({
          kind: 'tool_call',
          phase: 'coding',
          tool: extracted.tool,
          ...(extracted.preview
            ? { argsPreview: extracted.preview.slice(0, 120) }
            : {}),
        });
      }
      break;
    }
    case 'result': {
      const usage = parseUsage(obj.usage);
      if (usage) emitUsage(ctx, usage);
      // Exit code is the primary pass/fail signal (matches the sibling
      // adapters); this just enriches a non-zero rejection with the model's
      // own message.
      if (
        (obj.is_error === true || obj.subtype === 'error') &&
        typeof obj.result === 'string'
      ) {
        result.errorMessage = obj.result;
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

/**
 * cursor wraps each tool call as `{ "<name>ToolCall": { args, result }, … }`.
 * The tool name is the key ending in `ToolCall` (e.g. `editToolCall` → `edit`,
 * `readToolCall` → `read`, `shellToolCall` → `shell`); the args live under it.
 */
function extractToolCall(
  raw: unknown
): { tool: string; preview?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const tc = raw as Record<string, unknown>;
  const key = Object.keys(tc).find((k) => k.endsWith('ToolCall'));
  if (!key) return null;
  const tool = key.slice(0, -'ToolCall'.length) || key;
  const body = tc[key];
  let preview: string | undefined;
  if (body && typeof body === 'object') {
    preview = previewArgs((body as Record<string, unknown>).args);
  }
  return preview ? { tool, preview } : { tool };
}

/** Best-effort one-line preview of a tool call's args. */
function previewArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const field of ['path', 'command', 'query', 'pattern', 'globPattern']) {
    const v = a[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function parseUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  const cacheReadTokens =
    typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
  const cacheWriteTokens =
    typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0;
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0
  ) {
    return null;
  }
  // cursor reports non-cached input separately from cache reads (claude-code
  // semantics), so the buckets are kept distinct — no subtraction needed.
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function emitUsage(ctx: RunContext, u: Usage): void {
  ctx.emit({
    kind: 'token_usage',
    phase: 'coding',
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheWriteTokens > 0
      ? { cacheCreationTokens: u.cacheWriteTokens }
      : {}),
    ...(u.cacheReadTokens > 0 ? { cacheReadTokens: u.cacheReadTokens } : {}),
    // No costUsd: cursor-agent doesn't report billed cost (subscription auth).
  });
}
