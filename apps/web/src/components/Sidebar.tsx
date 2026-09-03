import { useEffect, useMemo, useState } from 'react';
import '@google/model-viewer';
import type {
  ArtifactKind,
  BranchMeta,
  CoderMessage,
  CoderMessageKind,
  EventPayload,
  MetaValue,
  NodeKind,
  NodeStatus,
} from '@vadimlobanov/gaido-core';
import { critiqueFeedback } from '@vadimlobanov/gaido-core';
import { trpc } from '../lib/trpc';
import { artifactUrl, READ_ONLY } from '../lib/static';
import { useUiStore } from '../store';
import { StatusBadge, isActiveStatus } from './StatusBadge';
import { EventStream } from './EventStream';
import { Markdown } from './Markdown';
import {
  ReferenceDraftField,
  BoundReferences,
  toReferenceInput,
  type DraftReference,
} from './ReferenceAttacher';
import { ManualCritiqueModal, critiqueAuthorLabel } from './ManualCritiqueModal';
import { AutoRunPanel } from './AutoRun';

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
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const node = nodeQuery.data?.node;

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

  return node.kind === 'critique' ? (
    <CritiqueSidebar nodeId={nodeId} />
  ) : node.kind === 'config' ? (
    <ConfigSidebar nodeId={nodeId} />
  ) : node.kind === 'instruction' ? (
    <InstructionSidebar nodeId={nodeId} />
  ) : (
    <CoderSidebar nodeId={nodeId} />
  );
}

type TokenUsage = Extract<EventPayload, { kind: 'token_usage' }>;

function CoderSidebar({ nodeId }: { nodeId: string }) {
  const [forkOpen, setForkOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tokens, setTokens] = useState<TokenUsage | null>(null);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const nodesList = trpc.nodes.list.useQuery();
  const runsList = trpc.runs.listByNode.useQuery({ nodeId });
  const node = nodeQuery.data?.node;
  const currentRun = nodeQuery.data?.currentRun;

  // Chronological list of runs with any conversation content (artist reply
  // or coder MESSAGE.md). Used to render the thread; absent → fall back to
  // the simple Instruction section.
  const thread = useMemo(() => {
    const rows = runsList.data ?? [];
    return rows
      .slice()
      .reverse() // listByNode returns newest-first
      .filter((r) => r.message != null || r.artistFollowUp != null);
  }, [runsList.data]);
  const hasThread = thread.length > 0;

  const critiqueChild = useMemo(() => {
    if (!nodesList.data) return null;
    return (
      nodesList.data.find(
        (n) => n.parentId === nodeId && n.kind === 'critique'
      ) ?? null
    );
  }, [nodesList.data, nodeId]);

  const setFavorite = trpc.nodes.setFavorite.useMutation({
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
    utils.runs.listByNode.invalidate({ nodeId });
  };

  const rerunRender = trpc.nodes.rerunRender.useMutation({
    onSuccess: () => refreshNodeState(),
  });

  // Reset live token counter whenever we switch runs.
  const currentRunId = node?.currentRunId ?? null;
  useEffect(() => {
    setTokens(null);
  }, [currentRunId]);

  if (!node) return null;

  const status = node.status as NodeStatus;
  const active = isActiveStatus(status);
  const retryable = nodeQuery.data?.retryable ?? true;
  const canRetry = RETRYABLE.has(status) && retryable;
  const canFork = !!critiqueChild;
  // The coder coded fine but the render flaked — offer a render-only re-run
  // that skips the coder. Gated to the leaf coder (same rule as Retry).
  const renderFailed =
    status === 'failed' &&
    currentRun?.error?.phase === 'rendering' &&
    retryable;
  const retryTooltip = retryable
    ? undefined
    : 'This branch has continued past this iteration — continue from a later critique or fork instead';

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-6 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusBadge
              status={status}
              timing={currentRun ?? null}
              size="md"
            />
            {active && tokens ? <TokenCounter tokens={tokens} /> : null}
          </div>
          <FavoriteToggle
            isFavorite={node.isFavorite}
            onToggle={() =>
              setFavorite.mutate({ nodeId, isFavorite: !node.isFavorite })
            }
          />
        </div>

        <AutoRunPanel nodeId={nodeId} canStart={canRetry} />

        {hasThread ? (
          <ConversationThread
            nodeId={nodeId}
            initialInstruction={node.instruction}
            entries={thread}
            sessionLive={nodeQuery.data?.hasSession ?? false}
            canReply={status !== 'running'}
          />
        ) : (
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
        )}

        <RunDetails kind="coder" runId={node.currentRunId ?? null} />

        {active && node.currentRunId ? (
          <Section label="Live events">
            <EventStream
              runId={node.currentRunId}
              onEvent={refreshNodeState}
              onTokenUsage={setTokens}
            />
          </Section>
        ) : null}

        {currentRun?.message && !currentRun.message.producedArtifact ? null : (
          <Section label="Output">
            <OutputPanel
              output={nodeQuery.data?.currentRunOutput ?? null}
              videoArtifactId={currentRun?.videoArtifactId ?? null}
              thumbnailArtifactId={currentRun?.thumbnailArtifactId ?? null}
              previewUrl={currentRun?.previewUrl ?? null}
            />
          </Section>
        )}

        <RunHistory nodeId={nodeId} />

        <NoteSection
          nodeId={nodeId}
          note={node.note ?? null}
          onChanged={refreshNodeState}
        />

        <BranchMetaSection
          nodeId={nodeId}
          meta={nodeQuery.data?.meta ?? null}
          branchSize={nodeQuery.data?.branchSize ?? 1}
          onChanged={refreshNodeState}
        />

        <BoundReferences nodeId={nodeId} />

        {!READ_ONLY && (
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => setForkOpen(true)}
              disabled={!canFork}
              data-testid="sidebar-fork"
              className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
              title={canFork ? undefined : 'Waiting for coder to finish'}
            >
              Fork
            </button>
            <button
              type="button"
              disabled={!canRetry}
              onClick={() => setRetryOpen(true)}
              data-testid="sidebar-retry"
              title={retryTooltip}
              className="border border-hairline bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
            >
              Retry
            </button>
            {renderFailed ? (
              <button
                type="button"
                onClick={() => rerunRender.mutate({ nodeId })}
                disabled={rerunRender.isPending}
                data-testid="sidebar-rerender"
                title="Re-run only the renderer against the code this run already committed — skips the coder"
                className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
              >
                Re-render
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              data-testid="sidebar-delete"
              className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
            >
              Delete
            </button>
          </div>
        )}

        {!READ_ONLY && rerunRender.error ? (
          <p
            data-testid="rerender-error"
            className="font-mono text-xs uppercase tracking-caps text-sanguine"
          >
            {rerunRender.error.message}
          </p>
        ) : null}
      </div>

      {forkOpen && critiqueChild ? (
        <ForkModal
          parentId={critiqueChild.id}
          onClose={() => setForkOpen(false)}
          onCreated={(newId) => {
            utils.nodes.list.invalidate();
            setSelectedNodeId(newId);
            setForkOpen(false);
          }}
        />
      ) : null}

      {retryOpen ? (
        <RetryModal
          nodeId={nodeId}
          failed={status === 'failed'}
          onClose={() => setRetryOpen(false)}
          onRetried={() => {
            refreshNodeState();
            setRetryOpen(false);
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

interface ThreadEntry {
  id: string;
  createdAt: number;
  artistFollowUp: string | null;
  message: CoderMessage | null;
}

function ConversationThread({
  nodeId,
  initialInstruction,
  entries,
  sessionLive,
  canReply,
}: {
  nodeId: string;
  initialInstruction: string;
  entries: ThreadEntry[];
  sessionLive: boolean;
  canReply: boolean;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState('');
  const reply = trpc.nodes.reply.useMutation({
    onSuccess: () => {
      setDraft('');
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
      utils.runs.listByNode.invalidate({ nodeId });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    reply.mutate({ nodeId, text });
  };

  return (
    <Section label="Conversation">
      <div data-testid="conversation-thread" className="flex flex-col gap-4">
        <ArtistTurn text={initialInstruction} isInitial />
        {entries.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-4">
            {entry.artistFollowUp ? (
              <ArtistTurn text={entry.artistFollowUp} />
            ) : null}
            {entry.message ? <CoderTurn message={entry.message} /> : null}
          </div>
        ))}
      </div>

      {!READ_ONLY && (
      <form onSubmit={onSubmit} className="flex flex-col gap-2 pt-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          disabled={!canReply || !sessionLive || reply.isPending}
          placeholder={
            !sessionLive
              ? 'Reply once the first run finishes…'
              : !canReply
                ? 'Wait for the current run to finish…'
                : 'Reply to the coder…'
          }
          data-testid="conversation-reply"
          className="w-full resize-y border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={
              !canReply || !sessionLive || reply.isPending || !draft.trim()
            }
            data-testid="conversation-reply-submit"
            className="border border-sanguine bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40 disabled:hover:bg-paper"
          >
            {reply.isPending ? 'Sending…' : 'Send reply'}
          </button>
          {reply.error ? (
            <span className="font-mono text-xs text-sanguine">
              {reply.error.message}
            </span>
          ) : null}
        </div>
      </form>
      )}
    </Section>
  );
}

function ArtistTurn({ text, isInitial }: { text: string; isInitial?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="thread-turn-artist">
      <span className="font-mono text-[10px] uppercase tracking-caps text-ink-muted">
        {isInitial ? 'You · initial ask' : 'You'}
      </span>
      <p className="whitespace-pre-wrap font-serif text-base leading-snug text-ink">
        {text}
      </p>
    </div>
  );
}

const KIND_LABEL: Record<CoderMessageKind, string> = {
  question: 'Question',
  limitation: 'Limitation',
  note: 'Note',
};

const KIND_GLYPH: Record<CoderMessageKind, string> = {
  question: '?',
  limitation: '!',
  note: '·',
};

function CoderTurn({ message }: { message: CoderMessage }) {
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="thread-turn-coder"
      data-coder-kind={message.kind}
    >
      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-caps text-ink-muted">
        <span className="inline-flex h-4 w-4 items-center justify-center border border-hairline-deep bg-paper text-[11px] text-ink">
          {KIND_GLYPH[message.kind]}
        </span>
        <span>Coder · {KIND_LABEL[message.kind]}</span>
        {message.producedArtifact ? (
          <span className="text-ink-faint">+ render</span>
        ) : null}
      </span>
      <div className="border border-hairline bg-paper-deep px-3 py-2">
        <Markdown className="text-base leading-snug">{message.body}</Markdown>
      </div>
    </div>
  );
}

function CritiqueSidebar({ nodeId }: { nodeId: string }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const systemQuery = trpc.system.info.useQuery();
  const node = nodeQuery.data?.node;
  const currentRun = nodeQuery.data?.currentRun;
  const isHumanCritic = systemQuery.data?.criticKind === 'human';

  const retryNode = trpc.nodes.retry.useMutation({
    onSuccess: () => {
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
    },
  });
  const continueNode = trpc.nodes.continue.useMutation({
    onSuccess: (data) => {
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
      // Jump to the new coder child so the artist sees its run kick off.
      setSelectedNodeId(data.node.id);
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

  if (!node) return null;

  const status = node.status as NodeStatus;
  const active = isActiveStatus(status);
  const idle = status === 'idle';
  const runLabel = idle ? 'Run critic' : 'Retry';
  const canTrigger = idle || RETRYABLE.has(status);

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-6 p-5">
        <div className="flex items-center justify-between">
          <StatusBadge
            status={status}
            timing={currentRun ?? null}
            size="md"
          />
        </div>

        <AutoRunPanel nodeId={nodeId} canStart={!active} />

        <Section label="Of">
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

        {isHumanCritic ? (
          <HumanCritiqueEditor
            nodeId={nodeId}
            initial={currentRun?.critique?.overall ?? ''}
            onContinue={() => continueNode.mutate({ critiqueNodeId: nodeId })}
            isContinuing={continueNode.isPending}
            continueError={continueNode.error?.message ?? null}
          />
        ) : currentRun?.critique ? (
          <Section label="Critique">
            <div
              data-testid="critique-panel"
              className="border border-hairline bg-paper-deep p-3 text-sm leading-relaxed text-ink"
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
                  Overall
                  {critiqueAuthorLabel(currentRun.critique.author) ? (
                    <span
                      data-testid="critique-author"
                      className="ml-2 font-mono text-xs normal-case tracking-normal text-ink-faint"
                    >
                      {critiqueAuthorLabel(currentRun.critique.author)}
                    </span>
                  ) : null}
                </span>
                {typeof currentRun.critique.rating === 'number' ? (
                  <span className="font-mono text-xs uppercase tracking-caps text-ink-soft">
                    {currentRun.critique.rating} of 5
                  </span>
                ) : null}
              </div>
              <p className="font-serif text-base text-ink">
                {currentRun.critique.overall}
              </p>
              {currentRun.critique.suggestions.length > 0 ? (
                <ul className="mt-3 list-none space-y-1.5 font-serif text-sm text-ink-soft">
                  {currentRun.critique.suggestions.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-ink-faint">·</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {!READ_ONLY && (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={continueNode.isPending}
                  onClick={() => continueNode.mutate({ critiqueNodeId: nodeId })}
                  data-testid="sidebar-continue"
                  title="Start the next coder attempt from this critique"
                  className="border border-sanguine bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40 disabled:hover:bg-paper"
                >
                  {continueNode.isPending ? 'Continuing…' : 'Continue'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  data-testid="sidebar-edit-critique"
                  className="font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-ink"
                >
                  Edit
                </button>
                {continueNode.error ? (
                  <span className="font-mono text-xs text-sanguine">
                    {continueNode.error.message}
                  </span>
                ) : null}
              </div>
            )}
          </Section>
        ) : null}

        <RulesPanel proposedRules={currentRun?.critique?.proposedRules ?? []} />

        <RunDetails kind="critique" runId={node.currentRunId ?? null} />

        {active && node.currentRunId ? (
          <Section label="Live events">
            <EventStream runId={node.currentRunId} onEvent={refreshNodeState} />
          </Section>
        ) : null}

        {!READ_ONLY && (
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
              onClick={() => setSwitchOpen(true)}
              data-testid="sidebar-switch-coder"
              className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep"
            >
              Switch coder
            </button>
            {isHumanCritic ? null : (
              <>
                <button
                  type="button"
                  disabled={!canTrigger || retryNode.isPending}
                  onClick={() => retryNode.mutate({ nodeId })}
                  data-testid="sidebar-retry"
                  className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
                >
                  {retryNode.isPending ? 'Starting...' : runLabel}
                </button>
                <button
                  type="button"
                  disabled={!canTrigger}
                  onClick={() => setManualOpen(true)}
                  data-testid="sidebar-critique-manually"
                  title="Write the critique yourself instead of running the critic"
                  className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
                >
                  Critique manually
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              data-testid="sidebar-delete"
              className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
            >
              Delete
            </button>
          </div>
        )}

        {!READ_ONLY && retryNode.error ? (
          <p className="font-mono text-xs text-sanguine">{retryNode.error.message}</p>
        ) : null}
      </div>

      {forkOpen ? (
        <ForkModal
          parentId={nodeId}
          onClose={() => setForkOpen(false)}
          onCreated={(newId) => {
            setForkOpen(false);
            utils.nodes.list.invalidate();
            setSelectedNodeId(newId);
          }}
        />
      ) : null}

      {switchOpen ? (
        <SwitchCoderModal
          critiqueNodeId={nodeId}
          onClose={() => setSwitchOpen(false)}
          onSwitched={(newId) => {
            setSwitchOpen(false);
            utils.nodes.list.invalidate();
            setSelectedNodeId(newId);
          }}
        />
      ) : null}

      {manualOpen ? (
        <ManualCritiqueModal
          nodeId={nodeId}
          initialOverall={currentRun?.critique?.overall ?? ''}
          initialRating={currentRun?.critique?.rating ?? null}
          onClose={() => setManualOpen(false)}
          onSaved={() => setManualOpen(false)}
        />
      ) : null}

      {editOpen && currentRun?.critique ? (
        <EditCritiqueModal
          nodeId={nodeId}
          initial={critiqueFeedback(currentRun.critique)}
          continuing={continueNode.isPending}
          onClose={() => setEditOpen(false)}
          onSaved={() => setEditOpen(false)}
          onContinue={() => {
            setEditOpen(false);
            continueNode.mutate({ critiqueNodeId: nodeId });
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete critique?"
          description="This removes the critique and any forks that branched off it. The action cannot be undone."
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

function TokenCounter({ tokens }: { tokens: TokenUsage }) {
  const totalIn = totalInputTokens(tokens);
  const cached =
    (tokens.cacheReadTokens ?? 0) + (tokens.cacheCreationTokens ?? 0);
  const hasCost = typeof tokens.costUsd === 'number';
  const title =
    `${totalIn.toLocaleString()} input` +
    (cached > 0 ? ` (${cached.toLocaleString()} cached)` : '') +
    ` / ${tokens.outputTokens.toLocaleString()} output tokens` +
    (hasCost ? ` · ${formatCost(tokens.costUsd as number)}` : '');
  return (
    <span
      data-testid="token-counter"
      className="inline-flex items-center font-mono text-xs uppercase tracking-caps text-ink-muted"
      title={title}
    >
      <span className="text-ink-faint">·</span>
      <span className="ml-2 text-ink-soft">{formatTokens(totalIn)}</span>
      <span className="ml-1 text-ink-faint">in</span>
      <span className="ml-2 text-ink-soft">{formatTokens(tokens.outputTokens)}</span>
      <span className="ml-1 text-ink-faint">out</span>
      {hasCost ? (
        <>
          <span className="ml-2 text-ink-faint">·</span>
          <span className="ml-2 text-ink-soft">
            {formatCost(tokens.costUsd as number)}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Total prompt input. `inputTokens` is the *uncached* portion only — with
 * prompt caching the bulk lands in the cache fields, so a bare `inputTokens`
 * reads as misleadingly tiny. Add them back for a meaningful "in" figure.
 */
function totalInputTokens(t: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  return t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheCreationTokens ?? 0);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

function HumanCritiqueEditor({
  nodeId,
  initial,
  onContinue,
  isContinuing,
  continueError,
}: {
  nodeId: string;
  initial: string;
  onContinue: () => void;
  isContinuing: boolean;
  continueError: string | null;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(initial);
  // Re-sync if a different node is selected or the persisted value changes
  // (e.g. another tab saved it). Without this, the textarea would stick to
  // whatever the user last typed for the previously-selected node.
  useEffect(() => {
    setDraft(initial);
  }, [nodeId, initial]);

  const save = trpc.runs.setHumanCritique.useMutation({
    onSuccess: () => {
      utils.nodes.get.invalidate({ nodeId });
      utils.nodes.list.invalidate();
    },
  });

  // Read-only published canvas: a human critique is a write surface — hide it
  // entirely. The persisted critique still renders read-only via the critique
  // panel above. Placed after all hooks so the rules-of-hooks order holds.
  if (READ_ONLY) return null;

  const dirty = draft !== initial;
  const hasNotes = !!draft.trim();
  const busy = save.isPending || isContinuing;

  const handleSaveAndContinue = async () => {
    if (dirty) {
      try {
        await save.mutateAsync({ nodeId, notes: draft });
      } catch {
        return;
      }
    }
    onContinue();
  };

  return (
    <Section label="Critique (yours)">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        placeholder="What worked, what didn't, what to try next…"
        data-testid="human-critique-textarea"
        className="w-full resize-y border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!hasNotes || busy}
          onClick={handleSaveAndContinue}
          data-testid="sidebar-continue"
          title={hasNotes ? undefined : 'Write some notes first'}
          className="border border-sanguine bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40 disabled:hover:bg-paper"
        >
          {save.isPending
            ? 'Saving…'
            : isContinuing
              ? 'Continuing…'
              : 'Save & Continue'}
        </button>
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => save.mutate({ nodeId, notes: draft })}
          data-testid="human-critique-save"
          className="font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-ink disabled:opacity-40 disabled:hover:text-ink-muted"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {!dirty && initial ? (
          <span className="font-mono text-xs uppercase tracking-caps text-ink-faint">
            saved
          </span>
        ) : null}
        {save.error ? (
          <span className="font-mono text-xs text-sanguine">{save.error.message}</span>
        ) : null}
        {continueError ? (
          <span className="font-mono text-xs text-sanguine">{continueError}</span>
        ) : null}
      </div>
    </Section>
  );
}

function RulesPanel({ proposedRules }: { proposedRules: string[] }) {
  const utils = trpc.useUtils();
  const lessonsQuery = trpc.lessons.get.useQuery();
  const promote = trpc.lessons.promote.useMutation({
    onSuccess: () => utils.lessons.get.invalidate(),
  });
  const [draft, setDraft] = useState('');

  const promotedSet = useMemo(() => {
    const contents = lessonsQuery.data?.contents ?? '';
    return new Set(
      contents
        .split('\n')
        .map((line) => normalizeRule(line))
        .filter((line) => line.length > 0)
    );
  }, [lessonsQuery.data?.contents]);

  const isPromoted = (rule: string) => promotedSet.has(normalizeRule(rule));

  const onAddDraft = (e: React.FormEvent) => {
    e.preventDefault();
    const rule = draft.trim();
    if (!rule) return;
    promote.mutate(
      { rule },
      {
        onSuccess: () => setDraft(''),
      }
    );
  };

  return (
    <Section label="Project rules">
      {proposedRules.length > 0 ? (
        <ul data-testid="proposed-rules" className="space-y-2">
          {proposedRules.map((rule, i) => {
            const done = isPromoted(rule);
            return (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-2 text-ink-faint">·</span>
                <span className="flex-1 font-serif text-sm leading-snug text-ink-soft">
                  {rule}
                </span>
                {!READ_ONLY && (
                  <button
                    type="button"
                    disabled={done || promote.isPending}
                    onClick={() => promote.mutate({ rule })}
                    data-testid="promote-rule"
                    className="shrink-0 border border-hairline-deep bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper-deep disabled:cursor-default disabled:border-hairline disabled:bg-paper disabled:text-ink-faint"
                  >
                    {done ? '✓ in rules' : 'Promote'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {!READ_ONLY && (
        <form onSubmit={onAddDraft} className="flex items-stretch gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a rule…"
            data-testid="add-rule-input"
            className="flex-1 border border-hairline bg-paper-deep px-3 py-2 font-serif text-sm text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
          />
          <button
            type="submit"
            disabled={!draft.trim() || promote.isPending}
            data-testid="add-rule-submit"
            className="border border-hairline-deep bg-paper px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}

      {!READ_ONLY && promote.error ? (
        <p className="font-mono text-xs text-sanguine">{promote.error.message}</p>
      ) : null}
    </Section>
  );
}

function normalizeRule(line: string): string {
  return line
    .replace(/^\s*[-•*]\s*/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/, '')
    .trim();
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
  if (READ_ONLY) return null;
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

interface RunOutput {
  artifactId: string;
  kind: ArtifactKind;
  mime: string;
}

/** The four presentable output kinds — the rest of ArtifactKind never surfaces here. */
const OUTPUT_KINDS = ['video', 'image', 'model', 'page'] as const;
type OutputMode = (typeof OUTPUT_KINDS)[number];

function isOutputMode(kind: ArtifactKind): kind is OutputMode {
  return (OUTPUT_KINDS as readonly string[]).includes(kind);
}

const MODE_LABEL: Record<OutputMode, string> = {
  video: 'Video',
  image: 'Image',
  model: '3D',
  page: 'Page',
};

function OutputPanel({
  output,
  videoArtifactId,
  thumbnailArtifactId,
  previewUrl,
}: {
  output: RunOutput | null;
  videoArtifactId: string | null;
  thumbnailArtifactId: string | null;
  previewUrl: string | null;
}) {
  // Primary presentation. A typed output row picks it; legacy runs (no row)
  // fall back to the video pointer, matching the pre-typed-output behavior.
  const primaryMode: OutputMode | null =
    output && isOutputMode(output.kind)
      ? output.kind
      : videoArtifactId
        ? 'video'
        : null;

  // A model/page/image render usually also has a video (the critic watches
  // it) — offer a toggle to flip to it.
  const hasVideoAlt =
    primaryMode != null && primaryMode !== 'video' && videoArtifactId != null;

  const [mode, setMode] = useState<OutputMode>(primaryMode ?? 'video');
  // Re-sync the active mode whenever the node/run underneath changes.
  useEffect(() => {
    setMode(primaryMode ?? 'video');
  }, [primaryMode, output?.artifactId, videoArtifactId]);

  const view = hasVideoAlt ? mode : primaryMode ?? 'video';
  const poster = thumbnailArtifactId ? artifactUrl(thumbnailArtifactId) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {hasVideoAlt ? (
        <div className="flex items-stretch gap-2">
          {([primaryMode as OutputMode, 'video'] as OutputMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              data-testid={`output-mode-${m}`}
              aria-pressed={mode === m}
              className={`border px-3 py-1 font-mono text-[10px] uppercase tracking-caps transition-colors ${
                mode === m
                  ? 'border-hairline-deep bg-paper-deep text-ink'
                  : 'border-hairline bg-paper text-ink-muted hover:bg-paper-deep'
              }`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}

      <OutputMedia
        view={view}
        output={output}
        videoArtifactId={videoArtifactId}
        thumbnailArtifactId={thumbnailArtifactId}
        previewUrl={previewUrl}
        poster={poster}
      />

      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="output-preview-link"
          className="font-mono text-xs uppercase tracking-caps text-ink-soft underline decoration-hairline-deep underline-offset-4 hover:text-ink"
        >
          Open live preview →
        </a>
      ) : null}
    </div>
  );
}

function OutputMedia({
  view,
  output,
  videoArtifactId,
  thumbnailArtifactId,
  previewUrl,
  poster,
}: {
  view: OutputMode;
  output: RunOutput | null;
  videoArtifactId: string | null;
  thumbnailArtifactId: string | null;
  previewUrl: string | null;
  poster: string | undefined;
}) {
  const frame = 'aspect-square w-full border border-hairline bg-paper-deep';

  if (view === 'video' && videoArtifactId) {
    return (
      <video
        data-testid="output-video"
        className={frame}
        src={artifactUrl(videoArtifactId)}
        poster={poster}
        controls
        loop
        muted
        playsInline
      />
    );
  }

  if (view === 'image' && output) {
    return (
      <img
        data-testid="output-image"
        className={`${frame} object-contain`}
        src={artifactUrl(output.artifactId)}
        alt="Render output"
      />
    );
  }

  if (view === 'model' && output) {
    return (
      <model-viewer
        data-testid="output-model"
        className={frame}
        src={artifactUrl(output.artifactId)}
        poster={poster}
        camera-controls
        autoplay
        alt="3D render output"
      />
    );
  }

  if (view === 'page' && previewUrl) {
    return (
      <iframe
        data-testid="output-page"
        className={frame}
        src={previewUrl}
        title="Page render output"
        sandbox="allow-scripts allow-same-origin"
      />
    );
  }

  // Fallbacks: a still thumbnail, else a placeholder.
  return thumbnailArtifactId ? (
    <img
      data-testid="output-thumbnail"
      className={`${frame} object-contain`}
      src={artifactUrl(thumbnailArtifactId)}
      alt="Render thumbnail"
    />
  ) : (
    <div className="flex aspect-square w-full items-center justify-center bg-hatch font-mono text-xs uppercase tracking-caps text-ink-faint">
      No render yet
    </div>
  );
}

/**
 * Every attempt on this coder node, newest first, each with a "Reveal code"
 * action that opens that iteration's committed code in the OS file manager.
 * Runs that produced no diff have no distinct snapshot, so their action is
 * disabled. Reuses CoderSidebar's `runs.listByNode` query (same key → React
 * Query dedupes, no extra fetch).
 */
function RunHistory({ nodeId }: { nodeId: string }) {
  const runsList = trpc.runs.listByNode.useQuery({ nodeId });
  const reveal = trpc.runs.revealCode.useMutation();
  const runs = runsList.data ?? [];
  if (runs.length === 0) return null;
  // listByNode is newest-first; number the oldest #1 so labels stay stable as
  // new runs land on top.
  const total = runs.length;
  return (
    <Section label="Iterations">
      <ul data-testid="iterations" className="flex flex-col">
        {runs.map((run, i) => {
          const hasCode = run.commitSha != null;
          return (
            <li
              key={run.id}
              className="flex items-center justify-between gap-3 border-b border-hairline py-2 last:border-b-0"
            >
              <span className="font-mono text-xs uppercase tracking-caps text-ink-soft">
                #{total - i}
                <span className="ml-2 text-ink-faint">{run.status}</span>
              </span>
              {!READ_ONLY && (
                <button
                  type="button"
                  disabled={!hasCode || reveal.isPending}
                  onClick={() => reveal.mutate({ runId: run.id })}
                  data-testid={`reveal-code-${run.id}`}
                  title={
                    hasCode
                      ? 'Open this iteration’s code folder'
                      : 'This iteration produced no code changes'
                  }
                  className="font-mono text-xs uppercase tracking-caps text-ink-soft underline decoration-hairline-deep underline-offset-4 transition-colors hover:text-ink disabled:no-underline disabled:opacity-40 disabled:hover:text-ink-soft"
                >
                  Reveal code →
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!READ_ONLY && reveal.error ? (
        <p
          data-testid="reveal-code-error"
          className="font-mono text-xs uppercase tracking-caps text-sanguine"
        >
          {reveal.error.message}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * Branch metadata — the typed key/values (`config.meta`) shared by every
 * coder on this node's branch. Declared fields render as a small form (text /
 * checkbox / number / url) so the artist can stamp or correct values by hand;
 * saving sends only the changed keys as a `setMeta` merge-patch. Each set key
 * shows the iteration it was stamped through (click to jump). With no schema
 * declared the set keys are listed read-only — the CLI is the write path.
 * Values are branch-wide, which the header says out loud, since editing here
 * changes every sibling iteration too.
 */
/** Server-side cap on `nodes.setNote`, mirrored so the textarea stops where
 * the mutation would reject rather than failing on save. */
const NOTE_MAX = 2000;

/**
 * The node's margin note — free prose about *this* iteration ("published as
 * hero-loop", "keep, the timing finally reads"), the same field `gaido note`
 * writes. Distinct from branch meta: a note belongs to one node and says
 * nothing typed; meta is structured and shared by the whole branch. Saved
 * text shows up on the card as its own strip; clearing the box removes it.
 */
function NoteSection({
  nodeId,
  note,
  onChanged,
}: {
  nodeId: string;
  note: string | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(note ?? '');

  // Re-sync when a different node is selected or the note changes under us
  // (`gaido note` from the CLI, another tab, an external agent).
  useEffect(() => {
    setDraft(note ?? '');
  }, [nodeId, note]);

  const setNote = trpc.nodes.setNote.useMutation({
    onSuccess: () => onChanged(),
  });

  // Published canvas: the note is part of the record, but writing isn't —
  // render it as prose and drop the editor. After the hooks, so the order holds.
  if (READ_ONLY) {
    return note ? (
      <Section label="Note">
        <p
          data-testid="node-note-text"
          className="whitespace-pre-wrap font-serif text-sm italic leading-snug text-ink-muted"
        >
          {note}
        </p>
      </Section>
    ) : null;
  }

  // The server trims and nulls a blank note, so compare against the trimmed
  // draft — re-saving whitespace isn't a change.
  const trimmed = draft.trim();
  const dirty = trimmed !== (note ?? '');
  const busy = setNote.isPending;
  const remaining = NOTE_MAX - draft.length;

  return (
    <Section label="Note">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        maxLength={NOTE_MAX}
        placeholder="A margin note on this iteration…"
        data-testid="node-note-input"
        className="w-full resize-y border border-hairline bg-paper-deep px-3 py-2 font-serif text-sm italic leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
      />
      <div className="flex items-center gap-4">
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => setNote.mutate({ nodeId, note: trimmed || null })}
          data-testid="node-note-save"
          className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {note ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setNote.mutate({ nodeId, note: null })}
            data-testid="node-note-remove"
            className="font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine disabled:opacity-40"
          >
            Remove
          </button>
        ) : null}
        {!dirty && note ? (
          <span className="font-mono text-xs uppercase tracking-caps text-ink-faint">
            saved
          </span>
        ) : null}
        {remaining <= 200 ? (
          <span className="ml-auto font-mono text-xs uppercase tracking-caps text-ink-faint">
            {remaining} left
          </span>
        ) : null}
      </div>
      {setNote.error ? (
        <p data-testid="node-note-error" className="font-mono text-xs text-sanguine">
          {setNote.error.message}
        </p>
      ) : null}
    </Section>
  );
}

function BranchMetaSection({
  nodeId,
  meta,
  branchSize,
  onChanged,
}: {
  nodeId: string;
  meta: BranchMeta | null;
  branchSize: number;
  onChanged: () => void;
}) {
  const info = trpc.system.info.useQuery(undefined, { staleTime: Infinity });
  const fields = useMemo(() => info.data?.metaFields ?? [], [info.data]);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Draft mirrors the saved values; reset whenever the branch's meta changes
  // under us (another node of the branch saved, the CLI wrote, etc.).
  useEffect(() => {
    const next: Record<string, string | boolean> = {};
    for (const f of fields) {
      const v = meta?.[f.key]?.value;
      next[f.key] = f.type === 'boolean' ? v === true : v == null ? '' : String(v);
    }
    setDraft(next);
    setError(null);
  }, [fields, meta]);

  const setMeta = trpc.nodes.setMeta.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(err.message),
  });
  const clearMeta = trpc.nodes.clearMeta.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(err.message),
  });

  const patch = useMemo(() => {
    const out: Record<string, MetaValue | null> = {};
    for (const f of fields) {
      const saved = meta?.[f.key]?.value;
      const d = draft[f.key];
      if (f.type === 'boolean') {
        const next = d === true;
        if (next !== (saved === true)) out[f.key] = next;
        continue;
      }
      const text = typeof d === 'string' ? d.trim() : '';
      if (text === '') {
        if (saved != null) out[f.key] = null;
        continue;
      }
      const next: MetaValue = f.type === 'number' ? Number(text) : text;
      if (saved == null || String(saved) !== String(next)) out[f.key] = next;
    }
    return out;
  }, [fields, draft, meta]);
  const dirty = Object.keys(patch).length > 0;
  const hasAny = meta != null && Object.keys(meta).length > 0;
  const busy = setMeta.isPending || clearMeta.isPending;

  // Keys set but not declared (free-form projects, or a schema that shrank).
  const extraKeys = useMemo(
    () => Object.keys(meta ?? {}).filter((k) => !fields.some((f) => f.key === k)),
    [meta, fields]
  );

  if (fields.length === 0 && !hasAny) return null;

  const inputCls =
    'w-full border border-hairline-deep bg-paper px-3 py-1.5 font-mono text-xs text-ink outline-none transition-colors focus:border-ink disabled:opacity-60';

  const provenance = (key: string) => {
    const entry = meta?.[key];
    if (!entry) return null;
    const here = entry.nodeId === nodeId;
    return (
      <span className="font-mono text-[10px] uppercase tracking-caps text-ink-faint">
        {here ? (
          'stamped here'
        ) : (
          <button
            type="button"
            onClick={() => setSelectedNodeId(entry.nodeId)}
            className="underline decoration-hairline-deep underline-offset-2 hover:text-ink"
            title="Open the iteration this value was stamped through"
          >
            via {entry.nodeId}
          </button>
        )}
        {' · '}
        {fmt(entry.at)}
      </span>
    );
  };

  return (
    <Section label="Branch meta">
      <p className="font-serif text-sm italic leading-snug text-ink-muted">
        {branchSize > 1
          ? `Shared by the ${branchSize} iterations on this branch — forks start clean.`
          : 'Shared by every later iteration on this branch — forks start clean.'}
      </p>
      <div className="flex flex-col gap-3" data-testid="branch-meta">
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-caps text-ink-muted">
                {f.label ?? f.key}
              </span>
              {provenance(f.key)}
            </span>
            {f.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={draft[f.key] === true}
                disabled={READ_ONLY || busy}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))}
                data-testid={`branch-meta-${f.key}`}
                className="h-4 w-4 accent-[var(--sanguine)]"
              />
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                disabled={READ_ONLY || busy}
                placeholder={f.type === 'url' ? 'https://…' : ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                data-testid={`branch-meta-${f.key}`}
                className={inputCls}
              />
            )}
          </label>
        ))}
        {extraKeys.map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-caps text-ink-muted">
                {k}
              </span>
              {provenance(k)}
            </span>
            <p className="break-all font-mono text-xs text-ink">{String(meta?.[k]?.value)}</p>
          </div>
        ))}
      </div>
      {!READ_ONLY && (fields.length > 0 || hasAny) ? (
        <div className="flex items-center gap-4">
          {fields.length > 0 ? (
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() => setMeta.mutate({ nodeId, patch })}
              data-testid="branch-meta-save"
              className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
            >
              {setMeta.isPending ? 'Saving…' : 'Save'}
            </button>
          ) : null}
          {hasAny ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => clearMeta.mutate({ nodeId })}
              data-testid="branch-meta-clear"
              className="font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine disabled:opacity-40"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p
          data-testid="branch-meta-error"
          className="font-mono text-xs text-sanguine"
        >
          {error}
        </p>
      ) : null}
    </Section>
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
  kind,
  runId,
}: {
  kind: NodeKind;
  runId: string | null;
}) {
  const runQuery = trpc.runs.get.useQuery(
    { runId: runId ?? '' },
    { enabled: !!runId }
  );
  if (!runId) return null;
  const run = runQuery.data?.run;
  if (!run) return null;

  return (
    <Section label="Run">
      <div className="space-y-1 font-mono text-xs text-ink-soft">
        {kind === 'coder' ? (
          <>
            <Timestamp label="Coding" started={run.codingStartedAt} finished={run.codingFinishedAt} />
            <Timestamp label="Rendering" started={run.renderingStartedAt} finished={run.renderingFinishedAt} />
          </>
        ) : (
          <Timestamp label="Critiquing" started={run.critiquingStartedAt} finished={run.critiquingFinishedAt} />
        )}
        <RunUsage run={run} />
        <CopyableRunId runId={runId} />
      </div>

      {run.error ? (
        <div
          data-testid="error-panel"
          className="mt-3 border border-sanguine bg-sanguine-tint p-3 font-mono text-xs leading-relaxed text-sanguine-deep"
        >
          <div className="uppercase tracking-caps text-sanguine">
            {run.error.validation
              ? `check '${run.error.validation.check}' failed`
              : `${run.error.phase} failed`}
          </div>
          <div className="mt-1 normal-case tracking-normal text-ink-soft">
            {run.error.message}
          </div>
          {run.error.validation ? (
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-sanguine/40 bg-paper p-2 text-[11px] leading-relaxed text-ink-soft">
              {run.error.validation.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

function CopyableRunId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(runId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (e.g. insecure context) — selection still works
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-run-id"
      title="Copy run id — paste it as a reference on another node"
      className="group flex items-center gap-2 pt-1 text-left text-ink-faint hover:text-ink-soft"
    >
      <span>id · {runId}</span>
      <span className="font-mono text-[10px] uppercase tracking-caps text-ink-muted opacity-0 transition-opacity group-hover:opacity-100">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
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
  const duration = finished ? finished - started : null;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 text-ink-muted">{label.toLowerCase()}</span>
      <span className="text-ink">
        {fmt(started)}
        {finished ? <span className="text-ink-faint"> · {fmt(finished)}</span> : null}
        {duration != null ? (
          <span className="ml-2 text-ink-muted">({formatDuration(duration)})</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Persisted token + cost totals for a finished run. Tokens "in" sums the
 * uncached input and the cache fields so it reflects the real prompt size;
 * cost shows only when the adapter reported billed dollars (claude-code
 * always; opencode for paid providers; codex/cursor never under subscription
 * auth). Renders nothing until the run has recorded values.
 */
function RunUsage({
  run,
}: {
  run: {
    tokensIn: number | null;
    tokensOut: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costUsd: number | null;
  };
}) {
  const cached = (run.cacheReadTokens ?? 0) + (run.cacheCreationTokens ?? 0);
  const totalIn = (run.tokensIn ?? 0) + cached;
  const out = run.tokensOut ?? 0;
  const hasTokens = run.tokensIn != null || run.tokensOut != null;
  const hasCost = typeof run.costUsd === 'number';
  if (!hasTokens && !hasCost) return null;
  return (
    <>
      {hasTokens ? (
        <div className="flex items-baseline gap-3">
          <span className="w-20 text-ink-muted">tokens</span>
          <span
            className="text-ink"
            title={`${totalIn.toLocaleString()} input${
              cached > 0 ? ` (${cached.toLocaleString()} cached)` : ''
            } / ${out.toLocaleString()} output`}
          >
            {formatTokens(totalIn)}
            <span className="ml-1 text-ink-faint">in</span>
            <span className="text-ink-faint"> · </span>
            {formatTokens(out)}
            <span className="ml-1 text-ink-faint">out</span>
            {cached > 0 ? (
              <span className="ml-2 text-ink-muted">
                ({formatTokens(cached)} cached)
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {hasCost ? (
        <div className="flex items-baseline gap-3">
          <span className="w-20 text-ink-muted">cost</span>
          <span className="text-ink">{formatCost(run.costUsd as number)}</span>
        </div>
      ) : null}
    </>
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
  const [references, setReferences] = useState<DraftReference[]>([]);
  const createChild = trpc.nodes.createChild.useMutation({
    onSuccess: (data) => onCreated(data.node.id),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = tweak.trim();
    if (!trimmed) return;
    createChild.mutate({
      parentId,
      instruction: trimmed,
      ...(references.length ? { references: references.map(toReferenceInput) } : {}),
    });
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
            New variation
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
        <div className="mt-4">
          <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
            References <span className="text-ink-faint">· inherited + added</span>
          </span>
          <ReferenceDraftField value={references} onChange={setReferences} />
        </div>
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

/**
 * Overwrite an automated critique before continuing. Pre-filled with the
 * critique's feedback (overall + suggestions, the same text `continue` sends
 * the coder). "Save & Continue" persists the edit and immediately spawns the
 * next coder; "Save" just persists. Editing folds suggestions into the prose
 * server-side, so the panel shows the artist's version with no duplication.
 */
function EditCritiqueModal({
  nodeId,
  initial,
  continuing,
  onClose,
  onSaved,
  onContinue,
}: {
  nodeId: string;
  initial: string;
  continuing: boolean;
  onClose: () => void;
  onSaved: () => void;
  onContinue: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(initial);
  const edit = trpc.runs.editCritique.useMutation();

  const empty = !draft.trim();
  const dirty = draft.trim() !== initial.trim();
  const busy = edit.isPending || continuing;

  // Skip the write when nothing changed (Save & Continue still works on an
  // untouched critique), but always refresh so the panel reflects the edit.
  const persist = async () => {
    if (dirty) await edit.mutateAsync({ nodeId, overall: draft });
    utils.nodes.get.invalidate({ nodeId });
    utils.nodes.list.invalidate();
  };
  const handleSave = async () => {
    try {
      await persist();
    } catch {
      return;
    }
    onSaved();
  };
  const handleSaveAndContinue = async () => {
    if (empty) return;
    try {
      await persist();
    } catch {
      return;
    }
    onContinue();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="edit-critique-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Edit critique</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            Drives the next run
          </span>
        </div>
        <textarea
          autoFocus
          rows={8}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What worked, what didn't, what to try next…"
          data-testid="edit-critique-textarea"
          className="w-full resize-y border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        {edit.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {edit.error.message}
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
            type="button"
            disabled={!dirty || busy}
            onClick={handleSave}
            data-testid="edit-critique-save"
            className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
          >
            {edit.isPending && !continuing ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={empty || busy}
            onClick={handleSaveAndContinue}
            data-testid="edit-critique-continue"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40 disabled:hover:bg-paper"
          >
            {continuing ? 'Continuing…' : 'Save & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RetryModal({
  nodeId,
  failed,
  onClose,
  onRetried,
}: {
  nodeId: string;
  failed: boolean;
  onClose: () => void;
  onRetried: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [coderName, setCoderName] = useState<string | null>(null);
  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const codersQuery = trpc.coders.list.useQuery();
  const coderOptions = codersQuery.data ?? [];
  const resolvedCoderName = nodeQuery.data?.resolvedCoderName ?? null;
  const resolvedCoderKind = nodeQuery.data?.resolvedCoderKind ?? null;
  const hasSession = nodeQuery.data?.hasSession ?? false;
  const selectedCoder = coderName ?? resolvedCoderName;
  // A live session can only resume under a same-kind adapter; others must go
  // through a config switch (new session). Lock them out here.
  const coderLocked = (kind: string) =>
    hasSession && resolvedCoderKind != null && kind !== resolvedCoderKind;

  const retry = trpc.nodes.retry.useMutation({
    onSuccess: () => onRetried(),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (retry.isPending) return;
    const trimmed = prompt.trim();
    // Only send coderName when it actually changes the resolved coder, so a
    // plain retry doesn't pin an otherwise-inherited choice onto the node.
    const swap =
      selectedCoder && selectedCoder !== resolvedCoderName
        ? selectedCoder
        : undefined;
    retry.mutate({
      nodeId,
      prompt: trimmed || undefined,
      ...(swap ? { coderName: swap } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="retry-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Retry run</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            New attempt
          </span>
        </div>
        {coderOptions.length > 1 ? (
          <div className="mb-4">
            <label
              htmlFor="retry-coder"
              className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
            >
              Coder
            </label>
            <select
              id="retry-coder"
              value={selectedCoder ?? ''}
              onChange={(e) => setCoderName(e.target.value)}
              data-testid="retry-coder"
              className="w-full border border-hairline bg-paper-deep px-3 py-2 font-mono text-sm text-ink outline-none focus:border-hairline-deep"
            >
              {coderOptions.map((c) => (
                <option key={c.name} value={c.name} disabled={coderLocked(c.kind)}>
                  {c.name} · {c.kind}
                  {coderLocked(c.kind) ? ' · incompatible' : ''}
                </option>
              ))}
            </select>
            {hasSession ? (
              <p className="mt-2 font-mono text-[10px] uppercase tracking-caps text-ink-faint">
                Resumes the session — same-kind coders only. Switch coder for others.
              </p>
            ) : null}
          </div>
        ) : null}
        <label
          htmlFor="retry-input"
          className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
        >
          {failed ? 'The last run failed — what should change?' : 'Steer this attempt'}
        </label>
        <textarea
          id="retry-input"
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Fix the type=module attribute and slow the intro"
          data-testid="retry-input"
          className="w-full resize-none border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        <p className="mt-2 font-mono text-[10px] uppercase tracking-caps text-ink-faint">
          Optional — leave blank to re-run as-is
        </p>
        {retry.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {retry.error.message}
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
            disabled={retry.isPending}
            data-testid="retry-submit"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
          >
            {retry.isPending ? 'Starting...' : 'Retry'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SwitchCoderModal({
  critiqueNodeId,
  onClose,
  onSwitched,
}: {
  critiqueNodeId: string;
  onClose: () => void;
  onSwitched: (newId: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [coderName, setCoderName] = useState<string | null>(null);
  const [sessionPolicy, setSessionPolicy] = useState<'retain' | 'reset'>('reset');
  const nodeQuery = trpc.nodes.get.useQuery({ nodeId: critiqueNodeId });
  const codersQuery = trpc.coders.list.useQuery();
  const coderOptions = codersQuery.data ?? [];
  const currentCoderName = nodeQuery.data?.resolvedCoderName ?? null;
  const currentCoderKind = nodeQuery.data?.resolvedCoderKind ?? null;
  const branchHasSession = nodeQuery.data?.hasSession ?? false;

  // Default the picker to the branch's current coder — switching to the same
  // coder with `reset` is a valid "start anew, same model + code" move.
  const resolvedCoder =
    coderName ?? currentCoderName ?? coderOptions[0]?.name ?? null;
  const selectedKind =
    coderOptions.find((c) => c.name === resolvedCoder)?.kind ?? null;
  // Retain resumes the branch session — needs a live session AND a same-kind
  // coder to resume it under.
  const canRetain =
    branchHasSession &&
    selectedKind != null &&
    currentCoderKind != null &&
    selectedKind === currentCoderKind;
  const effectivePolicy = canRetain ? sessionPolicy : 'reset';
  const retainReason = !branchHasSession
    ? 'No live session on this branch yet — reset starts a fresh one'
    : 'Only a same-kind coder can resume the session';

  const switchCoder = trpc.nodes.switchCoder.useMutation({
    onSuccess: (data) => onSwitched(data.node.id),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || !resolvedCoder || switchCoder.isPending) return;
    switchCoder.mutate({
      critiqueNodeId,
      coderName: resolvedCoder,
      sessionPolicy: effectivePolicy,
      instruction: trimmed,
    });
  };

  const policyButton = (
    value: 'retain' | 'reset',
    label: string,
    disabled: boolean
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setSessionPolicy(value)}
      data-testid={`switch-policy-${value}`}
      title={disabled ? retainReason : undefined}
      className={`flex-1 border px-3 py-2 font-mono text-xs uppercase tracking-caps transition-colors disabled:opacity-40 ${
        effectivePolicy === value
          ? 'border-sanguine bg-sanguine-tint text-sanguine'
          : 'border-hairline text-ink-soft hover:bg-paper-deep'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="switch-coder-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Switch coder</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            New coder
          </span>
        </div>

        <div className="mb-4">
          <label
            htmlFor="switch-coder-select"
            className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
          >
            Coder
          </label>
          <select
            id="switch-coder-select"
            value={resolvedCoder ?? ''}
            onChange={(e) => setCoderName(e.target.value)}
            data-testid="switch-coder-select"
            className="w-full border border-hairline bg-paper-deep px-3 py-2 font-mono text-sm text-ink outline-none focus:border-hairline-deep"
          >
            {coderOptions.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} · {c.kind}
                {c.name === currentCoderName ? ' · current' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
            Session
          </span>
          <div className="flex gap-2">
            {policyButton('reset', 'Reset · new session', false)}
            {policyButton('retain', 'Retain · keep session', !canRetain)}
          </div>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-caps text-ink-faint">
            {effectivePolicy === 'retain'
              ? 'Resumes the conversation under the new coder'
              : 'Fresh session, starting from this iteration’s code'}
          </p>
        </div>

        <label
          htmlFor="switch-coder-instruction"
          className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
        >
          Instruction for the new coder
        </label>
        <textarea
          id="switch-coder-instruction"
          autoFocus
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Push the lighting further and tighten the loop"
          data-testid="switch-coder-instruction"
          className="w-full resize-none border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        {switchCoder.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {switchCoder.error.message}
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
            disabled={switchCoder.isPending || !instruction.trim()}
            data-testid="switch-coder-submit"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
          >
            {switchCoder.isPending ? 'Switching...' : 'Switch & run'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfigSidebar({ nodeId }: { nodeId: string }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const nodesList = trpc.nodes.list.useQuery();
  const node = nodeQuery.data?.node;
  const resolvedCoderName =
    nodeQuery.data?.resolvedCoderName ?? node?.coderName ?? null;

  // Discriminate the two config flavours by parent: under a critique it's a
  // mid-graph coder switch (session policy matters); under an instruction root
  // it's the initial coder+skeleton choice for a branch.
  const parentKind = useMemo(() => {
    if (!nodesList.data || !node?.parentId) return null;
    return nodesList.data.find((n) => n.id === node.parentId)?.kind ?? null;
  }, [nodesList.data, node?.parentId]);
  const isSwitch = parentKind === 'critique';

  const childCoder = useMemo(() => {
    if (!nodesList.data) return null;
    return (
      nodesList.data.find(
        (n) => n.parentId === nodeId && n.kind === 'coder'
      ) ?? null
    );
  }, [nodesList.data, nodeId]);

  const deleteNode = trpc.nodes.delete.useMutation({
    onSuccess: () => {
      utils.nodes.list.invalidate();
      setSelectedNodeId(null);
    },
  });

  if (!node) return null;
  const policy = node.sessionPolicy;

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-6 p-5">
        <div className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          {isSwitch ? 'Config · coder switch' : 'Config · coder'}
        </div>

        <Section label="Coder">
          <p className="font-mono text-base text-ink">
            {resolvedCoderName ?? '—'}
          </p>
        </Section>

        {isSwitch ? (
          <Section label="Session">
            <p className="font-mono text-xs uppercase tracking-caps text-ink-soft">
              {policy === 'retain'
                ? 'Retain · resumes the branch session'
                : 'Reset · fresh session, same code'}
            </p>
          </Section>
        ) : (
          <Section label="Skeleton">
            <p className="font-mono text-base text-ink">
              {node.skeletonName ?? 'default'}
            </p>
          </Section>
        )}

        {childCoder ? (
          <Section label="Spawned coder">
            <button
              type="button"
              onClick={() => setSelectedNodeId(childCoder.id)}
              data-testid="config-child-link"
              className="text-left font-serif text-sm leading-snug text-ink-soft underline decoration-hairline-deep underline-offset-2 hover:text-ink"
            >
              {childCoder.instruction || 'View coder'}
            </button>
          </Section>
        ) : null}

        {!READ_ONLY && (
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              data-testid="sidebar-delete"
              className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={isSwitch ? 'Delete config node?' : 'Delete this branch?'}
          description={
            isSwitch
              ? 'Removes the coder switch and the coder (plus its descendants) spawned under it. The action cannot be undone.'
              : 'Removes this coder+skeleton branch — its coder, critiques, and descendants. The instruction and any sibling branches are kept. The action cannot be undone.'
          }
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

function InstructionSidebar({ nodeId }: { nodeId: string }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();

  const nodeQuery = trpc.nodes.get.useQuery({ nodeId });
  const node = nodeQuery.data?.node;

  const deleteNode = trpc.nodes.delete.useMutation({
    onSuccess: () => {
      utils.nodes.list.invalidate();
      setSelectedNodeId(null);
    },
  });

  if (!node) return null;

  return (
    <SidebarShell onClose={() => setSelectedNodeId(null)}>
      <div className="flex flex-col gap-6 p-5">
        <div className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Instruction · root
        </div>

        <Section label="Prompt">
          <p className="whitespace-pre-wrap font-serif text-sm leading-snug text-ink">
            {node.instruction || '—'}
          </p>
        </Section>

        {!READ_ONLY && (
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              data-testid="sidebar-delete"
              className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete this instruction?"
          description="Removes the instruction and every branch under it — all coders, critiques, and their descendants. The action cannot be undone."
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
