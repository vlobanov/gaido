import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { schema, canvasId as newCanvasId } from '@gaido/core';
import type { Canvas } from '@gaido/core/schema';
import type { Db } from './db.js';

export function seedDefaultCanvas(db: Db): Canvas {
  const id = newCanvasId();
  db.run(
    sql`INSERT INTO canvases (id, slug, name) VALUES (${id}, 'default', NULL) ON CONFLICT(slug) DO NOTHING`
  );
  const row = db
    .select()
    .from(schema.canvases)
    .where(eq(schema.canvases.slug, 'default'))
    .get();
  if (!row) throw new Error('seedDefaultCanvas: default canvas missing after insert');
  return row;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'untitled';
}

export function resolveSlugCollision(db: Db, base: string): string {
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const existing = db
      .select({ id: schema.canvases.id })
      .from(schema.canvases)
      .where(eq(schema.canvases.slug, candidate))
      .get();
    if (!existing) return candidate;
  }
  throw new Error(`resolveSlugCollision: exhausted 50 attempts for base "${base}"`);
}

export function nextUntitledName(db: Db): string {
  for (let i = 1; i <= 1000; i++) {
    const candidate = `untitled-${i}`;
    const existing = db
      .select({ id: schema.canvases.id })
      .from(schema.canvases)
      .where(eq(schema.canvases.slug, candidate))
      .get();
    if (!existing) return candidate;
  }
  throw new Error('nextUntitledName: exhausted 1000 attempts');
}
