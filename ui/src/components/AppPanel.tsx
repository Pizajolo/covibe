// The App tab: the run's app (its dev server, a site) running in the sandbox
// or in Docker. Start, stop and restart it, change how it runs, read its log,
// and use it live, with feedback on any page or element.
import { useEffect, useRef, useState } from 'react';
import { del, desktop, post, get, type AppProblemInfo, type AppViewInfo, type RunApp, type RunAppSettings, type RunSummary } from '../api';
import { AppDoctor } from './AppDoctor';
import { useLive } from '../data';
import { FeedbackPanel, useFeedback } from './Feedback';
import { IconAlert, IconArrowLeft, IconArrowRight, IconChat, IconLoop, IconPlay, IconSparkle, IconSpinner, IconStop } from './icons';
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

  const [forget, forgetting] = useAction(async () => {
    await del(`${base}/memory`);
    setForm(null);
    await reload();
  });
  const [doctor, setDoctor] = useState<{ seed?: string } | null>(null);
  const askDoctor = () => setDoctor({ seed: 'The app does not start. Find out why and get it running.' });

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
            <button className={`btn sm ${doctor ? '' : 'ghost'}`} onClick={() => setDoctor((d) => (d ? null : {}))} title="An agent that finds out why the app does not start and proposes fixes you approve">
              <IconSparkle width={13} height={13} /> App doctor{info.doctor?.waiting ? ` (${info.doctor.waiting})` : ''}
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
              <Places places={info.places} onForget={() => void forget()} forgetting={forgetting} />
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
              <Problems
                problems={info.problems ?? []}
                places={info.places}
                onSettings={() => setEditing(true)}
                onForget={() => void forget()}
                forgetting={forgetting}
                onDoctor={askDoctor}
              />
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
      {doctor && (
        <AppDoctor
          projectId={projectId}
          runId={run.id}
          conversation={doctor.seed ? undefined : info.doctor?.runId}
          seed={doctor.seed}
          onSeeded={() => setDoctor({})}
          onClose={() => setDoctor(null)}
        />
      )}
    </div>
  );
}

const PLACE: Record<AppProblemInfo['fixes'][number]['where'], string> = {
  settings: 'How it runs',
  team: 'Team file',
  memory: 'Last time',
  code: 'Code',
  sandbox: 'Sandbox',
  computer: 'This computer',
};

/** What covibe recognised in the log, each with where to fix it, and the app doctor for the rest. */
function Problems({
  problems,
  places,
  onSettings,
  onForget,
  forgetting,
  onDoctor,
}: {
  problems: AppProblemInfo[];
  places: RunApp['places'];
  onSettings: () => void;
  onForget: () => void;
  forgetting: boolean;
  onDoctor: () => void;
}) {
  return (
    <div className="app-problems">
      {problems.map((p) => (
        <div key={p.kind} className="app-problem">
          <div className="small"><strong>{p.title}</strong></div>
          <div className="tiny muted">{p.detail}</div>
          <ul>
            {p.fixes.map((f, i) => (
              <li key={i} className="small">
                <span className="chip-label">{PLACE[f.where]}</span> {f.text}{' '}
                {f.where === 'settings' && <button className="btn sm ghost" onClick={onSettings}>Open How it runs</button>}
                {f.where === 'team' && places.teamFile && <OpenFile path={places.teamFile} label="Open the team file" />}
                {f.where === 'memory' && places.memory && (
                  <button className="btn sm ghost" disabled={forgetting} onClick={onForget}>Forget it</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm primary" onClick={onDoctor}>
          <IconSparkle width={13} height={13} /> Find and fix it with an agent
        </button>
        <span className="tiny faint">
          {problems.length ? 'Or fix it yourself where it says above. ' : 'covibe does not recognise this one. '}
          The app doctor reads the log and the folder and proposes fixes; nothing changes until you approve each one.
        </span>
      </div>
    </div>
  );
}

/** Where the settings live: the team file's app: section and what covibe remembered (app.json), which you can forget. */
function Places({ places, onForget, forgetting }: { places: RunApp['places']; onForget: () => void; forgetting: boolean }) {
  const show = (s: RunAppSettings) =>
    Object.entries(s)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  return (
    <div className="app-places">
      <div className="app-place">
        <div className="tiny muted">
          Team file{places.teamFile ? <> · <span className="mono">{places.teamFile}</span></> : ''}
          {places.teamFile && <OpenFile path={places.teamFile} label="Open" />}
        </div>
        {places.team ? <pre className="mono">{`app:\n${show(places.team).replace(/^/gm, '  ')}`}</pre> : <div className="tiny faint">No app: section. Add one to set how every start runs (setup, command, …).</div>}
      </div>
      <div className="app-place">
        <div className="tiny muted">
          What ran last time{places.memory ? <> · <span className="mono">{places.memory.file}</span></> : ''}
          {places.memory && (
            <button className="btn sm ghost" disabled={forgetting} onClick={onForget} title="Delete app.json, so the team file or what covibe detects is used">
              Forget it
            </button>
          )}
        </div>
        {places.memory ? <pre className="mono">{show(places.memory.settings)}</pre> : <div className="tiny faint">Nothing remembered yet. What starts successfully from here or by a member is kept for this project.</div>}
      </div>
    </div>
  );
}

function OpenFile({ path, label }: { path: string; label: string }) {
  if (!desktop) return null;
  return (
    <button className="btn sm ghost" onClick={() => void desktop!.openPath(path)}>
      {label}
    </button>
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
