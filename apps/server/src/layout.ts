import type { Critique, NodeKind } from '@vadimlobanov/gaido-core';

// Card geometry constants. Mirrors the CSS in apps/web (CoderCard, CritiqueCard).
// Brittle by design — if those components change padding, line height, or the
// square thumbnail ratio, bump these or layouts will overlap.

const GAP = 40;

// Coder card height is constant: w-64 (256) square frame + 2-line clamped
// instruction (~69px) + footer row (~33px) + borders.
export const CODER_CARD_HEIGHT = 360;

// Config (coder-switch) card height: a compact marker — header + one
// coder/session line + borders. Mirrors ConfigCard.tsx in apps/web.
export const CONFIG_CARD_HEIGHT = 100;

// CritiqueCard rendered height, estimated from content.
const CRIT_HEADER = 37;
const CRIT_PADDING_Y = 24;
const CRIT_MIN_BODY = 80; // min-h-[5rem]
const CRIT_LINE_HEIGHT = 19; // text-sm × leading-snug
const CRIT_RATING_BLOCK = 32; // mt-2 line for "N of 5"
const CRIT_MAX_LINES = 10; // matches WebkitLineClamp in CritiqueCard
const CRIT_CHARS_PER_LINE = 30; // text-sm font-serif inside w-64 px-4

export function critiqueCardHeight(critique: Critique | null | undefined): number {
  if (!critique?.overall) {
    return CRIT_HEADER + CRIT_MIN_BODY;
  }
  const visualLines = critique.overall.split('\n').reduce(
    (acc, line) =>
      acc + Math.max(1, Math.ceil(line.length / CRIT_CHARS_PER_LINE)),
    0
  );
  const lines = Math.min(CRIT_MAX_LINES, visualLines);
  const rating = typeof critique.rating === 'number' ? CRIT_RATING_BLOCK : 0;
  const body = Math.max(CRIT_MIN_BODY, lines * CRIT_LINE_HEIGHT + CRIT_PADDING_Y + rating);
  return CRIT_HEADER + body;
}

export function nextChildY(parentY: number, parentHeight: number): number {
  return parentY + parentHeight + GAP;
}

// Coder card width (w-64) — used to spread sibling forks horizontally so a
// second/third fork from the same critique doesn't stack on top of the
// first. Mirrors apps/web/src/components/CoderCard.tsx.
export const CODER_CARD_WIDTH = 256;
export const SIBLING_X_STEP = CODER_CARD_WIDTH + GAP;

// One column of breathing room between adjacent root subtrees. Without it
// the rightmost card of one tree sits a single GAP away from the leftmost
// card of the next — readable but cramped.
const LANE_GAP_COLS = 1;

interface LayoutNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  createdAt: number;
}

/**
 * Tidy-tree auto-layout for one canvas.
 *
 * Each subtree owns a contiguous range of "columns"; a column is exactly
 * `SIBLING_X_STEP` wide so neighbouring leaves sit one card+gap apart. A
 * parent's column is the midpoint of its children's columns, so chains
 * stay centred above their descendants. Root subtrees are stacked left to
 * right by `createdAt` with one empty column between them.
 *
 * Y is walked top-down using the real per-card heights: coder is fixed at
 * `CODER_CARD_HEIGHT`, critique grows with its current critique text — so
 * re-laying out after a long critique writes through reflows everything
 * below it.
 */
export function layoutCanvasNodes(
  nodes: LayoutNode[],
  critiqueByNodeId: Map<string, Critique | null>
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return out;

  const childrenById = new Map<string, LayoutNode[]>();
  const nodeById = new Map<string, LayoutNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  for (const n of nodes) {
    if (n.parentId == null) continue;
    if (!childrenById.has(n.parentId)) childrenById.set(n.parentId, []);
    childrenById.get(n.parentId)!.push(n);
  }
  for (const kids of childrenById.values()) {
    kids.sort((a, b) => a.createdAt - b.createdAt);
  }

  const widthCache = new Map<string, number>();
  function subtreeWidth(id: string): number {
    const cached = widthCache.get(id);
    if (cached != null) return cached;
    const kids = childrenById.get(id) ?? [];
    if (kids.length === 0) {
      widthCache.set(id, 1);
      return 1;
    }
    const w = Math.max(1, kids.reduce((sum, k) => sum + subtreeWidth(k.id), 0));
    widthCache.set(id, w);
    return w;
  }

  const colById = new Map<string, number>();
  function assignCols(id: string, leftCol: number): void {
    const kids = childrenById.get(id) ?? [];
    if (kids.length === 0) {
      colById.set(id, leftCol);
      return;
    }
    let cur = leftCol;
    for (const k of kids) {
      assignCols(k.id, cur);
      cur += subtreeWidth(k.id);
    }
    const first = kids[0]!;
    const last = kids[kids.length - 1]!;
    const firstCol = colById.get(first.id)!;
    const lastCol = colById.get(last.id)!;
    colById.set(id, (firstCol + lastCol) / 2);
  }

  function assignY(id: string, y: number): void {
    const node = nodeById.get(id)!;
    const x = colById.get(id)! * SIBLING_X_STEP;
    out.set(id, { x, y });
    const h =
      node.kind === 'coder'
        ? CODER_CARD_HEIGHT
        : node.kind === 'config'
          ? CONFIG_CARD_HEIGHT
          : critiqueCardHeight(critiqueByNodeId.get(id) ?? null);
    const nextY = y + h + GAP;
    for (const k of childrenById.get(id) ?? []) {
      assignY(k.id, nextY);
    }
  }

  const roots = nodes
    .filter((n) => n.parentId == null)
    .sort((a, b) => a.createdAt - b.createdAt);
  let nextRootCol = 0;
  for (const root of roots) {
    assignCols(root.id, nextRootCol);
    assignY(root.id, 0);
    nextRootCol += subtreeWidth(root.id) + LANE_GAP_COLS;
  }

  return out;
}
