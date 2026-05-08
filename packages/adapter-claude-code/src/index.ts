import { spawn } from 'node:child_process';
import type { Coder, CoderInput, CoderResult, RunContext } from '@gaido/core';

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
   * Permission mode passed to claude. Default: 'bypassPermissions' — fits the
   * sandboxed worktree model where the agent owns its directory. Use
   * 'acceptEdits' to require approval for non-edit tools, or 'default' for
   * fully interactive (will hang in non-tty contexts).
   */
  permissionMode?: ClaudeCodePermissionMode;
  /** Extra CLI args appended to the spawn (after the standard flags). */
  extraArgs?: string[];
}

export function claudeCodeCoder(opts: ClaudeCodeCoderOpts = {}): Coder {
  const cfg = {
    bin: opts.bin ?? 'claude',
    model: opts.model ?? 'claude-sonnet-4-6',
    permissionMode: opts.permissionMode ?? 'bypassPermissions',
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
  extraArgs: string[];
}

async function runCoder(
  cfg: ResolvedConfig,
  input: CoderInput,
  ctx: RunContext
): Promise<CoderResult> {
  const args = [
    '-p',
    input.instruction,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    cfg.model,
    '--permission-mode',
    cfg.permissionMode,
  ];
  if (input.priorSessionId) {
    args.push('--resume', input.priorSessionId);
  }
  args.push(...cfg.extraArgs);

  ctx.logger.info(
    `[claude-code] spawn ${cfg.bin} model=${cfg.model} resume=${input.priorSessionId ?? 'none'} cwd=${ctx.workdir}`
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
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
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
        const captured = handleEvent(evt, ctx);
        if (captured.sessionId) sessionId = captured.sessionId;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
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
}

function handleEvent(evt: unknown, ctx: RunContext): HandleResult {
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
    const message = obj.message as { content?: unknown };
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
  }

  return result;
}
