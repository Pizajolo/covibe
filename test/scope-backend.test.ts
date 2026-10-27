import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/engine/engine.js';
import { evaluate, evaluateGate } from '../src/engine/expr.js';
import { makeToolChecker } from '../src/engine/scope.js';
import { backendEnv, BackendError } from '../src/runner/backend.js';

describe('makeToolChecker', () => {
  const check = makeToolChecker({ root: '/wt', cwd: '/wt', writeScope: ['web/**'] });

  it('allows writes inside the scope', () => {
    expect(check('Write', { file_path: '/wt/web/app.tsx' })).toBeUndefined();
    expect(check('Edit', { file_path: 'web/deep/x.css' })).toBeUndefined();
  });

  it('blocks writes outside the scope, the worktree and .git', () => {
    expect(check('Edit', { file_path: '/wt/api/server.ts' })).toMatch(/outside your write scope/);
    expect(check('Write', { file_path: '/elsewhere/x' })).toMatch(/outside your workspace/);
    expect(check('Write', { file_path: '/wt/web/../../x' })).toMatch(/outside your workspace/);
    expect(check('NotebookEdit', { notebook_path: '/wt/.git/config' })).toMatch(/\.git/);
  });

  it('ignores tools that do not write files', () => {
    expect(check('Read', { file_path: '/etc/passwd' })).toBeUndefined();
    expect(check('Bash', { command: 'ls' })).toBeUndefined();
  });

  it('treats [] as no writes and undefined as the whole worktree', () => {
    expect(makeToolChecker({ root: '/wt', cwd: '/wt', writeScope: [] })('Write', { file_path: '/wt/a' })).toMatch(/none/);
    expect(makeToolChecker({ root: '/wt', cwd: '/wt', writeScope: undefined })('Write', { file_path: '/wt/a' })).toBeUndefined();
  });
});

describe('backendEnv', () => {
  const parent = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_BASE_URL: 'http://old', LITELLM: 'tok' };

  it('subscription strips API credentials so they cannot silently win', () => {
    const { env, warnings } = backendEnv({ type: 'subscription' }, parent);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(env.PATH).toBe('/bin');
    expect(warnings[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('detaches agents from a parent Claude Code session', () => {
    const { env } = backendEnv({ type: 'subscription' }, { ...parent, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_REMOTE_SESSION_ID: 'r', SESSION_INGRESS_URL: 'u', CLAUDE_CODE_MAX_RETRIES: '3' });
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(env).not.toHaveProperty('CLAUDE_CODE_REMOTE_SESSION_ID');
    expect(env).not.toHaveProperty('SESSION_INGRESS_URL');
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('3');
  });

  it('api_key reads the named variable and drops the OAuth token', () => {
    const { env } = backendEnv({ type: 'api_key', api_key_env: 'LITELLM' }, parent);
    expect(env.ANTHROPIC_API_KEY).toBe('tok');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(() => backendEnv({ type: 'api_key', api_key_env: 'MISSING' }, parent)).toThrow(BackendError);
  });

  it('gateway sets the base URL and token', () => {
    const { env } = backendEnv({ type: 'gateway', base_url: 'http://localhost:4000', auth_token_env: 'LITELLM' }, parent);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('bedrock and vertex set their provider flags', () => {
    expect(backendEnv({ type: 'bedrock', region: 'eu-west-1' }, parent).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' });
    expect(backendEnv({ type: 'vertex', project: 'p' }, parent).env).toMatchObject({ CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'p' });
  });
});

describe('expressions', () => {
  const ctx = { plan: { tasks: [{ owner: 'frontend', id: 1 }, { owner: 'backend', id: 2 }, { owner: 'frontend', id: 3 }] }, review: { blocking_count: 0 } };

  it('select tasks by owner', async () => {
    expect(await evaluate("plan.tasks[owner = 'frontend'].id", ctx)).toEqual([1, 3]);
    expect(await evaluate("plan.tasks[owner = 'qa']", ctx)).toBeUndefined();
  });

  it('gates pass only on literal true', async () => {
    expect((await evaluateGate('review.blocking_count = 0', ctx)).passed).toBe(true);
    expect((await evaluateGate('review.blocking_count', ctx)).passed).toBe(false);
    expect((await evaluateGate('test.failed = 0', ctx)).passed).toBe(false);
  });
});

describe('extractJson', () => {
  it('takes the last fenced JSON block, or the whole text', () => {
    expect(extractJson('first\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('{"b":true}')).toEqual({ b: true });
    expect(extractJson('no json here')).toBeUndefined();
  });
});
