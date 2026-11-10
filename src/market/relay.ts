// Client for the market relay (market/relay). The owner signs requests with
// their NEAR key; the relay checks the key against the contract's state.
import { sha256Hex, publicKeyOf, signMessage } from './crypto.js';
import { MarketError, type ListingMeta, type Receipt } from './types.js';

export interface Relay {
  readonly url: string;
  health(): Promise<{ ok: boolean; contract: string | null; max_mb: number }>;
  putMedia(bytes: Buffer, type: string): Promise<string>;
  putListingMeta(listingId: number, json: string): Promise<void>;
  listingMeta(listingId: number): Promise<ListingMeta | undefined>;
  /** Store an encrypted input under its hash (what a customer's browser does). */
  putInput(bytes: Buffer): Promise<string>;
  orderInput(orderId: number): Promise<Buffer>;
  putBundle(orderId: number, bytes: Buffer): Promise<string>;
  bundle(orderId: number): Promise<Buffer>;
  putReceipt(orderId: number, json: string): Promise<void>;
  receipt(orderId: number): Promise<Receipt | undefined>;
  postStatus(orderId: number, state: string, text: string): Promise<void>;
}

/** What a relay signature covers (the same string the relay builds). */
export const authMessage = (method: string, path: string, ts: number) => `covibe-relay:v1:${method}:${path}:${ts}`;

export class RelayClient implements Relay {
  readonly url: string;

  constructor(
    url: string,
    private readonly accountId?: string,
    private readonly privateKey?: string,
  ) {
    if (!url) throw new MarketError('no relay is set (covibe market config --relay <url>)');
    this.url = url.replace(/\/+$/, '');
  }

  private auth(method: string, path: string): Record<string, string> {
    if (!this.privateKey) return {};
    const ts = Date.now();
    const auth = { account: this.accountId, public_key: publicKeyOf(this.privateKey), ts, sig: signMessage(this.privateKey, authMessage(method, path, ts)) };
    return { 'x-covibe-auth': Buffer.from(JSON.stringify(auth)).toString('base64url') };
  }

  private async request(method: string, path: string, body?: Buffer | string, type?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url + path, { method, headers: { ...this.auth(method, path), ...(type ? { 'content-type': type } : {}) }, ...(body === undefined ? {} : { body: body as BodyInit }) });
    } catch (err) {
      throw new MarketError(`the relay at ${this.url} cannot be reached: ${(err as Error).message}`);
    }
    return res;
  }

  private async ok(method: string, path: string, body?: Buffer | string, type?: string): Promise<Response> {
    const res = await this.request(method, path, body, type);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new MarketError(`relay ${method} ${path}: ${json.error ?? res.statusText}`);
    }
    return res;
  }

  health = async () => (await (await this.ok('GET', '/health')).json()) as { ok: boolean; contract: string | null; max_mb: number };

  async putMedia(bytes: Buffer, type: string): Promise<string> {
    const hash = sha256Hex(bytes);
    await this.ok('PUT', `/media/${hash}`, bytes, type);
    return hash;
  }

  async putListingMeta(listingId: number, json: string): Promise<void> {
    await this.ok('PUT', `/listings/${listingId}/meta`, json, 'application/json');
  }

  async listingMeta(listingId: number): Promise<ListingMeta | undefined> {
    const res = await this.request('GET', `/listings/${listingId}/meta`);
    return res.ok ? ((await res.json()) as ListingMeta) : undefined;
  }

  async putInput(bytes: Buffer): Promise<string> {
    const hash = sha256Hex(bytes);
    await this.ok('PUT', `/inputs/${hash}`, bytes, 'application/octet-stream');
    return hash;
  }

  orderInput = async (orderId: number) => Buffer.from(await (await this.ok('GET', `/orders/${orderId}/input`)).arrayBuffer());

  async putBundle(orderId: number, bytes: Buffer): Promise<string> {
    const out = (await (await this.ok('PUT', `/orders/${orderId}/bundle`, bytes, 'application/octet-stream')).json()) as { hash: string };
    return out.hash;
  }

  bundle = async (orderId: number) => Buffer.from(await (await this.ok('GET', `/orders/${orderId}/bundle`)).arrayBuffer());

  async putReceipt(orderId: number, json: string): Promise<void> {
    await this.ok('PUT', `/orders/${orderId}/receipt`, json, 'application/json');
  }

  async receipt(orderId: number): Promise<Receipt | undefined> {
    const res = await this.request('GET', `/orders/${orderId}/receipt`);
    return res.ok ? ((await res.json()) as Receipt) : undefined;
  }

  async postStatus(orderId: number, state: string, text: string): Promise<void> {
    await this.ok('POST', `/orders/${orderId}/status`, JSON.stringify({ state, text }), 'application/json');
  }
}
