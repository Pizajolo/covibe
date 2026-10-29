import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { useLive } from '../data';
import { IconAlert, IconCheck } from './icons';
import { useAction, useToast } from './ui';

type Engine = 'local' | 'openai' | 'elevenlabs';

interface VoiceStatus {
  settings: { engine: Engine; language: string; model: string; whisperPath?: string; openaiConnection?: string; openaiModel?: string };
  local: {
    command?: string;
    models: { id: string; file: string; mb: number; note: string; downloaded: boolean }[];
    download?: { model: string; received: number; total?: number; error?: string; done?: boolean };
  };
  openai: { hasKey: boolean; connections: { id: string; label: string; baseUrl?: string; hasKey: boolean }[] };
  elevenlabs: { hasKey: boolean; fromPlugin?: string };
  ready: boolean;
  problem?: string;
}

const LANGUAGES: [string, string][] = [
  ['auto', 'Detect it'],
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pt', 'Portuguese'],
  ['pl', 'Polish'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
];

/** Settings → Voice input: which engine turns what you say into the mic button into text. */
export function VoiceSettings() {
  const toast = useToast();
  const { value, setValue, reload } = useLive(() => get<VoiceStatus>('/api/voice'), []);
  const [keys, setKeys] = useState({ openai: '', elevenlabs: '' });
  const [path, setPath] = useState<string | null>(null);
  const downloading = !!value?.local.download && !value.local.download.done && !value.local.download.error;
  useEffect(() => {
    if (!downloading) return;
    const t = window.setInterval(() => void reload(), 1000);
    return () => window.clearInterval(t);
  }, [downloading, reload]);

  const [save] = useAction(async (patch: Record<string, unknown>, message: string = 'Saved') => {
    setValue(await put<VoiceStatus>('/api/voice', patch));
    toast(message);
  });
  const [download] = useAction(async (id: string) => setValue(await post<VoiceStatus>(`/api/voice/models/${id}`)));
  const [remove] = useAction(async (id: string) => setValue(await del<VoiceStatus>(`/api/voice/models/${id}`)));
  if (!value) return null;
  const s = value.settings;
  const dl = value.local.download;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Voice input</h2>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <span className="small">
          The mic button next to the goal box and every chat turns what you say into text. Click it, talk, click again; Esc throws the recording away. Dictation apps such as
          Wispr Flow or macOS dictation work in every text box too.
        </span>
        <div className={`banner small ${value.ready ? 'good' : 'warn'}`}>
          {value.ready ? <IconCheck /> : <IconAlert />}
          <span>{value.ready ? `Ready: ${s.engine === 'local' ? `whisper.cpp with the ${s.model} model, on this Mac` : s.engine === 'openai' ? 'OpenAI' : 'ElevenLabs'}` : value.problem}</span>
        </div>

        <div className="col" style={{ gap: 6 }}>
          {(
            [
              ['local', 'On this Mac with whisper.cpp', 'Free and private: nothing leaves this computer. Needs whisper.cpp and a model download.'],
              ['openai', 'OpenAI', 'Sends the recording to OpenAI (or another OpenAI-compatible provider, such as Groq).'],
              ['elevenlabs', 'ElevenLabs', "Sends the recording to ElevenLabs' Scribe."],
            ] as const
          ).map(([id, label, help]) => (
            <label key={id} className="check">
              <input type="radio" name="voice-engine" checked={s.engine === id} onChange={() => void save({ engine: id }, `Voice input uses ${label}`)} />
              <span>
                {label} <span className="tiny faint">· {help}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="field" style={{ maxWidth: 260 }}>
          Language you speak
          <select className="input" value={s.language} onChange={(e) => void save({ language: e.target.value })}>
            {LANGUAGES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
            {!LANGUAGES.some(([id]) => id === s.language) && <option value={s.language}>{s.language}</option>}
          </select>
          <span className="help">Saying which makes short recordings more accurate.</span>
        </label>

        {s.engine === 'local' && (
          <section className="form-section col" style={{ gap: 10 }}>
            <h3 className="small">whisper.cpp</h3>
            {value.local.command ? (
              <span className="small">
                Found at <span className="mono">{value.local.command}</span>
              </span>
            ) : (
              <span className="small">
                Not installed. In Terminal: <span className="mono">brew install whisper-cpp</span>, or set where its <span className="mono">whisper-cli</span> is:
              </span>
            )}
            <div className="row" style={{ maxWidth: 520 }}>
              <input className="input mono grow" value={path ?? s.whisperPath ?? ''} placeholder="Found on the PATH and in Homebrew's folders when empty" onChange={(e) => setPath(e.target.value)} />
              <button className="btn sm" disabled={path === null} onClick={() => void save({ whisperPath: path ?? '' }).then(() => setPath(null))}>
                Save
              </button>
            </div>
            <div className="list">
              {value.local.models.map((m) => {
                const here = dl?.model === m.id && !dl.done;
                return (
                  <div key={m.id} className="list-row">
                    <input type="radio" name="voice-model" checked={s.model === m.id} onChange={() => void save({ model: m.id })} aria-label={`Use ${m.id}`} />
                    <div className="grow col" style={{ gap: 2 }}>
                      <span className="small">
                        <strong className="mono">{m.id}</strong> <span className="faint">· {m.mb} MB</span>
                      </span>
                      <span className="tiny faint">
                        {here && dl?.error ? <span style={{ color: 'var(--bad)' }}>Download failed: {dl.error}</span> : here ? `Downloading… ${progress(dl!)}` : m.note}
                      </span>
                    </div>
                    {m.downloaded ? (
                      <button className="btn sm ghost" onClick={() => void remove(m.id)}>
                        Delete
                      </button>
                    ) : (
                      <button className="btn sm" disabled={downloading} onClick={() => void download(m.id)}>
                        {here && !dl?.error ? 'Downloading…' : 'Download'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <span className="help tiny faint">
              base is quick on any Mac. small understands German, French and other languages clearly better and is still fast on Apple silicon; large-v3-turbo is the most
              accurate. Models are kept in covibe's folder under voice/models.
            </span>
          </section>
        )}

        {s.engine === 'openai' && (
          <section className="form-section col" style={{ gap: 10 }}>
            <h3 className="small">OpenAI</h3>
            <label className="field" style={{ maxWidth: 420 }}>
              Key
              <select className="input" value={s.openaiConnection ?? ''} onChange={(e) => void save({ openaiConnection: e.target.value })}>
                <option value="">A key just for voice input{value.openai.hasKey ? ' (saved)' : ''}</option>
                {value.openai.connections.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.hasKey}>
                    Model provider: {c.label}
                    {c.baseUrl ? ` (${new URL(c.baseUrl).host})` : ''}
                    {c.hasKey ? '' : ', no key'}
                  </option>
                ))}
              </select>
              <span className="help">Model providers come from Advanced → Model providers below. Groq's OpenAI-compatible API works too.</span>
            </label>
            {!s.openaiConnection && (
              <KeyField
                label="OpenAI API key"
                saved={value.openai.hasKey}
                value={keys.openai}
                onChange={(v) => setKeys({ ...keys, openai: v })}
                onSave={() => void save({ openaiKey: keys.openai }, 'OpenAI key saved').then(() => setKeys({ ...keys, openai: '' }))}
                onRemove={() => void save({ openaiKey: null }, 'OpenAI key removed')}
              />
            )}
            <label className="field" style={{ maxWidth: 320 }}>
              Model
              <input className="input mono" defaultValue={s.openaiModel ?? ''} placeholder="gpt-4o-mini-transcribe (whisper-large-v3-turbo on Groq)" onBlur={(e) => e.target.value !== (s.openaiModel ?? '') && void save({ openaiModel: e.target.value })} />
            </label>
          </section>
        )}

        {s.engine === 'elevenlabs' && (
          <section className="form-section col" style={{ gap: 10 }}>
            <h3 className="small">ElevenLabs</h3>
            {value.elevenlabs.fromPlugin && !value.elevenlabs.hasKey && (
              <span className="small">
                Uses the ELEVENLABS_API_KEY saved for the <span className="mono">{value.elevenlabs.fromPlugin}</span> plugin. Enter one here to use another.
              </span>
            )}
            <KeyField
              label="ElevenLabs API key"
              saved={value.elevenlabs.hasKey}
              value={keys.elevenlabs}
              onChange={(v) => setKeys({ ...keys, elevenlabs: v })}
              onSave={() => void save({ elevenlabsKey: keys.elevenlabs }, 'ElevenLabs key saved').then(() => setKeys({ ...keys, elevenlabs: '' }))}
              onRemove={() => void save({ elevenlabsKey: null }, 'ElevenLabs key removed')}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function KeyField({ label, saved, value, onChange, onSave, onRemove }: { label: string; saved: boolean; value: string; onChange: (v: string) => void; onSave: () => void; onRemove: () => void }) {
  return (
    <div className="field" style={{ maxWidth: 520 }}>
      {label}
      <div className="row">
        <input className="input mono grow" type="password" value={value} placeholder={saved ? 'Saved: enter a new one to replace it' : 'Not set'} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSave()} />
        <button className="btn sm primary" disabled={!value.trim()} onClick={onSave}>
          Save
        </button>
        {saved && (
          <button className="btn sm ghost" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <span className="help">Kept with covibe's other keys.</span>
    </div>
  );
}

function progress(d: { received: number; total?: number }): string {
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return d.total ? `${mb(d.received)} of ${mb(d.total)} (${Math.floor((d.received / d.total) * 100)}%)` : mb(d.received);
}
