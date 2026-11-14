// The storefront assistant: a chat that sets up a team's page on the market
// with the owner. It reads the team (so the page says what the team really
// does) and writes storefront.yaml only through save_storefront, which writes
// nothing unless the file is valid for this team. Publishing stays with the owner.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, Effort, TeamConfig } from '../config/types.js';
import { eventSink, finishedData, newRunId } from '../engine/engine.js';
import type { EventStore } from '../events/store.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner, CustomTool } from '../runner/types.js';
import { MAX_EXAMPLE_BYTES, MEDIA, MEDIA_DIR, mediaTypeOf } from './media.js';
import { STOREFRONT_FILE, storefrontProblems, storefrontTemplate } from './storefront.js';

export const SHOPKEEPER = 'shopkeeper';

const GUIDE = `You are the storefront assistant in covibe, a desktop app where a team of AI agents does work in a folder. The owner of a team can sell its work on the covibe market: a customer orders on a public web page, pays into an escrow on NEAR, the team runs on the order, and the owner is paid only when the team's own checks (gates) passed. You help the owner set up the team's page, its storefront, by talking with them, and you write it with the save_storefront tool.

# What a storefront is
One file, storefront.yaml, next to the team's team.yaml. Customers see the title, summary, description, examples and the order form. They never see the team file or its prompts.

storefront:
  title: Reel cutter                      # up to 100 characters
  summary: "One sentence a customer reads on the card."   # up to 500
  description: |                          # what they get, what to send, how long it takes; plain paragraphs, no Markdown
    ...
  price_near: 5                           # NEAR per order, paid into escrow
  windows: { accept_min: 60, delivery_min: 240, review_min: 1440 }
      # minutes: how long the owner has to answer an order, how long the team has to deliver after accepting,
      # and how long the customer has to confirm or dispute. A missed window refunds the customer.
  intake:
    mode: recommend                       # manual: the owner answers every order. recommend: an intake agent suggests, the owner confirms.
                                          # auto: the agent accepts good fits and declines bad ones alone.
    budget_cap_usd: 3                     # the team's run on one order stops when it has spent this much
    estimated_cost_usd: 1.5               # what an order usually costs to run (must not be above the cap)
    min_price_near: 4                     # orders locked below this are not taken (must not be above price_near)
    max_input_mb: 500                     # all files of one order together; files travel encrypted in pieces, so video is fine (up to 20480)
    policy: |                             # what the team takes and what it does not; the intake agent judges orders by it
      ...
  inputs:                                 # the order form, 1 to 20 fields
    - { name: footage, label: Your clips, type: files, accept: [".mp4", ".mov"], max_files: 5, folder: raw, required: true, help: "Up to five clips." }
    - { name: brief, label: What is it for?, type: text, required: true, max_chars: 2000, help: "..." }
      # name: lower case letters, digits, underscores. type text: max_chars. type files: accept (extensions with the dot;
      # leave out for any file), max_files (default 5), folder (where the files land in the team's working folder; default: the field's name).
  examples:                               # shown on the page, up to 12
    - { title: Product teaser, text: "What it was and what came out." }
    - { title: Before and after, file: storefront/teaser.mp4 }   # a picture, video, sound or PDF from the team folder
  goal: |                                 # what the team is told for every order; the customer's order follows it as data
    Cut the customer's footage in raw/ into one vertical reel at out/reel.mp4, following their brief in ORDER.md.
  deliverables:
    folder: out                           # only this folder of the working folder is delivered to the customer
    gates_required: [render_ok, review]   # ids of the team's steps whose gates must pass before anything is delivered
  revisions:
    included: 1                           # revisions per order the team does automatically when the customer asks (0 to 5).
                                          # A request beyond them waits for the owner's yes or no. Each revision is another run the owner pays for.

# How an order runs, so the page and the goal fit
The order becomes a working folder: ORDER.md holds what the customer wrote, each files field is in its folder, and the deliverables folder is empty. The team runs its workflow there with the goal above. If every required gate passed, each file in the deliverables folder is delivered to the customer (they can watch a video or look at an image on the order page and download everything); if not, the customer is refunded. So:
- The goal must name the input folders and say exactly which file or files to write into the deliverables folder.
- gates_required may only name steps of this team that have a gate. A team with no gate cannot sell: say so and suggest adding a review step in the team editor.
- Promise on the page only what the team's members and tools can do. Read the team's prompts when unsure.
- If the team's members have write scopes, the deliverables folder and input folders must fit them (a member that may only write final/** needs deliverables.folder: final).

# Examples with pictures and video
You cannot create media. The owner adds pictures, videos and files in the editor ("Showcase"); they land in ${MEDIA_DIR}/ in the team folder and get_storefront lists them. When there are files no example uses yet, offer to write a title and a line of text for each. Types the page can show: ${Object.keys(MEDIA).join(' ')}; up to ${MAX_EXAMPLE_BYTES >> 20} MB each.

# How to work
- Call get_storefront first, every time: the owner also edits the storefront by hand in the form next to this chat.
- If something important is unclear, ask at most two or three short questions (what customers send, what they get back, the price). Otherwise propose a sensible storefront, save it, and say what you assumed.
- Write for customers: concrete, plain, no hype. The summary is one sentence. The description says what they get, what to send, how long it takes, and that they are refunded if the checks do not pass.
- Suggest a price that leaves room above what a run costs, and keep min_price_near at or below it.
- Save with save_storefront (the complete file). If it returns problems, fix them and save again. Never say it is saved unless the tool said so.
- You do not publish. After saving, say in two or three sentences what the page now offers and what is still open (for example: examples to add in Showcase, the price to confirm), and that the owner publishes with the Publish button.`;

export interface AssistStart {
  store: EventStore;
  runner: AgentRunner;
  teamId: string;
  teamDir: string;
  /** The team as it loads now (undefined when its file has problems). */
  team(): TeamConfig | undefined;
  /** Write storefront.yaml (it was checked). */
  write(yaml: string): void;
  model?: string;
  effort?: Effort;
  env?: Env;
}

/** Start the conversation about a team's storefront (or continue it) and send a message. Returns at once; the reply streams as events. */
export async function assist(opts: AssistStart & { runId?: string; message: string }): Promise<{ runId: string; done: Promise<void> }> {
  const { store, teamId, teamDir } = opts;
  let run = opts.runId ? store.getRun(opts.runId) : undefined;
  if (opts.runId && !run) throw new Error(`storefront conversation ${opts.runId} not found`);
  if (!run) {
    run = store.createRun({ id: newRunId(), kind: 'storefront', team: teamId, teamFile: join(teamDir, 'team.yaml'), repo: teamDir, goal: opts.message });
    store.append(run.id, { type: 'run.started', data: { team: teamId, goal: opts.message, kind: 'storefront', agent: SHOPKEEPER, steps: [] } });
  } else store.reopenRun(run.id);
  const runId = run.id;
  store.append(runId, { type: 'chat.message', agent: SHOPKEEPER, step: 'chat', data: { from: 'human', to: SHOPKEEPER, text: opts.message } });

  const agent: AgentConfig = {
    name: SHOPKEEPER,
    prompt: GUIDE,
    model: opts.model ?? 'sonnet',
    effort: opts.effort,
    tools: ['Read', 'Grep', 'Glob'],
    canMessage: [],
    canRequest: [],
    writeScope: [],
    backend: { type: 'subscription' },
    limits: { max_turns: 30, timeout_min: 15 },
    writes: false,
    skills: [],
    plugins: [],
    browser: false,
    app: false,
  };
  const session = store.getSession(runId, SHOPKEEPER);
  const base = { step: 'chat', agent: SHOPKEEPER };
  const { env } = backendEnv(agent.backend, opts.env ?? process.env);
  const prompt = session ? opts.message : `${opts.message}\n\n(The storefront you are working on belongs to the team "${teamId}" in ${teamDir}, your working folder. You may read the team's files there.)`;

  store.append(runId, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: 'subscription', cwd: teamDir, resumed: !!session, chat: true } });
  const done = opts.runner
    .run({
      agentName: SHOPKEEPER,
      prompt,
      systemPrompt: GUIDE,
      cwd: teamDir,
      resumeSessionId: session?.sessionId,
      model: agent.model,
      effort: agent.effort,
      tools: agent.tools,
      env,
      maxTurns: agent.limits.max_turns,
      settingSources: [],
      signal: AbortSignal.timeout(agent.limits.timeout_min * 60_000),
      canMessage: [],
      readDirs: [teamDir],
      customTools: assistantTools(opts, runId),
      checkToolUse: () => undefined,
      sendMessage: () => 'Messaging is not available here.',
      onEvent: eventSink(store, runId, base),
    })
    .then((result) => {
      if (result.sessionId) store.saveSession(runId, SHOPKEEPER, result.sessionId, teamDir);
      store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result) });
    })
    .catch((err) => {
      store.append(runId, { ...base, type: 'agent.error', data: { ok: false, error: (err as Error).message } });
    })
    .finally(() => store.finishRun(runId, 'succeeded'));
  return { runId, done };
}

/** The media files in the team's storefront folder, as storefront.yaml would name them. */
export function mediaFiles(teamDir: string): { file: string; size: number; type: string }[] {
  const dir = join(teamDir, MEDIA_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => !name.startsWith('.') && mediaTypeOf(name) && statSync(join(dir, name)).isFile())
    .map((name) => ({ file: `${MEDIA_DIR}/${name}`, size: statSync(join(dir, name)).size, type: mediaTypeOf(name)! }));
}

/** The team in a few lines: who is on it, its steps, and which of them have gates. */
function teamNote(team: TeamConfig | undefined): string {
  if (!team) return 'The team file has problems and could not be loaded; the owner fixes it in the team editor first.';
  const members = Object.values(team.agents).map((a) => `- ${a.name}${a.model ? ` (${a.model})` : ''}: tools ${a.tools.join(', ') || 'none'}${a.writeScope?.length ? `; may write ${a.writeScope.join(', ')}` : ''}`);
  const steps = team.steps.map((s) => `- ${s.id}${s.gate ? ` (gate: ${s.gate})` : ''}`);
  const gated = team.steps.filter((s) => s.gate).map((s) => s.id);
  return `Team "${team.name}"${team.description ? `: ${team.description}` : ''}\nMembers:\n${members.join('\n')}\nSteps:\n${steps.join('\n')}\nSteps with gates (what gates_required may name): ${gated.join(', ') || 'none'}`;
}

function assistantTools(opts: AssistStart, runId: string): CustomTool[] {
  const { store, teamDir } = opts;
  const file = join(teamDir, STOREFRONT_FILE);
  return [
    {
      name: 'get_storefront',
      description: "Read the team's storefront.yaml as it is now, its problems, the team it sells (members, steps, gates) and the example media the owner added.",
      params: {},
      run: () => {
        const team = opts.team();
        const exists = existsSync(file);
        const yaml = exists ? readFileSync(file, 'utf8') : team ? storefrontTemplate(team) : '';
        const problems = exists ? storefrontProblems(yaml, team) : [];
        const media = mediaFiles(teamDir);
        return [
          exists ? `storefront.yaml:\n${yaml}` : `There is no storefront.yaml yet. A file to start from:\n${yaml}`,
          `Problems: ${problems.length ? problems.join('; ') : 'none'}`,
          teamNote(team),
          `Example media in ${MEDIA_DIR}/: ${media.length ? media.map((m) => `${m.file} (${m.type}, ${(m.size / (1 << 20)).toFixed(1)} MB)`).join(', ') : 'none yet (the owner adds them under Showcase)'}`,
        ].join('\n\n');
      },
    },
    {
      name: 'save_storefront',
      description: 'Save the storefront: the complete storefront.yaml. It is only written when it is valid for this team; otherwise you get the problems to fix.',
      params: {
        yaml: { type: 'string', description: 'The complete storefront.yaml' },
        summary: { type: 'string', description: 'One line describing what you changed, for the owner' },
      },
      run: (a) => {
        const yaml = String(a.yaml);
        const team = opts.team();
        const problems = team ? storefrontProblems(yaml, team) : ['the team file has problems, so the storefront cannot be checked against it'];
        store.append(runId, { type: 'storefront.saved', agent: SHOPKEEPER, step: 'chat', data: { valid: !problems.length, problems, summary: a.summary ?? null } });
        if (problems.length) return `Not saved. storefront.yaml has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix them and call save_storefront again.`;
        opts.write(yaml);
        return 'Saved. The storefront is valid. The owner publishes it with the Publish button.';
      },
    },
  ];
}
