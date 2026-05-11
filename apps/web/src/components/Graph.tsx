import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodesChange,
} from '@xyflow/react';
import type { NodeKind, NodeStatus } from '@gaido/core';
import { trpc } from '../lib/trpc';
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
}

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
  const setPosition = trpc.nodes.setPosition.useMutation();

  // Local copy of node positions, kept in sync with server but allowing
  // instant drag feedback without waiting for the round-trip.
  const flowNodes = useMemo<Node<CardData>[]>(
    () =>
      serverNodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: { x: n.positionX, y: n.positionY },
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
        draggable: true,
      })),
    [serverNodes, selectedNodeId]
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

  const localNodesRef = useRef(flowNodes);
  localNodesRef.current = flowNodes;

  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      for (const t of debounceRef.current.values()) clearTimeout(t);
      debounceRef.current.clear();
    },
    []
  );

  const onNodesChange: OnNodesChange<Node<CardData>> = useCallback(
    (changes: NodeChange<Node<CardData>>[]) => {
      // Apply locally for snappy drag UX
      localNodesRef.current = applyNodeChanges(changes, localNodesRef.current);

      for (const change of changes) {
        if (change.type !== 'position' || change.dragging || !change.position) continue;
        const id = change.id;
        const { x, y } = change.position;
        const existing = debounceRef.current.get(id);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          debounceRef.current.delete(id);
          setPosition.mutate({ nodeId: id, x, y });
        }, 300);
        debounceRef.current.set(id, t);
      }
    },
    [setPosition]
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
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1}
          color="var(--hairline)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
