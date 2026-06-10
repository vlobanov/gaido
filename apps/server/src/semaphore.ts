/** Returned by `acquire`; call to free the slot. Idempotent. */
export type ReleaseSlot = () => void;

interface Waiter {
  signal: AbortSignal;
  resolve: (release: ReleaseSlot) => void;
  onAbort: () => void;
}

/**
 * Counting semaphore gating concurrent run phases (see `concurrency` in
 * gaido.config.ts). FIFO: slots free up to the longest-waiting run. An
 * aborted waiter (run cancelled while queued) leaves the queue without ever
 * consuming a slot — its `acquire` rejects with an AbortError.
 *
 * Process-global by design: sized once at startup from the project config;
 * skeleton overlays cannot resize it (the overlay loader rejects
 * `concurrency`).
 */
export class Semaphore {
  private free: number;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    // A non-positive limit would deadlock every run; clamp rather than throw
    // so a config typo degrades to serial execution instead of a dead server.
    this.free = Math.max(1, Math.floor(limit));
  }

  acquire(signal: AbortSignal): Promise<ReleaseSlot> {
    if (signal.aborted) return Promise.reject(makeAbortError());
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        onAbort: () => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(makeAbortError());
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter instead of bumping `free`,
      // so a release can't be raced by a fresh acquire jumping the queue.
      const next = this.waiters.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(this.makeRelease());
      } else {
        this.free += 1;
      }
    };
  }
}

function makeAbortError(): Error {
  const err = new Error('aborted while waiting for a concurrency slot');
  err.name = 'AbortError';
  return err;
}
