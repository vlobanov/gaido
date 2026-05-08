import { Workflow } from 'lucide-react';

interface ToolbarProps {
  nodeCount: number;
}

export function Toolbar({ nodeCount }: ToolbarProps) {
  return (
    <header
      data-testid="toolbar"
      className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4"
    >
      <div className="flex items-center gap-2">
        <Workflow className="h-4 w-4 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-200">Gaido</span>
        <span className="text-xs text-zinc-600">·</span>
        <span className="text-xs text-zinc-500">
          {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
        </span>
      </div>
      <div className="text-xs text-zinc-600">local-first</div>
    </header>
  );
}
