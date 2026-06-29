import { useMemo, useState } from 'react';
import { trpc } from '../lib/trpc';
import { READ_ONLY } from '../lib/static';
import { useUiStore } from '../store';

/**
 * Minimal shape the frontier walk needs from a `nodes.list` row. Both the
 * coder and critique card data satisfy it.
 */
interface AutoRunNode {
  id: string;
  parentId: string | null;
  autoRunTotal?: number | null;
  autoRunRemaining?: number | null;
}

/**
 * The live auto-run frontier reachable from `rootId` (itself or a descendant):
 * the single node carrying a non-null `autoRunRemaining`. Mirrors the server's
 * `findAutoRunFrontier` so the sidebar can show status + interrupt from any
 * node in the chain, not just the one the loop has currently reached.
 */
export function findAutoRunFrontier<T extends AutoRunNode>(
  nodes: T[],
  rootId: string
): T | null {
  const byParent = new Map<string, T[]>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    const list = byParent.get(n.parentId);
    if (list) list.push(n);
    else byParent.set(n.parentId, [n]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.autoRunRemaining != null) return node;
    for (const k of byParent.get(id) ?? []) queue.push(k.id);
  }
  return null;
}

/** 1-based current iteration + total, derived from the remaining count. */
function progress(total: number | null | undefined, remaining: number): {
  k: number;
  n: number;
} {
  const n = total ?? remaining;
  return { k: n - remaining + 1, n };
}

/**
 * Compact "↻ k/n" chip for a node card — present only on the auto-run frontier
 * (the running node carrying the budget), so it doubles as the "this is part of
 * an auto-run" marker on the canvas.
 */
export function AutoRunBadge({
  total,
  remaining,
}: {
  total?: number | null;
  remaining?: number | null;
}) {
  if (remaining == null) return null;
  const { k, n } = progress(total, remaining);
  return (
    <span
      data-testid="auto-run-badge"
      title={`Auto-run · iteration ${k} of ${n}`}
      className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] uppercase tracking-caps text-sanguine"
    >
      <span aria-hidden>↻</span>
      {k}/{n}
    </span>
  );
}

/**
 * Auto-run sidebar panel: shows interrupt controls while a run is in flight
 * (frontier exists in this node's subtree-or-self), otherwise a starter when
 * `canStart` and the project has a model critic. One component so the two
 * states never show at once.
 */
export function AutoRunPanel({
  nodeId,
  canStart,
}: {
  nodeId: string;
  canStart: boolean;
}) {
  const nodesList = trpc.nodes.list.useQuery();
  const system = trpc.system.info.useQuery();
  const frontier = useMemo(
    () => findAutoRunFrontier(nodesList.data ?? [], nodeId),
    [nodesList.data, nodeId]
  );

  if (frontier && frontier.autoRunRemaining != null) {
    return (
      <AutoRunControls
        viewedNodeId={nodeId}
        frontierId={frontier.id}
        total={frontier.autoRunTotal}
        remaining={frontier.autoRunRemaining}
      />
    );
  }
  if (READ_ONLY || !canStart) return null;
  if (system.data?.criticKind === 'human') return null;
  return <AutoRunStarter nodeId={nodeId} />;
}

function AutoRunControls({
  viewedNodeId,
  frontierId,
  total,
  remaining,
}: {
  viewedNodeId: string;
  frontierId: string;
  total: number | null | undefined;
  remaining: number;
}) {
  const utils = trpc.useUtils();
  const interrupt = trpc.nodes.interruptAuto.useMutation({
    onSuccess: () => {
      utils.nodes.list.invalidate();
      utils.nodes.get.invalidate({ nodeId: viewedNodeId });
    },
  });
  const { k, n } = progress(total, remaining);
  const stop = (mode: 'now' | 'after') =>
    interrupt.mutate({ nodeId: frontierId, mode });

  return (
    <div
      data-testid="auto-run-controls"
      className="flex flex-col gap-2 border border-sanguine bg-sanguine-tint px-3 py-2"
    >
      <span className="font-mono text-xs uppercase tracking-caps text-sanguine">
        Auto-run · iteration {k} of {n}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={interrupt.isPending}
          onClick={() => stop('now')}
          data-testid="auto-run-stop-now"
          title="Abort the step in progress and stop"
          className="border border-sanguine bg-paper px-3 py-1.5 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
        >
          Stop now
        </button>
        <button
          type="button"
          disabled={interrupt.isPending}
          onClick={() => stop('after')}
          data-testid="auto-run-stop-after"
          title="Let the current step finish, then stop"
          className="border border-hairline-deep bg-paper px-3 py-1.5 font-mono text-xs uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper-deep disabled:opacity-40"
        >
          Stop after this
        </button>
      </div>
    </div>
  );
}

function AutoRunStarter({ nodeId }: { nodeId: string }) {
  const utils = trpc.useUtils();
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const [count, setCount] = useState(4);
  const autoRun = trpc.nodes.autoRun.useMutation({
    onSuccess: (data) => {
      utils.nodes.list.invalidate();
      utils.nodes.get.invalidate({ nodeId });
      // Follow the node the loop actually started on (a done coder forwards to
      // its critique child), so the artist watches it advance.
      setSelectedNodeId(data.nodeId);
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2" data-testid="auto-run-starter">
        <label className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Run automatically
        </label>
        <input
          type="number"
          min={2}
          max={50}
          value={count}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            setCount(Number.isFinite(v) ? Math.min(50, Math.max(2, v)) : 2);
          }}
          data-testid="auto-run-count"
          className="w-14 border border-hairline bg-paper-deep px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-hairline-deep"
        />
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          ×
        </span>
        <button
          type="button"
          disabled={autoRun.isPending}
          onClick={() => autoRun.mutate({ nodeId, iterations: count })}
          data-testid="auto-run-start"
          title="Run code → critique → continue automatically this many times"
          className="border border-sanguine bg-paper px-3 py-1.5 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
        >
          {autoRun.isPending ? 'Starting…' : 'Go'}
        </button>
      </div>
      {autoRun.error ? (
        <span className="font-mono text-xs text-sanguine">
          {autoRun.error.message}
        </span>
      ) : null}
    </div>
  );
}
