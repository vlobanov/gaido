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

const TONE: Record<NodeStatus, string> = {
  pending: 'text-ink-muted',
  queued: 'text-ink-muted',
  coding: 'text-ink',
  rendering: 'text-ink',
  critiquing: 'text-ink',
  done: 'text-ink',
  failed: 'text-sanguine',
  cancelled: 'text-ink-faint',
  interrupted: 'text-ink-faint',
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
  const sizeCls = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center font-mono uppercase tracking-caps ${sizeCls} ${TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
