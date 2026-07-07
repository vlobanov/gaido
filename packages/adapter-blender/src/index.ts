import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  RenderInput,
  RenderOutput,
  RenderResult,
  Renderer,
  RunContext,
} from '@vadimlobanov/gaido-core';

export interface BlenderRendererOpts {
  /**
   * Path to the Blender binary. Default: resolved at render time — `blender`
   * from PATH if present, else the standard macOS app bundle, else an error.
   */
  bin?: string;
  /** Path to the ffmpeg binary. Default: 'ffmpeg' (resolved via PATH). */
  ffmpegBin?: string;
  /**
   * Also export the scene as a GLB model alongside the video. Default true.
   * Export is best-effort — a failure is logged and the model output dropped,
   * never failing the render.
   */
  exportGlb?: boolean;
  /**
   * Name of the agent-authored Python scene script inside the worktree.
   * Default 'scene.py'.
   */
  sceneFile?: string;
  /** Extra Blender CLI args, inserted before the `--` scene separator. */
  extraArgs?: string[];
}

interface ResolvedConfig {
  bin?: string;
  ffmpegBin: string;
  exportGlb: boolean;
  sceneFile: string;
  extraArgs: string[];
}

export function blenderRenderer(opts: BlenderRendererOpts = {}): Renderer {
  const cfg: ResolvedConfig = {
    bin: opts.bin,
    ffmpegBin: opts.ffmpegBin ?? 'ffmpeg',
    exportGlb: opts.exportGlb ?? true,
    sceneFile: opts.sceneFile ?? 'scene.py',
    extraArgs: opts.extraArgs ?? [],
  };
  return {
    kind: 'blender',
    render: (input, ctx) => doRender(cfg, input, ctx),
  };
}

let cachedBin: string | null = null;

/** Resolve the Blender binary once per process. */
function resolveBlenderBin(override?: string): string {
  if (override) return override;
  if (cachedBin) return cachedBin;
  const onPath = spawnSync('which', ['blender'], { encoding: 'utf8' });
  if (onPath.status === 0) {
    cachedBin = onPath.stdout.trim();
    return cachedBin;
  }
  if (process.platform === 'darwin') {
    const appBundle = '/Applications/Blender.app/Contents/MacOS/Blender';
    if (fs.existsSync(appBundle)) {
      cachedBin = appBundle;
      return cachedBin;
    }
  }
  throw new Error(
    "Blender not found. Install Blender and put `blender` on PATH, or pass { bin } to blenderRenderer(). On macOS the app bundle at /Applications/Blender.app is auto-detected."
  );
}

interface RenderMeta {
  frameStart: number;
  frameEnd: number;
  fps: number;
}

async function doRender(
  cfg: ResolvedConfig,
  input: RenderInput,
  ctx: RunContext
): Promise<RenderResult> {
  const startedAt = Date.now();
  const bin = resolveBlenderBin(cfg.bin);

  const scenePath = path.join(ctx.workdir, cfg.sceneFile);
  if (!fs.existsSync(scenePath)) {
    throw new Error(
      `Blender scene not found: ${cfg.sceneFile} is missing from the worktree. The coder must author a '${cfg.sceneFile}' at the project root.`
    );
  }

  fs.mkdirSync(ctx.outputDir, { recursive: true });
  const framesDir = path.join(ctx.outputDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const videoPath = path.join(ctx.outputDir, 'video.mp4');
  const thumbnailPath = path.join(ctx.outputDir, 'thumbnail.png');
  const glbPath = cfg.exportGlb ? path.join(ctx.outputDir, 'scene.glb') : null;

  // Params handed to the bundled Python runner. Absolute paths so the runner's
  // cwd (the worktree) doesn't matter.
  const params = {
    sceneFile: scenePath,
    framesDir,
    width: input.width,
    height: input.height,
    fps: input.fps,
    duration: input.duration,
    glbPath,
  };
  const paramsFile = path.join(ctx.logDir, 'blender.params.json');
  fs.writeFileSync(paramsFile, JSON.stringify(params, null, 2));

  const runnerPath = fileURLToPath(new URL('./runner.py', import.meta.url));
  const blenderLog = path.join(ctx.logDir, 'blender.log');
  const ffmpegLogFile = path.join(ctx.logDir, 'blender.ffmpeg.log');

  const meta = await runBlender(bin, {
    args: [
      '--background',
      '--factory-startup',
      '--python',
      runnerPath,
      ...cfg.extraArgs,
      '--',
      '--params',
      paramsFile,
    ],
    cwd: ctx.workdir,
    logFile: blenderLog,
    ctx,
  });

  if (ctx.abortSignal.aborted) throw makeAbortError();

  const padWidth = 4; // Blender pads frame numbers to 4 digits (frame_end <= 9999).

  // Encode the PNG frames Blender wrote (frame-0001.png …) into an mp4.
  await encodeWithFfmpeg(cfg.ffmpegBin, {
    framesDir,
    fps: meta.fps,
    startNumber: meta.frameStart,
    padWidth,
    outPath: videoPath,
    logFile: ffmpegLogFile,
  });

  // Thumbnail = the middle frame of the range (representative of motion).
  const midFrame = Math.round((meta.frameStart + meta.frameEnd) / 2);
  const thumbSrc = path.join(
    framesDir,
    `frame-${String(midFrame).padStart(padWidth, '0')}.png`
  );
  if (fs.existsSync(thumbSrc)) {
    fs.copyFileSync(thumbSrc, thumbnailPath);
  }
  const haveThumb = fs.existsSync(thumbnailPath);

  // Frame PNGs are large; the mp4 + thumbnail are the keepers.
  fs.rmSync(framesDir, { recursive: true, force: true });

  // The GLB leads when it landed (the interactive 3D scene is the showpiece;
  // the UI offers a toggle back to the video, and the critic reads the run's
  // video pointer either way). GLB export is best-effort — a video-only
  // result is still a complete render.
  const outputs: RenderOutput[] = [];
  if (glbPath && fs.existsSync(glbPath) && fs.statSync(glbPath).size > 0) {
    outputs.push({ kind: 'model', path: glbPath, mime: 'model/gltf-binary' });
  }
  outputs.push({ kind: 'video', path: videoPath, mime: 'video/mp4' });

  return {
    outputs,
    thumbnailPath: haveThumb ? thumbnailPath : null,
    durationMs: Date.now() - startedAt,
  };
}

interface RunBlenderOpts {
  args: string[];
  cwd: string;
  logFile: string;
  ctx: RunContext;
}

/**
 * Spawn Blender, mirror all output to the log file, parse GAIDO_META / warnings
 * and Blender's per-frame `Fra:` progress lines. Resolves with the scene's
 * frame range + fps; rejects with the stderr tail on nonzero exit.
 */
function runBlender(
  bin: string,
  opts: RunBlenderOpts
): Promise<RenderMeta> {
  const { ctx } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, opts.args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let meta: RenderMeta | null = null;
    let totalFrames = 0;
    let lastFrame = 0;
    let stdoutBuf = '';
    let stderrTail = '';
    let settled = false;

    const onAbort = () => {
      ctx.logger.warn('[blender] aborting');
      child.kill('SIGKILL');
    };
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      ctx.abortSignal.removeEventListener('abort', onAbort);
      fn();
    };

    const handleLine = (line: string) => {
      if (line.startsWith('GAIDO_META ')) {
        try {
          meta = JSON.parse(line.slice('GAIDO_META '.length)) as RenderMeta;
          totalFrames = Math.max(1, meta.frameEnd - meta.frameStart + 1);
          ctx.logger.info(
            `[blender] scene: frames ${meta.frameStart}–${meta.frameEnd} @ ${meta.fps}fps`
          );
        } catch {
          // ignore a malformed meta line; exit-code path will surface trouble
        }
        return;
      }
      if (line.startsWith('GAIDO_WARN ')) {
        ctx.logger.warn(`[blender] ${line.slice('GAIDO_WARN '.length)}`);
        return;
      }
      // Blender emits many "Fra:<n> ..." lines per frame (one per sample/layer)
      // as it renders. Read the frame NUMBER off the line — not a line count —
      // and only emit when it advances, so progress tracks real frames.
      if (line.startsWith('Fra:') && meta && totalFrames > 0) {
        const n = parseInt(line.slice('Fra:'.length), 10);
        if (Number.isFinite(n)) {
          const frame = Math.min(
            Math.max(1, n - meta.frameStart + 1),
            totalFrames
          );
          if (frame > lastFrame) {
            lastFrame = frame;
            ctx.emit({ kind: 'render_progress', frame, totalFrames });
          }
        }
      }
    };

    child.stdout.on('data', (b: Buffer) => {
      appendSilent(opts.logFile, b);
      stdoutBuf += b.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      appendSilent(opts.logFile, b);
      stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      done(() => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `Blender binary not found at '${bin}'. Install Blender or pass { bin } to blenderRenderer().`
            )
          );
        } else {
          reject(err);
        }
      });
    });

    child.on('close', (code) => {
      done(() => {
        if (ctx.abortSignal.aborted) {
          reject(makeAbortError());
          return;
        }
        if (code !== 0) {
          const tail = stderrTail.slice(-800).trim();
          reject(
            new Error(
              `Blender exited ${code}${tail ? `:\n${tail}` : ''}`
            )
          );
          return;
        }
        if (!meta) {
          reject(
            new Error(
              'Blender finished but produced no GAIDO_META line — the scene script may have failed before setting up the frame range. See blender.log.'
            )
          );
          return;
        }
        resolve(meta);
      });
    });
  });
}

interface EncodeOpts {
  framesDir: string;
  fps: number;
  startNumber: number;
  padWidth: number;
  outPath: string;
  logFile?: string;
}

function encodeWithFfmpeg(bin: string, opts: EncodeOpts): Promise<void> {
  const pattern = path.join(opts.framesDir, `frame-%0${opts.padWidth}d.png`);
  const args = [
    '-y',
    '-framerate',
    String(opts.fps),
    '-start_number',
    String(opts.startNumber),
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
            `ffmpeg not found at '${bin}'. Install ffmpeg or set { ffmpegBin } on blenderRenderer().`
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

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Best-effort sync append used to mirror subprocess output to a per-run log
 * file. Swallows errors — the structured record lives elsewhere; the file is a
 * debugging convenience.
 */
function appendSilent(file: string, data: Buffer | string): void {
  try {
    fs.appendFileSync(file, data);
  } catch {
    // ignore
  }
}
