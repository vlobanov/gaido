import fs from 'node:fs';
import path from 'node:path';
import type {
  Critic,
  CriticInput,
  CriticResult,
  Critique,
  RunContext,
} from '@vadimlobanov/gaido-core';

export interface GeminiCriticOpts {
  /**
   * OpenRouter API key. Falls back to process.env.OPENROUTER_API_KEY at
   * call time. Throws at run-time if neither is set.
   */
  apiKey?: string;
  /** Model id. Default: 'google/gemini-2.5-flash'. */
  model?: string;
  /**
   * Force routing to a specific provider. Default: ['google-vertex'] —
   * required for inline base64 video, since Google AI Studio rejects
   * non-YouTube video inputs. Pass null/[] to allow OpenRouter to pick.
   */
  providerOrder?: string[] | null;
  /** Allow OpenRouter to fall back outside the providerOrder. Default false. */
  allowFallbacks?: boolean;
  /** Optional `HTTP-Referer` header — OpenRouter uses it for attribution. */
  httpReferer?: string;
  /** Optional `X-Title` header — OpenRouter uses it for attribution. */
  appTitle?: string;
  /** Request timeout in ms. Default 180_000 (3 min). */
  timeoutMs?: number;
  /**
   * Detail Gemini ingests the video at. Gemini samples video at ~1 fps; this
   * sets the per-frame resolution. Default 'high'. Both 'low' and 'medium' bill
   * video at ~64 tokens/frame — too coarse for the model to resolve PBR,
   * specular, texture, or fine geometry, so it falls back to generic
   * "flat / low-poly / untextured" critiques that contradict the actual render.
   * 'high' is ~256 tokens/frame (≈4× the visual detail). Pass null to omit the
   * param and take the provider default (currently low).
   */
  mediaResolution?: 'low' | 'medium' | 'high' | null;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Gemini's media-resolution enum. The OpenRouter param is the raw Gemini value
// (top-level `media_resolution`), not a friendly 'low'/'high' string — those
// 400. Verified against google-vertex: LOW and MEDIUM both bill a 5s 1024²
// clip at 320 video tokens; HIGH bills 1280 (4× per-frame detail).
const MEDIA_RESOLUTION_ENUM: Record<'low' | 'medium' | 'high', string> = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
};

export function geminiCritic(opts: GeminiCriticOpts = {}): Critic {
  const cfg: ResolvedCfg = {
    apiKey: opts.apiKey ?? null,
    model: opts.model ?? 'google/gemini-2.5-flash',
    providerOrder:
      opts.providerOrder === null
        ? null
        : opts.providerOrder ?? ['google-vertex'],
    allowFallbacks: opts.allowFallbacks ?? false,
    httpReferer: opts.httpReferer ?? 'https://github.com/anthropics/gaido',
    appTitle: opts.appTitle ?? 'Gaido',
    timeoutMs: opts.timeoutMs ?? 180_000,
    mediaResolution:
      opts.mediaResolution === null ? null : opts.mediaResolution ?? 'high',
  };
  return {
    kind: 'gemini-openrouter',
    model: cfg.model,
    critique: (input, ctx) => critiqueWithGemini(cfg, input, ctx),
  };
}

interface ResolvedCfg {
  apiKey: string | null;
  model: string;
  providerOrder: string[] | null;
  allowFallbacks: boolean;
  httpReferer: string;
  appTitle: string;
  timeoutMs: number;
  mediaResolution: 'low' | 'medium' | 'high' | null;
}

async function critiqueWithGemini(
  cfg: ResolvedCfg,
  input: CriticInput,
  ctx: RunContext
): Promise<CriticResult> {
  const apiKey = cfg.apiKey ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Add it to <projectDir>/.env or ~/.gaido/.env, or pass { apiKey } to geminiCritic().'
    );
  }
  if (!fs.existsSync(input.videoPath)) {
    throw new Error(`geminiCritic: video not found at ${input.videoPath}`);
  }

  const videoBytes = fs.readFileSync(input.videoPath);
  const mime = mimeFromPath(input.videoPath);
  const dataUrl = `data:${mime};base64,${videoBytes.toString('base64')}`;
  ctx.logger.info(
    `[gemini-critic] sending ${(videoBytes.length / 1024).toFixed(1)} KiB to ${cfg.model}`
  );

  const logFile = path.join(ctx.logDir, 'critic.openrouter.log');
  // Snapshot the request shape for postmortem inspection. The video data URL
  // is redacted (would be MBs of base64) — its byte size goes in instead.
  appendSilent(
    logFile,
    formatLogBlock('REQUEST', {
      url: OPENROUTER_URL,
      model: cfg.model,
      providerOrder: cfg.providerOrder,
      allowFallbacks: cfg.allowFallbacks,
      promptLen: input.prompt.length,
      videoBytes: videoBytes.length,
      videoMime: mime,
      mediaResolution: cfg.mediaResolution,
    })
  );

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(input.prompt) },
          { type: 'video_url', video_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };
  if (cfg.mediaResolution) {
    body.media_resolution = MEDIA_RESOLUTION_ENUM[cfg.mediaResolution];
  }
  if (cfg.providerOrder && cfg.providerOrder.length > 0) {
    body.provider = {
      order: cfg.providerOrder,
      allow_fallbacks: cfg.allowFallbacks,
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  const onUserAbort = () => ac.abort();
  ctx.abortSignal.addEventListener('abort', onUserAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': cfg.httpReferer,
        'X-Title': cfg.appTitle,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (ctx.abortSignal.aborted) throw makeAbortError();
    if ((err as Error).name === 'AbortError') {
      throw new Error(
        `OpenRouter request timed out after ${cfg.timeoutMs}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onUserAbort);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    appendSilent(
      logFile,
      formatLogBlock('ERROR', { status: res.status, statusText: res.statusText, body: text })
    );
    throw new Error(
      `OpenRouter responded ${res.status} ${res.statusText}: ${text.slice(0, 600)}`
    );
  }

  // Read raw text so the log captures it verbatim, then JSON.parse separately
  // (response.json() would consume the stream and lose the raw form).
  const rawText = await res.text();
  appendSilent(
    logFile,
    formatLogBlock('RESPONSE', { status: res.status, body: rawText })
  );
  const json = JSON.parse(rawText) as OpenRouterResponse;
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      `OpenRouter response had no string content: ${JSON.stringify(json).slice(0, 400)}`
    );
  }

  ctx.emit({ kind: 'agent_token', phase: 'critiquing', text: content });

  // Emit token_usage so the orchestrator's setRunStatus rollup can persist
  // critic tokens on the run row alongside coder tokens — same path either
  // adapter takes.
  if (
    typeof json.usage?.prompt_tokens === 'number' ||
    typeof json.usage?.completion_tokens === 'number'
  ) {
    ctx.emit({
      kind: 'token_usage',
      phase: 'critiquing',
      inputTokens: json.usage.prompt_tokens ?? 0,
      outputTokens: json.usage.completion_tokens ?? 0,
    });
  }

  const critique = parseCritiqueOrThrow(content);
  return {
    critique,
    ...(typeof json.usage?.prompt_tokens === 'number'
      ? { tokensIn: json.usage.prompt_tokens }
      : {}),
    ...(typeof json.usage?.completion_tokens === 'number'
      ? { tokensOut: json.usage.completion_tokens }
      : {}),
  };
}

function buildPrompt(originalInstruction: string): string {
  return [
    `You are a senior visual artist reviewing a generated animation video.`,
    ``,
    `Original creative instruction:`,
    `"${originalInstruction.trim()}"`,
    ``,
    `Watch the attached video and evaluate the result holistically: composition, motion, color, how well it satisfies the instruction.`,
    ``,
    `Respond with ONE JSON object, no prose, no markdown fences. Schema:`,
    `{`,
    `  "overall": "1-2 sentence summary",`,
    `  "rating": 1-5,`,
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

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function parseCritiqueOrThrow(text: string): Critique {
  const json = extractFirstJsonObject(text);
  if (!json) {
    throw new Error(
      `gemini-critic: no JSON object in output (first 200 chars: ${text.slice(0, 200)})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `gemini-critic: JSON.parse failed: ${(err as Error).message} — input: ${json.slice(0, 200)}`
    );
  }
  return coerceCritique(parsed);
}

function extractFirstJsonObject(text: string): string | null {
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

function coerceCritique(raw: unknown): Critique {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gemini-critic: response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const overall = typeof obj.overall === 'string' ? obj.overall : '';
  if (!overall) {
    throw new Error('gemini-critic: missing "overall" string');
  }
  const ratingNum = typeof obj.rating === 'number' ? obj.rating : undefined;
  const rating =
    ratingNum !== undefined
      ? Math.max(1, Math.min(5, Math.round(ratingNum)))
      : undefined;
  const strengths = toStringArray(obj.strengths);
  const weaknesses = toStringArray(obj.weaknesses);
  const suggestions = toStringArray(obj.suggestions);
  return {
    overall,
    ...(rating !== undefined ? { rating } : {}),
    strengths,
    weaknesses,
    suggestions,
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function mimeFromPath(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mpeg':
    case '.mpg':
      return 'video/mpeg';
    default:
      return 'video/mp4';
  }
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function appendSilent(file: string, data: string): void {
  try {
    fs.appendFileSync(file, data);
  } catch {
    // ignore — events table is the structured source of truth
  }
}

function formatLogBlock(label: string, payload: unknown): string {
  const ts = new Date().toISOString();
  return `--- ${label} ${ts} ---\n${JSON.stringify(payload, null, 2)}\n\n`;
}
