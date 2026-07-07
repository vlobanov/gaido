import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  schema,
  SNAPSHOT_VERSION,
  PUBLISHABLE_EVENT_KINDS,
} from '@vadimlobanov/gaido-core';
import type {
  AdapterConfigSnapshot,
  ArtifactKind,
  GaidoSnapshotV1,
  SnapshotNode,
  SnapshotRun,
  SnapshotArtifact,
  SnapshotReference,
  SnapshotEvent,
  SnapshotRunConfig,
} from '@vadimlobanov/gaido-core';
import type { Node } from '@vadimlobanov/gaido-core/schema';
import type { Db } from './db.js';
import type { ResolvedConfig } from './config-loader.js';

/**
 * Artifact kinds that ride a published snapshot: every {@link OutputKind}
 * (`video` / `image` / `model` / `page`) any run output can be, plus
 * `thumbnail`. Code / frame / log artifacts are omitted.
 */
const DISPLAYED_ARTIFACT_KINDS = new Set<ArtifactKind>([
  'video',
  'image',
  'model',
  'page',
  'thumbnail',
]);

/**
 * Resolves the public URLs that go into a snapshot. The default builder emits
 * relative paths suitable for local inspection; `gaido publish` (phase C)
 * supplies R2/CDN strategies that also drive the actual uploads. Keeping URL
 * shaping injectable keeps `buildCanvasSnapshot` pure and decoupled from R2.
 */
export interface SnapshotUrlStrategy {
  /** Public URL for an artifact. Default: relative `artifacts/<id><ext>`. */
  artifact?: (a: {
    id: string;
    runId: string;
    kind: ArtifactKind;
    mime: string;
    ext: string;
  }) => string;
  /** Live-preview URL for a run (or null). Default: pass through the local preview URL. */
  preview?: (r: {
    runId: string;
    nodeId: string;
    commitSha: string | null;
    localPreviewUrl: string | null;
  }) => string | null;
  /** Public URL for an uploaded image reference (or null). Default: null (not published). */
  imageRef?: (r: { id: string; nodeId: string; mime: string | null; ext: string }) => string | null;
}

export interface BuildSnapshotOptions {
  /** Epoch ms stamp. The CLI passes `Date.now()`. */
  publishedAt: number;
  /** Public URL key. Defaults to the canvas slug. */
  publishSlug?: string;
  include?: { instructions?: boolean; events?: boolean; rules?: boolean };
  redact?: { artistFollowUp?: boolean };
  /** LESSONS.md contents (the caller reads the file). Emitted when `include.rules`. */
  rules?: string | null;
  viewerBuild?: string;
  siteUrl?: string;
  urls?: SnapshotUrlStrategy;
}

/**
 * Assemble the read-only `GaidoSnapshotV1` for one canvas: the same read-model
 * the live routers project, redacted down to what's safe to publish (see
 * `docs/publishing.md` for the column-by-column split). Pure over the DB +
 * resolved config; all R2 coupling lives behind `opts.urls`.
 */
export function buildCanvasSnapshot(
  db: Db,
  config: ResolvedConfig,
  canvasId: string,
  opts: BuildSnapshotOptions
): GaidoSnapshotV1 {
  const canvas = db
    .select()
    .from(schema.canvases)
    .where(eq(schema.canvases.id, canvasId))
    .get();
  if (!canvas) throw new Error(`canvas ${canvasId} not found`);

  const includeInstructions = opts.include?.instructions ?? true;
  const includeEvents = opts.include?.events ?? false;
  const includeRules = opts.include?.rules ?? true;
  const redactFollowUp = opts.redact?.artistFollowUp ?? true;

  const artifactUrl = opts.urls?.artifact ?? ((a) => `artifacts/${a.id}${a.ext}`);
  const previewUrl = opts.urls?.preview ?? ((r) => r.localPreviewUrl);
  const imageRefUrl = opts.urls?.imageRef ?? (() => null);

  // --- Nodes (+ resolved coder baked in; the viewer has no registry) ---
  const nodeRows = db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.canvasId, canvasId))
    .all();
  const byId = new Map(nodeRows.map((n) => [n.id, n] as const));
  const defaultCoder = config.defaultCoderName;

  const nodes: SnapshotNode[] = nodeRows.map((n) => {
    const resolvedCoderName = resolveCoderName(n, byId, defaultCoder);
    return {
      id: n.id,
      parentId: n.parentId,
      canvasId: n.canvasId,
      kind: n.kind,
      positionX: n.positionX,
      positionY: n.positionY,
      instruction: includeInstructions ? n.instruction : null,
      status: n.status,
      currentRunId: n.currentRunId,
      coderName: n.coderName,
      sessionPolicy: n.sessionPolicy,
      resolvedCoderName,
      resolvedCoderKind: config.coders.get(resolvedCoderName)?.kind ?? null,
      isFavorite: n.isFavorite,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    };
  });
  const nodeIds = nodeRows.map((n) => n.id);

  // --- Runs ---
  const runRows = nodeIds.length
    ? db.select().from(schema.runs).where(inArray(schema.runs.nodeId, nodeIds)).all()
    : [];
  const runs: SnapshotRun[] = runRows.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    status: r.status,
    codingStartedAt: r.codingStartedAt,
    codingFinishedAt: r.codingFinishedAt,
    renderingStartedAt: r.renderingStartedAt,
    renderingFinishedAt: r.renderingFinishedAt,
    critiquingStartedAt: r.critiquingStartedAt,
    critiquingFinishedAt: r.critiquingFinishedAt,
    config: slimConfig(r.configSnapshot),
    codeArtifactId: r.codeArtifactId,
    outputArtifactId: r.outputArtifactId ?? null,
    videoArtifactId: r.videoArtifactId,
    thumbnailArtifactId: r.thumbnailArtifactId,
    previewUrl: previewUrl({
      runId: r.id,
      nodeId: r.nodeId,
      commitSha: r.commitSha,
      localPreviewUrl: r.previewUrl,
    }),
    critique: r.critique ?? null,
    message: r.message ?? null,
    artistFollowUp: redactFollowUp ? null : r.artistFollowUp ?? null,
    error: r.error
      ? {
          phase: r.error.phase,
          message: r.error.message,
          ...(r.error.validation ? { validation: r.error.validation } : {}),
        }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  const runIds = runRows.map((r) => r.id);

  // --- Artifacts (only the displayed kinds) ---
  // Every output kind (video / image / model / page) plus thumbnails — the
  // media a run's outputArtifactId / videoArtifactId / thumbnailArtifactId can
  // point at. Code / frame / log artifacts stay out of the published bundle.
  const artifactRows = runIds.length
    ? db.select().from(schema.artifacts).where(inArray(schema.artifacts.runId, runIds)).all()
    : [];
  const artifacts: SnapshotArtifact[] = artifactRows
    .filter((a) => DISPLAYED_ARTIFACT_KINDS.has(a.kind))
    .map((a) => {
      const ext = path.extname(a.path);
      return {
        id: a.id,
        runId: a.runId,
        kind: a.kind,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        url: artifactUrl({ id: a.id, runId: a.runId, kind: a.kind, mime: a.mime, ext }),
      };
    });

  // --- References ---
  const refRows = nodeIds.length
    ? db
        .select()
        .from(schema.nodeReferences)
        .where(inArray(schema.nodeReferences.nodeId, nodeIds))
        .all()
    : [];
  const references: SnapshotReference[] = refRows.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    kind: r.kind,
    sourceRunId: r.sourceRunId,
    url:
      r.kind === 'image'
        ? imageRefUrl({
            id: r.id,
            nodeId: r.nodeId,
            mime: r.mime,
            ext: r.filePath ? path.extname(r.filePath) : '',
          })
        : null,
    mime: r.mime,
    label: r.label,
    createdAt: r.createdAt,
  }));

  // --- Events (optional, filtered to the publishable allowlist) ---
  let events: SnapshotEvent[] | undefined;
  if (includeEvents && runIds.length) {
    const allowed = new Set<string>(PUBLISHABLE_EVENT_KINDS);
    events = db
      .select()
      .from(schema.events)
      .where(inArray(schema.events.runId, runIds))
      .orderBy(asc(schema.events.ts))
      .all()
      .filter((e) => allowed.has(e.payload.kind))
      .map((e) => ({ id: e.id, runId: e.runId, ts: e.ts, payload: e.payload }));
  }

  const coders = [...config.coders].map(([name, coder]) => ({
    name,
    kind: coder.kind,
    isDefault: name === defaultCoder,
  }));

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    publishedAt: opts.publishedAt,
    ...(opts.viewerBuild ? { viewerBuild: opts.viewerBuild } : {}),
    ...(opts.siteUrl ? { site: { url: opts.siteUrl } } : {}),
    canvas: {
      id: canvas.id,
      name: canvas.name,
      slug: canvas.slug,
      publishSlug: opts.publishSlug ?? canvas.slug,
    },
    nodes,
    runs,
    artifacts,
    references,
    coders,
    system: { projectName: config.name ?? null, criticKind: config.critic.kind },
    rules: includeRules ? opts.rules ?? null : null,
    ...(events ? { events } : {}),
  };
}

/** First non-null `coderName` walking up the parent chain; else the registry default. */
function resolveCoderName(
  node: Node,
  byId: Map<string, Node>,
  defaultName: string
): string {
  const seen = new Set<string>();
  let cur: Node | undefined = node;
  while (cur) {
    if (cur.coderName) return cur.coderName;
    if (!cur.parentId || seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return defaultName;
}

/** Reduce a stored `AdapterConfigSnapshot` to adapter names/kinds — no args. */
function slimConfig(snap: AdapterConfigSnapshot): SnapshotRunConfig {
  return {
    coder: {
      kind: snap.coder.kind,
      ...(snap.coder.args?.name ? { name: snap.coder.args.name } : {}),
    },
    critic: {
      kind: snap.critic.kind,
      ...(snap.critic.model ? { model: snap.critic.model } : {}),
    },
    renderer: { kind: snap.renderer.kind },
  };
}
