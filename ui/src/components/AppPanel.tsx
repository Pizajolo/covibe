// The App tab: the run's app (its dev server, a site) running in the sandbox
// or in Docker. Start, stop and restart it, change how it runs, read its log,
// and use it live, with feedback on any page or element.
import { useEffect, useRef, useState } from 'react';
import { desktop, post, get, type AppViewInfo, type RunApp, type RunAppSettings, type RunSummary } from '../api';
import { useLive } from '../data';
import { FeedbackPanel, useFeedback } from './Feedback';
import { IconAlert, IconArrowLeft, IconArrowRight, IconChat, IconLoop, IconPlay, IconSpinner, IconStop } from './icons';
import { Empty, useAction } from './ui';

const SOURCE: Record<string, string> = {
  team: 'from the team file',
  remembered: 'as it ran last time',
  detected: 'detected from the project',
  given: 'as you set it',
};

/** Settings a person can type: everything as text. */
type Form = Record<keyof RunAppSettings, string>;
const EMPTY: Form = { runtime: 'sandbox', setup: '', command: '', port: '', path: '', image: '', dockerfile: '', compose: '', service: '' };
const toForm = (s?: RunAppSettings): Form => ({ ...EMPTY, ...Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, v === undefined ? '' : String(v)])) }) as Form;

export function AppPanel({ projectId, run }: { projectId: string; run: RunSummary }) {
  const base = `/api/runs/${projectId}/${run.id}/app`;
  const { value: info, error, reload } = useLive(
    () => get<RunApp>(base),
    [projectId, run.id],
    (e) => e.projectId === projectId && e.event.runId === run.id && e.event.type.startsWith('app.'),
  );
  const app = info?.app;
  const active = app?.status === 'running' || app?.status === 'starting';
  // While it starts (and while you look), follow its state and log.
  useEffect(() => {
    const t = window.setInterval(() => void reload(), active ? 1500 : 5000);
    return () => window.clearInterval(t);
  }, [active, reload]);

  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState(false);
  // The form shows how it runs (or would run) until you change it.
  const shown: Form = form ?? toForm(app?.settings ?? info?.suggested);
  const set = (k: keyof Form, v: string) => setForm({ ...shown, [k]: v });

  const [start, starting] = useAction(async () => {
    const settings = Object.fromEntries(Object.entries(shown).filter(([, v]) => v.trim()));
    await post(`${base}/start`, { settings });
    setForm(null);
    setEditing(false);
    await reload();
  });
  const [stop, stopping] = useAction(async () => {
    await post(`${base}/stop`);
    await reload();
  });

  const feedback = useFeedback();
  const [panel, setPanel] = useState(false);
  const [showLog, setShowLog] = useState(false);

  if (error) return <div className="banner bad" style={{ margin: 20 }}><IconAlert />{error}</div>;
  if (!info) return <div style={{ padding: 20 }} className="faint">Loading…</div>;

  const docker = shown.runtime === 'docker';
  const source = app?.source ?? info.suggested?.source;
  const running = app?.status === 'running';

  return (
    <div className="split app-tab">
      <div className="app-main">
        <div className="app-head">
          <div className="row wrap" style={{ gap: 10 }}>
            <AppStatus info={info} />
            <span className="grow" />
            {running && (
              <button className="btn sm" onClick={() => (desktop ? void desktop.openExternal(app.url) : window.open(app.url, '_blank', 'noopener'))} title={app.url}>
                Open in browser
              </button>
            )}
            {active ? (
              <>
                <button className="btn sm" disabled={starting} onClick={() => void start()} title="Stop it and start it again">
                  <IconLoop width={13} height={13} /> Restart
                </button>
                <button className="btn sm danger" disabled={stopping} onClick={() => void stop()}>
                  <IconStop width={13} height={13} /> Stop
                </button>
              </>
            ) : (
              <button className="btn sm primary" disabled={starting || !!info.unavailable || (docker && !info.dockerAvailable) || (!shown.command && !shown.compose && !shown.dockerfile && !(docker && shown.image))} onClick={() => void start()}>
                {starting ? <IconSpinner width={13} height={13} /> : <IconPlay width={13} height={13} />} Start the app
              </button>
            )}
            <button className={`btn sm ${editing ? '' : 'ghost'}`} onClick={() => setEditing((e) => !e)}>
              How it runs
            </button>
            <button className={`btn sm ${showLog ? '' : 'ghost'}`} onClick={() => setShowLog((l) => !l)}>
              Log
            </button>
            <button className={`btn sm ${panel ? '' : 'ghost'}`} onClick={() => setPanel((p) => !p)}>
              Feedback{feedback.items.length ? ` (${feedback.items.length})` : ''}
            </button>
          </div>
          {info.unavailable && <div className="banner warn"><IconAlert />{info.unavailable}</div>}
          {(editing || (!app && !info.suggested?.command && !info.suggested?.compose && !info.suggested?.dockerfile)) && !info.unavailable && (
            <div className="app-settings">
              {info.suggestError && !form && <p className="tiny muted" style={{ margin: 0 }}>{info.suggestError}</p>}
              <div className="row wrap" style={{ gap: 10 }}>
                <div className="seg">
                  <button className={!docker ? 'on' : ''} onClick={() => set('runtime', 'sandbox')}>Sandbox</button>
                  <button className={docker ? 'on' : ''} disabled={!info.dockerAvailable} onClick={() => set('runtime', 'docker')} title={info.dockerAvailable ? 'Run it in a Docker container' : 'Docker is not running on this computer'}>
                    Docker
                  </button>
                </div>
                <span className="tiny faint">
                  {docker
                    ? 'In a container: from an image with the project mounted at /app, a Dockerfile, or a compose file. The app listens on 0.0.0.0:$PORT inside.'
                    : "In the OS sandbox: it writes only in the run's folder and package caches, and reaches only the team's sandbox domains. It listens on 127.0.0.1:$PORT."}
                  {source && !form ? ` Settings ${source === 'given' && app ? `as ${app.by === 'you' ? 'you' : app.by} gave them` : SOURCE[source]}.` : ''}
                </span>
              </div>
              <div className="app-fields">
                <Field label="Setup" hint="Runs first, every start" value={shown.setup} placeholder="npm install" onChange={(v) => set('setup', v)} />
                <Field label="Command" hint={docker ? 'Empty: the image or Dockerfile starts it' : 'Must listen on $PORT'} value={shown.command} placeholder="npm run dev -- --port $PORT --host 127.0.0.1" onChange={(v) => set('command', v)} />
                <Field label={docker ? 'Port inside the container' : 'Fixed port'} hint={docker ? 'Default 3000' : 'Empty: a free one'} value={shown.port} placeholder={docker ? '3000' : 'auto'} onChange={(v) => set('port', v.replace(/\D/g, ''))} small />
                <Field label="First page" value={shown.path} placeholder="/" onChange={(v) => set('path', v)} small />
                {docker && (
                  <>
                    <Field label="Image" value={shown.image} placeholder="node:22-bookworm-slim" onChange={(v) => set('image', v)} />
                    <Field label="Dockerfile" value={shown.dockerfile} placeholder="Dockerfile" onChange={(v) => set('dockerfile', v)} />
                    <Field label="Compose file" value={shown.compose} placeholder="compose.yaml" onChange={(v) => set('compose', v)} />
                    <Field label="Compose service" value={shown.service} placeholder="web" onChange={(v) => set('service', v)} small />
                  </>
                )}
              </div>
              {form && (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm ghost" onClick={() => setForm(null)}>Reset</button>
                  <span className="tiny faint">What you start is remembered for this project.</span>
                </div>
              )}
            </div>
          )}
        </div>
        {showLog && <pre className="app-log mono">{info.log || 'Nothing in the log yet.'}</pre>}
        <div className="app-body">
          {running ? (
            <AppView projectId={projectId} runId={run.id} app={app} />
          ) : app?.status === 'starting' ? (
            <div className="col" style={{ flex: 1, minHeight: 0 }}>
              <div className="row small muted" style={{ padding: '10px 16px', gap: 8 }}>
                <IconSpinner width={14} height={14} /> Starting… it opens here once it answers at {app.url}.
              </div>
              {!showLog && <pre className="app-log mono grow">{info.log || '…'}</pre>}
            </div>
          ) : app?.status === 'failed' ? (
            <div className="col" style={{ flex: 1, minHeight: 0 }}>
              <div className="banner bad" style={{ margin: 16 }}><IconAlert />{app.reason ?? 'The app stopped.'}</div>
              {!showLog && <pre className="app-log mono grow">{info.log || 'The log is empty.'}</pre>}
            </div>
          ) : (
            <Empty icon={<IconPlay />} title={app ? 'The app is stopped' : 'Run the app'} action={undefined}>
              {app?.reason ? `${app.reason}. ` : ''}
              Start it here, or ask a member in chat to run it. Members with the app tools start it themselves to test it, and a reviewer can open it in its browser. It keeps running until it is stopped or nobody uses it for 30 minutes.
            </Empty>
          )}
        </div>
      </div>
      {panel && <FeedbackPanel onClose={() => setPanel(false)} />}
    </div>
  );
}

function Field({ label, hint, value, placeholder, onChange, small }: { label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void; small?: boolean }) {
  return (
    <label className={`col app-field ${small ? 'small-field' : ''}`} style={{ gap: 4 }}>
      <span className="tiny muted">
        {label}
        {hint && <span className="faint"> · {hint}</span>}
      </span>
      <input className="input mono" value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function AppStatus({ info }: { info: RunApp }) {
  const app = info.app;
  if (!app) return <span className="small muted">Not running</span>;
  const where = app.runtime === 'docker' ? 'in Docker' : 'in the sandbox';
  if (app.status === 'running')
    return (
      <span className="row small" style={{ gap: 6 }}>
        <i className="app-dot on" /> Running {where} at <span className="mono">{app.url}</span> <span className="faint">· started by {app.by}</span>
      </span>
    );
  if (app.status === 'starting') return <span className="row small" style={{ gap: 6 }}><i className="app-dot wait" /> Starting {where}… <span className="faint">· by {app.by}</span></span>;
  if (app.status === 'failed') return <span className="row small" style={{ gap: 6 }}><i className="app-dot bad" /> Did not run</span>;
  return <span className="row small muted" style={{ gap: 6 }}><i className="app-dot" /> Stopped</span>;
}

/** The running app in a frame (through its view, which adds the feedback bridge), with an address bar. */
function AppView({ projectId, runId, app }: { projectId: string; runId: string; app: NonNullable<RunApp['app']> }) {
  const [view, setView] = useState<AppViewInfo | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [src, setSrc] = useState({ path: app.path, n: 0 });
  const [page, setPage] = useState<{ path: string; title: string } | undefined>();
  const [picking, setPicking] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const { compose } = useFeedback();

  useEffect(() => {
    setView(null);
    post<AppViewInfo>(`/api/runs/${projectId}/${runId}/app/view`).then(setView, (err: Error) => setViewError(err.message));
  }, [projectId, runId, app.port, app.startedAt]);
  const origin = view ? `${location.protocol}//${location.hostname}:${view.port}` : undefined;

  useEffect(() => {
    if (!origin) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { covibePreview?: { path?: unknown; title?: unknown }; covibePick?: { selector: string; tag: string; text: string; path: string; title: string } | null } | null;
      if (d && 'covibePick' in d) {
        setPicking(false);
        if (d.covibePick) compose({ target: 'app', path: d.covibePick.path, kind: 'page', element: { selector: d.covibePick.selector, tag: d.covibePick.tag, text: d.covibePick.text, title: d.covibePick.title } });
        return;
      }
      if (d?.covibePreview && typeof d.covibePreview.path === 'string') setPage({ path: d.covibePreview.path, title: typeof d.covibePreview.title === 'string' ? d.covibePreview.title : '' });
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [origin, compose]);

  if (viewError) return <div className="banner bad" style={{ margin: 16 }}><IconAlert />{viewError}</div>;
  if (!view || !origin) return <div style={{ padding: 20 }} className="faint">Opening the app…</div>;
  const send = (covibe: string) => frame.current?.contentWindow?.postMessage({ covibe }, origin);
  const address = page?.path ?? src.path;
  return (
    <div className="preview-main">
      <div className="browser-bar">
        <button className="btn sm ghost icon-btn" title="Back" onClick={() => send('back')}><IconArrowLeft width={14} height={14} /></button>
        <button className="btn sm ghost icon-btn" title="Forward" onClick={() => send('forward')}><IconArrowRight width={14} height={14} /></button>
        <button className="btn sm ghost icon-btn" title="Reload" onClick={() => setSrc({ path: address, n: src.n + 1 })}><IconLoop width={14} height={14} /></button>
        <form
          className="grow"
          style={{ display: 'flex', minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get('address') ?? '').trim();
            if (value) setSrc({ path: value.startsWith('/') ? value : `/${value}`, n: src.n + 1 });
          }}
        >
          <input key={address} name="address" className="address mono" defaultValue={address} title={page?.title || address} spellCheck={false} />
        </form>
        <button
          className={`btn sm ${picking ? 'primary' : 'ghost'}`}
          onClick={() => {
            if (picking) {
              send('unpick');
              setPicking(false);
            } else {
              send('pick');
              setPicking(true);
            }
          }}
          title="Click an element of the app to comment on it (Esc cancels)"
        >
          <IconChat width={13} height={13} /> {picking ? 'Click an element…' : 'Comment on an element'}
        </button>
        <button className="btn sm ghost" onClick={() => compose({ target: 'app', path: address, kind: 'page' })}>
          Comment on the page
        </button>
      </div>
      <iframe
        ref={frame}
        key={`${src.n}-${view.port}`}
        className="preview-frame"
        title="The running app"
        src={`${origin}${src.path}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
    </div>
  );
}
