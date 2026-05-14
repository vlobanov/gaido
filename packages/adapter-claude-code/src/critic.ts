import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Critic,
  CriticInput,
  CriticResult,
  Critique,
  RunContext,
} from '@gaido/core';
import type { ClaudeCodePermissionMode } from './index.js';

export interface ClaudeCodeCriticOpts {
  /** Path to the claude executable. Default: 'claude' (resolved via PATH). */
  bin?: string;
  /** Path to the ffmpeg executable. Default: 'ffmpeg' (resolved via PATH). */
  ffmpegBin?: string;
  /** Model id. Default: 'claude-sonnet-4-6'. */
  model?: string;
  /**
   * Permission mode. Default: 'bypassPermissions'. The critic only needs Read,
   * but bypass keeps things simple in a sandboxed temp dir.
   */
  permissionMode?: ClaudeCodePermissionMode;
  /** Number of evenly-spaced frames to extract from the video. Default 6. */
  frameCount?: number;
  /** Extra CLI args appended after the standard flags. */
  extraArgs?: string[];
}

export function claudeCodeCritic(opts: ClaudeCodeCriticOpts = {}): Critic {
  const cfg: ResolvedCfg = {
    bin: opts.bin ?? 'claude',
    ffmpegBin: opts.ffmpegBin ?? 'ffmpeg',
    model: opts.model ?? 'claude-sonnet-4-6',
    permissionMode: opts.permissionMode ?? 'bypassPermissions',
    frameCount: Math.max(1, Math.min(20, opts.frameCount ?? 6)),
    extraArgs: opts.extraArgs ?? [],
  };
  return {
    kind: 'claude-code',
    critique: (input, ctx) => critiqueWithClaudeCode(cfg, input, ctx),
  };
}

interface ResolvedCfg {
  bin: string;
  ffmpegBin: string;
  model: string;
  permissionMode: ClaudeCodePermissionMode;
  frameCount: number;
  extraArgs: string[];
}

async function critiqueWithClaudeCode(
  cfg: ResolvedCfg,
  input: CriticInput,
  ctx: RunContext
): Promise<CriticResult> {
  // Stage frames into a temp dir under the run's outputDir so they get
  // cleaned up alongside other run artifacts on delete.
  const stageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `gaido-critic-${ctx.runId}-`)
  );
  try {
    const frames = await extractFrames({
      ffmpegBin: cfg.ffmpegBin,
      videoPath: input.videoPath,
      outDir: stageDir,
      frameCount: cfg.frameCount,
      logger: ctx.logger,
      abortSignal: ctx.abortSignal,
      logFile: path.join(ctx.logDir, 'critic.ffmpeg.log'),
    });
    if (ctx.abortSignal.aborted) throw makeAbortError();

    ctx.logger.info(
      `[claude-critic] extracted ${frames.length} frame(s) → ${stageDir}`
    );

    const prompt = buildPrompt(input.prompt, frames);
    const text = await runClaude(cfg, prompt, stageDir, ctx);
    if (ctx.abortSignal.aborted) throw makeAbortError();

    const critique = parseCritiqueOrThrow(text);
    return { critique };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function buildPrompt(originalInstruction: string, frames: string[]): string {
  const list = frames.map((f, i) => `  ${i + 1}. ${path.basename(f)}`).join('\n');
  return [
    `You are a senior visual artist reviewing a generated animation.`,
    ``,
    `Original creative instruction:`,
    `"${originalInstruction.trim()}"`,
    ``,
    `Use the Read tool to look at each of these keyframes from the rendered video, in order:`,
    list,
    ``,
    `Then evaluate the result holistically: composition, motion, color, how well it satisfies the instruction.`,
    ``,
    `OUTPUT FORMAT — your final assistant message MUST be exactly one JSON object, no prose, no markdown fences. Schema:`,
    `{`,
    `  "overall": "1-2 sentence summary",`,
    `  "rating": 1..5,`,
    `  "strengths": ["...", "..."],`,
    `  "weaknesses": ["...", "..."],`,
    `  "suggestions": ["...", "..."],`,
    `  "proposedRules": ["...", "..."]`,
    `}`,
    ``,
    `proposedRules: short, generic rules that should apply to EVERY future render in this project — not to this one specifically. Examples of the right shape: "Never let animations pause for more than 200ms", "Avoid pure white backgrounds". Examples of the wrong shape (too specific): "The blue square should be slower". Omit the field or use an empty array if nothing generic applies.`,
    ``,
    `Be concrete and specific to what you see. No filler.`,
  ].join('\n');
}

function runClaude(
  cfg: ResolvedCfg,
  prompt: string,
  cwd: string,
  ctx: RunContext
): Promise<string> {
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
    ...cfg.extraArgs,
  ];

  ctx.logger.info(
    `[claude-critic] spawn ${cfg.bin} model=${cfg.model} cwd=${cwd}`
  );

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cfg.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let finalText = '';
    let settled = false;

    // Tee raw subprocess streams to the per-run log dir so the same
    // postmortem surface exists for critic runs as for coder runs.
    const stdoutLog = fs.createWriteStream(
      path.join(ctx.logDir, 'critic.stdout.log'),
      { flags: 'a' }
    );
    const stderrLog = fs.createWriteStream(
      path.join(ctx.logDir, 'critic.stderr.log'),
      { flags: 'a' }
    );
    stdoutLog.on('error', (err) =>
      ctx.logger.warn(`[claude-critic] stdout log: ${err.message}`)
    );
    stderrLog.on('error', (err) =>
      ctx.logger.warn(`[claude-critic] stderr log: ${err.message}`)
    );

    const onAbort = () => {
      if (settled) return;
      ctx.logger.warn('[claude-critic] aborting subprocess');
      child.kill('SIGTERM');
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
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        const captured = handleCritEvent(evt, ctx);
        if (captured.finalText) finalText = captured.finalText;
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
              `Claude Code CLI not found at '${cfg.bin}'. Install it (https://claude.com/claude-code) or set { bin } on claudeCodeCritic().`
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
          reject(makeAbortError());
          return;
        }
        if (code === 0) {
          resolve(finalText);
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

interface HandleCritResult {
  finalText?: string;
}

function handleCritEvent(evt: unknown, ctx: RunContext): HandleCritResult {
  if (!evt || typeof evt !== 'object') return {};
  const obj = evt as Record<string, unknown>;
  const out: HandleCritResult = {};

  // The terminal `result` event carries the final assistant text.
  if (obj.type === 'result' && typeof obj.result === 'string') {
    out.finalText = obj.result;
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
          ctx.emit({
            kind: 'agent_token',
            phase: 'critiquing',
            text: block.text,
          });
          // Fallback: if no `result` event arrives (older CLI versions),
          // last assistant text wins.
          if (!out.finalText) out.finalText = block.text;
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          ctx.emit({
            kind: 'tool_call',
            phase: 'critiquing',
            tool: block.name,
          });
        }
      }
    }
  }

  return out;
}

interface ExtractOpts {
  ffmpegBin: string;
  videoPath: string;
  outDir: string;
  frameCount: number;
  logger: RunContext['logger'];
  abortSignal: AbortSignal;
  /** If set, ffmpeg stderr from probe + extract is appended here. */
  logFile?: string;
}

async function extractFrames(opts: ExtractOpts): Promise<string[]> {
  // Use ffmpeg's select filter to grab N evenly spaced frames. We compute
  // explicit timestamps via ffprobe-less arithmetic: ask ffmpeg for the
  // duration first by running -show_format isn't necessary — instead use
  // the `select` filter with `n_frames=N` via `select='not(mod(n,floor(N_frames/N)))'`.
  // Simpler approach: use the `fps=` filter to sample, capped to frameCount.
  //
  // Easiest path: probe duration with ffprobe-style `-stats`, then for each
  // i in [0..N-1] do a single -ss <t> -i video -frames:v 1 capture. N small
  // (default 6) so this is fast and gives us deterministic timestamps.
  const duration = await probeDuration(
    opts.ffmpegBin,
    opts.videoPath,
    opts.logFile
  );
  const targetCount = opts.frameCount;
  const padWidth = String(targetCount).length;
  const frames: string[] = [];

  for (let i = 0; i < targetCount; i++) {
    if (opts.abortSignal.aborted) throw makeAbortError();
    // Sample at fractions 1/(N+1), 2/(N+1), ... so we avoid the very first
    // and last frames (which may be black on cold-start animations).
    const t = ((i + 1) * duration) / (targetCount + 1);
    const out = path.join(
      opts.outDir,
      `frame-${String(i + 1).padStart(padWidth, '0')}.png`
    );
    await runFfmpeg(
      opts.ffmpegBin,
      [
        '-y',
        '-ss',
        t.toFixed(3),
        '-i',
        opts.videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        out,
      ],
      opts.logger,
      opts.logFile
    );
    frames.push(out);
  }
  return frames;
}

function probeDuration(
  ffmpegBin: string,
  videoPath: string,
  logFile?: string
): Promise<number> {
  // Avoids a separate ffprobe dep. Run ffmpeg with -i and parse "Duration:"
  // from stderr. Robust enough for our renderer's outputs.
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ['-i', videoPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let buf = '';
    child.stderr.on('data', (c: Buffer) => {
      if (logFile) appendSilent(logFile, c);
      buf += c.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found at '${ffmpegBin}'. Install ffmpeg or set { ffmpegBin } on claudeCodeCritic().`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on('close', () => {
      // ffmpeg with no output target exits non-zero, but the Duration line is
      // already on stderr. Match e.g. "Duration: 00:00:05.00,".
      const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) {
        reject(new Error(`ffmpeg: could not parse duration from probe output`));
        return;
      }
      const h = Number(m[1]);
      const mi = Number(m[2]);
      const s = Number(m[3]);
      resolve(h * 3600 + mi * 60 + s);
    });
  });
}

function runFfmpeg(
  bin: string,
  args: string[],
  logger: RunContext['logger'],
  logFile?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      if (logFile) appendSilent(logFile, c);
      stderr += c.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found at '${bin}'. Install ffmpeg or set { ffmpegBin } on claudeCodeCritic().`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        logger.warn(`[claude-critic] ffmpeg exited ${code}`);
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300).trim()}`));
      }
    });
  });
}

function parseCritiqueOrThrow(text: string): Critique {
  if (!text || !text.trim()) {
    throw new Error('claude critic returned no text');
  }
  // Find the first { ... } block. The model may wrap with prose/fences
  // despite the prompt, so we extract the largest balanced JSON object.
  const json = extractFirstJsonObject(text);
  if (!json) {
    throw new Error(
      `claude critic: no JSON object in output (first 200 chars: ${text.slice(0, 200)})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `claude critic: JSON.parse failed: ${(err as Error).message} — input: ${json.slice(0, 200)}`
    );
  }
  return coerceCritique(parsed);
}

function extractFirstJsonObject(text: string): string | null {
  // Strip code fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  if (!candidate) return null;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

export function coerceCritique(raw: unknown): Critique {
  if (!raw || typeof raw !== 'object') {
    throw new Error('critic: response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const overall = typeof obj.overall === 'string' ? obj.overall : '';
  if (!overall) {
    throw new Error('critic: missing "overall" string');
  }
  const ratingNum = typeof obj.rating === 'number' ? obj.rating : undefined;
  const rating =
    ratingNum !== undefined
      ? Math.max(1, Math.min(5, Math.round(ratingNum)))
      : undefined;
  const strengths = toStringArray(obj.strengths);
  const weaknesses = toStringArray(obj.weaknesses);
  const suggestions = toStringArray(obj.suggestions);
  const proposedRules = toStringArray(obj.proposedRules);
  return {
    overall,
    ...(rating !== undefined ? { rating } : {}),
    strengths,
    weaknesses,
    suggestions,
    ...(proposedRules.length > 0 ? { proposedRules } : {}),
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Best-effort sync append. Swallows errors so a misbehaving disk doesn't
 * crash the run — the structured event log in SQLite is the primary record.
 */
function appendSilent(file: string, data: Buffer | string): void {
  try {
    fs.appendFileSync(file, data);
  } catch {
    // ignore
  }
}
