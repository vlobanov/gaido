import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeStatus } from '@vadimlobanov/gaido-core';
import { StatusBadge, isActiveStatus, type PhaseTiming } from './StatusBadge';
import { trpc } from '../lib/trpc';

export interface CritiqueCardData extends PhaseTiming {
  id: string;
  instruction: string;
  status: NodeStatus;
  isFavorite: boolean;
  currentRunId: string | null;
  selected: boolean;
  [key: string]: unknown;
}

const FAILED_LIKE: ReadonlySet<NodeStatus> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

function CritiqueCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as CritiqueCardData;
  const utils = trpc.useUtils();
  const retryNode = trpc.nodes.retry.useMutation({
    onSuccess: () => utils.nodes.list.invalidate(),
  });
  const systemQuery = trpc.system.info.useQuery();
  const isHumanCritic = systemQuery.data?.criticKind === 'human';

  const active = isActiveStatus(d.status);
  const idle = d.status === 'idle';
  const done = d.status === 'done';
  const failed = FAILED_LIKE.has(d.status);

  const borderCls = selected
    ? 'border-sanguine'
    : active
      ? 'border-hairline animate-breathe-edge'
      : 'border-hairline hover:border-hairline-deep';

  const runQuery = trpc.runs.get.useQuery(
    { runId: d.currentRunId ?? '' },
    { enabled: !!d.currentRunId && done }
  );
  const critique = runQuery.data?.run?.critique ?? null;

  const onRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    retryNode.mutate({ nodeId: d.id });
  };

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-node-kind="critique"
      data-status={d.status}
      data-favorite={String(d.isFavorite)}
      className={`group w-64 border bg-paper transition-colors ${borderCls}`}
    >
      <Handle type="target" position={Position.Top} />

      <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Critique
        </span>
        <StatusBadge status={d.status} timing={d} />
      </div>

      <div className="min-h-[5rem] px-4 py-3">
        {idle ? (
          isHumanCritic ? (
            <p
              data-testid="critique-empty-human"
              className="font-serif text-sm italic text-ink-faint"
            >
              Click to add notes
            </p>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={retryNode.isPending}
              data-testid="critique-run"
              className="w-full border border-dashed border-hairline-deep bg-paper-deep px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper disabled:opacity-40"
            >
              {retryNode.isPending ? 'Starting...' : 'Run critic'}
            </button>
          )
        ) : active ? (
          <p className="font-serif text-sm italic text-ink-soft">
            Evaluating…
          </p>
        ) : done && critique ? (
          <>
            <p
              className="font-serif text-sm leading-snug text-ink"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 10,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              title={critique.overall}
            >
              {critique.overall}
            </p>
            {typeof critique.rating === 'number' ? (
              <p className="mt-2 font-mono text-xs uppercase tracking-caps text-ink-muted">
                {critique.rating} of 5
              </p>
            ) : null}
          </>
        ) : failed ? (
          <p className="font-mono text-xs uppercase tracking-caps text-sanguine">
            × critic failed
          </p>
        ) : (
          <p className="font-serif text-sm italic text-ink-faint">
            No critique yet
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const CritiqueCard = memo(CritiqueCardComponent);
