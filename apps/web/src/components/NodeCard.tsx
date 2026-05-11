import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeStatus } from '@gaido/core';
import { StatusBadge, isActiveStatus } from './StatusBadge';
import { trpc } from '../lib/trpc';
import { httpUrl } from '../lib/url';

export interface NodeCardData {
  id: string;
  instruction: string;
  status: NodeStatus;
  isFavorite: boolean;
  currentRunId: string | null;
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
  selected: boolean;
  [key: string]: unknown;
}

const PHASE_TICKS: Record<NodeStatus, number> = {
  pending: 0,
  queued: 0,
  coding: 1,
  rendering: 2,
  critiquing: 2,
  done: 3,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
};

const FAILED_LIKE: ReadonlySet<NodeStatus> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

function NodeCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as NodeCardData;
  const utils = trpc.useUtils();
  const setFavorite = trpc.nodes.setFavorite.useMutation({
    onSuccess: () => utils.nodes.list.invalidate(),
  });

  const active = isActiveStatus(d.status);
  const done = d.status === 'done';
  const failed = FAILED_LIKE.has(d.status);

  const borderCls = selected
    ? 'border-sanguine'
    : active
      ? 'border-hairline animate-breathe-edge'
      : 'border-hairline hover:border-hairline-deep';

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-status={d.status}
      data-favorite={String(d.isFavorite)}
      className={`group w-64 border bg-paper transition-colors ${borderCls}`}
    >
      <Handle type="target" position={Position.Top} />

      <Frame
        status={d.status}
        thumbnailArtifactId={d.thumbnailArtifactId}
        videoArtifactId={d.videoArtifactId}
      />

      <div className="border-t border-hairline px-4 pb-3 pt-3">
        {d.instruction ? (
          <p
            className="font-serif text-base leading-snug text-ink"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={d.instruction}
          >
            {d.instruction}
          </p>
        ) : (
          <p className="font-serif text-base italic text-ink-faint">
            no instruction
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <PhaseTicks status={d.status} active={active} done={done} failed={failed} />
          <StatusBadge status={d.status} />
        </div>
        <FavoriteToggle
          isFavorite={d.isFavorite}
          onToggle={() =>
            setFavorite.mutate({ nodeId: d.id, isFavorite: !d.isFavorite })
          }
        />
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function Frame({
  status,
  thumbnailArtifactId,
  videoArtifactId,
}: {
  status: NodeStatus;
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
}) {
  const failed = FAILED_LIKE.has(status);
  const done = status === 'done';
  const posterId = thumbnailArtifactId ?? videoArtifactId;

  if (done && posterId) {
    return (
      <div className="relative aspect-square w-full overflow-hidden">
        <img
          src={`${httpUrl}/artifacts/${posterId}`}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div
      className="relative aspect-square w-full bg-hatch"
      aria-hidden
    >
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-2xl text-sanguine">×</span>
        </div>
      ) : null}
    </div>
  );
}

function PhaseTicks({
  status,
  active,
  done,
  failed,
}: {
  status: NodeStatus;
  active: boolean;
  done: boolean;
  failed: boolean;
}) {
  const filled = PHASE_TICKS[status];
  return (
    <div
      className="inline-flex items-center gap-1"
      aria-label={`phase ${filled} of 3`}
    >
      {[0, 1, 2].map((i) => {
        const isFilled = i < filled;
        const isLiveActive = active && i === filled;
        let tickCls: string;
        if (isFilled) {
          tickCls = done ? 'bg-ink' : 'bg-ink';
        } else if (isLiveActive) {
          tickCls = 'animate-breathe-tick';
        } else if (failed) {
          tickCls = 'bg-ink-faint';
        } else {
          tickCls = 'bg-hairline-deep';
        }
        return (
          <span
            key={i}
            className={`block h-[2px] w-3 ${tickCls}`}
          />
        );
      })}
    </div>
  );
}

function FavoriteToggle({
  isFavorite,
  onToggle,
}: {
  isFavorite: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      data-testid="node-favorite-toggle"
      aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
      aria-pressed={isFavorite}
      className="shrink-0 p-0.5"
    >
      <span
        aria-hidden
        className={`block h-3 w-[3px] ${
          isFavorite ? 'bg-sanguine' : 'bg-transparent border-l border-hairline-deep'
        }`}
      />
    </button>
  );
}

export const NodeCard = memo(NodeCardComponent);
