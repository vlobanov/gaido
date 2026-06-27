import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';
import { artifactUrl, referenceUrl, READ_ONLY } from '../lib/static';

/**
 * Attach references — pasted/dropped images and other runs by id — to a coder
 * node. Two surfaces share the controls here:
 *
 *  - <ReferenceDraftField> collects references locally in a create/fork modal;
 *    the parent submits them inline with the node-creating mutation.
 *  - <BoundReferences> manages references on an already-created node via the
 *    references.* mutations.
 */

export interface DraftReference {
  kind: 'image' | 'run';
  // image
  filename?: string;
  mime?: string;
  dataBase64?: string;
  // run
  runId?: string;
  // display
  label: string;
  thumbnailArtifactId?: string | null;
}

/** Map a draft reference to the wire shape accepted by the create mutations. */
export function toReferenceInput(d: DraftReference) {
  return d.kind === 'image'
    ? { kind: 'image' as const, filename: d.filename!, mime: d.mime!, dataBase64: d.dataBase64! }
    : { kind: 'run' as const, runId: d.runId! };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- draft (modal) ----------

export function ReferenceDraftField({
  value,
  onChange,
}: {
  value: DraftReference[];
  onChange: (next: DraftReference[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const addImages = async (files: File[]) => {
    setError(null);
    const next: DraftReference[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const dataBase64 = await fileToBase64(file);
        next.push({
          kind: 'image',
          filename: file.name || 'pasted.png',
          mime: file.type,
          dataBase64,
          label: file.name || 'pasted image',
        });
      } catch {
        setError('Could not read that image.');
      }
    }
    if (next.length) onChange([...valueRef.current, ...next]);
  };

  // Paste an image anywhere in the modal. Text pastes (into the instruction
  // textarea) are ignored — we only act when the clipboard carries images.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f != null);
      if (files.length) {
        e.preventDefault();
        void addImages(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-testid="reference-attacher" className="flex flex-col gap-3">
      <ChipRow
        refs={value}
        onRemove={(i) => onChange(value.filter((_, idx) => idx !== i))}
      />
      <ImageDropZone onFiles={addImages} />
      <RunIdInput
        onResolved={(r) =>
          onChange([
            ...value,
            {
              kind: 'run',
              runId: r.runId,
              label: r.label,
              thumbnailArtifactId: r.thumbnailArtifactId,
            },
          ])
        }
        onError={setError}
      />
      {error ? (
        <p data-testid="reference-error" className="font-mono text-xs text-sanguine">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------- bound (sidebar) ----------

export function BoundReferences({ nodeId }: { nodeId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.references.list.useQuery({ nodeId });
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => utils.references.list.invalidate({ nodeId });
  const attachImage = trpc.references.attachImage.useMutation({ onSuccess: invalidate });
  const attachRun = trpc.references.attachRun.useMutation({ onSuccess: invalidate });
  const remove = trpc.references.remove.useMutation({ onSuccess: invalidate });

  const addImages = async (files: File[]) => {
    setError(null);
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const dataBase64 = await fileToBase64(file);
        await attachImage.mutateAsync({
          nodeId,
          filename: file.name || 'pasted.png',
          mime: file.type,
          dataBase64,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not attach image.');
      }
    }
  };

  const rows = list.data ?? [];

  return (
    <section data-testid="references-section" className="flex flex-col gap-3">
      <h4 className="font-mono text-xs uppercase tracking-caps text-ink-muted">
        References
      </h4>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid="reference-chip"
              data-ref-kind={r.kind}
              className="flex items-center gap-3 border border-hairline bg-paper-deep px-2 py-1.5"
            >
              {r.kind === 'image' ? (
                <img
                  src={referenceUrl(r.id)}
                  alt=""
                  className="h-8 w-8 shrink-0 border border-hairline object-cover"
                />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-hairline font-mono text-[10px] uppercase text-ink-muted">
                  run
                </span>
              )}
              <span className="flex-1 truncate font-serif text-sm text-ink" title={r.label}>
                {r.label}
              </span>
              {!READ_ONLY && (
                <button
                  type="button"
                  onClick={() => remove.mutate({ referenceId: r.id })}
                  data-testid="reference-chip-remove"
                  aria-label="Remove reference"
                  className="shrink-0 px-1 font-mono text-xs text-ink-muted hover:text-sanguine"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!READ_ONLY && (
        <>
          <ImageDropZone onFiles={addImages} busy={attachImage.isPending} />
          <RunIdInput
            onResolved={(r) => attachRun.mutate({ nodeId, runId: r.runId })}
            onError={setError}
            busy={attachRun.isPending}
          />
          {error ? (
            <p data-testid="reference-error" className="font-mono text-xs text-sanguine">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------- shared controls ----------

function ChipRow({
  refs,
  onRemove,
}: {
  refs: DraftReference[];
  onRemove: (index: number) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {refs.map((r, i) => (
        <li
          key={i}
          data-testid="reference-chip"
          data-ref-kind={r.kind}
          className="flex items-center gap-2 border border-hairline bg-paper-deep py-1 pl-1 pr-2"
        >
          {r.kind === 'image' && r.dataBase64 ? (
            <img
              src={`data:${r.mime};base64,${r.dataBase64}`}
              alt=""
              className="h-7 w-7 border border-hairline object-cover"
            />
          ) : r.kind === 'run' && r.thumbnailArtifactId ? (
            <img
              src={artifactUrl(r.thumbnailArtifactId)}
              alt=""
              className="h-7 w-7 border border-hairline object-cover"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center border border-hairline font-mono text-[10px] uppercase text-ink-muted">
              run
            </span>
          )}
          <span className="max-w-[10rem] truncate font-serif text-sm text-ink" title={r.label}>
            {r.label}
          </span>
          <button
            type="button"
            onClick={() => onRemove(i)}
            data-testid="reference-chip-remove"
            aria-label="Remove reference"
            className="font-mono text-xs text-ink-muted hover:text-sanguine"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function ImageDropZone({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => void | Promise<void>;
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="reference-dropzone"
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void onFiles(files);
      }}
      className={`cursor-pointer border border-dashed px-3 py-3 text-center font-mono text-[10px] uppercase tracking-caps transition-colors ${
        over
          ? 'border-sanguine bg-sanguine-tint text-sanguine'
          : 'border-hairline-deep text-ink-muted hover:bg-paper-deep'
      }`}
    >
      {busy ? 'Uploading…' : 'Paste, drop, or click to add reference images'}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="reference-image-input"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void onFiles(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function RunIdInput({
  onResolved,
  onError,
  busy,
}: {
  onResolved: (r: {
    runId: string;
    label: string;
    thumbnailArtifactId: string | null;
  }) => void;
  onError: (msg: string | null) => void;
  busy?: boolean;
}) {
  const utils = trpc.useUtils();
  const [runId, setRunId] = useState('');
  const [resolving, setResolving] = useState(false);

  const add = async () => {
    const id = runId.trim();
    if (!id) return;
    onError(null);
    setResolving(true);
    try {
      const r = await utils.references.resolveRun.fetch({ runId: id });
      if (!r) {
        onError('No run with that id.');
        return;
      }
      if (!r.hasCode && !r.hasVideo) {
        onError('That run has no code or video to reference yet.');
        return;
      }
      onResolved({
        runId: r.runId,
        label: r.label,
        thumbnailArtifactId: r.thumbnailArtifactId,
      });
      setRunId('');
    } catch {
      onError('Could not resolve that run.');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <input
        type="text"
        value={runId}
        onChange={(e) => setRunId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
        }}
        placeholder="Reference a run by id (r_…)"
        data-testid="reference-run-input"
        className="flex-1 border border-hairline bg-paper-deep px-3 py-2 font-mono text-xs text-ink placeholder-ink-faint outline-none focus:border-hairline-deep"
      />
      <button
        type="button"
        onClick={() => void add()}
        disabled={!runId.trim() || resolving || busy}
        data-testid="reference-run-add"
        className="border border-hairline-deep bg-paper px-3 py-2 font-mono text-xs uppercase tracking-caps text-ink transition-colors hover:bg-paper-deep disabled:opacity-40"
      >
        {resolving ? '…' : 'Add'}
      </button>
    </div>
  );
}
