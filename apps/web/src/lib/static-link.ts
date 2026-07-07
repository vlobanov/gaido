import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '@vadimlobanov/gaido-server';
import type { GaidoSnapshot, SnapshotNode, SnapshotRun } from '@vadimlobanov/gaido-core';
import { getSnapshot } from './static';

/**
 * Terminating tRPC link for static (published) mode. Resolves the read queries
 * the UI makes from the embedded snapshot, errors on every mutation (editing is
 * disabled), and leaves subscriptions idle (a frozen snapshot has no live
 * events). This is what lets every `trpc.X.useQuery()` call site keep working
 * unchanged with no server — see `docs/publishing.md`.
 */
export function staticLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      // Thin adapter at the client boundary — typed loosely on purpose.
      observable<any, any>((observer) => {
        if (op.type === 'query') {
          try {
            const data = resolveQuery(op.path, op.input, getSnapshot());
            observer.next({ result: { type: 'data', data } });
            observer.complete();
          } catch (err) {
            observer.error(TRPCClientError.from(err as Error));
          }
        } else if (op.type === 'mutation') {
          observer.error(
            TRPCClientError.from(
              new Error('[gaido] this canvas is published read-only; editing is disabled')
            )
          );
        }
        // subscriptions: stay idle, no emit — nothing changes in a snapshot.
        return () => {};
      });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function resolveQuery(path: string, input: any, snap: GaidoSnapshot): unknown {
  switch (path) {
    case 'canvases.list':
      return [canvasRow(snap)];
    case 'canvases.get':
      return canvasRow(snap);
    case 'nodes.list':
      return snap.nodes.map((n) => listRow(n, snap));
    case 'nodes.get': {
      const node = snap.nodes.find((n) => n.id === input?.nodeId);
      if (!node) throw new Error(`node ${input?.nodeId}`);
      const currentRun = node.currentRunId ? runById(snap, node.currentRunId) : null;
      const outputId = currentRun?.outputArtifactId ?? null;
      const outputArt = outputId
        ? snap.artifacts.find((a) => a.id === outputId) ?? null
        : null;
      return {
        node,
        currentRun,
        retryable: false,
        hasSession: false,
        resolvedCoderName: node.resolvedCoderName,
        resolvedCoderKind: node.resolvedCoderKind,
        currentRunOutput: outputArt
          ? { artifactId: outputArt.id, kind: outputArt.kind, mime: outputArt.mime }
          : null,
      };
    }
    case 'runs.get': {
      const run = runById(snap, input?.runId);
      if (!run) throw new Error(`run ${input?.runId}`);
      return { run, artifacts: snap.artifacts.filter((a) => a.runId === run.id) };
    }
    case 'runs.listByNode':
      return snap.runs
        .filter((r) => r.nodeId === input?.nodeId)
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
    case 'events.history':
      return (snap.events ?? []).filter((e) => e.runId === input?.runId);
    case 'references.list':
      return snap.references.filter((r) => r.nodeId === input?.nodeId);
    case 'references.resolveRun':
      // Attaching references is an editing flow, disabled here.
      return null;
    case 'lessons.get':
      return { contents: snap.rules ?? null };
    case 'coders.list':
      return snap.coders;
    case 'skeletons.list':
      // Skeletons only feed the seed (create) flow, which is hidden read-only.
      return [];
    case 'system.info':
      return { projectName: snap.system.projectName, criticKind: snap.system.criticKind };
    default:
      throw new Error(`[gaido] static mode: unsupported query "${path}"`);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function canvasRow(snap: GaidoSnapshot) {
  return {
    id: snap.canvas.id,
    name: snap.canvas.name,
    slug: snap.canvas.slug,
    createdAt: snap.publishedAt,
    updatedAt: snap.publishedAt,
  };
}

function runById(snap: GaidoSnapshot, id: string): SnapshotRun | null {
  return snap.runs.find((r) => r.id === id) ?? null;
}

/** Reproduce the joined `nodes.list` row: node fields + the current run's display data. */
function listRow(n: SnapshotNode, snap: GaidoSnapshot) {
  const run = n.currentRunId ? runById(snap, n.currentRunId) : null;
  return {
    id: n.id,
    parentId: n.parentId,
    canvasId: n.canvasId,
    kind: n.kind,
    positionX: n.positionX,
    positionY: n.positionY,
    instruction: n.instruction ?? '',
    status: n.status,
    currentRunId: n.currentRunId,
    sessionId: null,
    coderName: n.coderName,
    resolvedCoderName: n.resolvedCoderName,
    sessionPolicy: n.sessionPolicy,
    isFavorite: n.isFavorite,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    thumbnailArtifactId: run?.thumbnailArtifactId ?? null,
    videoArtifactId: run?.videoArtifactId ?? null,
    // Older snapshots (pre output generalization) lack the key entirely.
    outputArtifactId: run?.outputArtifactId ?? null,
    outputKind:
      snap.artifacts.find((a) => a.id === run?.outputArtifactId)?.kind ?? null,
    previewUrl: run?.previewUrl ?? null,
    message: run?.message ?? null,
    codingStartedAt: run?.codingStartedAt ?? null,
    codingFinishedAt: run?.codingFinishedAt ?? null,
    renderingStartedAt: run?.renderingStartedAt ?? null,
    renderingFinishedAt: run?.renderingFinishedAt ?? null,
    critiquingStartedAt: run?.critiquingStartedAt ?? null,
    critiquingFinishedAt: run?.critiquingFinishedAt ?? null,
  };
}
