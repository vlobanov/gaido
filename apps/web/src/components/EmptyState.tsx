import { useState } from 'react';
import { trpc } from '../lib/trpc';

export function EmptyState() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div className="flex h-full w-full items-center justify-center bg-paper">
      <div className="flex max-w-md flex-col items-start gap-6 px-8">
        <div className="font-mono text-xs uppercase tracking-caps text-ink-muted">
          Workspace · empty
        </div>
        <h2 className="font-serif text-3xl leading-tight text-ink">
          A blank page is the start of every notebook.
        </h2>
        <p className="font-serif text-base leading-relaxed text-ink-soft">
          Seed a root node with an instruction. The coder writes the
          visual, the renderer captures it, the critic notes what to fork
          next. Branch from there as long as the work is interesting.
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          data-testid="empty-create-root"
          className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint"
        >
          Seed root node
        </button>
      </div>

      {modalOpen ? <CreateRootModal onClose={() => setModalOpen(false)} /> : null}
    </div>
  );
}

interface CreateRootModalProps {
  onClose: () => void;
}

function CreateRootModal({ onClose }: CreateRootModalProps) {
  const [instruction, setInstruction] = useState('');
  const utils = trpc.useUtils();
  const createRoot = trpc.nodes.createRoot.useMutation({
    onSuccess: async () => {
      await utils.nodes.list.invalidate();
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed) return;
    createRoot.mutate({ instruction: trimmed });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="create-root-form"
        className="w-full max-w-lg border border-hairline-deep bg-paper p-6"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Seed root node</h3>
          <span className="font-mono text-xs uppercase tracking-caps text-ink-muted">
            New entry
          </span>
        </div>
        <label
          htmlFor="create-root-input"
          className="mb-2 block font-mono text-xs uppercase tracking-caps text-ink-muted"
        >
          Instruction
        </label>
        <textarea
          id="create-root-input"
          autoFocus
          rows={4}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="A neon torus rotating slowly with a chromatic aberration glitch"
          data-testid="create-root-input"
          className="w-full resize-none border border-hairline bg-paper-deep px-3 py-2 font-serif text-base leading-snug text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
        />
        {createRoot.error ? (
          <p className="mt-3 font-mono text-xs uppercase tracking-caps text-sanguine">
            {createRoot.error.message}
          </p>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="create-root-cancel"
            className="px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createRoot.isPending || !instruction.trim()}
            data-testid="create-root-submit"
            className="border border-sanguine bg-paper px-5 py-2 font-mono text-xs uppercase tracking-caps text-sanguine transition-colors hover:bg-sanguine-tint disabled:opacity-40"
          >
            {createRoot.isPending ? 'Seeding...' : 'Seed'}
          </button>
        </div>
      </form>
    </div>
  );
}
