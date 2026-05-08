import { trpc } from './lib/trpc';
import { useUiStore } from './store';
import { Graph } from './components/Graph';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { EmptyState } from './components/EmptyState';
import { DebugBridge } from './lib/debug';

export function App() {
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);

  // Live updates come from the global event subscription in <DebugBridge />,
  // which invalidates this query on phase_start/phase_end/error events.
  const nodesQuery = trpc.nodes.list.useQuery();
  const nodes = nodesQuery.data ?? [];

  const isInitialLoad = nodesQuery.isLoading && !nodesQuery.data;

  return (
    <div className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
      <DebugBridge />
      <Toolbar nodeCount={nodes.length} />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {isInitialLoad ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Loading...
            </div>
          ) : nodesQuery.isError ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-red-400">
              Failed to load nodes: {nodesQuery.error.message}
            </div>
          ) : nodes.length === 0 ? (
            <EmptyState />
          ) : (
            <Graph nodes={nodes} />
          )}
        </main>
        {selectedNodeId ? <Sidebar nodeId={selectedNodeId} /> : null}
      </div>
    </div>
  );
}
