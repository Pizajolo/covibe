// Hashing, signing and sealing for the market. Everything here is Node's own
// crypto, and each scheme has a WebCrypto twin in the storefront
// (market/storefront/src/crypto.ts):
//   seal/open  ephemeral X25519 → HKDF-SHA256 → AES-256-GCM
//   sign       ed25519 with a NEAR key ("ed25519:<base58>")
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAGIC = Buffer.from('CVB1');
const SEAL_INFO = Buffer.from('covibe-market/seal/v1');

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
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

export function base58Decode(text: string): Buffer {
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
  return Buffer.from(bytes);
}

// ---- x25519 sealing

const x25519Public = (raw: Buffer): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
const rawPublic = (key: KeyObject): Buffer => Buffer.from((key.export({ format: 'jwk' }) as { x: string }).x, 'base64url');

/** A new x25519 key pair, both halves as base64 of the raw 32 bytes. */
export function generateSealKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: rawPublic(publicKey).toString('base64'), privateKey: Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url').toString('base64') };
}

function sealKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), SEAL_INFO, 32));
}

/** Encrypt to an x25519 public key (base64). Layout: "CVB1" | ephemeral key (32) | nonce (12) | ciphertext | tag (16). */
export function seal(plain: Buffer, recipientPublicKey: string): Buffer {
  const recipient = Buffer.from(recipientPublicKey, 'base64');
  if (recipient.length !== 32) throw new Error('the public key must be 32 bytes of x25519, in base64');
  const eph = generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const key = sealKey(diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipient) }), ephPub, recipient);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([MAGIC, ephPub, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** Decrypt what seal made, with the recipient's private key (base64 of the raw 32 bytes). */
export function open(sealed: Buffer, privateKey: string): Buffer {
  if (sealed.length < 64 || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed covibe message');
  const d = Buffer.from(privateKey, 'base64');
  if (d.length !== 32) throw new Error('the private key must be 32 bytes of x25519, in base64');
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), d]), format: 'der', type: 'pkcs8' });
  const recipientPub = rawPublic(createPublicKey(priv));
  const ephPub = sealed.subarray(4, 36);
  const nonce = sealed.subarray(36, 48);
  const tag = sealed.subarray(sealed.length - 16);
  const key = sealKey(diffieHellman({ privateKey: priv, publicKey: x25519Public(ephPub) }), ephPub, recipientPub);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(48, sealed.length - 16)), decipher.final()]);
}

// ---- ed25519 with NEAR keys

/** The seed and public key inside a NEAR secret key ("ed25519:<base58 of seed|public>"). */
function parseSecret(secretKey: string): { seed: Buffer; publicKey: string } {
  const [curve, b58] = secretKey.trim().split(':');
  if (curve !== 'ed25519' || !b58) throw new Error('the NEAR key must look like ed25519:…');
  const raw = base58Decode(b58);
  if (raw.length !== 64 && raw.length !== 32) throw new Error('the NEAR key has the wrong length');
  const seed = raw.subarray(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from((createPublicKey(key).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return { seed, publicKey: `ed25519:${base58Encode(pub)}` };
}

export function publicKeyOf(secretKey: string): string {
  return parseSecret(secretKey).publicKey;
}

/** Sign with a NEAR secret key; the signature is base64. */
export function signMessage(secretKey: string, message: string | Buffer): string {
  const { seed } = parseSecret(secretKey);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(message), key).toString('base64');
}

export function verifyMessage(publicKey: string, message: string | Buffer, signature: string): boolean {
  try {
    const [curve, b58] = publicKey.split(':');
    if (curve !== 'ed25519' || !b58) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(b58)]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** A new ed25519 key pair in NEAR's notation (a customer's per-order access key, or a key for tests). */
export function generateNearKey(): { publicKey: string; secretKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const seed = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  return { publicKey: `ed25519:${base58Encode(pub)}`, secretKey: `ed25519:${base58Encode(Buffer.concat([seed, pub]))}` };
}
