// Connections set up in Settings → Advanced: extra Claude accounts, and model
// providers with an API key (Anthropic-compatible, or OpenAI-compatible through
// covibe's built-in translator). Team files refer to them by id; keys never go
// in a team file.

export type ConnectionKind = 'claude' | 'anthropic' | 'openai';

export interface ProviderModel {
  /** The id the provider expects, e.g. "deepseek-chat". */
  id: string;
  /** Shown in model pickers; defaults to the id. */
  name?: string;
  /** USD per million tokens, for spend estimates. Without it the model's spend shows as unknown. */
  price?: Pricing;
  /** Largest output the model accepts; requests for more are capped. */
  maxOutput?: number;
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
  /** claude: the account's own Claude Code config folder, where its login lives. */
  configDir?: string;
  /** anthropic / openai: the API's base URL. */
  baseUrl?: string;
  /** anthropic / openai: the models members can pick. */
  models?: ProviderModel[];
  createdAt: string;
}

/** A connection as the API shows it: never the key itself. */
export interface ConnectionView extends Connection {
  hasKey: boolean;
}

export interface ConnectionsFile {
  connections: Connection[];
  /** Share work across Claude accounts: members on the subscription without a fixed account use whichever has the most room, and move on when one hits its limit. */
  balance?: boolean;
}

/** The account id for your own `claude login` (never a stored connection). */
export const MAIN_ACCOUNT = 'main';
