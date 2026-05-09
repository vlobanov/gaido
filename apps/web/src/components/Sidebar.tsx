import { useState } from 'react';
import {
  GitBranch,
  RefreshCw,
  Trash2,
  Star,
  X,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import type { NodeStatus } from '@gaido/core';
import { trpc } from '../lib/trpc';
import { httpUrl } from '../lib/url';
import { useUiStore } from '../store';
import { StatusBadge, isActiveStatus } from './StatusBadge';
import { EventStream } from './EventStream';

interface SidebarProps {
  nodeId: string;
}

const RETRYABLE: ReadonlySet<NodeStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

export function Sidebar({ nodeId }: SidebarProps) {
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const node = nodeQuery.data?.node;
  const currentRun = nodeQuery.data?.currentRun;

  const setFavorite = trpc.nodes.setFavorite.useMutation({
    onSuccess: () => {
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
    },
  });

  const retryNode = trpc.nodes.retry.useMutation({
    onSuccess: () => {
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
    },
  });

  const deleteNode = trpc.nodes.delete.useMutation({
    onSuccess: () => {
      utils.nodes.list.invalidate();
      setSelectedNodeId(null);
    },
  });

  const refreshNodeState = () => {
    utils.nodes.get.invalidate({ nodeId });
    utils.nodes.list.invalidate();
  };

  if (nodeQuery.isLoading) {
    return (
      <SidebarShell onClose={() => setSelectedNodeId(null)}>
        <div className="p-4 text-sm text-zinc-500">Loading...</div>
      </SidebarShell>
    );
  }

  if (!node) {
    return (
      <SidebarShell onClose={() => setSelectedNodeId(null)}>
        <div className="p-4 text-sm text-zinc-500">Node not found.</div>
      </SidebarShell>
    );
  }

  const status = node.status as NodeStatus;
  const active = isActiveStatus(status);
  const canRetry = RETRYABLE.has(status);

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-5 p-4">
        <div className="flex items-center justify-between">
          <StatusBadge status={status} size="md" />
          <button
            type="button"
            onClick={() =>
              setFavorite.mutate({ nodeId, isFavorite: !node.isFavorite })
            }
            className={`rounded p-1 transition-colors ${
              node.isFavorite
                ? 'text-amber-400 hover:text-amber-300'
                : 'text-zinc-600 hover:text-zinc-400'
            }`}
            aria-label={node.isFavorite ? 'Unfavorite' : 'Favorite'}
          >
            <Star
              className="h-4 w-4"
              fill={node.isFavorite ? 'currentColor' : 'none'}
            />
          </button>
        </div>

        <Section label="Instruction">
          <p className="whitespace-pre-wrap text-sm text-zinc-200">
            {node.instruction || (
              <span className="italic text-zinc-500">No instruction</span>
            )}
          </p>
        </Section>

        <RunDetails nodeId={nodeId} runId={node.currentRunId ?? null} />

        {active && node.currentRunId ? (
          <Section label="Live events">
            <EventStream
              runId={node.currentRunId}
              onEvent={refreshNodeState}
            />
          </Section>
        ) : null}

        <Section label="Output">
          <OutputPanel
            videoArtifactId={currentRun?.videoArtifactId ?? null}
            thumbnailArtifactId={currentRun?.thumbnailArtifactId ?? null}
          />
        </Section>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => setForkOpen(true)}
            data-testid="sidebar-fork"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
          >
            <GitBranch className="h-3.5 w-3.5" /> Fork
          </button>
          <button
            type="button"
            disabled={!canRetry || retryNode.isPending}
            onClick={() => retryNode.mutate({ nodeId })}
            data-testid="sidebar-retry"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-testid="sidebar-delete"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950 hover:border-red-900"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>

        {retryNode.error ? (
          <p className="text-xs text-red-400">{retryNode.error.message}</p>
        ) : null}
      </div>

      {forkOpen ? (
        <ForkModal
          parentId={nodeId}
          onClose={() => setForkOpen(false)}
          onCreated={(newId) => {
            utils.nodes.list.invalidate();
            setSelectedNodeId(newId);
            setForkOpen(false);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete node?"
          description="This permanently removes the node and its descendants. This cannot be undone."
          confirmLabel="Delete"
          danger
          loading={deleteNode.isPending}
          onConfirm={() => deleteNode.mutate({ nodeId })}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </SidebarShell>
  );
}

function SidebarShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-[380px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Node
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

function OutputPanel({
  videoArtifactId,
  thumbnailArtifactId,
}: {
  videoArtifactId: string | null;
  thumbnailArtifactId: string | null;
}) {
  if (videoArtifactId) {
    return (
      <video
        data-testid="output-video"
        className="aspect-square w-full rounded border border-zinc-800 bg-black"
        src={`${httpUrl}/artifacts/${videoArtifactId}`}
        poster={
          thumbnailArtifactId
            ? `${httpUrl}/artifacts/${thumbnailArtifactId}`
            : undefined
        }
        controls
        loop
        muted
        playsInline
      />
    );
  }
  if (thumbnailArtifactId) {
    return (
      <img
        data-testid="output-thumbnail"
        className="aspect-square w-full rounded border border-zinc-800 bg-black object-contain"
        src={`${httpUrl}/artifacts/${thumbnailArtifactId}`}
        alt="Render thumbnail"
      />
    );
  }
  return (
    <div className="flex aspect-square items-center justify-center rounded border border-dashed border-zinc-800 bg-zinc-950 text-xs text-zinc-500">
      Video will appear here when render completes
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </h4>
      {children}
    </section>
  );
}

function RunDetails({
  nodeId,
  runId,
}: {
  nodeId: string;
  runId: string | null;
}) {
  const runQuery = trpc.runs.get.useQuery(
    { runId: runId ?? '' },
    { enabled: !!runId }
  );
  void nodeId;
  if (!runId) return null;
  const run = runQuery.data?.run;
  if (!run) return null;

  return (
    <Section label="Current run">
      <div className="space-y-1 text-xs text-zinc-400">
        <Timestamp label="Coding" started={run.codingStartedAt} finished={run.codingFinishedAt} />
        <Timestamp label="Rendering" started={run.renderingStartedAt} finished={run.renderingFinishedAt} />
        <Timestamp label="Critiquing" started={run.critiquingStartedAt} finished={run.critiquingFinishedAt} />
      </div>

      {run.error ? (
        <div
          data-testid="error-panel"
          className="mt-2 flex items-start gap-2 rounded border border-red-900/40 bg-red-950/30 p-2 text-xs text-red-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">{run.error.phase} failed</div>
            <div className="text-red-400/80">{run.error.message}</div>
          </div>
        </div>
      ) : null}

      {run.critique ? (
        <div
          data-testid="critique-panel"
          className="mt-2 rounded border border-zinc-800 bg-zinc-900/50 p-2.5 text-xs text-zinc-300 space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Critique
            </span>
            {typeof run.critique.rating === 'number' ? (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {run.critique.rating}/5
              </span>
            ) : null}
          </div>
          <p className="text-zinc-200">{run.critique.overall}</p>
          {run.critique.suggestions.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-zinc-400">
              {run.critique.suggestions.slice(0, 3).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

function Timestamp({
  label,
  started,
  finished,
}: {
  label: string;
  started: number | null | undefined;
  finished: number | null | undefined;
}) {
  if (!started) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <Clock className="h-3 w-3 text-zinc-600" />
      <span className="w-16 text-zinc-500">{label}</span>
      <span className="text-zinc-300">
        {fmt(started)}
        {finished ? <span className="text-zinc-500"> → {fmt(finished)}</span> : null}
      </span>
    </div>
  );
}

function fmt(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function ForkModal({
  parentId,
  onClose,
  onCreated,
}: {
  parentId: string;
  onClose: () => void;
  onCreated: (newId: string) => void;
}) {
  const [tweak, setTweak] = useState('');
  const createChild = trpc.nodes.createChild.useMutation({
    onSuccess: (data) => onCreated(data.node.id),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = tweak.trim();
    if (!trimmed) return;
    createChild.mutate({ parentId, instruction: trimmed });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="fork-form"
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-100">Fork node</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          What should we tweak?
        </label>
        <textarea
          autoFocus
          rows={3}
          value={tweak}
          onChange={(e) => setTweak(e.target.value)}
          placeholder="Make it slower and add a noise overlay..."
          data-testid="fork-input"
          className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-600"
        />
        {createChild.error ? (
          <p className="mt-2 text-xs text-red-400">{createChild.error.message}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createChild.isPending || !tweak.trim()}
            data-testid="fork-submit"
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {createChild.isPending ? 'Forking...' : 'Fork'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <h3 className="mb-1 text-sm font-medium text-zinc-100">{title}</h3>
        <p className="mb-4 text-sm text-zinc-400">{description}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              danger
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'bg-zinc-100 text-zinc-900 hover:bg-white'
            }`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
