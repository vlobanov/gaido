import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CritiqueAuthor } from '@vadimlobanov/gaido-core';
import { trpc } from '../lib/trpc';

/**
 * Human-readable authorship caption for a stored critique, e.g. "by you" or
 * "by claude-sonnet-4-6". Returns null when the critique predates authorship
 * tracking so callers can render nothing.
 */
export function critiqueAuthorLabel(author?: CritiqueAuthor): string | null {
  if (!author) return null;
  if (author.kind === 'human') return 'by you';
  return `by ${author.model ?? author.critic ?? 'critic'}`;
}

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * Write (or overwrite) a critique by hand on a critique node. Used when a model
 * critic is configured but the artist wants to provide the assessment
 * themselves — saved via the same `setHumanCritique` path as human-critic mode,
 * so the stored critique is tagged with a human author.
 */
export function ManualCritiqueModal({
  nodeId,
  initialOverall = '',
  initialRating = null,
  onClose,
  onSaved,
}: {
  nodeId: string;
  initialOverall?: string;
  initialRating?: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(initialOverall);
  const [rating, setRating] = useState<number | null>(initialRating);
  const save = trpc.runs.setHumanCritique.useMutation();

  const empty = !draft.trim();

  const handleSave = async () => {
    if (empty) return;
    try {
      await save.mutateAsync({
        nodeId,
        notes: draft,
        ...(rating ? { rating } : {}),
      });
    } catch {
      return;
    }
    utils.nodes.get.invalidate({ nodeId });
    utils.nodes.list.invalidate();
    onSaved();
  };

  // Portal to body: the card mounts this from inside xyflow's transformed
  // viewport, where a position:fixed overlay would otherwise be offset and
  // scaled by the pane transform.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="manual-critique-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Write critique</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            Recorded as yours
          </span>
        </div>
        <textarea
          autoFocus
          rows={8}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What worked, what didn't, what to try next…"
          data-testid="manual-critique-textarea"
          className="w-full resize-y border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            Rating
            <span className="ml-1 text-ink-faint">· optional</span>
          </span>
          <div className="flex items-center gap-1.5">
            {RATINGS.map((n) => {
              const on = rating === n;
              return (
                <button
                  key={n}
                  type="button"
                  // Click the active rating again to clear it.
                  onClick={() => setRating(on ? null : n)}
                  data-testid={`manual-critique-rating-${n}`}
                  aria-pressed={on}
                  className={`h-7 w-7 border font-mono text-xs transition-colors ${
                    on
                      ? 'border-sanguine bg-sanguine-tint text-sanguine'
                      : 'border-hairline-deep bg-paper text-ink-soft hover:bg-paper-deep'
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
        {save.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {save.error.message}
          </p>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={empty || save.isPending}
            onClick={handleSave}
            data-testid="manual-critique-save"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40 disabled:hover:bg-paper"
          >
            {save.isPending ? 'Saving…' : 'Save critique'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
