import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { attestsByDefault, decodeBytes, mergeAttestations, signatureProblem, verifyEd25519 } from '../src/connections/attest.js';
import { FileSecrets } from '../src/connections/secrets.js';
import { Connections } from '../src/connections/store.js';
import { receiptAttestation } from '../src/market/delivery.js';
import type { RunEvent } from '../src/events/types.js';
import { tempDir } from './helpers.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/**
 * A stand-in for a provider that signs its answers the way NEAR AI Cloud documents it: the
 * signed text is `<model>:<sha256 of the request>:<sha256 of the response>`, the signature is
 * ed25519, and the attestation report names the signing key and echoes the caller's nonce.
 */
async function enclaveProvider(opts: { wrongHash?: boolean; unknownSigner?: boolean; staleNonce?: boolean } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const address = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const signed = new Map<string, { text: string; signature: string }>();
  const seen: { path: string; headers: IncomingMessage['headers'] }[] = [];
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname, headers: req.headers });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/v1/attestation/report') {
      return json(200, {
        gateway_attestation: { signing_address: 'ab'.repeat(32), signing_algo: 'ed25519', request_nonce: url.searchParams.get('nonce') },
        model_attestations: [{ signing_address: opts.unknownSigner ? 'cd'.repeat(32) : address, signing_algo: 'ed25519', request_nonce: opts.staleNonce ? '00' : url.searchParams.get('nonce'), intel_quote: 'feedface' }],
      });
    }
    const sig = /^\/v1\/signature\/(.+)$/.exec(url.pathname);
    if (sig) {
      const s = signed.get(decodeURIComponent(sig[1]!));
      return s ? json(200, { ...s, signing_address: address, signing_algo: 'ed25519', signature_kind: 'provider_tee' }) : json(404, { error: 'not found' });
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = Buffer.concat(chunks);
    const body = JSON.parse(request.toString()) as { model: string; stream?: boolean };
    const id = `chatcmpl-${++n}`;
    const response = body.stream
      ? `data: ${JSON.stringify({ id, choices: [{ delta: { content: 'Hi' } }] })}\n\ndata: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ id, choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    const text = `${body.model}:${sha(request)}:${opts.wrongHash ? sha('something else') : sha(response)}`;
    signed.set(id, { text, signature: sign(null, Buffer.from(text), pair.privateKey).toString('hex') });
    res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
    res.end(response);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function member(opts: Parameters<typeof enclaveProvider>[0] = {}) {
  const provider = await enclaveProvider(opts);
  const home = tempDir('covibe-attest-');
  const c = new Connections(home, new FileSecrets(home));
  open.push(c, provider.server);
  c.add({ kind: 'openai', label: 'enclave', baseUrl: provider.url, apiKey: 'sk-near', attest: true });
  const built = await c.resolve({ type: 'connection', connection: 'enclave', model: 'm' }, { PATH: '/usr/bin' });
  const call = (body: Record<string, unknown>) =>
    fetch(`${built.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${built.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }], ...body }) });
  return { provider, built, call, connections: c };
}

describe('answers signed by an enclave provider', () => {
  it('turns signing on for NEAR AI Cloud by its address, and elsewhere only when asked', () => {
    expect(attestsByDefault('https://cloud-api.near.ai/v1')).toBe(true);
    expect(attestsByDefault('https://api.openai.com/v1')).toBe(false);
    expect(attestsByDefault('https://cloud-api.near.ai.evil.example/v1')).toBe(false);
  });

  it('reads keys and signatures as hex, base64 or base58', () => {
    const pair = generateKeyPairSync('ed25519');
    const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const sig = sign(null, Buffer.from('a:b:c'), pair.privateKey);
    expect(decodeBytes(`0x${raw.toString('hex')}`, 32)).toEqual(raw);
    expect(verifyEd25519(raw.toString('hex'), 'a:b:c', sig.toString('base64'))).toBe(true);
    expect(verifyEd25519(raw.toString('base64'), 'a:b:c', sig.toString('hex'))).toBe(true);
    expect(verifyEd25519(raw.toString('hex'), 'a:b:d', sig.toString('hex'))).toBe(false);
  });

  it('checks each call: plain and streamed, with the exact bytes both ways', async () => {
    const { provider, built, call } = await member();
    expect(built.env.ANTHROPIC_BASE_URL).toMatch(/\/enclave~[0-9a-f]{16}$/);
    expect(await (await call({})).json()).toMatchObject({ content: [{ type: 'text', text: 'Hello' }] });
    expect(await (await call({ stream: true })).text()).toContain('"text_delta","text":"Hi"');

    const got = (await built.attested!())!;
    expect(got.provider).toBe('127.0.0.1');
    expect(got.calls).toHaveLength(2);
    for (const c of got.calls) expect(c).toMatchObject({ model: 'm', verified: true, signature_kind: 'provider_tee', signing_algo: 'ed25519' });
    expect(got.calls.map((c) => c.chat_id)).toEqual(['chatcmpl-1', 'chatcmpl-2']);
    // The report is fetched once, with covibe's own nonce, and its hardware quote is kept as it came.
    expect(got.reports).toHaveLength(1);
    expect(got.reports[0]!.signers.find((s) => s.kind === 'model')).toMatchObject({ intel_quote: 'feedface', request_nonce: got.reports[0]!.nonce });
    expect(provider.seen.filter((s) => s.path === '/v1/attestation/report')).toHaveLength(1);
    // The model id is sent as written and the answer uncompressed, since both are part of what is signed.
    expect(provider.seen.find((s) => s.path === '/v1/chat/completions')!.headers).toMatchObject({ 'x-no-aliasing': 'true', 'accept-encoding': 'identity', authorization: 'Bearer sk-near' });
    // Collected once: asking again gives nothing.
    expect(await built.attested!()).toBeUndefined();
  });

  it('keeps members apart: each one collects its own calls', async () => {
    const { built, call, connections } = await member();
    const other = await connections.resolve({ type: 'connection', connection: 'enclave', model: 'm' }, { PATH: '/usr/bin' });
    await (await call({})).json();
    expect(await other.attested!()).toBeUndefined();
    expect((await built.attested!())!.calls).toHaveLength(1);
  });

  it('does not call a signature verified when it covers other bytes, or its key is not in the report', async () => {
    for (const [opts, problem] of [
      [{ wrongHash: true }, /does not match the request and response/],
      [{ unknownSigner: true }, /not in the attestation report/],
      [{ staleNonce: true }, /does not echo covibe's nonce/],
    ] as const) {
      const { built, call } = await member(opts);
      await (await call({})).json();
      const got = (await built.attested!())!;
      expect(got.calls[0]).toMatchObject({ verified: false });
      expect(got.calls[0]!.problem).toMatch(problem);
    }
  });

  it('refuses algorithms and kinds it cannot check', () => {
    const call = { model: 'm', request_hash: 'a', response_hash: 'b' };
    expect(signatureProblem({ text: 'm:a:b', signature: 'x', signing_address: 'y', signing_algo: 'ecdsa', signature_kind: 'provider_tee' }, call, undefined)).toMatch(/ed25519 only/);
    expect(signatureProblem({ text: 'm:a:b', signature: 'x', signing_address: 'y', signing_algo: 'ed25519', signature_kind: 'other' }, call, undefined)).toMatch(/unknown kind/);
    expect(signatureProblem({}, call, undefined)).toMatch(/no signature/);
  });

  it('leaves a provider that does not sign alone', async () => {
    const provider = await enclaveProvider();
    const home = tempDir('covibe-attest-');
    const c = new Connections(home, new FileSecrets(home));
    open.push(c, provider.server);
    c.add({ kind: 'openai', label: 'plain', baseUrl: provider.url, apiKey: 'sk' });
    const built = await c.resolve({ type: 'connection', connection: 'plain', model: 'm' }, { PATH: '/usr/bin' });
    expect(built.attested).toBeUndefined();
    expect(built.env.ANTHROPIC_BASE_URL).toMatch(/\/plain$/);
  });

  it('puts the intake agent’s and the team’s signed calls into a receipt, each report once', () => {
    const report = { model: 'm', nonce: 'n', fetched_at: 't', report_hash: 'r1', signers: [] };
    const one = (id: string, verified = true) => ({ model: 'm', chat_id: id, request_hash: 'a', response_hash: 'b', at: 't', verified });
    const events = [
      { type: 'agent.attested', step: 'review', agent: 'reviewer', data: { provider: 'cloud-api.near.ai', calls: [one('c2'), one('c3', false)], reports: [report] } },
      { type: 'agent.finished', step: 'review', agent: 'reviewer', data: {} },
    ] as unknown as RunEvent[];
    const got = receiptAttestation(events, { provider: 'cloud-api.near.ai', calls: [one('c1')], reports: [report] })!;
    expect(got).toMatchObject({ v: 1, provider: 'cloud-api.near.ai' });
    expect(got.calls.map((c) => [c.run, c.chat_id, c.step ?? null, c.verified])).toEqual([['intake', 'c1', null, true], ['team', 'c2', 'review', true], ['team', 'c3', 'review', false]]);
    expect(got.reports).toHaveLength(1);
    expect(receiptAttestation([], undefined)).toBeUndefined();
    expect(mergeAttestations([undefined, { provider: 'p', calls: [one('x')], reports: [report] }, { provider: 'p', calls: [one('y')], reports: [report] }])).toMatchObject({ provider: 'p', calls: [{ chat_id: 'x' }, { chat_id: 'y' }], reports: [report] });
  });
});
