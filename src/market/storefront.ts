// A team's storefront: `storefront.yaml` next to its team.yaml. It says what
// the listing shows, what an order must contain, when the intake accepts, and
// which of the team's gates must pass before a delivery goes out.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ConfigError, parseYaml } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';
import { sha256Hex } from './crypto.js';
import { MAX_EXAMPLE_BYTES, MEDIA, mediaPath, mediaTypeOf } from './media.js';
import { nearToYocto } from './near.js';
import type { Relay } from './relay.js';
import type { ListingInput, ListingMeta, Storefront } from './types.js';

export const STOREFRONT_FILE = 'storefront.yaml';
const SCHEMA_URL = new URL('../../schemas/storefront.schema.json', import.meta.url);

export const DEFAULT_PRIVACY =
  'Your order is encrypted in your browser and only the team owner can open it. To do the work, the owner and the AI model provider the owner uses will see what you send. Do not include secrets or personal data you would not give a freelancer.';

let validator: ReturnType<Ajv2020['compile']> | undefined;

interface Raw {
  storefront: Partial<Omit<Storefront, 'windows' | 'intake' | 'deliverables' | 'revisions'>> & {
    title: string;
    price_near: number;
    windows?: Partial<Storefront['windows']>;
    intake?: Partial<Storefront['intake']>;
    revisions?: Partial<Storefront['revisions']>;
    deliverables: { folder: string; gates_required?: string[] };
  };
}

/** Problems in a storefront file, in words (empty when it is fine). With a team, its gates are checked too. */
export function storefrontProblems(text: string, team?: TeamConfig): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(text, STOREFRONT_FILE);
  } catch (err) {
    return err instanceof ConfigError ? err.problems : [(err as Error).message];
  }
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')));
  if (!validator(doc)) return (validator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`);
  const sf = resolveStorefront(doc as Raw);
  const problems: string[] = [];
  const names = sf.inputs.map((i) => i.name);
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) problems.push(`input "${n}" is defined twice`);
  for (const i of sf.inputs) if (i.type === 'text' && (i.accept || i.max_files || i.folder)) problems.push(`input "${i.name}" is text, so accept, max_files and folder do not apply`);
  if (sf.intake.min_price_near > sf.price_near) problems.push(`intake.min_price_near (${sf.intake.min_price_near}) is above the price (${sf.price_near}), so every order would be turned down`);
  if (sf.intake.estimated_cost_usd !== undefined && sf.intake.estimated_cost_usd > sf.intake.budget_cap_usd) problems.push('intake.estimated_cost_usd is above intake.budget_cap_usd, so every order would be turned down');
  if (team) {
    const gated = team.steps.filter((s) => s.gate).map((s) => s.id);
    for (const g of sf.deliverables.gates_required) if (!gated.includes(g)) problems.push(`deliverables.gates_required names "${g}", but the team has no step with that id and a gate (steps with gates: ${gated.join(', ') || 'none'})`);
    if (!sf.deliverables.gates_required.length && !gated.length) problems.push('the team has no gate, so nothing decides whether an order passed; add a step with a gate to the team');
  }
  return problems;
}

function resolveStorefront(doc: Raw): Storefront {
  const s = doc.storefront;
  return {
    title: s.title,
    summary: s.summary ?? '',
    description: s.description ?? '',
    price_near: s.price_near,
    windows: { accept_min: s.windows?.accept_min ?? 60, delivery_min: s.windows?.delivery_min ?? 240, review_min: s.windows?.review_min ?? 1440 },
    intake: {
      mode: s.intake?.mode ?? 'recommend',
      budget_cap_usd: s.intake?.budget_cap_usd ?? 5,
      ...(s.intake?.estimated_cost_usd !== undefined ? { estimated_cost_usd: s.intake.estimated_cost_usd } : {}),
      min_price_near: s.intake?.min_price_near ?? 0,
      auto_min_fit: s.intake?.auto_min_fit ?? 0.8,
      max_input_mb: s.intake?.max_input_mb ?? 32,
      policy: s.intake?.policy ?? '',
    },
    inputs: s.inputs ?? [],
    examples: s.examples ?? [],
    goal: s.goal ?? 'Fulfil the customer order below.',
    deliverables: { folder: s.deliverables.folder.replace(/\/+$/, ''), gates_required: s.deliverables.gates_required ?? [] },
    workspace: s.workspace ?? 'folder',
    network: s.network ?? [],
    revisions: { included: s.revisions?.included ?? 0 },
    privacy: s.privacy ?? DEFAULT_PRIVACY,
  };
}

/** The gates an order must pass: the ones the storefront names, else every gate of the team. */
export function requiredGates(sf: Storefront, team: TeamConfig): string[] {
  return sf.deliverables.gates_required.length ? sf.deliverables.gates_required : team.steps.filter((s) => s.gate).map((s) => s.id);
}

/** Read and check a team's storefront. Throws ConfigError with what is wrong. */
export function loadStorefront(teamDir: string, team?: TeamConfig): Storefront {
  const file = join(teamDir, STOREFRONT_FILE);
  if (!existsSync(file)) throw new ConfigError(file, [`this team has no ${STOREFRONT_FILE} yet`]);
  const text = readFileSync(file, 'utf8');
  const problems = storefrontProblems(text, team);
  if (problems.length) throw new ConfigError(file, problems);
  return resolveStorefront(parseYaml(text, file) as Raw);
}

/** The listing's public page. Example files are uploaded to the relay as media. */
export async function buildMeta(sf: Storefront, teamDir: string, relay: Pick<Relay, 'putMedia'>): Promise<ListingMeta> {
  const examples: ListingMeta['examples'] = [];
  for (const e of sf.examples) {
    if (!e.file) {
      examples.push({ title: e.title, ...(e.text ? { text: e.text } : {}) });
      continue;
    }
    const type = mediaTypeOf(e.file);
    if (!type) throw new ConfigError(join(teamDir, STOREFRONT_FILE), [`example file "${e.file}" is of a type the storefront cannot show (${Object.keys(MEDIA).join(' ')})`]);
    let path: string;
    try {
      path = mediaPath(teamDir, e.file);
    } catch {
      throw new ConfigError(join(teamDir, STOREFRONT_FILE), [`example file "${e.file}" is not in the team folder`]);
    }
    if (!existsSync(path)) throw new ConfigError(join(teamDir, STOREFRONT_FILE), [`example file "${e.file}" is not in the team folder`]);
    if (statSync(path).size > MAX_EXAMPLE_BYTES) throw new ConfigError(join(teamDir, STOREFRONT_FILE), [`example file "${e.file}" is larger than ${MAX_EXAMPLE_BYTES >> 20} MB; show a shorter clip`]);
    examples.push({ title: e.title, ...(e.text ? { text: e.text } : {}), media: await relay.putMedia(readFileSync(path), type), media_type: type });
  }
  return { v: 1, title: sf.title, summary: sf.summary, description: sf.description, inputs: sf.inputs, examples, privacy: sf.privacy, max_input_mb: sf.intake.max_input_mb, intake_mode: sf.intake.mode };
}

/** The meta page as the bytes that are hashed and uploaded. */
export function metaJson(meta: ListingMeta): { json: string; hash: string } {
  const json = JSON.stringify(meta);
  return { json, hash: sha256Hex(json) };
}

export function listingInput(sf: Storefront, metaHash: string, intakePubkey: string): ListingInput {
  const seconds = (min: number) => Math.max(30, Math.round(min * 60));
  return {
    title: sf.title,
    summary: sf.summary,
    meta_hash: metaHash,
    price: nearToYocto(sf.price_near),
    accept_window_s: seconds(sf.windows.accept_min),
    delivery_window_s: seconds(sf.windows.delivery_min),
    review_window_s: seconds(sf.windows.review_min),
    intake_pubkey: intakePubkey,
    revisions: sf.revisions.included,
  };
}

/** A storefront to start from, for a team that has none. */
export function storefrontTemplate(team: TeamConfig): string {
  const gates = team.steps.filter((s) => s.gate).map((s) => s.id);
  return `# This team's page on the covibe market. Customers see the title, summary,
# description, examples and the order form; never the team file or its prompts.
storefront:
  title: ${JSON.stringify(team.name)}
  summary: ${JSON.stringify(team.description ?? 'What this team makes, in one sentence.')}
  description: |
    What a customer gets, what they need to send, and how long it takes.
  price_near: 1
  windows: { accept_min: 60, delivery_min: 240, review_min: 1440 }
  intake:
    mode: recommend            # manual | recommend | auto
    budget_cap_usd: 3          # the run stops when it has spent this much
    estimated_cost_usd: 1
    min_price_near: 1
    policy: |
      What this team takes on and what it does not.
  inputs:
    - { name: brief, label: "What do you need?", type: text, required: true }
  goal: |
    Fulfil the customer order below and put the result in out/.
  deliverables:
    folder: out
    gates_required: [${gates.join(', ')}]
  revisions:
    included: 1                # revisions per order the team does without asking you; more need your OK
`;
}
