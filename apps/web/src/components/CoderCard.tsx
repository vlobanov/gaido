import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { EventPayload, NodeStatus, PersistedEvent } from '@gaido/core';
import {
  StatusBadge,
  activePhase,
  isActiveStatus,
  type PhaseTiming,
} from './StatusBadge';
import { trpc } from '../lib/trpc';
import { httpUrl } from '../lib/url';

export interface CoderCardData extends PhaseTiming {
  id: string;
  instruction: string;
  status: NodeStatus;
  isFavorite: boolean;
  currentRunId: string | null;
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
  selected: boolean;
  [key: string]: unknown;
}

const FAILED_LIKE: ReadonlySet<NodeStatus> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

function CoderCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as CoderCardData;
  const utils = trpc.useUtils();
  const setFavorite = trpc.nodes.setFavorite.useMutation({
    onSuccess: () => utils.nodes.list.invalidate(),
  });

  const active = isActiveStatus(d.status);
  const done = d.status === 'done';
  const failed = FAILED_LIKE.has(d.status);

  const borderCls = selected
    ? 'border-sanguine'
    : active
      ? 'border-hairline animate-breathe-edge'
      : 'border-hairline hover:border-hairline-deep';

  return (
    <div
      data-testid="node-card"
      data-node-id={d.id}
      data-node-kind="coder"
      data-status={d.status}
      data-favorite={String(d.isFavorite)}
      className={`group w-64 border bg-paper transition-colors ${borderCls}`}
    >
      <Handle type="target" position={Position.Top} />

      <Frame
        status={d.status}
        thumbnailArtifactId={d.thumbnailArtifactId}
        videoArtifactId={d.videoArtifactId}
        currentRunId={d.currentRunId}
      />

      <div className="border-t border-hairline px-4 pb-3 pt-3">
        {d.instruction ? (
          <p
            className="font-serif text-base leading-snug text-ink"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
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

      <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <PhaseTicks data={d} active={active} done={done} failed={failed} />
          <StatusBadge status={d.status} kind="coder" timing={d} />
        </div>
        <FavoriteToggle
          isFavorite={d.isFavorite}
          onToggle={() =>
            setFavorite.mutate({ nodeId: d.id, isFavorite: !d.isFavorite })
          }
        />
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function Frame({
  status,
  thumbnailArtifactId,
  videoArtifactId,
  currentRunId,
}: {
  status: NodeStatus;
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
  currentRunId: string | null;
}) {
  const failed = FAILED_LIKE.has(status);
  const done = status === 'done';
  const running = isActiveStatus(status);
  const posterId = thumbnailArtifactId ?? videoArtifactId;

  if (done && posterId) {
    return (
      <DoneFrame
        thumbnailArtifactId={thumbnailArtifactId}
        videoArtifactId={videoArtifactId}
      />
    );
  }

  if (running && currentRunId && !posterId) {
    return <LiveFrame runId={currentRunId} />;
  }

  return (
    <div
      className="relative aspect-square w-full bg-hatch"
      aria-hidden
    >
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-2xl text-sanguine">×</span>
        </div>
      ) : null}
    </div>
  );
}

function DoneFrame({
  thumbnailArtifactId,
  videoArtifactId,
}: {
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const thumbUrl = thumbnailArtifactId
    ? `${httpUrl}/artifacts/${thumbnailArtifactId}`
    : null;
  const videoUrl = videoArtifactId
    ? `${httpUrl}/artifacts/${videoArtifactId}`
    : null;

  if (!videoUrl) {
    return (
      <div className="relative aspect-square w-full overflow-hidden">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid="node-done-frame"
      className="relative aspect-square w-full overflow-hidden"
      onMouseEnter={() => {
        ref.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const v = ref.current;
        if (!v) return;
        v.pause();
        v.currentTime = 0;
      }}
    >
      <video
        ref={ref}
        src={videoUrl}
        muted
        loop
        playsInline
        preload={thumbUrl ? 'none' : 'metadata'}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          draggable={false}
          // Keep the thumbnail on top until the video is actually playing —
          // bridges the load delay on first hover so we don't flash a black
          // frame between mouseenter and the video catching up.
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${
            playing ? 'opacity-0' : 'opacity-100'
          }`}
        />
      ) : null}
    </div>
  );
}

/**
 * Ambient teletype rendering of the run's live event stream. Lives inside the
 * coder frame while running and no thumbnail exists yet. Not for reading —
 * the sidebar carries the full readable log. Treat as atmospheric.
 *
 * - Content is bottom-anchored and the parent clips the overflowing top; no
 *   real scrolling. New lines emerge from below; older lines drift up into
 *   the void.
 * - A linear mask fades the top ~35% into the hatched paper, so text feels
 *   like it's surfacing from nothing.
 * - mix-blend-mode: multiply lets ink soak into the hatch instead of sitting
 *   on top of it.
 * - agent_token events flow inline (consecutive tokens form a paragraph),
 *   matching the sidebar EventStream's behavior. Everything else is a block.
 */
const LIVE_BUFFER_MAX = 80;

type LiveItem =
  | { id: number; kind: 'inline'; text: string }
  | { id: number; kind: 'block'; payload: EventPayload };

const PHASE_MARK: Record<'coding' | 'rendering' | 'critiquing', string> = {
  coding: 'CODING',
  rendering: 'RENDERING',
  critiquing: 'CRITIQUING',
};

function LiveFrame({ runId }: { runId: string }) {
  const [items, setItems] = useState<LiveItem[]>([]);
  const counterRef = useRef(0);
  // Hydration plumbing: subscription frames arriving before history loads
  // are buffered, then merged in (dedupe by id) when history resolves.
  // Without this, reloading mid-run leaves the teletype blank for as long
  // as the coder is between turns.
  const hydratedRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const bufferRef = useRef<PersistedEvent[]>([]);

  useEffect(() => {
    setItems([]);
    counterRef.current = 0;
    hydratedRef.current = false;
    seenIdsRef.current = new Set();
    bufferRef.current = [];
  }, [runId]);

  const appendOne = (prev: LiveItem[], payload: EventPayload): LiveItem[] => {
    let next: LiveItem[];
    if (payload.kind === 'agent_token') {
      const last = prev[prev.length - 1];
      // Coalesce consecutive agent_tokens into one inline run so they
      // flow as a paragraph rather than fragmenting word boundaries.
      if (last && last.kind === 'inline') {
        next = prev.slice(0, -1).concat({
          ...last,
          text: last.text + payload.text,
        });
      } else {
        counterRef.current += 1;
        next = prev.concat({
          id: counterRef.current,
          kind: 'inline',
          text: payload.text,
        });
      }
    } else {
      counterRef.current += 1;
      next = prev.concat({
        id: counterRef.current,
        kind: 'block',
        payload,
      });
    }
    return next.length > LIVE_BUFFER_MAX
      ? next.slice(next.length - LIVE_BUFFER_MAX)
      : next;
  };

  const history = trpc.events.history.useQuery(
    { runId },
    { staleTime: Infinity, refetchOnWindowFocus: false }
  );

  useEffect(() => {
    if (!history.data || hydratedRef.current) return;
    hydratedRef.current = true;

    const seenIds = seenIdsRef.current;
    let acc: LiveItem[] = [];
    const ingest = (ev: PersistedEvent) => {
      if (seenIds.has(ev.id)) return;
      seenIds.add(ev.id);
      // token_usage already drives the sidebar counter — skip in the teletype.
      if (ev.payload.kind === 'token_usage') return;
      acc = appendOne(acc, ev.payload);
    };
    for (const ev of history.data) ingest(ev);
    for (const ev of bufferRef.current) ingest(ev);
    bufferRef.current = [];
    setItems(acc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  trpc.events.subscribe.useSubscription(
    { runId },
    {
      onData: (event: PersistedEvent) => {
        const payload = event.payload;
        // token_usage already drives the live counter in the sidebar.
        if (payload.kind === 'token_usage') return;
        if (!hydratedRef.current) {
          bufferRef.current.push(event);
          return;
        }
        if (seenIdsRef.current.has(event.id)) return;
        seenIdsRef.current.add(event.id);
        setItems((prev) => appendOne(prev, payload));
      },
    }
  );

  // The mask fades older content (top) into transparency so it dissolves
  // into the hatched paper underneath. Bottom is fully visible.
  const maskImage =
    'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.25) 18%, rgba(0,0,0,0.85) 38%, black 60%)';

  return (
    <div
      data-testid="node-live-frame"
      className="relative aspect-square w-full overflow-hidden bg-hatch"
      aria-hidden
    >
      <div
        className="absolute inset-0 bottom-0 flex flex-col justify-end px-2 pb-2 font-mono text-[10px] leading-snug text-ink-soft"
        style={{
          maskImage,
          WebkitMaskImage: maskImage,
          mixBlendMode: 'multiply',
        }}
      >
        <div className="whitespace-pre-wrap break-words">
          {items.map((item) =>
            item.kind === 'inline' ? (
              <span key={item.id}>{item.text}</span>
            ) : (
              <LiveBlock key={item.id} payload={item.payload} />
            )
          )}
          <span className="ml-px inline-block animate-pulse text-ink">▌</span>
        </div>
      </div>
    </div>
  );
}

function LiveBlock({ payload }: { payload: EventPayload }) {
  switch (payload.kind) {
    case 'phase_start':
      return (
        <div className="tracking-caps text-ink-muted">
          {'› '}
          {PHASE_MARK[payload.phase]}
        </div>
      );
    case 'phase_end':
      return (
        <div className={payload.ok ? 'tracking-caps text-ink-muted' : 'tracking-caps text-sanguine'}>
          {'‹ '}
          {PHASE_MARK[payload.phase]}
        </div>
      );
    case 'tool_call':
      return (
        <div className="text-ink-muted">
          <span className="text-ink-faint">·</span> {payload.tool}
          {payload.argsPreview ? (
            <span className="text-ink-faint"> {payload.argsPreview}</span>
          ) : null}
        </div>
      );
    case 'render_progress':
      return (
        <div className="text-ink-muted">
          frame {payload.frame}/{payload.totalFrames}
        </div>
      );
    case 'check_attempt':
      return (
        <div className={payload.ok ? 'text-ink-muted' : 'text-sanguine'}>
          <span className="text-ink-faint">·</span> {payload.check}{' '}
          {payload.ok ? 'ok' : `fail (${payload.attempt})`}
        </div>
      );
    case 'log':
      return (
        <div
          className={
            payload.level === 'error'
              ? 'text-sanguine'
              : payload.level === 'warn'
                ? 'text-ink-soft'
                : 'text-ink-faint'
          }
        >
          {payload.message}
        </div>
      );
    case 'error':
      return <div className="text-sanguine">! {payload.message}</div>;
    default:
      return null;
  }
}

/**
 * Two ticks: coding and rendering. Active tick derived from run timing
 * columns rather than the (kind-agnostic) status field.
 */
function PhaseTicks({
  data,
  active,
  done,
  failed,
}: {
  data: CoderCardData;
  active: boolean;
  done: boolean;
  failed: boolean;
}) {
  const phase = activePhase(data);
  let filled = 0;
  if (done) filled = 2;
  else if (data.renderingFinishedAt) filled = 2;
  else if (data.renderingStartedAt) filled = 1;
  else if (data.codingFinishedAt) filled = 1;

  return (
    <div className="inline-flex items-center gap-1" aria-label={`phase ${filled} of 2`}>
      {[0, 1].map((i) => {
        const isFilled = i < filled;
        const isLiveActive =
          active &&
          ((i === 0 && phase === 'coding') ||
            (i === 1 && phase === 'rendering'));
        let tickCls: string;
        if (isFilled) {
          tickCls = 'bg-ink';
        } else if (isLiveActive) {
          tickCls = 'animate-breathe-tick';
        } else if (failed) {
          tickCls = 'bg-ink-faint';
        } else {
          tickCls = 'bg-hairline-deep';
        }
        return <span key={i} className={`block h-[2px] w-3 ${tickCls}`} />;
      })}
    </div>
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
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      data-testid="node-favorite-toggle"
      aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
      aria-pressed={isFavorite}
      className="shrink-0 p-0.5"
    >
      <span
        aria-hidden
        className={`block h-3 w-[3px] ${
          isFavorite ? 'bg-sanguine' : 'bg-transparent border-l border-hairline-deep'
        }`}
      />
    </button>
  );
}

export const CoderCard = memo(CoderCardComponent);
