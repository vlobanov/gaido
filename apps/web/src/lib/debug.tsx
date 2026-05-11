import { useEffect, useRef } from 'react';
import type { NodeStatus, PersistedEvent } from '@gaido/core';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@gaido/server';
import { trpc } from './trpc';
import { useUiStore } from '../store';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type NodeRow = RouterOutputs['nodes']['list'][number];

interface WaitForOpts {
  timeoutMs?: number;
  pollMs?: number;
}

export interface GaidoDebug {
  nodes(): NodeRow[];
  selectedNodeId(): string | null;
  events: PersistedEvent[];

  trigger: {
    createRoot(instruction: string): Promise<unknown>;
    /**
     * Fork a coder node: waits for its auto-spawned critique child to exist,
     * then creates a new coder under that critique. Multiple forks from the
     * same coder produce sibling coders under the same critique.
     */
    fork(coderNodeId: string, instruction: string): Promise<unknown>;
    /** Start the first run for an idle critique node (or retry a terminal one). */
    runCritique(critiqueNodeId: string): Promise<unknown>;
    select(nodeId: string | null): void;
    retry(nodeId: string): Promise<unknown>;
    cancel(nodeId: string): Promise<unknown>;
    delete(nodeId: string): Promise<unknown>;
  };

  /** Convenience helper for tests: find a coder's auto-spawned critique child. */
  critiqueChildOf(coderNodeId: string): NodeRow | null;

  waitFor(predicate: () => boolean, opts?: WaitForOpts): Promise<void>;
  waitForNodeStatus(
    nodeId: string,
    status: NodeStatus | NodeStatus[],
    timeoutMs?: number
  ): Promise<void>;
  refetch(): Promise<void>;
}

declare global {
  interface Window {
    __gaido?: GaidoDebug;
  }
}

const EVENT_BUFFER_MAX = 500;

function waitFor(
  predicate: () => boolean,
  opts?: WaitForOpts
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const pollMs = opts?.pollMs ?? 100;
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      let result: boolean;
      try {
        result = !!predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (result) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function DebugBridge() {
  const utils = trpc.useUtils();

  const eventsRef = useRef<PersistedEvent[]>([]);

  const createRoot = trpc.nodes.createRoot.useMutation();
  const createChild = trpc.nodes.createChild.useMutation();
  const retry = trpc.nodes.retry.useMutation();
  const cancel = trpc.nodes.cancel.useMutation();
  const deleteNode = trpc.nodes.delete.useMutation();

  // Single global subscription serves two jobs:
  // 1. Buffer events for window.__gaido tests.
  // 2. Invalidate nodes.list on phase boundaries so graph cards update live
  //    without polling. tanstack-query coalesces concurrent invalidations.
  trpc.events.subscribe.useSubscription(
    {},
    {
      onData: (event: PersistedEvent) => {
        const buf = eventsRef.current;
        buf.push(event);
        if (buf.length > EVENT_BUFFER_MAX) {
          buf.splice(0, buf.length - EVENT_BUFFER_MAX);
        }

        const kind = event.payload.kind;
        if (kind === 'phase_start' || kind === 'phase_end' || kind === 'error') {
          void utils.nodes.list.invalidate();
        }
      },
    }
  );

  useEffect(() => {
    const findCritiqueChild = (coderNodeId: string): NodeRow | null => {
      const list = utils.nodes.list.getData() ?? [];
      return (
        list.find(
          (n) => n.parentId === coderNodeId && n.kind === 'critique'
        ) ?? null
      );
    };

    const debug: GaidoDebug = {
      nodes() {
        return utils.nodes.list.getData() ?? [];
      },
      selectedNodeId() {
        return useUiStore.getState().selectedNodeId;
      },
      events: eventsRef.current,
      critiqueChildOf: findCritiqueChild,
      trigger: {
        async createRoot(instruction: string) {
          const result = await createRoot.mutateAsync({ instruction });
          await utils.nodes.list.invalidate();
          return result;
        },
        async fork(coderNodeId: string, instruction: string) {
          // Wait for the coder to finish AND for its auto-spawned critique
          // child to appear in the cached node list.
          await waitFor(
            () => {
              const list = utils.nodes.list.getData() ?? [];
              const coder = list.find((n) => n.id === coderNodeId);
              if (!coder || coder.status !== 'done') return false;
              return list.some(
                (n) => n.parentId === coderNodeId && n.kind === 'critique'
              );
            },
            { timeoutMs: 60_000 }
          );
          const critique = findCritiqueChild(coderNodeId);
          if (!critique) {
            throw new Error(
              `No critique child found for coder ${coderNodeId}`
            );
          }
          const result = await createChild.mutateAsync({
            parentId: critique.id,
            instruction,
          });
          await utils.nodes.list.invalidate();
          return result;
        },
        async runCritique(critiqueNodeId: string) {
          const result = await retry.mutateAsync({ nodeId: critiqueNodeId });
          await utils.nodes.list.invalidate();
          return result;
        },
        select(nodeId: string | null) {
          useUiStore.getState().setSelectedNodeId(nodeId);
        },
        async retry(nodeId: string) {
          const result = await retry.mutateAsync({ nodeId });
          await utils.nodes.list.invalidate();
          return result;
        },
        async cancel(nodeId: string) {
          const result = await cancel.mutateAsync({ nodeId });
          await utils.nodes.list.invalidate();
          return result;
        },
        async delete(nodeId: string) {
          const result = await deleteNode.mutateAsync({ nodeId });
          await utils.nodes.list.invalidate();
          return result;
        },
      },
      waitFor,
      async waitForNodeStatus(
        nodeId: string,
        status: NodeStatus | NodeStatus[],
        timeoutMs?: number
      ) {
        const targets = Array.isArray(status) ? status : [status];
        await waitFor(
          () => {
            const list = utils.nodes.list.getData() ?? [];
            const node = list.find((n) => n.id === nodeId);
            return !!node && targets.includes(node.status as NodeStatus);
          },
          { timeoutMs }
        );
      },
      async refetch() {
        await utils.nodes.list.invalidate();
      },
    };

    window.__gaido = debug;
    return () => {
      if (window.__gaido === debug) {
        delete window.__gaido;
      }
    };
  }, [utils, createRoot, createChild, retry, cancel, deleteNode]);

  return null;
}
