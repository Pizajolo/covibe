import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecrets } from '../src/connections/secrets.js';
import type { Connection } from '../src/connections/types.js';
import { addMcpServer, deletePlugin } from '../src/plugins.js';
import { tidy, Voice } from '../src/voice.js';
import { tempDir } from './helpers.js';

/** A tiny 16 kHz mono WAV: what the app's mic button sends. */
function wav(samples = 1600): Buffer {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

async function serve(handler: (req: IncomingMessage, body: Buffer) => { status?: number; body: string | Buffer; headers?: Record<string, string> }) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = handler(req, Buffer.concat(chunks));
    res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'application/json' });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function setup(connections: Connection[] = [], keys: Record<string, string> = {}, opts = {}) {
  const home = tempDir('covibe-voice-');
  const secrets = new FileSecrets(home);
  for (const [k, v] of Object.entries(keys)) secrets.set(k, v);
  const voice = new Voice(home, secrets, { list: () => connections, key: (id) => secrets.get(id) }, opts);
  return { home, secrets, voice };
}

describe('voice input', () => {
  it('transcribes on this computer with whisper.cpp and a model it downloads', async () => {
    const model = Buffer.alloc(4096, 7);
    const hub = await serve((req) => (req.url === '/ggml-base.bin' ? { body: model, headers: { 'content-length': String(model.length) } } : { status: 404, body: 'no' }));
    const { home, voice } = setup([], {}, { modelsBase: hub.base });

    // A stand-in for whisper-cli: checks what it is given and prints what it "heard".
    const bin = join(tempDir('covibe-bin-'), 'whisper-cli');
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${home}/args"\nprintf '\\n Add a dark mode toggle.\\n [BLANK_AUDIO]\\n Remember the choice.\\n'\n`);
    chmodSync(bin, 0o755);

    expect(voice.status()).toMatchObject({ ready: false, settings: { engine: 'local', model: 'base', language: 'auto' } });
    voice.update({ whisperPath: bin, language: 'en' });
    expect(voice.status().problem).toMatch(/base model is not downloaded/);

    voice.startDownload('base');
    for (let i = 0; i < 100 && !voice.status().local.download?.done; i++) await new Promise((r) => setTimeout(r, 20));
    const st = voice.status();
    expect(st.local.download).toMatchObject({ model: 'base', received: 4096, total: 4096, done: true });
    expect(st.local.models.find((m) => m.id === 'base')!.downloaded).toBe(true);
    expect(st).toMatchObject({ ready: true, local: { command: bin } });

    expect(await voice.transcribe(wav())).toEqual({ text: 'Add a dark mode toggle. Remember the choice.', engine: 'local' });
    const args = (await import('node:fs')).readFileSync(join(home, 'args'), 'utf8');
    expect(args).toMatch(/-m \S+ggml-base\.bin -f \S+speech\.wav -l en -t \d+ -nt -np/);

    await expect(voice.transcribe(Buffer.from('not audio at all, honestly'))).rejects.toThrow(/not a WAV/);
    expect(() => voice.update({ model: 'huge' })).toThrow(/unknown whisper.cpp model/);
    expect(voice.deleteModel('base').local.models.find((m) => m.id === 'base')!.downloaded).toBe(false);
    hub.close();
  });

  it("uses OpenAI's API with the key of a model provider from Settings, or its own", async () => {
    const seen: { auth?: string; body: string }[] = [];
    const api = await serve((req, body) => {
      seen.push({ auth: req.headers.authorization, body: body.toString('latin1') });
      return req.url === '/v1/audio/transcriptions' ? { body: JSON.stringify({ text: 'Hallo Team' }) } : { status: 404, body: '{}' };
    });
    const provider: Connection = { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: `${api.base}/v1`, createdAt: '' };
    const { voice, secrets } = setup([provider], { openai: 'sk-provider' }, { openaiBase: `${api.base}/v1` });

    voice.update({ engine: 'openai' });
    expect(voice.status().problem).toMatch(/no OpenAI key/);
    expect(voice.status().openai.connections).toEqual([{ id: 'openai', label: 'OpenAI', baseUrl: `${api.base}/v1`, hasKey: true }]);

    voice.update({ openaiConnection: 'openai', language: 'de' });
    expect(await voice.transcribe(wav())).toEqual({ text: 'Hallo Team', engine: 'openai' });
    expect(seen[0]!.auth).toBe('Bearer sk-provider');
    expect(seen[0]!.body).toContain('name="model"\r\n\r\nwhisper-1');
    expect(seen[0]!.body).toContain('name="language"\r\n\r\nde');
    expect(seen[0]!.body).toContain('filename="speech.wav"');

    // Its own key instead, with OpenAI's own model.
    voice.update({ openaiConnection: '', openaiKey: 'sk-own' });
    expect(secrets.get('voice.openai')).toBe('sk-own');
    await voice.transcribe(wav());
    expect(seen[1]!.auth).toBe('Bearer sk-own');
    expect(seen[1]!.body).toContain('gpt-4o-mini-transcribe');
    expect(() => voice.update({ openaiConnection: 'nope' })).toThrow(/not an OpenAI-compatible model provider/);
    api.close();
  });

  it("uses ElevenLabs' Scribe, with the key saved for an ElevenLabs plugin if it has none of its own", async () => {
    const seen: { key?: string; body: string }[] = [];
    const api = await serve((req, body) => {
      seen.push({ key: req.headers['xi-api-key'] as string | undefined, body: body.toString('latin1') });
      return req.headers['xi-api-key'] ? { body: JSON.stringify({ text: 'Ship it.', language_code: 'en' }) } : { status: 401, body: JSON.stringify({ detail: { message: 'invalid api key' } }) };
    });
    const { voice } = setup([], {}, { elevenlabsBase: `${api.base}/v1` });
    voice.update({ engine: 'elevenlabs' });
    expect(voice.status().problem).toMatch(/no ElevenLabs key/);

    addMcpServer({ config: 'ELEVENLABS_API_KEY=xi_from_plugin uvx elevenlabs-mcp', name: 'elevenlabs' }, { network: [], allowWrite: [], writeWorkspace: false });
    expect(voice.status()).toMatchObject({ ready: true, elevenlabs: { hasKey: false, fromPlugin: 'elevenlabs' } });
    expect(await voice.transcribe(wav())).toEqual({ text: 'Ship it.', engine: 'elevenlabs' });
    expect(seen[0]!.key).toBe('xi_from_plugin');
    expect(seen[0]!.body).toContain('name="model_id"\r\n\r\nscribe_v1');

    voice.update({ elevenlabsKey: 'xi_own' });
    await voice.transcribe(wav());
    expect(seen[1]!.key).toBe('xi_own');
    deletePlugin('elevenlabs');
    api.close();
  });

  it('says what went wrong at the service', async () => {
    const api = await serve(() => ({ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) }));
    const { voice } = setup([], { 'voice.openai': 'sk-bad' }, { openaiBase: api.base });
    voice.update({ engine: 'openai' });
    await expect(voice.transcribe(wav())).rejects.toThrow('OpenAI could not transcribe it (401): Incorrect API key provided');
    expect(tidy(' (music) hello\n  world [BLANK_AUDIO] ')).toBe('hello world');
    api.close();
  });
});
