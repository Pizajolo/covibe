import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { ConfigError, loadTeam } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';

/**
 * The desktop app's library: the projects (git repositories) you work on and
 * the teams you have defined. Teams are reusable across projects; each lives
 * in its own folder with its team.yaml, prompts and schemas.
 *
 *   ~/.covibe/config.json
 *   ~/.covibe/teams/<team-id>/team.yaml
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

interface LibraryConfig {
  projects: Project[];
}

export interface TeamFileInfo {
  path: string;
  size: number;
}

export interface TeamListing {
  id: string;
  name: string;
  description?: string;
  dir: string;
  valid: boolean;
  problems: string[];
  agents: string[];
  steps: string[];
}

export type EditOp = { op: 'set'; path: (string | number)[]; value: unknown } | { op: 'delete'; path: (string | number)[] };

const TEMPLATES_DIR = new URL('../../examples/', import.meta.url).pathname;
const TEAM_FILE = 'team.yaml';

export class Library {
  readonly teamsDir: string;
  private readonly configFile: string;

  constructor(readonly home = process.env.COVIBE_HOME ?? join(homedir(), '.covibe')) {
    this.teamsDir = join(home, 'teams');
    this.configFile = join(home, 'config.json');
    mkdirSync(this.teamsDir, { recursive: true });
  }

  private read(): LibraryConfig {
    if (!existsSync(this.configFile)) return { projects: [] };
    try {
      return { projects: [], ...JSON.parse(readFileSync(this.configFile, 'utf8')) };
    } catch {
      return { projects: [] };
    }
  }

  private write(config: LibraryConfig) {
    writeFileSync(this.configFile, JSON.stringify(config, null, 2) + '\n');
  }

  // ---- projects

  projects(): Project[] {
    return this.read().projects;
  }

  project(id: string): Project {
    const p = this.projects().find((x) => x.id === id);
    if (!p) throw new NotFound(`project ${id} not found`);
    return p;
  }

  addProject(path: string): Project {
    const dir = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BadRequest(`${dir} is not a folder`);
    let top: string;
    try {
      top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new BadRequest(`${dir} is not a git repository. Run "git init" and make a first commit, then add it again.`);
    }
    const config = this.read();
    const existing = config.projects.find((p) => p.path === top);
    if (existing) return existing;
    const project: Project = { id: slug(basename(top)) + '-' + randomBytes(2).toString('hex'), name: basename(top), path: top, addedAt: new Date().toISOString() };
    config.projects.push(project);
    this.write(config);
    return project;
  }

  removeProject(id: string) {
    const config = this.read();
    config.projects = config.projects.filter((p) => p.id !== id);
    this.write(config);
  }

  // ---- teams

  templates(): { id: string; name: string; description?: string }[] {
    if (!existsSync(TEMPLATES_DIR)) return [];
    return readdirSync(TEMPLATES_DIR)
      .filter((d) => existsSync(join(TEMPLATES_DIR, d, TEAM_FILE)))
      .map((d) => {
        const doc = parseDocument(readFileSync(join(TEMPLATES_DIR, d, TEAM_FILE), 'utf8')).toJS() as { name?: string; description?: string };
        return { id: d, name: doc?.name ?? d, description: doc?.description };
      });
  }

  teamDir(id: string): string {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new BadRequest(`bad team id "${id}"`);
    const dir = join(this.teamsDir, id);
    if (!existsSync(join(dir, TEAM_FILE))) throw new NotFound(`team ${id} not found`);
    return dir;
  }

  teamFile(id: string): string {
    return join(this.teamDir(id), TEAM_FILE);
  }

  teams(): TeamListing[] {
    return readdirSync(this.teamsDir)
      .filter((d) => existsSync(join(this.teamsDir, d, TEAM_FILE)))
      .sort()
      .map((id) => this.listing(id));
  }

  listing(id: string): TeamListing {
    const dir = this.teamDir(id);
    const { problems } = this.check(id);
    const raw = rawDoc(readFileSync(join(dir, TEAM_FILE), 'utf8'));
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      dir,
      valid: problems.length === 0,
      problems,
      agents: isRecord(raw.agents) ? Object.keys(raw.agents) : [],
      steps: Array.isArray((raw.workflow as { steps?: unknown[] })?.steps)
        ? ((raw.workflow as { steps: { id?: string }[] }).steps.map((s) => s?.id ?? '?'))
        : [],
    };
  }

  /** Load a team for running. Throws ConfigError when invalid. */
  load(id: string): TeamConfig {
    return loadTeam(this.teamFile(id));
  }

  /** Load a team file outside the library (runs started from the CLI). */
  loadFile(file: string): TeamConfig {
    return loadTeam(file);
  }

  check(id: string): { problems: string[] } {
    try {
      loadTeam(this.teamFile(id));
      return { problems: [] };
    } catch (err) {
      if (err instanceof ConfigError) return { problems: err.problems };
      return { problems: [(err as Error).message] };
    }
  }

  /** Validate YAML text as if it were this team's file (live editor feedback). */
  validateText(id: string, yaml: string): string[] {
    const dir = this.teamDir(id);
    const probe = join(dir, `.validate-${randomBytes(3).toString('hex')}.yaml`);
    writeFileSync(probe, yaml);
    try {
      loadTeam(probe);
      return [];
    } catch (err) {
      return err instanceof ConfigError ? err.problems : [(err as Error).message];
    } finally {
      rmSync(probe, { force: true });
    }
  }

  createTeam(name: string, template: string): TeamListing {
    const id = this.freeId(slug(name) || 'team');
    const src = join(TEMPLATES_DIR, template);
    if (!/^[a-z0-9-]+$/.test(template) || !existsSync(join(src, TEAM_FILE))) throw new BadRequest(`unknown template "${template}"`);
    const dest = join(this.teamsDir, id);
    cpSync(src, dest, { recursive: true });
    // Templates point at the schema in the source tree; inside the library they point at the bundled copy.
    const file = join(dest, TEAM_FILE);
    const doc = parseDocument(readFileSync(file, 'utf8'));
    doc.set('name', slug(name) || id);
    writeFileSync(file, doc.toString().replace(/^# yaml-language-server:.*\n/m, ''));
    return this.listing(id);
  }

  duplicateTeam(id: string, name: string): TeamListing {
    const src = this.teamDir(id);
    const newId = this.freeId(slug(name) || `${id}-copy`);
    cpSync(src, join(this.teamsDir, newId), { recursive: true });
    this.applyEdits(newId, [{ op: 'set', path: ['name'], value: slug(name) || newId }]);
    return this.listing(newId);
  }

  deleteTeam(id: string) {
    rmSync(this.teamDir(id), { recursive: true, force: true });
  }

  private freeId(base: string): string {
    let id = base;
    for (let i = 2; existsSync(join(this.teamsDir, id)); i++) id = `${base}-${i}`;
    return id;
  }

  files(id: string): TeamFileInfo[] {
    const dir = this.teamDir(id);
    const out: TeamFileInfo[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        if (name.startsWith('.')) continue;
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else out.push({ path: relative(dir, p).split(sep).join('/'), size: st.size });
      }
    };
    walk(dir);
    return out;
  }

  private safePath(id: string, rel: string): string {
    const dir = this.teamDir(id);
    const p = resolve(dir, rel);
    if (!p.startsWith(dir + sep) || !/\.(ya?ml|md|json|txt)$/.test(p)) throw new BadRequest(`cannot access "${rel}"`);
    return p;
  }

  readFile(id: string, rel: string): string {
    const p = this.safePath(id, rel);
    if (!existsSync(p)) throw new NotFound(`${rel} not found`);
    return readFileSync(p, 'utf8');
  }

  writeFile(id: string, rel: string, content: string) {
    const p = this.safePath(id, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  deleteFile(id: string, rel: string) {
    if (rel === TEAM_FILE) throw new BadRequest('cannot delete team.yaml');
    rmSync(this.safePath(id, rel), { force: true });
  }

  /**
   * Structured edits from the UI's forms, applied through the YAML document
   * API so comments, ordering and formatting elsewhere in the file survive.
   */
  applyEdits(id: string, ops: EditOp[]): string {
    const file = this.teamFile(id);
    const doc = parseDocument(readFileSync(file, 'utf8'));
    if (doc.errors.length) throw new BadRequest(`team.yaml has syntax errors; fix them in the YAML tab first (${doc.errors[0]!.message.split('\n')[0]})`);
    for (const op of ops) {
      if (!Array.isArray(op.path) || !op.path.length) throw new BadRequest('edit needs a path');
      if (op.op === 'delete') doc.deleteIn(op.path);
      else if (op.op === 'set') {
        if (op.value === undefined || op.value === null) doc.deleteIn(op.path);
        else setIn(doc, op.path, op.value);
      } else throw new BadRequest(`unknown edit op`);
    }
    const text = doc.toString();
    writeFileSync(file, text);
    return text;
  }
}

/** setIn that keeps short lists of scalars in flow style ([a, b]) to match hand-written files. */
function setIn(doc: ReturnType<typeof parseDocument>, path: (string | number)[], value: unknown) {
  const node = doc.createNode(value);
  const flow = (n: unknown) => {
    if (isSeq(n) && n.items.every((i) => !isMap(i) && !isSeq(i))) n.flow = true;
    if (isMap(n)) for (const pair of n.items) flow(pair.value);
    if (isSeq(n)) for (const item of n.items) flow(item);
  };
  flow(node);
  if (isMap(node) && Object.keys(value as object).length <= 3 && Object.values(value as object).every((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    // small maps like { type: subscription } read best inline
    if (path.length > 2) node.flow = true;
  }
  doc.setIn(path, node);
}

export function rawDoc(text: string): Record<string, unknown> {
  try {
    const v = parseDocument(text).toJS();
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A name usable as a team id and as the schema's identifier (starts with a letter). */
function slug(s: string) {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return out && !/^[a-z]/.test(out) ? `team-${out}` : out;
}

export class NotFound extends Error {}
export class BadRequest extends Error {}
