import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashResumePrompt, ExitClues, readTail } from '../src/runner/claude-sdk.js';
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

describe("reading Claude Code's debug log", () => {
  it('reports the errors it logged', () => {
    const c = new ExitClues();
    c.stderr(NOTICES);
    c.log(
      [
        '2026-11-02T23:35:01.196Z [WARN] auto mode disabled: model x does not support auto mode',
        '2026-11-02T23:35:01.336Z [DEBUG] something routine',
        '2026-11-02T23:35:01.988Z [ERROR] Error: ENOSPC: no space left on device, write',
        '',
      ].join('\n'),
    );
    const error = c.explain(EXIT, 'Working on it.');
    expect(error).toBe("Claude Code process exited with code 1; Claude Code's log: Error: ENOSPC: no space left on device, write");
  });

  it('still says when nothing explains the stop', () => {
    const c = new ExitClues();
    c.log('2026-11-02T23:35:01.196Z [WARN] auto mode disabled\n2026-11-02T23:35:01.336Z [DEBUG] routine\n');
    expect(c.explain(EXIT)).toMatch(/gave no reason/);
  });
});

describe('the tail of a file', () => {
  it('reads the end and drops a partial first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'covibe-tail-'));
    const file = join(dir, 'log');
    writeFileSync(file, 'first line\nsecond line\nthird line\n');
    expect(readTail(file, 1000)).toBe('first line\nsecond line\nthird line\n');
    expect(readTail(file, 15)).toBe('third line\n');
    expect(readTail(join(dir, 'missing'), 100)).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('picking a session up again after a crash', () => {
  it('carries over the messages it had not read', () => {
    expect(crashResumePrompt([])).toMatch(/Pick up where you left off/);
    expect(crashResumePrompt(['[Message from the human]\nUse port 3000'])).toMatch(/just before it stopped:\n\n\[Message from the human\]\nUse port 3000$/);
  });
});
