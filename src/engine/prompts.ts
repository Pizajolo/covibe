import type { AgentConfig, TeamConfig } from '../config/types.js';
import type { InboxMessage } from '../events/types.js';

/** Role prompt plus the team protocol, appended to Claude Code's system prompt. */
export function systemPrompt(team: TeamConfig, agent: AgentConfig, opts: { canAsk?: boolean; canRequest?: boolean } = {}): string {
  const teammates = Object.values(team.agents)
    .filter((a) => a.name !== agent.name)
    .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ''}`)
    .join('\n');
  const scope =
    agent.writeScope === undefined
      ? agent.writes
        ? 'You may change any file in your workspace.'
        : 'You cannot change files.'
      : agent.writeScope.length
        ? `You may only change files matching: ${agent.writeScope.join(', ')}. Writes elsewhere are blocked, and changes made by other means outside that scope are discarded.`
        : 'You cannot change files.';
  const lines = [
    `# Team protocol`,
    `You are "${agent.name}" on the team "${team.name}". Your teammates:`,
    teammates || '- (none)',
    '',
    `A workflow engine, not a person or another agent, decides which step runs next, checks results against gates and loops failed work back. Do the step you are given, then finish with your report. Do not wait for teammates; they run in their own turns.`,
    scope,
  ];
  if (agent.canMessage.length) {
    lines.push(
      `You can message ${agent.canMessage.join(', ')} with the send_message tool. A teammate who is working reads it between its tool calls; otherwise at the start of its next turn.`,
    );
  }
  if (opts.canRequest && agent.canRequest.length) {
    lines.push(
      `You can ask ${agent.canRequest.join(', ')} to do work for you with the request_work tool: they do it in a turn of their own, their changes are merged so you can use them, and their reply is the tool's answer. You wait until they finish. Use it when their part would make yours better (say, a design to build from); you do not have to, and you can do your work without it.`,
    );
  }
  const askers = Object.values(team.agents)
    .filter((a) => a.canRequest.includes(agent.name))
    .map((a) => a.name);
  if (askers.length) {
    lines.push(
      `${askers.join(', ')} can ask you to do work for them. A request comes as a turn of its own, between workflow steps or while you have none: do what is asked and reply with what you did.`,
    );
  }
  if (opts.canAsk) {
    const lead = team.lead && team.lead !== agent.name ? team.lead : undefined;
    lines.push(
      lead
        ? `When you need a decision you cannot make from the goal, your task, the code or the project brain, ask ${lead} (the team lead) with the ask_question tool instead of guessing. If ${lead} cannot answer, it asks the human. You wait for the answer, which the tool returns. Look things up yourself before asking. When it is a choice between a few answers, pass them as options.`
        : 'When you need a decision only the human can make, ask with the ask_question tool instead of guessing. The whole team pauses until they answer, which the tool returns, so look things up and decide what you can yourself first. When it is a choice between a few answers, pass them as options.',
    );
  }
  lines.push(
    'Messages from the human or a teammate can arrive while you work, marked as such. Take them into account; a message from the human may change your task.',
  );
  if (agent.writes) lines.push('covibe commits and merges your changes after your turn; do not run git commit, branch, merge or stash yourself.');
  if (agent.sandbox) {
    lines.push(
      `Shell commands run in a sandbox: they can write only in your working folder, temp folders and package caches, and reach only these domains: ${agent.sandbox.network.join(', ') || 'none'}. If a command fails because of the sandbox, report what you needed instead of working around it.`,
    );
  }
  if (agent.browser) {
    lines.push(
      'You have a browser (the browser_* tools). Open your dev server or the pages you build (a path in your working folder works) to check they work and look right: read pages with browser_snapshot, act by element number, and take a screenshot when the look matters. People can watch it live and may take control for a moment; your browser tools wait until they hand it back.' +
        (agent.sandbox ? ' It reaches the same domains as your shell commands, plus local addresses.' : ''),
    );
  }
  lines.push('', '# Your role', agent.prompt.trim());
  return lines.join('\n');
}

export interface TurnInput {
  goal: string;
  stepId: string;
  loop: number;
  maxLoops?: number;
  instructions?: string;
  task?: unknown;
  feedback?: Record<string, unknown>;
  messages: InboxMessage[];
  structured: boolean;
}

/** The user turn for one agent invocation. */
export function turnPrompt(t: TurnInput): string {
  const parts = [`# Goal\n${t.goal}`];
  const loopNote = t.loop > 0 ? ` (fix round ${t.loop}${t.maxLoops !== undefined ? ` of at most ${t.maxLoops}` : ''})` : '';
  parts.push(`# Step: ${t.stepId}${loopNote}`);
  if (t.instructions) parts.push(t.instructions.trim());
  if (t.task !== undefined) parts.push(`## Your task\n${fence(t.task)}`);
  if (t.loop > 0 && t.feedback && Object.keys(t.feedback).length) {
    parts.push(
      `## Feedback from the previous round\nThe last round did not pass its gates. Fix the items that concern your work; items with an "owner" field name who should fix them.\n${fence(t.feedback)}`,
    );
  }
  if (t.messages.length) {
    parts.push(`## Messages\n${t.messages.map((m) => `- from ${m.from}: ${m.text}`).join('\n')}`);
  }
  if (t.structured) parts.push('When you are done, return your report as the structured output requested.');
  return parts.join('\n\n');
}

function fence(value: unknown): string {
  return typeof value === 'string' ? value : '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}
