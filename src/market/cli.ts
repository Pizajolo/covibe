// `covibe market …`: the owner's side of the market from a terminal, so the
// whole flow can be run and tested without the app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Connections } from '../connections/store.js';
import { bold, dim, green, red, yellow } from '../format.js';
import { covibeHome } from '../home.js';
import { ClaudeSdkRunner } from '../runner/claude-sdk.js';
import { LocalHost } from './host.js';
import { Market, teamDirOf } from './market.js';
import { yoctoToNear } from './near.js';
import { STOREFRONT_FILE, storefrontTemplate } from './storefront.js';
import { MarketError, type Hire, type LocalOrder, type MarketSettings } from './types.js';

export const MARKET_USAGE = `covibe market — sell a team's work on the covibe market (NEAR escrow)

  covibe market config [--account <id>] [--contract <id>] [--relay <url>] [--network testnet|mainnet]
        [--rpc <url>] [--storefront-url <url>] [--key-file <file>]
                                          Show or change the market settings. The key file is a
                                          near-cli credentials file (or holds just the key); the key
                                          goes to covibe's secret store. COVIBE_NEAR_KEY works too.
  covibe market init <team>               Write a storefront.yaml to start from, next to the team file
  covibe market publish <team>            Create or update the team's listing and its page
  covibe market open|close <team>         Take new orders, or stop taking them
  covibe market orders                    List your orders, what waits for you, and what you earned
  covibe market watch [--once]            Watch for orders: screen them, run the team, deliver, settle
  covibe market accept <order>            Take an order that waits for you (the watcher starts the team)
  covibe market decline <order> [--reason <text>]   Turn it down; the customer is refunded
  covibe market fail <order> [--reason <text>]      Give up on an accepted order; the customer is refunded
  covibe market run <order>               Run the team again on an order whose run stopped

  covibe market agent-market connect <team> --token-file <file> [--url <address>]
                                          Take jobs for this team on NEAR AI Agent Market (market.near.ai): the
                                          file holds the token of your agent there (aat_…); COVIBE_AGENT_MARKET_TOKEN
                                          works too. Its jobs show under orders as h1, h2, … and take the same
                                          accept, decline, fail and run. They need no NEAR account.
  covibe market agent-market disconnect <team>

<team> is a team folder, a team.yaml, or the id of a team in your library.`;

export interface MarketFlags {
  account?: string;
  contract?: string;
  relay?: string;
  network?: string;
  rpc?: string;
  'storefront-url'?: string;
  'key-file'?: string;
  'token-file'?: string;
  url?: string;
  reason?: string;
  once?: boolean;
}

function readKey(file: string): string {
  const text = readFileSync(resolve(file), 'utf8').trim();
  try {
    const json = JSON.parse(text) as { private_key?: string; secret_key?: string };
    const key = json.private_key ?? json.secret_key;
    if (key) return key;
  } catch {
    // not JSON: the file holds the key itself
  }
  return text;
}

const STAGE: Record<LocalOrder['stage'], string> = { new: 'new', checking: 'being screened', awaiting_owner: 'waits for you', running: 'team working', needs_owner: 'waits for you (run stopped)', delivered: 'delivered, in review', closed: 'closed' };

function orderLine(o: LocalOrder): string {
  const head = `${bold(`#${o.id}`)}  ${o.chain.status.padEnd(9)} ${yoctoToNear(o.chain.price).padStart(6)} NEAR  ${o.chain.customer}`;
  const state = o.stage === 'awaiting_owner' || o.stage === 'needs_owner' ? yellow(STAGE[o.stage]) : dim(STAGE[o.stage]);
  const lines = [`${head}  ${state}`];
  if (o.stage === 'awaiting_owner' && o.chain.status === 'REVISION_REQUESTED') {
    lines.push(`      the customer asks for a revision (${o.revision?.n ?? '?'}): ${o.revision?.note?.replace(/\s+/g, ' ').slice(0, 400) ?? o.revision?.problem ?? ''}`);
    lines.push(dim(`      covibe market accept ${o.id}   |   covibe market decline ${o.id} --reason "…"   (declining keeps the delivery as it is)`));
  } else if (o.stage === 'awaiting_owner') {
    for (const c of o.prechecks ?? []) lines.push(`      ${c.ok ? green('✓') : red('✗')} ${c.name}: ${c.detail}`);
    if (o.brief) for (const [k, v] of Object.entries(o.brief)) lines.push(dim(`      ${k}: ${v.replace(/\s+/g, ' ').slice(0, 200)}`));
    if (o.intake) lines.push(`      intake: ${o.intake.decision}, scope fit ${o.intake.scope_fit.toFixed(2)}, ${o.intake.estimated_cost}${o.intake.risks.length ? `; risks: ${o.intake.risks.join('; ')}` : ''}`);
    if (o.recommendation) lines.push(`      recommended: ${bold(o.recommendation.action)} — ${o.recommendation.reason}`);
    lines.push(dim(`      covibe market accept ${o.id}   |   covibe market decline ${o.id} --reason "…"`));
  }
  if (o.stage === 'needs_owner') lines.push(dim(`      covibe market run ${o.id}   |   covibe market fail ${o.id} --reason "…"`));
  if (o.note && o.stage !== 'closed') lines.push(`      ${o.note}`);
  if (o.chain.reason) lines.push(dim(`      reason: ${o.chain.reason}`));
  if (o.gates?.length) lines.push(dim(`      gates: ${o.gates.map((g) => `${g.name} ${g.passed ? 'passed' : 'failed'}`).join(', ')}${o.costUsd !== undefined ? `; run cost $${o.costUsd.toFixed(2)}` : ''}`));
  return lines.join('\n');
}

function hireLine(h: Hire): string {
  const head = `${bold(h.key.padEnd(3))} ${h.status.replace('_', ' ').padEnd(11)} ${`${h.price} ${h.token}`.padStart(10)}  ${h.title.slice(0, 60)}`;
  const state = h.stage === 'awaiting_owner' || h.stage === 'needs_owner' ? yellow(STAGE[h.stage]) : dim(STAGE[h.stage]);
  const lines = [`${head}  ${state}`];
  if (h.stage === 'awaiting_owner' && h.delivery && h.revision) {
    lines.push(`      the buyer asks for changes (${h.revision.n}): ${h.revision.note?.replace(/\s+/g, ' ').slice(0, 400) ?? h.revision.problem ?? ''}`);
    lines.push(dim(`      covibe market accept ${h.key}   |   covibe market decline ${h.key} --reason "…"   (declining submits the earlier delivery again)`));
  } else if (h.stage === 'awaiting_owner') {
    for (const c of h.prechecks ?? []) lines.push(`      ${c.ok ? green('✓') : red('✗')} ${c.name}: ${c.detail}`);
    if (h.brief) for (const [k, v] of Object.entries(h.brief)) lines.push(dim(`      ${k}: ${v.replace(/\s+/g, ' ').slice(0, 200)}`));
    if (h.intake) lines.push(`      intake: ${h.intake.decision}, scope fit ${h.intake.scope_fit.toFixed(2)}, ${h.intake.estimated_cost}${h.intake.risks.length ? `; risks: ${h.intake.risks.join('; ')}` : ''}`);
    if (h.recommendation) lines.push(`      recommended: ${bold(h.recommendation.action)} — ${h.recommendation.reason}`);
    lines.push(dim(`      covibe market accept ${h.key}   |   covibe market decline ${h.key} --reason "…"`));
  }
  if (h.stage === 'needs_owner') lines.push(dim(`      covibe market run ${h.key}   |   covibe market fail ${h.key} --reason "…"`));
  if (h.note) lines.push(`      ${h.note}`);
  if (h.gates?.length) lines.push(dim(`      gates: ${h.gates.map((g) => `${g.name} ${g.passed ? 'passed' : 'failed'}`).join(', ')}${h.costUsd !== undefined ? `; run cost $${h.costUsd.toFixed(2)}` : ''}`));
  return lines.join('\n');
}

const isHire = (text: string | undefined): text is string => !!text && /^h\d+$/.test(text);

export async function marketCommand(args: string[], flags: MarketFlags): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help') {
    console.log(MARKET_USAGE);
    return sub ? 0 : 1;
  }
  const runner = new ClaudeSdkRunner();
  const connections = new Connections();
  connections.usageReader = (env) => runner.usage(env);
  const home = covibeHome();
  const market = new Market({ home, secrets: connections.secrets, host: new LocalHost(runner, connections), log: (line) => console.log(`${dim(new Date().toLocaleTimeString())} ${line}`) });
  const team = (ref: string | undefined) => {
    if (!ref) throw new MarketError(`${sub} needs a team: a team folder, a team.yaml, or a library team's id`);
    return resolve(teamDirOf(ref, join(home, 'teams')));
  };
  const orderId = (text: string | undefined) => {
    if (!text || !/^\d+$/.test(text.replace(/^#/, ''))) throw new MarketError(`${sub} needs an order number (covibe market orders lists them)`);
    return Number(text.replace(/^#/, ''));
  };

  try {
    switch (sub) {
      case 'config': {
        const patch: Partial<MarketSettings> & { privateKey?: string } = {};
        if (flags.account) patch.accountId = flags.account;
        if (flags.contract) patch.contractId = flags.contract;
        if (flags.relay) patch.relayUrl = flags.relay;
        if (flags.rpc) patch.rpcUrl = flags.rpc;
        if (flags['storefront-url']) patch.storefrontUrl = flags['storefront-url'];
        if (flags.network) {
          if (!['testnet', 'mainnet', 'custom'].includes(flags.network)) throw new MarketError('--network is testnet, mainnet or custom (with --rpc)');
          patch.network = flags.network as MarketSettings['network'];
        }
        const key = flags['key-file'] ? readKey(flags['key-file']) : process.env.COVIBE_NEAR_KEY;
        if (key) patch.privateKey = key;
        if (Object.keys(patch).length) market.configure(patch);
        const o = market.overview();
        console.log(`network     ${o.settings.network}  ${dim(o.settings.rpcUrl)}`);
        console.log(`contract    ${o.settings.contractId || red('not set')}`);
        console.log(`account     ${o.settings.accountId || red('not set')}`);
        console.log(`key         ${o.publicKey ? `${o.publicKey} ${dim(`(in the ${connections.secrets.kind === 'keychain' ? 'Keychain' : 'secrets file'})`)}` : red('not set')}`);
        console.log(`relay       ${o.settings.relayUrl}`);
        console.log(`storefront  ${o.settings.storefrontUrl}`);
        if (o.ready) {
          const [config, balance] = await Promise.all([market.chain().config(), market.chain().balance()]);
          console.log(green(`✓ connected: ${yoctoToNear(balance, 2)} NEAR on ${o.settings.accountId}; platform fee ${(config.fee_bps / 100).toFixed(2)}%, ${config.listings} listings, ${config.orders} orders`));
        } else console.log(yellow(`missing: ${o.missing.join(', ')}`));
        return 0;
      }
      case 'agent-market': {
        const [action, ref] = rest;
        if (action === 'connect') {
          const token = flags['token-file'] ? readFileSync(resolve(flags['token-file']), 'utf8').trim() : process.env.COVIBE_AGENT_MARKET_TOKEN;
          if (!token) throw new MarketError('give the token of your agent on NEAR AI Agent Market: --token-file <file>, or COVIBE_AGENT_MARKET_TOKEN');
          await market.hires.connect(team(ref), token, flags.url);
          console.log(green('✓ connected: this team takes the jobs of that agent'));
          console.log(dim('  jobs are picked up where covibe watches (the app, or covibe market watch)'));
          return 0;
        }
        if (action === 'disconnect') {
          market.hires.disconnect(team(ref));
          console.log(green('✓ disconnected; the token was forgotten'));
          return 0;
        }
        for (const c of market.hires.connections()) console.log(`${c.team}  ${dim(c.baseUrl)}`);
        if (!market.hires.connected) console.log(dim('no team is connected (covibe market agent-market connect <team> --token-file <file>)'));
        return 0;
      }
      case 'init': {
        const dir = team(rest[0]);
        const file = join(dir, STOREFRONT_FILE);
        if (existsSync(file)) throw new MarketError(`${file} exists already`);
        writeFileSync(file, storefrontTemplate(new LocalHost(runner, connections).loadTeam(join(dir, 'team.yaml'))));
        console.log(green(`✓ wrote ${file}`));
        console.log(dim('  edit it, then: covibe market publish <team>'));
        return 0;
      }
      case 'publish': {
        const out = await market.publish(team(rest[0]));
        console.log(green(`✓ listing ${out.listingId} ${out.created ? 'created' : 'updated'}`));
        console.log(`  ${out.url}`);
        console.log(dim(`  ${market.explorer('tx', out.tx)}`));
        return 0;
      }
      case 'open':
      case 'close': {
        const tx = await market.setActive(team(rest[0]), sub === 'open');
        console.log(green(`✓ the listing ${sub === 'open' ? 'takes orders again' : 'takes no new orders'}`));
        console.log(dim(`  ${market.explorer('tx', tx)}`));
        return 0;
      }
      case 'orders': {
        await market.tick();
        const o = market.overview();
        if (o.lastError) console.log(red(o.lastError));
        if (!o.listings.length) console.log(dim('nothing published yet (covibe market publish <team>)'));
        for (const l of o.listings) console.log(`listing ${bold(String(l.listingId))}  ${l.listing?.title ?? ''}  ${l.listing && !l.listing.active ? yellow('closed') : ''}\n  ${dim(l.url)}`);
        if (o.orders.length) console.log('');
        for (const order of o.orders) console.log(orderLine(order));
        if (o.hires.length) console.log(`\n${bold('NEAR AI Agent Market')} ${dim('(paid there, when the buyer accepts)')}`);
        for (const h of o.hires) console.log(hireLine(h));
        const e = o.earnings;
        console.log(`\nearned ${bold(`${yoctoToNear(e.earned)} NEAR`)} from ${e.settled} order${e.settled === 1 ? '' : 's'} (fees ${yoctoToNear(e.fees)}); in review ${yoctoToNear(e.inReview)}, in escrow ${yoctoToNear(e.inEscrow)}; ${e.refunded} refunded`);
        if (o.settings.accountId) console.log(dim(market.explorer('account', o.settings.accountId)));
        return 0;
      }
      case 'watch': {
        if (!market.watchable) throw new MarketError(`the market is not set up yet: ${market.overview().missing.join(', ')} missing (covibe market config), and no team is connected to NEAR AI Agent Market`);
        if (flags.once) {
          await market.tick();
          await market.settle();
          return market.lastError ? 1 : 0;
        }
        console.log(`watching ${bold([...(market.overview().ready ? [market.settings().contractId] : []), ...(market.hires.connected ? ['NEAR AI Agent Market'] : [])].join(' and '))} for orders ${dim('(Ctrl-C to stop)')}`);
        let stop = false;
        let wake = () => {};
        const onSigint = () => {
          if (stop) process.exit(130);
          stop = true;
          console.error(yellow('\nstopping…'));
          wake();
        };
        process.on('SIGINT', onSigint);
        while (!stop) {
          await market.tick();
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, market.settings().pollSeconds * 1000).unref();
          });
        }
        await market.close();
        process.off('SIGINT', onSigint);
        return 0;
      }
      case 'accept':
      case 'decline':
      case 'fail': {
        if (isHire(rest[0])) {
          await market.tick();
          if (sub === 'accept') await market.hires.accept(rest[0]);
          else if (sub === 'decline') await market.hires.decline(rest[0], flags.reason);
          else await market.hires.fail(rest[0], flags.reason);
          await market.settle();
          console.log(hireLine(market.store.hire(rest[0])!));
          return 0;
        }
        const id = orderId(rest[0]);
        await market.tick();
        if (sub === 'accept') {
          // Only the transaction: the process that watches sees it and starts the team.
          const local = market.store.order(id);
          if (!local) throw new MarketError(`order ${id} is not one of yours`);
          if (local.chain.status === 'REVISION_REQUESTED') {
            if (!local.revision?.note) throw new MarketError(`the revision cannot be taken: ${local.revision?.problem ?? 'its note has not been read yet'}`);
            // Only the transaction, as for an order: the process that watches starts the team.
            const { tx } = await market.chain().answerRevision(id, true);
            market.store.patchOrder(id, { txs: { revision: tx } });
            console.log(green(`✓ revision of order ${id} taken`));
            console.log(dim(`  ${market.explorer('tx', tx)}\n  the team starts where covibe watches (the app, or covibe market watch)`));
            return 0;
          }
          if (!local.workspace) throw new MarketError(`order ${id} cannot be taken: ${local.recommendation?.reason ?? 'its input could not be read'}`);
          const { tx } = await market.chain().acceptOrder(id);
          market.store.patchOrder(id, { decidedBy: 'owner', txs: { accept: tx } });
          console.log(green(`✓ order ${id} accepted`));
          console.log(dim(`  ${market.explorer('tx', tx)}\n  the team starts where covibe watches (the app, or covibe market watch)`));
        } else {
          const revision = sub === 'decline' && market.store.order(id)?.chain.status === 'REVISION_REQUESTED';
          const tx = sub === 'decline' ? await market.decline(id, flags.reason) : await market.fail(id, flags.reason);
          console.log(green(revision ? `✓ revision of order ${id} turned down; the delivery stands` : `✓ order ${id} ${sub === 'decline' ? 'declined' : 'failed'}; the customer is refunded`));
          console.log(dim(`  ${market.explorer('tx', tx)}`));
        }
        return 0;
      }
      case 'run': {
        if (isHire(rest[0])) {
          await market.tick();
          market.hires.retry(rest[0]);
          await market.settle();
          console.log(hireLine(market.store.hire(rest[0])!));
          return market.store.hire(rest[0])!.stage === 'delivered' ? 0 : 2;
        }
        const id = orderId(rest[0]);
        await market.tick();
        market.retry(id);
        await market.settle();
        console.log(orderLine(market.store.order(id)!));
        return market.store.order(id)!.stage === 'delivered' ? 0 : 2;
      }
      default:
        console.error(`unknown market command "${sub}"\n\n${MARKET_USAGE}`);
        return 1;
    }
  } finally {
    await market.close();
    await connections.close();
  }
}
