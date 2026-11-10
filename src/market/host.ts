// How the market runs teams. The engine needs an event store, a runner and
// the user's connections; the app's server has its own (with projects and a
// live feed), the CLI opens them per folder. Both stand behind RunHost.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTeam } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';
import type { Connections } from '../connections/store.js';
import { startRun } from '../engine/engine.js';
import { EventStore } from '../events/store.js';
import type { RunEvent } from '../events/types.js';
import type { AgentRunner } from '../runner/types.js';
import { runIntake } from './intake.js';
import type { IntakeDecision } from './types.js';

export interface HostRun {
  team: TeamConfig;
  /** The order's workspace. */
  repo: string;
  goal: string;
  budgetUsd?: number;
  signal?: AbortSignal;
  /** Called once the run exists (its id, and the app's project for it if there is one). */
  onStart?(runId: string, projectId?: string): void;
  onEvent?(event: RunEvent): void;
}

export interface RunResult {
  runId: string;
  projectId?: string;
  status: 'succeeded' | 'failed' | 'escalated';
  reason?: string;
  costUsd: number;
  budgetExceeded: boolean;
  /** Result branch of a worktree run. */
  branch?: string;
  events: RunEvent[];
}

export interface IntakeResult {
  runId: string;
  projectId?: string;
  decision?: IntakeDecision;
  error?: string;
  costUsd: number;
}

export interface RunHost {
  loadTeam(file: string): TeamConfig;
  run(opts: HostRun): Promise<RunResult>;
  intake(opts: { team: TeamConfig; repo: string; prompt: string; orderId: number; signal?: AbortSignal }): Promise<IntakeResult>;
}

/** Run a team on a folder with a given store, and gather what the market needs from it. */
export async function runOnStore(store: EventStore, runner: AgentRunner, connections: Connections | undefined, o: HostRun, projectId?: string, track?: (runId: string, done: Promise<unknown>) => void): Promise<RunResult> {
  const { runId, done } = await startRun({ team: o.team, repo: o.repo, goal: o.goal, store, runner, connections, signal: o.signal, budgetUsd: o.budgetUsd, onLimit: 'stop' });
  track?.(runId, done);
  o.onStart?.(runId, projectId);
  const unsubscribe = store.subscribe((e) => {
    if (e.runId === runId) o.onEvent?.(e);
  });
  try {
    const outcome = await done;
    return { runId, projectId, status: outcome.status, reason: outcome.reason, costUsd: outcome.costUsd, budgetExceeded: !!outcome.budgetExceeded, branch: outcome.branch, events: store.events(runId) };
  } finally {
    unsubscribe();
  }
}

/** The CLI's host: each order folder keeps its own event store, like any folder covibe runs in. */
export class LocalHost implements RunHost {
  constructor(
    private readonly runner: AgentRunner,
    private readonly connections?: Connections,
  ) {}

  loadTeam(file: string): TeamConfig {
    return loadTeam(file, this.connections ? { providerFor: (model) => this.connections!.providerFor(model) } : {});
  }

  private open(repo: string): EventStore {
    const dir = join(repo, '.covibe');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
    return new EventStore(join(dir, 'covibe.db'));
  }

  async run(o: HostRun): Promise<RunResult> {
    const store = this.open(o.repo);
    try {
      return await runOnStore(store, this.runner, this.connections, o);
    } finally {
      store.close();
    }
  }

  async intake(o: { team: TeamConfig; repo: string; prompt: string; orderId: number; signal?: AbortSignal }): Promise<IntakeResult> {
    const store = this.open(o.repo);
    try {
      return await runIntake({ store, runner: this.runner, connections: this.connections, ...o });
    } finally {
      store.close();
    }
  }
}
