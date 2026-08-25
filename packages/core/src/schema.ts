import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { NodeStatus, NodeKind, RunStatus, ArtifactKind, Critique, RunError, AdapterConfigSnapshot, SessionPolicy, BranchMeta } from './types.js';
import type { EventPayload } from './events.js';
import type { CoderMessage } from './prompts.js';

export const canvases = sqliteTable(
  'canvases',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    slug: text('slug').notNull(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    slugIdx: uniqueIndex('canvases_slug_unique').on(table.slug),
  })
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    canvasId: text('canvas_id').notNull().references(() => canvases.id),
    kind: text('kind').$type<NodeKind>().notNull().default('coder'),
    positionX: real('position_x').notNull().default(0),
    positionY: real('position_y').notNull().default(0),
    instruction: text('instruction').notNull(),
    status: text('status').$type<NodeStatus>().notNull().default('idle'),
    currentRunId: text('current_run_id'),
    sessionId: text('session_id'),
    /**
     * Branch lineage. NULL = this node owns its own branch (worktree at
     * `runs/<id>/`, git branch `node/<id>`). Set = this node is a linked
     * continuation; its worktree, branch, and Claude Code session live on
     * the anchor row instead. Anchors always point at the branch root, not
     * intermediate links — collapse via `node.branchAnchorId ?? node.id`.
     */
    branchAnchorId: text('branch_anchor_id'),
    /**
     * Skeleton preset name — a folder under `<projectDir>/skeletons/` or
     * `~/.gaido/skeletons/` that seeds a branch's worktree. Set on the coder
     * that owns the branch (the orchestrator seeds from `anchor.skeletonName`)
     * and, for display, on the root `config` marker above it. NULL → `'default'`.
     * Continued/forked nodes inherit via branch lineage and leave this NULL.
     */
    skeletonName: text('skeleton_name'),
    /**
     * Selected coder name from the config's coder registry. Set where a coder
     * is *chosen*: root coders (seed picker), config nodes (mid-graph switch),
     * and coder nodes whose model was swapped on Retry. NULL elsewhere — the
     * orchestrator resolves the effective coder by walking up the parent chain
     * to the first non-null value (else the registry default). Same
     * inherit-down-lineage shape as `skeletonName`, with config nodes as extra
     * injection points.
     */
    coderName: text('coder_name'),
    /**
     * Config-node only: how the coder spawned beneath it treats the branch's
     * session — `'retain'` (resume, wired like Continue) or `'reset'` (fresh,
     * wired like Fork). NULL on coder/critique nodes.
     */
    sessionPolicy: text('session_policy').$type<SessionPolicy>(),
    /**
     * Auto-run budget. When the artist starts an auto-run ("Run automatically
     * N times"), the coder → critique → continue cycle advances itself without
     * manual clicks. `autoRunTotal` is the requested cycle count (constant
     * across the chain, for "iteration k of N" display); `autoRunRemaining`
     * counts the cycles still to complete, including the one in flight, and is
     * decremented at each continue. Both NULL outside an auto-run. The
     * orchestrator carries the budget forward onto each spawned node and clears
     * it from the frontier when the run finishes the campaign, is interrupted,
     * or fails — so at most one node per chain ever holds a live budget.
     */
    autoRunTotal: integer('auto_run_total'),
    autoRunRemaining: integer('auto_run_remaining'),
    /**
     * Artist/agent-authored margin note on the node — free text like
     * "published as hero-loop on videoeffects.com". Set via `gaido note` (or
     * the nodes.setNote mutation), shown on the card. Null = no note.
     */
    note: text('note'),
    /**
     * Branch metadata (`gaido meta` / `nodes.setMeta`) — typed key/values the
     * project declares in `config.meta`, shared by the whole branch. Lives on
     * the **anchor row only** (like `sessionId`); every node of the branch
     * reads it via `branchAnchorId ?? id`. So Continue inherits it and a
     * Fork (new anchor) starts clean. NULL = no metadata.
     */
    branchMeta: text('branch_meta', { mode: 'json' }).$type<BranchMeta>(),
    isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    parentIdx: index('nodes_parent_idx').on(table.parentId),
    canvasIdx: index('nodes_canvas_idx').on(table.canvasId),
    statusIdx: index('nodes_status_idx').on(table.status),
    kindIdx: index('nodes_kind_idx').on(table.kind),
    branchAnchorIdx: index('nodes_branch_anchor_idx').on(table.branchAnchorId),
    // One critique child per parent. Prevents double auto-spawn.
    critiqueChildIdx: uniqueIndex('nodes_critique_per_parent_idx')
      .on(table.parentId)
      .where(sql`${table.kind} = 'critique'`),
  })
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('idle'),
    codingStartedAt: integer('coding_started_at'),
    codingFinishedAt: integer('coding_finished_at'),
    renderingStartedAt: integer('rendering_started_at'),
    renderingFinishedAt: integer('rendering_finished_at'),
    critiquingStartedAt: integer('critiquing_started_at'),
    critiquingFinishedAt: integer('critiquing_finished_at'),
    configSnapshot: text('config_snapshot', { mode: 'json' }).$type<AdapterConfigSnapshot>().notNull(),
    codeArtifactId: text('code_artifact_id'),
    /**
     * The run's primary output — the first entry of the renderer's `outputs`,
     * whatever its kind (video / image / model / page). What the UI displays.
     * `videoArtifactId` stays alongside as the *video* pointer specifically:
     * the critic and reference keyframes consume pixels, so they read the
     * video even when the primary output is a model or page. For classic
     * video-only renders the two point at the same artifact.
     */
    outputArtifactId: text('output_artifact_id'),
    videoArtifactId: text('video_artifact_id'),
    thumbnailArtifactId: text('thumbnail_artifact_id'),
    previewUrl: text('preview_url'),
    commitSha: text('commit_sha'),
    critique: text('critique', { mode: 'json' }).$type<Critique>(),
    /**
     * Coder's MESSAGE.md after parsing — populated when the coder chose to
     * talk back to the artist (impossibility, question, note). When the
     * message's `producedArtifact` is false the orchestrator also skips
     * render + critic auto-spawn for this run.
     */
    message: text('message', { mode: 'json' }).$type<CoderMessage>(),
    /**
     * Artist-typed text that triggered this run: either a reply from the
     * message thread or a prompt supplied with Retry. (Plain create/continue
     * runs leave it null.) Used in the UI thread to render the artist's side
     * of the conversation alongside the coder's MESSAGE.md outputs. Also fed
     * to the coder adapter — as the next turn on a resumed session, or folded
     * into the composed instruction on a fresh one.
     */
    artistFollowUp: text('artist_follow_up'),
    costUsd: real('cost_usd'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /**
     * Cache-token breakdown rolled up alongside tokensIn/tokensOut. Kept
     * separate because `tokensIn` is the *uncached* prompt input only — with
     * prompt caching most of the real context lands here, so display must add
     * these back to show a meaningful "input" figure. Null when the adapter
     * has no cache visibility.
     */
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    error: text('error', { mode: 'json' }).$type<RunError>(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    nodeIdx: index('runs_node_idx').on(table.nodeId),
    statusIdx: index('runs_status_idx').on(table.status),
  })
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    runIdx: index('artifacts_run_idx').on(table.runId),
  })
);

/**
 * Artist-provided references attached to a coder node — images (pasted /
 * dropped) and snapshots of other runs (by run id). Materialized into the
 * node's worktree under `references/` before each coder run and named in the
 * fresh-session instruction. Bytes live outside the DB: uploads under
 * `runs/.references/uploads/`, run snapshots cached under
 * `runs/.references/cache/`. Rows are copied (not shared) when a fork/continue
 * inherits its ancestor coder's references, so removal on a child is local.
 */
export const nodeReferences = sqliteTable(
  'node_references',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    kind: text('kind').$type<'image' | 'run'>().notNull(),
    /** kind='run': the source run this points at (its commit + video). */
    sourceRunId: text('source_run_id'),
    /** kind='image': absolute path to the uploaded file on disk. */
    filePath: text('file_path'),
    /** kind='image': mime type of the uploaded file. */
    mime: text('mime'),
    /** Human label snapshot — shown in the UI and in the coder's prompt. */
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    nodeIdx: index('node_references_node_idx').on(table.nodeId),
  })
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    ts: integer('ts').notNull(),
    payload: text('payload', { mode: 'json' }).$type<EventPayload>().notNull(),
  },
  (table) => ({
    runTsIdx: index('events_run_ts_idx').on(table.runId, table.ts),
  })
);

export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type DbEvent = typeof events.$inferSelect;
export type NewDbEvent = typeof events.$inferInsert;
export type Canvas = typeof canvases.$inferSelect;
export type NewCanvas = typeof canvases.$inferInsert;
export type NodeReference = typeof nodeReferences.$inferSelect;
export type NewNodeReference = typeof nodeReferences.$inferInsert;
export type ReferenceKind = NodeReference['kind'];
