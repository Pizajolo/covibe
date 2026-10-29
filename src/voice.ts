// Voice input: what you say into the mic button becomes text in the box you
// are typing in (a goal, a chat message). The app records 16 kHz mono WAV and
// sends it here; one of three engines turns it into text:
//
//   local       whisper.cpp on this computer (whisper-cli, `brew install whisper-cpp`),
//               with a model covibe downloads to ~/.covibe/voice/models/. Nothing leaves the Mac.
//   openai      OpenAI's transcription API (or another OpenAI-compatible one, such as Groq),
//               with a model provider from Settings → Advanced or a key of its own.
//   elevenlabs  ElevenLabs' Scribe, with a key of its own or the one saved for an ElevenLabs plugin.
//
// While you talk, the app sends each stretch of speech as soon as you pause, so
// the text appears a moment after you say it. A recording is a session: for the
// local engine it starts whisper.cpp's server (whisper-server), which keeps the
// model loaded until the recording ends, instead of loading it for every piece.
//
// Settings are in ~/.covibe/voice.json; keys are with covibe's other keys.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { pluginKeys } from './connections/plugin-keys.js';
import type { SecretStore } from './connections/secrets.js';
import type { Connection } from './connections/types.js';
import { listPlugins } from './plugins.js';

export class VoiceError extends Error {}

export type VoiceEngine = 'local' | 'openai' | 'elevenlabs';

export interface VoiceSettings {
  engine: VoiceEngine;
  /** Spoken language as an ISO code ("en", "de"), or "auto". */
  language: string;
  /** local: which whisper.cpp model. */
  model: string;
  /** local: whisper.cpp's command, when it is not on the PATH. */
  whisperPath?: string;
  /** openai: a model provider from Settings → Advanced to use (its key and address); otherwise the key saved here. */
  openaiConnection?: string;
  /** openai: the transcription model; defaults to one that suits the provider. */
  openaiModel?: string;
}

export interface WhisperModel {
  id: string;
  file: string;
  /** Approximate download size in MB. */
  mb: number;
  note: string;
}

/** whisper.cpp's models (ggml), smallest first. Multilingual: each also understands languages other than English. */
export const WHISPER_MODELS: WhisperModel[] = [
  { id: 'tiny', file: 'ggml-tiny.bin', mb: 75, note: 'Fastest; makes the most mistakes' },
  { id: 'base', file: 'ggml-base.bin', mb: 142, note: 'Fast on any Mac; good for clear English' },
  { id: 'small', file: 'ggml-small.bin', mb: 466, note: 'Clearly better, especially in other languages; still quick on Apple silicon' },
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547, note: 'Best; wants Apple silicon (a few seconds per minute of speech)' },
];

const DEFAULTS: VoiceSettings = { engine: 'local', language: 'auto', model: 'base' };
const OPENAI = 'https://api.openai.com/v1';
const ELEVENLABS = 'https://api.elevenlabs.io/v1';
const MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
/** whisper.cpp's command over the years (brew installs whisper-cli; older formulas whisper-cpp). */
const WHISPER_COMMANDS = ['whisper-cli', 'whisper-cpp'];
/** whisper.cpp's server, which keeps a model loaded (brew installs it with whisper-cli). */
const SERVER_COMMANDS = ['whisper-server'];
/** Where Homebrew puts commands; apps started from Finder may not have them on the PATH. */
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];
/** A session the app stopped using (closed without saying so) ends after this long. */
const SESSION_IDLE = 2 * 60_000;
/** How long whisper-server may take to load its model. */
const SERVER_LOAD = 90_000;

/** whisper-servers still running, stopped if covibe exits without closing their sessions. */
const running = new Set<ChildProcess>();
let exitHook = false;

/** One recording: for the local engine, a whisper-server with the model loaded. */
interface Session {
  id: string;
  engine: VoiceEngine;
  /** local: the server's address once its model is loaded, or undefined when there is none (whisper-cli does each piece then). */
  server?: Promise<string | undefined>;
  proc?: ChildProcess;
  closed: boolean;
  idle?: NodeJS.Timeout;
}

export interface VoiceStatus {
  settings: VoiceSettings;
  local: {
    /** whisper.cpp's command, if found. */
    command?: string;
    /** whisper.cpp's server, if found: it keeps the model loaded while you talk. */
    server?: string;
    models: (WhisperModel & { downloaded: boolean })[];
    download?: { model: string; received: number; total?: number; error?: string; done?: boolean };
  };
  openai: {
    /** A key is saved here. */
    hasKey: boolean;
    /** Model providers of the OpenAI kind it can use instead. */
    connections: { id: string; label: string; baseUrl?: string; hasKey: boolean }[];
  };
  elevenlabs: {
    hasKey: boolean;
    /** A plugin whose saved ELEVENLABS_API_KEY it can use. */
    fromPlugin?: string;
  };
  /** Whether the chosen engine can transcribe now, and if not, why. */
  ready: boolean;
  problem?: string;
}

/** What Voice needs of Settings → Advanced: the model providers and their keys. */
export interface ConnectionSource {
  list(): Connection[];
  key(id: string): string | undefined;
}

export interface VoiceOptions {
  /** Where to fetch models, and the APIs (tests point these at fakes). */
  modelsBase?: string;
  openaiBase?: string;
  elevenlabsBase?: string;
}

export class Voice {
  private readonly file: string;
  private readonly modelsDir: string;
  private download?: NonNullable<VoiceStatus['local']['download']>;
  private readonly sessions = new Map<string, Session>();

  constructor(
    readonly home: string,
    private readonly secrets: SecretStore,
    private readonly connections: ConnectionSource,
    private readonly opts: VoiceOptions = {},
  ) {
    this.file = join(home, 'voice.json');
    this.modelsDir = join(home, 'voice', 'models');
  }

  settings(): VoiceSettings {
    try {
      return { ...DEFAULTS, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<VoiceSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** Change settings; keys go to the secret store (null or "" removes one). */
  update(patch: Partial<VoiceSettings> & { openaiKey?: string | null; elevenlabsKey?: string | null }): VoiceStatus {
    const next = { ...this.settings() };
    if (patch.engine !== undefined) {
      if (!['local', 'openai', 'elevenlabs'].includes(patch.engine)) throw new VoiceError(`unknown engine "${patch.engine}"`);
      next.engine = patch.engine;
    }
    if (patch.language !== undefined) {
      const l = patch.language.trim().toLowerCase() || 'auto';
      if (l !== 'auto' && !/^[a-z]{2,3}$/.test(l)) throw new VoiceError('the language is a code like "en" or "de", or "auto"');
      next.language = l;
    }
    if (patch.model !== undefined) {
      if (!WHISPER_MODELS.some((m) => m.id === patch.model)) throw new VoiceError(`unknown whisper.cpp model "${patch.model}"`);
      next.model = patch.model;
    }
    if (patch.whisperPath !== undefined) next.whisperPath = patch.whisperPath.trim() || undefined;
    if (patch.openaiConnection !== undefined) {
      const id = patch.openaiConnection.trim();
      if (id && this.connections.list().find((c) => c.id === id)?.kind !== 'openai') throw new VoiceError(`"${id}" is not an OpenAI-compatible model provider in Settings → Advanced`);
      next.openaiConnection = id || undefined;
    }
    if (patch.openaiModel !== undefined) next.openaiModel = patch.openaiModel.trim() || undefined;
    for (const [field, id] of [['openaiKey', 'voice.openai'], ['elevenlabsKey', 'voice.elevenlabs']] as const) {
      const v = patch[field];
      if (v === undefined) continue;
      if (v === null || !v.trim()) this.secrets.delete(id);
      else this.secrets.set(id, v.trim());
    }
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n');
    return this.status();
  }

  status(): VoiceStatus {
    const settings = this.settings();
    const command = this.whisperCommand(settings);
    const server = command ? this.serverCommand(settings, command) : undefined;
    const eleven = this.elevenlabsKey();
    const status: VoiceStatus = {
      settings,
      local: {
        command,
        ...(server ? { server } : {}),
        models: WHISPER_MODELS.map((m) => ({ ...m, downloaded: existsSync(join(this.modelsDir, m.file)) })),
        ...(this.download ? { download: { ...this.download } } : {}),
      },
      openai: {
        hasKey: !!this.secrets.get('voice.openai'),
        connections: this.connections
          .list()
          .filter((c) => c.kind === 'openai')
          .map((c) => ({ id: c.id, label: c.label, baseUrl: c.baseUrl, hasKey: !!this.connections.key(c.id) })),
      },
      elevenlabs: { hasKey: !!this.secrets.get('voice.elevenlabs'), ...(eleven?.from ? { fromPlugin: eleven.from } : {}) },
      ready: false,
    };
    const problem = this.problem(settings, status);
    return { ...status, ready: !problem, ...(problem ? { problem } : {}) };
  }

  private problem(s: VoiceSettings, st: VoiceStatus): string | undefined {
    if (s.engine === 'local') {
      if (!st.local.command) return 'whisper.cpp is not installed: run `brew install whisper-cpp` (or set where it is in Settings → Voice input)';
      if (!st.local.models.find((m) => m.id === s.model)?.downloaded) return `the ${s.model} model is not downloaded yet: download it in Settings → Voice input`;
      return undefined;
    }
    if (s.engine === 'openai') return this.openai(s) ? undefined : 'no OpenAI key: add one in Settings → Voice input, or choose a model provider that has one';
    return this.elevenlabsKey() ? undefined : 'no ElevenLabs key: add one in Settings → Voice input';
  }

  /** whisper.cpp's command: the one you set, or the first found on the PATH or in Homebrew's folders. */
  private whisperCommand(s: VoiceSettings): string | undefined {
    if (s.whisperPath) return isAbsolute(s.whisperPath) && existsSync(s.whisperPath) ? s.whisperPath : undefined;
    return findCommand(WHISPER_COMMANDS);
  }

  /** whisper-server: next to whisper.cpp's command, or on the PATH or in Homebrew's folders. */
  private serverCommand(s: VoiceSettings, command: string): string | undefined {
    const beside = join(dirname(command), SERVER_COMMANDS[0]!);
    if (existsSync(beside)) return beside;
    return s.whisperPath ? undefined : findCommand(SERVER_COMMANDS);
  }

  private openai(s: VoiceSettings): { base: string; key: string; model: string } | undefined {
    const conn = s.openaiConnection ? this.connections.list().find((c) => c.id === s.openaiConnection) : undefined;
    const base = (conn?.baseUrl ?? this.opts.openaiBase ?? OPENAI).replace(/\/+$/, '');
    const key = conn ? this.connections.key(conn.id) : this.secrets.get('voice.openai');
    if (!key) return undefined;
    const model = s.openaiModel || (/groq\.com/.test(base) ? 'whisper-large-v3-turbo' : /openai\.com/.test(base) || !conn ? 'gpt-4o-mini-transcribe' : 'whisper-1');
    return { base, key, model };
  }

  /** The ElevenLabs key: the one saved here, or one saved for a plugin (as ELEVENLABS_API_KEY). */
  private elevenlabsKey(): { key: string; from?: string } | undefined {
    const own = this.secrets.get('voice.elevenlabs');
    if (own) return { key: own };
    for (const p of listPlugins()) {
      if (!p.variables.some((v) => v.name === 'ELEVENLABS_API_KEY' && v.saved)) continue;
      const key = pluginKeys(p.name).ELEVENLABS_API_KEY;
      if (key) return { key, from: p.name };
    }
    return undefined;
  }

  // ---------------------------------------------------------------- models

  /** Start downloading a whisper.cpp model (one at a time); status() shows how far it is. */
  startDownload(id: string): VoiceStatus {
    const model = WHISPER_MODELS.find((m) => m.id === id);
    if (!model) throw new VoiceError(`unknown whisper.cpp model "${id}"`);
    if (this.download && !this.download.done && !this.download.error) throw new VoiceError(`the ${this.download.model} model is still downloading`);
    const state = { model: id, received: 0 } as NonNullable<VoiceStatus['local']['download']>;
    this.download = state;
    void this.fetchModel(model, state).catch((err: Error) => (state.error = err.message));
    return this.status();
  }

  private async fetchModel(model: WhisperModel, state: NonNullable<VoiceStatus['local']['download']>) {
    mkdirSync(this.modelsDir, { recursive: true });
    const dest = join(this.modelsDir, model.file);
    const part = `${dest}.part`;
    const res = await fetch(`${(this.opts.modelsBase ?? process.env.COVIBE_WHISPER_MODELS ?? MODELS).replace(/\/+$/, '')}/${model.file}`, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new VoiceError(`could not download ${model.file}: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length')) || undefined;
    state.total = total;
    const body = Readable.fromWeb(res.body as WebStream);
    body.on('data', (c: Buffer) => (state.received += c.length));
    try {
      await pipeline(body, createWriteStream(part));
      if (total && statSync(part).size !== total) throw new VoiceError(`the download of ${model.file} was cut short; try again`);
      renameSync(part, dest);
      state.done = true;
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
  }

  deleteModel(id: string): VoiceStatus {
    const model = WHISPER_MODELS.find((m) => m.id === id);
    if (!model) throw new VoiceError(`unknown whisper.cpp model "${id}"`);
    rmSync(join(this.modelsDir, model.file), { force: true });
    return this.status();
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Start a recording: with the local engine, whisper-server begins loading the
   * model now (it is ready by the time you pause) and keeps it loaded until
   * closeSession. Pieces sent before it is ready wait for it.
   */
  openSession(): { id: string; engine: VoiceEngine } {
    const s = this.settings();
    const st = this.status();
    if (st.problem) throw new VoiceError(st.problem);
    const session: Session = { id: randomBytes(9).toString('hex'), engine: s.engine, closed: false };
    if (s.engine === 'local' && st.local.server) {
      const model = join(this.modelsDir, WHISPER_MODELS.find((m) => m.id === s.model)!.file);
      session.server = this.serve(session, st.local.server, model, s).catch(() => undefined);
    }
    this.sessions.set(session.id, session);
    this.touch(session);
    return { id: session.id, engine: session.engine };
  }

  /** End a recording: its whisper-server stops and the model is unloaded. */
  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.closed = true;
    clearTimeout(session.idle);
    stopServer(session);
  }

  /** Stop every session (covibe is closing). */
  close(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  private touch(session: Session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => this.closeSession(session.id), SESSION_IDLE);
    session.idle.unref();
  }

  /** Start whisper-server on a free port and wait until its model is loaded; its address, or undefined if it did not come up. */
  private async serve(session: Session, command: string, model: string, s: VoiceSettings): Promise<string | undefined> {
    const port = await freePort();
    if (session.closed) return undefined;
    const proc = spawn(command, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', threads(), '-l', s.language || 'auto'], { stdio: 'ignore' });
    session.proc = proc;
    running.add(proc);
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => running.forEach((p) => p.kill()));
    }
    let dead = false;
    proc.once('error', () => (dead = true));
    proc.once('exit', () => ((dead = true), running.delete(proc)));
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + SERVER_LOAD;
    while (!dead && !session.closed && Date.now() < deadline) {
      try {
        // Newer servers answer 503 while the model loads; older ones only listen once it is loaded (and have no /health).
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel();
        if (res.status !== 503) return base;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    stopServer(session);
    return undefined;
  }

  // ---------------------------------------------------------------- transcribing

  /**
   * Turn a recording, or one piece of it (16 kHz mono WAV from the app), into
   * text with the chosen engine. With a session, the local engine uses that
   * session's loaded model.
   */
  async transcribe(audio: Buffer, sessionId?: string): Promise<{ text: string; engine: VoiceEngine }> {
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new VoiceError('the recording is not a WAV file');
    const s = this.settings();
    const st = this.status();
    if (st.problem) throw new VoiceError(st.problem);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) this.touch(session);
    const text =
      s.engine === 'local' ? await this.localPiece(audio, s, st.local.command!, session) : s.engine === 'openai' ? await this.remoteOpenai(audio, s) : await this.remoteElevenlabs(audio, s);
    return { text: tidy(text), engine: s.engine };
  }

  /** With the session's whisper-server if it has one; whisper-cli otherwise, or when the server fails. */
  private async localPiece(audio: Buffer, s: VoiceSettings, command: string, session?: Session): Promise<string> {
    const base = session?.engine === 'local' ? await session.server : undefined;
    if (base && session && !session.closed) {
      try {
        return await this.viaServer(base, audio, s);
      } catch {
        stopServer(session);
        session.server = Promise.resolve(undefined);
      }
    }
    return this.local(audio, s, command);
  }

  private async viaServer(base: string, audio: Buffer, s: VoiceSettings): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('language', s.language || 'auto');
    const res = await fetch(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(5 * 60_000) });
    return textOf(res, 'whisper.cpp');
  }

  private async local(audio: Buffer, s: VoiceSettings, command: string): Promise<string> {
    const model = join(this.modelsDir, WHISPER_MODELS.find((m) => m.id === s.model)!.file);
    const dir = mkdtempSync(join(tmpdir(), 'covibe-voice-'));
    try {
      const wav = join(dir, 'speech.wav');
      writeFileSync(wav, audio);
      const out = await new Promise<string>((resolve, reject) =>
        execFile(command, ['-m', model, '-f', wav, '-l', s.language || 'auto', '-t', threads(), '-nt', '-np'], { timeout: 5 * 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
          if (err) reject(new VoiceError(`whisper.cpp failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
          else resolve(stdout);
        }),
      );
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async remoteOpenai(audio: Buffer, s: VoiceSettings): Promise<string> {
    const o = this.openai(s)!;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', o.model);
    if (s.language && s.language !== 'auto') form.append('language', s.language);
    const res = await fetch(`${o.base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${o.key}` }, body: form, signal: AbortSignal.timeout(120_000) });
    return textOf(res, 'OpenAI');
  }

  private async remoteElevenlabs(audio: Buffer, s: VoiceSettings): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model_id', 'scribe_v1');
    form.append('tag_audio_events', 'false');
    if (s.language && s.language !== 'auto') form.append('language_code', s.language);
    const base = (this.opts.elevenlabsBase ?? ELEVENLABS).replace(/\/+$/, '');
    const res = await fetch(`${base}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': this.elevenlabsKey()!.key }, body: form, signal: AbortSignal.timeout(120_000) });
    return textOf(res, 'ElevenLabs');
  }
}

/** The first of these commands on the PATH or in Homebrew's folders. */
function findCommand(names: string[]): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_PATHS].filter(Boolean);
  for (const name of names) {
    for (const d of dirs) {
      const p = join(d, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** How many threads whisper.cpp may use: all cores but one, at most 8. */
function threads(): string {
  return String(Math.max(1, Math.min(8, availableParallelism() - 1)));
}

function stopServer(session: Session) {
  if (session.proc && session.proc.exitCode === null) session.proc.kill();
  session.proc = undefined;
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function textOf(res: Response, who: string): Promise<string> {
  const body = await res.text();
  if (!res.ok) {
    let message = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: { message?: string } | string };
      const e = j.error ?? j.detail;
      message = typeof e === 'string' ? e : (e?.message ?? message);
    } catch {
      // not JSON
    }
    throw new VoiceError(`${who} could not transcribe it (${res.status}): ${message}`);
  }
  try {
    return String((JSON.parse(body) as { text?: unknown }).text ?? '');
  } catch {
    throw new VoiceError(`${who} sent an answer covibe cannot read`);
  }
}

/** One line of text: whisper.cpp's line breaks and markers for silence or noise ("[BLANK_AUDIO]", "(music)") taken out. */
export function tidy(text: string): string {
  return text
    .replace(/\[[A-Z_ ]+\]|\((?:silence|music|noise|applause|laughter|inaudible)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
