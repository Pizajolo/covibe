import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateNearKey, generateSealKey, seal } from '../src/market/crypto.js';
import { RelayClient } from '../src/market/relay.js';
import type { MarketView, RunSummary } from '../src/server/api-types.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import { Library } from '../src/server/library.js';
// @ts-expect-error the relay is plain JavaScript (its own package)
import { startRelay } from '../market/relay/server.mjs';
import { ScriptedRunner, tempDir } from './helpers.js';
import { FakeChain, OWNER } from './market-helpers.js';

let server: CovibeServer | undefined;
let relay: { url: string; close(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.close();
  await relay?.close();
  server = relay = undefined;
});

describe('the market in the app', () => {
  it('edits and publishes a storefront, shows an order with the recommendation, and runs the team on accept', async () => {
    const chain = new FakeChain();
    const owner = generateNearKey();
    relay = await startRelay({ port: 0, data: tempDir('covibe-relay-'), chain: { contract: chain.contractId, order: (id: string) => chain.order(Number(id)), listing: (id: string) => chain.listing(Number(id)), hasKey: async (_a: string, key: string) => key === owner.publicKey } });
    const library = new Library(tempDir('covibe-home-'));
    // The landing-page example, as a team of the library.
    cpSync(new URL('../examples/landing-page', import.meta.url).pathname, join(library.teamsDir, 'landing'), { recursive: true });
    const runner = new ScriptedRunner({
      intake: () => ({ structured: { decision: 'accept', reason: 'A landing page.', scope_fit: 0.9, estimated_cost: 'small', risks: [] } }),
      builder: () => ({ write: { 'out/index.html': '<h1>Acme</h1>' } }),
      reviewer: () => ({ structured: { blocking_count: 0, findings: [] } }),
    });
    server = await startServer({ library, runner, token: 't', market: { chain, relay: new RelayClient(relay!.url, OWNER, owner.secretKey) } });
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
      return json as T;
    };

    // The key goes to the secret store and never comes back.
    let view = await api<MarketView>('PUT', '/api/market/settings', { accountId: OWNER, contractId: chain.contractId, privateKey: owner.secretKey });
    expect(view.publicKey).toBe(owner.publicKey);
    expect(JSON.stringify(view)).not.toContain(owner.secretKey);
    await expect(api('PUT', '/api/market/settings', { privateKey: 'not a key' })).rejects.toThrow('not a NEAR key');
    expect(view.teams).toMatchObject([{ id: 'landing', hasStorefront: true, problems: [], title: 'Landing-page team', priceNear: 2 }]);

    // The editor: a broken file is saved with its problems named; publishing it is refused.
    const sf = await api<{ yaml: string; problems: string[] }>('GET', '/api/market/storefronts/landing');
    expect(sf.problems).toEqual([]);
    const broken = await api<{ problems: string[] }>('PUT', '/api/market/storefronts/landing', { yaml: sf.yaml.replace('gates_required: [review]', 'gates_required: [nope]') });
    expect(broken.problems[0]).toContain('"nope"');
    await expect(api('POST', '/api/market/storefronts/landing/publish')).rejects.toMatchObject({ status: 400 });
    await api('PUT', '/api/market/storefronts/landing', { yaml: sf.yaml });
    const published = await api<{ listingId: number; url: string }>('POST', '/api/market/storefronts/landing/publish');
    expect(published.url).toContain('/#/listing/0');
    view = await api<MarketView>('GET', '/api/market');
    expect(view.teams[0]).toMatchObject({ listingId: 0, active: true, outdated: false });

    // A customer orders.
    const listing = (await chain.listing(0))!;
    const sealed = seal(Buffer.from(JSON.stringify({ v: 1, fields: { brief: 'A page for Acme bikes.' }, files: [], reply_pubkey: generateSealKey().publicKey })), listing.intake_pubkey);
    const { value: id } = await chain.placeOrder(0, await new RelayClient(relay!.url).putInput(sealed), listing.price, generateNearKey().publicKey);
    view = await api<MarketView>('POST', '/api/market/refresh');
    expect(view.orders[0]).toMatchObject({ id, stage: 'awaiting_owner', brief: { brief: 'A page for Acme bikes.' }, recommendation: { action: 'accept' }, intake: { scope_fit: 0.9 } });
    expect(view.earnings.inEscrow).toBe(listing.price);

    await api('POST', `/api/market/orders/${id}/accept`);
    const end = Date.now() + 10_000;
    while ((await api<MarketView>('GET', '/api/market')).orders[0]!.stage !== 'delivered') {
      if (Date.now() > end) throw new Error(`not delivered: ${JSON.stringify((await api<MarketView>('GET', '/api/market')).orders[0])}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    view = await api<MarketView>('GET', '/api/market');
    const order = view.orders[0]!;
    expect((await chain.order(id))!.status).toBe('DELIVERED');
    expect(order.gates).toEqual([{ name: 'review', passed: true }]);
    // The order's workspace is a project, and the team's run shows with the other runs.
    const runs = await api<RunSummary[]>('GET', '/api/runs');
    expect(runs.find((r) => r.id === order.runId)).toMatchObject({ projectId: order.projectId, status: 'succeeded' });
    await expect(api('POST', `/api/market/orders/${id}/decline`, {})).rejects.toThrow('not waiting for an answer');
  });

  it('starts a storefront from a team, keeps its example media, and lets the assistant save only a valid file', async () => {
    const library = new Library(tempDir('covibe-home-'));
    cpSync(new URL('../examples/landing-page', import.meta.url).pathname, join(library.teamsDir, 'landing'), { recursive: true });
    const file = join(library.teamsDir, 'landing', 'storefront.yaml');
    const original = readFileSync(file, 'utf8');
    rmSync(file);
    const runner = new ScriptedRunner({
      shopkeeper: (inv, n) =>
        n === 0
          ? { call: [{ tool: 'get_storefront', args: {} }, { tool: 'save_storefront', args: { yaml: original.replace('gates_required: [review]', 'gates_required: [nope]'), summary: 'first try' } }, { tool: 'save_storefront', args: { yaml: original.replace('Landing-page team', 'Pages by Acme'), summary: 'set up' } }], text: 'Saved.' }
          : { text: `resumed ${inv.resumeSessionId}` },
    });
    server = await startServer({ library, runner, token: 't', market: { chain: new FakeChain() } });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
      return json as T;
    };
    const wait = async (until: () => Promise<boolean>) => {
      for (const end = Date.now() + 5000; !(await until()); ) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 30));
      }
    };

    // A team without a storefront is not a card yet; a new one starts from a file the form can read.
    expect((await api<MarketView>('GET', '/api/market')).teams[0]).toMatchObject({ id: 'landing', hasStorefront: false });
    await api('POST', '/api/market/storefronts/landing');
    const fresh = await api<{ exists: boolean; gates: string[]; media: unknown[] }>('GET', '/api/market/storefronts/landing');
    expect(fresh).toMatchObject({ exists: true, gates: ['review'], media: [] });

    // An example picture goes into the team folder and comes back, in ranges too; other files are refused.
    const png = Buffer.from('not really a png, but long enough to take a range from');
    const up = await fetch(`${base}/api/market/storefronts/landing/media?name=${encodeURIComponent('../Before after.png')}`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: png });
    expect(await up.json()).toEqual({ file: 'storefront/Before after.png', size: png.length, type: 'image/png' });
    const part = await fetch(`${base}/api/market/storefronts/landing/media?file=${encodeURIComponent('storefront/Before after.png')}&token=t`, { headers: { range: 'bytes=4-9' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('really');
    expect((await fetch(`${base}/api/market/storefronts/landing/media?name=run.sh`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/market/storefronts/landing/media?file=team.yaml&token=t`)).status).toBe(400);
    expect((await api<{ media: { file: string }[] }>('GET', '/api/market/storefronts/landing')).media).toMatchObject([{ file: 'storefront/Before after.png' }]);

    // The assistant: a file with problems is not written, a valid one is, and the conversation continues.
    await api('POST', '/api/market/storefronts/landing/assistant', { message: 'Set it up' });
    await wait(async () => !(await api('GET', '/api/market/storefronts/landing/assistant')).busy);
    let chat = await api<{ runId: string; saves: { valid: boolean; problems: string[] }[]; thread: { kind: string; text: string }[] }>('GET', '/api/market/storefronts/landing/assistant');
    expect(chat.saves.map((x) => x.valid)).toEqual([false, true]);
    expect(chat.saves[0]!.problems[0]).toContain('"nope"');
    expect(runner.toolResults.find((r) => r.tool === 'get_storefront')!.result).toContain('Steps with gates (what gates_required may name): review');
    expect(runner.toolResults.find((r) => r.tool === 'get_storefront')!.result).toContain('storefront/Before after.png');
    expect(readFileSync(file, 'utf8')).toContain('Pages by Acme');
    expect(chat.thread[0]).toMatchObject({ kind: 'human', text: 'Set it up' });
    const first = chat.runId;
    await api('POST', '/api/market/storefronts/landing/assistant', { message: 'Cheaper please' });
    await wait(async () => !(await api('GET', '/api/market/storefronts/landing/assistant')).busy);
    chat = await api('GET', '/api/market/storefronts/landing/assistant');
    expect(chat.runId).toBe(first);
    expect(chat.thread.at(-1)).toMatchObject({ kind: 'agent', text: 'resumed session-shopkeeper' });
    expect((await api<MarketView>('GET', '/api/market')).teams[0]).toMatchObject({ hasStorefront: true, title: 'Pages by Acme', problems: [] });

    // A draft can be dropped; the team and its media stay.
    await api('DELETE', '/api/market/storefronts/landing');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(library.teamsDir, 'landing', 'team.yaml'))).toBe(true);
  });
});
