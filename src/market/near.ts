// The market contract as covibe uses it. `MarketChain` is the seam: NearChain
// talks to NEAR through near-api-js, and tests put a stand-in behind it.
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { MarketError, type ChainConfig, type Listing, type ListingInput, type Order, type Review } from './types.js';

export interface TxResult<T = undefined> {
  /** Transaction hash, for the explorer. */
  tx: string;
  value: T;
}

export interface MarketChain {
  readonly contractId: string;
  /** The account that signs (unset: read-only). */
  readonly accountId?: string;
  config(): Promise<ChainConfig>;
  listing(id: number): Promise<Listing | undefined>;
  listings(from?: number, limit?: number): Promise<Listing[]>;
  listingsByOwner(owner: string): Promise<Listing[]>;
  order(id: number): Promise<Order | undefined>;
  orders(listingId: number, from?: number, limit?: number): Promise<Order[]>;
  ordersByCustomer(customer: string, from?: number, limit?: number): Promise<Order[]>;
  /** NEAR the account holds, in yoctoNEAR. */
  balance(): Promise<string>;
  createListing(listing: ListingInput): Promise<TxResult<number>>;
  updateListing(id: number, listing: ListingInput): Promise<TxResult>;
  setActive(id: number, active: boolean): Promise<TxResult>;
  acceptOrder(id: number): Promise<TxResult>;
  declineOrder(id: number, reason?: string): Promise<TxResult>;
  failOrder(id: number, reason?: string): Promise<TxResult>;
  deliverOrder(id: number, receiptHash: string, bundleHash: string): Promise<TxResult>;
  settleOrder(id: number): Promise<TxResult>;
  expireOrder(id: number): Promise<TxResult>;
  /** Answer a revision request that waits for the owner. */
  answerRevision(id: number, accept: boolean, reason?: string): Promise<TxResult>;
  /** A listing's reviews, oldest first. */
  reviews(listingId: number, from?: number, limit?: number): Promise<Review[]>;
  /** The customer's side (the storefront does these in the browser; here for the CLI and tests). */
  placeOrder(listingId: number, inputHash: string, price: string, accessKey?: string): Promise<TxResult<number>>;
  confirmOrder(id: number): Promise<TxResult>;
  disputeOrder(id: number, reason?: string): Promise<TxResult>;
  /** Resolves with whether the revision was one of the included ones (taken at once). */
  requestRevision(id: number, noteHash: string): Promise<TxResult<boolean>>;
  reviewOrder(id: number, stars: number, comment?: string): Promise<TxResult>;
}

export const YOCTO = 10n ** 24n;
const GAS = 60_000_000_000_000n;
/** Attached for a listing's storage; the contract sends back what it does not need. */
const LISTING_STORAGE = YOCTO / 10n;

/** NEAR (a decimal) to yoctoNEAR, exactly. */
export function nearToYocto(near: number | string): string {
  const [whole, frac = ''] = String(near).split('.');
  if (!/^\d+$/.test(whole ?? '') || !/^\d*$/.test(frac) || frac.length > 24) throw new MarketError(`"${near}" is not an amount of NEAR`);
  return (BigInt(whole!) * YOCTO + BigInt(frac.padEnd(24, '0') || '0')).toString();
}

/** yoctoNEAR as NEAR with up to `digits` decimals, trailing zeros dropped. */
export function yoctoToNear(yocto: string | bigint, digits = 4): string {
  const n = BigInt(yocto);
  const whole = n / YOCTO;
  const frac = (n % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export const DEFAULT_RPC: Record<string, string> = { testnet: 'https://test.rpc.fastnear.com', mainnet: 'https://free.rpc.fastnear.com' };

/** Where a transaction or account can be looked up. */
export function explorerUrl(network: string, kind: 'tx' | 'account', id: string): string {
  // A local or private chain has no public explorer.
  if (network !== 'mainnet' && network !== 'testnet') return '';
  const host = network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
  return `${host}/${kind === 'tx' ? 'txns' : 'address'}/${id}`;
}

export class NearChain implements MarketChain {
  private readonly provider: JsonRpcProvider;
  private readonly account?: Account;

  constructor(
    rpcUrl: string,
    readonly contractId: string,
    readonly accountId?: string,
    privateKey?: string,
  ) {
    if (!contractId) throw new MarketError('no market contract is set (covibe market config --contract <account>)');
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    if (accountId && privateKey) this.account = new Account(accountId, this.provider, privateKey as KeyPairString);
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.provider.callFunction({ contractId: this.contractId, method, args })) as T;
    } catch (err) {
      throw new MarketError(`${this.contractId}.${method}: ${(err as Error).message}`);
    }
  }

  private async call<T = undefined>(method: string, args: Record<string, unknown>, deposit = 0n): Promise<TxResult<T>> {
    if (!this.account) throw new MarketError('no NEAR account and key are set, so nothing can be signed (covibe market config)');
    let out: Awaited<ReturnType<Account['callFunctionRaw']>>;
    try {
      out = await this.account.callFunctionRaw({ contractId: this.contractId, methodName: method, args, gas: GAS, deposit });
    } catch (err) {
      throw new MarketError(`${method}: ${contractMessage(err)}`);
    }
    const status = out.status as { SuccessValue?: string; Failure?: unknown };
    if (status.Failure) throw new MarketError(`${method}: ${contractMessage(status.Failure)}`);
    const raw = status.SuccessValue ? Buffer.from(status.SuccessValue, 'base64').toString('utf8') : '';
    return { tx: out.transaction.hash as string, value: (raw ? JSON.parse(raw) : undefined) as T };
  }

  config = () => this.view<ChainConfig>('get_config');
  listing = async (id: number) => (await this.view<Listing | null>('get_listing', { listing_id: id })) ?? undefined;
  listings = (from = 0, limit = 50) => this.view<Listing[]>('get_listings', { from_index: from, limit });
  listingsByOwner = (owner: string) => this.view<Listing[]>('get_listings_by_owner', { owner });
  order = async (id: number) => (await this.view<Order | null>('get_order', { order_id: id })) ?? undefined;
  orders = (listingId: number, from = 0, limit = 50) => this.view<Order[]>('get_orders', { listing_id: listingId, from_index: from, limit });
  ordersByCustomer = (customer: string, from = 0, limit = 50) => this.view<Order[]>('get_orders_by_customer', { customer, from_index: from, limit });

  async balance(): Promise<string> {
    if (!this.account) return '0';
    try {
      return (await this.account.getBalance()).toString();
    } catch (err) {
      throw new MarketError(`could not read the balance of ${this.accountId}: ${(err as Error).message}`);
    }
  }

  createListing = (listing: ListingInput) => this.call<number>('create_listing', { listing }, LISTING_STORAGE);
  updateListing = (id: number, listing: ListingInput) => this.call('update_listing', { listing_id: id, listing }, LISTING_STORAGE);
  setActive = (id: number, active: boolean) => this.call('set_active', { listing_id: id, active });
  acceptOrder = (id: number) => this.call('accept_order', { order_id: id });
  declineOrder = (id: number, reason?: string) => this.call('decline_order', { order_id: id, reason: reason ?? null });
  failOrder = (id: number, reason?: string) => this.call('fail_order', { order_id: id, reason: reason ?? null });
  deliverOrder = (id: number, receiptHash: string, bundleHash: string) => this.call('deliver_order', { order_id: id, receipt_hash: receiptHash, bundle_hash: bundleHash });
  settleOrder = (id: number) => this.call('settle_order', { order_id: id });
  expireOrder = (id: number) => this.call('expire_order', { order_id: id });
  placeOrder = (listingId: number, inputHash: string, price: string, accessKey?: string) => this.call<number>('place_order', { listing_id: listingId, input_hash: inputHash, access_key: accessKey ?? null }, BigInt(price));
  confirmOrder = (id: number) => this.call('confirm_order', { order_id: id });
  disputeOrder = (id: number, reason?: string) => this.call('dispute_order', { order_id: id, reason: reason ?? null });
  answerRevision = (id: number, accept: boolean, reason?: string) => this.call('answer_revision', { order_id: id, accept, reason: reason ?? null });
  requestRevision = (id: number, noteHash: string) => this.call<boolean>('request_revision', { order_id: id, note_hash: noteHash });
  reviewOrder = (id: number, stars: number, comment?: string) => this.call('review_order', { order_id: id, stars, comment: comment ?? null });
  reviews = (listingId: number, from = 0, limit = 50) => this.view<Review[]>('get_reviews', { listing_id: listingId, from_index: from, limit });
}

/** The contract's own words out of a failed call ("Smart contract panicked: …"), else the error as it is. */
export function contractMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : JSON.stringify(err);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text) ?? /ExecutionError"?:\s*"?([^"\\}]+)/.exec(text);
  return (panic?.[1] ?? text).trim();
}
