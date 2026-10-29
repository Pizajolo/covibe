import { covibeHome } from '../home.js';
import { defaultSecrets, FileSecrets, KeychainSecrets, type SecretStore } from './secrets.js';

// Keys and other variables a plugin's servers need (an API key, a workspace
// id), entered on the plugin's page. They live with covibe's other keys (the
// Keychain, or ~/.covibe/secrets.json), never in a plugin's files or a
// member's environment: the sandbox launcher reads them when it starts one of
// the plugin's servers and hands them to that server alone, and covibe's MCP
// proxy adds them to a remote server's requests.

/** Where the launcher (a separate process) finds a plugin's keys; written into its sandbox.json. */
export interface KeysLocation {
  store: 'keychain' | 'file';
  /** covibe's folder, for the file store. */
  home: string;
  id: string;
}

const secretId = (plugin: string) => `plugin-env.${plugin}`.replace(/[^\w.@-]/g, '_');

let secrets: SecretStore | undefined;
const store = () => (secrets ??= defaultSecrets(covibeHome()));

/** For tests: keep secrets somewhere else. */
export function usePluginKeyStore(s: SecretStore) {
  secrets = s;
}

function parse(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {};
  }
}

/** The values saved for a plugin, by variable name. */
export function pluginKeys(plugin: string): Record<string, string> {
  return parse(store().get(secretId(plugin)));
}

/** Save, replace or (with null) remove some of a plugin's values. */
export function setPluginKeys(plugin: string, values: Record<string, string | null>) {
  const all = pluginKeys(plugin);
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === '') delete all[k];
    else all[k] = v;
  }
  if (Object.keys(all).length) store().set(secretId(plugin), JSON.stringify(all));
  else store().delete(secretId(plugin));
}

export function forgetPluginKeys(plugin: string) {
  store().delete(secretId(plugin));
}

/** Where the launcher reads this plugin's keys from. */
export function keysLocation(plugin: string): KeysLocation {
  return { store: store().kind, home: covibeHome(), id: secretId(plugin) };
}

/** In the launcher: the keys at a location from sandbox.json. */
export function readKeys(at: KeysLocation): Record<string, string> {
  return parse((at.store === 'keychain' ? new KeychainSecrets() : new FileSecrets(at.home)).get(at.id));
}
