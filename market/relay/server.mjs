#!/usr/bin/env node
// The covibe market relay. The owner's covibe app is not reachable from the
// internet, so this small public service carries what should not go on-chain:
// encrypted order inputs, listing pages and media, delivery bundles, receipts
// and the status feed of a run. Files of any size (footage a customer sends,
// a video the team delivers) travel as encrypted chunks ("blobs"), each stored
// under its own hash; the order's input and the delivery name their chunks. It holds no funds and no keys; who may read or
// write what is decided from the market contract's state, so anyone can run
// their own relay against the same contract.
//
// Configuration (environment):
//   RELAY_CONTRACT   market contract account (required)
//   RELAY_RPC        NEAR RPC URL (default: testnet)
//   RELAY_PORT       port (default 4480)
//   RELAY_HOST       address to listen on (default 127.0.0.1)
//   RELAY_DATA       data folder (default ./data)
//   RELAY_MAX_MB     largest single upload in MB (default 64); files are sent in chunks below it
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH = /^[0-9a-f]{64}$/;
const ID = /^\d{1,15}$/;
/** A signed request is good for this long around its timestamp. */
const AUTH_WINDOW_MS = 5 * 60_000;
/** What listing media may be: shown in a page, never run. */
const MEDIA_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|mp4)|application\/pdf|text\/plain)$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** Check an ed25519 signature made with a NEAR-style key ("ed25519:<base58>"). */
export function verifySignature(publicKey, message, signatureB64) {
  try {
    const [curve, b58] = String(publicKey).split(':');
    if (curve !== 'ed25519' || !b58) return false;
    const raw = base58Decode(b58);
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(String(signatureB64), 'base64'));
  } catch {
    return false;
  }
}

/** What a signature covers: the method, the path and the time, so it cannot be replayed elsewhere. */
export const authMessage = (method, path, ts) => `covibe-relay:v1:${method}:${path}:${ts}`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reads the market contract over NEAR's JSON-RPC. */
export class Chain {
  constructor(rpc, contract) {
    this.rpc = rpc;
    this.contract = contract;
    this.keys = new Map();
  }

  async rpcCall(params) {
    const res = await fetch(this.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'relay', method: 'query', params }) });
    const json = await res.json();
    if (json.error) throw new Error(json.error.data ?? json.error.message ?? 'rpc error');
    if (json.result?.error) throw new Error(json.result.error);
    return json.result;
  }

  async view(method, args) {
    const result = await this.rpcCall({ request_type: 'call_function', finality: 'optimistic', account_id: this.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  }

  order(id) {
    return this.view('get_order', { order_id: Number(id) });
  }

  listing(id) {
    return this.view('get_listing', { listing_id: Number(id) });
  }

  /** Does this public key belong to the account? (Cached for five minutes when it does.) */
  async hasKey(account, publicKey) {
    const k = `${account} ${publicKey}`;
    const hit = this.keys.get(k);
    if (hit && Date.now() - hit < 5 * 60_000) return true;
    try {
      await this.rpcCall({ request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: publicKey });
      this.keys.set(k, Date.now());
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Start a relay. `chain` can be given (tests); otherwise it reads `contract` over `rpc`.
 * Resolves with { url, port, close }.
 */
export async function startRelay(opts = {}) {
  const data = opts.data ?? process.env.RELAY_DATA ?? join(process.cwd(), 'data');
  const maxBytes = (opts.maxMb ?? Number(process.env.RELAY_MAX_MB ?? 64)) << 20;
  const contract = opts.contract ?? process.env.RELAY_CONTRACT;
  const chain = opts.chain ?? new Chain(opts.rpc ?? process.env.RELAY_RPC ?? 'https://test.rpc.fastnear.com', contract);
  if (!opts.chain && !contract) throw new Error('set RELAY_CONTRACT to the market contract account');
  for (const d of ['inputs', 'blobs', 'media', 'listings', 'orders']) mkdirSync(join(data, d), { recursive: true });

  const save = (file, bytes) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, bytes);
    renameSync(`${file}.tmp`, file);
  };
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

  const body = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new HttpError(413, `larger than ${maxBytes >> 20} MB`));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  /** Who signed this request: { publicKey, account? }. Throws 401 without a good signature. */
  const signer = (req, path) => {
    let auth;
    try {
      auth = JSON.parse(Buffer.from(String(req.headers['x-covibe-auth'] ?? ''), 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(401, 'this needs a signed request (x-covibe-auth)');
    }
    if (!auth || typeof auth.public_key !== 'string' || typeof auth.ts !== 'number') throw new HttpError(401, 'this needs a signed request (x-covibe-auth)');
    if (Math.abs(Date.now() - auth.ts) > AUTH_WINDOW_MS) throw new HttpError(401, 'the signature is too old; check your clock');
    if (!verifySignature(auth.public_key, authMessage(req.method, path, auth.ts), auth.sig)) throw new HttpError(401, 'the signature does not match');
    return { publicKey: auth.public_key, account: typeof auth.account === 'string' ? auth.account : undefined };
  };

  /** The signer's role on an order: its owner (an account key) or its customer (the order's access key). */
  const roleOn = async (req, path, order) => {
    const who = signer(req, path);
    if (order.access_key && who.publicKey === order.access_key) return 'customer';
    if (await chain.hasKey(order.owner, who.publicKey)) return 'owner';
    if (await chain.hasKey(order.customer, who.publicKey)) return 'customer';
    throw new HttpError(403, 'only the customer or the owner of this order may do that');
  };

  const orderOf = async (id) => {
    const order = await chain.order(id);
    if (!order) throw new HttpError(404, 'no such order');
    return order;
  };

  const sendFile = (res, file, type, req) => {
    if (!existsSync(file)) throw new HttpError(404, 'not found');
    const size = statSync(file).size;
    const head = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
    // A byte range, so a video on a listing page can be played and skipped through.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-length': size });
    createReadStream(file).pipe(res);
  };

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const handle = async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const parts = path.split('/').filter(Boolean);
    const m = req.method;

    if (path === '/health' && m === 'GET') return json(res, 200, { ok: true, contract: chain.contract ?? null, max_mb: maxBytes >> 20, blobs: true });

    // Encrypted order inputs: stored under their own hash before the order exists, read through the order.
    if (parts[0] === 'inputs' && HASH.test(parts[1] ?? '') && parts.length === 2 && m === 'PUT') {
      const bytes = await body(req);
      if (sha(bytes) !== parts[1]) throw new HttpError(400, 'the content does not match its hash');
      save(join(data, 'inputs', parts[1]), bytes);
      return json(res, 200, { hash: parts[1], size: bytes.length });
    }

    // Encrypted chunks of files (order inputs and deliveries), stored under their own hash. Each is
    // ciphertext whose key travels inside the sealed input or the sealed delivery, so the hash is all a reader needs.
    if (parts[0] === 'blobs' && HASH.test(parts[1] ?? '') && parts.length === 2) {
      const file = join(data, 'blobs', parts[1]);
      if (m === 'GET') return sendFile(res, file, 'application/octet-stream');
      if (m === 'PUT') {
        const bytes = await body(req);
        if (sha(bytes) !== parts[1]) throw new HttpError(400, 'the content does not match its hash');
        if (!existsSync(file)) save(file, bytes);
        return json(res, 200, { hash: parts[1], size: bytes.length });
      }
    }

    // Listing media: public to read, stored under its hash by an account that signs the upload.
    if (parts[0] === 'media' && HASH.test(parts[1] ?? '') && parts.length === 2) {
      const file = join(data, 'media', parts[1]);
      if (m === 'GET') return sendFile(res, file, existsSync(`${file}.type`) ? readFileSync(`${file}.type`, 'utf8') : 'application/octet-stream', req);
      if (m === 'PUT') {
        const who = signer(req, path);
        if (!who.account || !(await chain.hasKey(who.account, who.publicKey))) throw new HttpError(403, 'sign media uploads with a key of your NEAR account');
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
        if (!MEDIA_TYPES.test(type)) throw new HttpError(400, `media of type "${type}" is not accepted`);
        const bytes = await body(req);
        if (sha(bytes) !== parts[1]) throw new HttpError(400, 'the content does not match its hash');
        save(file, bytes);
        save(`${file}.type`, type);
        return json(res, 200, { hash: parts[1], size: bytes.length });
      }
    }

    // A listing's page (examples, input form): must hash to the meta_hash on-chain.
    if (parts[0] === 'listings' && ID.test(parts[1] ?? '') && parts[2] === 'meta' && parts.length === 3) {
      const file = join(data, 'listings', `${parts[1]}.json`);
      if (m === 'GET') return sendFile(res, file, 'application/json');
      if (m === 'PUT') {
        const who = signer(req, path);
        const listing = await chain.listing(parts[1]);
        if (!listing) throw new HttpError(404, 'no such listing');
        if (!(await chain.hasKey(listing.owner, who.publicKey))) throw new HttpError(403, 'only the listing owner may publish its page');
        const bytes = await body(req);
        if (sha(bytes) !== listing.meta_hash) throw new HttpError(400, 'the page does not match the meta_hash on-chain');
        save(file, bytes);
        return json(res, 200, { hash: listing.meta_hash });
      }
    }

    if (parts[0] === 'orders' && ID.test(parts[1] ?? '') && parts.length === 3) {
      const id = parts[1];
      const dir = join(data, 'orders', id);
      const what = parts[2];

      if (what === 'input' && m === 'GET') {
        const order = await orderOf(id);
        await roleOn(req, path, order);
        return sendFile(res, join(data, 'inputs', order.input_hash), 'application/octet-stream');
      }

      if (what === 'bundle') {
        const order = await orderOf(id);
        const role = await roleOn(req, path, order);
        if (m === 'GET') return sendFile(res, join(dir, 'bundle'), 'application/octet-stream');
        if (m === 'PUT') {
          if (role !== 'owner') throw new HttpError(403, 'only the owner delivers');
          if (order.status !== 'ACCEPTED') throw new HttpError(409, `a bundle can be uploaded while the order is accepted (it is ${order.status})`);
          const bytes = await body(req);
          save(join(dir, 'bundle'), bytes);
          return json(res, 200, { hash: sha(bytes), size: bytes.length });
        }
      }

      // The signed receipt: public, so anyone can check it against receipt_hash on-chain.
      if (what === 'receipt') {
        if (m === 'GET') return sendFile(res, join(dir, 'receipt.json'), 'application/json');
        if (m === 'PUT') {
          const order = await orderOf(id);
          if ((await roleOn(req, path, order)) !== 'owner') throw new HttpError(403, 'only the owner writes the receipt');
          if (order.status !== 'ACCEPTED') throw new HttpError(409, `a receipt can be uploaded while the order is accepted (it is ${order.status})`);
          const bytes = await body(req);
          save(join(dir, 'receipt.json'), bytes);
          return json(res, 200, { hash: sha(bytes) });
        }
      }

      // What the customer sees of the run: a feed of short status lines, never the board or prompts.
      if (what === 'status') {
        const order = await orderOf(id);
        const role = await roleOn(req, path, order);
        const file = join(dir, 'status.jsonl');
        if (m === 'GET') {
          const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
          return json(res, 200, { status: lines });
        }
        if (m === 'POST') {
          if (role !== 'owner') throw new HttpError(403, 'only the owner posts status');
          const entry = JSON.parse((await body(req)).toString('utf8'));
          const line = { ts: new Date().toISOString(), state: String(entry.state ?? '').slice(0, 40), text: String(entry.text ?? '').slice(0, 500) };
          mkdirSync(dir, { recursive: true });
          appendFileSync(file, JSON.stringify(line) + '\n');
          return json(res, 200, line);
        }
      }
    }

    throw new HttpError(404, 'not found');
  };

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-covibe-auth, range');
    res.setHeader('access-control-expose-headers', 'content-range, accept-ranges');
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 502;
      if (status === 502) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    });
  });
  const host = opts.host ?? process.env.RELAY_HOST ?? '127.0.0.1';
  await new Promise((r) => server.listen(opts.port ?? Number(process.env.RELAY_PORT ?? 4480), host, r));
  const port = server.address().port;
  return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, port, close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  startRelay().then(
    (relay) => console.log(`covibe market relay on ${relay.url} for ${process.env.RELAY_CONTRACT}`),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
