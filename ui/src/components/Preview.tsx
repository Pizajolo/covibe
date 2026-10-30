// The Preview tab: a run's files as a tree, and the selected one shown the way
// it is meant to be seen. Web pages and PDFs open in a frame served by the
// run's own preview site (its own origin, see server/site.ts), so you can
// click through a site the team built; videos, audio and images play here;
// Markdown is rendered; office files open in their own app; other files show
// as text. Every view takes feedback: a moment, an area, a passage, an
// element (see Feedback.tsx).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { desktop, get, post, type FeedbackItem, type PreviewSite, type RunFile, type RunFiles, type RunSummary } from '../api';
import { useLive } from '../data';
import { CodeEditor } from './CodeEditor';
import { FeedbackPanel, useFeedback, type Anchor } from './Feedback';
import { IconAlert, IconArrowLeft, IconArrowRight, IconBranch, IconChat, IconEye, IconFile, IconFolder, IconLoop } from './icons';
import { Markdown } from './Markdown';
import { Empty } from './ui';
import { appName, AUDIO, IMAGE, ImageView, MediaView, OFFICE, OPENABLE, PDF, useOpenInApp, useSelectedText, VIDEO } from './Viewers';

/** Shown in the frame, as a browser shows them. */
const WEB = /\.(html?|pdf)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const HTML = /\.html?$/i;

type Node = { name: string; path: string; dir: boolean; changed: boolean; size: number; children: Node[] };

function buildTree(files: RunFiles['files']): Node {
  const root: Node = { name: '', path: '', dir: true, changed: false, size: 0, children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const leaf = i === parts.length - 1;
      let next = at.children.find((c) => c.name === name && c.dir === !leaf);
      if (!next) {
        next = { name, path, dir: !leaf, changed: false, size: leaf ? f.size : 0, children: [] };
        at.children.push(next);
      }
      if (f.changed) next.changed = true;
      at = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** The page to open first: a changed web page, then any index.html, then the first changed file. */
function firstPick(files: RunFiles['files']): string | undefined {
  const by = (pred: (p: string) => boolean) => files.filter((f) => pred(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0]?.path;
  return (
    by((p) => /(^|\/)index\.html?$/i.test(p) && files.find((f) => f.path === p)!.changed) ??
    files.find((f) => f.changed && HTML.test(f.path))?.path ??
    by((p) => /(^|\/)index\.html?$/i.test(p)) ??
    files.find((f) => f.changed)?.path ??
    by((p) => /(^|\/)readme\.md$/i.test(p)) ??
    files[0]?.path
  );
}

/** The file a page address shows ("/about/" is about/index.html). */
function fileOfPage(page: string, paths: Set<string>): string | undefined {
  const path = decodeURIComponent(page.replace(/[?#].*$/, '')).replace(/^\/+/, '');
  if (paths.has(path)) return path;
  const dir = path.replace(/\/+$/, '');
  const index = dir ? `${dir}/index.html` : 'index.html';
  return paths.has(index) ? index : undefined;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

export function Preview({ projectId, run }: { projectId: string; run: RunSummary }) {
  // New merges change the files; re-list them when the run commits or merges.
  const { value: listing, error } = useLive(
    () => get<RunFiles>(`/api/runs/${projectId}/${run.id}/files`),
    [projectId, run.id],
    (e) => e.projectId === projectId && e.event.runId === run.id && (e.event.type === 'git.merge' || e.event.type === 'git.commit' || e.event.type === 'files.changed' || e.event.type === 'files.undone' || e.event.type === 'run.finished'),
  );
  const [site, setSite] = useState<PreviewSite | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  /** What the frame was told to load (a path on the site); changes only when you pick a file or type an address. */
  const [src, setSrc] = useState<{ path: string; n: number } | undefined>();
  /** The page the frame shows now, as the page itself reports it. */
  const [page, setPage] = useState<{ path: string; title: string } | undefined>();
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const frame = useRef<HTMLIFrameElement>(null);
  const feedback = useFeedback();
  const [panel, setPanel] = useState(() => feedback.items.length > 0);
  const [picking, setPicking] = useState(false);
  /** A comment's moment to go to when its video opens. */
  const [seek, setSeek] = useState<{ path: string; at: number; n: number } | undefined>();
  const openInApp = useOpenInApp(projectId, run.id);

  useEffect(() => {
    setSite(null);
    setSiteError(null);
    post<PreviewSite>(`/api/runs/${projectId}/${run.id}/preview`).then(setSite, (err: Error) => setSiteError(err.message));
  }, [projectId, run.id]);

  const origin = site ? `${location.protocol}//${location.hostname}:${site.port}` : undefined;
  const siteUrl = useCallback((path: string) => {
    if (!site || !origin) return '';
    const u = new URL(path, origin);
    u.searchParams.set('covibe_key', site.key);
    return u.toString();
  }, [site, origin]);

  const files = listing?.files ?? [];
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const tree = useMemo(() => buildTree(files), [files]);

  const show = useCallback((path: string) => {
    setSelected(path);
    if (WEB.test(path)) setSrc((s) => ({ path: `/${path.split('/').map(encodeURIComponent).join('/')}`, n: (s?.n ?? 0) + 1 }));
    // Open the folders on the way to it.
    setOpen((o) => {
      const next = new Set(o);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
  }, []);

  // Pick a first file once the list is in, and open the folders with changes.
  useEffect(() => {
    if (!listing || selected) return;
    setOpen(new Set(listing.files.filter((f) => f.changed).flatMap((f) => f.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))));
    const first = firstPick(listing.files);
    if (first) show(first);
  }, [listing, selected, show]);

  // The page in the frame says where it is; follow it in the list. It also says which element you picked to comment on.
  useEffect(() => {
    if (!origin) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const data = e.data as { covibePick?: PickedElement | null } | null;
      if (data && 'covibePick' in data) {
        setPicking(false);
        const pick = data.covibePick;
        if (pick) {
          const file = fileOfPage(pick.path, paths) ?? selected ?? pick.path;
          feedback.compose({ target: 'file', path: file, kind: 'page', element: { selector: pick.selector, tag: pick.tag, text: pick.text, title: pick.title } });
        }
        return;
      }
      const info = (e.data as { covibePreview?: { path?: unknown; title?: unknown } } | null)?.covibePreview;
      if (!info || typeof info.path !== 'string') return;
      setPage({ path: info.path, title: typeof info.title === 'string' ? info.title : '' });
      const file = fileOfPage(info.path, paths);
      if (file) setSelected(file);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [origin, paths, selected, feedback.compose]);

  if (error) return <div className="banner bad" style={{ margin: 20 }}><IconAlert />{error}</div>;
  if (!listing) return <div style={{ padding: 20 }} className="faint">Loading files…</div>;
  if (!files.length) return <Empty icon={<IconEye />} title="No files yet">The run's files show up here once members merge their work.</Empty>;

  const q = filter.trim().toLowerCase();
  const visible = (n: Node): boolean => (n.dir ? n.children.some(visible) : (!changedOnly || n.changed) && (!q || n.path.toLowerCase().includes(q)));
  const searching = !!q || changedOnly;
  const changedCount = files.filter((f) => f.changed).length;
  const file = files.find((f) => f.path === selected);
  const web = !!selected && WEB.test(selected);
  const video = !!selected && VIDEO.test(selected);
  const audio = !!selected && AUDIO.test(selected);
  const image = !!selected && IMAGE.test(selected);
  const office = !!selected && OFFICE.test(selected);
  const fileUrl = (path: string) => siteUrl(`/${path.split('/').map(encodeURIComponent).join('/')}`);
  const pick = () => {
    setPicking(true);
    frame.current?.contentWindow?.postMessage({ covibe: 'pick' }, origin ?? '*');
  };
  const showItem = (i: FeedbackItem) => {
    if (i.target !== 'file' || !paths.has(i.path)) return;
    show(i.path);
    if (i.at !== undefined) setSeek((s) => ({ path: i.path, at: i.at!, n: (s?.n ?? 0) + 1 }));
  };

  const rows: ReactElement[] = [];
  const walk = (n: Node, depth: number) => {
    for (const c of n.children) {
      if (!visible(c)) continue;
      const expanded = searching || open.has(c.path);
      rows.push(
        <button
          key={c.path}
          className={`tree-row ${c.path === selected ? 'on' : ''} ${c.changed ? 'changed' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={c.path}
          onClick={() => {
            if (!c.dir) return show(c.path);
            setOpen((o) => {
              const next = new Set(o);
              if (next.has(c.path)) next.delete(c.path);
              else next.add(c.path);
              return next;
            });
          }}
        >
          {c.dir ? <span className={`caret ${expanded ? 'open' : ''}`}>▸</span> : <span className="caret" />}
          {c.dir ? <IconFolder width={13} height={13} /> : <IconFile width={13} height={13} />}
          <span className="ellipsis grow mono">{c.name}</span>
          {c.changed && <i className="dot" title={c.dir ? 'has changed files' : 'changed in this run'} />}
        </button>,
      );
      if (c.dir && expanded) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  const sourceLabel = listing.source.kind === 'branch' ? listing.source.ref : listing.source.kind === 'folder' ? 'your folder' : 'your checkout';
  const address = web ? (page?.path ?? src?.path ?? '') : selected ?? '';
  const send = (covibe: 'back' | 'forward' | 'reload') => frame.current?.contentWindow?.postMessage({ covibe }, origin ?? '*');
  const openOutside = () => {
    const url = siteUrl(web ? address : `/${selected}`);
    if (!url) return;
    if (desktop) void desktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="split preview">
      <div className="split-list preview-tree">
        <div className="col" style={{ gap: 6, marginBottom: 6 }}>
          <span className="tiny faint row" style={{ gap: 5 }} title={listing.source.kind === 'branch' ? 'Files as merged on the run’s result branch' : listing.source.kind === 'folder' ? 'This run worked directly in your folder' : 'This run worked directly in your checkout'}>
            <IconBranch width={12} height={12} /> <span className="mono ellipsis">{sourceLabel}</span>
          </span>
          <input className="input" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check tiny">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} /> Changed only ({changedCount})
          </label>
        </div>
        {rows.length ? rows : <span className="tiny faint" style={{ padding: 8 }}>No files match.</span>}
        {listing.truncated && <span className="tiny faint" style={{ padding: 8 }}>Only the first files are listed.</span>}
      </div>
      <div className="preview-main">
        <div className="browser-bar">
          {web ? (
            <>
              <button className="btn sm ghost icon-btn" title="Back" onClick={() => send('back')}><IconArrowLeft width={14} height={14} /></button>
              <button className="btn sm ghost icon-btn" title="Forward" onClick={() => send('forward')}><IconArrowRight width={14} height={14} /></button>
              <button className="btn sm ghost icon-btn" title="Reload" onClick={() => (page || src) && setSrc({ path: page?.path ?? src!.path, n: (src?.n ?? 0) + 1 })}><IconLoop width={14} height={14} /></button>
              <form
                className="grow"
                style={{ display: 'flex', minWidth: 0 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = String(new FormData(e.currentTarget).get('address') ?? '').trim();
                  if (value) setSrc((s) => ({ path: value.startsWith('/') ? value : `/${value}`, n: (s?.n ?? 0) + 1 }));
                }}
              >
                <input key={address} name="address" className="address mono" defaultValue={address} title={page?.title || address} spellCheck={false} />
              </form>
            </>
          ) : (
            <span className="address mono ellipsis">{selected}</span>
          )}
          {file && <span className="tiny faint num">{kb(file.size)}</span>}
          {selected && web && HTML.test(selected) && site && (
            <button className={`btn sm ${picking ? 'primary' : 'ghost'}`} onClick={() => (picking ? (frame.current?.contentWindow?.postMessage({ covibe: 'unpick' }, origin ?? '*'), setPicking(false)) : pick())} title="Click an element of the page to comment on it (Esc cancels)">
              <IconChat width={13} height={13} /> {picking ? 'Click an element…' : 'Comment on an element'}
            </button>
          )}
          {selected && web && (
            <button className="btn sm ghost" onClick={() => feedback.compose({ target: 'file', path: (HTML.test(selected) && page ? fileOfPage(page.path, paths) : undefined) ?? selected, kind: PDF.test(selected) ? 'pdf' : 'page' })}>
              {HTML.test(selected) ? 'Comment on the page' : 'Comment on the PDF'}
            </button>
          )}
          {selected && office && (
            <button className="btn sm" onClick={() => void openInApp(selected)} title="Open it in its own app on this computer">
              Open in {appName(selected)}
            </button>
          )}
          {site && selected && (web || video || audio || image) && (
            <button className="btn sm ghost" onClick={openOutside} title="Open in your own browser">
              Open
            </button>
          )}
          <button className={`btn sm ${panel ? '' : 'ghost'}`} onClick={() => setPanel((p) => !p)} title="Your comments on this result">
            Feedback{feedback.items.length ? ` (${feedback.items.length})` : ''}
          </button>
        </div>
        <div className="preview-body">
          {!selected ? (
            <Empty icon={<IconEye />} title="Pick a file">Web pages open as a site you can click through.</Empty>
          ) : (video || audio || image) ? (
            siteError ? (
              <div className="banner bad" style={{ margin: 20 }}><IconAlert />{siteError}</div>
            ) : site ? (
              image ? <ImageView key={selected} src={fileUrl(selected)} path={selected} /> : <MediaView key={selected} src={fileUrl(selected)} path={selected} kind={video ? 'video' : 'audio'} seek={seek?.path === selected ? seek : undefined} />
            ) : (
              <div style={{ padding: 20 }} className="faint">Starting the preview…</div>
            )
          ) : office ? (
            <Empty
              icon={<IconFile />}
              title={selected.split('/').pop() ?? selected}
              action={
                <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                  <button className="btn primary" onClick={() => void openInApp(selected)}>Open in {appName(selected)}</button>
                  <button className="btn" onClick={() => feedback.compose({ target: 'file', path: selected, kind: 'file' })}><IconChat width={14} height={14} /> Comment on it</button>
                </div>
              }
            >
              {file ? `${kb(file.size)} · ` : ''}Office files open in their own app on this computer. Leave your comments here for the team.
            </Empty>
          ) : web ? (
            siteError ? (
              <div className="banner bad" style={{ margin: 20 }}><IconAlert />{siteError}</div>
            ) : site && src ? (
              <iframe
                ref={frame}
                key={src.n}
                className="preview-frame"
                title={`Preview of ${selected}`}
                src={siteUrl(src.path)}
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
              />
            ) : (
              <div style={{ padding: 20 }} className="faint">Starting the preview…</div>
            )
          ) : (
            <FileText projectId={projectId} runId={run.id} path={selected} version={files.find((f) => f.path === selected)?.size} onComment={feedback.compose} onOpen={() => void openInApp(selected)} />
          )}
        </div>
      </div>
      {panel && <FeedbackPanel onShow={showItem} onClose={() => setPanel(false)} />}
    </div>
  );
}

/** What a page tells the app about the element you picked (see pickElements in server/site.ts). */
interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  path: string;
  title: string;
}

/** A non-web file: Markdown rendered (or as source), anything else as read-only text. Select a passage to comment on it. */
function FileText({ projectId, runId, path, version, onComment, onOpen }: { projectId: string; runId: string; path: string; version?: number; onComment: (a: Anchor) => void; onOpen: () => void }) {
  const { value: file, error } = useLive(() => get<RunFile>(`/api/runs/${projectId}/${runId}/file?path=${encodeURIComponent(path)}`), [projectId, runId, path, version]);
  const [source, setSource] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selection = useSelectedText(box);
  if (error) return <div className="banner bad" style={{ margin: 20 }}><IconAlert />{error}</div>;
  if (!file) return <div style={{ padding: 20 }} className="faint">Loading…</div>;
  if (file.binary)
    return (
      <Empty
        icon={<IconFile />}
        title="Binary file"
        action={
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            {OPENABLE.test(path) && <button className="btn" onClick={onOpen}>Open with its app</button>}
            <button className="btn" onClick={() => onComment({ target: 'file', path, kind: 'file' })}><IconChat width={14} height={14} /> Comment on it</button>
          </div>
        }
      >
        {path} ({kb(file.size)}) cannot be shown as text.
      </Empty>
    );
  const md = MARKDOWN.test(path);
  return (
    <div className="preview-text" ref={box}>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8, gap: 8 }}>
        <button
          className={`btn sm ${selection ? 'primary' : ''}`}
          // Keep the selection: a click on the button would clear it first.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onComment(selection ? { target: 'file', path, kind: 'text', quote: selection } : { target: 'file', path, kind: 'text' })}
          title="Select a passage first to comment on it; otherwise the comment is on the whole file"
        >
          <IconChat width={13} height={13} /> {selection ? 'Comment on the selection' : 'Comment on the file'}
        </button>
        {md && (
          <div className="seg">
            <button className={!source ? 'on' : ''} onClick={() => setSource(false)}>Rendered</button>
            <button className={source ? 'on' : ''} onClick={() => setSource(true)}>Source</button>
          </div>
        )}
      </div>
      {md && !source ? (
        <div className="card" style={{ padding: '6px 22px' }}>
          <Markdown text={file.content ?? ''} />
        </div>
      ) : (
        <div className="cm-wrap">
          <CodeEditor value={file.content ?? ''} readOnly language={md ? 'markdown' : /\.(json|ya?ml)$/i.test(path) ? 'json' : 'text'} />
        </div>
      )}
      {file.truncated && <p className="tiny faint">Only the first megabyte is shown.</p>}
    </div>
  );
}
