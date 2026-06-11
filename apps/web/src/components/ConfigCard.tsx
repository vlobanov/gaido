import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SessionPolicy } from '@vadimlobanov/gaido-core';

export interface ConfigCardData {
  id: string;
  instruction: string;
  coderName: string | null;
  sessionPolicy: SessionPolicy | null;
  selected: boolean;
  [key: string]: unknown;
}

const POLICY_LABEL: Record<SessionPolicy, string> = {
  retain: 'retain session',
  reset: 'reset session',
};

/**
 * Config (coder-switch) node — a settled marker recording a mid-graph coder
 * change. No run, no render: it sits between a critique and the coder it
 * spawned, naming the new coder and how it treats the branch's session.
 */
function ConfigCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ConfigCardData;
  const policy = d.sessionPolicy;
  const borderCls = selected
    ? 'border-sanguine'
    : 'border-hairline hover:border-hairline-deep';

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-node-kind="config"
      className={`group w-64 border bg-paper transition-colors ${borderCls}`}
    >
      <Handle type="target" position={Position.Top} />

      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2">
        <span
          aria-hidden
          className="inline-flex h-4 w-4 items-center justify-center border border-hairline-deep bg-paper-deep text-[11px] text-ink"
        >
          ⇄
        </span>
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Switch coder
        </span>
      </div>

      <div className="px-4 py-3">
        <p
          className="truncate font-mono text-sm text-ink"
          title={d.coderName ?? undefined}
        >
          {d.coderName ?? '—'}
        </p>
        {policy ? (
          <p className="mt-1 font-mono text-[10px] uppercase tracking-caps text-ink-muted">
            {POLICY_LABEL[policy]}
          </p>
        ) : null}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const ConfigCard = memo(ConfigCardComponent);
