import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { NodeStatus, NodeKind, RunStatus, ArtifactKind, Critique, RunError, AdapterConfigSnapshot } from './types.js';
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
     * Skeleton preset name. Only meaningful on root coders — names a folder
     * under `<projectDir>/skeletons/` or `~/.gaido/skeletons/` that seeds the
     * worktree. NULL → `'default'`. Forks inherit via branch lineage and
     * leave this NULL.
     */
    skeletonName: text('skeleton_name'),
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
     * Artist's reply that triggered this run, when the run was kicked off
     * from the message thread (not from create/retry/continue). Used in the
     * UI thread to render the artist's side of the conversation alongside
     * the coder's MESSAGE.md outputs. Also passed to the coder adapter as
     * the next turn in the resumed session.
     */
    artistFollowUp: text('artist_follow_up'),
    costUsd: real('cost_usd'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
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
