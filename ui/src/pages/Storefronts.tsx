// A team's page on the market. The Storefronts tab shows each storefront as a
// card and starts a new one from an existing team; the editor is a form
// (page, order form, delivery, rules) next to an assistant that sets it up in
// a chat. Both write storefront.yaml, next to the team file.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { parse, stringify } from 'yaml';
import { authedUrl, del, get, post, postRaw, put, type ChatItem, type MarketTeam, type MarketView } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { IconAlert, IconArrowLeft, IconChat, IconCheck, IconFile, IconInfo, IconPlus, IconSend, IconSpinner, IconTrash, IconX } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { MicButton, withSpoken } from '../components/MicButton';
import { Toolbar } from '../components/Toolbar';
import { Copy, Modal, useAction, useToast } from '../components/ui';
import { go, href, useLive } from '../data';
import { money } from '../format';
import { openUrl } from './GitView';

const mediaUrl = (team: string, file: string) => authedUrl(`/api/market/storefronts/${team}/media?file=${encodeURIComponent(file)}`);
const isImage = (file: string) => /\.(png|jpe?g|gif|webp)$/i.test(file);
const isVideo = (file: string) => /\.(mp4|webm|mov)$/i.test(file);

// ---- the tab: every storefront as a card, and a way to start one

export function Storefronts({ m, onChanged }: { m: MarketView; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [setActive, busy] = useAction(async (t: MarketTeam, active: boolean) => {
    await post(`/api/market/storefronts/${t.id}/active`, { active });
    toast(active ? `${t.title ?? t.name} takes orders again` : `${t.title ?? t.name} takes no new orders`);
    await onChanged();
  });
  // Live ones first, then the ones still being set up.
  const rank = (t: MarketTeam) => (t.listingId === undefined ? 2 : t.active === false ? 1 : 0);
  const shops = m.teams.filter((t) => t.hasStorefront).sort((a, b) => rank(a) - rank(b));
  return (
    <>
      <div className="sf-grid">
        {shops.map((t) => (
          <div key={t.id} className="sf-card" role="link" tabIndex={0} onClick={() => go('market', 'storefronts', t.id)} onKeyDown={(e) => e.key === 'Enter' && go('market', 'storefronts', t.id)}>
            <div className="sf-cover">
              {t.cover && isImage(t.cover) ? <img src={mediaUrl(t.id, t.cover)} alt="" /> : t.cover && isVideo(t.cover) ? <video src={`${mediaUrl(t.id, t.cover)}#t=0.1`} muted playsInline preload="metadata" /> : <span>{(t.title ?? t.name).slice(0, 1).toUpperCase()}</span>}
              <span className="sf-state">
                {t.listingId === undefined ? <span className="pill">Draft</span> : t.active === false ? <span className="pill">Closed for orders</span> : <span className="pill good">Live</span>}
              </span>
            </div>
            <div className="sf-body">
              <strong className="ellipsis">{t.title ?? t.name}</strong>
              <span className="small muted ellipsis-2">{t.summary || `Team ${t.name}`}</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {t.outdated && <span className="pill warn">Changes not published</span>}
                {t.problems.length > 0 && (
                  <span className="pill bad" title={t.problems.join('\n')}>
                    <IconAlert /> {t.problems.length} to fix
                  </span>
                )}
              </div>
              <span className="tiny faint">
                {t.priceNear !== undefined ? `${t.priceNear} NEAR per order` : `Team ${t.name}`}
                {t.stats ? ` · ${t.stats.completed} paid · ${t.stats.failed + t.stats.expired + t.stats.declined} refunded · ${t.stats.disputed} disputed` : ''}
              </span>
              {t.url && (
                <div className="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => openUrl(t.url!)}>
                    Open page
                  </button>
                  <Copy text={t.url} label="Copy link" />
                  <span className="grow" />
                  <button className="btn sm ghost" disabled={busy} onClick={() => void setActive(t, t.active === false)}>
                    {t.active === false ? 'Open for orders' : 'Close'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <button className="sf-card sf-new" onClick={() => setAdding(true)}>
          <IconPlus />
          <strong>New storefront</strong>
          <span className="small muted">Sell the work of one of your teams</span>
        </button>
      </div>
      {adding && <NewStorefront m={m} onClose={() => setAdding(false)} onChanged={onChanged} />}
    </>
  );
}

function NewStorefront({ m, onClose, onChanged }: { m: MarketView; onClose: () => void; onChanged: () => Promise<void> }) {
  const free = m.teams.filter((t) => !t.hasStorefront);
  const [create, busy] = useAction(async (t: MarketTeam) => {
    await post(`/api/market/storefronts/${t.id}`);
    await onChanged();
    onClose();
    go('market', 'storefronts', t.id);
  });
  return (
    <Modal
      title="New storefront"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => go('teams')}>
            Create a new team
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="small muted">Which team's work do you want to sell? You set up its page next; nothing is public until you publish.</p>
      {free.length ? (
        <div className="sf-pick">
          {free.map((t) => (
            <button key={t.id} disabled={busy} onClick={() => void create(t)}>
              <strong>{t.name}</strong>
              <span className="small muted">{t.description ?? 'No description'}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="banner info">
          <IconInfo /> {m.teams.length ? 'Every team you have already has a storefront.' : 'You have no team yet. A storefront sells the work of a team, so create one first.'}
        </div>
      )}
    </Modal>
  );
}

// ---- the editor

interface Field {
  name: string;
  label?: string;
  help?: string;
  type: 'text' | 'files';
  required?: boolean;
  max_chars?: number;
  accept?: string[];
  max_files?: number;
  folder?: string;
}
interface Example {
  title: string;
  text?: string;
  file?: string;
}
/** storefront.yaml's content, as it is written (see schemas/storefront.schema.json). */
interface Doc {
  title?: string;
  summary?: string;
  description?: string;
  price_near?: number;
  windows?: { accept_min?: number; delivery_min?: number; review_min?: number };
  intake?: { mode?: 'manual' | 'recommend' | 'auto'; budget_cap_usd?: number; estimated_cost_usd?: number; min_price_near?: number; auto_min_fit?: number; max_input_mb?: number; policy?: string };
  inputs?: Field[];
  examples?: Example[];
  goal?: string;
  deliverables?: { folder?: string; gates_required?: string[] };
  workspace?: 'folder' | 'git';
  privacy?: string;
}
interface Loaded {
  exists: boolean;
  yaml: string;
  problems: string[];
  name: string;
  gates: string[];
  media: { file: string; size: number; type: string }[];
}
interface Chat {
  runId: string | null;
  busy: boolean;
  thread: ChatItem[];
  saves: { ts: string; valid: boolean; problems: string[]; summary: string | null }[];
  costUsd: number;
}

const HEADER = `# This team's page on the covibe market. Customers see the title, summary,\n# description, examples and the order form; never the team file or its prompts.\n`;

/** Empty texts, lists and groups are left out of the file. */
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const t = tidy(x);
      if (t === undefined || t === '' || (typeof t === 'number' && Number.isNaN(t))) continue;
      if (t && typeof t === 'object' && !Array.isArray(t) && !Object.keys(t).length) continue;
      out[k] = t;
    }
    return out;
  }
  return v;
}

const toYaml = (doc: Doc) => HEADER + stringify({ storefront: tidy({ ...doc, inputs: doc.inputs ?? [], deliverables: { ...doc.deliverables, folder: doc.deliverables?.folder ?? '' } }) }, { lineWidth: 0 });

function fromYaml(text: string): Doc {
  const v = parse(text) as { storefront?: unknown } | null;
  if (!v || typeof v !== 'object' || !v.storefront || typeof v.storefront !== 'object' || Array.isArray(v.storefront)) throw new Error('the file needs a "storefront:" section');
  return v.storefront as Doc;
}

const PRESETS: { label: string; ext: string[] }[] = [
  { label: 'Video', ext: ['.mp4', '.mov', '.webm', '.m4v'] },
  { label: 'Images', ext: ['.png', '.jpg', '.jpeg', '.webp', '.gif'] },
  { label: 'Audio', ext: ['.mp3', '.wav', '.m4a'] },
  { label: 'Documents', ext: ['.pdf', '.docx', '.txt', '.md'] },
];

const span = (min: number | undefined) => (min === undefined || Number.isNaN(min) ? '' : min < 90 ? `${min} minutes` : min < 2880 ? `${+(min / 60).toFixed(1)} hours` : `${+(min / 1440).toFixed(1)} days`);

type Section = 'page' | 'form' | 'delivery' | 'rules' | 'file';
const SECTIONS: [Section, string][] = [
  ['page', 'Page'],
  ['form', 'Order form'],
  ['delivery', 'Delivery'],
  ['rules', 'Rules'],
  ['file', 'File'],
];

export function StorefrontEditor({ team, market, onChanged }: { team: string; market: MarketView | null; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const { value, reload } = useLive(() => get<Loaded>(`/api/market/storefronts/${team}`), [team]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [text, setText] = useState('');
  const [broken, setBroken] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [media, setMedia] = useState<Loaded['media']>([]);
  const [section, setSection] = useState<Section>('page');
  const [chat, setChat] = useState(true);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const t = market?.teams.find((x) => x.id === team);

  useEffect(() => {
    if (!value) return;
    setText(value.yaml);
    setProblems(value.problems);
    setMedia(value.media);
    try {
      setDoc(fromYaml(value.yaml));
      setBroken(null);
    } catch (err) {
      setDoc({});
      setBroken((err as Error).message);
      setSection('file');
    }
    // A team with no storefront yet shows one to start from; it is written with the first change.
    setState('saved');
  }, [value]);

  // Changes are saved on their own a moment after the last one, so the assistant always reads what the form shows.
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const yaml = pending.current;
    if (yaml === null) return;
    pending.current = null;
    setState('saving');
    try {
      const out = await put<{ problems: string[] }>(`/api/market/storefronts/${team}`, { yaml });
      setProblems(out.problems);
      if (pending.current === null) setState('saved');
      void onChanged();
    } catch (err) {
      pending.current ??= yaml;
      setState('dirty');
      toast((err as Error).message, true);
    }
  }, [team, onChanged, toast]);
  const schedule = (yaml: string) => {
    pending.current = yaml;
    setState('dirty');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
  };
  useEffect(() => () => void flush(), [flush]);

  const change = (fn: (d: Doc) => Doc) => {
    if (!doc || broken) return;
    const next = fn(doc);
    const yaml = toYaml(next);
    setDoc(next);
    setText(yaml);
    schedule(yaml);
  };
  const set = <K extends keyof Doc>(k: K, v: Doc[K]) => change((d) => ({ ...d, [k]: v }));
  const editFile = (yaml: string) => {
    setText(yaml);
    try {
      setDoc(fromYaml(yaml));
      setBroken(null);
      schedule(yaml);
    } catch (err) {
      setBroken((err as Error).message);
    }
  };

  const [publish, publishing] = useAction(async () => {
    await flush();
    const out = await post<{ listingId: number; created: boolean; url: string }>(`/api/market/storefronts/${team}/publish`);
    toast(out.created ? `Published as listing ${out.listingId}` : `Listing ${out.listingId} updated`);
    await onChanged();
  });
  const [remove] = useAction(async () => {
    pending.current = null;
    window.clearTimeout(timer.current);
    await del(`/api/market/storefronts/${team}`);
    toast('The draft was deleted');
    await onChanged();
    go('market', 'storefronts');
  });
  // The assistant saved: show what it wrote.
  const assistantSaved = useCallback(async () => {
    pending.current = null;
    window.clearTimeout(timer.current);
    await Promise.all([reload(), onChanged()]);
    toast('The assistant updated the storefront');
  }, [reload, onChanged, toast]);

  const published = t?.listingId !== undefined;
  const blocked = !market?.ready ? 'Set the market up first (Market → Settings)' : broken ? 'The file cannot be read; fix it under File' : problems.length ? 'Fix the problems first' : undefined;
  return (
    <>
      <Toolbar
        title={
          <span className="row">
            <a className="btn ghost sm" href={href('market', 'storefronts')} aria-label="Back to the storefronts">
              <IconArrowLeft />
            </a>
            {doc?.title || value?.name || team}
          </span>
        }
        sub={`Storefront of the team ${value?.name ?? team} · ${state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Edited' : value && !value.exists && !t?.hasStorefront ? 'Not saved yet' : 'Saved'}`}
      >
        {!published && t?.hasStorefront && (
          <button className="btn ghost" onClick={() => void remove()} title="Delete this draft. The team stays.">
            <IconTrash /> Delete draft
          </button>
        )}
        <button className={`btn ${chat ? 'on' : ''}`} onClick={() => setChat((c) => !c)} aria-pressed={chat}>
          <IconChat /> Assistant
        </button>
        <button className="btn primary" disabled={publishing || !doc || !!blocked} title={blocked ?? 'Create or update the listing on NEAR and its page in the relay'} onClick={() => void publish()}>
          {published ? (t?.outdated || state !== 'saved' ? 'Publish changes' : 'Publish again') : 'Publish'}
        </button>
      </Toolbar>
      <div className="content flush">
        <div className="sf-edit">
          <div className="sf-form">
            <div className="page" style={{ maxWidth: 860 }}>
              {t?.url && (
                <div className="banner good">
                  <IconCheck />
                  <div className="grow">
                    Listing {t.listingId} is live{t.active === false ? ' (closed for new orders)' : ''}: <a onClick={() => openUrl(t.url!)}>{t.url}</a>
                    {t.outdated && <div className="small">What you see here is newer than the published page. Publish to update it.</div>}
                  </div>
                  <Copy text={t.url} label="Copy link" />
                </div>
              )}
              {(broken || problems.length > 0) && (
                <div className="banner bad">
                  <IconAlert />
                  <div className="col" style={{ gap: 2 }}>
                    <strong>{broken ? 'The file cannot be read' : 'To fix before publishing'}</strong>
                    {(broken ? [broken] : problems).map((p) => (
                      <div key={p}>{p}</div>
                    ))}
                  </div>
                </div>
              )}
              <div className="seg" role="tablist">
                {SECTIONS.map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={section === id} className={section === id ? 'on' : ''} disabled={!!broken && id !== 'file'} onClick={() => setSection(id)}>
                    {label}
                  </button>
                ))}
              </div>
              {!doc ? (
                <div className="faint small">Loading…</div>
              ) : section === 'page' ? (
                <PageSection team={team} doc={doc} set={set} media={media} onMedia={setMedia} />
              ) : section === 'form' ? (
                <FormSection doc={doc} set={set} />
              ) : section === 'delivery' ? (
                <DeliverySection doc={doc} set={set} gates={value?.gates ?? []} />
              ) : section === 'rules' ? (
                <RulesSection doc={doc} set={set} />
              ) : (
                <div className="card" style={{ overflow: 'hidden' }}>
                  <div className="card-head">
                    <h2>storefront.yaml</h2>
                    <span className="hint">Next to the team file. The form and the assistant write this file; you can edit it here too.</span>
                  </div>
                  <CodeEditor value={text} language="yaml" minHeight={460} onChange={editFile} onSave={() => void flush()} />
                </div>
              )}
            </div>
          </div>
          {chat && <Assistant team={team} beforeSend={flush} onSaved={assistantSaved} empty={!!value && !value.exists} />}
        </div>
      </div>
    </>
  );
}

type SetDoc = <K extends keyof Doc>(k: K, v: Doc[K]) => void;

const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="card-pad col" style={{ gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function PageSection({ team, doc, set, media, onMedia }: { team: string; doc: Doc; set: SetDoc; media: Loaded['media']; onMedia: (m: Loaded['media']) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const examples = doc.examples ?? [];
  const [upload, uploading] = useAction(async (files: File[]) => {
    const added: Example[] = [];
    const kept = [...media];
    for (const f of files) {
      try {
        const out = await postRaw<{ file: string; size: number; type: string }>(`/api/market/storefronts/${team}/media?name=${encodeURIComponent(f.name)}`, f);
        kept.push(out);
        added.push({ title: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), file: out.file });
      } catch (err) {
        toast((err as Error).message, true);
      }
    }
    onMedia(kept);
    if (added.length) set('examples', [...examples, ...added]);
    if (input.current) input.current.value = '';
  });
  const edit = (i: number, patch: Partial<Example>) => set('examples', examples.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const unused = media.filter((m) => !examples.some((e) => e.file === m.file));
  return (
    <>
      <Card title="What you offer" hint="The first things a customer reads">
        <label className="field">
          Title
          <input className="input" value={doc.title ?? ''} maxLength={100} placeholder="Reel cutter" onChange={(e) => set('title', e.target.value)} />
        </label>
        <label className="field">
          Summary
          <input className="input" value={doc.summary ?? ''} maxLength={500} placeholder="Send your raw clips and a short brief; get back one vertical reel, ready to post." onChange={(e) => set('summary', e.target.value)} />
          <span className="help">One sentence, shown on the storefront's card.</span>
        </label>
        <label className="field">
          Description
          <textarea className="input" rows={7} value={doc.description ?? ''} maxLength={8000} placeholder="What a customer gets, what they need to send, and how long it takes." onChange={(e) => set('description', e.target.value)} />
          <span className="help">Plain paragraphs; leave an empty line between them.</span>
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          Price per order (NEAR)
          <input className="input" type="number" min={0} step="any" value={doc.price_near ?? ''} onChange={(e) => set('price_near', num(e.target.value))} />
          <span className="help">Held in escrow until the team's checks passed.</span>
        </label>
      </Card>
      <Card title="Showcase" hint="Pictures, videos and files that show what customers get">
        {examples.length > 0 && (
          <div className="sf-examples">
            {examples.map((e, i) => (
              <div key={i} className="sf-example">
                {e.file && (
                  <div className="sf-media">
                    {isImage(e.file) ? (
                      <img src={mediaUrl(team, e.file)} alt="" />
                    ) : isVideo(e.file) ? (
                      <video src={`${mediaUrl(team, e.file)}#t=0.1`} controls playsInline preload="metadata" />
                    ) : (
                      <span className="row small muted">
                        <IconFile width={16} height={16} /> {e.file.split('/').pop()}
                      </span>
                    )}
                  </div>
                )}
                <input className="input" value={e.title} maxLength={100} placeholder="Title" aria-label="Example title" onChange={(ev) => edit(i, { title: ev.target.value })} />
                <textarea className="input" rows={2} value={e.text ?? ''} maxLength={2000} placeholder="What it was and what came out (optional)" aria-label="Example text" onChange={(ev) => edit(i, { text: ev.target.value })} />
                <button className="btn sm ghost" onClick={() => set('examples', examples.filter((_, j) => j !== i))}>
                  <IconX /> Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input ref={input} type="file" hidden multiple accept=".png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov,.mp3,.wav,.m4a,.pdf,.txt" onChange={(e) => void upload([...(e.target.files ?? [])])} />
          <button className="btn" disabled={uploading || examples.length >= 12} onClick={() => input.current?.click()}>
            {uploading ? <IconSpinner /> : <IconPlus />} Add pictures, videos or files
          </button>
          <button className="btn" disabled={examples.length >= 12} onClick={() => set('examples', [...examples, { title: '' }])}>
            <IconPlus /> Add a text example
          </button>
          <span className="small faint">Up to 12; a video or picture up to 60 MB. The first picture or video is the storefront's cover.</span>
        </div>
        {unused.length > 0 && (
          <div className="row small" style={{ flexWrap: 'wrap' }}>
            <span className="faint">In the team folder, not shown:</span>
            {unused.map((m) => (
              <button key={m.file} className="chip" disabled={examples.length >= 12} onClick={() => set('examples', [...examples, { title: m.file.split('/').pop()!.replace(/\.[^.]+$/, ''), file: m.file }])}>
                <IconPlus width={11} height={11} /> {m.file.split('/').pop()}
              </button>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function FormSection({ doc, set }: { doc: Doc; set: SetDoc }) {
  const fields = doc.inputs ?? [];
  const edit = (i: number, patch: Partial<Field>) => set('inputs', fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const freeName = (base: string) => {
    let name = base;
    for (let i = 2; fields.some((f) => f.name === name); i++) name = `${base}_${i}`;
    return name;
  };
  const add = (f: Field) => set('inputs', [...fields, { ...f, name: freeName(f.name) }]);
  const extensions = (v: string) => {
    const list = v.split(/[\s,]+/).filter(Boolean).map((x) => (x.startsWith('.') ? x : `.${x}`).toLowerCase());
    return list.length ? [...new Set(list)] : undefined;
  };
  return (
    <>
      <Card title="What customers send" hint="The order form on your page">
        {fields.map((f, i) => (
          <div key={i} className="sf-field">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field grow">
                Question
                <input className="input" value={f.label ?? ''} maxLength={100} placeholder={f.type === 'files' ? 'Your clips' : 'What do you need?'} onChange={(e) => edit(i, { label: e.target.value })} />
              </label>
              <label className="field" style={{ width: 130 }}>
                Answer
                <select
                  className="input"
                  value={f.type}
                  onChange={(e) => edit(i, e.target.value === 'files' ? { type: 'files', max_chars: undefined } : { type: 'text', accept: undefined, max_files: undefined, folder: undefined })}
                >
                  <option value="text">Text</option>
                  <option value="files">Files</option>
                </select>
              </label>
              <label className="check small" style={{ height: 28 }}>
                <input type="checkbox" checked={!!f.required} onChange={(e) => edit(i, { required: e.target.checked || undefined })} /> Required
              </label>
              <button className="btn icon-btn ghost" aria-label="Remove this question" disabled={fields.length <= 1} title={fields.length <= 1 ? 'An order form needs at least one question' : 'Remove'} onClick={() => set('inputs', fields.filter((_, j) => j !== i))}>
                <IconTrash />
              </button>
            </div>
            {f.type === 'files' ? (
              <>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span className="small muted">Accepts</span>
                  {PRESETS.map((p) => {
                    const on = p.ext.some((x) => f.accept?.includes(x));
                    return (
                      <button key={p.label} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => edit(i, { accept: on ? extensions((f.accept ?? []).filter((x) => !p.ext.includes(x)).join(' ')) : [...new Set([...(f.accept ?? []), ...p.ext])] })}>
                        {p.label}
                      </button>
                    );
                  })}
                  <button className={`chip ${!f.accept ? 'on' : ''}`} aria-pressed={!f.accept} onClick={() => edit(i, { accept: undefined })}>
                    Any file
                  </button>
                </div>
                <div className="grid grid-3">
                  <label className="field">
                    File types
                    <input className="input mono" key={(f.accept ?? []).join(' ')} defaultValue={(f.accept ?? []).join(' ')} placeholder="any" onBlur={(e) => edit(i, { accept: extensions(e.target.value) })} />
                  </label>
                  <label className="field">
                    How many files at most
                    <input className="input" type="number" min={1} max={50} value={f.max_files ?? ''} placeholder="5" onChange={(e) => edit(i, { max_files: num(e.target.value) })} />
                  </label>
                  <label className="field">
                    Folder the team finds them in
                    <input className="input mono" value={f.folder ?? ''} placeholder={f.name} onChange={(e) => edit(i, { folder: e.target.value || undefined })} />
                  </label>
                </div>
              </>
            ) : (
              <label className="field" style={{ maxWidth: 220 }}>
                Longest answer (characters)
                <input className="input" type="number" min={1} value={f.max_chars ?? ''} placeholder="5000" onChange={(e) => edit(i, { max_chars: num(e.target.value) })} />
              </label>
            )}
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 200px' }}>
              <label className="field">
                Hint under the question
                <input className="input" value={f.help ?? ''} maxLength={500} placeholder="Optional" onChange={(e) => edit(i, { help: e.target.value || undefined })} />
              </label>
              <label className="field">
                Name in the order
                <input className="input mono" value={f.name} onChange={(e) => edit(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
              </label>
            </div>
          </div>
        ))}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" disabled={fields.length >= 20} onClick={() => add({ name: 'brief', label: 'What do you need?', type: 'text', required: true })}>
            <IconPlus /> Text question
          </button>
          <button className="btn" disabled={fields.length >= 20} onClick={() => add({ name: 'files', label: 'Your files', type: 'files', max_files: 5 })}>
            <IconPlus /> File upload
          </button>
          <button className="btn" disabled={fields.length >= 20} onClick={() => add({ name: 'footage', label: 'Your clips', type: 'files', accept: PRESETS[0]!.ext, max_files: 5, required: true })}>
            <IconPlus /> Video upload
          </button>
        </div>
      </Card>
      <Card title="Upload limit">
        <label className="field" style={{ maxWidth: 260 }}>
          All files of one order together (MB)
          <input className="input" type="number" min={1} max={20480} value={doc.intake?.max_input_mb ?? ''} placeholder="32" onChange={(e) => set('intake', { ...doc.intake, max_input_mb: num(e.target.value) })} />
          <span className="help">Files are encrypted in the customer's browser and sent in pieces, so video footage is fine: 500 for short clips, 4000 for long ones. Larger orders are turned down before anything is fetched.</span>
        </label>
      </Card>
    </>
  );
}

function DeliverySection({ doc, set, gates }: { doc: Doc; set: SetDoc; gates: string[] }) {
  const required = doc.deliverables?.gates_required ?? [];
  const known = [...new Set([...gates, ...required])];
  return (
    <>
      <Card title="What the team does with an order" hint="Customers do not see this">
        <label className="field">
          Instructions for every order
          <textarea className="input" rows={5} value={doc.goal ?? ''} maxLength={8000} placeholder={`Cut the customer's footage in raw/ into one vertical reel at ${doc.deliverables?.folder || 'out'}/reel.mp4, following their brief in ORDER.md.`} onChange={(e) => set('goal', e.target.value)} />
          <span className="help">The team gets this as its goal, with the customer's order after it as data. ORDER.md in the working folder holds what the customer wrote; each file question's files are in its folder.</span>
        </label>
        <label className="field" style={{ maxWidth: 260 }}>
          Folder that is delivered
          <input className="input mono" value={doc.deliverables?.folder ?? ''} placeholder="out" onChange={(e) => set('deliverables', { ...doc.deliverables, folder: e.target.value })} />
          <span className="help">Every file in it goes to the customer, encrypted: videos, images, documents, of any size. Nothing else leaves your machine.</span>
        </label>
      </Card>
      <Card title="Checks that must pass" hint="Without them nothing is delivered and the customer is refunded">
        {known.length ? (
          <div className="chips">
            {known.map((g) => {
              const on = required.includes(g);
              return (
                <button key={g} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={gates.includes(g) ? undefined : 'The team has no step with this id and a gate'} onClick={() => set('deliverables', { ...doc.deliverables, gates_required: on ? required.filter((x) => x !== g) : [...required, g] })}>
                  {on && <IconCheck width={11} height={11} />} {g}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="banner warn">
            <IconAlert />
            <div>This team has no step with a gate, so nothing decides whether an order passed. Add a review or test step with a gate in the team editor.</div>
          </div>
        )}
        <span className="small faint">These are the team's steps that have a gate. {required.length ? '' : 'With none chosen, every gate of the team must pass.'}</span>
        <label className="field" style={{ maxWidth: 320 }}>
          The team works in
          <select className="input" value={doc.workspace ?? 'folder'} onChange={(e) => set('workspace', e.target.value === 'git' ? 'git' : undefined)}>
            <option value="folder">A plain folder (media, documents)</option>
            <option value="git">A git repository (code)</option>
          </select>
        </label>
      </Card>
    </>
  );
}

function RulesSection({ doc, set }: { doc: Doc; set: SetDoc }) {
  const intake = doc.intake ?? {};
  const mode = intake.mode ?? 'recommend';
  const setIntake = (patch: Partial<NonNullable<Doc['intake']>>) => set('intake', { ...intake, ...patch });
  const setWindow = (patch: Partial<NonNullable<Doc['windows']>>) => set('windows', { ...doc.windows, ...patch });
  const windows = [
    ['accept_min', 'You answer an order within', 60],
    ['delivery_min', 'The team delivers within', 240],
    ['review_min', 'The customer reviews within', 1440],
  ] as const;
  return (
    <>
      <Card title="Who answers an order">
        <div className="seg">
          {(['manual', 'recommend', 'auto'] as const).map((id) => (
            <button key={id} className={mode === id ? 'on' : ''} onClick={() => setIntake({ mode: id })}>
              {id === 'manual' ? 'I do' : id === 'recommend' ? 'An agent suggests, I confirm' : 'An agent, alone'}
            </button>
          ))}
        </div>
        <span className="small muted">
          {mode === 'manual'
            ? 'Every order waits for your accept or decline.'
            : mode === 'recommend'
              ? 'An intake agent with no tools reads each order as data and recommends; you decide.'
              : 'The intake agent accepts when every rule below passed and the order clearly fits, declines when it says so, and asks you otherwise. Failed checks refund the customer without waiting for you.'}
        </span>
        <label className="field">
          What this team takes, and what it does not
          <textarea className="input" rows={4} value={intake.policy ?? ''} maxLength={4000} placeholder="Short reels from the customer's own footage only. No footage of other people's copyrighted films, nothing sexual or violent." onChange={(e) => setIntake({ policy: e.target.value })} />
          <span className="help">The intake agent judges orders by this.</span>
        </label>
        {mode === 'auto' && (
          <label className="field" style={{ maxWidth: 260 }}>
            Accept alone from a fit of
            <input className="input" type="number" min={0} max={1} step={0.05} value={intake.auto_min_fit ?? ''} placeholder="0.8" onChange={(e) => setIntake({ auto_min_fit: num(e.target.value) })} />
            <span className="help">0 to 1: how well the order matches what you offer.</span>
          </label>
        )}
      </Card>
      <Card title="Money" hint="Rules covibe enforces before any model sees an order">
        <div className="grid grid-3">
          <label className="field">
            Spend cap per order (USD)
            <input className="input" type="number" min={0} step="any" value={intake.budget_cap_usd ?? ''} placeholder="5" onChange={(e) => setIntake({ budget_cap_usd: num(e.target.value) })} />
            <span className="help">The team's run stops here and the order comes to you.</span>
          </label>
          <label className="field">
            Usual cost of a run (USD)
            <input className="input" type="number" min={0} step="any" value={intake.estimated_cost_usd ?? ''} placeholder="Optional" onChange={(e) => setIntake({ estimated_cost_usd: num(e.target.value) })} />
            <span className="help">Compared with the cap, together with past runs.</span>
          </label>
          <label className="field">
            Lowest price taken (NEAR)
            <input className="input" type="number" min={0} step="any" value={intake.min_price_near ?? ''} placeholder="0" onChange={(e) => setIntake({ min_price_near: num(e.target.value) })} />
            <span className="help">Orders placed at an older, lower price are turned down.</span>
          </label>
        </div>
      </Card>
      <Card title="Time" hint="A missed deadline refunds the customer">
        <div className="grid grid-3">
          {windows.map(([key, label, fallback]) => (
            <label key={key} className="field">
              {label} (minutes)
              <input className="input" type="number" min={0.5} max={43200} step="any" value={doc.windows?.[key] ?? ''} placeholder={String(fallback)} onChange={(e) => setWindow({ [key]: num(e.target.value) })} />
              <span className="help">{span(doc.windows?.[key] ?? fallback)}</span>
            </label>
          ))}
        </div>
      </Card>
      <Card title="Privacy note" hint="What customers are told about who sees their order">
        <textarea
          className="input"
          rows={3}
          aria-label="Privacy note"
          value={doc.privacy ?? ''}
          maxLength={2000}
          placeholder="Your order is encrypted in your browser and only the team owner can open it. To do the work, the owner and the AI model provider the owner uses will see what you send. (Shown when you leave this empty.)"
          onChange={(e) => set('privacy', e.target.value || undefined)}
        />
      </Card>
    </>
  );
}

// ---- the assistant

const STARTERS = ['Set this storefront up from what the team does', 'Customers send video clips and get an edited video back', 'Write the title, summary and description for me', 'Is everything ready to publish?'];

const TOOLS: Record<string, string> = { get_storefront: 'reading the storefront and the team', save_storefront: 'saving the storefront' };

function Assistant({ team, beforeSend, onSaved, empty }: { team: string; beforeSend: () => Promise<void>; onSaved: () => Promise<void>; empty: boolean }) {
  const run = useRef<string | null>(null);
  const [text, setText] = useState('');
  // "New chat": the next message starts a conversation of its own.
  const [fresh, setFresh] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const { value: chat, reload } = useLive(
    () => get<Chat>(`/api/market/storefronts/${team}/assistant`),
    [team],
    (e) => e.projectId === '_library' && e.event.runId === run.current,
  );
  run.current = chat?.runId ?? run.current;
  // Saves made while this page is open are shown in the form; the ones from earlier visits are in the file already.
  const seen = useRef<string | undefined>(undefined);
  const last = chat?.saves.filter((s) => s.valid).at(-1)?.ts;
  useEffect(() => {
    if (!chat) return;
    if (seen.current !== undefined && last && last !== seen.current) void onSaved();
    seen.current = last ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, !chat]);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [chat?.thread.length, chat?.busy]);

  const [send, sending] = useAction(async (message: string) => {
    if (!message.trim()) return;
    setText('');
    await beforeSend();
    const out = await post<{ runId: string }>(`/api/market/storefronts/${team}/assistant`, { message, ...(fresh ? { fresh: true } : {}) });
    run.current = out.runId;
    setFresh(false);
    await reload();
  });
  const busy = sending || !!chat?.busy;
  const items = fresh ? [] : (chat?.thread ?? []);
  return (
    <aside className="helper-drawer sf-chat" aria-label="Storefront assistant">
      <div className="sf-chat-head">
        <IconChat width={14} height={14} />
        <strong className="grow">Assistant</strong>
        {items.length > 0 && (
          <button className="btn sm ghost" disabled={busy} title="Start a new conversation. The storefront stays as it is." onClick={() => setFresh(true)}>
            New chat
          </button>
        )}
      </div>
      <div className="thread">
        {!items.length && (
          <div className="col" style={{ gap: 10, margin: 'auto 0' }}>
            <p className="small muted" style={{ textAlign: 'center' }}>
              {empty ? 'Say what you want to sell. ' : ''}The assistant reads the team, asks what is unclear, and fills in the page, the order form and the rules. You can change everything in the form afterwards, and nothing is public until you publish.
            </p>
            <div className="col" style={{ gap: 6, alignItems: 'center' }}>
              {STARTERS.map((s) => (
                <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it) =>
          it.kind === 'human' ? (
            <div key={it.id} className="msg human">
              {it.text}
            </div>
          ) : it.kind === 'agent' ? (
            <div key={it.id} className="msg agent helper-text" style={{ whiteSpace: 'normal' }}>
              <Markdown text={it.text} />
            </div>
          ) : it.kind === 'tool' ? (
            <div key={it.id} className="tools-line">
              · {TOOLS[it.text.replace(/^mcp__covibe__/, '').split(/[\s(]/)[0]!] ?? it.text.replace(/^mcp__covibe__/, '')}
            </div>
          ) : (
            <div key={it.id} className={`note-line ${it.kind === 'error' ? 'error' : ''}`}>
              {it.text}
            </div>
          ),
        )}
        {busy && (
          <div className="note-line row" style={{ gap: 6 }}>
            <IconSpinner width={12} height={12} /> The assistant is working…
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <div className="box">
          <textarea
            value={text}
            rows={2}
            placeholder={items.length ? 'Ask for changes, e.g. "make it cheaper" or "customers also send a logo"' : 'What do you want to sell?'}
            aria-label="Message to the assistant"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!busy) void send(text);
              }
            }}
          />
          <MicButton onText={(spoken) => setText((prev) => withSpoken(prev, spoken))} />
          <button className="btn primary icon-btn" style={{ borderRadius: 14 }} disabled={!text.trim() || busy} onClick={() => void send(text)} aria-label="Send">
            <IconSend />
          </button>
        </div>
        {chat && chat.costUsd > 0 && <span className="mode">This conversation so far: {money(chat.costUsd)} (estimate)</span>}
      </div>
    </aside>
  );
}
