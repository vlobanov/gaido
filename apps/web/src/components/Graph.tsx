import { useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import type { NodeKind, NodeStatus } from '@gaido/core';
import { useUiStore } from '../store';
import { CoderCard, type CoderCardData } from './CoderCard';
import { CritiqueCard, type CritiqueCardData } from './CritiqueCard';

interface GaidoNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  positionX: number;
  positionY: number;
  instruction: string;
  status: NodeStatus;
  isFavorite: boolean;
  currentRunId: string | null;
  thumbnailArtifactId: string | null;
  videoArtifactId: string | null;
  codingStartedAt: number | null;
  codingFinishedAt: number | null;
  renderingStartedAt: number | null;
  renderingFinishedAt: number | null;
  critiquingStartedAt: number | null;
  critiquingFinishedAt: number | null;
  createdAt: number;
}

// Mirrors apps/server/src/layout.ts (CODER_CARD_WIDTH 256 + GAP 40); plus a
// little extra so lanes don't bleed into each other when sibling forks spread.
const LANE_WIDTH = 256 + 4 * 40;

interface GraphProps {
  nodes: GaidoNode[];
}

type CardData = CoderCardData | CritiqueCardData;

const nodeTypes: NodeTypes = {
  coder: CoderCard,
  critique: CritiqueCard,
};

export function Graph({ nodes: serverNodes }: GraphProps) {
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);

  // Auto-lane: when a canvas contains multiple root coders, shift each root's
  // subtree horizontally so the trees don't overlap. Single-root canvases are
  // untouched (offset 0). The shift is applied uniformly to a subtree, so any
  // future user drags survive relative to their root.
  const laneOffsetByNodeId = useMemo<Map<string, number>>(() => {
    const offsets = new Map<string, number>();
    const roots = serverNodes
      .filter((n) => n.parentId === null)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
    if (roots.length <= 1) return offsets;
    const rootLane = new Map<string, number>();
    roots.forEach((r, i) => rootLane.set(r.id, i));
    const parentById = new Map<string, string | null>();
    for (const n of serverNodes) parentById.set(n.id, n.parentId);
    for (const n of serverNodes) {
      let cur: string | null = n.id;
      let lane: number | undefined;
      while (cur != null) {
        const maybe = rootLane.get(cur);
        if (maybe != null) {
          lane = maybe;
          break;
        }
        cur = parentById.get(cur) ?? null;
      }
      if (lane != null && lane > 0) {
        offsets.set(n.id, lane * LANE_WIDTH);
      }
    }
    return offsets;
  }, [serverNodes]);

  const flowNodes = useMemo<Node<CardData>[]>(
    () =>
      serverNodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: {
          x: n.positionX + (laneOffsetByNodeId.get(n.id) ?? 0),
          y: n.positionY,
        },
        data: {
          id: n.id,
          instruction: n.instruction,
          status: n.status,
          isFavorite: n.isFavorite,
          currentRunId: n.currentRunId,
          thumbnailArtifactId: n.thumbnailArtifactId,
          videoArtifactId: n.videoArtifactId,
          codingStartedAt: n.codingStartedAt,
          codingFinishedAt: n.codingFinishedAt,
          renderingStartedAt: n.renderingStartedAt,
          renderingFinishedAt: n.renderingFinishedAt,
          critiquingStartedAt: n.critiquingStartedAt,
          critiquingFinishedAt: n.critiquingFinishedAt,
          selected: n.id === selectedNodeId,
        },
        selected: n.id === selectedNodeId,
      })),
    [serverNodes, selectedNodeId, laneOffsetByNodeId]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      serverNodes
        .filter((n) => n.parentId)
        .map((n) => ({
          id: `e_${n.parentId}_${n.id}`,
          source: n.parentId as string,
          target: n.id,
          type: 'smoothstep',
        })),
    [serverNodes]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.4}
          color="var(--hairline-deep)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
