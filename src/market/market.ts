// The owner's side of the market: publish a team's storefront, watch the
// contract for orders, screen them, run the team, deliver, and collect.
//
// The chain is the source of truth for an order's status. What is kept here
// (MarketStore) is the owner's working state: what the customer sent, what the
// checks and the intake agent said, which run works on it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TeamConfig } from '../config/types.js';
import { confinedEnv, confineTeam } from '../engine/confine.js';
import type { SecretStore } from '../connections/secrets.js';
import type { RunEvent } from '../events/types.js';
import { open, seal, sha256Hex } from './crypto.js';
import { putFile } from './blobs.js';
import { collectDeliverables, eventLogHash, gateResults, mediaType, secretsIn, signReceipt } from './delivery.js';
import type { RunHost, RunResult } from './host.js';
import { fileList, intakePrompt, loadIntakeTeam, orderGoal, parseInput, prechecks, writeWorkspace } from './intake.js';
import { explorerUrl, NearChain, yoctoToNear, type MarketChain } from './near.js';
import { RelayClient, type Relay } from './relay.js';
import { buildMeta, listingInput, loadStorefront, metaJson, requiredGates, STOREFRONT_FILE } from './storefront.js';
import { MarketStore } from './store.js';
import { MarketError, OPEN_STATUSES, type Delivery, type Earnings, type Listing, type LocalOrder, type MarketSettings, type Order, type OrderInput, type Overview, type Storefront } from './types.js';

const PAGE = 50;
/** Local clocks and block time differ a little; wait this long past a window before acting on it. */
const CLOCK_MARGIN_MS = 5_000;
/** The most one delivery may hold. Files go to the relay in chunks, so this is a sanity limit, not the relay's. */
const MAX_DELIVERY_BYTES = 8 * 2 ** 30;

export interface MarketOptions {
  home: string;
  secrets: SecretStore;
  host: RunHost;
  /** Stand-ins for the chain and the relay (tests). */
  chain?: MarketChain;
  relay?: Relay;
  log?(line: string): void;
}

export class Market {
  readonly store: MarketStore;
  private readonly host: RunHost;
  private readonly log: (line: string) => void;
  private chainCache?: { key: string; chain: MarketChain };
  private readonly fixedChain?: MarketChain;
  private readonly fixedRelay?: Relay;
  /** Orders a team is working on in this process, and how to stop them. */
  private readonly running = new Map<number, AbortController>();
  /** Runs and deliveries in flight (tests wait for them). */
  private readonly jobs = new Set<Promise<void>>();
  private readonly chainListings = new Map<number, Listing>();
  private ticking = false;
  private timer?: NodeJS.Timeout;
  lastTick?: string;
  lastError?: string;

  constructor(opts: MarketOptions) {
    this.store = new MarketStore(opts.home, opts.secrets);
    this.host = opts.host;
    this.fixedChain = opts.chain;
    this.fixedRelay = opts.relay;
    this.log = opts.log ?? (() => undefined);
  }

  // ---- connections

  settings(): MarketSettings {
    return this.store.settings();
  }

  /** Change the settings; `privateKey` (a NEAR key, or null to forget it) goes to the secret store. */
  configure(patch: Partial<MarketSettings> & { privateKey?: string | null }): MarketSettings {
    const { privateKey, ...rest } = patch;
    if (privateKey !== undefined) {
      try {
        this.store.setNearKey(privateKey);
      } catch (err) {
        throw new MarketError(`that is not a NEAR key: ${(err as Error).message}`);
      }
    }
    this.chainCache = undefined;
    return this.store.saveSettings(rest);
  }

  chain(): MarketChain {
    if (this.fixedChain) return this.fixedChain;
    const s = this.settings();
    const key = this.store.nearKey();
    const id = [s.rpcUrl, s.contractId, s.accountId, key ? sha256Hex(key) : ''].join('|');
    if (this.chainCache?.key !== id) this.chainCache = { key: id, chain: new NearChain(s.rpcUrl, s.contractId, s.accountId || undefined, key) };
    return this.chainCache.chain;
  }

  relay(): Relay {
    if (this.fixedRelay) return this.fixedRelay;
    const s = this.settings();
    return new RelayClient(s.relayUrl, s.accountId || undefined, this.store.nearKey());
  }

  private missing(): string[] {
    if (this.fixedChain) return [];
    const s = this.settings();
    return [...(s.contractId ? [] : ['the market contract']), ...(s.accountId ? [] : ['your NEAR account']), ...(this.store.nearKey() ? [] : ['your NEAR key']), ...(s.relayUrl ? [] : ['the relay'])];
  }

  private requireReady(): void {
    const missing = this.missing();
    if (missing.length) throw new MarketError(`the market is not set up yet: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing (covibe market config, or Market → Settings in the app)`);
  }

  private storefrontOf(teamDir: string): { team: TeamConfig; sf: Storefront } {
    const team = this.host.loadTeam(join(teamDir, 'team.yaml'));
    return { team, sf: loadStorefront(teamDir, team) };
  }

  listingUrl(listingId: number): string {
    return `${this.settings().storefrontUrl.replace(/\/+$/, '')}/#/listing/${listingId}`;
  }

  // ---- storefronts

  /** Publish a team's storefront: create its listing (or update it) on-chain and put its page in the relay. */
  async publish(teamDir: string): Promise<{ listingId: number; tx: string; created: boolean; url: string }> {
    this.requireReady();
    const { sf } = this.storefrontOf(teamDir);
    const chain = this.chain();
    const relay = this.relay();
    const meta = metaJson(await buildMeta(sf, teamDir, relay));
    const input = listingInput(sf, meta.hash, this.store.intakeKey().publicKey);
    const known = this.store.state().listings[teamDir];
    const existing = known && known.contractId === chain.contractId ? known : undefined;
    let listingId: number;
    let tx: string;
    if (existing) {
      listingId = existing.listingId;
      tx = (await chain.updateListing(listingId, input)).tx;
    } else {
      const out = await chain.createListing(input);
      listingId = out.value;
      tx = out.tx;
    }
    await relay.putListingMeta(listingId, meta.json);
    this.store.update((s) => {
      s.listings[teamDir] = { listingId, contractId: chain.contractId, metaHash: meta.hash, publishedAt: new Date().toISOString() };
    });
    this.log(`listing ${listingId} ${existing ? 'updated' : 'created'}: ${this.listingUrl(listingId)}`);
    return { listingId, tx, created: !existing, url: this.listingUrl(listingId) };
  }

  /** Open or close a published storefront for new orders. */
  async setActive(teamDir: string, active: boolean): Promise<string> {
    this.requireReady();
    const known = this.store.state().listings[teamDir];
    if (!known) throw new MarketError('this team is not published yet');
    const { tx } = await this.chain().setActive(known.listingId, active);
    this.chainListings.delete(known.listingId);
    return tx;
  }

  // ---- the watch loop

  /** Poll for orders every few seconds until stop(). */
  start(): void {
    if (this.timer) return;
    const loop = () => {
      void this.tick().finally(() => {
        if (this.timer) this.timer = setTimeout(loop, this.settings().pollSeconds * 1000);
      });
    };
    this.timer = setTimeout(loop, 500);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get watching(): boolean {
    return !!this.timer;
  }

  /** Stop watching and stop the teams working on orders (they wait for the owner afterwards). */
  async close(): Promise<void> {
    this.stop();
    for (const c of this.running.values()) c.abort();
    await this.settle();
  }

  /** Wait for runs and deliveries in flight. */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  /** Read every published listing's orders from the chain and move each one along. */
  async tick(): Promise<void> {
    if (this.ticking || this.missing().length) return;
    this.ticking = true;
    try {
      const chain = this.chain();
      for (const [team, l] of Object.entries(this.store.state().listings)) {
        if (l.contractId !== chain.contractId) continue;
        const listing = await chain.listing(l.listingId);
        if (!listing) continue;
        this.chainListings.set(listing.id, listing);
        for (let from = 0; ; from += PAGE) {
          const page = await chain.orders(l.listingId, from, PAGE);
          for (const order of page) await this.see(team, listing, order).catch((err) => this.problem(order.id, err));
          if (page.length < PAGE) break;
        }
      }
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log(`market: ${this.lastError}`);
    } finally {
      this.lastTick = new Date().toISOString();
      this.ticking = false;
    }
  }

  private problem(id: number, err: unknown): void {
    const message = (err as Error).message;
    this.log(`order ${id}: ${message}`);
    if (this.store.order(id)) this.store.patchOrder(id, { note: message });
  }

  /** One order as the chain has it now: record it, and do what its status calls for. */
  private async see(team: string, listing: Listing, order: Order): Promise<void> {
    let local = this.store.order(order.id);
    if (!local) {
      const open = OPEN_STATUSES.includes(order.status);
      this.store.update((s) => {
        s.orders[String(order.id)] = { id: order.id, listingId: order.listing_id, team, stage: open ? 'new' : 'closed', chain: order, txs: {}, updatedAt: new Date().toISOString() };
      });
      local = this.store.order(order.id)!;
      if (open) this.log(`order ${order.id}: new, ${yoctoToNear(order.price)} NEAR from ${order.customer}`);
    } else if (local.chain.status !== order.status) {
      this.log(`order ${order.id}: ${order.status.toLowerCase()}`);
      local = this.store.patchOrder(order.id, { chain: order });
    }

    switch (order.status) {
      case 'PLACED':
        // "checking" left behind by a stop mid-screening is screened again.
        if (local.stage === 'new' || (local.stage === 'checking' && !this.screening.has(order.id))) await this.screen(team, local);
        return;
      case 'ACCEPTED':
        if (this.running.has(order.id)) return;
        // Accepted from elsewhere (the CLI while the app watches, say): the team starts here.
        if (local.stage === 'new' || local.stage === 'checking' || local.stage === 'awaiting_owner') {
          if (!local.workspace) await this.screen(team, local, true);
          this.launch(order.id);
        } else if (local.stage === 'running') this.store.patchOrder(order.id, { stage: 'needs_owner', note: 'covibe stopped while the team was working on this order. Run it again, or fail it to refund the customer.' });
        return;
      case 'DELIVERED':
        if (local.stage !== 'delivered') this.store.patchOrder(order.id, { stage: 'delivered' });
        if (Date.now() > (order.delivered_at ?? 0) + listing.review_window_s * 1000 + CLOCK_MARGIN_MS) {
          const { tx } = await this.chain().settleOrder(order.id);
          this.log(`order ${order.id}: review window over, settled (${tx})`);
          this.store.patchOrder(order.id, { txs: { settle: tx } });
        }
        return;
      default:
        this.running.get(order.id)?.abort();
        if (local.stage !== 'closed') this.store.patchOrder(order.id, { stage: 'closed', chain: order });
    }
  }

  private readonly screening = new Set<number>();

  private workspaceOf(id: number): string {
    return join(this.store.dir, 'orders', `order-${id}`);
  }

  /**
   * Fetch and decrypt the order, run the pre-checks, lay out the workspace and
   * ask the intake agent. `only` skips the decision (the order is accepted already).
   */
  private async screen(team: string, local: LocalOrder, only = false): Promise<void> {
    const id = local.id;
    this.screening.add(id);
    try {
      this.store.patchOrder(id, { stage: 'checking', note: undefined });
      const { sf } = this.storefrontOf(team);
      let sealedBytes = 0;
      let input: OrderInput | undefined;
      let inputError: string | undefined;
      try {
        const sealed = await this.relay().orderInput(id);
        sealedBytes = sealed.length;
        if (sha256Hex(sealed) !== local.chain.input_hash) throw new Error('the input in the relay does not match the hash on-chain');
        input = parseInput(open(sealed, this.store.intakeKey().privateKey));
      } catch (err) {
        inputError = `the order's input cannot be read: ${(err as Error).message}`;
      }
      const pastCosts = Object.values(this.store.state().orders).filter((o) => o.team === team && o.costUsd !== undefined).map((o) => o.costUsd!);
      const checks = prechecks({ sf, order: local.chain, sealedBytes, input, inputError, pastCosts });
      const workspace = this.workspaceOf(id);
      // The customer's files are fetched only for an order that passed the rules; one that cannot be fetched fails them.
      if (input && checks.every((c) => c.ok)) {
        if (input.files.some((f) => f.blob)) this.log(`order ${id}: fetching ${input.files.length} file${input.files.length === 1 ? '' : 's'} from the relay`);
        await writeWorkspace(workspace, sf, input, sf.workspace === 'git', this.relay()).catch((err) => {
          Object.assign(checks.find((c) => c.name === 'schema')!, { ok: false, detail: (err as Error).message });
        });
      }
      const failed = checks.filter((c) => !c.ok);
      this.store.patchOrder(id, {
        prechecks: checks,
        ...(input ? { brief: input.fields, files: fileList(input), ...(input.reply_pubkey ? { replyKey: input.reply_pubkey } : {}) } : {}),
        ...(input && !failed.length ? { workspace } : {}),
      });
      if (only) return;

      // The rules covibe enforces come first: a failed pre-check never reaches the agent.
      if (failed.length) {
        this.store.patchOrder(id, { stage: 'awaiting_owner', recommendation: { action: 'decline', reason: failed.map((c) => c.detail).join('; ') } });
        this.log(`order ${id}: pre-checks failed (${failed.map((c) => c.name).join(', ')}); waiting for you`);
        return;
      }
      if (sf.intake.mode === 'manual') {
        this.store.patchOrder(id, { stage: 'awaiting_owner' });
        this.log(`order ${id}: pre-checks passed; waiting for you`);
        return;
      }
      const result = await this.host.intake({ team: loadIntakeTeam(this.store.home), repo: workspace, prompt: intakePrompt(sf, local.chain, input!), orderId: id });
      const d = result.decision;
      if (!d) {
        this.store.patchOrder(id, { stage: 'awaiting_owner', intakeRunId: result.runId, projectId: result.projectId, note: `The intake agent gave no recommendation: ${result.error ?? 'unknown error'}` });
        return;
      }
      const recommendation = d.decision === 'accept' ? { action: 'accept' as const, reason: d.reason } : { action: 'decline' as const, reason: d.decision === 'need_info' ? `More information is needed: ${d.reason}` : d.reason };
      this.store.patchOrder(id, { stage: 'awaiting_owner', intake: d, intakeRunId: result.runId, projectId: result.projectId, recommendation });
      this.log(`order ${id}: intake recommends ${recommendation.action} (scope fit ${d.scope_fit.toFixed(2)}): ${d.reason}`);
      // auto: taking an order is what costs the owner, so that needs a good fit; a decline only refunds.
      if (sf.intake.mode === 'auto') {
        if (recommendation.action === 'decline') await this.decline(id, recommendation.reason, 'auto');
        else if (d.scope_fit >= sf.intake.auto_min_fit) await this.accept(id, 'auto');
        else this.log(`order ${id}: scope fit below ${sf.intake.auto_min_fit}; waiting for you`);
      }
    } finally {
      this.screening.delete(id);
    }
  }

  // ---- the owner's decisions

  private mine(id: number): LocalOrder {
    const local = this.store.order(id);
    if (!local) throw new MarketError(`order ${id} is not one of yours (covibe market orders lists them)`);
    return local;
  }

  /** Take the order: accept_order on-chain, then the team starts. */
  async accept(id: number, by: 'owner' | 'auto' = 'owner'): Promise<string> {
    this.requireReady();
    const local = this.mine(id);
    if (local.chain.status !== 'PLACED') throw new MarketError(`order ${id} is ${local.chain.status.toLowerCase()}, not waiting for an answer`);
    if (!local.workspace) throw new MarketError(`order ${id} cannot be taken: ${local.recommendation?.reason ?? local.note ?? 'its input could not be read'}`);
    const { tx } = await this.chain().acceptOrder(id);
    this.log(`order ${id}: accepted${by === 'auto' ? ' by the intake agent' : ''} (${tx})`);
    this.store.patchOrder(id, { decidedBy: by, txs: { accept: tx }, chain: { ...local.chain, status: 'ACCEPTED', accepted_at: Date.now() } });
    this.launch(id);
    return tx;
  }

  /** Turn the order down: the customer is refunded at once and reads the reason. */
  async decline(id: number, reason?: string, by: 'owner' | 'auto' = 'owner'): Promise<string> {
    this.requireReady();
    const local = this.mine(id);
    if (local.chain.status !== 'PLACED') throw new MarketError(`order ${id} is ${local.chain.status.toLowerCase()}, not waiting for an answer`);
    const why = (reason ?? local.recommendation?.reason ?? '').slice(0, 280) || undefined;
    const { tx } = await this.chain().declineOrder(id, why);
    this.log(`order ${id}: declined${by === 'auto' ? ' by the intake agent' : ''} (${tx})`);
    this.store.patchOrder(id, { stage: 'closed', decidedBy: by, txs: { decline: tx }, chain: { ...local.chain, status: 'DECLINED', reason: why ?? null, closed_at: Date.now() } });
    return tx;
  }

  /** Give up on an accepted order: the customer is refunded. */
  async fail(id: number, reason?: string): Promise<string> {
    this.requireReady();
    const local = this.mine(id);
    if (local.chain.status !== 'ACCEPTED') throw new MarketError(`order ${id} is ${local.chain.status.toLowerCase()}; only an accepted order can be failed`);
    this.running.get(id)?.abort();
    const why = (reason ?? local.note ?? '').slice(0, 280) || undefined;
    const { tx } = await this.chain().failOrder(id, why);
    this.log(`order ${id}: failed and refunded (${tx})`);
    this.store.patchOrder(id, { stage: 'closed', txs: { fail: tx }, chain: { ...local.chain, status: 'FAILED', reason: why ?? null, closed_at: Date.now() } });
    void this.status(id, 'failed', 'The team could not complete this order. You have been refunded.');
    return tx;
  }

  /** Run the team again on an order that waits for the owner. */
  retry(id: number): void {
    this.requireReady();
    const local = this.mine(id);
    if (local.chain.status !== 'ACCEPTED' || local.stage !== 'needs_owner') throw new MarketError(`order ${id} is not waiting for you after a stopped run`);
    this.launch(id);
  }

  // ---- the run and the delivery

  private launch(id: number): void {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    this.store.patchOrder(id, { stage: 'running', note: undefined, runStatus: undefined, gates: undefined });
    const job = this.work(id, controller.signal)
      .catch((err) => {
        this.log(`order ${id}: ${(err as Error).message}`);
        if (this.store.order(id)?.chain.status === 'ACCEPTED') this.store.patchOrder(id, { stage: 'needs_owner', note: (err as Error).message });
      })
      .finally(() => {
        this.running.delete(id);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }

  private async status(id: number, state: string, text: string): Promise<void> {
    await this.relay().postStatus(id, state, text).catch(() => undefined);
  }

  /** What the customer may see of a run: steps and checks by name, never prompts or the board. */
  private feed(id: number, e: RunEvent): void {
    if (e.type === 'step.started') void this.status(id, 'working', `Step "${e.step}" started${Number(e.data.loop) > 0 ? ` (fix round ${String(e.data.loop)})` : ''}.`);
    else if (e.type === 'gate.passed') void this.status(id, 'check_passed', `Check "${e.step}" passed.`);
    else if (e.type === 'gate.failed') void this.status(id, 'check_failed', `Check "${e.step}" did not pass.`);
    else if (e.type === 'loop.goto') void this.status(id, 'fixing', 'The team is fixing what the check found.');
  }

  private async work(id: number, signal: AbortSignal): Promise<void> {
    const local = this.mine(id);
    const { team: asWritten, sf } = this.storefrontOf(local.team);
    // The order is a stranger's: whatever the team file allows, its members work confined (see engine/confine.ts).
    const team = confineTeam(asWritten, { network: sf.network });
    const workspace = local.workspace;
    if (!workspace || !existsSync(join(workspace, 'ORDER.md'))) throw new MarketError('the order has no workspace; its input could not be read');
    await this.status(id, 'accepted', 'The team took your order and started working.');
    const result = await this.host.run({
      team,
      repo: workspace,
      goal: orderGoal(sf, readFileSync(join(workspace, 'ORDER.md'), 'utf8')),
      budgetUsd: sf.intake.budget_cap_usd,
      env: confinedEnv(process.env, team),
      signal,
      onStart: (runId, projectId) => {
        this.store.patchOrder(id, { runId, ...(projectId ? { projectId } : {}) });
        this.log(`order ${id}: run ${runId} started`);
      },
      onEvent: (e) => this.feed(id, e),
    });
    const gates = gateResults(result.events, requiredGates(sf, team));
    this.store.patchOrder(id, { runStatus: result.status, costUsd: result.costUsd, gates });
    // The order may have ended while the team worked (it expired, or the owner failed it).
    const now = await this.chain().order(id);
    if (!now || now.status !== 'ACCEPTED') {
      if (now) this.store.patchOrder(id, { stage: 'closed', chain: now });
      return;
    }
    if (signal.aborted) {
      this.store.patchOrder(id, { stage: 'needs_owner', note: 'The run was stopped. Run it again, or fail the order to refund the customer.' });
      return;
    }
    const passed = result.status === 'succeeded' && gates.length > 0 && gates.every((g) => g.passed);
    if (passed) return this.deliver(id, sf, workspace, result, gates);

    const failedGates = gates.filter((g) => !g.passed).map((g) => g.name);
    const why = result.budgetExceeded
      ? `The run reached this listing's spend cap of $${sf.intake.budget_cap_usd.toFixed(2)} before it was done.`
      : failedGates.length && result.status !== 'failed'
        ? `The team's checks did not pass (${failedGates.join(', ')}).`
        : `The run ${result.status === 'succeeded' ? 'ended without passing its checks' : result.status}${result.reason ? `: ${result.reason}` : ''}.`;
    this.log(`order ${id}: not delivered. ${why}`);
    // auto: checks that did not pass refund the customer without waiting. The spend cap always comes to the owner.
    if (sf.intake.mode === 'auto' && !result.budgetExceeded) {
      this.store.patchOrder(id, { note: why });
      await this.fail(id, "The team's checks did not pass, so the order was not delivered.");
      return;
    }
    this.store.patchOrder(id, { stage: 'needs_owner', note: `${why} Run it again, or fail the order to refund the customer.` });
    await this.status(id, 'waiting', 'The run stopped before the checks passed. The owner is looking at it.');
  }

  private async deliver(id: number, sf: Storefront, workspace: string, result: RunResult, gates: { name: string; passed: boolean }[]): Promise<void> {
    const local = this.mine(id);
    const relay = this.relay();
    const chain = this.chain();
    const key = this.store.nearKey();
    if (!key && !this.fixedChain) throw new MarketError('your NEAR key is missing, so the receipt cannot be signed');
    // Each file goes to the relay in encrypted chunks; the bundle is the sealed list of them.
    const { files, done } = collectDeliverables(workspace, sf.deliverables.folder, result.branch, MAX_DELIVERY_BYTES);
    const delivery: Delivery = { v: 2, files: [] };
    try {
      if (!files.length) throw new MarketError(`the checks passed, but ${sf.deliverables.folder}/ is empty: there is nothing to deliver`);
      // Nothing that looks like a key leaves the machine on an order's word, in any intake mode.
      const leaks = secretsIn(files, this.ownSecrets());
      if (leaks.length) {
        await this.status(id, 'waiting', 'The result is being checked by the owner before it is sent.');
        throw new MarketError(`the delivery was held back: ${leaks.map((l) => `${sf.deliverables.folder}/${l.name} looks like it holds ${l.what}`).join('; ')}. Look at the files before anything else. Run the order again, or fail it to refund the customer.`);
      }
      await this.status(id, 'uploading', `The checks passed. Uploading ${files.length === 1 ? 'the result' : `${files.length} files`}…`);
      for (const f of files) {
        const type = mediaType(f.name);
        delivery.files.push({ name: f.name, ...(await putFile(relay, f.path)), ...(type ? { type } : {}) });
      }
    } finally {
      done();
    }
    const entries = delivery.files;
    const manifest = Buffer.from(JSON.stringify(delivery));
    const replyKey = local.replyKey;
    const bundle = replyKey ? seal(manifest, replyKey) : manifest;
    const bundleHash = await relay.putBundle(id, bundle);
    if (bundleHash !== sha256Hex(bundle)) throw new MarketError('the relay stored a different bundle than was sent');
    const started = result.events[0]?.ts ?? new Date().toISOString();
    const finished = result.events[result.events.length - 1]?.ts ?? new Date().toISOString();
    const body = { v: 1 as const, contract: chain.contractId, order_id: id, listing_id: local.listingId, input_hash: local.chain.input_hash, bundle_hash: bundleHash, run_status: result.status, gates, event_log_hash: eventLogHash(result.events), started, finished, owner: local.chain.owner };
    const receipt = JSON.stringify(key ? signReceipt(body, key) : { ...body, public_key: '' });
    await relay.putReceipt(id, receipt);
    const { tx } = await chain.deliverOrder(id, sha256Hex(receipt), bundleHash);
    this.log(`order ${id}: delivered, ${entries.length} file${entries.length === 1 ? '' : 's'} (${tx})`);
    this.store.patchOrder(id, { stage: 'delivered', txs: { deliver: tx }, chain: { ...local.chain, status: 'DELIVERED', delivered_at: Date.now(), bundle_hash: bundleHash, receipt_hash: sha256Hex(receipt) } });
    await this.status(id, 'delivered', 'Your order is ready to download. Review it and confirm, or dispute it within the review window.');
  }

  /** The owner's keys as they could turn up in a file: the NEAR key (with and without its prefix) and the key orders are encrypted to. */
  private ownSecrets(): string[] {
    const near = this.store.nearKey();
    return [...(near ? [near, near.replace(/^ed25519:/, '')] : []), this.store.intakeKey().privateKey];
  }

  // ---- what the app and the CLI show

  earnings(): Earnings {
    let earned = 0n;
    let fees = 0n;
    let inReview = 0n;
    let inEscrow = 0n;
    let settled = 0;
    let refunded = 0;
    for (const o of Object.values(this.store.state().orders)) {
      const price = BigInt(o.chain.price);
      const fee = (price * BigInt(o.chain.fee_bps)) / 10_000n;
      if (o.chain.status === 'SETTLED') {
        earned += price - fee;
        fees += fee;
        settled += 1;
      } else if (o.chain.status === 'DELIVERED') inReview += price;
      else if (o.chain.status === 'PLACED' || o.chain.status === 'ACCEPTED') inEscrow += price;
      else refunded += 1;
    }
    return { earned: earned.toString(), fees: fees.toString(), inReview: inReview.toString(), inEscrow: inEscrow.toString(), settled, refunded };
  }

  overview(): Overview {
    const state = this.store.state();
    const missing = this.missing();
    return {
      settings: this.settings(),
      publicKey: this.store.nearPublicKey(),
      ready: !missing.length,
      missing,
      listings: Object.entries(state.listings).map(([team, l]) => ({ team, ...l, listing: this.chainListings.get(l.listingId), url: this.listingUrl(l.listingId) })),
      orders: Object.values(state.orders).sort((a, b) => b.id - a.id),
      earnings: this.earnings(),
      watching: this.watching,
      lastTick: this.lastTick,
      lastError: this.lastError,
    };
  }

  explorer(kind: 'tx' | 'account', id: string): string {
    return explorerUrl(this.settings().network, kind, id);
  }
}

/** The folder of a team given as a team file, a team folder, or (with `libraryDir`) a library team's id. */
export function teamDirOf(ref: string, libraryDir?: string): string {
  for (const candidate of [ref, ...(libraryDir ? [join(libraryDir, ref)] : [])]) {
    if (existsSync(join(candidate, 'team.yaml'))) return candidate;
    if (/\.ya?ml$/.test(candidate) && existsSync(candidate)) return dirname(candidate);
  }
  throw new MarketError(`no team found at "${ref}" (give a team folder, a team.yaml, or the id of a team in your library)`);
}

export { STOREFRONT_FILE };
