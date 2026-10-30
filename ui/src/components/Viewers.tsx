// Viewers for a run's media that you can point into for feedback: a video or
// audio file at a moment (or a stretch), an image at an area. Also opening a
// file in its own app (Word, Excel, Keynote…).
import { useEffect, useRef, useState, type RefObject } from 'react';
import { desktop, post, type OpenedFile } from '../api';
import { timecode, useFeedback, type Anchor } from './Feedback';
import { IconChat } from './icons';
import { useToast } from './ui';

export const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
export const AUDIO = /\.(mp3|wav|ogg|m4a)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
export const PDF = /\.pdf$/i;
/** Opened in their own app: office documents and the like. */
export const OFFICE = /\.(docx?|dotx?|xlsx?|xlsm|pptx?|potx?|odt|ods|odp|rtf|key|pages|numbers|vsdx?|psd|ai|sketch|fig)$/i;

/** What covibe opens in its own app (the server allows the same): documents, media and images, never programs. */
export const OPENABLE = /\.(docx?|dotx?|xlsx?|xlsm|csv|pptx?|potx?|odt|ods|odp|rtf|key|pages|numbers|vsdx?|pdf|png|jpe?g|gif|webp|avif|bmp|tiff?|heic|psd|ai|sketch|fig|mp4|mov|m4v|webm|mp3|wav|m4a|ogg|aiff?)$/i;

/** The app a file opens in, for the button. */
export function appName(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (/^(docx?|dotx?|rtf)$/.test(ext)) return 'Word';
  if (/^(xlsx?|xlsm)$/.test(ext)) return 'Excel';
  if (/^(pptx?|potx?)$/.test(ext)) return 'PowerPoint';
  if (ext === 'key') return 'Keynote';
  if (ext === 'pages') return 'Pages';
  if (ext === 'numbers') return 'Numbers';
  return 'its app';
}

/** Open a file of the run in its own app: through the Mac app, else the server opens it. */
export function useOpenInApp(projectId: string, runId: string) {
  const toast = useToast();
  return async (path: string) => {
    try {
      if (desktop) {
        const f = await post<OpenedFile>(`/api/runs/${projectId}/${runId}/open`, { path });
        await desktop.openPath(f.path);
        if (f.copy) toast('Opened a copy from the result branch: changes you make there do not change the run.');
      } else {
        const f = await post<OpenedFile>(`/api/runs/${projectId}/${runId}/open`, { path, launch: true });
        toast(f.copy ? 'Opened a copy from the result branch: changes you make there do not change the run.' : `Opened ${path}.`);
      }
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
}

/** A video or audio file, with buttons to comment at the current moment or on a stretch. */
export function MediaView({ src, path, kind, seek }: { src: string; path: string; kind: 'video' | 'audio'; seek?: { at: number; n: number } }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const { compose } = useFeedback();
  const [now, setNow] = useState(0);
  const [start, setStart] = useState<number | undefined>();
  useEffect(() => {
    if (seek && media.current) {
      media.current.currentTime = seek.at;
      media.current.pause();
    }
  }, [seek?.n]);
  useEffect(() => setStart(undefined), [path]);
  const at = () => Math.round((media.current?.currentTime ?? 0) * 10) / 10;
  const comment = () => {
    media.current?.pause();
    const t = at();
    const anchor: Anchor = { target: 'file', path, kind, ...(start !== undefined && t > start ? { at: start, until: t } : { at: t }) };
    setStart(undefined);
    compose(anchor);
  };
  return (
    <div className="media-view">
      {kind === 'video' ? (
        <video ref={media} className="media" src={src} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
      ) : (
        <audio ref={media} className="media audio" src={src} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
      )}
      <div className="media-actions row wrap">
        <button className="btn primary" onClick={comment}>
          <IconChat /> {start !== undefined && now > start ? `Comment on ${timecode(start)}–${timecode(now)}` : `Comment at ${timecode(now)}`}
        </button>
        {start === undefined ? (
          <button className="btn" onClick={() => setStart(at())} title="Mark where a stretch starts, play or seek to its end, then comment">
            Mark start of a stretch
          </button>
        ) : (
          <button className="btn ghost" onClick={() => setStart(undefined)}>
            Clear start ({timecode(start)})
          </button>
        )}
        <span className="tiny faint">Pause where something should change and comment, or mark a stretch.</span>
      </div>
    </div>
  );
}

/** An image: drag over it to comment on an area, or comment on the whole. */
export function ImageView({ src, path }: { src: string; path: string }) {
  const { compose } = useFeedback();
  const img = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const box = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) };
  return (
    <div className="media-view">
      <div className="image-stage">
        <div className="image-wrap">
          <img
            ref={img}
            src={src}
            alt={path}
            draggable={false}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = rel(e);
              setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const p = rel(e);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }}
            onPointerUp={() => {
              if (box && box.width > 0.01 && box.height > 0.01) compose({ target: 'file', path, kind: 'image', region: box });
              setDrag(null);
            }}
          />
          {box && <div className="image-region" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />}
        </div>
      </div>
      <div className="media-actions row wrap">
        <button className="btn" onClick={() => compose({ target: 'file', path, kind: 'image' })}>
          <IconChat /> Comment on the image
        </button>
        <span className="tiny faint">Or drag over the image to comment on an area.</span>
      </div>
    </div>
  );
}

/** The text selected inside `root`, kept while you reach for a button. */
export function useSelectedText(root: RefObject<HTMLElement | null>): string {
  const [text, setText] = useState('');
  useEffect(() => {
    const on = () => {
      const sel = document.getSelection();
      const el = root.current;
      setText(!sel || !el || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode) ? '' : sel.toString().trim().slice(0, 2000));
    };
    document.addEventListener('selectionchange', on);
    return () => document.removeEventListener('selectionchange', on);
  }, [root]);
  return text;
}
