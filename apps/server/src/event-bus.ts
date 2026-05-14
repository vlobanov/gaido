import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
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

export interface EventBusOpts {
  /**
   * Root for per-run NDJSON sidecars. Each event is appended to
   * `<logsDir>/<runId>/events.ndjson` as JSON. Optional — if unset, events
   * still land in SQLite but no on-disk mirror is written. Useful for tests
   * that don't care about the sidecar.
   */
  logsDir?: string;
}

export class EventBus {
  private emitter = new EventEmitter();
  private readonly logsDir: string | undefined;
  private readonly ensuredRunDirs = new Set<string>();

  constructor(
    private readonly db: Db,
    opts: EventBusOpts = {}
  ) {
    this.emitter.setMaxListeners(0);
    this.logsDir = opts.logsDir;
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
    this.appendSidecar(event);
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

  /**
   * Append the event to the per-run sidecar. Best-effort: errors here are
   * logged and swallowed so a broken disk doesn't take down the event bus
   * (SQLite is the source of truth; the sidecar is for grepping postmortem).
   */
  private appendSidecar(event: PersistedEvent): void {
    if (!this.logsDir) return;
    const runDir = path.join(this.logsDir, event.runId);
    if (!this.ensuredRunDirs.has(runDir)) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        this.ensuredRunDirs.add(runDir);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[event-bus] mkdir ${runDir} failed:`, err);
        return;
      }
    }
    try {
      fs.appendFileSync(
        path.join(runDir, 'events.ndjson'),
        JSON.stringify(event) + '\n'
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[event-bus] append events.ndjson failed:`, err);
    }
  }
}
