import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Star } from 'lucide-react';
import type { NodeStatus } from '@gaido/core';
import { StatusBadge, isActiveStatus } from './StatusBadge';
import { trpc } from '../lib/trpc';

export interface NodeCardData {
  id: string;
  instruction: string;
  status: NodeStatus;
  isFavorite: boolean;
  selected: boolean;
  [key: string]: unknown;
}

const ACTIVE_RING: Record<NodeStatus, string> = {
  pending: '',
  queued: '',
  coding: 'shadow-[0_0_0_1px_rgba(245,158,11,0.5)] animate-pulse-soft',
  rendering: 'shadow-[0_0_0_1px_rgba(99,102,241,0.5)] animate-pulse-soft',
  critiquing: 'shadow-[0_0_0_1px_rgba(139,92,246,0.5)] animate-pulse-soft',
  done: '',
  failed: '',
  cancelled: '',
  interrupted: '',
};

function NodeCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as NodeCardData;
  const utils = trpc.useUtils();
  const setFavorite = trpc.nodes.setFavorite.useMutation({
    onSuccess: () => utils.nodes.list.invalidate(),
  });

  const active = isActiveStatus(d.status);

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-status={d.status}
      data-favorite={String(d.isFavorite)}
      className={`relative w-64 rounded-lg border bg-zinc-900 transition-colors ${
        selected
          ? 'border-zinc-600 ring-1 ring-zinc-500'
          : 'border-zinc-800 hover:border-zinc-700'
      } ${ACTIVE_RING[d.status]}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-600 !border-zinc-900"
      />
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <StatusBadge status={d.status} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setFavorite.mutate({ nodeId: d.id, isFavorite: !d.isFavorite });
          }}
          data-testid="node-favorite-toggle"
          className={`rounded p-0.5 transition-colors ${
            d.isFavorite
              ? 'text-amber-400 hover:text-amber-300'
              : 'text-zinc-600 hover:text-zinc-400'
          }`}
          aria-label={d.isFavorite ? 'Unfavorite' : 'Favorite'}
        >
          <Star
            className="h-3.5 w-3.5"
            fill={d.isFavorite ? 'currentColor' : 'none'}
          />
        </button>
      </div>

      <div className="px-3 py-2">
        <p
          className="text-sm leading-snug text-zinc-200"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={d.instruction}
        >
          {d.instruction || <span className="text-zinc-500 italic">No instruction</span>}
        </p>
      </div>

      {active ? (
        <div className="border-t border-zinc-800 px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <span className="h-1 w-1 rounded-full bg-zinc-400 animate-pulse-soft" />
            {d.status === 'coding' ? 'Generating code' : null}
            {d.status === 'rendering' ? 'Rendering video' : null}
            {d.status === 'critiquing' ? 'Critiquing output' : null}
          </div>
        </div>
      ) : null}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-600 !border-zinc-900"
      />
    </div>
  );
}

export const NodeCard = memo(NodeCardComponent);
