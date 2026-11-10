// The browser's half of the market's crypto, on WebCrypto. It matches
// src/market/crypto.ts byte for byte:
//   seal/open  ephemeral X25519 → HKDF-SHA256 → AES-256-GCM
//   sign       ed25519, keys written NEAR's way ("ed25519:<base58>")
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAGIC = new TextEncoder().encode('CVB1');
const SEAL_INFO = new TextEncoder().encode('covibe-market/seal/v1');

type Bytes = Uint8Array<ArrayBuffer>;

export const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export function fromBase64(text: string): Bytes {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(text: string): Bytes {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function sealKey(shared: ArrayBuffer, ephemeral: Uint8Array, recipient: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: concat(ephemeral, recipient), info: SEAL_INFO as Bytes }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt to an x25519 public key (base64 of the raw 32 bytes). */
export async function seal(plain: Uint8Array, recipientPublicKey: string): Promise<Bytes> {
  const recipient = fromBase64(recipientPublicKey);
  const eph = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const theirs = await crypto.subtle.importKey('raw', recipient, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, eph.privateKey, 256);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await sealKey(shared, ephPub, recipient), plain as Bytes));
  return concat(MAGIC, ephPub, nonce, cipher);
}

/** A key pair bundles are encrypted to; the private half is kept as a JWK. */
export async function generateSealKey(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  return { publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

/** Decrypt what seal made (here or in covibe) with the private key kept for it. */
export async function open(sealed: Uint8Array, privateJwk: JsonWebKey): Promise<Bytes> {
  if (sealed.length < 64 || MAGIC.some((b, i) => sealed[i] !== b)) throw new Error('this is not a sealed covibe bundle');
  const mine = await crypto.subtle.importKey('jwk', privateJwk, { name: 'X25519' }, false, ['deriveBits']);
  const myPub = fromBase64(privateJwk.x!);
  const ephPub = sealed.slice(4, 36);
  const theirs = await crypto.subtle.importKey('raw', ephPub, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, mine, 256);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(36, 48) }, await sealKey(shared, ephPub, myPub), sealed.slice(48)));
}

/** An ed25519 key for one order: its public half goes on-chain, relay requests are signed with the private half. */
export async function generateAccessKey(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}`, privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

export async function sign(privateJwk: JsonWebKey, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(message))));
}

export async function verify(publicKey: string, message: string, signature: string): Promise<boolean> {
  try {
    const [curve, b58] = publicKey.split(':');
    if (curve !== 'ed25519' || !b58) return false;
    const key = await crypto.subtle.importKey('raw', base58Decode(b58), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(signature), utf8(message));
  } catch {
    return false;
  }
}
