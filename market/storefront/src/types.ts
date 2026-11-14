// The contract's and the relay's shapes, as the storefront reads them
// (the same as src/market/types.ts in covibe).
export type OrderStatus = 'PLACED' | 'ACCEPTED' | 'DELIVERED' | 'DECLINED' | 'EXPIRED' | 'FAILED' | 'DISPUTED' | 'SETTLED' | 'REVISION_REQUESTED';

export interface Listing {
  id: number;
  owner: string;
  title: string;
  summary: string;
  meta_hash: string;
  price: string;
  accept_window_s: number;
  delivery_window_s: number;
  review_window_s: number;
  intake_pubkey: string;
  active: boolean;
  stats: { completed: number; declined: number; expired: number; failed: number; disputed: number };
  created_at: number;
  /** Revisions per order the team does without asking the owner. */
  revisions?: number;
  /** Reviews, and their stars added up. */
  rating_count?: number;
  rating_sum?: number;
}

/** A customer's review of an order that was delivered and is closed. */
export interface Review {
  order_id: number;
  listing_id: number;
  customer: string;
  stars: number;
  comment: string;
  created_at: number;
}

export interface Order {
  id: number;
  listing_id: number;
  customer: string;
  owner: string;
  price: string;
  fee_bps: number;
  input_hash: string;
  access_key: string | null;
  status: OrderStatus;
  created_at: number;
  accepted_at: number | null;
  delivered_at: number | null;
  closed_at: number | null;
  receipt_hash: string | null;
  bundle_hash: string | null;
  reason: string | null;
  revisions_included?: number;
  revisions_used?: number;
  revision_hash?: string | null;
  revision_requested_at?: number | null;
  review?: Review | null;
}

export interface InputField {
  name: string;
  label?: string;
  help?: string;
  type: 'text' | 'files';
  required?: boolean;
  max_chars?: number;
  accept?: string[];
  max_files?: number;
}

export interface ListingMeta {
  v: 1;
  title: string;
  summary: string;
  description: string;
  inputs: InputField[];
  examples: { title: string; text?: string; media?: string; media_type?: string }[];
  privacy: string;
  max_input_mb: number;
  intake_mode: 'manual' | 'recommend' | 'auto';
}

/** Where a file's bytes are: encrypted chunks in the relay, under their hashes (see src/market/types.ts). */
export interface BlobRef {
  key: string;
  chunk: number;
  chunks: string[];
}

/** What a delivery bundle holds once opened: the delivered files. */
export interface Delivery {
  v: 2;
  files: { name: string; size: number; type?: string; blob: BlobRef }[];
}

export interface Receipt {
  v: 1;
  contract: string;
  order_id: number;
  listing_id: number;
  input_hash: string;
  bundle_hash: string;
  run_status: string;
  gates: { name: string; passed: boolean }[];
  event_log_hash: string;
  started: string;
  finished: string;
  owner: string;
  /** Model calls an enclave provider signed (NEAR AI Cloud), as the owner's covibe recorded and checked them. */
  attestation?: { v: 1; provider: string; calls: { run: 'intake' | 'team'; model: string; verified: boolean }[]; reports: { model: string; signers: { intel_quote?: string }[] }[] };
  public_key: string;
  signature?: string;
}

export interface Config {
  network: 'testnet' | 'mainnet' | 'custom';
  rpcUrl: string;
  contractId: string;
  relayUrl: string;
}

/** The keys the browser keeps for one order. Without them its bundle cannot be opened. */
export interface OrderKeys {
  access: { publicKey: string; privateJwk: JsonWebKey };
  reply: { publicKey: string; privateJwk: JsonWebKey };
  listingId: number;
  createdAt: number;
}
