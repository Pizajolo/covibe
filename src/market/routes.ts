// The market in the app: the routes behind the Market page (storefronts,
// incoming orders, earnings, settings). They sit in the local server's route
// table like every other route (see server/app.ts).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { AgentRunner } from '../runner/types.js';
import type { Library } from '../server/library.js';
import { chatThreads } from '../server/projections.js';
import { assist, mediaFiles, SHOPKEEPER } from './assistant.js';
import type { Market } from './market.js';
import { listingInput, loadStorefront, STOREFRONT_FILE, storefrontProblems, storefrontTemplate } from './storefront.js';
import { MarketError, type MarketSettings, type MarketTeam, type MarketView } from './types.js';

type Handler = (params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown;
export type MarketRoute = [string, string, Handler];

const SETTINGS: (keyof MarketSettings)[] = ['network', 'rpcUrl', 'contractId', 'accountId', 'relayUrl', 'storefrontUrl', 'watch', 'pollSeconds'];

/** What the storefront assistant's chat needs: where conversations are kept and what runs the agent. */
export interface AssistantHost {
  store: EventStore;
  runner: AgentRunner;
}

export function marketRoutes(market: Market, library: Library, secretStore: 'keychain' | 'file', host?: AssistantHost): MarketRoute[] {
  /** Conversations with the assistant that are being answered right now. */
  const answering = new Set<string>();
  const loadTeam = (id: string): TeamConfig | undefined => {
    try {
      return library.load(id);
    } catch {
      return undefined;
    }
  };
  const conversation = (team: string) => host?.store.listRuns(500).find((r) => r.kind === 'storefront' && r.team === team);

  let wallet: { at: number; balance?: string; feeBps?: number } | undefined;
  /** The account's balance and the platform fee, read at most every half minute. */
  const readWallet = async () => {
    if (wallet && Date.now() - wallet.at < 30_000) return wallet;
    wallet = { at: Date.now() };
    try {
      const [balance, config] = await Promise.all([market.chain().balance(), market.chain().config()]);
      wallet = { at: Date.now(), balance, feeBps: config.fee_bps };
    } catch {
      // not connected: the page shows what is missing
    }
    return wallet;
  };

  const teams = (view: ReturnType<Market['overview']>): MarketTeam[] =>
    library.teams().map((t) => {
      const file = join(t.dir, STOREFRONT_FILE);
      const base: MarketTeam = { id: t.id, name: t.name, description: t.description, hasStorefront: existsSync(file), problems: [] };
      const published = view.listings.find((l) => l.team === t.dir && l.contractId === view.settings.contractId);
      if (published) Object.assign(base, { listingId: published.listingId, url: published.url, active: published.listing?.active, stats: published.listing?.stats });
      if (!base.hasStorefront) return base;
      try {
        if (!t.valid) throw new Error(`the team file has problems: ${t.problems.join('; ')}`);
        const team = library.load(t.id);
        base.problems = storefrontProblems(readFileSync(file, 'utf8'), team);
        if (!base.problems.length) {
          const sf = loadStorefront(t.dir, team);
          Object.assign(base, { title: sf.title, summary: sf.summary, priceNear: sf.price_near, mode: sf.intake.mode, cover: sf.examples.find((e) => e.file && /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(e.file))?.file });
          // Price, windows or texts changed since it was published (example media aside).
          const l = published?.listing;
          if (l) {
            const now = listingInput(sf, l.meta_hash, l.intake_pubkey);
            base.outdated = now.price !== l.price || now.title !== l.title || now.summary !== l.summary || now.accept_window_s !== l.accept_window_s || now.delivery_window_s !== l.delivery_window_s || now.review_window_s !== l.review_window_s || (now.revisions ?? 0) !== (l.revisions ?? 0);
          }
        }
      } catch (err) {
        base.problems = [(err as Error).message];
      }
      return base;
    });

  const view = async (): Promise<MarketView> => {
    const o = market.overview();
    const w = o.ready ? await readWallet() : undefined;
    const tx: Record<string, string> = {};
    for (const order of o.orders) for (const hash of Object.values(order.txs)) if (hash) tx[hash] = market.explorer('tx', hash);
    return {
      ...o,
      teams: teams(o),
      balance: w?.balance,
      feeBps: w?.feeBps,
      secretStore,
      explorer: { account: o.settings.accountId ? market.explorer('account', o.settings.accountId) : undefined, contract: o.settings.contractId ? market.explorer('account', o.settings.contractId) : undefined, tx },
    };
  };

  const orderId = (p: Record<string, string>) => {
    if (!/^\d+$/.test(p.id ?? '')) throw new MarketError('bad order number');
    return Number(p.id);
  };
  const reason = (body: unknown) => (typeof (body as { reason?: unknown })?.reason === 'string' ? (body as { reason: string }).reason.trim() || undefined : undefined);

  return [
    ['GET', '/api/market', () => view()],
    ['POST', '/api/market/refresh', async () => {
      wallet = undefined;
      await market.tick();
      return view();
    }],
    ['PUT', '/api/market/settings', async (_p, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const patch: Partial<MarketSettings> & { privateKey?: string | null } = {};
      for (const k of SETTINGS) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = k === 'watch' ? b[k] === true : k === 'pollSeconds' ? Number(b[k]) : String(b[k]).trim();
      if (patch.network && !['testnet', 'mainnet', 'custom'].includes(patch.network)) throw new MarketError('network is testnet, mainnet or custom');
      if (b.privateKey === null) patch.privateKey = null;
      else if (typeof b.privateKey === 'string' && b.privateKey.trim()) patch.privateKey = b.privateKey.trim();
      const s = market.configure(patch);
      wallet = undefined;
      if (s.watch && market.overview().ready) market.start();
      else market.stop();
      return view();
    }],
    // A live check of the connections, for the Settings tab.
    ['GET', '/api/market/status', async () => {
      const out: { chain?: string; relay?: string; balance?: string; feeBps?: number; relayContract?: string | null } = {};
      try {
        const [config, balance] = await Promise.all([market.chain().config(), market.chain().balance()]);
        Object.assign(out, { balance, feeBps: config.fee_bps });
      } catch (err) {
        out.chain = (err as Error).message;
      }
      try {
        const health = await market.relay().health();
        out.relayContract = health.contract;
        if (health.contract && health.contract !== market.settings().contractId) out.relay = `this relay serves ${health.contract}, not ${market.settings().contractId}`;
      } catch (err) {
        out.relay = (err as Error).message;
      }
      return out;
    }],
    ['GET', '/api/market/storefronts/:team', (p) => {
      const dir = library.teamDir(p.team!);
      const file = join(dir, STOREFRONT_FILE);
      const team = library.load(p.team!);
      // What the form offers: the team's steps that have a gate, and the example media in its folder.
      const more = { name: team.name, gates: team.steps.filter((s) => s.gate).map((s) => s.id), media: mediaFiles(dir) };
      if (!existsSync(file)) return { exists: false, yaml: storefrontTemplate(team), problems: [], ...more };
      const yaml = readFileSync(file, 'utf8');
      return { exists: true, yaml, problems: storefrontProblems(yaml, team), ...more };
    }],
    // A new storefront for a team that has none: the file to start from, written.
    ['POST', '/api/market/storefronts/:team', (p) => {
      const file = join(library.teamDir(p.team!), STOREFRONT_FILE);
      if (!existsSync(file)) library.writeFile(p.team!, STOREFRONT_FILE, storefrontTemplate(library.load(p.team!)));
      return { exists: true };
    }],
    // Drop a storefront that was never published. A published one is closed for orders instead (its orders and record stay).
    ['DELETE', '/api/market/storefronts/:team', (p) => {
      const dir = library.teamDir(p.team!);
      const o = market.overview();
      if (o.listings.some((l) => l.team === dir && l.contractId === o.settings.contractId)) throw new MarketError('this storefront is published; close it for orders instead');
      rmSync(join(dir, STOREFRONT_FILE), { force: true });
      return { ok: true };
    }],
    // ---- the assistant that sets a storefront up in a chat (see assistant.ts)
    ['GET', '/api/market/storefronts/:team/assistant', (p) => {
      library.teamDir(p.team!);
      const run = conversation(p.team!);
      if (!run || !host) return { runId: null, busy: false, thread: [], saves: [], costUsd: 0 };
      const events = host.store.events(run.id);
      return {
        runId: run.id,
        busy: answering.has(run.id),
        thread: chatThreads(events, [run.repo])[SHOPKEEPER] ?? [],
        saves: events.filter((e) => e.type === 'storefront.saved').map((e) => ({ ts: e.ts, ...e.data })),
        costUsd: events.filter((e) => e.type === 'agent.finished' || e.type === 'agent.error').reduce((n, e) => n + Number(e.data.cost_usd ?? 0), 0),
      };
    }],
    ['POST', '/api/market/storefronts/:team/assistant', async (p, body) => {
      if (!host) throw new MarketError('the assistant is not available here');
      const team = p.team!;
      const teamDir = library.teamDir(team);
      const b = (body ?? {}) as { message?: unknown; fresh?: unknown };
      const message = typeof b.message === 'string' ? b.message.trim() : '';
      if (!message) throw new MarketError('say what you need');
      const run = b.fresh === true ? undefined : conversation(team);
      if (run && answering.has(run.id)) throw new MarketError('the assistant is still answering');
      const settings = library.settings();
      const { runId, done } = await assist({ store: host.store, runner: host.runner, teamId: team, teamDir, team: () => loadTeam(team), write: (yaml) => library.writeFile(team, STOREFRONT_FILE, yaml), runId: run?.id, message, model: settings.designerModel, effort: settings.designerEffort });
      answering.add(runId);
      void done.finally(() => answering.delete(runId));
      return { runId };
    }],
    ['PUT', '/api/market/storefronts/:team', (p, body) => {
      const yaml = (body as { yaml?: unknown })?.yaml;
      if (typeof yaml !== 'string') throw new MarketError('yaml is missing');
      library.writeFile(p.team!, STOREFRONT_FILE, yaml);
      let problems: string[];
      try {
        problems = storefrontProblems(yaml, library.load(p.team!));
      } catch (err) {
        problems = [(err as Error).message];
      }
      return { exists: true, yaml, problems };
    }],
    ['POST', '/api/market/storefronts/:team/publish', async (p) => {
      const out = await market.publish(library.teamDir(p.team!));
      await market.tick();
      return { ...out, explorer: market.explorer('tx', out.tx) };
    }],
    ['POST', '/api/market/storefronts/:team/active', async (p, body) => {
      const tx = await market.setActive(library.teamDir(p.team!), (body as { active?: unknown })?.active === true);
      await market.tick();
      return { tx, explorer: market.explorer('tx', tx) };
    }],
    ['POST', '/api/market/orders/:id/accept', async (p) => ({ tx: await market.accept(orderId(p)) })],
    ['POST', '/api/market/orders/:id/decline', async (p, body) => ({ tx: await market.decline(orderId(p), reason(body)) })],
    ['POST', '/api/market/orders/:id/fail', async (p, body) => ({ tx: await market.fail(orderId(p), reason(body)) })],
    ['POST', '/api/market/orders/:id/retry', (p) => {
      market.retry(orderId(p));
      return { ok: true };
    }],
  ];
}

