// Shapes shared by the market module: what the contract returns, what travels
// through the relay, and what the owner's covibe keeps about each order.

/** An order's state on-chain (see market/contract). */
export type OrderStatus = 'PLACED' | 'ACCEPTED' | 'DELIVERED' | 'DECLINED' | 'EXPIRED' | 'FAILED' | 'DISPUTED' | 'SETTLED' | 'REVISION_REQUESTED';

export const OPEN_STATUSES: OrderStatus[] = ['PLACED', 'ACCEPTED', 'DELIVERED', 'REVISION_REQUESTED'];

export interface ListingStats {
  completed: number;
  declined: number;
  expired: number;
  failed: number;
  disputed: number;
}

/** What an owner sets on a listing (create_listing, update_listing). */
export interface ListingInput {
  title: string;
  summary: string;
  meta_hash: string;
  /** yoctoNEAR. */
  price: string;
  accept_window_s: number;
  delivery_window_s: number;
  review_window_s: number;
  intake_pubkey: string;
  /** Revisions per order the contract takes without asking the owner (0 to 5). */
  revisions?: number;
}

export interface Listing extends ListingInput {
  id: number;
  owner: string;
  active: boolean;
  stats: ListingStats;
  created_at: number;
  /** Reviews of this listing, and their stars added up (the average is sum / count). */
  rating_count?: number;
  rating_sum?: number;
}

/** A customer's review of an order that was delivered and is closed. */
export interface Review {
  order_id: number;
  listing_id: number;
  customer: string;
  /** 1 to 5. */
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
  /** Milliseconds since the epoch (block time). */
  created_at: number;
  accepted_at: number | null;
  delivered_at: number | null;
  closed_at: number | null;
  receipt_hash: string | null;
  bundle_hash: string | null;
  reason: string | null;
  /** Revisions taken without asking (locked when the order was placed), and how many the team was sent back for. */
  revisions_included?: number;
  revisions_used?: number;
  /** sha256 of the customer's latest revision note (encrypted, in the relay). */
  revision_hash?: string | null;
  /** When a request that waits for the owner was made. */
  revision_requested_at?: number | null;
  review?: Review | null;
}

export interface ChainConfig {
  admin: string;
  treasury: string;
  fee_bps: number;
  min_price: string;
  max_price: string;
  max_open_orders: number;
  listings: number;
  orders: number;
}

/** One field of a listing's order form. */
export interface InputField {
  name: string;
  label?: string;
  help?: string;
  type: 'text' | 'files';
  required?: boolean;
  /** text: the longest text accepted. */
  max_chars?: number;
  /** files: extensions accepted (".mp4"), how many, and the folder they go to in the team's workspace. */
  accept?: string[];
  max_files?: number;
  folder?: string;
}

/** The listing's page, kept in the relay; its sha256 is the listing's meta_hash. */
export interface ListingMeta {
  v: 1;
  title: string;
  summary: string;
  description: string;
  inputs: InputField[];
  examples: { title: string; text?: string; media?: string; media_type?: string }[];
  /** What the customer is told about who sees their input. */
  privacy: string;
  max_input_mb: number;
  intake_mode: IntakeMode;
}

/**
 * Where a file's bytes are: in the relay, as encrypted chunks stored under their hashes.
 * Chunk i is AES-256-GCM under `key` with i as the nonce (see sealChunk), so chunks
 * cannot be swapped or reordered, and a file of any size is sent and read piece by piece.
 */
export interface BlobRef {
  /** The file's own AES-256 key, base64. */
  key: string;
  /** Bytes of the file in each chunk (the last one may be shorter). */
  chunk: number;
  /** sha256 of each encrypted chunk, in order. */
  chunks: string[];
}

/** A customer's order input, before encryption. */
export interface OrderInput {
  v: 1;
  fields: Record<string, string>;
  /** A file is `blob` (chunks in the relay, with its `size`), or small and inline as base64 `data`. */
  files: { field: string; name: string; type?: string; data?: string; size?: number; blob?: BlobRef }[];
  /** x25519 key (base64) the delivery bundle is encrypted to. */
  reply_pubkey?: string;
}

/** What a delivery bundle is: the list of delivered files, sealed to the customer. Its hash goes on-chain. */
export interface Delivery {
  v: 2;
  files: { name: string; size: number; type?: string; blob: BlobRef }[];
}

export type IntakeMode = 'manual' | 'recommend' | 'auto';

export interface Storefront {
  title: string;
  summary: string;
  description: string;
  price_near: number;
  windows: { accept_min: number; delivery_min: number; review_min: number };
  intake: {
    mode: IntakeMode;
    /** The run stops when it has spent this much. */
    budget_cap_usd: number;
    /** What an order usually costs to run (the pre-check compares it, and past runs, with the cap). */
    estimated_cost_usd?: number;
    /** Orders locked below this price are not taken. */
    min_price_near: number;
    /** auto: act alone only when the agent's scope_fit is at least this. */
    auto_min_fit: number;
    max_input_mb: number;
    /** What this team takes and what it does not, in the owner's words. */
    policy: string;
  };
  inputs: InputField[];
  examples: { title: string; text?: string; file?: string }[];
  /** What the team is asked to do with an order; the order itself follows as data. */
  goal: string;
  deliverables: { folder: string; gates_required: string[] };
  /** What the team works in: a plain folder, or a git repository with the order as its first commit. */
  workspace: 'folder' | 'git';
  /** Domains the team may reach while it works on an order (shell commands and WebFetch). None unless named here. */
  network: string[];
  /** Revisions per order that are taken automatically; a request beyond them waits for the owner. */
  revisions: { included: number };
  privacy: string;
}

export interface Precheck {
  name: 'schema' | 'size' | 'file_types' | 'price_floor' | 'budget';
  ok: boolean;
  detail: string;
}

/** What the intake agent returns. */
export interface IntakeDecision {
  decision: 'accept' | 'decline' | 'need_info';
  reason: string;
  scope_fit: number;
  estimated_cost: string;
  risks: string[];
}

/** The signed record of a run that the customer can check against the chain. */
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
  public_key: string;
  /** ed25519 over the receipt's JSON without this field (base64). */
  signature?: string;
}

export interface MarketSettings {
  network: 'testnet' | 'mainnet' | 'custom';
  rpcUrl: string;
  contractId: string;
  accountId: string;
  relayUrl: string;
  /** Where customers order (shown in the app and the CLI). */
  storefrontUrl: string;
  /** Watch for orders while the app is open. */
  watch: boolean;
  pollSeconds: number;
}

/**
 * Where an order stands on the owner's side. new: seen on-chain. checking: pre-checks and
 * intake. awaiting_owner: needs the owner's accept or decline. running: the team works.
 * needs_owner: the run stopped (budget, failed gates, an error) and the owner decides.
 * delivered: on-chain, in the customer's review window. closed: over, either way.
 */
export type Stage = 'new' | 'checking' | 'awaiting_owner' | 'running' | 'needs_owner' | 'delivered' | 'closed';

export interface LocalOrder {
  id: number;
  listingId: number;
  team: string;
  stage: Stage;
  /** The order as last read from the chain. */
  chain: Order;
  /** What the customer wrote (text fields only), for the inbox. */
  brief?: Record<string, string>;
  files?: { field: string; name: string; size: number }[];
  prechecks?: Precheck[];
  intake?: IntakeDecision;
  intakeRunId?: string;
  /** What covibe suggests, and why. */
  recommendation?: { action: 'accept' | 'decline'; reason: string };
  decidedBy?: 'owner' | 'auto';
  workspace?: string;
  projectId?: string;
  runId?: string;
  runStatus?: string;
  costUsd?: number;
  gates?: { name: string; passed: boolean }[];
  /** x25519 key (base64) the delivery bundle is encrypted to, from the order's input. */
  replyKey?: string;
  /** Why it waits for the owner, or what went wrong. */
  note?: string;
  /** The customer's latest revision request: its number, the note's hash on-chain, and the note (or why it cannot be read). */
  revision?: { n: number; hash: string; note?: string; problem?: string };
  /** The revision the team was last started on (0 or unset: the order itself). */
  revisionRun?: number;
  /** Result branch of the last delivered run (git workspaces): a revision starts from it. */
  resultBranch?: string;
  txs: Partial<Record<'accept' | 'decline' | 'fail' | 'deliver' | 'settle' | 'revision', string>>;
  updatedAt: string;
}

export interface MarketState {
  /** Published storefronts: team key → its listing. */
  listings: Record<string, { listingId: number; contractId: string; metaHash: string; publishedAt: string }>;
  orders: Record<string, LocalOrder>;
}

export interface Earnings {
  /** yoctoNEAR paid out to the owner (settled orders, after the fee). */
  earned: string;
  /** Platform fees on those orders. */
  fees: string;
  /** In escrow for delivered orders still in review. */
  inReview: string;
  /** In escrow for orders placed or accepted. */
  inEscrow: string;
  settled: number;
  refunded: number;
}

export interface Overview {
  settings: MarketSettings;
  publicKey?: string;
  ready: boolean;
  /** What is missing before the market can be used. */
  missing: string[];
  listings: { team: string; listingId: number; contractId: string; publishedAt: string; listing?: Listing; url: string }[];
  orders: LocalOrder[];
  earnings: Earnings;
  watching: boolean;
  lastTick?: string;
  lastError?: string;
}

/** One team of the library as the Market page lists it. */
export interface MarketTeam {
  id: string;
  name: string;
  description?: string;
  hasStorefront: boolean;
  /** What is wrong with its storefront.yaml (empty when it can be published). */
  problems: string[];
  title?: string;
  summary?: string;
  /** The first example that is an image or a video (a path in the team folder), for the storefront's card. */
  cover?: string;
  priceNear?: number;
  mode?: IntakeMode;
  listingId?: number;
  url?: string;
  active?: boolean;
  stats?: ListingStats;
  rating?: { count: number; sum: number };
  /** The page on-chain differs from the file: publish again to update it. */
  outdated?: boolean;
}

/** What the app's Market page shows. */
export interface MarketView extends Overview {
  teams: MarketTeam[];
  /** yoctoNEAR on the owner's account, when it could be read. */
  balance?: string;
  feeBps?: number;
  secretStore: 'keychain' | 'file';
  explorer: { account?: string; contract?: string; tx: Record<string, string> };
}

export class MarketError extends Error {}
