// What a member sees of the website it builds or tests. With covibe's browser
// (browser: true) that is its tab, live: you watch it, and after taking
// control you click, scroll and type in it while the member waits. A member
// that drives a browser some other way (Playwright in a shell command) shows
// the screenshots it looked at, newest first, and the page it went to.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authedUrl, desktop, post, type LiveBrowser, type RunDetail } from '../api';
import { clock } from '../format';
import { IconArrowLeft, IconArrowRight, IconBrowser, IconLoop } from './icons';
import { Modal, useToast } from './ui';

export interface View {
  id: number;
  ts: string;
  tool: string;
  file?: string;
}

/** The images a member saw this run, oldest first (the server keeps the newest 40). */
export function viewsOf(detail: RunDetail, agent: string): View[] {
  return detail.events
    .filter((e) => e.type === 'agent.view' && e.agent === agent)
    .map((e) => ({ id: Number(e.data.id), ts: e.ts, tool: String(e.data.tool), file: typeof e.data.file === 'string' ? e.data.file : undefined }))
    .slice(-40);
}

/** The page a member last went to in a browser, from its tool calls this run. */
export function browserUrlOf(detail: RunDetail, agent: string): string | undefined {
  for (let i = detail.events.length - 1; i >= 0; i--) {
    const e = detail.events[i]!;
    const url = e.agent === agent && (e.type === 'agent.tool' || e.type === 'browser.page') ? (e.type === 'browser.page' ? (e.data.url as string) : (e.data.browser as { url?: string } | undefined)?.url) : undefined;
    if (url) return url;
  }
  return undefined;
}

export const viewSrc = (projectId: string, runId: string, id: number) => authedUrl(`/api/runs/${projectId}/${runId}/views/${id}`);

function openPage(url: string) {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/** The window behind the browser button above a member's desk: its live tab when it has one, else the screenshots it saw. */
export function BrowserPreview({ detail, projectId, agent, onClose }: { detail: RunDetail; projectId: string; agent: string; onClose: () => void }) {
  const live = detail.browsers.find((b) => b.agent === agent);
  const [mode, setMode] = useState<'live' | 'shots'>(live ? 'live' : 'shots');
  useEffect(() => setMode(live ? 'live' : 'shots'), [agent, !!live]);
  const views = useMemo(() => viewsOf(detail, agent), [detail, agent]);
  // Closing while holding control gives the browser back at once.
  const holding = useRef(false);
  holding.current = live?.control === 'human';
  const close = useCallback(() => {
    if (holding.current) void post(`/api/runs/${projectId}/${detail.summary.id}/browser/${encodeURIComponent(agent)}/control`, { by: 'member' }).catch(() => undefined);
    onClose();
  }, [projectId, detail.summary.id, agent, onClose]);

  return (
    <Modal
      huge={mode === 'live'}
      wide={mode !== 'live'}
      title={
        <span className="row" style={{ gap: 8 }}>
          <IconBrowser width={16} height={16} />
          {live && mode === 'live' ? `${agent}’s browser` : `What ${agent} sees`}
          {live && mode === 'live' && <span className="live-dot-red" title="Live" />}
        </span>
      }
      onClose={close}
      footer={
        <>
          {live && views.length > 0 && (
            <div className="seg" style={{ marginRight: 'auto' }}>
              <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live</button>
              <button className={mode === 'shots' ? 'on' : ''} onClick={() => setMode('shots')}>Screenshots it read ({views.length})</button>
            </div>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {live && mode === 'live' ? <LiveView detail={detail} projectId={projectId} live={live} /> : <Screenshots detail={detail} projectId={projectId} agent={agent} views={views} />}
    </Modal>
  );
}

/** Key names the browser understands, from KeyboardEvent.key. */
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);

/** A key press as the browser takes it: text to type, a key combination, or nothing (a lone modifier). */
function keyInput(e: React.KeyboardEvent): { type: 'text'; text: string } | { type: 'key'; key: string } | undefined {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(e.key)) return undefined;
  const shortcut = e.ctrlKey || e.metaKey || e.altKey;
  if (e.key.length === 1 && !shortcut) return { type: 'text', text: e.key };
  const name = e.key === ' ' ? 'Space' : e.key;
  if (!NAMED_KEYS.has(name) && name.length !== 1) return undefined;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && 'Shift'].filter(Boolean);
  return { type: 'key', key: [...mods, name.length === 1 ? name.toLowerCase() : name].join('+') };
}

function LiveView({ detail, projectId, live }: { detail: RunDetail; projectId: string; live: LiveBrowser }) {
  const run = detail.summary;
  const agent = live.agent;
  const toast = useToast();
  const base = `/api/runs/${projectId}/${run.id}/browser/${encodeURIComponent(agent)}`;
  const member = run.agents.find((a) => a.name === agent);
  const memberWorking = member?.status === 'working' || detail.answering.includes(agent);
  const yours = live.control === 'human';
  const canDrive = yours || !memberWorking;
  const screen = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [hint, setHint] = useState(false);

  // Input goes out one request at a time, in order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = useCallback(
    (path: string, body: unknown) => {
      queue.current = queue.current.then(() => post(`${base}/${path}`, body)).catch((err: Error) => toast(err.message, true));
      return queue.current;
    },
    [base, toast],
  );

  /** A pointer position in the page's window. */
  const at = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect();
    const scale = live.viewport.width / r.width;
    return { x: Math.round((clientX - r.left) * scale), y: Math.round((clientY - r.top) * scale) };
  };

  const lastMove = useRef(0);
  const buttons = useRef(0);
  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    // Wheel needs a non-passive listener to keep the dialog from scrolling.
    const onWheel = (e: WheelEvent) => {
      if (!canDrive || !img.current) return;
      e.preventDefault();
      void send('input', { type: 'wheel', ...at(e.clientX, e.clientY), deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const button = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  return (
    <div className="browser-frame live-browser">
      <div className="browser-bar">
        <button className="btn sm ghost icon-btn" title="Back" disabled={!canDrive} onClick={() => void send('navigate', { action: 'back' })}>
          <IconArrowLeft width={14} height={14} />
        </button>
        <button className="btn sm ghost icon-btn" title="Forward" disabled={!canDrive} onClick={() => void send('navigate', { action: 'forward' })}>
          <IconArrowRight width={14} height={14} />
        </button>
        <button className="btn sm ghost icon-btn" title="Reload" disabled={!canDrive} onClick={() => void send('navigate', { action: 'reload' })}>
          <IconLoop width={14} height={14} />
        </button>
        <form
          className="grow"
          style={{ display: 'flex', minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            const url = String(new FormData(e.currentTarget).get('address') ?? '').trim();
            if (url) void send('navigate', { url });
          }}
        >
          <input key={live.url} name="address" className="address mono" defaultValue={live.url} readOnly={!canDrive} title={live.title || live.url} spellCheck={false} />
        </form>
        {/^https?:\/\//.test(live.url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(live.url) && (
          <button className="btn sm ghost" onClick={() => openPage(live.url)} title="Open this page in your own browser">
            Open
          </button>
        )}
        {memberWorking || yours ? (
          <button
            className={`btn sm ${yours ? 'primary' : ''}`}
            onClick={() =>
              void send('control', { by: yours ? 'member' : 'human' }).then(() => {
                if (!yours) screen.current?.focus();
              })
            }
            title={yours ? `${agent} continues where you left it` : `${agent} waits at its next browser step until you hand it back`}
          >
            {yours ? `Hand back to ${agent}` : 'Take control'}
          </button>
        ) : null}
      </div>
      <div
        ref={screen}
        className={`live-screen ${canDrive ? 'driving' : 'watching'}`}
        tabIndex={0}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => {
          if (!img.current) return;
          screen.current?.focus();
          if (!canDrive) {
            setHint(true);
            window.setTimeout(() => setHint(false), 2500);
            return;
          }
          e.preventDefault();
          buttons.current = e.buttons;
          void send('input', { type: 'down', ...at(e.clientX, e.clientY), button: button(e.button), clickCount: e.detail || 1 });
        }}
        onMouseUp={(e) => {
          if (!canDrive || !img.current || !buttons.current) return;
          buttons.current = 0;
          void send('input', { type: 'up', ...at(e.clientX, e.clientY), button: button(e.button), clickCount: e.detail || 1 });
        }}
        onMouseMove={(e) => {
          if (!canDrive || !img.current) return;
          // Hover effects and drags, at most ~20 moves a second.
          const now = performance.now();
          if (now - lastMove.current < 50) return;
          lastMove.current = now;
          void send('input', { type: 'move', ...at(e.clientX, e.clientY) });
        }}
        onKeyDown={(e) => {
          if (!canDrive) return;
          // Paste is handled below; let the shortcut through to fire it.
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
          const input = keyInput(e);
          if (!input) return;
          e.preventDefault();
          e.stopPropagation();
          void send('input', input);
        }}
        onPaste={(e) => {
          if (!canDrive) return;
          const text = e.clipboardData.getData('text/plain');
          if (text) {
            e.preventDefault();
            void send('input', { type: 'text', text });
          }
        }}
      >
        <img
          ref={img}
          key={streamKey}
          src={authedUrl(`${base}/live`) + `&n=${streamKey}`}
          alt={`${agent}’s browser: ${live.title || live.url}`}
          draggable={false}
          width={live.viewport.width}
          height={live.viewport.height}
          // The stream ends if the tab closes or the connection drops; try again.
          onError={() => window.setTimeout(() => setStreamKey((k) => k + 1), 1500)}
        />
        {hint && <div className="live-hint">{agent} is using its browser. Take control to click and type.</div>}
      </div>
      <div className="row tiny faint" style={{ padding: '6px 10px', gap: 10 }}>
        <span className="grow ellipsis">
          {yours
            ? `You have control: ${agent} waits at its next browser step. Click into the page to type.`
            : memberWorking
              ? `${agent} is driving. Take control to use the page yourself.`
              : `${agent} is not working right now, so you can use the page. Click into it to type.`}
        </span>
        <span className="num">
          {live.viewport.width}×{live.viewport.height} · {live.provider}
        </span>
      </div>
    </div>
  );
}

/** The screenshots a member looked at, newest followed live unless you pick an older one. */
function Screenshots({ detail, projectId, agent, views }: { detail: RunDetail; projectId: string; agent: string; views: View[] }) {
  const run = detail.summary;
  const url = useMemo(() => browserUrlOf(detail, agent), [detail, agent]);
  const a = run.agents.find((x) => x.name === agent);
  const [picked, setPicked] = useState<number | undefined>();
  const current = views.find((v) => v.id === picked) ?? views.at(-1);
  const following = picked === undefined || picked === views.at(-1)?.id;
  const [broken, setBroken] = useState<Set<number>>(() => new Set());
  useEffect(() => setPicked(undefined), [agent]);
  const working = a?.status === 'working' && run.status === 'running';

  return (
    <>
      <div className="browser-frame">
        <div className="browser-bar">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          <span className="address mono ellipsis" title={url}>
            {url ?? (a?.browser ? 'a page it did not name' : 'no page yet')}
          </span>
          {url && /^https?:\/\//.test(url) && (
            <button className="btn sm ghost" onClick={() => openPage(url)} title="Open this page in your own browser">
              Open
            </button>
          )}
        </div>
        <div className="browser-shot">
          {current && !broken.has(current.id) ? (
            <img
              key={current.id}
              src={viewSrc(projectId, run.id, current.id)}
              alt={`What ${agent} saw at ${clock(current.ts)}`}
              onError={() => setBroken((b) => new Set(b).add(current.id))}
            />
          ) : (
            <div className="browser-empty small muted">
              {current
                ? 'This screenshot is no longer kept.'
                : `${agent} ${working ? 'is using a browser but has' : 'has'} not looked at a screenshot yet. Claude sees a page when it takes a screenshot and reads it (or a browser tool returns one); it shows up here the moment it does.`}
            </div>
          )}
        </div>
      </div>
      {a?.browser?.live && !detail.browsers.some((b) => b.agent === agent) && (
        <p className="tiny faint" style={{ margin: 0 }}>
          {agent}’s browser runs in another covibe process (a run started in the terminal), so it cannot be watched live here. These are the screenshots it read.
        </p>
      )}
      {current && (
        <p className="tiny faint" style={{ margin: 0 }}>
          {following && working ? 'Live: follows new screenshots. ' : ''}
          Seen at {clock(current.ts)} via {current.tool}
          {current.file ? ` · ${current.file.split('/').slice(-2).join('/')}` : ''}
        </p>
      )}
      {views.length > 1 && (
        <div className="browser-strip" role="listbox" aria-label="Earlier screenshots">
          {[...views].reverse().map((v) => (
            <button key={v.id} role="option" aria-selected={v.id === current?.id} className={v.id === current?.id ? 'on' : ''} onClick={() => setPicked(v.id === views.at(-1)?.id ? undefined : v.id)} title={clock(v.ts)}>
              {broken.has(v.id) ? <span className="tiny faint">gone</span> : <img src={viewSrc(projectId, run.id, v.id)} alt="" loading="lazy" onError={() => setBroken((b) => new Set(b).add(v.id))} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
