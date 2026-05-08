import { EventEmitter } from 'node:events';
import { eventId, schema } from '@gaido/core';
import type { EventPayload, PersistedEvent } from '@gaido/core';
import type { Db } from './db.js';

const ALL = '__all__';

export class EventBus {
  private emitter = new EventEmitter();

  constructor(private readonly db: Db) {
    // Allow many WS subscribers without warnings.
    this.emitter.setMaxListeners(0);
  }

  /** Persist an event to the events table and fan out to subscribers. */
  publish(runId: string, payload: EventPayload): PersistedEvent {
    const event: PersistedEvent = {
      id: eventId(),
      runId,
      ts: Date.now(),
      payload,
    };
    this.db.insert(schema.events).values(event).run();
    this.emitter.emit(runId, event);
    this.emitter.emit(ALL, event);
    return event;
  }

  /**
   * Subscribe to events. If `runId` is provided, only events for that run are
   * delivered; otherwise all events.
   */
  subscribe(
    runId: string | undefined,
    listener: (event: PersistedEvent) => void
  ): () => void {
    const channel = runId ?? ALL;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }
}
