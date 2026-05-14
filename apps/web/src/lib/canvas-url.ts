const IDENTIFIER_RE = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)-)?(c_[0-9a-z]{16})$/;

export interface ParsedIdentifier {
  slug: string | null;
  id: string | null;
}

export function parseIdentifier(s: string): ParsedIdentifier {
  if (!s) return { slug: null, id: null };
  const match = IDENTIFIER_RE.exec(s);
  if (match) {
    const id = match[2] ?? null;
    return { slug: match[1] ?? null, id };
  }
  return { slug: s, id: null };
}

export function canonicalIdentifier(canvas: { slug: string; id: string }): string {
  return `${canvas.slug}-${canvas.id}`;
}

export function canvasHref(canvas: { slug: string; id: string }): string {
  return `/c/${canonicalIdentifier(canvas)}`;
}
