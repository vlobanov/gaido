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
} from '@gaido/core';

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
}

export function playwrightRenderer(
  opts: PlaywrightRendererOpts = {}
): Renderer {
  const cfg = {
    ffmpegBin: opts.ffmpegBin ?? 'ffmpeg',
    warmupMs: opts.warmupMs ?? 1000,
    launchArgs: opts.launchArgs ?? [],
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

  const totalFrames = Math.max(1, Math.round(input.duration * input.fps));
  const stepMs = 1000 / input.fps;
  const videoPath = path.join(ctx.outputDir, 'video.mp4');
  const thumbnailPath = path.join(ctx.outputDir, 'thumbnail.png');

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
      ctx.logger.warn(`[playwright] page error: ${err.message}`);
    });

    // Install fake clock BEFORE navigation. setTimeout/rAF/Date in the page
    // become deterministic; we drive time via fastForward.
    await page.clock.install({ time: new Date(0) });

    const indexUrl = `http://127.0.0.1:${server.port}/index.html`;
    await page.goto(indexUrl, { waitUntil: 'load', timeout: 30_000 });

    // Warm up: real wall-clock grace for any post-load init that depends
    // on real network / filesystem. Then run fake clock briefly to drain
    // any queued microtask/animation init.
    await new Promise((r) => setTimeout(r, cfg.warmupMs));
    await page.clock.runFor(cfg.warmupMs);

    if (ctx.abortSignal.aborted) throw makeAbortError();

    // Capture frames. Width of the frame index is enough digits to hold
    // totalFrames with leading zeros (ffmpeg friendly).
    const padWidth = String(totalFrames).length;
    for (let i = 0; i < totalFrames; i++) {
      if (ctx.abortSignal.aborted) throw makeAbortError();
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

    // Use the middle frame as the thumbnail (visually representative of
    // the middle of the animation rather than the still pre-roll).
    const thumbIdx = Math.floor(totalFrames / 2);
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

interface EncodeOpts {
  framesDir: string;
  fps: number;
  padWidth: number;
  outPath: string;
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
