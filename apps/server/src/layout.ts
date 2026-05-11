import type { Critique } from '@gaido/core';

// Card geometry constants. Mirrors the CSS in apps/web (CoderCard, CritiqueCard).
// Brittle by design — if those components change padding, line height, or the
// square thumbnail ratio, bump these or layouts will overlap.

const GAP = 40;

// Coder card height is constant: w-64 (256) square frame + 2-line clamped
// instruction (~69px) + footer row (~33px) + borders.
export const CODER_CARD_HEIGHT = 360;

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
