import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadTeam } from '../src/config/load.js';
import { tempDir, writeFiles } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

function teamFile(yaml: string, extra: Record<string, string> = {}) {
  const dir = tempDir();
  writeFiles(dir, { 'team.yaml': yaml, 'prompts/a.md': 'You are A.', ...extra });
  return join(dir, 'team.yaml');
}

function problems(path: string): string[] {
  try {
    loadTeam(path);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

const MINIMAL = `
version: 1
name: t
agents:
  a: { prompt: prompts/a.md, tools: [Read] }
workflow:
  steps:
    - { id: one, agent: a }
`;

describe('loadTeam', () => {
  it('loads the example team and resolves prompts, schemas and defaults', () => {
    const team = loadTeam(EXAMPLE);
    expect(Object.keys(team.agents)).toEqual(['manager', 'frontend', 'backend', 'qa', 'tester']);
    expect(team.agents.manager!.prompt).toContain('engineering manager');
    expect(team.agents.manager!.writes).toBe(false);
    expect(team.agents.frontend!.writeScope).toEqual(['web/**']);
    // YAML anchors work: backend reuses the frontend tool list.
    expect(team.agents.backend!.tools).toEqual(team.agents.frontend!.tools);
    expect(team.agents.qa!.limits).toEqual({ max_turns: 40, timeout_min: 30 });
    const review = team.steps.find((s) => s.id === 'review')!;
    // The workflow-level on_gate_fail applies to gated steps.
    expect(review.onGateFail).toMatchObject({ goto: 'build', maxLoops: 3, then: 'escalate_to_human' });
    expect(team.steps.find((s) => s.id === 'plan')!.onGateFail).toBeUndefined();
  });

  it('accepts a minimal file and fills in defaults', () => {
    const team = loadTeam(teamFile(MINIMAL));
    expect(team.isolation).toBe('worktree');
    expect(team.maxParallel).toBe(2);
    expect(team.agents.a!.backend).toEqual({ type: 'subscription' });
  });

  it('accepts plain JSON, since JSON is YAML 1.2', () => {
    const json = JSON.stringify({
      version: 1,
      name: 't',
      agents: { a: { prompt: 'prompts/a.md', tools: ['Read'] } },
      workflow: { steps: [{ id: 'one', agent: 'a' }] },
    });
    expect(loadTeam(teamFile(json)).name).toBe('t');
  });

  it('rejects duplicate keys', () => {
    const p = problems(teamFile(MINIMAL.replace('name: t', 'name: t\nname: u')));
    expect(p.join('\n')).toMatch(/unique/i);
  });

  it('rejects unknown fields with their path', () => {
    const p = problems(teamFile(MINIMAL.replace('tools: [Read]', 'tools: [Read], colour: blue')));
    expect(p).toContain('/agents/a: unknown field "colour"');
  });

  it('keeps YAML 1.2 scalars as written (no "NO" → false surprises)', () => {
    const team = loadTeam(teamFile(MINIMAL.replace('name: t', 'name: t\ndescription: NO')));
    expect(team.description).toBe('NO');
  });

  it('checks cross references', () => {
    const yaml = `
version: 1
name: t
agents:
  a: { prompt: prompts/a.md, tools: [Read], can_message: [ghost] }
workflow:
  steps:
    - { id: one, agent: nobody }
    - id: two
      agent: a
      gate: "x = 1"
      on_gate_fail: { goto: three, max_loops: 1 }
    - { id: three, agent: a, gate: "((" }
`;
    const p = problems(teamFile(yaml));
    expect(p).toEqual(
      expect.arrayContaining([
        '/agents/a/can_message: unknown agent "ghost"',
        '/workflow/steps/0/agent: unknown agent "nobody"',
        '/workflow/steps/1/on_gate_fail/goto: must point at this or an earlier step',
      ]),
    );
    expect(p.some((x) => x.startsWith('/workflow/steps/2/gate: invalid expression'))).toBe(true);
  });

  it('reports missing prompt and schema files', () => {
    const p = problems(teamFile(MINIMAL.replace('tools: [Read]', 'tools: [Read], output_schema: nope.json').replace('prompts/a.md', 'prompts/missing.md')));
    expect(p).toEqual(['/agents/a/prompt: file "prompts/missing.md" not found', '/agents/a/output_schema: output schema "nope.json" not found']);
  });

  it('rejects reserved step ids and a write scope without write tools', () => {
    const p = problems(teamFile(MINIMAL.replace('id: one', 'id: goal').replace('tools: [Read]', 'tools: [Read], scope: { write: ["src/**"] }')));
    expect(p).toEqual(
      expect.arrayContaining(['/workflow/steps: "goal" is reserved and cannot be a step id', '/agents/a/scope: has a write scope but no tool that can write']),
    );
  });

  it('requires base_url for a gateway backend', () => {
    const p = problems(teamFile(MINIMAL.replace('tools: [Read]', 'tools: [Read], backend: { type: gateway }')));
    expect(p.join('\n')).toMatch(/base_url/);
  });

  it('accepts inline multi-line prompts', () => {
    const team = loadTeam(teamFile(MINIMAL.replace('prompt: prompts/a.md, ', 'prompt: "Line one\\nLine two", ')));
    expect(team.agents.a!.prompt).toBe('Line one\nLine two');
  });
});
