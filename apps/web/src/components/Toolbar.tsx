interface ToolbarProps {
  nodeCount: number;
}

export function Toolbar({ nodeCount }: ToolbarProps) {
  return (
    <header
      data-testid="toolbar"
      className="flex h-11 shrink-0 items-center justify-between border-b border-hairline bg-paper px-5"
    >
      <div className="flex items-baseline gap-3">
        <span className="font-serif text-base text-ink">Gaido</span>
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          {String(nodeCount).padStart(2, '0')} {nodeCount === 1 ? 'node' : 'nodes'}
        </span>
      </div>
      <div className="font-mono text-xs uppercase tracking-caps text-ink-faint">
        local · single user
      </div>
    </header>
  );
}
