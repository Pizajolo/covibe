import type { BackendConfig } from '../config/types.js';
import type { Attestation } from '../connections/attest.js';
import type { Pricing } from '../connections/types.js';

export type Env = Record<string, string | undefined>;

export interface BackendEnv {
  env: Env;
  warnings: string[];
  /** Prices for spend estimates, when Claude Code's own (Claude prices) would be wrong. */
  pricing?: Pricing;
  /** Which account or connection the agent uses: "claude" (your login), "claude:<account>", a connection id, or the backend type. */
  via: string;
  /**
   * On a provider that signs its answers: what it signed about this member's model calls since the
   * last time this was asked (see connections/attest.ts). Unset on every other backend.
   */
  attested?(): Promise<Attestation | undefined>;
}

/**
 * What a connection from Settings → Advanced adds to an agent's environment
 * (resolved by connections/store.ts, which reads the keys).
 */
export interface Link {
  /** A Claude account's own Claude Code config folder. */
  configDir?: string;
  /** An Anthropic-compatible endpoint: a provider's, or covibe's OpenAI translator. */
  baseUrl?: string;
  token?: string;
  /** Send the token as x-api-key (Anthropic's own API) rather than as a bearer token. */
  apiKey?: boolean;
  /** The provider's model, also used for Claude Code's small background requests. */
  model?: string;
  maxOutput?: number;
  pricing?: Pricing;
  attested?(): Promise<Attestation | undefined>;
}

/** Turns a team file's backend into an agent environment, including connections that need keys or a running translator. */
export interface BackendResolver {
  resolve(backend: BackendConfig, parent?: Env): Promise<BackendEnv>;
}

/** Without connections (tests, or nothing set up): plain backends only. */
export const plainBackends: BackendResolver = { resolve: async (backend, parent) => backendEnv(backend, parent) };

// Variables that select a credential or provider. Each backend starts from a
// copy of the parent environment with all of these removed, then sets only the
// ones it needs, so a stray ANTHROPIC_API_KEY can never silently win and bill
// the API when the team file says "subscription".
const AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// Variables a parent Claude Code session sets for its own process tree (when
// covibe itself is started from inside Claude Code, locally or in a cloud
// session). Inherited, they attach every agent to the parent's session, so
// each agent gets them removed.
const HOST_SESSION_PATTERN = /^(CLAUDE_CODE_REMOTE|CLAUDE_CODE_USE_CCR|CLAUDE_CODE_CCR|CCR_|SESSION_INGRESS|CLAUDE_SESSION_INGRESS|CLAUDE_CODE_POST_FOR_SESSION_INGRESS)/;
const HOST_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
];

export class BackendError extends Error {}

/** Build the environment for one agent's Claude Code process. `link` carries what a named account or connection needs. */
export function backendEnv(backend: BackendConfig, parent: Env = process.env, link?: Link, clientApp = 'covibe'): BackendEnv {
  const env: Env = { ...parent, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp };
  const warnings: string[] = [];
  let via: string = backend.type;
  for (const k of [...AUTH_VARS, ...HOST_SESSION_VARS]) delete env[k];
  for (const k of Object.keys(env)) if (HOST_SESSION_PATTERN.test(k)) delete env[k];

  switch (backend.type) {
    case 'subscription':
      // Uses `claude login` credentials, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
      if (parent.ANTHROPIC_API_KEY) {
        warnings.push('ANTHROPIC_API_KEY is set but this agent uses the subscription backend; it was removed from the agent environment.');
      }
      via = 'claude';
      if (backend.account && backend.account !== 'main') {
        // Another account: its login lives in its own config folder. Your own
        // token would win over that login, so it goes.
        if (!link?.configDir) throw new BackendError(`Claude account "${backend.account}" is not set up (Settings → Advanced)`);
        env.CLAUDE_CONFIG_DIR = link.configDir;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        via = `claude:${backend.account}`;
      }
      break;
    case 'connection': {
      if (!backend.connection) throw new BackendError('connection backend: connection is required');
      if (!link?.baseUrl) throw new BackendError(`connection "${backend.connection}" is not set up (Settings → Advanced)`);
      env.ANTHROPIC_BASE_URL = link.baseUrl;
      if (link.token) env[link.apiKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = link.token;
      else warnings.push(`connection "${backend.connection}" has no API key; calling ${link.baseUrl} without one.`);
      const model = backend.model ?? link.model;
      if (model) {
        // Claude Code sends small background requests (titles, summaries) to a
        // Haiku model, which another provider does not have.
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.ANTHROPIC_SMALL_FAST_MODEL = model;
        env.CLAUDE_CODE_SUBAGENT_MODEL = model;
      }
      if (link.maxOutput) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(link.maxOutput);
      // Telemetry, error reports and update checks would go to Anthropic, not the provider.
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      via = backend.connection;
      break;
    }
    case 'api_key': {
      const name = backend.api_key_env ?? 'ANTHROPIC_API_KEY';
      const key = parent[name];
      if (!key) throw new BackendError(`api_key backend: environment variable ${name} is not set`);
      env.ANTHROPIC_API_KEY = key;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      break;
    }
    case 'gateway': {
      if (!backend.base_url) throw new BackendError('gateway backend: base_url is required');
      env.ANTHROPIC_BASE_URL = backend.base_url;
      const name = backend.auth_token_env ?? 'ANTHROPIC_AUTH_TOKEN';
      if (parent[name]) env.ANTHROPIC_AUTH_TOKEN = parent[name];
      else warnings.push(`gateway backend: ${name} is not set; calling ${backend.base_url} without a token.`);
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      break;
    }
    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      if (backend.region) env.AWS_REGION = backend.region;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      break;
    case 'vertex':
      env.CLAUDE_CODE_USE_VERTEX = '1';
      if (backend.region) env.CLOUD_ML_REGION = backend.region;
      if (backend.project) env.ANTHROPIC_VERTEX_PROJECT_ID = backend.project;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      break;
  }
  return { env, warnings, via, ...(link?.pricing ? { pricing: link.pricing } : {}), ...(link?.attested ? { attested: link.attested } : {}) };
}
