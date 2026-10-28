// What a member sees of the website it builds or tests: the screenshots it
// looked at (images in its tool results), newest first, and the page it goes to.
import { useEffect, useMemo, useState } from 'react';
import { authedUrl, desktop, type RunDetail } from '../api';
import { clock } from '../format';
import { IconBrowser } from './icons';
import { Modal } from './ui';

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
    const url = e.agent === agent && e.type === 'agent.tool' ? (e.data.browser as { url?: string } | undefined)?.url : undefined;
    if (url) return url;
  }
  return undefined;
}

export const viewSrc = (projectId: string, runId: string, id: number) => authedUrl(`/api/runs/${projectId}/${runId}/views/${id}`);

function openPage(url: string) {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/** The preview behind the browser button above a member's desk. Follows new screenshots live unless you pick an older one. */
export function BrowserPreview({ detail, projectId, agent, onClose }: { detail: RunDetail; projectId: string; agent: string; onClose: () => void }) {
  const run = detail.summary;
  const views = useMemo(() => viewsOf(detail, agent), [detail, agent]);
  const url = useMemo(() => browserUrlOf(detail, agent), [detail, agent]);
  const a = run.agents.find((x) => x.name === agent);
  const [picked, setPicked] = useState<number | undefined>();
  const current = views.find((v) => v.id === picked) ?? views.at(-1);
  const following = picked === undefined || picked === views.at(-1)?.id;
  const [broken, setBroken] = useState<Set<number>>(() => new Set());
  useEffect(() => setPicked(undefined), [agent]);
  const working = a?.status === 'working' && run.status === 'running';

  return (
    <Modal
      wide
      title={
        <span className="row" style={{ gap: 8 }}>
          <IconBrowser width={16} height={16} />
          What {agent} sees
        </span>
      }
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
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
    </Modal>
  );
}
