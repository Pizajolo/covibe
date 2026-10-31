import { describe, expect, it } from 'vitest';
import { ExitClues } from '../src/runner/claude-sdk.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const NOTICES =
  '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization\'s connectors\n[claude-code:unrecognized_model] {"model":"gpt-6.1-sol","query_source":"sdk"}\n';
const EXIT = `Claude Code process exited with code 1. stderr: ${NOTICES.trim()}`;

describe('explaining an unexpected exit', () => {
  it('drops the usual notices and says when nothing else was reported', () => {
    const c = new ExitClues();
    c.stderr(NOTICES);
    const error = c.explain(EXIT, 'Setting up the Electron main process now.');
    expect(error).not.toMatch(/unrecognized_model|connectors are disabled/);
    expect(error).toMatch(/^Claude Code process exited with code 1; Claude Code gave no reason/);
    expect(error).toMatch(/last message: "Setting up the Electron main process now\."/);
  });

  it('reports the provider error, retries and other stderr', () => {
    const c = new ExitClues();
    c.stderr(NOTICES + 'Error: something real broke\n');
    c.see({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 1000, error_status: 502, error: 'server_error' } as unknown as SDKMessage);
    c.see({ type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 502 the Codex API stream broke: terminated' }] } } as unknown as SDKMessage);
    const error = c.explain(EXIT);
    expect(error).toContain('last API error: API Error: 502 the Codex API stream broke');
    expect(error).toContain("provider's last failed answer: 502 (server_error), retry 3 of 10");
    expect(error).toContain('stderr: Error: something real broke');
    expect(error).not.toContain('unrecognized_model');
  });

  it('leaves other errors alone', () => {
    expect(new ExitClues().explain('Claude Code returned an error result: API Error: 401')).toBe('Claude Code returned an error result: API Error: 401');
  });
});
