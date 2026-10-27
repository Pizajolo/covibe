import type { BackendConfig } from '../config/types.js';

export type Env = Record<string, string | undefined>;

export interface BackendEnv {
  env: Env;
  warnings: string[];
}

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

/** Build the environment for one agent's Claude Code process. */
export function backendEnv(backend: BackendConfig, parent: Env = process.env, clientApp = 'covibe'): BackendEnv {
  const env: Env = { ...parent, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp };
  const warnings: string[] = [];
  for (const k of [...AUTH_VARS, ...HOST_SESSION_VARS]) delete env[k];
  for (const k of Object.keys(env)) if (HOST_SESSION_PATTERN.test(k)) delete env[k];

  switch (backend.type) {
    case 'subscription':
      // Uses `claude login` credentials, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
      if (parent.ANTHROPIC_API_KEY) {
        warnings.push('ANTHROPIC_API_KEY is set but this agent uses the subscription backend; it was removed from the agent environment.');
      }
      break;
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
  return { env, warnings };
}
