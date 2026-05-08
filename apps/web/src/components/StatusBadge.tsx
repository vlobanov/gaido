import type { NodeStatus } from '@gaido/core';

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'Pending',
  queued: 'Queued',
  coding: 'Coding',
  rendering: 'Rendering',
  critiquing: 'Critiquing',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const STATUS_DOT: Record<NodeStatus, string> = {
  pending: 'bg-zinc-500',
  queued: 'bg-blue-500',
  coding: 'bg-amber-500',
  rendering: 'bg-indigo-500',
  critiquing: 'bg-violet-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-zinc-400',
  interrupted: 'bg-orange-500',
};

const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: 'text-zinc-400',
  queued: 'text-blue-400',
  coding: 'text-amber-400',
  rendering: 'text-indigo-400',
  critiquing: 'text-violet-400',
  done: 'text-emerald-400',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
  interrupted: 'text-orange-400',
};

const ACTIVE: ReadonlySet<NodeStatus> = new Set(['coding', 'rendering', 'critiquing']);

export function isActiveStatus(s: NodeStatus): boolean {
  return ACTIVE.has(s);
}

interface StatusBadgeProps {
  status: NodeStatus;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const active = isActiveStatus(status);
  const sizeCls = size === 'md' ? 'text-xs px-2 py-0.5' : 'text-[10px] px-1.5 py-0.5';
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded ${sizeCls} font-medium uppercase tracking-wide ${STATUS_TEXT[status]} bg-zinc-900/80 border border-zinc-800`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]} ${active ? 'animate-pulse-soft' : ''}`}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
