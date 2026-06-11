import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { schema, referenceId as newReferenceId } from '@vadimlobanov/gaido-core';
import type { NodeReference } from '@vadimlobanov/gaido-core/schema';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db.js';
import type { Paths } from './paths.js';
import type { WorkspaceManager } from './workspace.js';
import { REFERENCES_DIRNAME } from './workspace.js';

/**
 * Artist references — images and snapshots of other runs — attached to a coder
 * node so its agent can read them. This module owns the bytes lifecycle:
 *
 *   bind        write/extract bytes once into runs/.references, insert rows
 *   inherit     copy a coder's reference rows onto a fork/continue child
 *   materialize copy the bytes into a worktree's references/ + name them in
 *               the instruction (called by the orchestrator before each run)
 *
 * Heavy work (git archive + ffmpeg frame extraction) happens at bind time and
 * is cached per source run, so it runs once and survives the source being
 * deleted later. Materialize is a cheap recursive copy.
 */

/** How many keyframes to pull from a referenced run's video. */
const REFERENCE_FRAME_COUNT = 4;
const FFMPEG_BIN = process.env['GAIDO_FFMPEG'] ?? 'ffmpeg';

export const referenceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: z.string() }),
  z.object({
    kind: z.literal('image'),
    filename: z.string().min(1),
    mime: z.string().min(1),
    /** base64-encoded bytes (no data: prefix). Pasted images are small. */
    dataBase64: z.string().min(1),
  }),
]);

export type ReferenceInput = z.infer<typeof referenceInputSchema>;

export interface ReferenceDeps {
  db: Db;
  paths: Paths;
  workspace: WorkspaceManager;
}

// ---------- bind ----------

/** Bind a list of references to a node. Skips any that fail to resolve. */
export async function bindReferences(
  deps: ReferenceDeps,
  nodeId: string,
  refs: ReferenceInput[]
): Promise<NodeReference[]> {
  const out: NodeReference[] = [];
  for (const ref of refs) {
    const row =
      ref.kind === 'image'
        ? bindImage(deps, nodeId, ref)
        : await bindRun(deps, nodeId, ref.runId);
    if (row) out.push(row);
  }
  return out;
}

function bindImage(
  deps: ReferenceDeps,
  nodeId: string,
  ref: Extract<ReferenceInput, { kind: 'image' }>
): NodeReference {
  const id = newReferenceId();
  const safeName = sanitizeFilename(ref.filename);
  const dir = path.join(deps.paths.referencesDir, 'uploads', id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, Buffer.from(ref.dataBase64, 'base64'));
  return insertReference(deps, {
    id,
    nodeId,
    kind: 'image',
    sourceRunId: null,
    filePath,
    mime: ref.mime,
    label: ref.filename,
  });
}

/**
 * Cache a run's code (git archive) + keyframes (ffmpeg) and bind it. Returns
 * null if the run is gone or has neither code nor video to reference.
 */
async function bindRun(
  deps: ReferenceDeps,
  nodeId: string,
  sourceRunId: string
): Promise<NodeReference | null> {
  const resolved = resolveRunForReference(deps.db, sourceRunId);
  if (!resolved || (!resolved.hasCode && !resolved.hasVideo)) return null;

  const cacheDir = runCachePath(deps.paths, sourceRunId);
  const codeDir = path.join(cacheDir, 'code');
  const framesDir = path.join(cacheDir, 'frames');

  // Cache code once per source run (commit SHAs are immutable).
  if (resolved.commitSha && !fs.existsSync(codeDir)) {
    await deps.workspace.archiveCommit({
      commitSha: resolved.commitSha,
      destDir: codeDir,
    });
  }
  // Cache keyframes once. Best-effort: a render with no probe-able video
  // shouldn't block attaching the code.
  if (resolved.videoPath && !fs.existsSync(framesDir)) {
    try {
      fs.mkdirSync(framesDir, { recursive: true });
      await extractVideoFrames(resolved.videoPath, framesDir, REFERENCE_FRAME_COUNT);
    } catch {
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
  }

  return insertReference(deps, {
    id: newReferenceId(),
    nodeId,
    kind: 'run',
    sourceRunId,
    filePath: null,
    mime: null,
    label: resolved.label,
  });
}

function insertReference(
  deps: ReferenceDeps,
  row: Omit<NodeReference, 'createdAt'>
): NodeReference {
  const createdAt = Date.now();
  deps.db
    .insert(schema.nodeReferences)
    .values({ ...row, createdAt })
    .run();
  return { ...row, createdAt };
}

// ---------- inherit ----------

/**
 * Copy a coder's reference rows onto a new fork/continue child. Rows point at
 * the same cached bytes, so this is cheap; the copies are independent, so
 * removing one on the child doesn't touch the parent's.
 */
export function inheritReferences(
  deps: ReferenceDeps,
  fromNodeId: string,
  toNodeId: string
): void {
  const rows = deps.db
    .select()
    .from(schema.nodeReferences)
    .where(eq(schema.nodeReferences.nodeId, fromNodeId))
    .all();
  if (rows.length === 0) return;
  const now = Date.now();
  for (const r of rows) {
    deps.db
      .insert(schema.nodeReferences)
      .values({
        id: newReferenceId(),
        nodeId: toNodeId,
        kind: r.kind,
        sourceRunId: r.sourceRunId,
        filePath: r.filePath,
        mime: r.mime,
        label: r.label,
        createdAt: now,
      })
      .run();
  }
}

// ---------- materialize ----------

/**
 * Copy a node's references into `<workdir>/references/` and return a block to
 * splice into the coder's instruction. Clears the folder first so it always
 * reflects the node's current list (matters for continued nodes that share
 * the anchor worktree). Returns null when the node has no references.
 */
export function materializeReferences(
  deps: Pick<ReferenceDeps, 'db' | 'paths'>,
  nodeId: string,
  workdir: string
): string | null {
  const refsRoot = path.join(workdir, REFERENCES_DIRNAME);
  fs.rmSync(refsRoot, { recursive: true, force: true });

  const rows = deps.db
    .select()
    .from(schema.nodeReferences)
    .where(eq(schema.nodeReferences.nodeId, nodeId))
    .all();
  if (rows.length === 0) return null;

  const images: string[] = [];
  const runs: { label: string; codeRel: string | null; frames: string[] }[] = [];

  for (const row of rows) {
    if (row.kind === 'image' && row.filePath && fs.existsSync(row.filePath)) {
      const rel = path.posix.join(REFERENCES_DIRNAME, 'images', path.basename(row.filePath));
      const dest = path.join(workdir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(row.filePath, dest);
      images.push(rel);
    } else if (row.kind === 'run' && row.sourceRunId) {
      const cacheDir = runCachePath(deps.paths, row.sourceRunId);
      const slug = `run-${row.sourceRunId.replace(/^r_/, '')}`;
      const destDir = path.join(refsRoot, slug);
      let codeRel: string | null = null;
      const cacheCode = path.join(cacheDir, 'code');
      if (fs.existsSync(cacheCode)) {
        fs.cpSync(cacheCode, path.join(destDir, 'code'), { recursive: true });
        codeRel = path.posix.join(REFERENCES_DIRNAME, slug, 'code');
      }
      const frames: string[] = [];
      const cacheFrames = path.join(cacheDir, 'frames');
      if (fs.existsSync(cacheFrames)) {
        fs.cpSync(cacheFrames, path.join(destDir, 'frames'), { recursive: true });
        for (const f of fs.readdirSync(cacheFrames).sort()) {
          frames.push(path.posix.join(REFERENCES_DIRNAME, slug, 'frames', f));
        }
      }
      if (codeRel || frames.length > 0) {
        runs.push({ label: row.label, codeRel, frames });
      }
    }
  }

  if (images.length === 0 && runs.length === 0) return null;
  return formatReferenceBlock(images, runs);
}

function formatReferenceBlock(
  images: string[],
  runs: { label: string; codeRel: string | null; frames: string[] }[]
): string {
  const lines: string[] = [
    'REFERENCES (provided by the artist as inspiration and context — read them before you start; do not copy them wholesale):',
  ];
  if (images.length > 0) {
    lines.push('', 'Reference images (use the Read tool to view each):');
    for (const rel of images) lines.push(`  - ${rel}`);
  }
  for (const run of runs) {
    lines.push('', `Prior run — "${run.label}":`);
    if (run.codeRel) lines.push(`  - code: ${run.codeRel}/ (browse to see how it was built)`);
    if (run.frames.length > 0) {
      lines.push(`  - keyframes (use the Read tool to view): ${run.frames.join(', ')}`);
    }
  }
  return lines.join('\n');
}

// ---------- resolve (for UI preview + validation) ----------

export interface ResolvedRunReference {
  runId: string;
  label: string;
  instruction: string;
  canvasSlug: string;
  canvasName: string | null;
  thumbnailArtifactId: string | null;
  commitSha: string | null;
  videoPath: string | null;
  hasCode: boolean;
  hasVideo: boolean;
}

/** Resolve a run id to the metadata needed to reference + preview it. */
export function resolveRunForReference(
  db: Db,
  runId: string
): ResolvedRunReference | null {
  const run = db
    .select({
      id: schema.runs.id,
      nodeId: schema.runs.nodeId,
      commitSha: schema.runs.commitSha,
      videoArtifactId: schema.runs.videoArtifactId,
      thumbnailArtifactId: schema.runs.thumbnailArtifactId,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .get();
  if (!run) return null;

  const node = db
    .select({
      instruction: schema.nodes.instruction,
      canvasId: schema.nodes.canvasId,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, run.nodeId))
    .get();
  const canvas = node
    ? db
        .select({ slug: schema.canvases.slug, name: schema.canvases.name })
        .from(schema.canvases)
        .where(eq(schema.canvases.id, node.canvasId))
        .get()
    : undefined;

  let videoPath: string | null = null;
  if (run.videoArtifactId) {
    const art = db
      .select({ path: schema.artifacts.path })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, run.videoArtifactId))
      .get();
    videoPath = art?.path ?? null;
  }

  const instruction = node?.instruction ?? '';
  const canvasName = canvas?.name ?? null;
  const canvasSlug = canvas?.slug ?? 'default';
  return {
    runId,
    label: buildLabel(instruction, canvasName ?? canvasSlug),
    instruction,
    canvasSlug,
    canvasName,
    thumbnailArtifactId: run.thumbnailArtifactId ?? null,
    commitSha: run.commitSha ?? null,
    videoPath,
    hasCode: !!run.commitSha,
    hasVideo: !!videoPath,
  };
}

// ---------- cleanup ----------

/** Drop all reference rows for the given nodes. Cached bytes are left in
 *  place (cheap, gitignored, and possibly shared by other nodes). */
export function deleteReferencesForNodes(db: Db, nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  db.delete(schema.nodeReferences)
    .where(inArray(schema.nodeReferences.nodeId, nodeIds))
    .run();
}

// ---------- helpers ----------

function runCachePath(paths: Paths, runId: string): string {
  return path.join(paths.referencesDir, 'cache', `run-${runId.replace(/^r_/, '')}`);
}

function buildLabel(instruction: string, canvasLabel: string): string {
  const snippet = instruction.replace(/\s+/g, ' ').trim().slice(0, 60);
  const truncated = instruction.trim().length > 60 ? `${snippet}…` : snippet;
  const text = truncated || 'untitled run';
  return `${text} · ${canvasLabel}`;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'image';
}

// ---------- ffmpeg ----------

/** Extract N evenly-spaced keyframes from a video into outDir as PNGs. */
async function extractVideoFrames(
  videoPath: string,
  outDir: string,
  frameCount: number
): Promise<string[]> {
  const duration = await probeDuration(videoPath);
  const padWidth = String(frameCount).length;
  const frames: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    // Sample at 1/(N+1), 2/(N+1)… to skip the (often black) first/last frame.
    const t = ((i + 1) * duration) / (frameCount + 1);
    const out = path.join(outDir, `frame-${String(i + 1).padStart(padWidth, '0')}.png`);
    await runFfmpeg([
      '-y',
      '-ss',
      t.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      out,
    ]);
    frames.push(out);
  }
  return frames;
}

function probeDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ['-i', videoPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let buf = '';
    child.stderr.on('data', (c: Buffer) => (buf += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', () => {
      const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) {
        reject(new Error('ffmpeg: could not parse duration'));
        return;
      }
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-200).trim()}`));
    });
  });
}
