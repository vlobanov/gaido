import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface InstructionCardData {
  id: string;
  instruction: string;
  selected: boolean;
  [key: string]: unknown;
}

/**
 * Instruction (root) node — a settled marker holding the prompt shared by every
 * branch below it. No run, no render: the coders beneath its config markers
 * each render this instruction, so it's shown here once instead of being
 * re-echoed on every coder card. Source handle only — a root has no parent.
 */
function InstructionCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as InstructionCardData;
  const borderCls = selected
    ? 'border-sanguine'
    : 'border-hairline hover:border-hairline-deep';

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-node-kind="instruction"
      className={`group w-64 border bg-paper transition-colors ${borderCls}`}
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2">
        <span
          aria-hidden
          className="inline-flex h-4 w-4 items-center justify-center border border-hairline-deep bg-paper-deep text-[11px] text-ink"
        >
          ✎
        </span>
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Instruction
        </span>
      </div>

      <div className="px-4 py-3">
        {d.instruction ? (
          <p
            className="font-serif text-base leading-snug text-ink"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
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

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const InstructionCard = memo(InstructionCardComponent);
