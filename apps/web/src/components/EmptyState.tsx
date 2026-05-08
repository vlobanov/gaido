import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { trpc } from '../lib/trpc';

export function EmptyState() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 border border-zinc-800">
          <Sparkles className="h-6 w-6 text-zinc-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-medium text-zinc-100">No explorations yet</h2>
          <p className="max-w-sm text-sm text-zinc-400">
            Create a root node to seed your first idea. Branches grow from there as the
            coder, renderer, and critic loop on it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          data-testid="empty-create-root"
          className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white transition-colors"
        >
          Create root node
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="create-root-form"
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-100">Create root node</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Instruction
        </label>
        <textarea
          autoFocus
          rows={4}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="A neon torus rotating slowly with a chromatic aberration glitch..."
          data-testid="create-root-input"
          className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-600"
        />
        {createRoot.error ? (
          <p className="mt-2 text-xs text-red-400">{createRoot.error.message}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="create-root-cancel"
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createRoot.isPending || !instruction.trim()}
            data-testid="create-root-submit"
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {createRoot.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
