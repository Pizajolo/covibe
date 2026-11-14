// What the market keeps on the owner's machine: its settings and the state of
// each order, as JSON files in covibe's home. Keys live in covibe's secret
// store (the Keychain on macOS), never in these files.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '../connections/secrets.js';
import { replaceFile } from '../home.js';
import { generateSealKey, publicKeyOf, sha256Hex } from './crypto.js';
import { DEFAULT_RPC } from './near.js';
import { MarketError, type Hire, type LocalOrder, type MarketSettings, type MarketState } from './types.js';

/** Secret ids: the owner's NEAR key, and the x25519 key customers encrypt their orders to. */
const NEAR_KEY = 'market-near-key';
const INTAKE_KEY = 'market-intake-key';
/** One agent token per connected team. */
const agentTokenId = (team: string) => `market-agent-token-${sha256Hex(team).slice(0, 16)}`;

export const DEFAULT_SETTINGS: MarketSettings = {
  network: 'testnet',
  rpcUrl: DEFAULT_RPC.testnet!,
  contractId: '',
  accountId: '',
  relayUrl: 'http://127.0.0.1:4480',
  storefrontUrl: 'http://127.0.0.1:4490',
  watch: false,
  pollSeconds: 15,
};

export class MarketStore {
  readonly dir: string;

  constructor(
    readonly home: string,
    readonly secrets: SecretStore,
  ) {
    this.dir = join(home, 'market');
    mkdirSync(this.dir, { recursive: true });
  }

  private read<T>(name: string, fallback: T): T {
    const file = join(this.dir, name);
    if (!existsSync(file)) return fallback;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  settings(): MarketSettings {
    return { ...DEFAULT_SETTINGS, ...this.read<Partial<MarketSettings>>('settings.json', {}) };
  }

  saveSettings(patch: Partial<MarketSettings>): MarketSettings {
    const next = { ...this.settings(), ...patch };
    if (patch.network && patch.network !== 'custom' && !patch.rpcUrl) next.rpcUrl = DEFAULT_RPC[patch.network]!;
    next.pollSeconds = Math.min(600, Math.max(5, Math.round(next.pollSeconds) || 15));
    replaceFile(join(this.dir, 'settings.json'), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  state(): MarketState {
    const s = this.read<Partial<MarketState>>('state.json', {});
    return { listings: s.listings ?? {}, orders: s.orders ?? {}, agentMarket: s.agentMarket ?? {}, hires: s.hires ?? {} };
  }

  /** Change the state in one read-modify-write (the app and the CLI may both be at it). */
  update(change: (state: MarketState) => void): MarketState {
    const state = this.state();
    change(state);
    replaceFile(join(this.dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    return state;
  }

  order(id: number): LocalOrder | undefined {
    return this.state().orders[String(id)];
  }

  /** Change one order; the patch is applied to the order as it is on disk now. */
  patchOrder(id: number, patch: Partial<LocalOrder>): LocalOrder {
    let out: LocalOrder | undefined;
    this.update((s) => {
      const cur = s.orders[String(id)];
      if (!cur) throw new MarketError(`order ${id} is not one of yours`);
      out = s.orders[String(id)] = { ...cur, ...patch, txs: { ...cur.txs, ...patch.txs }, updatedAt: new Date().toISOString() };
    });
    return out!;
  }

  hire(ref: string): Hire | undefined {
    const hires = this.state().hires;
    return hires[ref] ?? Object.values(hires).find((h) => h.key === ref);
  }

  /** Change one hire (by its assignment id); the patch is applied to it as it is on disk now. */
  patchHire(assignmentId: string, patch: Partial<Hire>): Hire {
    let out: Hire | undefined;
    this.update((s) => {
      const cur = s.hires[assignmentId];
      if (!cur) throw new MarketError(`hire ${assignmentId} is not one of yours`);
      out = s.hires[assignmentId] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    });
    return out!;
  }

  /** The token of the agent a team is connected to on NEAR AI Agent Market. */
  agentToken(team: string): string | undefined {
    return this.secrets.get(agentTokenId(team));
  }

  setAgentToken(team: string, token: string | null): void {
    if (token === null) return this.secrets.delete(agentTokenId(team));
    this.secrets.set(agentTokenId(team), token.trim());
  }

  nearKey(): string | undefined {
    return this.secrets.get(NEAR_KEY);
  }

  /** Keep the owner's NEAR key (checked to be a usable ed25519 key first). */
  setNearKey(key: string | null): void {
    if (key === null) return this.secrets.delete(NEAR_KEY);
    publicKeyOf(key);
    this.secrets.set(NEAR_KEY, key.trim());
  }

  nearPublicKey(): string | undefined {
    const key = this.nearKey();
    return key ? publicKeyOf(key) : undefined;
  }

  /** The key customers encrypt orders to; made on first use and never shown. */
  intakeKey(): { publicKey: string; privateKey: string } {
    const kept = this.secrets.get(INTAKE_KEY);
    if (kept) {
      try {
        return JSON.parse(kept) as { publicKey: string; privateKey: string };
      } catch {
        // fall through: a damaged entry is replaced
      }
    }
    const key = generateSealKey();
    this.secrets.set(INTAKE_KEY, JSON.stringify(key));
    return key;
  }
}
