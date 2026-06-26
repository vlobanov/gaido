import http from 'node:http';
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

export {
  playwrightRecordRenderer,
  type PlaywrightRecordRendererOpts,
} from './record.js';

export interface PlaywrightRendererOpts {
  /** Path to the ffmpeg binary. Default: 'ffmpeg' (resolved via PATH). */
  ffmpegBin?: string;
  /**
   * Page-side wait grace before frame capture begins, in real ms. Used to
   * let the page initialize (load PIXI, fetch assets, etc.). Default 1000.
   */
  warmupMs?: number;
  /**
   * Browser launch args. Default empty. The renderer always launches
   * headless.
   */
  launchArgs?: string[];
  /**
   * What the camera does across the configured duration.
   *
   * - 'viewport' (default): fixed viewport — for animations that move on
   *   their own under the fake clock.
   * - 'scroll': the page is taller than the viewport and the camera pans
   *   down it — for documents/websites. Holds on the top of the page, eases
   *   down to the bottom, holds there. The fake clock still advances every
   *   frame, so CSS animations and rAF-driven touches keep moving during
   *   the pan. Thumbnail becomes the FIRST frame (the hero), not the middle.
   */
  capture?: 'viewport' | 'scroll';
  /**
   * Scroll-mode pacing. `holdStart`/`holdEnd` are fractions of the total
   * frame count spent parked on the hero/footer (defaults 0.15 each, 70%
   * travel between). `maxPxPerSecond` caps the average travel speed: when a
   * page is tall enough that the configured duration would scroll faster,
   * the render extends past `render.duration` until the cap holds (up to 4×
   * duration) — a 9000px page shouldn't blur past in seven seconds.
   * Default 600. Ignored in 'viewport' mode.
   */
  scroll?: {
    holdStart?: number;
    holdEnd?: number;
    maxPxPerSecond?: number;
  };
}

export function playwrightRenderer(
  opts: PlaywrightRendererOpts = {}
): Renderer {
  const cfg: ResolvedConfig = {
    ffmpegBin: opts.ffmpegBin ?? 'ffmpeg',
    warmupMs: opts.warmupMs ?? 1000,
    launchArgs: opts.launchArgs ?? [],
    capture: opts.capture ?? 'viewport',
    scroll: {
      holdStart: opts.scroll?.holdStart ?? 0.15,
      holdEnd: opts.scroll?.holdEnd ?? 0.15,
      maxPxPerSecond: opts.scroll?.maxPxPerSecond ?? 600,
    },
  };
  return {
    kind: 'playwright',
    render: (input, ctx) => doRender(cfg, input, ctx),
  };
}

interface ResolvedConfig {
  ffmpegBin: string;
  warmupMs: number;
  launchArgs: string[];
  capture: 'viewport' | 'scroll';
  scroll: { holdStart: number; holdEnd: number; maxPxPerSecond: number };
}

async function doRender(
  cfg: ResolvedConfig,
  input: RenderInput,
  ctx: RunContext
): Promise<RenderResult> {
  const startedAt = Date.now();
  fs.mkdirSync(ctx.outputDir, { recursive: true });
  const framesDir = path.join(ctx.outputDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  let totalFrames = Math.max(1, Math.round(input.duration * input.fps));
  const stepMs = 1000 / input.fps;
  const videoPath = path.join(ctx.outputDir, 'video.mp4');
  const thumbnailPath = path.join(ctx.outputDir, 'thumbnail.png');

  // Per-run technical log surface for the rendering phase. Captures
  // everything the orchestrator can't see structurally: page console
  // chatter, page errors, ffmpeg stderr.
  const pageLogFile = path.join(ctx.logDir, 'renderer.page.log');
  const ffmpegLogFile = path.join(ctx.logDir, 'renderer.ffmpeg.log');

  const server = await startStaticServer(ctx.workdir);
  ctx.logger.info(
    `[playwright] serving ${ctx.workdir} at http://127.0.0.1:${server.port}/`
  );

  let browser: Browser | null = null;
  const onAbort = () => {
    ctx.logger.warn('[playwright] aborting');
    void browser?.close().catch(() => {});
  };
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    browser = await chromium.launch({
      headless: true,
      args: cfg.launchArgs,
    });
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // Surface page console errors as render-progress log breadcrumbs would
    // be too noisy; let the orchestrator capture only failures.
    page.on('pageerror', (err) => {
      appendSilent(pageLogFile, `[pageerror] ${err.message}\n`);
      ctx.logger.warn(`[playwright] page error: ${err.message}`);
    });
    // Capture every console line to disk — useful when a scene boots fine
    // but renders empty or glitchy: the only hint is often a console.warn.
    page.on('console', (msg) => {
      appendSilent(pageLogFile, `[${msg.type()}] ${msg.text()}\n`);
    });

    // Install AND pause the fake clock before navigation. install() alone
    // fakes Date / performance.now / rAF but lets them keep advancing with
    // REAL wall-clock time — so every real second spent in page.screenshot()
    // (slow for WebGL scenes: "GPU stall due to ReadPixels") leaks into the
    // page's performance.now(). An animation reading it then lurches forward
    // far more than stepMs per frame (a 5s render measured ~37s of page time).
    // pauseAt() freezes time so it advances ONLY by our explicit
    // fastForward()/runFor() calls — the whole point of deterministic capture.
    await page.clock.install({ time: new Date(0) });
    await page.clock.pauseAt(new Date(0));

    const indexUrl = `http://127.0.0.1:${server.port}/index.html`;
    await page.goto(indexUrl, { waitUntil: 'load', timeout: 30_000 });

    // Warm up with REAL wall-clock grace only: lets post-load init that runs
    // on real events (CDN module fetch, texture/font decode) settle. We do NOT
    // advance the fake clock here — the capture loop drives the animation from
    // t≈0 (frame i at t=(i+1)*step), so the video maps onto animation time
    // [0, duration] instead of skipping the first warmup second. (A scene that
    // *defers* its start via a fake setTimeout would begin a few frames in
    // rather than off-screen; rare for the rAF-driven animations this renders.)
    await new Promise((r) => setTimeout(r, cfg.warmupMs));

    let maxScroll = 0;
    if (cfg.capture === 'scroll') {
      // Web fonts shift layout and scrollHeight; give them a bounded real-time
      // grace (document.fonts.ready resolves off network events, not the
      // fake clock — but a hung font fetch shouldn't stall the render).
      // `globalThis` casts keep this file compilable in Node-only tsconfigs
      // (same convention as record.ts).
      await Promise.race([
        page.evaluate(() => {
          const d = (globalThis as unknown as {
            document: { fonts: { ready: Promise<unknown> } };
          }).document;
          return d.fonts.ready.then(() => undefined);
        }),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      // Classic (non-overlay) scrollbars would show up in every frame.
      await page.addStyleTag({
        content:
          'html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }',
      });
      maxScroll = await page.evaluate(() => {
        const g = globalThis as unknown as {
          document: { documentElement: { scrollHeight: number } };
          innerHeight: number;
        };
        return Math.max(
          0,
          g.document.documentElement.scrollHeight - g.innerHeight
        );
      });
      // Tall pages: extend the render rather than blur past the content.
      // `render.duration` acts as a minimum; the cap bounds travel speed.
      const travelFrac = Math.max(
        0.05,
        1 - cfg.scroll.holdStart - cfg.scroll.holdEnd
      );
      const travelSec = (totalFrames / input.fps) * travelFrac;
      if (maxScroll / travelSec > cfg.scroll.maxPxPerSecond) {
        const needed = Math.round(
          (maxScroll / cfg.scroll.maxPxPerSecond / travelFrac) * input.fps
        );
        totalFrames = Math.min(needed, totalFrames * 4);
      }
      ctx.logger.info(
        `[playwright] scroll capture: ${maxScroll}px of travel over ${totalFrames} frames`
      );
    }

    if (ctx.abortSignal.aborted) throw makeAbortError();

    // Capture frames. Width of the frame index is enough digits to hold
    // totalFrames with leading zeros (ffmpeg friendly).
    const padWidth = String(totalFrames).length;
    for (let i = 0; i < totalFrames; i++) {
      if (ctx.abortSignal.aborted) throw makeAbortError();
      if (cfg.capture === 'scroll' && maxScroll > 0) {
        const y = Math.round(
          scrollOffsetAt(i, totalFrames, cfg.scroll) * maxScroll
        );
        // behavior:'instant' bypasses any CSS scroll-behavior:smooth the
        // page sets, keeping frame position exact.
        await page.evaluate((top) => {
          const g = globalThis as unknown as {
            scrollTo: (opts: {
              top: number;
              left: number;
              behavior: string;
            }) => void;
          };
          g.scrollTo({ top, left: 0, behavior: 'instant' });
        }, y);
      }
      // Advance time first so frame i is at t = (i+1)*step. Frame 0 at t=step
      // matches the convention "first frame is one tick into the animation".
      await page.clock.fastForward(stepMs);
      const framePath = path.join(
        framesDir,
        `frame-${String(i).padStart(padWidth, '0')}.png`
      );
      await page.screenshot({ path: framePath, type: 'png', omitBackground: false });
      ctx.emit({
        kind: 'render_progress',
        frame: i + 1,
        totalFrames,
      });
    }

    // Thumbnail: middle frame for animations (representative of motion);
    // first frame for scroll capture (the page hero beats mid-scroll).
    const thumbIdx =
      cfg.capture === 'scroll' ? 0 : Math.floor(totalFrames / 2);
    const thumbSrc = path.join(
      framesDir,
      `frame-${String(thumbIdx).padStart(padWidth, '0')}.png`
    );
    fs.copyFileSync(thumbSrc, thumbnailPath);
  } finally {
    ctx.abortSignal.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    server.close();
  }

  if (ctx.abortSignal.aborted) throw makeAbortError();

  // Encode frames into mp4. yuv420p for broad browser playback.
  await encodeWithFfmpeg(cfg.ffmpegBin, {
    framesDir,
    fps: input.fps,
    padWidth: String(totalFrames).length,
    outPath: videoPath,
    logFile: ffmpegLogFile,
  });

  // Frame PNGs are ~10MB+ for a 1024² × 150-frame run. Drop them after
  // encoding; the mp4 + thumbnail are the keepers.
  fs.rmSync(framesDir, { recursive: true, force: true });

  return {
    videoPath,
    thumbnailPath,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Scroll progress (0..1) for frame i of n: hold at the top, ease down,
 * hold at the bottom. Cubic in-out on the travel segment so the pan
 * starts and lands softly.
 */
function scrollOffsetAt(
  i: number,
  n: number,
  pacing: { holdStart: number; holdEnd: number }
): number {
  if (n <= 1) return 0;
  const t = i / (n - 1);
  const travel = Math.max(0.05, 1 - pacing.holdStart - pacing.holdEnd);
  const p = Math.min(1, Math.max(0, (t - pacing.holdStart) / travel));
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

interface EncodeOpts {
  framesDir: string;
  fps: number;
  padWidth: number;
  outPath: string;
  /** If set, ffmpeg stderr is appended here for postmortem inspection. */
  logFile?: string;
}

function encodeWithFfmpeg(
  bin: string,
  opts: EncodeOpts
): Promise<void> {
  const pattern = path.join(opts.framesDir, `frame-%0${opts.padWidth}d.png`);
  const args = [
    '-y',
    '-framerate',
    String(opts.fps),
    '-i',
    pattern,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    opts.outPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      if (opts.logFile) appendSilent(opts.logFile, b);
      stderr += b.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found at '${bin}'. Install ffmpeg or set { ffmpegBin } on playwrightRenderer().`
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

interface StaticServer {
  port: number;
  close: () => void;
}

function startStaticServer(rootDir: string): Promise<StaticServer> {
  return new Promise((resolve, reject) => {
    const root = path.resolve(rootDir);
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent(
          (req.url ?? '/').split('?')[0] ?? '/'
        );
        const safeRel = path.normalize(urlPath).replace(/^([/\\])+/, '');
        const filePath = path.join(
          root,
          safeRel === '' || safeRel === '/' ? 'index.html' : safeRel
        );
        // Prevent escapes via .. — resolved path must stay under root.
        if (!filePath.startsWith(root)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
        if (!stat || stat.isDirectory()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', mimeFor(filePath));
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.statusCode = 500;
        res.end((err as Error).message);
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('static server: unexpected address'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Best-effort sync append used by adapters to mirror subprocess output to
 * a per-run log file. Swallows errors — SQLite holds the structured record,
 * the file is a debugging convenience.
 */
function appendSilent(file: string, data: Buffer | string): void {
  try {
    fs.appendFileSync(file, data);
  } catch {
    // ignore
  }
}
