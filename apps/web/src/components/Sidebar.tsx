import { useState } from 'react';
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
        <div className="p-5 font-mono text-xs uppercase tracking-caps text-ink-faint">
          Loading
        </div>
      </SidebarShell>
    );
  }

  if (!node) {
    return (
      <SidebarShell onClose={() => setSelectedNodeId(null)}>
        <div className="p-5 font-mono text-xs uppercase tracking-caps text-ink-faint">
          Node not found
        </div>
      </SidebarShell>
    );
  }

  const status = node.status as NodeStatus;
  const active = isActiveStatus(status);
  const canRetry = RETRYABLE.has(status);

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-6 p-5">
        <div className="flex items-center justify-between">
          <StatusBadge status={status} size="md" />
          <FavoriteToggle
            isFavorite={node.isFavorite}
            onToggle={() =>
              setFavorite.mutate({ nodeId, isFavorite: !node.isFavorite })
            }
          />
        </div>

        <Section label="Instruction">
          {node.instruction ? (
            <p className="whitespace-pre-wrap font-serif text-base leading-snug text-ink">
              {node.instruction}
            </p>
          ) : (
            <p className="font-serif text-base italic text-ink-faint">
              no instruction
            </p>
          )}
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

        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
          <button
            type="button"
            onClick={() => setForkOpen(true)}
            data-testid="sidebar-fork"
            className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep"
          >
            Fork
          </button>
          <button
            type="button"
            disabled={!canRetry || retryNode.isPending}
            onClick={() => retryNode.mutate({ nodeId })}
            data-testid="sidebar-retry"
            className="border border-hairline bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-testid="sidebar-delete"
            className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
          >
            Delete
          </button>
        </div>

        {retryNode.error ? (
          <p className="font-mono text-xs text-sanguine">{retryNode.error.message}</p>
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
          description="This permanently removes the node and its descendants. The action cannot be undone."
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
      className="flex h-full w-[400px] shrink-0 flex-col border-l border-hairline bg-paper"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-hairline px-5">
        <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Entry
        </span>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          aria-label="Close panel"
        >
          close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

function FavoriteToggle({
  isFavorite,
  onToggle,
}: {
  isFavorite: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
      aria-pressed={isFavorite}
      className="flex items-center gap-2 p-1"
    >
      <span
        aria-hidden
        className={`block h-4 w-[3px] ${
          isFavorite ? 'bg-sanguine' : 'bg-transparent border-l border-hairline-deep'
        }`}
      />
      <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
        {isFavorite ? 'Favorited' : 'Mark'}
      </span>
    </button>
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
        className="aspect-square w-full border border-hairline bg-paper-deep"
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
        className="aspect-square w-full border border-hairline bg-paper-deep object-contain"
        src={`${httpUrl}/artifacts/${thumbnailArtifactId}`}
        alt="Render thumbnail"
      />
    );
  }
  return (
    <div className="flex aspect-square w-full items-center justify-center bg-hatch font-mono text-xs uppercase tracking-caps text-ink-faint">
      No render yet
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
    <section className="flex flex-col gap-2">
      <h4 className="font-mono text-xs uppercase tracking-caps text-ink-muted">
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
    <Section label="Run">
      <div className="space-y-1 font-mono text-xs text-ink-soft">
        <Timestamp label="Coding" started={run.codingStartedAt} finished={run.codingFinishedAt} />
        <Timestamp label="Rendering" started={run.renderingStartedAt} finished={run.renderingFinishedAt} />
        <Timestamp label="Critiquing" started={run.critiquingStartedAt} finished={run.critiquingFinishedAt} />
        <div className="pt-1 text-ink-faint">id · {runId}</div>
      </div>

      {run.error ? (
        <div
          data-testid="error-panel"
          className="mt-3 border border-sanguine bg-sanguine-tint p-3 font-mono text-xs leading-relaxed text-sanguine-deep"
        >
          <div className="uppercase tracking-caps text-sanguine">
            {run.error.phase} failed
          </div>
          <div className="mt-1 normal-case tracking-normal text-ink-soft">
            {run.error.message}
          </div>
        </div>
      ) : null}

      {run.critique ? (
        <div
          data-testid="critique-panel"
          className="mt-3 border border-hairline bg-paper-deep p-3 text-sm leading-relaxed text-ink"
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
              Critique
            </span>
            {typeof run.critique.rating === 'number' ? (
              <span className="font-mono text-xs uppercase tracking-caps text-ink-soft">
                {run.critique.rating} of 5
              </span>
            ) : null}
          </div>
          <p className="font-serif text-base text-ink">{run.critique.overall}</p>
          {run.critique.suggestions.length > 0 ? (
            <ul className="mt-3 list-none space-y-1.5 font-serif text-sm text-ink-soft">
              {run.critique.suggestions.slice(0, 3).map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-ink-faint">·</span>
                  <span>{s}</span>
                </li>
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
    <div className="flex items-baseline gap-3">
      <span className="w-20 text-ink-muted">{label.toLowerCase()}</span>
      <span className="text-ink">
        {fmt(started)}
        {finished ? <span className="text-ink-faint"> · {fmt(finished)}</span> : null}
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="fork-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Fork node</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            Child branch
          </span>
        </div>
        <label
          htmlFor="fork-input"
          className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
        >
          What should the next variation explore?
        </label>
        <textarea
          id="fork-input"
          autoFocus
          rows={3}
          value={tweak}
          onChange={(e) => setTweak(e.target.value)}
          placeholder="Slow it down and add a noise overlay"
          data-testid="fork-input"
          className="w-full resize-none border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        {createChild.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {createChild.error.message}
          </p>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createChild.isPending || !tweak.trim()}
            data-testid="fork-submit"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-hairline-deep bg-paper p-6"
      >
        <h3 className="font-serif text-xl text-ink">{title}</h3>
        <p className="mt-3 font-serif text-base text-ink-soft">{description}</p>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`border px-5 py-2 font-mono text-xs uppercase tracking-caps transition-colors disabled:opacity-40 ${
              danger
                ? 'border-sanguine bg-paper text-sanguine hover:bg-sanguine-tint'
                : 'border-hairline-deep bg-paper text-ink hover:bg-paper-deep'
            }`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
