import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile } from '../home.js';

/** Where API keys live. Only the connection ids are in covibe's own files. */
export interface SecretStore {
  readonly kind: 'keychain' | 'file';
  get(id: string): string | undefined;
  set(id: string, value: string): void;
  delete(id: string): void;
}

const SERVICE = 'covibe';

/**
 * The macOS Keychain, through the `security` tool, so the app and the CLI
 * read the same items (an item's access list names the tool, not the app).
 * The key goes to `security` on stdin rather than as an argument, so other
 * processes cannot see it in the process list.
 */
export class KeychainSecrets implements SecretStore {
  readonly kind = 'keychain';

  get(id: string): string | undefined {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.replace(/\n$/, '') || undefined;
    } catch {
      return undefined;
    }
  }

  set(id: string, value: string): void {
    // security -i reads commands from stdin with shell-like quoting. Keys are
    // plain tokens; anything that would need escaping takes the argument path.
    const plain = /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value) && /^[\w.@-]+$/.test(id);
    const res = plain
      ? spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${id} -l "covibe ${id}" -w "${value}"\n`, encoding: 'utf8' })
      : spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-l', `covibe ${id}`, '-w', value], { encoding: 'utf8' });
    if (res.status !== 0 || /error/i.test(res.stderr ?? '')) throw new Error(`could not save the key in the Keychain: ${(res.stderr || res.error?.message || 'unknown error').trim()}`);
  }

  delete(id: string): void {
    spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', id], { stdio: 'ignore' });
  }
}

/** A JSON file only your user can read (like ~/.claude/.credentials.json), where there is no Keychain. */
export class FileSecrets implements SecretStore {
  readonly kind = 'file';
  readonly file: string;

  constructor(home: string) {
    this.file = join(home, 'secrets.json');
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>) {
    replaceFile(this.file, JSON.stringify(all, null, 2) + '\n', 0o600);
  }

  get(id: string): string | undefined {
    return this.read()[id];
  }

  set(id: string, value: string): void {
    this.write({ ...this.read(), [id]: value });
  }

  delete(id: string): void {
    const all = this.read();
    delete all[id];
    this.write(all);
  }
}

/** The Keychain on macOS; a private file elsewhere, or when COVIBE_SECRETS=file (tests). */
export function defaultSecrets(home: string): SecretStore {
  return process.platform === 'darwin' && process.env.COVIBE_SECRETS !== 'file' ? new KeychainSecrets() : new FileSecrets(home);
}
