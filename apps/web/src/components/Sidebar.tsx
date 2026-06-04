import { useEffect, useMemo, useState } from 'react';
import type {
  CoderMessage,
  CoderMessageKind,
  EventPayload,
  NodeKind,
  NodeStatus,
} from '@gaido/core';
import { trpc } from '../lib/trpc';
import { httpUrl } from '../lib/url';
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
              kind="coder"
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
              videoArtifactId={currentRun?.videoArtifactId ?? null}
              thumbnailArtifactId={currentRun?.thumbnailArtifactId ?? null}
              previewUrl={currentRun?.previewUrl ?? null}
            />
          </Section>
        )}

        <BoundReferences nodeId={nodeId} />

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
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-testid="sidebar-delete"
            className="ml-auto px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
          >
            Delete
          </button>
        </div>
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
            kind="critique"
            timing={currentRun ?? null}
            size="md"
          />
        </div>

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
              <div className="mb-2 flex items-baseline justify-between">
                <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
                  Overall
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
          </Section>
        ) : null}

        <RulesPanel proposedRules={currentRun?.critique?.proposedRules ?? []} />

        <RunDetails kind="critique" runId={node.currentRunId ?? null} />

        {active && node.currentRunId ? (
          <Section label="Live events">
            <EventStream runId={node.currentRunId} onEvent={refreshNodeState} />
          </Section>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
          <button
            type="button"
            onClick={() => setForkOpen(true)}
            data-testid="sidebar-fork"
            className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep"
          >
            Fork
          </button>
          {isHumanCritic ? null : (
            <button
              type="button"
              disabled={!canTrigger || retryNode.isPending}
              onClick={() => retryNode.mutate({ nodeId })}
              data-testid="sidebar-retry"
              className="border border-hairline-deep bg-paper px-4 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40 disabled:hover:bg-paper"
            >
              {retryNode.isPending ? 'Starting...' : runLabel}
            </button>
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

        {retryNode.error ? (
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
  return (
    <span
      data-testid="token-counter"
      className="inline-flex items-center font-mono text-xs uppercase tracking-caps text-ink-muted"
      title={`${tokens.inputTokens.toLocaleString()} input / ${tokens.outputTokens.toLocaleString()} output tokens`}
    >
      <span className="text-ink-faint">·</span>
      <span className="ml-2 text-ink-soft">{formatTokens(tokens.inputTokens)}</span>
      <span className="ml-1 text-ink-faint">in</span>
      <span className="ml-2 text-ink-soft">{formatTokens(tokens.outputTokens)}</span>
      <span className="ml-1 text-ink-faint">out</span>
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
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
                <button
                  type="button"
                  disabled={done || promote.isPending}
                  onClick={() => promote.mutate({ rule })}
                  data-testid="promote-rule"
                  className="shrink-0 border border-hairline-deep bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-caps text-ink-soft transition-colors hover:bg-paper-deep disabled:cursor-default disabled:border-hairline disabled:bg-paper disabled:text-ink-faint"
                >
                  {done ? '✓ in rules' : 'Promote'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

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

      {promote.error ? (
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
  previewUrl,
}: {
  videoArtifactId: string | null;
  thumbnailArtifactId: string | null;
  previewUrl: string | null;
}) {
  const media = videoArtifactId ? (
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
  ) : thumbnailArtifactId ? (
    <img
      data-testid="output-thumbnail"
      className="aspect-square w-full border border-hairline bg-paper-deep object-contain"
      src={`${httpUrl}/artifacts/${thumbnailArtifactId}`}
      alt="Render thumbnail"
    />
  ) : (
    <div className="flex aspect-square w-full items-center justify-center bg-hatch font-mono text-xs uppercase tracking-caps text-ink-faint">
      No render yet
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {media}
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
  const retry = trpc.nodes.retry.useMutation({
    onSuccess: () => onRetried(),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (retry.isPending) return;
    const trimmed = prompt.trim();
    retry.mutate({ nodeId, prompt: trimmed || undefined });
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
