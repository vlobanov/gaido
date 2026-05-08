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
        className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-500"
      >
        Waiting for events...
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="event-stream"
      className="max-h-64 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-300"
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
          className="text-zinc-400"
        >
          <span className="text-zinc-500">▸</span> {PHASE_LABEL[payload.phase]} started
        </div>
      );
    case 'phase_end':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className={payload.ok ? 'text-emerald-400' : 'text-red-400'}
        >
          <span className="text-zinc-500">◂</span> {PHASE_LABEL[payload.phase]}{' '}
          {payload.ok ? 'finished' : 'failed'}
        </div>
      );
    case 'agent_token':
      return (
        <span
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="whitespace-pre-wrap break-words text-zinc-300"
        >
          {payload.text}
        </span>
      );
    case 'tool_call':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-blue-400"
        >
          <span className="text-zinc-500">·</span> tool: {payload.tool}
          {payload.argsPreview ? (
            <span className="text-zinc-500"> {payload.argsPreview}</span>
          ) : null}
        </div>
      );
    case 'render_progress':
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className="text-indigo-400"
        >
          frame {payload.frame}/{payload.totalFrames}
        </div>
      );
    case 'log': {
      const colour =
        payload.level === 'error'
          ? 'text-red-400'
          : payload.level === 'warn'
            ? 'text-amber-400'
            : 'text-zinc-500';
      return (
        <div
          data-testid="event-row"
          data-event-kind={payload.kind}
          className={colour}
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
          className="text-red-400"
        >
          error: {payload.message}
        </div>
      );
    default:
      return null;
  }
}
