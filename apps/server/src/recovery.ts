import { schema } from '@vadimlobanov/gaido-core';
import type { NodeStatus } from '@vadimlobanov/gaido-core';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db.js';

const NON_TERMINAL: NodeStatus[] = ['running'];

/**
 * On startup, any run still in a non-terminal state was left mid-flight by a
 * crash. Mark those runs (and their owning nodes) as `interrupted`.
 */
export function recoverInterrupted(db: Db): { runs: number; nodes: number } {
  const now = Date.now();

  const stuckRuns = db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.status, NON_TERMINAL))
    .all();

  if (stuckRuns.length === 0) return { runs: 0, nodes: 0 };

  const runIds = stuckRuns.map((r) => r.id);
  const nodeIds = Array.from(new Set(stuckRuns.map((r) => r.nodeId)));

  db.update(schema.runs)
    .set({ status: 'interrupted', updatedAt: now })
    .where(inArray(schema.runs.id, runIds))
    .run();

  // Mirror to nodes: only flip a node if its current_run_id is in the stuck set,
  // OR its status is non-terminal (defensive: nodes should mirror runs).
  for (const nodeId of nodeIds) {
    const node = db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    if (!node) continue;
    if (
      node.currentRunId &&
      runIds.includes(node.currentRunId)
    ) {
      db.update(schema.nodes)
        .set({ status: 'interrupted', updatedAt: now })
        .where(eq(schema.nodes.id, nodeId))
        .run();
    } else if (NON_TERMINAL.includes(node.status)) {
      db.update(schema.nodes)
        .set({ status: 'interrupted', updatedAt: now })
        .where(eq(schema.nodes.id, nodeId))
        .run();
    }
  }

  return { runs: runIds.length, nodes: nodeIds.length };
}
