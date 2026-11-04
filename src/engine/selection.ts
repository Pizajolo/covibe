// Which members a run needs. Every member of a workflow step is a session of
// its own (Claude Code's system prompt and tools, then reading the project),
// so running one the goal does not need costs a full session for nothing. The
// planner decides: it names the members the goal needs (select_members, or a
// `members` list in its plan report), and the steps of the others are
// skipped. A member that owns a task on the plan always runs, and a step the
// team file marks `required` always runs in full.
//
// Fix rounds are narrowed the same way: when every item of the feedback names
// its owner, only the branches of those owners run again.
import type { Step, TeamConfig } from '../config/types.js';
import type { CustomTool } from '../runner/types.js';

export const SELECT_TOOL = 'select_members';

/** Whether a step is where its member plans the run: a step named plan (or planning), or the lead's first step. */
export function isPlanningStep(team: TeamConfig, agent: string, stepId: string): boolean {
  return /^plan(ning)?$/i.test(stepId) || (team.lead === agent && team.steps[0]?.id === stepId);
}

/** The members a step runs (none for a summary step, which covibe writes itself). */
export const stepAgents = (step: Step): string[] => (step.kind === 'agent' ? [step.agent] : step.kind === 'parallel' ? step.branches.map((b) => b.agent) : []);

/** The run's planner: the member of the first planning step, and where that step is. */
export function plannerOf(team: TeamConfig): { agent: string; index: number } | undefined {
  const index = team.steps.findIndex((s) => s.kind === 'agent' && isPlanningStep(team, s.agent, s.id));
  const step = team.steps[index];
  return step?.kind === 'agent' ? { agent: step.agent, index } : undefined;
}

export interface Candidate {
  name: string;
  description?: string;
  /** The steps it has after the plan. */
  steps: string[];
  /** In a required step: it runs whatever the planner chooses. */
  required: boolean;
}

/** The members the planner chooses among: those with a step after the planning step, other than the planner. */
export function candidates(team: TeamConfig, planner: { agent: string; index: number }): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const step of team.steps.slice(planner.index + 1)) {
    for (const name of stepAgents(step)) {
      if (name === planner.agent) continue;
      const c = out.get(name) ?? { name, description: team.agents[name]?.description, steps: [], required: false };
      if (!c.steps.includes(step.id)) c.steps.push(step.id);
      c.required ||= !!step.required;
      out.set(name, c);
    }
  }
  return [...out.values()];
}

/** What the planner chose. Before it chooses, everyone runs. */
export class Selection {
  private chosen: Set<string> | undefined;
  reason: string | undefined;

  constructor(initial?: { members: string[]; reason?: string }) {
    if (initial) this.set(initial.members, initial.reason);
  }

  get members(): string[] | undefined {
    return this.chosen && [...this.chosen];
  }

  set(members: string[], reason?: string) {
    this.chosen = new Set(members);
    this.reason = reason;
  }

  /** Whether the planner left this member out. */
  leftOut(agent: string): boolean {
    return !!this.chosen && !this.chosen.has(agent);
  }
}

/** The members a list names (strings, or objects with a name), if it is a list. */
export function namesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined)).filter((v): v is string => typeof v === 'string' && !!v.trim());
  return names.map((n) => n.trim());
}

/**
 * The owners the feedback of a fix round names. Undefined when that cannot be
 * told: an item without an owner (or a feedback value that is not a list of
 * items) could concern anyone.
 */
export function feedbackOwners(feedback: Record<string, unknown>): Set<string> | undefined {
  const owners = new Set<string>();
  for (const value of Object.values(feedback)) {
    if (value === null || value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const owner = (item as Record<string, unknown>).owner;
      if (typeof owner !== 'string' || !owner.trim()) return undefined;
      owners.add(owner.trim());
    }
  }
  return owners.size ? owners : undefined;
}

/** For the planner: pick the members the goal needs. */
export function selectTool(list: Candidate[], onSelect: (members: string[], reason?: string) => void): CustomTool {
  const names = list.map((c) => c.name);
  return {
    name: SELECT_TOOL,
    description: `Choose which members this goal needs after your plan. The steps of members you leave out are skipped, which saves a whole session each. Members: ${list.map((c) => `${c.name}${c.description ? ` (${c.description})` : ''}`).join('; ')}. Calling it again replaces the choice for the steps that have not run yet.`,
    params: {
      members: { type: 'list', description: `The members that should work on this goal, from ${names.join(', ')}. Members you give tasks to always run.` },
      reason: { type: 'string', optional: true, description: 'One line: why the others are not needed.' },
    },
    run: (a) => {
      const given = namesOf(a.members) ?? [];
      const unknown = given.filter((n) => !names.includes(n));
      if (unknown.length) throw new Error(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not among ${names.join(', ')}`);
      const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : undefined;
      const members = [...new Set(given)];
      onSelect(members, reason);
      const skipped = list.filter((c) => !members.includes(c.name) && !c.required).map((c) => c.name);
      return skipped.length ? `Chosen: ${members.join(', ') || 'nobody'}. Skipped unless you give them a task: ${skipped.join(', ')}.` : `Chosen: ${members.join(', ')}. Everyone runs.`;
    },
  };
}

/** The planner's note on choosing members (planning turns only). */
export function selectionNote(list: Candidate[], viaReport: boolean): string | undefined {
  const optional = list.filter((c) => !c.required);
  if (!optional.length) return undefined;
  return [
    '## Who is needed',
    `Every member that runs is a session of its own: it starts cold, reads the project and costs a full session even when it has little to do. Decide which members this goal really needs and leave the others out. ${viaReport ? 'List them in your report\'s `members`' : `Call ${SELECT_TOOL} with them`} before you finish. The steps after yours and who runs them:`,
    list.map((c) => `- ${c.name}: ${c.steps.join(', ')}${c.required ? ' (always runs)' : ''}${c.description ? ` — ${c.description}` : ''}`).join('\n'),
    'Members you give a task to always run. Keep a reviewer or tester when the change can break something they would catch; leave them out for work they cannot check or do not need to (a copy edit, a config value, a docs change). When unsure about a member, keep it.',
  ].join('\n\n');
}

/** For the planner: hand over what it found, so the members do not explore the project again. */
export const HANDOFF_NOTE =
  '## Hand over what you found\nThe members who do the tasks start cold, each in a session of its own, and pay again for every file they read. Put what you learned into the tasks: the files to change, the functions, types and patterns to follow, the commands that build and test it, so they can start working instead of exploring the project again.';
