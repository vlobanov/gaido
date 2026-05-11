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
}

const PHASE_LABEL: Record<RunPhase, string> = {
  coding: 'Coding',
  rendering: 'Rendering',
  critiquing: 'Critiquing',
};

export function EventStream({ runId, onEvent }: EventStreamProps) {
  const [items, setItems] = useState<StreamItem[]>([]);
  const counterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset stream whenever the run changes
  useEffect(() => {
    setItems([]);
    counterRef.current = 0;
  }, [runId]);

  trpc.events.subscribe.useSubscription(
    { runId },
    {
      onData: (event: PersistedEvent) => {
        counterRef.current += 1;
        setItems((prev) => {
          const next = [
            ...prev,
            { id: counterRef.current, payload: event.payload },
          ];
          // keep stream bounded so it stays cheap to render
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
        onEvent?.();
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
