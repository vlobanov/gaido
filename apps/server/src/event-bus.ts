import { EventEmitter } from 'node:events';
import { eventId, schema } from '@gaido/core';
import type { EventPayload, PersistedEvent } from '@gaido/core';
import type { Db } from './db.js';

const ALL = '__all__';
const RUN_PREFIX = 'runId:';
const CANVAS_PREFIX = 'canvas:';

export interface SubscribeFilter {
  runId?: string;
  canvasId?: string;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor(private readonly db: Db) {
    this.emitter.setMaxListeners(0);
  }

  /** Persist an event and fan out to runId, canvas, and global buckets. */
  publish(
    runId: string,
    canvasId: string | null,
    payload: EventPayload
  ): PersistedEvent {
    const event: PersistedEvent = {
      id: eventId(),
      runId,
      ts: Date.now(),
      payload,
    };
    this.db.insert(schema.events).values(event).run();
    this.emitter.emit(RUN_PREFIX + runId, event);
    if (canvasId) this.emitter.emit(CANVAS_PREFIX + canvasId, event);
    this.emitter.emit(ALL, event);
    return event;
  }

  /**
   * Subscribe with optional filter. Resolution:
   *   runId → only that run; else canvasId → only that canvas;
   *   else → global firehose.
   */
  subscribe(
    filter: SubscribeFilter,
    listener: (event: PersistedEvent) => void
  ): () => void {
    const channel = filter.runId
      ? RUN_PREFIX + filter.runId
      : filter.canvasId
        ? CANVAS_PREFIX + filter.canvasId
        : ALL;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }
}
