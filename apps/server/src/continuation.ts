import { schema, nodeId as newNodeId, critiqueFeedback } from '@vadimlobanov/gaido-core';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db.js';
import type { Paths } from './paths.js';
import type { WorkspaceManager } from './workspace.js';
import { inheritReferences } from './references.js';
import { critiqueCardHeight, nextChildY, SIBLING_X_STEP } from './layout.js';

export interface ContinuationDeps {
  db: Db;
  paths: Paths;
  workspace: WorkspaceManager;
}

export type ContinuationResult =
  | { ok: true; coderId: string }
  | { ok: false; reason: 'missing' | 'not-critique' | 'no-parent' | 'no-feedback' };

/**
 * Spawn the next coder by continuing from a critique — the shared core of the
 * `continue` mutation and the orchestrator's auto-run advance, so manual and
 * automatic iteration behave identically. The new coder sits under the
 * critique on the SAME branch as the parent coder (`branchAnchorId` → resumed
 * session + reused worktree), carries the critique feedback as its instruction,
 * and inherits the parent coder's references. Does NOT start the run — the
 * caller owns that. `auto` seeds the new coder's auto-run budget columns when
 * continuing inside an auto-run.
 */
export function createContinuationCoder(
  deps: ContinuationDeps,
  critiqueNodeId: string,
  auto?: { total: number; remaining: number }
): ContinuationResult {
  const { db } = deps;
  const critique = db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, critiqueNodeId))
    .get();
  if (!critique) return { ok: false, reason: 'missing' };
  if (critique.kind !== 'critique') return { ok: false, reason: 'not-critique' };
  if (!critique.parentId) return { ok: false, reason: 'no-parent' };

  const critiqueRun = critique.currentRunId
    ? db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, critique.currentRunId))
        .get() ?? null
    : null;
  // The next coder resumes the prior session but never saw the critique (the
  // critic is a separate agent), so the full feedback — overall plus any
  // suggestions — rides the instruction. An edited critique already folded its
  // suggestions into `overall`, so this stays a single clean block either way.
  const notes = critiqueRun?.critique
    ? critiqueFeedback(critiqueRun.critique).trim()
    : undefined;
  if (!notes) return { ok: false, reason: 'no-feedback' };

  const parentCoder = db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, critique.parentId))
    .get();
  if (!parentCoder) return { ok: false, reason: 'no-parent' };
  const anchorId = parentCoder.branchAnchorId ?? parentCoder.id;

  const id = newNodeId();
  const now = Date.now();
  const y = nextChildY(
    critique.positionY,
    critiqueCardHeight(critiqueRun?.critique)
  );
  // Spread alongside any prior siblings (forks or other continues) so a second
  // iteration from one critique doesn't land on top of the first.
  const existingChildren = db
    .select({ positionX: schema.nodes.positionX })
    .from(schema.nodes)
    .where(
      and(eq(schema.nodes.parentId, critique.id), eq(schema.nodes.kind, 'coder'))
    )
    .all();
  const rightmost = existingChildren.length
    ? Math.max(...existingChildren.map((c) => c.positionX))
    : critique.positionX - SIBLING_X_STEP;

  db.insert(schema.nodes)
    .values({
      id,
      parentId: critique.id,
      canvasId: parentCoder.canvasId,
      kind: 'coder',
      positionX: rightmost + SIBLING_X_STEP,
      positionY: y,
      instruction: notes,
      branchAnchorId: anchorId,
      status: 'idle',
      isFavorite: false,
      ...(auto
        ? { autoRunTotal: auto.total, autoRunRemaining: auto.remaining }
        : {}),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Continuing inherits the parent coder's references so iteration keeps the
  // same context.
  inheritReferences(deps, parentCoder.id, id);

  return { ok: true, coderId: id };
}
