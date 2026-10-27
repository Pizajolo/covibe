// The skill library: Claude Code skills (folders with a SKILL.md) that you
// write yourself or install from GitHub, kept in one local plugin so each
// agent can be given exactly the skills it should have.
//
//   ~/.covibe/skills-plugin/.claude-plugin/plugin.json
//   ~/.covibe/skills-plugin/skills/<name>/SKILL.md (+ any files it uses)
//   ~/.covibe/skills-plugin/skills/<name>/.covibe-skill.json (where it came from)
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYamlText } from 'yaml';
import { covibeHome } from './home.js';

const exec = promisify(execFile);
export const SKILL_PLUGIN = 'covibe';
const META = '.covibe-skill.json';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SkillError extends Error {}

export interface SkillOrigin {
  repo: string;
  ref?: string;
  path: string;
  commit?: string;
}

export interface LibrarySkill {
  name: string;
  description: string;
  source: 'manual' | 'github';
  origin?: SkillOrigin;
  /** Given to every member of every team. */
  everyone: boolean;
  files: number;
  updatedAt: string;
}

interface Meta {
  source: 'manual' | 'github';
  origin?: SkillOrigin;
  everyone?: boolean;
}

export function skillsPluginDir(): string {
  return join(covibeHome(), 'skills-plugin');
}

function skillsDir(): string {
  return join(skillsPluginDir(), 'skills');
}

function ensurePlugin() {
  const manifest = join(skillsPluginDir(), '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name: SKILL_PLUGIN, version: '1.0.0', description: 'Skills from your covibe library' }, null, 2) + '\n');
  }
  mkdirSync(skillsDir(), { recursive: true });
}

/** Split a SKILL.md into its frontmatter fields and body. */
export function parseSkillMd(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text };
  try {
    const front = (parseYamlText(m[1]!) ?? {}) as Record<string, unknown>;
    return { name: typeof front.name === 'string' ? front.name : undefined, description: typeof front.description === 'string' ? front.description : undefined, body: m[2] ?? '' };
  } catch {
    return { body: m[2] ?? '' };
  }
}

export function skillMd(name: string, description: string, body: string): string {
  const front = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  return front + body.replace(/^\s+/, '');
}

function readMeta(dir: string): Meta {
  try {
    return JSON.parse(readFileSync(join(dir, META), 'utf8')) as Meta;
  } catch {
    return { source: 'manual' };
  }
}

function writeMeta(dir: string, meta: Meta) {
  writeFileSync(join(dir, META), JSON.stringify(meta, null, 2) + '\n');
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === META) continue;
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

export function listSkills(): LibrarySkill[] {
  if (!existsSync(skillsDir())) return [];
  return readdirSync(skillsDir())
    .filter((d) => existsSync(join(skillsDir(), d, 'SKILL.md')))
    .sort()
    .map((name) => {
      const dir = join(skillsDir(), name);
      const parsed = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      const meta = readMeta(dir);
      return {
        name,
        description: parsed.description ?? '',
        source: meta.source,
        origin: meta.origin,
        everyone: !!meta.everyone,
        files: countFiles(dir),
        updatedAt: statSync(join(dir, 'SKILL.md')).mtime.toISOString(),
      };
    });
}

function skillDir(name: string): string {
  if (!NAME.test(name)) throw new SkillError(`"${name}" is not a valid skill name (lowercase letters, digits and -)`);
  return join(skillsDir(), name);
}

export function getSkill(name: string): { skill: LibrarySkill; files: { path: string; size: number }[] } {
  const dir = skillDir(name);
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) throw new SkillError(`skill ${name} not found`);
  const files: { path: string; size: number }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === META) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push({ path: relative(dir, p).split(sep).join('/'), size: statSync(p).size });
    }
  };
  walk(dir);
  return { skill, files };
}

function safeFile(name: string, rel: string): string {
  const dir = skillDir(name);
  const p = resolve(dir, rel);
  if (!p.startsWith(dir + sep) || basename(p) === META) throw new SkillError(`cannot access "${rel}"`);
  return p;
}

export function readSkillFile(name: string, rel: string): string {
  const p = safeFile(name, rel);
  if (!existsSync(p)) throw new SkillError(`${rel} not found`);
  return readFileSync(p, 'utf8');
}

export function writeSkillFile(name: string, rel: string, content: string) {
  const p = safeFile(name, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function createSkill(input: { name: string; description: string; body: string }): LibrarySkill {
  ensurePlugin();
  const dir = skillDir(input.name);
  if (existsSync(dir)) throw new SkillError(`a skill named ${input.name} already exists`);
  if (!input.description.trim()) throw new SkillError('a skill needs a description: it tells Claude when to use it');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(input.name, input.description.trim(), input.body));
  writeMeta(dir, { source: 'manual' });
  return listSkills().find((s) => s.name === input.name)!;
}

export function deleteSkill(name: string) {
  rmSync(skillDir(name), { recursive: true, force: true });
}

export function setEveryone(name: string, everyone: boolean): LibrarySkill {
  const dir = skillDir(name);
  if (!existsSync(dir)) throw new SkillError(`skill ${name} not found`);
  writeMeta(dir, { ...readMeta(dir), everyone });
  return listSkills().find((s) => s.name === name)!;
}

/**
 * Turn a member's skill list into what the SDK needs: library skills are
 * plugin-qualified ("covibe:pdf"), anything else is taken as a skill Claude
 * Code already has (a built-in, or one from the project's .claude/skills).
 * Skills marked "everyone" are always included.
 */
export function resolveSkills(requested: string[]): { names: string[]; pluginDirs: string[] } | undefined {
  const library = new Map(listSkills().map((s) => [s.name, s]));
  const wanted = new Set([...requested, ...[...library.values()].filter((s) => s.everyone).map((s) => s.name)]);
  if (!wanted.size) return undefined;
  const names = [...wanted].map((n) => (library.has(n) ? `${SKILL_PLUGIN}:${n}` : n));
  const usesLibrary = [...wanted].some((n) => library.has(n));
  return { names, pluginDirs: usesLibrary ? [skillsPluginDir()] : [] };
}

// ---------------------------------------------------------------- GitHub

export interface GithubRef {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

/** Accepts https://github.com/o/r, …/tree/<ref>/<path>, …/blob/<ref>/<path>/SKILL.md, or o/r[/path]. */
export function parseGithub(input: string): GithubRef {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.*))?)?$/.exec(s);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3], path: (url[4] ?? '').replace(/\/?SKILL\.md$/, '') };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.*))?$/.exec(s);
  if (short) return { owner: short[1]!, repo: short[2]!, path: (short[3] ?? '').replace(/\/?SKILL\.md$/, '') };
  throw new SkillError('Use a GitHub URL like https://github.com/anthropics/skills/tree/main/skills/pdf, or owner/repo');
}

export interface SkillCandidate {
  /** Folder of the skill inside the repository. */
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

const checkouts = new Map<string, { dir: string; commit: string; at: number }>();

async function git(cwd: string, args: string[]) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 32 << 20, timeout: 180_000 })).stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new SkillError(`git ${args[0]}: ${(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

/** A shallow, blobless, sparse clone: cheap even for big repositories. Reused for 10 minutes. */
async function checkout(ref: GithubRef): Promise<{ dir: string; commit: string }> {
  const key = `${ref.owner}/${ref.repo}@${ref.ref ?? ''}`;
  const cached = checkouts.get(key);
  if (cached && Date.now() - cached.at < 600_000 && existsSync(cached.dir)) return cached;
  const dir = join(covibeHome(), 'cache', 'github', `${ref.owner}__${ref.repo}__${(ref.ref ?? 'default').replace(/[^\w.-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const args = ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', ...(ref.ref ? ['--branch', ref.ref] : []), `https://github.com/${ref.owner}/${ref.repo}.git`, dir];
  await git(dirname(dir), args);
  const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const entry = { dir, commit, at: Date.now() };
  checkouts.set(key, entry);
  return entry;
}

/** Find the skills in a GitHub location and read their name and description. */
export async function scanGithub(input: string | GithubRef): Promise<{ ref: GithubRef; commit: string; skills: SkillCandidate[] }> {
  const ref = typeof input === 'string' ? parseGithub(input) : input;
  const { dir, commit } = await checkout(ref);
  const listed = (await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', ...(ref.path ? ['--', ref.path] : [])])).split('\n').filter((p) => p.endsWith('SKILL.md'));
  // Skip templates and examples of the format itself.
  const files = listed.filter((p) => !/(^|\/)template\/SKILL\.md$/.test(p)).slice(0, 200);
  if (!files.length) return { ref, commit, skills: [] };
  await git(dir, ['sparse-checkout', 'set', '--no-cone', ...files.map((f) => `/${f}`)]);
  const installed = new Set(listSkills().map((s) => s.name));
  const skills = files.map((f) => {
    const parsed = parseSkillMd(readFileSync(join(dir, f), 'utf8'));
    const folder = dirname(f) === '.' ? '' : dirname(f);
    const name = toName(parsed.name ?? basename(folder || ref.repo));
    return { path: folder, name, description: parsed.description ?? '', installed: installed.has(name) };
  });
  return { ref, commit, skills };
}

function toName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

/** Install (or update) skills from GitHub into the library. */
export async function installGithub(input: string | GithubRef, paths: string[]): Promise<LibrarySkill[]> {
  ensurePlugin();
  const { ref, commit, skills } = await scanGithub(input);
  const chosen = skills.filter((s) => paths.includes(s.path));
  if (!chosen.length) throw new SkillError('none of the selected skills were found');
  const { dir } = await checkout(ref);
  await git(dir, ['sparse-checkout', 'set', '--no-cone', ...chosen.map((s) => (s.path ? `/${s.path}/` : '/*'))]);
  const repo = `${ref.owner}/${ref.repo}`;
  for (const s of chosen) {
    const dest = skillDir(s.name);
    if (existsSync(dest)) {
      const meta = readMeta(dest);
      if (meta.origin?.repo !== repo || meta.origin.path !== s.path) throw new SkillError(`a different skill named ${s.name} is already in your library`);
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(s.path ? join(dir, s.path) : dir, dest, { recursive: true, filter: (src) => !src.split(sep).includes('.git') });
    const previous = existsSync(join(dest, META)) ? readMeta(dest) : undefined;
    writeMeta(dest, { source: 'github', origin: { repo, ref: ref.ref, path: s.path, commit }, everyone: previous?.everyone ?? false });
  }
  const names = new Set(chosen.map((s) => s.name));
  return listSkills().filter((s) => names.has(s.name));
}

/** Re-install a GitHub skill from the latest commit of its source. */
export async function updateSkill(name: string): Promise<LibrarySkill> {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill?.origin) throw new SkillError(`${name} was not installed from GitHub`);
  const { repo, ref, path } = skill.origin;
  checkouts.delete(`${repo}@${ref ?? ''}`);
  const [owner, name_] = repo.split('/') as [string, string];
  const [installed] = await installGithub({ owner, repo: name_, ref, path }, [path]);
  return installed!;
}

/** Anthropic's published skills, as a catalog to install from. */
export const ANTHROPIC_SKILLS = 'https://github.com/anthropics/skills/tree/main/skills';
