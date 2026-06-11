import type { NodeStatus } from '@vadimlobanov/gaido-core';

const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const TONE: Record<NodeStatus, string> = {
  idle: 'text-ink-muted',
  running: 'text-ink',
  done: 'text-ink',
  failed: 'text-sanguine',
  cancelled: 'text-ink-faint',
  interrupted: 'text-ink-faint',
};

const ACTIVE: ReadonlySet<NodeStatus> = new Set(['running']);

export function isActiveStatus(s: NodeStatus): boolean {
  return ACTIVE.has(s);
}

/**
 * Phase timing fields needed to derive a running node's display label.
 * Pass the node's currentRun timings; null/undefined for nodes with no run.
 */
export interface PhaseTiming {
  codingStartedAt?: number | null;
  codingFinishedAt?: number | null;
  renderingStartedAt?: number | null;
  renderingFinishedAt?: number | null;
  critiquingStartedAt?: number | null;
  critiquingFinishedAt?: number | null;
}

/**
 * Derive the active phase from run timing columns. Returns null if no phase
 * is currently in flight (i.e., none started, or all finished).
 */
export function activePhase(
  timing: PhaseTiming | null | undefined
): 'coding' | 'rendering' | 'critiquing' | null {
  if (!timing) return null;
  if (timing.critiquingStartedAt && !timing.critiquingFinishedAt) return 'critiquing';
  if (timing.renderingStartedAt && !timing.renderingFinishedAt) return 'rendering';
  if (timing.codingStartedAt && !timing.codingFinishedAt) return 'coding';
  return null;
}

const PHASE_LABEL: Record<'coding' | 'rendering' | 'critiquing', string> = {
  coding: 'Coding',
  rendering: 'Rendering',
  critiquing: 'Critiquing',
};

/**
 * Compute the badge label for a node. Translates `running` to a phase-aware
 * label using timing columns from `nodes.list`.
 */
export function statusLabel(
  status: NodeStatus,
  timing: PhaseTiming | null | undefined
): string {
  if (status !== 'running') return STATUS_LABEL[status];
  const phase = activePhase(timing);
  if (phase) return PHASE_LABEL[phase];
  // Running with no phase in flight = waiting for a concurrency slot
  // (`concurrency` in gaido.config.ts) — either before the first phase or
  // between coding and rendering. Without a backlog this shows only for the
  // instant between startRun and the first phase stamp.
  return 'Queued';
}

interface StatusBadgeProps {
  status: NodeStatus;
  timing?: PhaseTiming | null;
  size?: 'sm' | 'md';
}

export function StatusBadge({
  status,
  timing = null,
  size = 'sm',
}: StatusBadgeProps) {
  const sizeCls = size === 'md' ? 'text-sm' : 'text-xs';
  const label = statusLabel(status, timing);
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center font-mono uppercase tracking-caps ${sizeCls} ${TONE[status]}`}
    >
      {label}
    </span>
  );
}
