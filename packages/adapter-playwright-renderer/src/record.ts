import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type {
  RenderInput,
  RenderResult,
  Renderer,
  RunContext,
} from '@gaido/core';

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
}

interface ResolvedRecordConfig {
  urlPath: (args: { runId: string; nodeId: string }) => string;
  baseUrl?: string;
  recordOpts: { fps: number; bitrate: number; fileName: string };
  timeoutMs: number;
  launchArgs: string[];
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
      ctx.logger.warn(`[playwright-record] page error: ${err.message}`);
    });
    page.on('console', (msg) => {
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

    // Thumbnail: the page just finished recording, so the player is
    // typically parked on the last frame. A screenshot at this point gives a
    // reasonable poster. If projects want a specific frame, they can scrub
    // before recording in their __recordMp4 implementation.
    const thumbnailPath = path.join(ctx.outputDir, 'thumbnail.png');
    await page.screenshot({ path: thumbnailPath, type: 'png' });

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
