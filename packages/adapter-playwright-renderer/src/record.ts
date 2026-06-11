import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import type {
  RenderInput,
  RenderResult,
  Renderer,
  RunContext,
} from '@vadimlobanov/gaido-core';

export interface PlaywrightRecordRendererOpts {
  /**
   * Build the URL path + query Playwright opens, given the run identity. The
   * returned string is appended to `baseUrl` (the dev server base, taken
   * from `ctx.previewServerBase` unless `baseUrl` below is set). Default:
   *   `/?scene=/runs/${runId}/scene.json`
   * — matches the convention where the orchestrator's artifactsDir is
   * exposed as `/runs/*` by the project's dev server.
   */
  urlPath?: (args: { runId: string; nodeId: string }) => string;
  /**
   * Override the preview server base URL. Default: `ctx.previewServerBase`
   * (set when `previewServer` is configured in gaido.config.ts). When neither
   * is available the renderer fails up front rather than guessing.
   */
  baseUrl?: string;
  /**
   * Options forwarded to `window.__recordMp4(...)` on the page. The page
   * decides how to encode; this adapter is encoding-agnostic.
   */
  recordOpts?: {
    fps?: number;
    bitrate?: number;
    fileName?: string;
  };
  /**
   * Cap on the recording call, in ms. Default 600_000 (10 min) — long
   * enough for slow scenes, short enough to surface deadlocks.
   */
  timeoutMs?: number;
  /**
   * Browser launch args (e.g. `--no-sandbox` for some Docker setups).
   * The renderer always launches headless.
   */
  launchArgs?: string[];
  /** Path to the ffmpeg binary used to extract the thumbnail. Default 'ffmpeg'. */
  ffmpegBin?: string;
  /** Path to the ffprobe binary used to read the video duration. Default 'ffprobe'. */
  ffprobeBin?: string;
}

interface ResolvedRecordConfig {
  urlPath: (args: { runId: string; nodeId: string }) => string;
  baseUrl?: string;
  recordOpts: { fps: number; bitrate: number; fileName: string };
  timeoutMs: number;
  launchArgs: string[];
  ffmpegBin: string;
  ffprobeBin: string;
}

/**
 * Renderer for projects whose own dev server (configured via
 * `previewServer` in gaido.config.ts) exposes:
 *   - `window.__ready: boolean` — set to true once the scene mounts
 *   - `window.__recordMp4(opts): Promise<unknown>` — encodes the scene to
 *     mp4 and triggers a browser download
 *
 * The adapter is contract-driven, not encoding-specific: the page can use
 * mediabunny / MediaRecorder / WebCodecs — whatever puts an mp4 in front of
 * the download event.
 */
export function playwrightRecordRenderer(
  opts: PlaywrightRecordRendererOpts = {}
): Renderer {
  const cfg: ResolvedRecordConfig = {
    urlPath:
      opts.urlPath ??
      (({ runId }) => `/?scene=/runs/${runId}/scene.json`),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    recordOpts: {
      fps: opts.recordOpts?.fps ?? 30,
      bitrate: opts.recordOpts?.bitrate ?? 5_000_000,
      fileName: opts.recordOpts?.fileName ?? 'video.mp4',
    },
    timeoutMs: opts.timeoutMs ?? 600_000,
    launchArgs: opts.launchArgs ?? [],
    ffmpegBin: opts.ffmpegBin ?? 'ffmpeg',
    ffprobeBin: opts.ffprobeBin ?? 'ffprobe',
  };
  return {
    kind: 'playwright-record',
    render: (input, ctx) => doRender(cfg, input, ctx),
  };
}

async function doRender(
  cfg: ResolvedRecordConfig,
  _input: RenderInput,
  ctx: RunContext
): Promise<RenderResult> {
  const startedAt = Date.now();
  const base = cfg.baseUrl ?? ctx.previewServerBase;
  if (!base) {
    throw new Error(
      'playwrightRecordRenderer: no preview server base URL — set `previewServer` in gaido.config.ts or pass `baseUrl` on the renderer.'
    );
  }
  const url =
    base.replace(/\/$/, '') +
    cfg.urlPath({ runId: ctx.runId, nodeId: ctx.nodeId });

  const pageLogFile = path.join(ctx.logDir, 'renderer.page.log');
  const ffmpegLogFile = path.join(ctx.logDir, 'renderer.ffmpeg.log');

  let browser: Browser | null = null;
  const onAbort = () => {
    ctx.logger.warn('[playwright-record] aborting');
    void browser?.close().catch(() => {});
  };
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    browser = await chromium.launch({
      headless: true,
      args: cfg.launchArgs,
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    page.on('pageerror', (err) => {
      appendSilent(pageLogFile, `[pageerror] ${err.message}\n`);
      ctx.logger.warn(`[playwright-record] page error: ${err.message}`);
    });
    page.on('console', (msg) => {
      appendSilent(pageLogFile, `[${msg.type()}] ${msg.text()}\n`);
      if (msg.type() === 'error') {
        ctx.logger.warn(`[playwright-record] console error: ${msg.text()}`);
      }
    });

    ctx.logger.info(`[playwright-record] opening ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

    // Wait for the page to signal ready. We accept `__ready === true`
    // or an explicit `__error` (so a failed mount surfaces here).
    // Using `globalThis` instead of `window` keeps this file compilable in
    // Node-only tsconfigs (some consumers compile our source directly).
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as {
          __ready?: boolean;
          __error?: string;
        };
        return w.__ready === true || !!w.__error;
      },
      { timeout: 30_000 }
    );
    const pageErr = await page.evaluate(
      () =>
        (globalThis as unknown as { __error?: string }).__error ?? null
    );
    if (pageErr) {
      throw new Error(`page bootstrap failed: ${pageErr}`);
    }

    if (ctx.abortSignal.aborted) throw makeAbortError();

    // Drive __recordMp4 and catch the download in parallel — the download
    // event fires the moment the page calls saveAs / a.click, which happens
    // inside __recordMp4. Promise.all keeps us from racing the events.
    const recordOpts = cfg.recordOpts;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: cfg.timeoutMs }),
      page.evaluate(
        async (o) =>
          (
            globalThis as unknown as {
              __recordMp4: (opts: typeof o) => Promise<unknown>;
            }
          ).__recordMp4(o),
        recordOpts
      ),
    ]);

    const videoPath = path.join(ctx.outputDir, recordOpts.fileName);
    await download.saveAs(videoPath);

    // Thumbnail: pull the middle frame out of the freshly-saved mp4 with
    // ffmpeg. Same pixels as the video, same resolution, same aspect — no
    // chance of a poster/player mismatch from a separately-captured screenshot.
    const thumbnailPath = path.join(ctx.outputDir, 'thumbnail.png');
    await extractMiddleFrame({
      videoPath,
      outPath: thumbnailPath,
      ffmpegBin: cfg.ffmpegBin,
      ffprobeBin: cfg.ffprobeBin,
      logFile: ffmpegLogFile,
    });

    return {
      videoPath,
      thumbnailPath,
      durationMs: Date.now() - startedAt,
      previewUrl: url,
    };
  } finally {
    ctx.abortSignal.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
  }
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function appendSilent(file: string, data: Buffer | string): void {
  try {
    fs.appendFileSync(file, data);
  } catch {
    // ignore
  }
}

async function extractMiddleFrame(args: {
  videoPath: string;
  outPath: string;
  ffmpegBin: string;
  ffprobeBin: string;
  logFile?: string;
}): Promise<void> {
  const durationSec = await probeDuration(
    args.ffprobeBin,
    args.videoPath,
    args.logFile
  );
  // Seek before -i for fast keyframe seek; mp4 keyframes are sparse but a
  // ~1s offset error on a thumbnail is invisible and cheaper than decode-seek.
  const middle = Math.max(0, durationSec / 2);
  await runFfmpeg(
    args.ffmpegBin,
    [
      '-y',
      '-ss',
      middle.toFixed(3),
      '-i',
      args.videoPath,
      '-frames:v',
      '1',
      '-update',
      '1',
      args.outPath,
    ],
    args.logFile
  );
}

function probeDuration(
  bin: string,
  videoPath: string,
  logFile?: string
): Promise<number> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    videoPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (logFile) appendSilent(logFile, b);
      stderr += b.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffprobe not found at '${bin}'. Install ffmpeg (it ships ffprobe) or set { ffprobeBin } on playwrightRecordRenderer().`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.slice(-800).trim();
        reject(new Error(`ffprobe exited ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }
      const dur = parseFloat(stdout.trim());
      if (!Number.isFinite(dur) || dur <= 0) {
        reject(new Error(`ffprobe returned non-numeric duration: ${stdout.trim()}`));
        return;
      }
      resolve(dur);
    });
  });
}

function runFfmpeg(
  bin: string,
  args: string[],
  logFile?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      if (logFile) appendSilent(logFile, b);
      stderr += b.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found at '${bin}'. Install ffmpeg or set { ffmpegBin } on playwrightRecordRenderer().`
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
        const tail = stderr.slice(-800).trim();
        reject(new Error(`ffmpeg exited ${code}${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}
