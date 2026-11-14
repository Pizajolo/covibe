// Connections set up in Settings → Advanced: extra Claude accounts, ChatGPT
// accounts (the sign-in Codex uses, through covibe's built-in translator), and
// model providers with an API key (Anthropic-compatible, or OpenAI-compatible
// through the same translator). Team files refer to them by id; keys and
// sign-ins never go in a team file.

export type ConnectionKind = 'claude' | 'anthropic' | 'openai' | 'codex';

export interface ProviderModel {
  /** The id the provider expects, e.g. "deepseek-chat". */
  id: string;
  /** Shown in model pickers; defaults to the id. */
  name?: string;
  /** USD per million tokens, for spend estimates. Without it the model's spend shows as unknown. */
  price?: Pricing;
  /** Largest output the model accepts; requests for more are capped. */
  maxOutput?: number;
  /** codex: the reasoning efforts the model takes; a member's effort is lowered to one of them. */
  efforts?: string[];
}

/** USD per million tokens. Cache prices default to the input price (writes) and a tenth of it (reads). */
export interface Pricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface Connection {
  /** What team files use: `account: <id>` or `connection: <id>`. */
  id: string;
  kind: ConnectionKind;
  label: string;
  /** claude: the account's own Claude Code config folder, where its login lives. codex: the folder with its auth.json. */
  configDir?: string;
  /** anthropic / openai: the API's base URL. codex: the ChatGPT backend's Codex API. */
  baseUrl?: string;
  /** anthropic / openai / codex: the models members can pick. */
  models?: ProviderModel[];
  /**
   * openai: the provider signs its answers inside an enclave, and covibe fetches and checks each
   * signature (connections/attest.ts). Unset: on for NEAR AI Cloud's address, off elsewhere.
   */
  attest?: boolean;
  createdAt: string;
}

/** A connection as the API shows it: never the key itself. */
export interface ConnectionView extends Connection {
  /** Has an API key; for a ChatGPT account, is signed in. */
  hasKey: boolean;
}

export interface ConnectionsFile {
  connections: Connection[];
  /** Share work across Claude accounts: members on the subscription without a fixed account use whichever has the most room, and move on when one hits its limit. */
  balance?: boolean;
}

/** The account id for your own `claude login` (never a stored connection). */
export const MAIN_ACCOUNT = 'main';
