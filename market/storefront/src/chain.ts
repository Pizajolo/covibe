// Reading the market contract (plain JSON-RPC) and signing as the customer:
// with a NEAR wallet through NEAR Connect, or, on test networks only, with a
// pasted developer key so the flow can be driven without a wallet.
import { NearConnector } from '@hot-labs/near-connect';
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import type { Config, Listing, Order, Review } from './types';

const GAS = '60000000000000';
const YOCTO = 10n ** 24n;

export function near(yocto: string | bigint, digits = 4): string {
  const n = BigInt(yocto);
  const frac = (n % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${n / YOCTO}.${frac}` : `${n / YOCTO}`;
}

export function explorer(config: Config, kind: 'account' | 'tx', id: string): string | undefined {
  if (config.network === 'custom') return undefined;
  return `https://${config.network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/${kind === 'tx' ? 'txns' : 'address'}/${id}`;
}

/** The contract's own words out of a failed call. */
function contractMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return (/Smart contract panicked: ([^"\\]+)/.exec(text)?.[1] ?? text).trim();
}

export class Chain {
  constructor(readonly config: Config) {}

  private async query<T>(params: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'storefront', method: 'query', params: { finality: 'optimistic', ...params } }) });
    const json = await res.json();
    if (json.error) throw new Error(contractMessage(json.error.data ?? json.error.message));
    if (json.result?.error) throw new Error(contractMessage(json.result.error));
    return json.result as T;
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const out = await this.query<{ result: number[] }>({ request_type: 'call_function', account_id: this.config.contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(out.result))) as T;
  }

  listings = () => this.view<Listing[]>('get_listings', { from_index: 0, limit: 100 });
  listing = (id: number) => this.view<Listing | null>('get_listing', { listing_id: id });
  order = (id: number) => this.view<Order | null>('get_order', { order_id: id });
  reviews = (listingId: number) => this.view<Review[]>('get_reviews', { listing_id: listingId, from_index: 0, limit: 100 });
  ordersOf = (customer: string) => this.view<Order[]>('get_orders_by_customer', { customer, from_index: 0, limit: 100 });

  /** Does this key belong to the account (is the receipt signed by the owner)? */
  async hasKey(account: string, publicKey: string): Promise<boolean> {
    try {
      await this.query({ request_type: 'view_access_key', account_id: account, public_key: publicKey });
      return true;
    } catch {
      return false;
    }
  }
}

export interface Session {
  accountId: string;
  kind: 'wallet' | 'key';
  /** Call the contract; resolves with the method's return value when the wallet hands it back. */
  call(method: string, args: Record<string, unknown>, deposit?: string): Promise<unknown>;
  signOut(): Promise<void>;
}

function successValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string; Failure?: unknown } } | undefined)?.status;
  if (status?.Failure) throw new Error(contractMessage(status.Failure));
  if (!status?.SuccessValue) return undefined;
  try {
    return JSON.parse(atob(status.SuccessValue));
  } catch {
    return undefined;
  }
}

let connector: NearConnector | undefined;
const getConnector = (config: Config) => (connector ??= new NearConnector({ network: config.network === 'mainnet' ? 'mainnet' : 'testnet' }));

type ConnectedWallet = Awaited<ReturnType<NearConnector['wallet']>>;

function walletSession(config: Config, wallet: ConnectedWallet, accountId: string): Session {
  return {
    accountId,
    kind: 'wallet',
    async call(method, args, deposit = '0') {
      try {
        const outcome = await wallet.signAndSendTransaction({ receiverId: config.contractId, actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: GAS, deposit } }] });
        return successValue(outcome);
      } catch (err) {
        throw new Error(contractMessage(err));
      }
    },
    signOut: () => getConnector(config).disconnect(wallet),
  };
}

/** Open the wallet chooser and sign in. */
export async function connectWallet(config: Config): Promise<Session> {
  const wallet = await getConnector(config).connect();
  const accounts = await wallet.getAccounts();
  if (!accounts[0]) throw new Error('the wallet returned no account');
  return walletSession(config, wallet, accounts[0].accountId);
}

const KEY_SESSION = 'covibe-market:dev-key';

function keySession(config: Config, accountId: string, privateKey: string): Session {
  const account = new Account(accountId, new JsonRpcProvider({ url: config.rpcUrl }), privateKey as KeyPairString);
  return {
    accountId,
    kind: 'key',
    async call(method, args, deposit = '0') {
      try {
        return successValue(await account.callFunctionRaw({ contractId: config.contractId, methodName: method, args, gas: BigInt(GAS), deposit: BigInt(deposit) }));
      } catch (err) {
        throw new Error(contractMessage(err));
      }
    },
    async signOut() {
      sessionStorage.removeItem(KEY_SESSION);
    },
  };
}

/** Sign in with an account's key, kept for this tab only. Never offered on mainnet. */
export function connectKey(config: Config, accountId: string, privateKey: string): Session {
  if (config.network === 'mainnet') throw new Error('developer keys are for test networks only');
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(privateKey.trim())) throw new Error('the key must look like ed25519:…');
  const session = keySession(config, accountId.trim(), privateKey.trim());
  sessionStorage.setItem(KEY_SESSION, JSON.stringify({ accountId: accountId.trim(), privateKey: privateKey.trim() }));
  return session;
}

/** The session from before a reload, if there is one. */
export async function restoreSession(config: Config): Promise<Session | undefined> {
  try {
    const kept = sessionStorage.getItem(KEY_SESSION);
    if (kept && config.network !== 'mainnet') {
      const { accountId, privateKey } = JSON.parse(kept) as { accountId: string; privateKey: string };
      return keySession(config, accountId, privateKey);
    }
  } catch {
    // no usable key session
  }
  if (config.network === 'custom') return undefined;
  try {
    const { wallet, accounts } = await getConnector(config).getConnectedWallet();
    if (accounts[0]) return walletSession(config, wallet, accounts[0].accountId);
  } catch {
    // not signed in
  }
  return undefined;
}
