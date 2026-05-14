import { useEffect, useRef, useState } from 'react';
import type { EventPayload, PersistedEvent, RunPhase } from '@gaido/core';
import { trpc } from '../lib/trpc';

interface StreamItem {
  id: number;
  payload: EventPayload;
}

interface EventStreamProps {
  runId: string;
  /** Called whenever an event arrives, so the parent can invalidate node state */
  onEvent?: () => void;
  /**
   * Fired with each `token_usage` event so the parent can render a live token
   * counter outside the stream (e.g. next to the status badge). Payload values
   * are run-cumulative, so the parent can render the latest and ignore prior.
   */
  onTokenUsage?: (payload: Extract<EventPayload, { kind: 'token_usage' }>) => void;
}

const PHASE_LABEL: Record<RunPhase, string> = {
  coding: 'Coding',
  rendering: 'Rendering',
  critiquing: 'Critiquing',
};

const MAX_ITEMS = 200;

export function EventStream({ runId, onEvent, onTokenUsage }: EventStreamProps) {
  const [items, setItems] = useState<StreamItem[]>([]);
  const counterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Hydration coordination: subscription events that arrive before the
  // history query resolves go into the buffer; they get merged in (deduped
  // by id) when history lands so reload doesn't double-render the events
  // that came back from the table.
  const hydratedRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const bufferRef = useRef<PersistedEvent[]>([]);

  // Reset stream whenever the run changes
  useEffect(() => {
    setItems([]);
    counterRef.current = 0;
    hydratedRef.current = false;
    seenIdsRef.current = new Set();
    bufferRef.current = [];
  }, [runId]);

  // Backfill from the persisted events table so reloading mid-run keeps the
  // timeline. Without this the stream would start empty and only show events
  // emitted after the WS subscription connects.
  const history = trpc.events.history.useQuery(
    { runId },
    { staleTime: Infinity, refetchOnWindowFocus: false }
  );

  useEffect(() => {
    if (!history.data || hydratedRef.current) return;
    hydratedRef.current = true;

    const seenIds = seenIdsRef.current;
    const initial: StreamItem[] = [];
    let latestTokenUsage: Extract<EventPayload, { kind: 'token_usage' }> | null = null;

    const ingest = (ev: PersistedEvent) => {
      if (seenIds.has(ev.id)) return;
      seenIds.add(ev.id);
      if (ev.payload.kind === 'token_usage') {
        latestTokenUsage = ev.payload;
        return;
      }
      counterRef.current += 1;
      initial.push({ id: counterRef.current, payload: ev.payload });
    };

    for (const ev of history.data) ingest(ev);
    // Drain any events that arrived via subscription while history was loading.
    for (const ev of bufferRef.current) ingest(ev);
    bufferRef.current = [];

    setItems(initial.length > MAX_ITEMS ? initial.slice(-MAX_ITEMS) : initial);
    if (latestTokenUsage) onTokenUsage?.(latestTokenUsage);
  }, [history.data, onTokenUsage]);

  trpc.events.subscribe.useSubscription(
    { runId },
    {
      onData: (event: PersistedEvent) => {
        onEvent?.();
        if (!hydratedRef.current) {
          // Hold until history finishes loading; dedupe-merge happens there.
          bufferRef.current.push(event);
          return;
        }
        if (seenIdsRef.current.has(event.id)) return;
        seenIdsRef.current.add(event.id);
        // token_usage drives the live counter next to the status badge — it
        // would clutter the timeline as repeating "tokens N in / M out" rows.
        if (event.payload.kind === 'token_usage') {
          onTokenUsage?.(event.payload);
          return;
        }
        counterRef.current += 1;
        setItems((prev) => {
          const next = [
            ...prev,
            { id: counterRef.current, payload: event.payload },
          ];
          // keep stream bounded so it stays cheap to render
          return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
        });
      },
    }
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div
        data-testid="event-stream"
        className="border border-hairline bg-paper-deep p-3 font-mono text-xs text-ink-faint"
      >
        waiting for events
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="event-stream"
      className="max-h-64 overflow-y-auto border border-hairline bg-paper-deep p-3 font-mono text-xs leading-relaxed text-ink-soft"
    >
      {items.map((item) => (
        <EventLine key={item.id} payload={item.payload} />
      ))}
    </div>
  );
}

function EventLine({ payload }: { payload: EventPayload }) {
  switch (payload.kind) {
    case 'phase_start':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-ink-soft"
        >
          <span className="text-ink-muted">›</span> {PHASE_LABEL[payload.phase]} started
        </div>
      );
    case 'phase_end':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className={payload.ok ? 'text-ink' : 'text-sanguine'}
        >
          <span className="text-ink-muted">‹</span> {PHASE_LABEL[payload.phase]}{' '}
          {payload.ok ? 'finished' : 'failed'}
        </div>
      );
    case 'agent_token':
      return (
        <span
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="whitespace-pre-wrap break-words text-ink-soft"
        >
          {payload.text}
        </span>
      );
    case 'tool_call':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-ink-muted"
        >
          <span className="text-ink-faint">·</span> tool: {payload.tool}
          {payload.argsPreview ? (
            <span className="text-ink-faint"> {payload.argsPreview}</span>
          ) : null}
        </div>
      );
    case 'token_usage':
      // Rendered as a live counter outside the stream — see onTokenUsage above.
      return null;
    case 'render_progress':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-ink-muted"
        >
          frame {payload.frame}/{payload.totalFrames}
        </div>
      );
    case 'check_attempt':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className={payload.ok ? 'text-ink' : 'text-sanguine'}
        >
          <span className="text-ink-muted">·</span> check {payload.check}{' '}
          <span className="text-ink-faint">(attempt {payload.attempt})</span>{' '}
          {payload.ok ? 'passed' : 'failed'}
        </div>
      );
    case 'log': {
      const tone =
        payload.level === 'error'
          ? 'text-sanguine'
          : payload.level === 'warn'
            ? 'text-ink-soft'
            : 'text-ink-faint';
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className={tone}
        >
          [{payload.level}] {payload.message}
        </div>
      );
    }
    case 'error':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-sanguine"
        >
          error: {payload.message}
        </div>
      );
    default:
      return null;
  }
}
