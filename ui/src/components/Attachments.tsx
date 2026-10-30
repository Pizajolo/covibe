// Files you give the team with a goal, a question or a chat message: pick
// them, drop them on the box, or paste an image. They upload right away
// (POST /api/uploads) and go with the message as a list of upload ids.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { authedUrl, desktop, postRaw, type SentFile } from '../api';
import { IconClip, IconFile, IconSpinner, IconX } from './icons';


interface Pending {
  key: number;
  name: string;
  size: number;
  /** A local preview for images. */
  preview?: string;
  id?: string;
  error?: string;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** The files added to one message box. */
export function useAttachments() {
  const [items, setItems] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const next = useRef(1);
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const add = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = next.current++;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      // A pasted screenshot has no useful name.
      const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      setItems((list) => [...list, { key, name, size: file.size, preview }]);
      postRaw<{ id: string }>(`/api/uploads?name=${encodeURIComponent(name)}`, file).then(
        ({ id }) => setItems((list) => list.map((i) => (i.key === key ? { ...i, id } : i))),
        (err: Error) => setItems((list) => list.map((i) => (i.key === key ? { ...i, error: err.message } : i))),
      );
    }
  }, []);
  const remove = useCallback((key: number) => setItems((list) => list.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  /** Paste an image (a screenshot) into the box. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData.files.length) return;
      e.preventDefault();
      add(e.clipboardData.files);
    },
    [add],
  );
  /** Drop files on the box. */
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      setDragging(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      add(e.dataTransfer.files);
    },
  };

  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    drop,
    dragging,
    ids: items.filter((i) => i.id).map((i) => i.id!),
    uploading: items.some((i) => !i.id && !i.error),
    failed: items.some((i) => i.error),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The paperclip: pick files from this computer. */
export function AttachButton({ files, title = 'Attach images or documents (or drop them here, or paste an image)' }: { files: Attachments; title?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost icon-btn" title={title} aria-label="Attach files" onClick={() => input.current?.click()}>
        <IconClip />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) files.add(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** The files added so far, uploading or ready, each with a way to take it out. */
export function AttachmentChips({ files }: { files: Attachments }) {
  if (!files.items.length) return null;
  return (
    <div className="attach-chips">
      {files.items.map((i) => (
        <span key={i.key} className={`attach-chip ${i.error ? 'bad' : ''}`} title={i.error ?? `${i.name} (${kb(i.size)})`}>
          {i.preview ? <img src={i.preview} alt="" /> : <IconFile width={13} height={13} />}
          <span className="ellipsis">{i.name}</span>
          {!i.id && !i.error && <IconSpinner width={12} height={12} />}
          {i.error && <span className="tiny">failed</span>}
          <button type="button" className="attach-x" aria-label={`Remove ${i.name}`} onClick={() => files.remove(i.key)}>
            <IconX width={10} height={10} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Where a file given to a run is, inside the run's folder ("chat-…/logo.png"). */
function relOf(path: string, runId: string): string {
  const marker = `/${runId}/`;
  const at = path.lastIndexOf(marker);
  return at >= 0 ? path.slice(at + marker.length) : path.split('/').pop() ?? path;
}

/** Files that went with a goal or a message: images as thumbnails, the rest by name. Click to open. */
export function SentFiles({ projectId, runId, files, compact }: { projectId: string; runId: string; files: SentFile[]; compact?: boolean }) {
  if (!files.length) return null;
  const url = (f: SentFile) => authedUrl(`/api/runs/${projectId}/${runId}/attachment?path=${encodeURIComponent(relOf(f.path, runId))}`);
  const open = (f: SentFile) => (desktop ? void desktop.openPath(f.path) : window.open(url(f), '_blank', 'noopener'));
  return (
    <div className={`attach-chips sent ${compact ? 'compact' : ''}`}>
      {files.map((f) =>
        f.kind === 'image' ? (
          <button key={f.path} type="button" className="attach-thumb" title={`${f.name} (${kb(f.size)})`} onClick={() => open(f)}>
            <img src={url(f)} alt={f.name} />
          </button>
        ) : (
          <button key={f.path} type="button" className="attach-chip" title={`${f.path} (${kb(f.size)})`} onClick={() => open(f)}>
            <IconFile width={13} height={13} />
            <span className="ellipsis">{f.name}</span>
            <span className="tiny faint">{kb(f.size)}</span>
          </button>
        ),
      )}
    </div>
  );
}
