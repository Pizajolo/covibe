// covibe teams as a supplier on NEAR AI Agent Market (market.near.ai). A buyer
// hires an agent there; covibe polls that agent's assignments with its token
// and treats each one as an order: pre-checks, the intake agent, the team's
// run, and a delivery only when the required gates passed. A hire that is not
// taken, or whose checks do not pass, is handed back, which refunds the buyer.
//
// What differs from the covibe market: the money is held by that marketplace
// and released when the buyer accepts (or its acceptance window ends), not by
// a contract that waits for the gates. So the gates decide what covibe sends,
// and the buyer decides whether it is paid.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TeamConfig } from '../config/types.js';
import { confinedEnv, confineTeam } from '../engine/confine.js';
import type { RunEvent } from '../events/types.js';
import { sha256Hex } from './crypto.js';
import { collectDeliverables, eventLogHash, gateResults, receiptAttestation, secretsIn, signReceipt, type DeliverableFile } from './delivery.js';
import type { RunHost, RunResult } from './host.js';
import { fileList, intakePrompt, loadIntakeTeam, MAX_REVISION_NOTE, orderGoal, prechecks, revisionGoal, writeWorkspace } from './intake.js';
import { requiredGates } from './storefront.js';
import type { MarketStore } from './store.js';
import { MarketError, type Hire, type HireReceipt, type HireStatus, type OrderInput, type Storefront } from './types.js';
import { zipFiles } from './zip.js';

export const AGENT_MARKET_URL = 'https://market.near.ai';
/** What one delivery may hold there: five files, 100 MiB together, and a Markdown text of 256 KiB. */
const MAX_FILES = 5;
const MAX_BYTES = 100 * 2 ** 20;
const MAX_MARKDOWN = 256 * 1024;
/** A deliverable that is one text is shown in the delivery itself up to this size. */
const MAX_INLINE = 200 * 1024;
const RECEIPT_NAME = 'covibe-receipt.json';
const ARCHIVE_NAME = 'delivery.zip';
/** The marketplace takes one progress report per assignment in 30 seconds. */
const PROGRESS_EVERY_MS = 31_000;
const PAGE = 100;
const MAX_PAGES = 5;
const REDO_NOTE = 'A dispute on this job was ruled "redo": do the work again as the order asks, and fix what a careful buyer would object to in the earlier result.';

export interface AmAttachment {
  id: string;
  filename: string;
  byteSize: number;
  sha256?: string;
  downloadUrl: string;
}

/** One row of the agent's assignment list: the assignment, the job's brief and the newest message of its thread. */
export interface AmRow {
  assignment: { assignmentId: string; jobId: string; status: HireStatus; escrowAmount: string; escrowToken: string; slaDeadlineAt?: string; startedAt?: string | null; submittedAt?: string | null; deliverableUrl?: string | null; cancelReason?: string | null };
  job: { jobId: string; title: string; description: string; jobKind?: string; attachments?: AmAttachment[] };
  latestMessage?: { senderSide: string; body: string; truncated?: boolean; createdAt: string; attachments?: AmAttachment[] } | null;
}

/** The part of the marketplace's API a worker agent uses (see market.near.ai/skill/reference/agent-api.md). */
export interface AgentMarketApi {
  assignments(status: string, limit: number, offset: number): Promise<AmRow[]>;
  start(id: string): Promise<void>;
  progress(id: string, message: string, percent?: number): Promise<void>;
  /** Hand the assignment back; the buyer is refunded in full. */
  decline(id: string, reason: 'rejected' | 'failed', detail?: string): Promise<void>;
  messages(id: string): Promise<{ body: string; createdAt: string }[]>;
  message(id: string, body: string, requestId?: string): Promise<void>;
  submit(id: string, markdown: string, files: string[]): Promise<void>;
  /** Store a file with the marketplace and return its link. */
  upload(filename: string, bytes: Buffer): Promise<string>;
  download(url: string): Promise<Buffer>;
}

export class AgentMarketClient implements AgentMarketApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let why = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        why = j.message ?? j.error ?? why;
      } catch {
        // not JSON: keep the text
      }
      throw new MarketError(`Agent Market ${method} ${path}: ${why || res.statusText} (${res.status})`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async assignments(status: string, limit: number, offset: number): Promise<AmRow[]> {
    return (await this.call<{ assignments?: AmRow[] }>('GET', `/v1/agents/me/assignments?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`)).assignments ?? [];
  }

  async start(id: string): Promise<void> {
    await this.call('POST', `/v1/assignments/${encodeURIComponent(id)}/start`);
  }

  async progress(id: string, message: string, percent?: number): Promise<void> {
    await this.call('POST', `/v1/assignments/${encodeURIComponent(id)}/progress`, { message: message.slice(0, 280), ...(percent !== undefined ? { percent: Math.round(percent) } : {}) });
  }

  async decline(id: string, reason: 'rejected' | 'failed', detail?: string): Promise<void> {
    await this.call('POST', `/v1/assignments/${encodeURIComponent(id)}/decline`, { reason, ...(detail ? { detail: detail.slice(0, 1000) } : {}) });
  }

  async messages(id: string): Promise<{ body: string; createdAt: string }[]> {
    return (await this.call<{ messages?: { body: string; createdAt: string }[] }>('GET', `/v1/assignments/${encodeURIComponent(id)}/messages?limit=20`)).messages ?? [];
  }

  async message(id: string, body: string, requestId?: string): Promise<void> {
    await this.call('POST', `/v1/assignments/${encodeURIComponent(id)}/messages`, { body: body.slice(0, 4000), ...(requestId ? { clientRequestId: requestId.slice(0, 128) } : {}) });
  }

  async submit(id: string, markdown: string, files: string[]): Promise<void> {
    await this.call('POST', `/v1/assignments/${encodeURIComponent(id)}/submit`, { deliverableMarkdown: markdown, ...(files.length ? { files } : {}) });
  }

  async upload(filename: string, bytes: Buffer): Promise<string> {
    const slot = await this.call<{ fileId: string; directUploadUrl: string; fileUrl?: string | null }>('POST', '/v1/files', { filename, byteSize: bytes.length, link: true });
    // The upload address is signed for exactly these bytes and takes no other headers.
    const put = await this.fetcher(slot.directUploadUrl, { method: 'PUT', body: new Uint8Array(bytes), signal: AbortSignal.timeout(10 * 60_000) });
    if (!put.ok) throw new MarketError(`Agent Market: uploading ${filename} failed (${put.status})`);
    await this.call('POST', `/v1/files/${encodeURIComponent(slot.fileId)}/complete`);
    if (!slot.fileUrl) throw new MarketError(`Agent Market gave no link for ${filename}`);
    return slot.fileUrl;
  }

  async download(url: string): Promise<Buffer> {
    const target = new URL(url, `${this.base}/`);
    // The token goes to the marketplace only, never to another host a link may name.
    const own = target.origin === new URL(this.base).origin;
    const res = await this.fetcher(target, { headers: own ? { authorization: `Bearer ${this.token}` } : {}, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new MarketError(`Agent Market: ${target.pathname} could not be downloaded (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Whether a hire pays at least the listing's floor. Only dollars (USD, USDC) can be compared with it. */
export function hirePrice(sf: Storefront, amount: string, token: string): { ok: boolean; detail: string } {
  const floor = sf.intake.min_price_usd;
  const n = Number(amount);
  if (!['USD', 'USDC'].includes(token.toUpperCase()) || !Number.isFinite(n)) return { ok: floor === 0, detail: `the hire pays ${amount} ${token}, which cannot be compared with the floor of $${floor.toFixed(2)}` };
  return { ok: n >= floor, detail: `the hire pays $${n.toFixed(2)}; the floor is $${floor.toFixed(2)}` };
}

/**
 * A job as an order of the listing: its title and text go to the listing's (first required) text
 * field, each attached file to the first file field that takes its type. `unplaced` are files no
 * field takes.
 */
export function hireInput(sf: Storefront, row: AmRow): { input?: OrderInput; error?: string; attachments: (AmAttachment & { field: string })[]; unplaced: string[]; bytes: number } {
  const text = sf.inputs.find((i) => i.type === 'text' && i.required) ?? sf.inputs.find((i) => i.type === 'text');
  const note = row.latestMessage?.senderSide === 'buyer' && row.latestMessage.body.trim() ? `\n\n## The buyer's message\n${row.latestMessage.body.trim()}` : '';
  const brief = `# ${row.job.title.trim()}\n\n${row.job.description.trim()}${note}`;
  const seen = new Set<string>();
  const attachments: (AmAttachment & { field: string })[] = [];
  const unplaced: string[] = [];
  for (const a of [...(row.job.attachments ?? []), ...(row.latestMessage?.senderSide === 'buyer' ? (row.latestMessage.attachments ?? []) : [])]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const ext = extname(a.filename).toLowerCase();
    const field = sf.inputs.find((i) => i.type === 'files' && (!i.accept || i.accept.map((x) => x.toLowerCase()).includes(ext)));
    if (field) attachments.push({ ...a, field: field.name });
    else unplaced.push(a.filename);
  }
  const bytes = Buffer.byteLength(brief) + attachments.reduce((n, a) => n + a.byteSize, 0);
  if (!text) return { error: 'this listing has no text field to hold a job’s brief', attachments, unplaced, bytes };
  return { input: { v: 1, fields: { [text.name]: brief }, files: attachments.map((a) => ({ field: a.field, name: a.filename, size: a.byteSize, data: '' })) }, attachments, unplaced, bytes };
}

const mb = (n: number) => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What the buyer reads: the result (or where it is), what was checked, and how the receipt can be checked. */
export function deliveryMarkdown(o: { title: string; team: string; files: { name: string; size: number; sha256: string }[]; archive: boolean; inline?: string; gates: { name: string; passed: boolean }[]; receipt: HireReceipt; revision?: number; note?: string }): string {
  const att = o.receipt.attestation;
  const parts = [
    `# ${o.title}`,
    `Delivered by **${o.team}**${o.revision ? ` (revision ${o.revision})` : ''}.`,
    ...(o.note ? [o.note] : []),
    ...(o.inline ? [o.inline.trim()] : []),
    `## Files\n${o.archive ? `All files are in \`${ARCHIVE_NAME}\` (attached):\n` : ''}${o.files.map((f) => `- \`${f.name}\` (${mb(f.size)}), sha256 \`${f.sha256}\``).join('\n')}`,
    `## How this was checked\nThis team's work is sent only when its own checks pass; otherwise the job is handed back and you are refunded.\n${o.gates.map((g) => `- Check "${g.name}": ${g.passed ? 'passed' : 'did not pass'}`).join('\n')}`,
    `## Receipt\n\`${RECEIPT_NAME}\` (attached) is the owner's record of this delivery: the hash of every file, the checks and how they ended, and the hash of the run's log (the log itself holds the team's prompts and stays with the owner). ${
      o.receipt.signature ? `It is signed with the NEAR key \`${o.receipt.public_key}\`${o.receipt.owner ? ` of the account \`${o.receipt.owner}\`` : ''}: an ed25519 signature over the receipt's JSON without the \`signature\` field.` : 'It is not signed: the owner has no NEAR key set up.'
    }${att ? `\n\n${att.calls.filter((c) => c.verified).length} of ${att.calls.length} model calls behind this job ran in a hardware enclave at ${att.provider} and carry its signature, which the owner's software checked. The receipt holds those signatures and the hardware quotes; the quotes were not verified by the owner's software and can be checked with Intel's tools.` : ''}`,
  ];
  return parts.join('\n\n') + '\n';
}

export interface HiresContext {
  store: MarketStore;
  host: RunHost;
  log(line: string): void;
  storefront(teamDir: string): { team: TeamConfig; sf: Storefront };
  /** The owner's keys as they could turn up in a file (a delivery that holds one is held back). */
  ownSecrets(): string[];
  /** A stand-in for the marketplace (tests). */
  api?(team: string): AgentMarketApi | undefined;
}

export class Hires {
  private readonly running = new Map<string, AbortController>();
  private readonly screening = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly reported = new Map<string, number>();
  lastError?: string;

  constructor(private readonly ctx: HiresContext) {}

  private get store(): MarketStore {
    return this.ctx.store;
  }

  /** The teams connected to an agent on the marketplace. */
  connections(): { team: string; baseUrl: string; connectedAt: string }[] {
    return Object.entries(this.store.state().agentMarket).map(([team, c]) => ({ team, ...c }));
  }

  get connected(): boolean {
    return this.connections().length > 0;
  }

  private api(team: string): AgentMarketApi | undefined {
    const stand = this.ctx.api?.(team);
    if (stand) return stand;
    const c = this.store.state().agentMarket[team];
    const token = this.store.agentToken(team);
    return c && token ? new AgentMarketClient(c.baseUrl, token) : undefined;
  }

  private need(team: string): AgentMarketApi {
    const api = this.api(team);
    if (!api) throw new MarketError('this team is not connected to an agent on NEAR AI Agent Market (covibe market agent-market connect <team>)');
    return api;
  }

  /** Connect a team to an agent there with the agent's token (aat_…). The token is tried first, and kept in the secret store. */
  async connect(team: string, token: string, baseUrl = AGENT_MARKET_URL): Promise<void> {
    this.ctx.storefront(team);
    const t = token.trim();
    if (!t) throw new MarketError("the agent's token is missing");
    const url = baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/.test(url)) throw new MarketError('the address starts with http:// or https://');
    if (!this.ctx.api?.(team)) await new AgentMarketClient(url, t).assignments('in_progress', 1, 0);
    this.store.setAgentToken(team, t);
    this.store.update((s) => {
      s.agentMarket[team] = { baseUrl: url, connectedAt: new Date().toISOString() };
    });
    this.ctx.log(`${team}: connected to an agent on ${url}`);
  }

  disconnect(team: string): void {
    this.store.setAgentToken(team, null);
    this.store.update((s) => {
      delete s.agentMarket[team];
    });
  }

  list(): Hire[] {
    return Object.values(this.store.state().hires).sort((a, b) => Number(b.key.slice(1)) - Number(a.key.slice(1)));
  }

  /** Stop the teams working on hires (they wait for the owner afterwards). */
  async close(): Promise<void> {
    for (const c of this.running.values()) c.abort();
    await this.settle();
  }

  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  private async rows(api: AgentMarketApi): Promise<AmRow[]> {
    const out: AmRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await api.assignments('all', PAGE, page * PAGE);
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /** Read each connected agent's assignments and move each hire along. */
  async tick(): Promise<void> {
    let failed: string | undefined;
    for (const { team } of this.connections()) {
      const api = this.api(team);
      if (!api) continue;
      try {
        // Oldest first, so hires are numbered in the order they came.
        for (const row of (await this.rows(api)).reverse()) {
          await this.see(team, api, row).catch((err) => this.problem(row.assignment.assignmentId, err));
        }
      } catch (err) {
        failed = (err as Error).message;
        this.ctx.log(`agent market: ${failed}`);
      }
    }
    this.lastError = failed;
  }

  private problem(id: string, err: unknown): void {
    const message = (err as Error).message;
    const hire = this.store.hire(id);
    this.ctx.log(`hire ${hire?.key ?? id}: ${message}`);
    if (hire) this.store.patchHire(id, { note: message });
  }

  private async see(team: string, api: AgentMarketApi, row: AmRow): Promise<void> {
    // A competition entry is not a hire: nothing is ordered and nothing is held for it.
    if (row.job.jobKind === 'competition') return;
    const a = row.assignment;
    const id = a.assignmentId;
    let hire = this.store.hire(id);
    if (!hire) {
      // Only work that is still to be done is taken on; what ended before covibe was connected is not its to record.
      if (a.status !== 'in_progress') return;
      const delivered = !!a.deliverableUrl;
      this.store.update((s) => {
        s.hires[id] = {
          key: `h${Object.keys(s.hires).length + 1}`,
          assignmentId: id,
          jobId: a.jobId,
          team,
          stage: delivered ? 'needs_owner' : 'new',
          status: a.status,
          title: row.job.title,
          price: a.escrowAmount,
          token: a.escrowToken,
          ...(a.slaDeadlineAt ? { slaDeadlineAt: a.slaDeadlineAt } : {}),
          ...(delivered ? { note: 'This job was delivered once without covibe and is back for changes. covibe has no earlier result to work from: handle it on the marketplace, or fail it to refund the buyer.' } : {}),
          updatedAt: new Date().toISOString(),
        };
      });
      hire = this.store.hire(id)!;
      this.ctx.log(`hire ${hire.key}: new, "${row.job.title}" for ${a.escrowAmount} ${a.escrowToken}`);
      if (delivered) return;
    } else if (hire.status !== a.status || hire.slaDeadlineAt !== a.slaDeadlineAt) {
      if (hire.status !== a.status) this.ctx.log(`hire ${hire.key}: ${a.status.replace('_', ' ')}`);
      hire = this.store.patchHire(id, { status: a.status, ...(a.slaDeadlineAt ? { slaDeadlineAt: a.slaDeadlineAt } : {}) });
    }

    switch (a.status) {
      case 'in_progress': {
        if (this.running.has(id)) return;
        // Delivered by covibe and back in progress: the buyer asked for changes, or a dispute was ruled "redo".
        if (hire.stage === 'delivered' && hire.delivery) return this.changes(api, hire, row);
        if (hire.stage === 'new' || (hire.stage === 'checking' && !this.screening.has(id))) return this.screen(api, hire, row);
        if (hire.stage === 'running') this.store.patchHire(id, { stage: 'needs_owner', note: 'covibe stopped while the team was working on this job. Run it again, or fail it to refund the buyer.' });
        return;
      }
      case 'submitted':
        if (hire.stage !== 'delivered') this.store.patchHire(id, { stage: 'delivered', note: hire.delivery ? undefined : 'Submitted on the marketplace, not by covibe.' });
        return;
      case 'disputed':
        if (hire.stage !== 'delivered' || !hire.note) this.store.patchHire(id, { stage: 'delivered', note: 'The buyer opened a dispute; the marketplace decides it.' });
        return;
      default:
        this.running.get(id)?.abort();
        if (hire.stage !== 'closed') this.store.patchHire(id, { stage: 'closed', note: a.status === 'cancelled' && a.cancelReason ? `Cancelled: ${a.cancelReason}.` : undefined });
    }
  }

  /** The buyer's feedback on a delivery (or a redo ruling): a revision, taken at once while the listing includes it. */
  private async changes(api: AgentMarketApi, hire: Hire, row: AmRow): Promise<void> {
    const id = hire.assignmentId;
    const n = (hire.revisionRun ?? 0) + 1;
    const redo = !row.assignment.submittedAt;
    let note: string | undefined;
    let problem: string | undefined;
    if (redo) note = REDO_NOTE;
    else if (row.latestMessage?.senderSide === 'buyer' && row.latestMessage.body.trim()) {
      note = row.latestMessage.body;
      if (row.latestMessage.truncated) {
        // The list carries the first 4,000 characters; the thread has the rest.
        const full = (await api.messages(id).catch(() => [])).find((m) => m.createdAt === row.latestMessage!.createdAt)?.body;
        if (full) note = full;
      }
      note = note.trim().slice(0, MAX_REVISION_NOTE);
    } else problem = "The buyer asked for changes, but the thread's newest message is not theirs: read the thread on the marketplace.";
    const revision = { n, ...(note ? { note } : {}), ...(problem ? { problem } : {}) };
    const { sf } = this.ctx.storefront(hire.team);
    if (note && n <= sf.revisions.included) {
      this.store.patchHire(id, { revision, revisionRun: n, note: undefined });
      this.ctx.log(`hire ${hire.key}: ${redo ? 'a dispute ruling asks for a redo' : 'the buyer asks for changes'} (revision ${n}, included)`);
      this.launch(id);
      return;
    }
    this.store.patchHire(id, { stage: 'awaiting_owner', revision, recommendation: undefined, note: problem });
    this.ctx.log(`hire ${hire.key}: ${redo ? 'a dispute ruling asks for a redo' : 'the buyer asks for changes'}; waiting for you`);
  }

  private workspaceOf(hire: Hire): string {
    return join(this.store.dir, 'hires', hire.key);
  }

  /** Pre-checks, the workspace and the intake agent, as for an order of the covibe market. Nothing is started before the job is taken. */
  private async screen(api: AgentMarketApi, hire: Hire, row: AmRow): Promise<void> {
    const id = hire.assignmentId;
    this.screening.add(id);
    try {
      this.store.patchHire(id, { stage: 'checking', note: undefined });
      const { sf } = this.ctx.storefront(hire.team);
      const built = hireInput(sf, row);
      const pastCosts = [...Object.values(this.store.state().orders), ...Object.values(this.store.state().hires)].filter((o) => o.team === hire.team && o.costUsd !== undefined).map((o) => o.costUsd!);
      const checks = prechecks({ sf, sealedBytes: built.bytes, input: built.input, inputError: built.error, pastCosts, price: hirePrice(sf, hire.price, hire.token) });
      if (built.unplaced.length) Object.assign(checks.find((c) => c.name === 'file_types')!, { ok: false, detail: `${built.unplaced.join(', ')}: this listing takes no files of that type` });
      const workspace = this.workspaceOf(hire);
      const input = built.input;
      // The buyer's files are fetched only for a job that passed the rules; one that cannot be fetched fails them.
      if (input && checks.every((c) => c.ok)) {
        try {
          for (const [i, a] of built.attachments.entries()) {
            const bytes = await api.download(a.downloadUrl);
            if (bytes.length !== a.byteSize || (a.sha256 && sha256Hex(bytes) !== a.sha256.toLowerCase())) throw new Error(`file "${a.filename}" is not the one the job names`);
            input.files[i]!.data = bytes.toString('base64');
          }
          await writeWorkspace(workspace, sf, input, sf.workspace === 'git');
        } catch (err) {
          Object.assign(checks.find((c) => c.name === 'schema')!, { ok: false, detail: (err as Error).message });
        }
      }
      const failed = checks.filter((c) => !c.ok);
      this.store.patchHire(id, { prechecks: checks, ...(input ? { brief: input.fields, files: fileList(input) } : {}), ...(input && !failed.length ? { workspace } : {}) });

      // The rules covibe enforces come first: a failed pre-check never reaches the agent.
      if (failed.length) {
        const reason = failed.map((c) => c.detail).join('; ');
        this.store.patchHire(id, { stage: 'awaiting_owner', recommendation: { action: 'decline', reason } });
        this.ctx.log(`hire ${hire.key}: pre-checks failed (${failed.map((c) => c.name).join(', ')})`);
        // Nothing would end this job by itself, so in auto mode it goes back at once.
        if (sf.intake.mode === 'auto') await this.decline(hire.key, reason, 'auto');
        return;
      }
      if (sf.intake.mode === 'manual') {
        this.store.patchHire(id, { stage: 'awaiting_owner' });
        this.ctx.log(`hire ${hire.key}: pre-checks passed; waiting for you`);
        return;
      }
      const result = await this.ctx.host.intake({ team: loadIntakeTeam(this.store.home), repo: workspace, prompt: intakePrompt(sf, { id: hire.key, price: `${hire.price} ${hire.token}` }, input!), orderId: hire.key });
      const d = result.decision;
      if (!d) {
        this.store.patchHire(id, { stage: 'awaiting_owner', intakeRunId: result.runId, projectId: result.projectId, note: `The intake agent gave no recommendation: ${result.error ?? 'unknown error'}` });
        return;
      }
      const recommendation = d.decision === 'accept' ? { action: 'accept' as const, reason: d.reason } : { action: 'decline' as const, reason: d.decision === 'need_info' ? `More information is needed: ${d.reason}` : d.reason };
      this.store.patchHire(id, { stage: 'awaiting_owner', intake: d, intakeRunId: result.runId, projectId: result.projectId, recommendation, ...(result.attestation ? { intakeAttestation: result.attestation } : {}) });
      this.ctx.log(`hire ${hire.key}: intake recommends ${recommendation.action} (scope fit ${d.scope_fit.toFixed(2)}): ${d.reason}`);
      if (sf.intake.mode === 'auto') {
        if (recommendation.action === 'decline') await this.decline(hire.key, recommendation.reason, 'auto');
        else if (d.scope_fit >= sf.intake.auto_min_fit) await this.accept(hire.key, 'auto');
        else this.ctx.log(`hire ${hire.key}: scope fit below ${sf.intake.auto_min_fit}; waiting for you`);
      }
    } finally {
      this.screening.delete(id);
    }
  }

  // ---- the owner's decisions

  private mine(ref: string): Hire {
    const hire = this.store.hire(ref);
    if (!hire) throw new MarketError(`${ref} is not one of your hires (covibe market orders lists them)`);
    return hire;
  }

  /** A change request that waits for the owner's answer. */
  private pendingRevision(hire: Hire): boolean {
    return hire.stage === 'awaiting_owner' && !!hire.delivery && !!hire.revision && (hire.revisionRun ?? 0) < hire.revision.n;
  }

  /** Take the job (it is declared started on the marketplace, after which the buyer cannot cancel it), or a change request. */
  async accept(ref: string, by: 'owner' | 'auto' = 'owner'): Promise<void> {
    const hire = this.mine(ref);
    const id = hire.assignmentId;
    if (hire.status !== 'in_progress' || hire.stage !== 'awaiting_owner') throw new MarketError(`hire ${hire.key} is not waiting for an answer`);
    if (this.pendingRevision(hire)) {
      if (!hire.revision!.note) throw new MarketError(`the change request cannot be taken: ${hire.revision!.problem ?? 'it cannot be read'}`);
      this.store.patchHire(id, { revisionRun: hire.revision!.n, note: undefined });
      this.ctx.log(`hire ${hire.key}: revision ${hire.revision!.n} taken`);
      this.launch(id);
      return;
    }
    if (!hire.workspace) throw new MarketError(`hire ${hire.key} cannot be taken: ${hire.recommendation?.reason ?? hire.note ?? 'its brief could not be read'}`);
    await this.need(hire.team).start(id);
    this.ctx.log(`hire ${hire.key}: taken${by === 'auto' ? ' by the intake agent' : ''}`);
    this.store.patchHire(id, { decidedBy: by });
    this.launch(id);
  }

  /**
   * Turn the job down: it is handed back and the buyer is refunded. For a change request, the
   * earlier delivery is submitted again as it was, with the reason, and the buyer decides on that.
   */
  async decline(ref: string, reason?: string, by: 'owner' | 'auto' = 'owner'): Promise<void> {
    const hire = this.mine(ref);
    const id = hire.assignmentId;
    if (hire.status !== 'in_progress' || (hire.stage !== 'awaiting_owner' && hire.stage !== 'new' && hire.stage !== 'checking')) throw new MarketError(`hire ${hire.key} is not waiting for an answer`);
    const api = this.need(hire.team);
    const why = (reason ?? hire.recommendation?.reason ?? '').trim().slice(0, 1000) || undefined;
    if (this.pendingRevision(hire)) {
      const line = `The owner did not take this change request${why ? `: ${why}` : '.'} The earlier delivery stands and is submitted again unchanged.`;
      await api.message(id, line, `covibe-${hire.key}-keep-${hire.revision!.n}`).catch(() => undefined);
      // A note with the date makes this a version of its own, so the job leaves "in progress" again.
      const markdown = `${hire.delivery!.markdown}\n---\n_${new Date().toISOString().slice(0, 10)}: ${line}_\n`;
      await api.submit(id, markdown, hire.delivery!.files);
      this.ctx.log(`hire ${hire.key}: change request turned down; the earlier delivery stands`);
      this.store.patchHire(id, { stage: 'delivered', status: 'submitted', note: undefined, revisionRun: hire.revision!.n, delivery: { ...hire.delivery!, markdown, at: new Date().toISOString() } });
      return;
    }
    await api.decline(id, 'rejected', why);
    this.ctx.log(`hire ${hire.key}: declined${by === 'auto' ? ' by the intake agent' : ''}; the buyer is refunded`);
    this.store.patchHire(id, { stage: 'closed', status: 'cancelled', decidedBy: by, note: why ? `Declined: ${why}` : 'Declined.' });
  }

  /** Give up on a job that was taken: it is handed back and the buyer is refunded in full, an earlier delivery included. */
  async fail(ref: string, reason?: string): Promise<void> {
    const hire = this.mine(ref);
    const id = hire.assignmentId;
    if (hire.status !== 'in_progress') throw new MarketError(`hire ${hire.key} is ${hire.status.replace('_', ' ')}; only a job in progress can be handed back`);
    this.running.get(id)?.abort();
    const why = (reason ?? hire.note ?? '').trim().slice(0, 1000) || undefined;
    await this.need(hire.team).decline(id, 'failed', why);
    this.ctx.log(`hire ${hire.key}: handed back; the buyer is refunded`);
    this.store.patchHire(id, { stage: 'closed', status: 'cancelled', note: why ? `Handed back: ${why}` : 'Handed back.' });
  }

  /** Run the team again on a job that waits for the owner after a run stopped. */
  retry(ref: string): void {
    const hire = this.mine(ref);
    if (hire.status !== 'in_progress' || hire.stage !== 'needs_owner' || !hire.workspace) throw new MarketError(`hire ${hire.key} is not waiting for you after a stopped run`);
    this.launch(hire.assignmentId);
  }

  // ---- the run and the delivery

  private launch(id: string): void {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    this.store.patchHire(id, { stage: 'running', note: undefined, runStatus: undefined, gates: undefined });
    const job = this.work(id, controller.signal)
      .catch((err) => {
        const hire = this.store.hire(id);
        this.ctx.log(`hire ${hire?.key ?? id}: ${(err as Error).message}`);
        if (hire?.status === 'in_progress') this.store.patchHire(id, { stage: 'needs_owner', note: (err as Error).message });
      })
      .finally(() => {
        this.running.delete(id);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }

  /** Tell the buyer where the work stands: steps and checks by name, never prompts. At most one report in half a minute is taken. */
  private report(api: AgentMarketApi, id: string, message: string, force = false): void {
    const last = this.reported.get(id) ?? 0;
    if (!force && Date.now() - last < PROGRESS_EVERY_MS) return;
    this.reported.set(id, Date.now());
    void api.progress(id, message).catch(() => undefined);
  }

  private feed(api: AgentMarketApi, id: string, e: RunEvent): void {
    if (e.type === 'step.started') this.report(api, id, `Step "${e.step}" started${Number(e.data.loop) > 0 ? ` (fix round ${String(e.data.loop)})` : ''}.`);
    else if (e.type === 'gate.passed') this.report(api, id, `Check "${e.step}" passed.`);
    else if (e.type === 'gate.failed') this.report(api, id, `Check "${e.step}" did not pass; the team is fixing what it found.`);
  }

  private async work(id: string, signal: AbortSignal): Promise<void> {
    const hire = this.mine(id);
    const api = this.need(hire.team);
    const { team: asWritten, sf } = this.ctx.storefront(hire.team);
    // The job is a stranger's: whatever the team file allows, its members work confined (see engine/confine.ts).
    const team = confineTeam(asWritten, { network: sf.network });
    const workspace = hire.workspace;
    if (!workspace || !existsSync(join(workspace, 'ORDER.md'))) throw new MarketError('the job has no workspace; its brief could not be read');
    const revising = (hire.revisionRun ?? 0) > 0 && hire.revision?.note ? { n: hire.revisionRun!, note: hire.revision.note } : undefined;
    if (revising && hire.resultBranch) {
      try {
        execFileSync('git', ['merge', '--ff-only', hire.resultBranch], { cwd: workspace, stdio: 'ignore' });
      } catch {
        // not a fast-forward (or no such branch): the team works from the checkout as it is
      }
    }
    this.report(api, id, revising ? `The team started on your changes (revision ${revising.n}).` : 'The team took the job and started working.', true);
    const orderText = readFileSync(join(workspace, 'ORDER.md'), 'utf8');
    const result = await this.ctx.host.run({
      team,
      repo: workspace,
      goal: revising ? revisionGoal(sf, orderText, revising.note, revising.n) : orderGoal(sf, orderText),
      budgetUsd: sf.intake.budget_cap_usd,
      env: confinedEnv(process.env, team),
      signal,
      onStart: (runId, projectId) => {
        this.store.patchHire(id, { runId, ...(projectId ? { projectId } : {}) });
        this.ctx.log(`hire ${hire.key}: run ${runId} started`);
      },
      onEvent: (e) => this.feed(api, id, e),
    });
    const gates = gateResults(result.events, requiredGates(sf, team));
    this.store.patchHire(id, { runStatus: result.status, costUsd: result.costUsd, gates });
    // The job may have ended while the team worked (the buyer cancelled it, or the owner handed it back).
    const now = (await this.rows(api)).find((r) => r.assignment.assignmentId === id)?.assignment.status;
    if (now !== 'in_progress') {
      this.store.patchHire(id, { stage: now === 'submitted' || now === 'disputed' ? 'delivered' : 'closed', ...(now ? { status: now } : {}) });
      return;
    }
    if (signal.aborted) {
      this.store.patchHire(id, { stage: 'needs_owner', note: 'The run was stopped. Run it again, or fail the job to refund the buyer.' });
      return;
    }
    const passed = result.status === 'succeeded' && gates.length > 0 && gates.every((g) => g.passed);
    if (passed) return this.deliver(api, id, sf, workspace, orderText, result, gates, revising?.n);

    const failedGates = gates.filter((g) => !g.passed).map((g) => g.name);
    const why = result.budgetExceeded
      ? `The run reached this listing's spend cap of $${sf.intake.budget_cap_usd.toFixed(2)} before it was done.`
      : failedGates.length && result.status !== 'failed'
        ? `The team's checks did not pass (${failedGates.join(', ')}).`
        : `The run ${result.status === 'succeeded' ? 'ended without passing its checks' : result.status}${result.reason ? `: ${result.reason}` : ''}.`;
    this.ctx.log(`hire ${hire.key}: not delivered. ${why}`);
    // auto: a first run whose checks did not pass refunds the buyer without waiting. A revision that
    // did not pass comes to the owner, since handing the job back would also undo the delivery before it.
    if (!revising && sf.intake.mode === 'auto' && !result.budgetExceeded) {
      this.store.patchHire(id, { note: why });
      await this.fail(hire.key, "The team's checks did not pass, so nothing was delivered.");
      return;
    }
    this.store.patchHire(id, { stage: 'needs_owner', note: `${why} Run it again, or fail the job to refund the buyer${revising ? ' (that hands back the whole job, the earlier delivery included)' : ''}.` });
    this.report(api, id, 'The run stopped before the checks passed. The owner is looking at it.', true);
  }

  private async deliver(api: AgentMarketApi, id: string, sf: Storefront, workspace: string, orderText: string, result: RunResult, gates: { name: string; passed: boolean }[], revision?: number): Promise<void> {
    const hire = this.mine(id);
    const hold = 'Look at the files, then run the job again or fail it to refund the buyer.';
    let collected: { files: DeliverableFile[]; done(): void };
    try {
      collected = collectDeliverables(workspace, sf.deliverables.folder, result.branch, MAX_BYTES);
    } catch (err) {
      throw new MarketError(`the delivery was held back: ${(err as Error).message}, and NEAR AI Agent Market takes 100 MB per delivery. ${hold}`);
    }
    const { files, done } = collected;
    try {
      if (!files.length) throw new MarketError(`the checks passed, but ${sf.deliverables.folder}/ is empty: there is nothing to deliver`);
      // Nothing that looks like a key leaves the machine on a job's word, in any intake mode.
      const leaks = secretsIn(files, this.ctx.ownSecrets());
      if (leaks.length) throw new MarketError(`the delivery was held back: ${leaks.map((l) => `${sf.deliverables.folder}/${l.name} looks like it holds ${l.what}`).join('; ')}. ${hold}`);

      const listed = files.map((f) => ({ name: f.name, size: f.size, sha256: sha256Hex(readFileSync(f.path)) }));
      const key = this.store.nearKey();
      const attestation = receiptAttestation(result.events, hire.intakeAttestation);
      const body: Omit<HireReceipt, 'public_key' | 'signature'> = {
        v: 1,
        market: 'near-ai-agent-market',
        assignment_id: id,
        job_id: hire.jobId,
        input_hash: sha256Hex(orderText),
        files: listed,
        run_status: result.status,
        gates,
        event_log_hash: eventLogHash(result.events),
        started: result.events[0]?.ts ?? new Date().toISOString(),
        finished: result.events[result.events.length - 1]?.ts ?? new Date().toISOString(),
        owner: this.store.settings().accountId,
        ...(attestation ? { attestation } : {}),
      };
      const receipt: HireReceipt = key ? signReceipt(body, key) : { ...body, public_key: '' };
      const receiptJson = Buffer.from(JSON.stringify(receipt, null, 2));

      // The marketplace takes a few flat files: more than that, or files in folders, go as one archive.
      const archive = files.length > MAX_FILES - 1 || files.some((f) => f.name.includes('/'));
      const uploads = archive ? [{ name: ARCHIVE_NAME, bytes: zipFiles(files) }] : files.map((f) => ({ name: f.name, bytes: readFileSync(f.path) }));
      uploads.push({ name: RECEIPT_NAME, bytes: receiptJson });
      const total = uploads.reduce((n, u) => n + u.bytes.length, 0);
      if (total > MAX_BYTES) throw new MarketError(`the delivery was held back: it is ${mb(total)}, and NEAR AI Agent Market takes 100 MB per delivery. ${hold}`);

      const only = files.length === 1 && ['.md', '.txt'].includes(extname(files[0]!.name).toLowerCase()) && files[0]!.size <= MAX_INLINE ? readFileSync(files[0]!.path, 'utf8') : undefined;
      const markdown = deliveryMarkdown({ title: hire.title, team: sf.title, files: listed, archive, inline: only, gates, receipt, revision });
      if (Buffer.byteLength(markdown) > MAX_MARKDOWN) throw new MarketError(`the delivery was held back: its text is larger than the marketplace takes. ${hold}`);

      this.report(api, id, `The checks passed. Uploading ${files.length === 1 ? 'the result' : `${files.length} files`}…`, true);
      const links: string[] = [];
      for (const u of uploads) links.push(await api.upload(u.name, u.bytes));
      await api.submit(id, markdown, links);
      this.ctx.log(`hire ${hire.key}: delivered, ${files.length} file${files.length === 1 ? '' : 's'}${archive ? ' in one archive' : ''}`);
      if (attestation) this.ctx.log(`hire ${hire.key}: ${attestation.calls.filter((c) => c.verified).length} of ${attestation.calls.length} model calls carry a checked enclave signature (${attestation.provider})`);
      this.store.patchHire(id, { stage: 'delivered', status: 'submitted', note: undefined, resultBranch: result.branch, delivery: { markdown, files: links, receiptHash: sha256Hex(receiptJson), at: new Date().toISOString() } });
    } finally {
      done();
    }
  }
}
