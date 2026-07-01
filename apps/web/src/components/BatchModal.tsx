import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';
import { useUiStore } from '../store';
import {
  ReferenceDraftField,
  toReferenceInput,
  type DraftReference,
} from './ReferenceAttacher';

interface CanvasSummary {
  id: string;
  slug: string;
  name: string | null;
}

interface BatchModalProps {
  canvas: CanvasSummary;
  onClose: () => void;
}

/**
 * Batch run — one shared instruction fanned out across a picked set of
 * coders × skeletons. The permutation grid is shown live and individual
 * combinations can be removed before running. Each surviving combination
 * becomes one `config → coder` branch under a single instruction root, so
 * several models/skeletons can be compared side by side on the same prompt.
 */
export function BatchModal({ canvas, onClose }: BatchModalProps) {
  const [instruction, setInstruction] = useState('');
  const [selectedCoders, setSelectedCoders] = useState<Set<string>>(new Set());
  const [selectedSkeletons, setSelectedSkeletons] = useState<Set<string>>(
    new Set()
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [references, setReferences] = useState<DraftReference[]>([]);
  const setSelectedNodeId = useUiStore((s) => s.setSelectedNodeId);
  const utils = trpc.useUtils();
  const skeletons = trpc.skeletons.list.useQuery();
  const coders = trpc.coders.list.useQuery();

  const coderOptions = coders.data ?? [];
  const skeletonOptions = skeletons.data ?? [];
  const hasSkeletons = skeletonOptions.length > 0;

  // Seed the selection once, when the lists first arrive: every coder (compare
  // them all by default) crossed with just the default skeleton. The artist
  // then adjusts axes and prunes individual combinations.
  const initedCoders = useRef(false);
  const initedSkeletons = useRef(false);
  useEffect(() => {
    if (!initedCoders.current && coderOptions.length) {
      initedCoders.current = true;
      setSelectedCoders(new Set(coderOptions.map((c) => c.name)));
    }
  }, [coderOptions]);
  useEffect(() => {
    if (!initedSkeletons.current && skeletonOptions.length) {
      initedSkeletons.current = true;
      const def =
        skeletonOptions.find((s) => s.name === 'default')?.name ??
        skeletonOptions[0]!.name;
      setSelectedSkeletons(new Set([def]));
    }
  }, [skeletonOptions]);

  const createBatch = trpc.nodes.createBatch.useMutation({
    onSuccess: async (data) => {
      await utils.nodes.list.invalidate();
      // Select the instruction root so the whole comparison set is in view.
      setSelectedNodeId(data.node.id);
      onClose();
    },
  });

  // Effective combinations: the product of the picked axes, minus any the
  // artist X'd out. Iterated in registry order for a stable list. Touching an
  // axis clears the manual removals (a fresh grid).
  const combos = useMemo(() => {
    const skels: (string | null)[] = hasSkeletons
      ? skeletonOptions
          .filter((s) => selectedSkeletons.has(s.name))
          .map((s) => s.name)
      : [null];
    const out: { coderName: string; skeletonName: string | null; key: string }[] =
      [];
    for (const c of coderOptions) {
      if (!selectedCoders.has(c.name)) continue;
      for (const sk of skels) {
        const key = `${c.name}||${sk ?? ''}`;
        if (removed.has(key)) continue;
        out.push({ coderName: c.name, skeletonName: sk, key });
      }
    }
    return out;
  }, [
    coderOptions,
    skeletonOptions,
    selectedCoders,
    selectedSkeletons,
    removed,
    hasSkeletons,
  ]);

  const toggleCoder = (name: string) => {
    setRemoved(new Set());
    setSelectedCoders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleSkeleton = (name: string) => {
    setRemoved(new Set());
    setSelectedSkeletons((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const removeCombo = (key: string) =>
    setRemoved((prev) => new Set(prev).add(key));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || combos.length === 0) return;
    createBatch.mutate({
      instruction: trimmed,
      canvasId: canvas.id,
      combinations: combos.map((c) => ({
        coderName: c.coderName,
        ...(c.skeletonName ? { skeletonName: c.skeletonName } : {}),
      })),
      ...(references.length
        ? { references: references.map(toReferenceInput) }
        : {}),
    });
  };

  const canvasLabel = canvas.name?.trim() ? canvas.name : canvas.slug;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="batch-form"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Batch run</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            Compare
          </span>
        </div>
        <p className="mb-5 font-serif text-sm leading-snug text-ink-soft">
          One instruction, several coders × skeletons — run side by side as
          branches under a shared root on{' '}
          <span className="font-mono uppercase tracking-caps text-ink">
            {canvasLabel}
          </span>
          .
        </p>

        <label
          htmlFor="batch-input"
          className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
        >
          Instruction
        </label>
        <textarea
          id="batch-input"
          autoFocus
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="A neon torus rotating slowly with a chromatic aberration glitch"
          data-testid="batch-input"
          className="w-full resize-none border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />

        <div className="mt-4">
          <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
            Coders
          </span>
          <div data-testid="batch-coders" className="flex flex-col gap-1.5">
            {coderOptions.map((c) => (
              <label
                key={c.name}
                className="flex items-center gap-2 font-mono text-sm text-ink-soft"
              >
                <input
                  type="checkbox"
                  checked={selectedCoders.has(c.name)}
                  onChange={() => toggleCoder(c.name)}
                  data-testid={`batch-coder-${c.name}`}
                  className="accent-sanguine"
                />
                {c.name}{' '}
                <span className="text-ink-faint">· {c.kind}</span>
              </label>
            ))}
          </div>
        </div>

        {hasSkeletons ? (
          <div className="mt-4">
            <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
              Skeletons
            </span>
            <div data-testid="batch-skeletons" className="flex flex-col gap-1.5">
              {skeletonOptions.map((s) => (
                <label
                  key={`${s.source}:${s.name}`}
                  className="flex items-center gap-2 font-mono text-sm text-ink-soft"
                >
                  <input
                    type="checkbox"
                    checked={selectedSkeletons.has(s.name)}
                    onChange={() => toggleSkeleton(s.name)}
                    data-testid={`batch-skeleton-${s.name}`}
                    className="accent-sanguine"
                  />
                  {s.name} <span className="text-ink-faint">· {s.source}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4">
          <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
            Runs{' '}
            <span className="text-ink-faint">
              · {combos.length} {combos.length === 1 ? 'combination' : 'combinations'}
            </span>
          </span>
          {combos.length === 0 ? (
            <p className="font-mono text-xs uppercase tracking-caps text-ink-faint">
              Pick at least one coder{hasSkeletons ? ' and skeleton' : ''}.
            </p>
          ) : (
            <ul data-testid="batch-combos" className="flex flex-col gap-1">
              {combos.map((c) => (
                <li
                  key={c.key}
                  data-testid="batch-combo"
                  className="flex items-center justify-between gap-2 border border-hairline bg-paper-deep px-3 py-1.5"
                >
                  <span className="truncate font-mono text-sm text-ink">
                    {c.coderName}{' '}
                    <span className="text-ink-muted">
                      · {c.skeletonName ?? 'default'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCombo(c.key)}
                    data-testid="batch-combo-remove"
                    aria-label={`Remove ${c.coderName} · ${c.skeletonName ?? 'default'}`}
                    className="shrink-0 font-mono text-xs uppercase tracking-caps text-ink-muted transition-colors hover:text-sanguine"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4">
          <span className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted">
            References <span className="text-ink-faint">· optional, shared</span>
          </span>
          <ReferenceDraftField value={references} onChange={setReferences} />
        </div>

        {createBatch.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {createBatch.error.message}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="batch-cancel"
            className="px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              createBatch.isPending || !instruction.trim() || combos.length === 0
            }
            data-testid="batch-submit"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
          >
            {createBatch.isPending
              ? 'Running…'
              : `Run ${combos.length || ''}`.trim()}
          </button>
        </div>
      </form>
    </div>
  );
}
