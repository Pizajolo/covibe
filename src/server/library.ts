import { randomBytes } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { ConfigError, loadTeam } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';
import { covibeHome } from '../home.js';
import type { AppSettings, EditOp, NotificationKind, NotifyChoice, Project, TeamFileInfo, TeamListing } from './api-types.js';

/**
 * The desktop app's library: the projects (git repositories) you work on and
 * the teams you have defined. Teams are reusable across projects; each lives
 * in its own folder with its team.yaml, prompts and schemas.
 *
 *   ~/.covibe/config.json
 *   ~/.covibe/teams/<team-id>/team.yaml
 */
interface LibraryConfig {
  projects: Project[];
  settings?: Partial<AppSettings>;
}

export type { EditOp, Project, TeamFileInfo, TeamListing };

export const NOTIFICATION_KINDS: NotificationKind[] = ['question', 'limit', 'stopped', 'error', 'done'];
/** By default everything shows under the bell and goes out as a system notification. */
const DEFAULT_NOTIFY: Record<NotificationKind, NotifyChoice> = {
  question: { bell: true, push: true },
  limit: { bell: true, push: true },
  stopped: { bell: true, push: true },
  error: { bell: true, push: true },
  done: { bell: true, push: true },
};

const execAsync = promisify(execFile);
const TEMPLATES_DIR = new URL('../../examples/', import.meta.url).pathname;
const TEAM_FILE = 'team.yaml';

export class Library {
  readonly teamsDir: string;
  private readonly configFile: string;

  constructor(readonly home = covibeHome()) {
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

  // ---- settings

  settings(): AppSettings {
    const saved = this.read().settings ?? {};
    const notifications = { ...DEFAULT_NOTIFY };
    for (const k of NOTIFICATION_KINDS) notifications[k] = { ...DEFAULT_NOTIFY[k], ...saved.notifications?.[k] };
    return { autoCleanDays: null, ...saved, notifications };
  }

  /** Change some settings; notifications merge per kind, so one kind's choice can be sent alone. */
  updateSettings(patch: Partial<Omit<AppSettings, 'notifications'>> & { notifications?: Partial<Record<NotificationKind, Partial<NotifyChoice>>> }): AppSettings {
    const config = this.read();
    const days = patch.autoCleanDays;
    if (days !== undefined && days !== null && (!Number.isFinite(days) || days < 0 || days > 3650)) throw new BadRequest('autoCleanDays must be between 0 and 3650, or null');
    if (patch.onLimit !== undefined && patch.onLimit !== 'wait' && patch.onLimit !== 'stop') throw new BadRequest('onLimit is "wait" or "stop"');
    const { notifications: notify, ...rest } = patch;
    const next: Partial<AppSettings> = { ...config.settings, ...rest };
    if (notify !== undefined) {
      const merged = { ...this.settings().notifications };
      for (const [k, v] of Object.entries(notify ?? {})) {
        if (!NOTIFICATION_KINDS.includes(k as NotificationKind)) throw new BadRequest(`unknown notification kind "${k}"`);
        const choice = { ...merged[k as NotificationKind], ...v };
        if (typeof choice.bell !== 'boolean' || typeof choice.push !== 'boolean') throw new BadRequest(`notifications.${k} takes bell and push as true or false`);
        merged[k as NotificationKind] = { bell: choice.bell, push: choice.push };
      }
      next.notifications = merged;
    }
    config.settings = next;
    this.write(config);
    return this.settings();
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

  /**
   * Add an existing folder. covibe needs git with at least one commit (each
   * run branches off it); with `init`, a plain folder gets `git init` and a
   * first commit of what is in it.
   */
  addProject(path: string, opts: { init?: boolean } = {}): Project {
    const dir = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BadRequest(`${dir} is not a folder`);
    let top: string;
    try {
      top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      if (!opts.init) throw new NeedsGit(`${dir} is not a git repository yet.`);
      initRepo(dir);
      top = dir;
    }
    if (!hasCommit(top)) {
      if (!opts.init) throw new NeedsGit(`${top} has no commits yet.`);
      initRepo(top);
    }
    const config = this.read();
    const existing = config.projects.find((p) => p.path === top);
    if (existing) return existing;
    const project: Project = { id: slug(basename(top)) + '-' + randomBytes(2).toString('hex'), name: basename(top), path: top, addedAt: new Date().toISOString() };
    config.projects.push(project);
    this.write(config);
    return project;
  }

  /** A new, empty project folder with a README and a first commit. */
  createProject(parent: string, name: string): Project {
    const folder = name.trim().replace(/[/\\]/g, '-');
    if (!folder || folder.startsWith('.')) throw new BadRequest('give the project a name');
    const dir = join(resolve(parent.replace(/^~(?=$|\/)/, homedir())), folder);
    if (existsSync(dir) && readdirSync(dir).length) throw new BadRequest(`${dir} already exists and is not empty`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `# ${folder}\n`);
    initRepo(dir);
    return this.addProject(dir);
  }

  /** Clone a repository into `parent` and add it. */
  async cloneProject(url: string, parent: string, name?: string): Promise<Project> {
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)[^\s]+$/.test(url.trim())) throw new BadRequest('enter a git URL, e.g. https://github.com/owner/repo');
    const base = resolve(parent.replace(/^~(?=$|\/)/, homedir()));
    const folder = (name?.trim() || url.trim().replace(/\.git$/, '').split(/[/:]/).pop() || 'repo').replace(/[/\\]/g, '-');
    const dir = join(base, folder);
    if (existsSync(dir) && readdirSync(dir).length) throw new BadRequest(`${dir} already exists and is not empty`);
    mkdirSync(base, { recursive: true });
    try {
      await execAsync('git', ['clone', '-q', url.trim(), dir], { timeout: 15 * 60_000, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new BadRequest(`Could not clone: ${(e.stderr || e.message).trim().split('\n').pop()}`);
    }
    return this.addProject(dir, { init: true });
  }

  /** Where new projects go by default. */
  defaultParent(): string {
    for (const d of ['Developer', 'Projects', 'Code', 'code', 'src']) if (existsSync(join(homedir(), d))) return join(homedir(), d);
    return join(homedir(), 'Projects');
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
    writeFileSync(file, doc.toString().replace(/^# yaml-language-server:.*\n(#\s*\n)?/m, ''));
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
      } else if (op.op === 'move' || op.op === 'insert') {
        const seq = doc.getIn(op.path, true);
        if (!isSeq(seq)) throw new BadRequest(`${op.path.join('.')} is not a list`);
        if (op.op === 'move') {
          const { from, to } = op;
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= seq.items.length || to >= seq.items.length) throw new BadRequest('move out of range');
          const [item] = seq.items.splice(from, 1);
          seq.items.splice(to, 0, item!);
        } else {
          const index = op.index === undefined ? seq.items.length : Math.max(0, Math.min(seq.items.length, op.index));
          const node = doc.createNode(op.value);
          flowScalars(node);
          seq.items.splice(index, 0, node);
        }
      } else throw new BadRequest(`unknown edit op`);
    }
    const text = doc.toString();
    writeFileSync(file, text);
    return text;
  }
}

/** setIn that keeps short lists of scalars in flow style ([a, b]) to match hand-written files. */
function flowScalars(n: unknown) {
  if (isSeq(n) && n.items.every((i) => !isMap(i) && !isSeq(i))) n.flow = true;
  if (isMap(n)) for (const pair of n.items) flowScalars(pair.value);
  if (isSeq(n)) for (const item of n.items) flowScalars(item);
}

function setIn(doc: ReturnType<typeof parseDocument>, path: (string | number)[], value: unknown) {
  const node = doc.createNode(value);
  flowScalars(node);
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

function hasCommit(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Written before the first commit of a folder that has none, so secrets and
// dependency or build folders do not end up in history.
const DEFAULT_GITIGNORE = ['node_modules/', '.env', '.env.*', '!.env.example', 'dist/', 'build/', '.next/', 'out/', 'target/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.DS_Store', '*.log', '.idea/', '.vscode/', ''].join('\n');

function initRepo(dir: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'covibe', GIT_AUTHOR_EMAIL: 'covibe@localhost', GIT_COMMITTER_NAME: 'covibe', GIT_COMMITTER_EMAIL: 'covibe@localhost' };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env });
  if (!existsSync(join(dir, '.git'))) run('init', '-q', '-b', 'main');
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), DEFAULT_GITIGNORE);
  run('add', '-A');
  run('commit', '-q', '--allow-empty', '-m', 'Initial commit');
}

/** The folder is fine but needs git first; the UI offers to set it up. */
export class NeedsGit extends Error {}
export class NotFound extends Error {}
export class BadRequest extends Error {}
