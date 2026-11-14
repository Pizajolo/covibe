import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FileSecrets } from '../src/connections/secrets.js';
import { AgentMarketClient, hireInput, hirePrice, type AgentMarketApi, type AmAttachment, type AmRow } from '../src/market/agentmarket.js';
import { generateNearKey, sha256Hex } from '../src/market/crypto.js';
import { verifyReceipt } from '../src/market/delivery.js';
import { LocalHost } from '../src/market/host.js';
import { Market } from '../src/market/market.js';
import { RelayClient } from '../src/market/relay.js';
import { loadStorefront } from '../src/market/storefront.js';
import type { HireReceipt } from '../src/market/types.js';
import { zipFiles } from '../src/market/zip.js';
import { ScriptedRunner, tempDir, writeFiles, type Script } from './helpers.js';
import { FakeChain, OWNER } from './market-helpers.js';

const TEAM = `version: 1
name: landing
defaults:
  isolation: none
agents:
  maker:
    prompt: "Make the page.\\n"
    tools: [Read, Write, Edit]
    scope: { write: ["out/**"] }
  reviewer:
    prompt: "Review the page.\\n"
    tools: [Read]
    output_schema: schemas/review.json
workflow:
  on_gate_fail: { goto: make, max_loops: 1, feed: [review.findings], then: escalate_to_human }
  steps:
    - { id: make, agent: maker }
    - { id: review, agent: reviewer, gate: "review.blocking_count = 0" }
`;

const storefront = (mode: string, included = 1) => `storefront:
  title: Landing-page team
  summary: A one-page site from your brief.
  price_near: 2
  intake: { mode: ${mode}, budget_cap_usd: 1, estimated_cost_usd: 0.1, min_price_near: 1, min_price_usd: 5, policy: "Landing pages only." }
  inputs:
    - { name: brief, type: text, required: true, max_chars: 2000 }
    - { name: logo, type: files, accept: [".png"], max_files: 1, folder: assets }
  goal: Build the landing page the customer ordered.
  deliverables: { folder: out, gates_required: [review] }
  revisions: { included: ${included} }
`;

const REVIEW_SCHEMA = JSON.stringify({ type: 'object', required: ['blocking_count'], properties: { blocking_count: { type: 'integer' }, findings: { type: 'array' } } });

/** NEAR AI Agent Market as the worker API describes it, in memory. */
class FakeAgentMarket implements AgentMarketApi {
  rows: AmRow[] = [];
  blobs = new Map<string, Buffer>();
  started: string[] = [];
  declined: { id: string; reason: string; detail?: string }[] = [];
  submitted: { id: string; markdown: string; files: string[] }[] = [];
  uploaded = new Map<string, { name: string; bytes: Buffer }>();
  sent: { id: string; body: string }[] = [];
  reports: { id: string; message: string }[] = [];
  private n = 0;

  private row(id: string): AmRow {
    const r = this.rows.find((x) => x.assignment.assignmentId === id);
    if (!r) throw new Error('not_found');
    return r;
  }

  hire(o: { title?: string; description?: string; amount?: string; token?: string; attachments?: AmAttachment[] } = {}): string {
    const id = `as-${++this.n}`;
    this.rows.unshift({
      assignment: { assignmentId: id, jobId: `job-${this.n}`, status: 'in_progress', escrowAmount: o.amount ?? '8.00', escrowToken: o.token ?? 'USD', slaDeadlineAt: '2026-12-01T00:00:00Z', startedAt: null, submittedAt: null, deliverableUrl: null },
      job: { jobId: `job-${this.n}`, title: o.title ?? 'A page for Acme', description: o.description ?? 'One page for Acme, a bike repair shop.', jobKind: 'standard', attachments: o.attachments ?? [] },
      latestMessage: null,
    });
    return id;
  }

  attachment(name: string, bytes: Buffer): AmAttachment {
    const url = `/v1/jobs/j/attachments/${name}/raw`;
    this.blobs.set(url, bytes);
    return { id: name, filename: name, byteSize: bytes.length, sha256: sha256Hex(bytes), downloadUrl: url };
  }

  /** The buyer sends a delivery back with feedback. */
  requestChanges(id: string, body: string) {
    const r = this.row(id);
    r.assignment.status = 'in_progress';
    r.latestMessage = { senderSide: 'buyer', body, truncated: false, createdAt: new Date().toISOString(), attachments: [] };
  }

  buyerAccepts(id: string) {
    this.row(id).assignment.status = 'accepted';
  }

  assignments = async (status: string, limit: number, offset: number) => this.rows.filter((r) => status === 'all' || r.assignment.status === status).slice(offset, offset + limit).map((r) => structuredClone(r));
  start = async (id: string) => {
    this.row(id).assignment.startedAt = new Date().toISOString();
    this.started.push(id);
  };
  progress = async (id: string, message: string) => void this.reports.push({ id, message });
  decline = async (id: string, reason: 'rejected' | 'failed', detail?: string) => {
    Object.assign(this.row(id).assignment, { status: 'cancelled', cancelReason: reason });
    this.declined.push({ id, reason, detail });
  };
  messages = async () => [];
  message = async (id: string, body: string) => void this.sent.push({ id, body });
  submit = async (id: string, markdown: string, files: string[]) => {
    for (const f of files) if (!this.uploaded.has(f)) throw new Error(`invalid_attachment: ${f}`);
    Object.assign(this.row(id).assignment, { status: 'submitted', submittedAt: new Date().toISOString(), deliverableUrl: `https://am.test/d/${id}` });
    this.submitted.push({ id, markdown, files });
  };
  upload = async (name: string, bytes: Buffer) => {
    const url = `https://am.test/files/t${this.uploaded.size + 1}/${name}`;
    this.uploaded.set(url, { name, bytes });
    return url;
  };
  download = async (url: string) => {
    const b = this.blobs.get(url);
    if (!b) throw new Error('not found');
    return b;
  };
}

const good: Record<string, Script> = {
  intake: () => ({ structured: { decision: 'accept', reason: 'A landing page, as offered.', scope_fit: 0.95, estimated_cost: 'small', risks: [] } }),
  maker: (_inv, n) => ({ write: { 'out/index.html': `<h1>Acme v${n + 1}</h1>\n`, 'notes.md': 'not for the customer\n' } }),
  reviewer: () => ({ structured: { blocking_count: 0, findings: [] } }),
};

async function setup(mode: string, scripts: Record<string, Script> = good, included = 1) {
  const am = new FakeAgentMarket();
  const owner = generateNearKey();
  const home = tempDir('covibe-am-');
  const teamDir = tempDir('covibe-team-');
  writeFiles(teamDir, { 'team.yaml': TEAM, 'schemas/review.json': REVIEW_SCHEMA, 'storefront.yaml': storefront(mode, included) });
  const runner = new ScriptedRunner(scripts);
  const lines: string[] = [];
  const market = new Market({ home, secrets: new FileSecrets(home), host: new LocalHost(runner), chain: new FakeChain(), relay: new RelayClient('http://127.0.0.1:9'), agentMarket: () => am, log: (l) => lines.push(l) });
  market.configure({ privateKey: owner.secretKey, accountId: OWNER });
  await market.hires.connect(teamDir, 'aat_test');
  /** One pass of the watcher, and the runs it started. */
  const pass = async () => {
    await market.tick();
    await market.settle();
  };
  const hire = (key = 'h1') => market.store.hire(key)!;
  return { am, market, runner, teamDir, lines, owner, pass, hire };
}

const receiptOf = (am: FakeAgentMarket, files: string[]): HireReceipt => JSON.parse(am.uploaded.get(files.find((f) => f.endsWith('covibe-receipt.json'))!)!.bytes.toString()) as HireReceipt;

describe('NEAR AI Agent Market: a hire as an order', () => {
  it('maps a job to the listing’s form and compares its pay with the floor', async () => {
    const { am, teamDir } = await setup('auto');
    const sf = loadStorefront(teamDir);
    const id = am.hire({ attachments: [am.attachment('logo.png', Buffer.from('png')), am.attachment('notes.psd', Buffer.from('psd'))] });
    const row = am.rows.find((r) => r.assignment.assignmentId === id)!;
    row.latestMessage = { senderSide: 'buyer', body: 'Green and cream, please.', createdAt: 't', attachments: [] };
    const built = hireInput(sf, row);
    expect(built.input!.fields.brief).toBe("# A page for Acme\n\nOne page for Acme, a bike repair shop.\n\n## The buyer's message\nGreen and cream, please.");
    expect(built.attachments.map((a) => [a.filename, a.field])).toEqual([['logo.png', 'logo']]);
    expect(built.unplaced).toEqual(['notes.psd']);
    expect(hirePrice(sf, '8.00', 'USD').ok).toBe(true);
    expect(hirePrice(sf, '4.99', 'USDC').ok).toBe(false);
    expect(hirePrice(sf, '8.00', 'NEAR')).toMatchObject({ ok: false });
  });

  it('auto: screens, starts, runs the team, and submits only after the gates passed', async () => {
    const { am, pass, hire, owner, market } = await setup('auto');
    const id = am.hire({ attachments: [am.attachment('logo.png', Buffer.from('a logo'))] });
    await pass();
    expect(am.started).toEqual([id]);
    expect(hire()).toMatchObject({ key: 'h1', stage: 'delivered', status: 'submitted', decidedBy: 'auto', gates: [{ name: 'review', passed: true }] });
    expect(readFileSync(join(hire().workspace!, 'assets', 'logo.png'), 'utf8')).toBe('a logo');

    expect(am.submitted).toHaveLength(1);
    const { markdown, files } = am.submitted[0]!;
    expect([...am.uploaded.values()].map((u) => u.name)).toEqual(['index.html', 'covibe-receipt.json']);
    expect(am.uploaded.get(files[0]!)!.bytes.toString()).toBe('<h1>Acme v1</h1>\n');
    expect(markdown).toContain('Check "review": passed');
    expect(markdown).toContain('`index.html`');
    expect(markdown).not.toContain('notes.md');

    const receipt = receiptOf(am, files);
    expect(receipt).toMatchObject({ v: 1, market: 'near-ai-agent-market', assignment_id: id, run_status: 'succeeded', gates: [{ name: 'review', passed: true }], owner: OWNER, public_key: owner.publicKey });
    expect(receipt.files).toEqual([{ name: 'index.html', size: 17, sha256: sha256Hex('<h1>Acme v1</h1>\n') }]);
    expect(verifyReceipt(receipt)).toBe(true);
    expect(verifyReceipt({ ...receipt, gates: [] } as HireReceipt)).toBe(false);
    expect(am.reports.map((r) => r.message)).toContain('The team took the job and started working.');

    am.buyerAccepts(id);
    await pass();
    expect(hire()).toMatchObject({ stage: 'closed', status: 'accepted' });
    expect(market.overview().hires).toHaveLength(1);
  });

  it('auto: hands the job back when the checks do not pass, and submits nothing', async () => {
    const { am, pass, hire } = await setup('auto', { ...good, reviewer: () => ({ structured: { blocking_count: 1, findings: ['no call to action'] } }) });
    const id = am.hire();
    await pass();
    expect(am.submitted).toEqual([]);
    expect(am.uploaded.size).toBe(0);
    expect(am.declined).toEqual([{ id, reason: 'failed', detail: "The team's checks did not pass, so nothing was delivered." }]);
    expect(hire()).toMatchObject({ stage: 'closed', status: 'cancelled', gates: [{ name: 'review', passed: false }] });
  });

  it('auto: turns down a hire that fails the rules, before any model sees it', async () => {
    const { am, pass, hire, runner } = await setup('auto');
    const id = am.hire({ amount: '2.00' });
    await pass();
    expect(runner.calls).toEqual([]);
    expect(am.started).toEqual([]);
    expect(am.declined[0]).toMatchObject({ id, reason: 'rejected' });
    expect(am.declined[0]!.detail).toContain('the floor is $5.00');
    expect(hire().stage).toBe('closed');
  });

  it('recommend: nothing starts until the owner takes the job', async () => {
    const { am, pass, hire, market } = await setup('recommend');
    const id = am.hire();
    am.hire({ title: 'Another page' });
    await pass();
    expect(am.started).toEqual([]);
    expect(hire()).toMatchObject({ stage: 'awaiting_owner', recommendation: { action: 'accept' }, title: 'A page for Acme' });
    await pass();
    expect(hire().stage).toBe('awaiting_owner');

    await market.hires.accept('h1');
    await market.settle();
    expect(am.started).toEqual([id]);
    expect(hire().stage).toBe('delivered');

    await market.hires.decline('h2', 'No capacity this week.');
    expect(am.declined).toEqual([{ id: 'as-2', reason: 'rejected', detail: 'No capacity this week.' }]);
    expect(hire('h2').stage).toBe('closed');
    await expect(market.hires.accept('h2')).rejects.toThrow(/not waiting/);
  });

  it('runs an included change request on the earlier result, and asks the owner beyond that', async () => {
    const { am, pass, hire, market, runner } = await setup('auto');
    const id = am.hire();
    await pass();
    am.requestChanges(id, 'Make the headline bigger.');
    await pass();
    expect(hire()).toMatchObject({ stage: 'delivered', revisionRun: 1, revision: { n: 1, note: 'Make the headline bigger.' } });
    expect(am.submitted).toHaveLength(2);
    expect(am.submitted[1]!.markdown).toContain('(revision 1)');
    expect(am.uploaded.get(am.submitted[1]!.files[0]!)!.bytes.toString()).toBe('<h1>Acme v2</h1>\n');
    expect(runner.calls.filter((c) => c.agentName === 'maker').at(-1)!.prompt).toContain('<revision>\nMake the headline bigger.\n</revision>');

    // A second request is beyond the one the listing includes.
    am.requestChanges(id, 'Now make it a shop.');
    await pass();
    expect(hire()).toMatchObject({ stage: 'awaiting_owner', revision: { n: 2, note: 'Now make it a shop.' }, revisionRun: 1 });
    expect(am.submitted).toHaveLength(2);

    await market.hires.decline('h1', 'A shop is a different job.');
    expect(am.sent[0]!.body).toContain('A shop is a different job.');
    expect(am.submitted).toHaveLength(3);
    expect(am.submitted[2]!.files).toEqual(am.submitted[1]!.files);
    expect(am.submitted[2]!.markdown).toContain('The earlier delivery stands');
    expect(am.declined).toEqual([]);
    expect(hire()).toMatchObject({ stage: 'delivered', status: 'submitted' });
  });

  it('a revision that does not pass comes to the owner instead of undoing the delivery', async () => {
    const { am, pass, hire, market } = await setup('auto', { ...good, reviewer: (_inv, n) => ({ structured: { blocking_count: n === 0 ? 0 : 1, findings: [] } }) });
    const id = am.hire();
    await pass();
    am.requestChanges(id, 'Change everything.');
    await pass();
    expect(am.declined).toEqual([]);
    expect(hire().stage).toBe('needs_owner');
    expect(hire().note).toContain('the earlier delivery included');
    await market.hires.fail('h1', 'Could not be done.');
    expect(am.declined).toEqual([{ id, reason: 'failed', detail: 'Could not be done.' }]);
  });

  it('sends folders and many files as one archive', async () => {
    const { am, pass } = await setup('auto', { ...good, maker: () => ({ write: { 'out/index.html': '<h1>Acme</h1>\n', 'out/css/styles.css': 'h1 { color: green }\n' } }) });
    am.hire();
    await pass();
    expect([...am.uploaded.values()].map((u) => u.name)).toEqual(['delivery.zip', 'covibe-receipt.json']);
    const receipt = receiptOf(am, am.submitted[0]!.files);
    expect(receipt.files.map((f) => f.name)).toEqual(['css/styles.css', 'index.html']);
    expect(am.submitted[0]!.markdown).toContain('All files are in `delivery.zip`');
  });

  it('holds back a delivery that carries a key', async () => {
    const { am, pass, hire } = await setup('auto', { ...good, maker: () => ({ write: { 'out/index.html': `<!-- sk-ant-${'a'.repeat(30)} -->\n` } }) });
    am.hire();
    await pass();
    expect(am.submitted).toEqual([]);
    expect(am.declined).toEqual([]);
    expect(hire().stage).toBe('needs_owner');
    expect(hire().note).toContain('looks like it holds an Anthropic key');
  });

  it('leaves competitions and jobs that ended before it was connected alone', async () => {
    const { am, pass, market } = await setup('auto');
    const a = am.hire();
    const b = am.hire();
    am.rows.find((r) => r.assignment.assignmentId === a)!.job.jobKind = 'competition';
    am.rows.find((r) => r.assignment.assignmentId === b)!.assignment.status = 'accepted';
    await pass();
    expect(market.overview().hires).toEqual([]);
  });

  it('keeps the token in the secret store and forgets it on disconnect', async () => {
    const { market, teamDir } = await setup('auto');
    expect(market.store.agentToken(teamDir)).toBe('aat_test');
    expect(readFileSync(join(market.store.dir, 'state.json'), 'utf8')).not.toContain('aat_test');
    expect(market.watchable).toBe(true);
    market.hires.disconnect(teamDir);
    expect(market.store.agentToken(teamDir)).toBeUndefined();
    expect(market.hires.connected).toBe(false);
  });
});

describe('the marketplace client', () => {
  it('speaks the worker API: bearer token, the three-step upload, and no token for other hosts', async () => {
    const seen: { method: string; path: string; auth?: string; body: string }[] = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const path = req.url ?? '';
      seen.push({ method: req.method!, path, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (path.startsWith('/v1/agents/me/assignments')) return json(200, { assignments: [{ assignment: { assignmentId: 'a1', jobId: 'j1', status: 'in_progress', escrowAmount: '5', escrowToken: 'USD' }, job: { jobId: 'j1', title: 't', description: 'd' } }] });
      if (path === '/v1/files') return json(201, { fileId: 'f1', directUploadUrl: `${base}/put/f1`, fileUrl: `${base}/files/tok/out.html` });
      if (path === '/v1/assignments/gone/start') return json(400, { error: 'invalid_state_transition', message: "cannot transition from 'cancelled' to 'in_progress'" });
      if (path === '/raw') {
        res.writeHead(200);
        return res.end('bytes');
      }
      return json(200, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const other = createServer((req, res) => {
      seen.push({ method: req.method!, path: `other${req.url}`, auth: req.headers.authorization, body: '' });
      res.end('elsewhere');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = new AgentMarketClient(`${base}/`, 'aat_secret');
      expect((await client.assignments('all', 100, 0))[0]!.assignment.assignmentId).toBe('a1');
      expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1/agents/me/assignments?status=all&limit=100&offset=0', auth: 'Bearer aat_secret' });

      expect(await client.upload('out.html', Buffer.from('<h1>hi</h1>'))).toBe(`${base}/files/tok/out.html`);
      expect(seen.slice(1, 4).map((s) => [s.method, s.path, s.auth ?? null])).toEqual([['POST', '/v1/files', 'Bearer aat_secret'], ['PUT', '/put/f1', null], ['POST', '/v1/files/f1/complete', 'Bearer aat_secret']]);
      expect(JSON.parse(seen[1]!.body)).toEqual({ filename: 'out.html', byteSize: 11, link: true });
      expect(seen[2]!.body).toBe('<h1>hi</h1>');

      await client.submit('a1', '# Result', ['u1']);
      expect(seen.at(-1)).toMatchObject({ path: '/v1/assignments/a1/submit', body: JSON.stringify({ deliverableMarkdown: '# Result', files: ['u1'] }) });
      await client.decline('a1', 'failed', 'checks did not pass');
      expect(JSON.parse(seen.at(-1)!.body)).toEqual({ reason: 'failed', detail: 'checks did not pass' });
      await expect(client.start('gone')).rejects.toThrow(/cannot transition from 'cancelled'/);

      expect((await client.download('/raw')).toString()).toBe('bytes');
      expect(seen.at(-1)!.auth).toBe('Bearer aat_secret');
      expect((await client.download(`http://127.0.0.1:${(other.address() as AddressInfo).port}/x`)).toString()).toBe('elsewhere');
      expect(seen.at(-1)).toMatchObject({ path: 'other/x', auth: undefined });
    } finally {
      server.close();
      other.close();
    }
  });
});

describe('zip', () => {
  it('writes an archive other tools can read', () => {
    const dir = tempDir('covibe-zip-');
    writeFiles(dir, { 'a.txt': 'hello hello hello hello hello\n', 'sub/ü.bin': '\u0001' });
    const zip = zipFiles([{ name: 'a.txt', path: join(dir, 'a.txt') }, { name: 'sub/ü.bin', path: join(dir, 'sub/ü.bin') }]);
    // Read it back through the central directory, as an unzipper does.
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    let at = zip.readUInt32LE(end + 16);
    const out: Record<string, string> = {};
    for (let i = 0; i < 2; i++) {
      expect(zip.readUInt32LE(at)).toBe(0x02014b50);
      const method = zip.readUInt16LE(at + 10);
      const packed = zip.readUInt32LE(at + 20);
      const nameLen = zip.readUInt16LE(at + 28);
      const local = zip.readUInt32LE(at + 42);
      const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
      expect(zip.readUInt32LE(local)).toBe(0x04034b50);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + packed);
      out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
      at += 46 + nameLen;
    }
    expect(out).toEqual({ 'a.txt': 'hello hello hello hello hello\n', 'sub/ü.bin': '\u0001' });
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
  });
});
