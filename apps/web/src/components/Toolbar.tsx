import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { trpc } from '../lib/trpc';
import { canvasHref } from '../lib/canvas-url';
import { CreateRootModal } from './EmptyState';

interface CanvasSummary {
  id: string;
  slug: string;
  name: string | null;
}

interface ToolbarProps {
  nodeCount: number;
  canvas: CanvasSummary;
}

export function Toolbar({ nodeCount, canvas }: ToolbarProps) {
  const [open, setOpen] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const utils = trpc.useUtils();
  const relayout = trpc.nodes.relayout.useMutation({
    onSuccess: () => utils.nodes.list.invalidate(),
  });

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = canvas.name?.trim() ? canvas.name : canvas.slug;

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
        <div ref={wrapRef} className="relative">
          <button
            type="button"
            data-testid="toolbar-canvas-button"
            onClick={() => setOpen((v) => !v)}
            className="font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Canvas &middot; {label}
          </button>
          {open ? (
            <CanvasSwitcher
              activeId={canvas.id}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </div>
        <button
          type="button"
          data-testid="toolbar-seed-root"
          onClick={() => setSeedOpen(true)}
          className="border border-sanguine bg-paper px-3 py-1 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint"
        >
          + Seed root
        </button>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          data-testid="toolbar-relayout"
          onClick={() => relayout.mutate({ canvasId: canvas.id })}
          disabled={relayout.isPending || nodeCount === 0}
          className="border border-hairline bg-paper px-3 py-1 font-mono text-xs uppercase tracking-caps text-ink-muted opacity-70 transition hover:border-hairline-deep hover:bg-paper-deep hover:text-ink hover:opacity-100 disabled:cursor-default disabled:border-hairline disabled:text-ink-faint disabled:opacity-50 disabled:hover:bg-paper disabled:hover:text-ink-faint"
        >
          {relayout.isPending ? 'Laying out…' : 'Re-layout'}
        </button>
        <span className="font-mono text-xs uppercase tracking-caps text-ink-faint">
          local · single user
        </span>
      </div>
      {seedOpen ? (
        <CreateRootModal canvas={canvas} onClose={() => setSeedOpen(false)} />
      ) : null}
    </header>
  );
}

interface CanvasSwitcherProps {
  activeId: string;
  onClose: () => void;
}

function CanvasSwitcher({ activeId, onClose }: CanvasSwitcherProps) {
  const [, setLocation] = useLocation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const utils = trpc.useUtils();
  const canvasesQuery = trpc.canvases.list.useQuery();
  const createCanvas = trpc.canvases.create.useMutation({
    onSuccess: async (row) => {
      await utils.canvases.list.invalidate();
      setLocation(canvasHref(row));
      onClose();
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    createCanvas.mutate({ name: trimmed.length > 0 ? trimmed : undefined });
  };

  const rows = canvasesQuery.data ?? [];

  return (
    <div
      data-testid="canvas-switcher"
      className="absolute left-0 top-full z-40 mt-2 min-w-[14rem] border border-hairline-deep bg-paper"
    >
      <ul className="flex flex-col py-1">
        {rows.map((row) => {
          const isActive = row.id === activeId;
          const display = row.name?.trim() ? row.name : row.slug;
          return (
            <li key={row.id}>
              <button
                type="button"
                data-testid="canvas-switcher-item"
                data-canvas-id={row.id}
                data-canvas-slug={row.slug}
                onClick={() => {
                  setLocation(canvasHref(row));
                  onClose();
                }}
                className={`flex w-full items-baseline gap-2 border-l-2 px-3 py-1.5 text-left font-mono text-xs uppercase tracking-caps transition-colors ${
                  isActive
                    ? 'border-sanguine text-sanguine'
                    : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                <span className="truncate">{display}</span>
                {row.name?.trim() ? (
                  <span className="ml-auto text-ink-faint">{row.slug}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-hairline">
        {creating ? (
          <form
            data-testid="new-canvas-form"
            onSubmit={onSubmit}
            className="flex items-center gap-2 px-3 py-2"
          >
            <input
              data-testid="new-canvas-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional name…"
              className="min-w-0 flex-1 border border-hairline bg-paper-deep px-2 py-1 font-mono text-xs text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
            />
            <button
              type="submit"
              data-testid="new-canvas-submit"
              disabled={createCanvas.isPending}
              className="border border-sanguine bg-paper px-2 py-1 font-mono text-xs uppercase tracking-caps text-sanguine hover:bg-sanguine-tint disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              data-testid="new-canvas-cancel"
              onClick={() => {
                setCreating(false);
                setName('');
              }}
              className="px-2 py-1 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-testid="canvas-switcher-new"
            onClick={() => setCreating(true)}
            className="block w-full px-3 py-1.5 text-left font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            + New canvas
          </button>
        )}
      </div>
    </div>
  );
}
