// The relay as the customer's browser uses it. Reads of an order's feed and
// bundle are signed with the order's own key (see OrderKeys).
import { sha256Hex, sign } from './crypto';
import type { Config, ListingMeta, OrderKeys, Receipt } from './types';

export class Relay {
  private readonly url: string;

  constructor(config: Config) {
    this.url = config.relayUrl.replace(/\/+$/, '');
  }

  mediaUrl = (hash: string) => `${this.url}/media/${hash}`;

  private async auth(method: string, path: string, keys: OrderKeys): Promise<Record<string, string>> {
    const ts = Date.now();
    const sig = await sign(keys.access.privateJwk, `covibe-relay:v1:${method}:${path}:${ts}`);
    return { 'x-covibe-auth': btoa(JSON.stringify({ public_key: keys.access.publicKey, ts, sig })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
  }

  private async fail(res: Response): Promise<never> {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `the relay answered ${res.status}`);
  }

  /** A listing's page, checked against the hash on-chain. */
  async meta(listingId: number, metaHash: string): Promise<ListingMeta> {
    const res = await fetch(`${this.url}/listings/${listingId}/meta`);
    if (!res.ok) return this.fail(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== metaHash) throw new Error('the listing page in the relay does not match the hash on-chain');
    return JSON.parse(new TextDecoder().decode(bytes)) as ListingMeta;
  }

  /** Store an encrypted order input; resolves with its hash. */
  async putInput(sealed: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await sha256Hex(sealed);
    const res = await fetch(`${this.url}/inputs/${hash}`, { method: 'PUT', body: sealed });
    if (!res.ok) return this.fail(res);
    return hash;
  }

  /** Store one encrypted chunk of a file under its hash. */
  async putBlob(sealed: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await sha256Hex(sealed);
    const res = await fetch(`${this.url}/blobs/${hash}`, { method: 'PUT', body: sealed });
    if (!res.ok) return this.fail(res);
    return hash;
  }

  /** One encrypted chunk, checked against its hash. */
  async blob(hash: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetch(`${this.url}/blobs/${hash}`);
    if (!res.ok) return this.fail(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash) throw new Error('a part of the file in the relay does not match its hash');
    return bytes;
  }

  async status(orderId: number, keys: OrderKeys): Promise<{ ts: string; state: string; text: string }[]> {
    const path = `/orders/${orderId}/status`;
    const res = await fetch(this.url + path, { headers: await this.auth('GET', path, keys) });
    if (!res.ok) return this.fail(res);
    return ((await res.json()) as { status: { ts: string; state: string; text: string }[] }).status;
  }

  async bundle(orderId: number, keys: OrderKeys): Promise<Uint8Array<ArrayBuffer>> {
    const path = `/orders/${orderId}/bundle`;
    const res = await fetch(this.url + path, { headers: await this.auth('GET', path, keys) });
    if (!res.ok) return this.fail(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The receipt and the exact text that was hashed on-chain. */
  async receipt(orderId: number): Promise<{ receipt: Receipt; text: string } | undefined> {
    const res = await fetch(`${this.url}/orders/${orderId}/receipt`);
    if (!res.ok) return undefined;
    const text = await res.text();
    return { receipt: JSON.parse(text) as Receipt, text };
  }
}

const keyName = (config: Config, inputHash: string) => `covibe-market:${config.contractId}:order:${inputHash}`;

/** Keep an order's keys in this browser, under the hash of its input (which the order carries on-chain). */
export function saveKeys(config: Config, inputHash: string, keys: OrderKeys): void {
  localStorage.setItem(keyName(config, inputHash), JSON.stringify(keys));
}

export function loadKeys(config: Config, inputHash: string): OrderKeys | undefined {
  try {
    const kept = localStorage.getItem(keyName(config, inputHash));
    return kept ? (JSON.parse(kept) as OrderKeys) : undefined;
  } catch {
    return undefined;
  }
}
