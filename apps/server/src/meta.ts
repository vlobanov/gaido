import { schema } from '@vadimlobanov/gaido-core';
import type { BranchMeta, MetaField, MetaValue } from '@vadimlobanov/gaido-core';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './db.js';
import type { EventBus } from './event-bus.js';

/**
 * Branch metadata — typed key/values shared by every coder on a branch,
 * stored once on the branch **anchor** row (`nodes.branch_meta`). See
 * "Branch metadata" in docs/graph-model.md. This module owns the read /
 * validate / write helpers the router, the snapshot builder, and `nodes.list`
 * share, so the anchor collapse (`branchAnchorId ?? id`) happens in one place.
 */

/** Merge-patch input: `null` deletes a key. */
export type MetaPatch = Record<string, MetaValue | null>;

export class MetaValidationError extends Error {}

export function anchorIdOf(node: { id: string; branchAnchorId: string | null }): string {
  return node.branchAnchorId ?? node.id;
}

export function readBranchMeta(db: Db, anchorId: string): BranchMeta | null {
  const row = db
    .select({ branchMeta: schema.nodes.branchMeta })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, anchorId))
    .get();
  return row?.branchMeta ?? null;
}

/**
 * Resolve branch metadata for a set of node rows in one query — the
 * `nodes.list` / snapshot projection. Only coder nodes carry a branch;
 * everything else maps to null. Rows that are themselves anchors are read
 * from the set, so the extra query covers only anchors outside it.
 */
export function branchMetaForRows<
  R extends { id: string; kind: string; branchAnchorId: string | null; branchMeta?: BranchMeta | null },
>(db: Db, rows: R[]): Map<string, BranchMeta | null> {
  const out = new Map<string, BranchMeta | null>();
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const missingAnchors = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'coder') continue;
    const anchorId = anchorIdOf(r);
    const anchor = byId.get(anchorId);
    if (anchor && 'branchMeta' in anchor) continue;
    missingAnchors.add(anchorId);
  }
  const fetched = new Map<string, BranchMeta | null>();
  if (missingAnchors.size > 0) {
    const anchors = db
      .select({ id: schema.nodes.id, branchMeta: schema.nodes.branchMeta })
      .from(schema.nodes)
      .where(inArray(schema.nodes.id, [...missingAnchors]))
      .all();
    for (const a of anchors) fetched.set(a.id, a.branchMeta ?? null);
  }
  for (const r of rows) {
    if (r.kind !== 'coder') {
      out.set(r.id, null);
      continue;
    }
    const anchorId = anchorIdOf(r);
    const anchor = byId.get(anchorId);
    const meta =
      anchor && 'branchMeta' in anchor
        ? anchor.branchMeta ?? null
        : fetched.get(anchorId) ?? null;
    out.set(r.id, meta && Object.keys(meta).length > 0 ? meta : null);
  }
  return out;
}

/** Number of coder nodes sharing the anchor — "shared by N iterations" copy. */
export function branchSize(db: Db, anchorId: string): number {
  const linked = db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(eq(schema.nodes.branchAnchorId, anchorId))
    .all();
  return linked.length + 1;
}

function describeFields(fields: MetaField[]): string {
  return fields.map((f) => `${f.key} (${f.type})`).join(', ');
}

/**
 * Validate a patch against the declared fields and coerce string inputs
 * (CLI / query-string clients send everything as text). With no declared
 * fields the schema is free-form: any key, any scalar. Throws
 * {@link MetaValidationError} naming the offending key.
 */
export function validateMetaPatch(fields: MetaField[], patch: MetaPatch): MetaPatch {
  const out: MetaPatch = {};
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  for (const [key, raw] of Object.entries(patch)) {
    if (!/^[A-Za-z0-9_.\-:]+$/.test(key)) {
      throw new MetaValidationError(
        `meta key "${key}" — use letters, digits, '.', '_', '-' or ':'`
      );
    }
    if (raw === null) {
      out[key] = null;
      continue;
    }
    const field = byKey.get(key);
    if (fields.length > 0 && !field) {
      throw new MetaValidationError(
        `meta key "${key}" is not declared — the project's \`meta\` fields are: ${describeFields(fields)}`
      );
    }
    const type = field?.type ?? typeofScalar(raw);
    out[key] = coerce(key, type, raw);
  }
  return out;
}

function typeofScalar(v: MetaValue): MetaField['type'] {
  return typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string';
}

function coerce(key: string, type: MetaField['type'], raw: MetaValue): MetaValue {
  switch (type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
      throw new MetaValidationError(`meta "${key}" expects a boolean, got "${raw}"`);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        throw new MetaValidationError(`meta "${key}" expects a number, got "${raw}"`);
      }
      return n;
    }
    case 'url': {
      const s = String(raw).trim();
      try {
        const u = new URL(s);
        if (!u.protocol || !u.host) throw new Error();
      } catch {
        throw new MetaValidationError(`meta "${key}" expects an absolute URL, got "${raw}"`);
      }
      return s;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw new MetaValidationError(`meta "${key}" expects a string, got ${typeof raw}`);
      }
      const s = raw.trim();
      if (s.length > 2000) {
        throw new MetaValidationError(`meta "${key}" is too long (max 2000 chars)`);
      }
      return s;
    }
  }
}

/** Apply a validated patch; every touched key is re-stamped. Null when nothing remains. */
export function applyMetaPatch(
  current: BranchMeta | null,
  patch: MetaPatch,
  stamp: { at: number; nodeId: string }
): BranchMeta | null {
  const next: BranchMeta = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = { value, at: stamp.at, nodeId: stamp.nodeId };
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** Strip `private` fields for publishing. Unknown keys (free-form) are kept. */
export function publicMeta(meta: BranchMeta | null, fields: MetaField[]): BranchMeta | null {
  if (!meta) return null;
  const privateKeys = new Set(fields.filter((f) => f.private).map((f) => f.key));
  if (privateKeys.size === 0) return meta;
  const out: BranchMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!privateKeys.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function publicMetaFields(fields: MetaField[]): MetaField[] {
  return fields.filter((f) => !f.private);
}

/**
 * Nudge open canvases after an out-of-band node write (note / meta). Events
 * are keyed by run, so pick the node's current run, else the anchor's, else
 * the newest run anywhere on the branch; a branch that never ran has no
 * subscribers to wake, so that case is a silent no-op.
 */
export function emitNodeUpdated(
  deps: { db: Db; eventBus: EventBus },
  node: { id: string; canvasId: string; currentRunId: string | null; branchAnchorId: string | null },
  field: 'note' | 'meta'
): void {
  let runId = node.currentRunId;
  if (!runId) {
    const anchorId = anchorIdOf(node);
    const branchIds = [
      anchorId,
      ...deps.db
        .select({ id: schema.nodes.id })
        .from(schema.nodes)
        .where(eq(schema.nodes.branchAnchorId, anchorId))
        .all()
        .map((r) => r.id),
    ];
    const latest = deps.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(inArray(schema.runs.nodeId, branchIds))
      .orderBy(desc(schema.runs.createdAt))
      .limit(1)
      .get();
    runId = latest?.id ?? null;
  }
  if (!runId) return;
  deps.eventBus.publish(runId, node.canvasId, { kind: 'node_updated', nodeId: node.id, field });
}
