import { useEffect } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import type { PersistedEvent } from '@vadimlobanov/gaido-core';
import { trpc } from './lib/trpc';
import { useUiStore } from './store';
import { Graph } from './components/Graph';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { EmptyState } from './components/EmptyState';
import { DebugBridge } from './lib/debug';
import { canvasHref, parseIdentifier } from './lib/canvas-url';
import { STATIC_MODE, EMBED, getSnapshot } from './lib/static';

export function App() {
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const [, setLocation] = useLocation();
  const [matched, params] = useRoute<{ identifier: string }>('/c/:identifier');

  // Published mode: a single embedded canvas, rendered directly — no routing,
  // no redirect — so the page stays at its `/<slug>` URL and survives a reload
  // with no server behind it.
  if (STATIC_MODE) {
    const c = getSnapshot().canvas;
    return (
      <CanvasShell
        identifier={`${c.slug}-${c.id}`}
        selectedNodeId={selectedNodeId}
        setLocation={() => {}}
      />
    );
  }

  return matched ? (
    <CanvasShell
      identifier={params.identifier}
      selectedNodeId={selectedNodeId}
      setLocation={setLocation}
    />
  ) : (
    <RootRedirect setLocation={setLocation} />
  );
}

interface RootRedirectProps {
  setLocation: (to: string, opts?: { replace?: boolean }) => void;
}

function RootRedirect({ setLocation }: RootRedirectProps) {
  const canvasesQuery = trpc.canvases.list.useQuery();
  const first = canvasesQuery.data?.[0];

  useEffect(() => {
    if (first) {
      setLocation(canvasHref(first), { replace: true });
    }
  }, [first, setLocation]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-paper font-mono text-xs uppercase tracking-caps text-ink-muted">
      {canvasesQuery.isError
        ? `Failed to load canvases: ${canvasesQuery.error.message}`
        : 'Loading'}
    </div>
  );
}

interface CanvasShellProps {
  identifier: string;
  selectedNodeId: string | null;
  setLocation: (to: string, opts?: { replace?: boolean }) => void;
}

function CanvasShell({ identifier, selectedNodeId, setLocation }: CanvasShellProps) {
  const parsed = parseIdentifier(identifier);

  const byIdQuery = trpc.canvases.get.useQuery(
    { id: parsed.id! },
    { enabled: parsed.id != null }
  );
  const bySlugQuery = trpc.canvases.get.useQuery(
    { slug: parsed.slug! },
    { enabled: parsed.id == null && parsed.slug != null }
  );

  const canvasQuery = parsed.id != null ? byIdQuery : bySlugQuery;
  const canvas = canvasQuery.data ?? null;

  useEffect(() => {
    if (canvas && parsed.slug && canvas.slug !== parsed.slug) {
      setLocation(canvasHref(canvas), { replace: true });
    }
  }, [canvas, parsed.slug, setLocation]);

  const nodesQuery = trpc.nodes.list.useQuery(
    { canvasId: canvas?.id ?? '' },
    { enabled: canvas != null }
  );
  const nodes = nodesQuery.data ?? [];

  // Out-of-band node writes — `gaido note` / `gaido meta` from the CLI or a
  // project's own server — publish a `node_updated` event on the canvas.
  // Nothing else refetches for them (the per-card live subscription only
  // exists while a run is in flight), so listen canvas-wide here.
  const utils = trpc.useUtils();
  trpc.events.subscribe.useSubscription(
    { canvasId: canvas?.id ?? '' },
    {
      enabled: canvas != null,
      onData: (event: PersistedEvent) => {
        if (event.payload.kind === 'node_updated') {
          void utils.nodes.list.invalidate();
          void utils.nodes.get.invalidate({ nodeId: event.payload.nodeId });
        }
      },
    }
  );

  if (canvasQuery.isLoading && !canvasQuery.data) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper font-mono text-xs uppercase tracking-caps text-ink-muted">
        Loading
      </div>
    );
  }
  if (canvasQuery.isError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper px-6 font-mono text-xs uppercase tracking-caps text-sanguine">
        Failed to load canvas: {canvasQuery.error.message}
      </div>
    );
  }
  if (!canvas) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper font-mono text-xs uppercase tracking-caps text-ink-muted">
        Canvas not found.{' '}
        <Link href="/" className="ml-2 text-sanguine underline">
          Go to default
        </Link>
      </div>
    );
  }

  const isInitialNodesLoad = nodesQuery.isLoading && !nodesQuery.data;

  return (
    <div className="flex h-full w-full flex-col bg-paper text-ink">
      {!STATIC_MODE && <DebugBridge canvasId={canvas.id} />}
      {!EMBED && <Toolbar nodeCount={nodes.length} canvas={canvas} />}
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {isInitialNodesLoad ? (
            <div className="flex h-full items-center justify-center font-mono text-xs uppercase tracking-caps text-ink-muted">
              Loading
            </div>
          ) : nodesQuery.isError ? (
            <div className="flex h-full items-center justify-center px-6 font-mono text-xs uppercase tracking-caps text-sanguine">
              Failed to load nodes: {nodesQuery.error.message}
            </div>
          ) : nodes.length === 0 ? (
            <EmptyState canvas={canvas} />
          ) : (
            <Graph nodes={nodes} />
          )}
        </main>
        {selectedNodeId ? <Sidebar nodeId={selectedNodeId} /> : null}
      </div>
    </div>
  );
}
