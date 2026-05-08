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
    fork(parentId: string, instruction: string): Promise<unknown>;
    select(nodeId: string | null): void;
    retry(nodeId: string): Promise<unknown>;
    cancel(nodeId: string): Promise<unknown>;
    delete(nodeId: string): Promise<unknown>;
  };

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

  // Subscribe to all events globally (no runId filter).
  trpc.events.subscribe.useSubscription(
    {},
    {
      onData: (event: PersistedEvent) => {
        const buf = eventsRef.current;
        buf.push(event);
        if (buf.length > EVENT_BUFFER_MAX) {
          buf.splice(0, buf.length - EVENT_BUFFER_MAX);
        }
      },
    }
  );

  useEffect(() => {
    const debug: GaidoDebug = {
      nodes() {
        return utils.nodes.list.getData() ?? [];
      },
      selectedNodeId() {
        return useUiStore.getState().selectedNodeId;
      },
      events: eventsRef.current,
      trigger: {
        async createRoot(instruction: string) {
          const result = await createRoot.mutateAsync({ instruction });
          await utils.nodes.list.invalidate();
          return result;
        },
        async fork(parentId: string, instruction: string) {
          const result = await createChild.mutateAsync({ parentId, instruction });
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
