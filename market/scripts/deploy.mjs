#!/usr/bin/env node
// Deploy the market contract to an account and initialise it.
//
//   node market/scripts/deploy.mjs --account covibe-market.testnet [--treasury <account>]
//        [--fee-bps 250] [--min-price 0.1] [--max-price 1000] [--max-open-orders 5]
//        [--network testnet] [--rpc <url>] [--key-file <file>]
//
// The key comes from --key-file (a near-cli credentials file, or a file with
// just the key), from NEAR_PRIVATE_KEY, or from ~/.near-credentials/<network>/<account>.json.
// Run it again to upgrade the code; an initialised contract keeps its state. A contract from
// before revisions and reviews is migrated (its listings and orders stay as they are).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, nearToYocto } from 'near-api-js';

const { values: v } = parseArgs({
  options: {
    account: { type: 'string' },
    treasury: { type: 'string' },
    'fee-bps': { type: 'string', default: '250' },
    'min-price': { type: 'string', default: '0.1' },
    'max-price': { type: 'string', default: '1000' },
    'max-open-orders': { type: 'string', default: '5' },
    network: { type: 'string', default: 'testnet' },
    rpc: { type: 'string' },
    'key-file': { type: 'string' },
    wasm: { type: 'string' },
  },
});
if (!v.account) {
  console.error('usage: node market/scripts/deploy.mjs --account <contract account> [--treasury <account>] [--fee-bps 250]');
  process.exit(1);
}
const rpc = v.rpc ?? (v.network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com');
const keyFile = v['key-file'] ?? join(homedir(), '.near-credentials', v.network, `${v.account}.json`);
let key = process.env.NEAR_PRIVATE_KEY;
if (!key && existsSync(keyFile)) {
  const text = readFileSync(keyFile, 'utf8').trim();
  try {
    const json = JSON.parse(text);
    key = json.private_key ?? json.secret_key;
  } catch {
    key = text;
  }
}
if (!key) {
  console.error(`no key for ${v.account}: give --key-file, set NEAR_PRIVATE_KEY, or sign in with near-cli so ${keyFile} exists`);
  process.exit(1);
}
const wasm = v.wasm ?? new URL('../contract/res/covibe_market.wasm', import.meta.url).pathname;
const provider = new JsonRpcProvider({ url: rpc });
const account = new Account(v.account, provider, key);

console.log(`deploying ${wasm} to ${v.account} on ${rpc}`);
await account.deployContract(readFileSync(wasm));
let config;
try {
  config = await provider.callFunction({ contractId: v.account, method: 'get_config', args: {} });
  console.log('the contract was initialised before; its code is upgraded and its state kept');
} catch {
  // The state does not read with the new code: it is either from an earlier version, or not there yet.
  let migrated = false;
  try {
    await account.callFunction({ contractId: v.account, methodName: 'migrate', args: {} });
    migrated = true;
    console.log('the contract held state from an earlier version; it was migrated, its listings and orders kept');
  } catch {
    // no earlier state: a first deployment
  }
  if (!migrated) await account.callFunction({
    contractId: v.account,
    methodName: 'new',
    args: { treasury: v.treasury ?? v.account, fee_bps: Number(v['fee-bps']), min_price: nearToYocto(v['min-price']).toString(), max_price: nearToYocto(v['max-price']).toString(), max_open_orders: Number(v['max-open-orders']) },
  });
  config = await provider.callFunction({ contractId: v.account, method: 'get_config', args: {} });
}
console.log(config);
console.log(`\nnext:\n  covibe market config --contract ${v.account} --account <your account> --key-file <its key>\n  RELAY_CONTRACT=${v.account} node market/relay/server.mjs\n  put "contractId": "${v.account}" into market/storefront/public/config.json`);
