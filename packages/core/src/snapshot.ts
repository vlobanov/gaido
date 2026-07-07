import type {
  NodeKind,
  NodeStatus,
  RunStatus,
  ArtifactKind,
  Critique,
  RunError,
  SessionPolicy,
} from './types.js';
import type { CoderMessage } from './prompts.js';
import type { EventKind, EventPayload } from './events.js';

/**
 * The published, read-only snapshot of a canvas — the wire format behind
 * `gaido publish`. A finished canvas is serialized to this shape, embedded in
 * the static viewer page, and read back through the web app's static tRPC link
 * (see `docs/publishing.md`).
 *
 * It is a *contract*, deliberately decoupled from the live router output shapes
 * and the DB rows: a graph published today must still open after the schema and
 * routers have moved on, so the viewer keys off `snapshotVersion` and migrates
 * older snapshots forward rather than depending on a live API. Bump the version
 * (and add a forward-migration in the viewer) whenever this shape changes in a
 * way old viewers can't read.
 */
export const SNAPSHOT_VERSION = 1 as const;

/**
 * Event kinds safe to publish. Excludes `agent_token` / `tool_call`
 * (verbose coder internals), `token_usage` (cost), and `check_attempt` (its
 * `output` tail can carry stderr / paths). Events ride the snapshot only when
 * `include.events` is set; this is the allowlist applied when they do.
 */
export const PUBLISHABLE_EVENT_KINDS: readonly EventKind[] = [
  'phase_start',
  'phase_end',
  'render_progress',
  'log',
  'error',
  'run_finalized',
];

export interface SnapshotCanvas {
  id: string;
  name: string | null;
  slug: string;
  /** Public URL key under the publish origin — `graphs.gaido.ai/<publishSlug>`. */
  publishSlug: string;
}

export interface SnapshotNode {
  id: string;
  parentId: string | null;
  canvasId: string;
  kind: NodeKind;
  positionX: number;
  positionY: number;
  /** Null when instructions were redacted at publish (`include.instructions: false`). */
  instruction: string | null;
  status: NodeStatus;
  currentRunId: string | null;
  /** Raw chosen coder (null on inheriting nodes) — parity with the live `nodes.list`. */
  coderName: string | null;
  /**
   * Config-node marker: how the coder beneath treats the branch session
   * (`'retain'` | `'reset'`). Null on coder/critique nodes. Display-only — the
   * config card renders it — and a harmless enum, so it rides the snapshot.
   */
  sessionPolicy: SessionPolicy | null;
  /**
   * Effective coder, resolved by lineage walk at publish time. The viewer has
   * no coder registry, so the resolution is baked here for display (badges).
   */
  resolvedCoderName: string;
  /** Adapter kind of the resolved coder. Null when the registry can't resolve it. */
  resolvedCoderKind: string | null;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Redacted `AdapterConfigSnapshot` — adapter names/kinds only, no args. */
export interface SnapshotRunConfig {
  coder: { kind: string; name?: string };
  critic: { kind: string; model?: string };
  renderer: { kind: string };
}

/** Redacted `RunError` — no stack trace. */
export type SnapshotRunError = Omit<RunError, 'stack'>;

export interface SnapshotRun {
  id: string;
  nodeId: string;
  status: RunStatus;
  codingStartedAt: number | null;
  codingFinishedAt: number | null;
  renderingStartedAt: number | null;
  renderingFinishedAt: number | null;
  critiquingStartedAt: number | null;
  critiquingFinishedAt: number | null;
  config: SnapshotRunConfig;
  codeArtifactId: string | null;
  /**
   * Primary output artifact (any {@link OutputKind}). Optional: snapshots
   * published before output generalization lack it — viewers fall back to
   * `videoArtifactId`. The artifact row's `kind` says how to present it.
   */
  outputArtifactId?: string | null;
  videoArtifactId: string | null;
  thumbnailArtifactId: string | null;
  /** Live-preview origin for this run, rewritten to the publish domain. Null when none. */
  previewUrl: string | null;
  critique: Critique | null;
  message: CoderMessage | null;
  /** Artist's side of the message thread. Null when redacted (`redact.artistFollowUp`). */
  artistFollowUp: string | null;
  error: SnapshotRunError | null;
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotArtifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  mime: string;
  sizeBytes: number;
  /** Resolved URL — R2/CDN in production, a relative path in the default builder. */
  url: string;
}

export interface SnapshotReference {
  id: string;
  nodeId: string;
  kind: 'image' | 'run';
  /** kind='run': the referenced run id (resolvable within this snapshot when same-canvas). */
  sourceRunId: string | null;
  /** kind='image': resolved URL for the uploaded image. Null when not published. */
  url: string | null;
  mime: string | null;
  label: string;
  createdAt: number;
}

export interface SnapshotEvent {
  id: string;
  runId: string;
  ts: number;
  /** Already filtered to `PUBLISHABLE_EVENT_KINDS`. */
  payload: EventPayload;
}

export interface SnapshotCoder {
  name: string;
  kind: string;
  isDefault: boolean;
}

export interface GaidoSnapshotV1 {
  snapshotVersion: typeof SNAPSHOT_VERSION;
  /** Epoch ms the snapshot was built. */
  publishedAt: number;
  /** Identifier of the viewer bundle this was published against — pin escape hatch. */
  viewerBuild?: string;
  /** Canonical site origin, for share/embed links. */
  site?: { url?: string };
  canvas: SnapshotCanvas;
  nodes: SnapshotNode[];
  runs: SnapshotRun[];
  /** Only displayed artifacts — outputs (video/image/model/page) + thumbnails. */
  artifacts: SnapshotArtifact[];
  references: SnapshotReference[];
  coders: SnapshotCoder[];
  system: { projectName: string | null; criticKind: string };
  /** LESSONS.md contents at publish (`include.rules`), or null. */
  rules?: string | null;
  /** Filtered event history — present only when `include.events`. */
  events?: SnapshotEvent[];
}

/** The current snapshot shape. Re-point this alias when a `V2` is introduced. */
export type GaidoSnapshot = GaidoSnapshotV1;
