import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeKind, SessionPolicy } from '@vadimlobanov/gaido-core';

export interface ConfigCardData {
  id: string;
  instruction: string;
  coderName: string | null;
  resolvedCoderName: string;
  skeletonName: string | null;
  sessionPolicy: SessionPolicy | null;
  /** Kind of the parent node: 'critique' → mid-graph switch; 'instruction' → root choice. */
  parentKind: NodeKind | null;
  selected: boolean;
  [key: string]: unknown;
}

const POLICY_LABEL: Record<SessionPolicy, string> = {
  retain: 'retain session',
  reset: 'reset session',
};

/**
 * Config node — a settled marker recording a coder/skeleton choice. It appears
 * in two places, discriminated by its parent:
 * - under an `instruction` root → the initial coder+skeleton for a branch
 *   ("Coder"); shows the seeding skeleton.
 * - under a `critique` → a mid-graph coder switch ("Switch coder"); shows the
 *   session policy it wired.
 * No run, no render either way.
 */
function ConfigCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ConfigCardData;
  const isSwitch = d.parentKind === 'critique';
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
          {isSwitch ? '⇄' : '◇'}
        </span>
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          {isSwitch ? 'Switch coder' : 'Coder'}
        </span>
      </div>

      <div className="px-4 py-3">
        <p
          className="truncate font-mono text-sm text-ink"
          title={d.resolvedCoderName}
        >
          {d.resolvedCoderName}
        </p>
        {isSwitch ? (
          policy ? (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-caps text-ink-muted">
              {POLICY_LABEL[policy]}
            </p>
          ) : null
        ) : (
          <p className="mt-1 font-mono text-[10px] uppercase tracking-caps text-ink-muted">
            skeleton · {d.skeletonName ?? 'default'}
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const ConfigCard = memo(ConfigCardComponent);
