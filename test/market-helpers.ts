import { nearToYocto, type MarketChain, type TxResult } from '../src/market/near.js';
import type { ChainConfig, Listing, ListingInput, Order } from '../src/market/types.js';

export const OWNER = 'owner.test';
export const CUSTOMER = 'alice.test';

/** The contract's rules, in memory (the real ones are tested in market/contract). */
export class FakeChain implements MarketChain {
  readonly contractId = 'market.test';
  accountId = OWNER;
  listingsById: Listing[] = [];
  ordersById: Order[] = [];
  private n = 0;
  private now = () => Date.now();
  private tx = <T>(value: T): TxResult<T> => ({ tx: `tx${++this.n}`, value });
  private get(id: number, ...status: Order['status'][]): Order {
    const o = this.ordersById[id];
    if (!o) throw new Error('no such order');
    if (!status.includes(o.status)) throw new Error(`order is ${o.status}`);
    return o;
  }
  private close(o: Order, status: Order['status'], reason?: string) {
    o.status = status;
    o.closed_at = this.now();
    o.reason = reason ?? null;
    const stats = this.listingsById[o.listing_id]!.stats;
    if (status === 'SETTLED') stats.completed += 1;
    else if (status === 'DECLINED') stats.declined += 1;
    else if (status === 'FAILED') stats.failed += 1;
    else if (status === 'DISPUTED') stats.disputed += 1;
    else stats.expired += 1;
    return this.tx(undefined);
  }
  config = async (): Promise<ChainConfig> => ({ admin: 'admin.test', treasury: 'treasury.test', fee_bps: 250, min_price: '0', max_price: nearToYocto(1000), max_open_orders: 5, listings: this.listingsById.length, orders: this.ordersById.length });
  listing = async (id: number) => this.listingsById[id];
  listings = async () => this.listingsById;
  listingsByOwner = async (owner: string) => this.listingsById.filter((l) => l.owner === owner);
  order = async (id: number) => (this.ordersById[id] ? { ...this.ordersById[id]! } : undefined);
  orders = async (listingId: number, from = 0, limit = 50) => this.ordersById.filter((o) => o.listing_id === listingId).slice(from, from + limit).map((o) => ({ ...o }));
  ordersByCustomer = async (customer: string) => this.ordersById.filter((o) => o.customer === customer);
  balance = async () => nearToYocto(10);
  createListing = async (l: ListingInput) => {
    this.listingsById.push({ ...l, id: this.listingsById.length, owner: OWNER, active: true, stats: { completed: 0, declined: 0, expired: 0, failed: 0, disputed: 0 }, created_at: this.now() });
    return this.tx(this.listingsById.length - 1);
  };
  updateListing = async (id: number, l: ListingInput) => {
    Object.assign(this.listingsById[id]!, l);
    return this.tx(undefined);
  };
  setActive = async (id: number, active: boolean) => {
    this.listingsById[id]!.active = active;
    return this.tx(undefined);
  };
  placeOrder = async (listingId: number, inputHash: string, price: string, accessKey?: string) => {
    const l = this.listingsById[listingId]!;
    if (!l.active) throw new Error('this listing takes no orders right now');
    if (price !== l.price) throw new Error('attach exactly the price');
    this.ordersById.push({ id: this.ordersById.length, listing_id: listingId, customer: CUSTOMER, owner: l.owner, price, fee_bps: 250, input_hash: inputHash, access_key: accessKey ?? null, status: 'PLACED', created_at: this.now(), accepted_at: null, delivered_at: null, closed_at: null, receipt_hash: null, bundle_hash: null, reason: null });
    return this.tx(this.ordersById.length - 1);
  };
  acceptOrder = async (id: number) => {
    const o = this.get(id, 'PLACED');
    o.status = 'ACCEPTED';
    o.accepted_at = this.now();
    return this.tx(undefined);
  };
  declineOrder = async (id: number, reason?: string) => this.close(this.get(id, 'PLACED'), 'DECLINED', reason);
  failOrder = async (id: number, reason?: string) => this.close(this.get(id, 'ACCEPTED'), 'FAILED', reason);
  deliverOrder = async (id: number, receiptHash: string, bundleHash: string) => {
    const o = this.get(id, 'ACCEPTED');
    Object.assign(o, { status: 'DELIVERED', delivered_at: this.now(), receipt_hash: receiptHash, bundle_hash: bundleHash });
    return this.tx(undefined);
  };
  settleOrder = async (id: number) => {
    const o = this.get(id, 'DELIVERED');
    if (this.now() <= o.delivered_at! + this.listingsById[o.listing_id]!.review_window_s * 1000) throw new Error("the customer's review window is still open");
    return this.close(o, 'SETTLED');
  };
  expireOrder = async (id: number) => this.close(this.get(id, 'PLACED', 'ACCEPTED'), 'EXPIRED');
  confirmOrder = async (id: number) => this.close(this.get(id, 'DELIVERED'), 'SETTLED');
  disputeOrder = async (id: number, reason?: string) => this.close(this.get(id, 'DELIVERED'), 'DISPUTED', reason);
}

