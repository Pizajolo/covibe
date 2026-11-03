import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import jsonata from 'jsonata';
import { parseDocument } from 'yaml';
import type { AppConfig } from '../apps/config.js';
import type {
  AgentConfig,
  BackendConfig,
  CacheTtl,
  Branch,
  Effort,
  GateFailPolicy,
  JsonSchema,
  Limits,
  SandboxConfig,
  SettingSource,
  Step,
  TeamConfig,
  Thinking,
} from './types.js';

const SCHEMA_URL = new URL('../../schemas/team.schema.json', import.meta.url);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
// Keys the engine puts in the run context next to the step outputs.
const RESERVED_STEP_IDS = new Set(['goal', 'loop', 'feedback', 'question']);
const DEFAULT_LIMITS: Limits = { max_turns: 40, timeout_min: 30 };

// What shell commands typically need: package registries to install from and
// package-manager caches to write. Teams override either list.
export const DEFAULT_SANDBOX_NETWORK = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
];
export const DEFAULT_SANDBOX_WRITE = ['~/.npm', '~/.cache', '~/.yarn', '~/.pnpm-store', '~/Library/Caches', '~/.cargo/registry', '~/go/pkg/mod'];

interface RawSandbox {
  enabled?: boolean;
  network?: string[];
  allow_write?: string[];
}

/** Agent fields override team defaults, which override the built-in defaults. */
function resolveSandbox(tools: string[], team: RawSandbox | undefined, agent: RawSandbox | undefined): SandboxConfig | undefined {
  if (!tools.includes('Bash')) return undefined;
  const merged = { ...team, ...agent };
  if (merged.enabled === false) return undefined;
  const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  return { network: merged.network ?? DEFAULT_SANDBOX_NETWORK, allowWrite: (merged.allow_write ?? DEFAULT_SANDBOX_WRITE).map(expand) };
}

function resolveAppConfig(a: RawApp): AppConfig {
  const { ready_timeout_s, ...rest } = a;
  return { ...rest, ...(ready_timeout_s !== undefined ? { readyTimeoutS: ready_timeout_s } : {}) };
}

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    public readonly problems: string[],
  ) {
    super(`${file}: invalid team file\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

let validator: ReturnType<Ajv2020['compile']> | undefined;
function getValidator() {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')));
  }
  return validator;
}

/**
 * Parse YAML 1.2 strictly: duplicate keys, unresolvable aliases and other
 * parser warnings are errors. JSON is valid YAML 1.2, so `.json` files work too.
 */
export function parseYaml(text: string, file: string): unknown {
  const doc = parseDocument(text, {
    version: '1.2',
    uniqueKeys: true,
    strict: true,
    prettyErrors: true,
    merge: false,
  });
  const problems = [...doc.errors, ...doc.warnings].map((e) => e.message.split('\n')[0] ?? e.message);
  if (problems.length) throw new ConfigError(file, problems);
  return doc.toJS({ maxAliasCount: 100 });
}

function formatAjvError(e: ErrorObject): string {
  const at = e.instancePath || '/';
  if (e.keyword === 'additionalProperties') {
    return `${at}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
  }
  if (e.keyword === 'enum') {
    return `${at}: must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  return `${at}: ${e.message ?? e.keyword}`;
}

/** Validate a parsed team document against the JSON Schema. Returns problems, empty if valid. */
export function validateTeamDocument(doc: unknown): string[] {
  const validate = getValidator();
  if (validate(doc)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of validate.errors ?? []) {
    // if/then on steps produces a noisy "must match then schema" wrapper; skip it.
    if (e.keyword === 'if') continue;
    const msg = formatAjvError(e);
    if (!seen.has(msg)) {
      seen.add(msg);
      out.push(msg);
    }
  }
  return out;
}

// Raw shapes as written in the file (already schema-checked when used).
interface RawBackend extends BackendConfig {}
interface RawPolicy {
  goto: string;
  max_loops: number;
  feed?: string[];
  then?: 'escalate_to_human' | 'fail';
}
interface RawAgent {
  description?: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  thinking?: Thinking;
  cache_ttl?: CacheTtl;
  tools: string[];
  can_message?: string[];
  can_request?: string[];
  scope?: { write?: string[] };
  output_schema?: string;
  backend?: RawBackend;
  limits?: Partial<Limits>;
  sandbox?: RawSandbox;
  skills?: string[];
  plugins?: string[];
  browser?: boolean;
  app?: boolean;
}
interface RawApp {
  runtime?: 'sandbox' | 'docker';
  setup?: string;
  command?: string;
  port?: number;
  path?: string;
  env?: Record<string, string>;
  ready_timeout_s?: number;
  network?: string[];
  image?: string;
  dockerfile?: string;
  compose?: string;
  service?: string;
}
interface RawBranch {
  agent: string;
  task?: string;
  output_schema?: string;
}
interface RawStep {
  id: string;
  agent?: string;
  task?: string;
  instructions?: string;
  output_schema?: string;
  parallel?: RawBranch[];
  gate?: string;
  on_gate_fail?: RawPolicy;
  required?: boolean;
  summary?: boolean;
}
interface RawTeam {
  name: string;
  description?: string;
  defaults?: {
    backend?: RawBackend;
    model?: string;
    effort?: Effort;
    thinking?: Thinking;
    cache_ttl?: CacheTtl;
    isolation?: 'worktree' | 'none';
    limits?: Partial<Limits>;
    max_parallel?: number;
    setting_sources?: SettingSource[];
    sandbox?: RawSandbox;
    skills?: string[];
    plugins?: string[];
    browser?: boolean;
    app?: boolean;
  };
  app?: RawApp;
  brain?: { curator?: string; curate?: 'after_run' | 'manual'; min_proposals?: number };
  lead?: string | null;
  agents: Record<string, RawAgent>;
  workflow: { on_gate_fail?: RawPolicy; steps: RawStep[] };
}

export interface LoadOptions {
  /**
   * The provider (a connection from Settings → Advanced) that offers this
   * model, with the model id it expects. With it, a member whose model only a
   * provider has runs on that provider instead of being sent to Claude.
   */
  providerFor?: (model: string) => { connection: string; model: string } | undefined;
}

/** Load, validate and resolve a team file into the engine's typed model. */
export function loadTeam(path: string, opts: LoadOptions = {}): TeamConfig {
  const file = resolve(path);
  if (!existsSync(file)) throw new ConfigError(file, ['file not found']);
  const doc = parseYaml(readFileSync(file, 'utf8'), file);
  const schemaProblems = validateTeamDocument(doc);
  if (schemaProblems.length) throw new ConfigError(file, schemaProblems);
  return resolveTeam(doc as RawTeam, file, opts);
}

/** Claude's own model names: aliases (opus, sonnet[1m], ...) and full ids. Never routed to a provider. */
const CLAUDE_MODEL = /^(claude-|anthropic[.:/]|(us|eu|apac|global)\.anthropic\.|(opus|sonnet|haiku|fable|opusplan|best|default)(\[|$))/i;

/** Backends that send requests to Anthropic itself, where only Claude models exist. */
const CLAUDE_BACKENDS = new Set<BackendConfig['type']>(['subscription', 'api_key']);

/**
 * The backend and model a member runs on. A member's own backend wins and
 * carries its own model. Without one it inherits the team's backend, except
 * that a model of its own is honoured: a Claude model leaves an inherited
 * provider for the Claude login, and a model only a provider offers goes to
 * that provider (Claude Code would reject it on Claude).
 */
export function memberBackend(
  own: { backend?: BackendConfig; model?: string },
  defaults: { backend: BackendConfig; model?: string },
  providerFor?: LoadOptions['providerFor'],
): { backend: BackendConfig; model?: string } {
  let backend = own.backend ?? defaults.backend;
  if (!own.backend && own.model && backend.type === 'connection' && own.model !== backend.model) {
    if (CLAUDE_MODEL.test(own.model)) backend = { type: 'subscription' };
    else {
      const provider = providerFor?.(own.model);
      if (provider) backend = { type: 'connection', ...provider };
    }
  }
  const model = backend.model ?? own.model ?? defaults.model;
  if (model && CLAUDE_BACKENDS.has(backend.type) && !CLAUDE_MODEL.test(model)) {
    const provider = providerFor?.(model);
    if (provider) return { backend: { type: 'connection', ...provider }, model: provider.model };
  }
  return { backend, model };
}

function resolveTeam(raw: RawTeam, file: string, opts: LoadOptions): TeamConfig {
  const baseDir = dirname(file);
  const problems: string[] = [];
  const schemaCache = new Map<string, JsonSchema>();

  const readSchema = (ref: string, where: string): JsonSchema | undefined => {
    const p = isAbsolute(ref) ? ref : resolve(baseDir, ref);
    const cached = schemaCache.get(p);
    if (cached) return cached;
    if (!existsSync(p)) {
      problems.push(`${where}: output schema "${ref}" not found`);
      return undefined;
    }
    try {
      const schema = parseYaml(readFileSync(p, 'utf8'), p) as JsonSchema;
      new Ajv2020({ strict: false }).compile(schema);
      schemaCache.set(p, schema);
      return schema;
    } catch (err) {
      problems.push(`${where}: output schema "${ref}" is not a valid JSON Schema (${(err as Error).message.split('\n')[0]})`);
      return undefined;
    }
  };

  const checkExpr = (expr: string, where: string) => {
    try {
      jsonata(expr);
    } catch (err) {
      problems.push(`${where}: invalid expression "${expr}" (${(err as Error).message})`);
    }
  };

  const defaults = raw.defaults ?? {};
  const defaultBackend: BackendConfig = defaults.backend ?? { type: 'subscription' };
  const defaultLimits: Limits = { ...DEFAULT_LIMITS, ...defaults.limits };

  const agents: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries(raw.agents)) {
    const where = `/agents/${name}`;
    let prompt = a.prompt;
    let promptFile: string | undefined;
    if (!a.prompt.includes('\n')) {
      promptFile = isAbsolute(a.prompt) ? a.prompt : resolve(baseDir, a.prompt);
      if (existsSync(promptFile)) prompt = readFileSync(promptFile, 'utf8');
      else problems.push(`${where}/prompt: file "${a.prompt}" not found`);
    }
    for (const target of a.can_message ?? []) {
      if (target === name) problems.push(`${where}/can_message: an agent cannot message itself`);
      else if (!(target in raw.agents)) problems.push(`${where}/can_message: unknown agent "${target}"`);
    }
    for (const target of a.can_request ?? []) {
      if (target === name) problems.push(`${where}/can_request: an agent cannot request work from itself`);
      else if (!(target in raw.agents)) problems.push(`${where}/can_request: unknown agent "${target}"`);
    }
    // An agent-level backend replaces the default one entirely; merging fields
    // across backend types (say a gateway base_url into api_key) is never wanted.
    const { backend, model } = memberBackend({ backend: a.backend, model: a.model }, { backend: defaultBackend, model: defaults.model }, opts.providerFor);
    agents[name] = {
      name,
      description: a.description,
      prompt,
      promptFile,
      model,
      effort: a.effort ?? defaults.effort,
      thinking: a.thinking ?? defaults.thinking,
      cacheTtl: a.cache_ttl ?? defaults.cache_ttl,
      tools: a.tools,
      canMessage: a.can_message ?? [],
      canRequest: a.can_request ?? [],
      writeScope: a.scope?.write,
      outputSchema: a.output_schema ? readSchema(a.output_schema, `${where}/output_schema`) : undefined,
      backend,
      limits: { ...defaultLimits, ...a.limits },
      writes: a.tools.some((t) => WRITE_TOOLS.has(t)),
      sandbox: resolveSandbox(a.tools, defaults.sandbox, a.sandbox),
      skills: [...new Set([...(defaults.skills ?? []), ...(a.skills ?? [])])],
      plugins: [...new Set([...(defaults.plugins ?? []), ...(a.plugins ?? [])])],
      browser: a.browser ?? defaults.browser ?? false,
      app: a.app ?? defaults.app ?? (a.tools.includes('Bash') || (a.browser ?? defaults.browser ?? false)),
    };
    if (a.scope?.write && !agents[name].writes) {
      problems.push(`${where}/scope: has a write scope but no tool that can write`);
    }
  }

  const stepIds = new Set<string>();
  for (const s of raw.workflow.steps) {
    if (stepIds.has(s.id)) problems.push(`/workflow/steps: duplicate step id "${s.id}"`);
    if (RESERVED_STEP_IDS.has(s.id)) problems.push(`/workflow/steps: "${s.id}" is reserved and cannot be a step id`);
    stepIds.add(s.id);
  }

  const resolvePolicy = (p: RawPolicy | undefined, where: string): GateFailPolicy | undefined => {
    if (!p) return undefined;
    if (!stepIds.has(p.goto)) problems.push(`${where}/goto: unknown step "${p.goto}"`);
    for (const f of p.feed ?? []) checkExpr(f, `${where}/feed`);
    return { goto: p.goto, maxLoops: p.max_loops, feed: p.feed ?? [], then: p.then ?? 'escalate_to_human' };
  };

  const defaultPolicy = resolvePolicy(raw.workflow.on_gate_fail, '/workflow/on_gate_fail');
  const checkAgent = (agent: string, where: string) => {
    if (!(agent in agents)) problems.push(`${where}: unknown agent "${agent}"`);
  };

  const steps: Step[] = raw.workflow.steps.map((s, i): Step => {
    const where = `/workflow/steps/${i}`;
    if (s.gate) checkExpr(s.gate, `${where}/gate`);
    if (s.task) checkExpr(s.task, `${where}/task`);
    const onGateFail = resolvePolicy(s.on_gate_fail, `${where}/on_gate_fail`) ?? (s.gate ? defaultPolicy : undefined);
    const base = { id: s.id, instructions: s.instructions, gate: s.gate, onGateFail, ...(s.required ? { required: true } : {}) };
    if (s.summary) return { id: s.id, kind: 'summary' };
    if (s.parallel) {
      const seen = new Set<string>();
      const branches = s.parallel.map((b, j): Branch => {
        const bw = `${where}/parallel/${j}`;
        checkAgent(b.agent, `${bw}/agent`);
        if (seen.has(b.agent)) problems.push(`${bw}/agent: "${b.agent}" appears twice in one parallel step`);
        seen.add(b.agent);
        if (b.task) checkExpr(b.task, `${bw}/task`);
        return {
          agent: b.agent,
          task: b.task,
          outputSchema: b.output_schema ? readSchema(b.output_schema, `${bw}/output_schema`) : agents[b.agent]?.outputSchema,
        };
      });
      return { ...base, kind: 'parallel', branches };
    }
    const agent = s.agent as string;
    checkAgent(agent, `${where}/agent`);
    return {
      ...base,
      kind: 'agent',
      agent,
      task: s.task,
      outputSchema: s.output_schema ? readSchema(s.output_schema, `${where}/output_schema`) : agents[agent]?.outputSchema,
    };
  });

  // A loop may only jump backwards (or to itself); a forward goto would skip work.
  steps.forEach((s, i) => {
    if (s.onGateFail) {
      const target = steps.findIndex((t) => t.id === s.onGateFail!.goto);
      if (target > i) problems.push(`/workflow/steps/${i}/on_gate_fail/goto: must point at this or an earlier step`);
    }
  });

  const curator = raw.brain?.curator;
  if (curator) {
    const c = agents[curator];
    if (!c) problems.push(`/brain/curator: unknown agent "${curator}"`);
    else if (!c.tools.some((t) => t === 'Write' || t === 'Edit')) problems.push(`/brain/curator: ${curator} needs the Write or Edit tool to maintain the notes`);
  }

  // Questions go to the lead first; a member named "manager" leads unless the file says otherwise (null = nobody).
  const lead = raw.lead === null ? undefined : raw.lead ?? ('manager' in agents ? 'manager' : undefined);
  if (lead && !agents[lead]) problems.push(`/lead: unknown agent "${lead}"`);

  if (raw.app?.runtime !== 'docker' && (raw.app?.image || raw.app?.dockerfile || raw.app?.compose)) problems.push('/app: image, dockerfile and compose need runtime: docker');
  if (raw.app?.compose && !raw.app.service) problems.push('/app/service: say which service of the compose file serves the app');

  if (problems.length) throw new ConfigError(file, problems);
  return {
    ...(raw.app ? { app: resolveAppConfig(raw.app) } : {}),
    brain: { curator, curate: raw.brain?.curate ?? 'after_run', minProposals: raw.brain?.min_proposals ?? 1 },
    lead,
    name: raw.name,
    description: raw.description,
    file,
    isolation: defaults.isolation ?? 'worktree',
    maxParallel: defaults.max_parallel ?? 2,
    settingSources: defaults.setting_sources ?? ['project'],
    agents,
    steps,
  };
}
