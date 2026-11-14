// Signed answers from a provider that runs models in enclaves (NEAR AI Cloud).
// The provider signs each answer over the exact bytes of the request and the
// response; an attestation report names the keys that may sign and carries the
// hardware quote (Intel TDX) that vouches for them.
//
// What covibe checks: the signature, that it covers the bytes covibe sent and
// received, and that the signing key is one the report names for covibe's own
// nonce. What it does not check: the hardware quote itself. It is kept as it
// came, so anyone can verify it with Intel's tooling (dcap-qvl).
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

/** One model call and what the provider signed about it. */
export interface AttestedCall {
  model: string;
  /** The provider's id of the completion. */
  chat_id: string;
  /** sha256 of the request body as sent, and of the response body as received (hex). */
  request_hash: string;
  response_hash: string;
  at: string;
  /** provider_tee: signed by the enclave that served the model. gateway: signed by the provider's gateway. */
  signature_kind?: string;
  text?: string;
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  /** The signature is valid, covers these hashes, and its key is named in a report fetched with covibe's nonce. */
  verified: boolean;
  /** Why it is not verified. */
  problem?: string;
}

/** A key the attestation report names, with the hardware quote that vouches for it (not verified by covibe). */
export interface AttestedSigner {
  kind: 'model' | 'gateway';
  signing_address: string;
  signing_algo: string;
  /** The nonce the report echoes; it must be the one covibe sent. */
  request_nonce?: string;
  intel_quote?: string;
}

export interface AttestationReport {
  model: string;
  /** The nonce covibe sent with the request for this report. */
  nonce: string;
  fetched_at: string;
  /** sha256 of the report as it was received. */
  report_hash: string;
  signers: AttestedSigner[];
}

/** What one member's model calls left behind. */
export interface Attestation {
  /** The provider's host. */
  provider: string;
  calls: AttestedCall[];
  reports: AttestationReport[];
}

const ALGO = 'ed25519';
const REPORT_TTL_MS = 10 * 60_000;
const SIGNATURE_TRIES = 6;
const DRAIN_TIMEOUT_MS = 20_000;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(text: string): Buffer | undefined {
  let n = 0n;
  for (const ch of text) {
    const i = BASE58.indexOf(ch);
    if (i < 0) return undefined;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const zeros = /^1*/.exec(text)![0].length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(n ? hex : '', 'hex')]);
}

/** Key or signature bytes as a provider may write them: hex (with or without 0x), base64, or base58 (with or without "ed25519:"). */
export function decodeBytes(text: string, length: number): Buffer | undefined {
  const t = text.trim().replace(/^ed25519:/, '');
  const hex = t.replace(/^0x/i, '');
  if (hex.length === length * 2 && /^[0-9a-f]+$/i.test(hex)) return Buffer.from(hex, 'hex');
  if (/^[A-Za-z0-9+/_-]+=*$/.test(t)) {
    const b = Buffer.from(t, t.includes('-') || t.includes('_') ? 'base64url' : 'base64');
    if (b.length === length) return b;
  }
  const b = base58(t);
  return b?.length === length ? b : undefined;
}

/** An ed25519 signature over the text's UTF-8 bytes, with the signing address as the public key. */
export function verifyEd25519(address: string, text: string, signature: string): boolean {
  const key = decodeBytes(address, 32);
  const sig = decodeBytes(signature, 64);
  if (!key || !sig) return false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(text, 'utf8'), pub, sig);
  } catch {
    return false;
  }
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** The keys a report names. The report's shape is read loosely: a field that is missing is a signer that is missing. */
export function signersOf(report: unknown): AttestedSigner[] {
  const out: AttestedSigner[] = [];
  const take = (kind: AttestedSigner['kind'], v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o.signing_address !== 'string' || !o.signing_address) return;
    out.push({
      kind,
      signing_address: o.signing_address,
      signing_algo: typeof o.signing_algo === 'string' ? o.signing_algo : ALGO,
      ...(typeof o.request_nonce === 'string' ? { request_nonce: o.request_nonce } : {}),
      ...(typeof o.intel_quote === 'string' ? { intel_quote: o.intel_quote } : {}),
    });
  };
  const r = (report ?? {}) as Record<string, unknown>;
  for (const m of Array.isArray(r.model_attestations) ? r.model_attestations : []) take('model', m);
  take('gateway', r.gateway_attestation);
  return out;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.replace(/^0x/i, '').toLowerCase() === b.replace(/^0x/i, '').toLowerCase();

/**
 * Check one signed answer against the bytes that were sent and received and
 * against the report. Returns what is wrong, or nothing when it holds.
 */
export function signatureProblem(sig: Record<string, unknown>, call: { model: string; request_hash: string; response_hash: string }, report: AttestationReport | undefined): string | undefined {
  const { text, signature, signing_address: address, signing_algo: algo, signature_kind: kind } = sig as Record<string, string | undefined>;
  if (typeof text !== 'string' || typeof signature !== 'string' || typeof address !== 'string') return 'the provider returned no signature';
  if (algo !== ALGO) return `the signature uses ${algo ?? 'an unnamed algorithm'}; covibe checks ${ALGO} only`;
  const hashes = `${call.request_hash}:${call.response_hash}`;
  const expected = kind === 'provider_tee' ? `${call.model}:${hashes}` : kind === 'gateway' ? hashes : undefined;
  if (!expected) return `the signature is of an unknown kind (${kind ?? 'none'})`;
  if (text.toLowerCase() !== expected.toLowerCase()) return 'the signed text does not match the request and response that were sent and received';
  if (!verifyEd25519(address, text, signature)) return 'the signature does not verify';
  if (!report) return 'no attestation report could be fetched, so the signing key is not tied to an enclave';
  const matches = report.signers.filter((s) => s.kind === (kind === 'provider_tee' ? 'model' : 'gateway') && s.signing_algo === algo && same(s.signing_address, address));
  if (matches.length !== 1) return matches.length ? 'the attestation report names the signing key more than once' : 'the signing key is not in the attestation report';
  if (!same(matches[0]!.request_nonce, report.nonce)) return "the attestation report does not echo covibe's nonce";
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches reports and signatures from one provider, and keeps what each member's calls produced until it is collected. */
export class Attestor {
  private readonly reports = new Map<string, { at: number; value: Promise<AttestationReport | undefined> }>();
  private readonly pending = new Map<string, Promise<{ call: AttestedCall; report?: AttestationReport }>[]>();

  constructor(
    private readonly baseUrl: string,
    private readonly key?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { accept: 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) };
  }

  /** The attestation report for a model, fetched with a fresh nonce and kept for a few minutes. Unset when the provider gives none. */
  report(model: string): Promise<AttestationReport | undefined> {
    const kept = this.reports.get(model);
    if (kept && Date.now() - kept.at < REPORT_TTL_MS) return kept.value;
    const nonce = randomBytes(32).toString('hex');
    const value = (async () => {
      const q = new URLSearchParams({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: ALGO, nonce });
      const res = await this.fetcher(`${this.baseUrl}/attestation/report?${q.toString()}`, { headers: { ...this.headers(), 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return undefined;
      const raw = await res.text();
      return { model, nonce, fetched_at: new Date().toISOString(), report_hash: sha256(raw), signers: signersOf(JSON.parse(raw)) };
    })().catch(() => undefined);
    this.reports.set(model, { at: Date.now(), value });
    // A report that could not be fetched is asked for again next time.
    void value.then((r) => {
      if (!r && this.reports.get(model)?.value === value) this.reports.delete(model);
    });
    return value;
  }

  private async signature(chatId: string): Promise<Record<string, unknown> | string> {
    for (let i = 0; i < SIGNATURE_TRIES; i++) {
      // The signature is stored a moment after the answer ends.
      if (i) await sleep(400 * i);
      try {
        const res = await this.fetcher(`${this.baseUrl}/signature/${encodeURIComponent(chatId)}?signing_algo=${ALGO}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) continue;
        if (!res.ok) return `the provider answered ${res.status} for the signature`;
        const body = (await res.json()) as Record<string, unknown>;
        if (body.error_code) return `the provider has no signature for this answer (${String(body.message ?? body.error_code)})`;
        return body;
      } catch (err) {
        if (i === SIGNATURE_TRIES - 1) return `the signature could not be fetched: ${(err as Error).message}`;
      }
    }
    return 'the provider has no signature for this answer';
  }

  /** Note one finished model call under a member's tag; its signature is fetched and checked in the background. */
  record(tag: string, c: { model: string; chatId?: string; requestHash: string; responseHash: string }): void {
    const call: AttestedCall = { model: c.model, chat_id: c.chatId ?? '', request_hash: c.requestHash, response_hash: c.responseHash, at: new Date().toISOString(), verified: false };
    const job = (async () => {
      const report = await this.report(c.model);
      if (!c.chatId) return { call: { ...call, problem: 'the answer carried no id to ask a signature for' }, report };
      const sig = await this.signature(c.chatId);
      if (typeof sig === 'string') return { call: { ...call, problem: sig }, report };
      const problem = signatureProblem(sig, call, report);
      const str = (k: string) => (typeof sig[k] === 'string' ? { [k]: sig[k] as string } : {});
      return { call: { ...call, ...str('signature_kind'), ...str('text'), ...str('signature'), ...str('signing_address'), ...str('signing_algo'), verified: !problem, ...(problem ? { problem } : {}) }, report };
    })().catch((err) => ({ call: { ...call, problem: (err as Error).message }, report: undefined }));
    this.pending.set(tag, [...(this.pending.get(tag) ?? []), job]);
  }

  /** Collect what a member's calls produced so far (waiting for signatures still on their way), and forget it. */
  async drain(tag: string): Promise<Attestation | undefined> {
    const jobs = this.pending.get(tag);
    this.pending.delete(tag);
    if (!jobs?.length) return undefined;
    const late = { call: undefined, report: undefined };
    const done = await Promise.all(jobs.map((j) => Promise.race([j, sleep(DRAIN_TIMEOUT_MS).then(() => late)])));
    const calls = done.flatMap((d) => (d.call ? [d.call] : []));
    const reports = new Map<string, AttestationReport>();
    for (const d of done) if (d.report) reports.set(d.report.report_hash, d.report);
    return calls.length ? { provider: new URL(this.baseUrl).hostname, calls, reports: [...reports.values()] } : undefined;
  }
}

/** A provider that signs its answers, by its address (NEAR AI Cloud). */
export const attestsByDefault = (baseUrl: string | undefined): boolean => {
  try {
    return !!baseUrl && /(^|\.)cloud-api\.near\.ai$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

/** Several members' attestations as one: every call, and each report once. */
export function mergeAttestations(parts: (Attestation | undefined)[]): Attestation | undefined {
  const all = parts.filter((p): p is Attestation => !!p && p.calls.length > 0);
  if (!all.length) return undefined;
  const reports = new Map<string, AttestationReport>();
  for (const p of all) for (const r of p.reports) reports.set(r.report_hash, r);
  return { provider: [...new Set(all.map((p) => p.provider))].join(', '), calls: all.flatMap((p) => p.calls), reports: [...reports.values()] };
}
