// The market: sell a team's work. Storefronts (one per team, published as a
// listing on NEAR; see Storefronts.tsx), incoming orders with the intake's
// recommendation, what was earned, and the connection settings. The server
// side is src/market.
import { useEffect, useState } from 'react';
import { del, get, post, put, type Hire, type LocalOrder, type MarketView } from '../api';
import { IconAlert, IconCheck, IconCoin, IconLoop, IconPlay, IconShield, IconX } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { Empty, Modal, useAction, useToast } from '../components/ui';
import { go, href, useLive } from '../data';
import { ago, money } from '../format';
import { openUrl } from './GitView';
import { StorefrontEditor, Storefronts } from './Storefronts';

type Tab = 'orders' | 'storefronts' | 'earnings' | 'settings';
const TABS: Tab[] = ['orders', 'storefronts', 'earnings', 'settings'];

/** yoctoNEAR as NEAR, with up to four decimals. */
export function near(yocto: string | undefined): string {
  if (!yocto) return '0';
  const n = BigInt(yocto);
  const unit = 10n ** 24n;
  const frac = (n % unit).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  return frac ? `${n / unit}.${frac}` : `${n / unit}`;
}

export function Market({ tab: tabParam, name }: { tab?: string; name?: string }) {
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'orders';
  const { value: m, error, reload } = useLive(() => get<MarketView>('/api/market'), []);
  const toast = useToast();
  // Orders move on their own (the watcher, the team's run): look again every few seconds.
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const [refresh, refreshing] = useAction(async () => {
    await post('/api/market/refresh');
    await reload();
  });
  const [watch] = useAction(async (on: boolean) => {
    await put('/api/market/settings', { watch: on });
    toast(on ? 'Watching for orders while covibe is open' : 'No longer watching for orders');
    await reload();
  });

  if (tab === 'storefronts' && name) return <StorefrontEditor team={name} market={m} onChanged={reload} />;
  const waiting = m?.orders.filter((o) => o.stage === 'awaiting_owner' || o.stage === 'needs_owner').length ?? 0;
  return (
    <>
      <Toolbar title="Market" sub="Sell a team's work. The price waits in a NEAR escrow and is released only when the team's gates pass.">
        {m?.ready && (
          <label className="check small" title="Poll the contract for new orders, screen them, run the team and deliver">
            <input type="checkbox" checked={m.watching} onChange={(e) => void watch(e.target.checked)} /> Watch for orders
          </label>
        )}
        <button className="btn" disabled={refreshing || !m?.ready} onClick={() => void refresh()}>
          <IconLoop /> Check now
        </button>
      </Toolbar>
      <nav className="tabs">
        {TABS.map((id) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => go('market', id)}>
            {id === 'orders' ? 'Incoming orders' : id[0]!.toUpperCase() + id.slice(1)}
            {id === 'orders' && waiting > 0 && <span className="badge">{waiting}</span>}
          </button>
        ))}
      </nav>
      <div className="content">
        <div className="page">
          {error && (
            <div className="banner bad">
              <IconAlert /> {error}
            </div>
          )}
          {m && !m.ready && tab !== 'settings' && (
            <div className="banner warn">
              <IconAlert />
              <div className="grow">
                The market is not set up yet: {m.missing.join(', ')} {m.missing.length === 1 ? 'is' : 'are'} missing.
              </div>
              <button className="btn sm" onClick={() => go('market', 'settings')}>
                Set up
              </button>
            </div>
          )}
          {m?.lastError && (
            <div className="banner bad">
              <IconAlert /> {m.lastError}
            </div>
          )}
          {!m ? (
            <div className="faint small">Loading…</div>
          ) : tab === 'orders' ? (
            <Orders m={m} onChanged={reload} />
          ) : tab === 'storefronts' ? (
            <Storefronts m={m} onChanged={reload} />
          ) : tab === 'earnings' ? (
            <EarningsTab m={m} />
          ) : (
            <SettingsTab m={m} onChanged={reload} />
          )}
        </div>
      </div>
    </>
  );
}

// ---- incoming orders

const STAGE: Record<LocalOrder['stage'], { label: string; tone: string }> = {
  new: { label: 'New', tone: 'info' },
  checking: { label: 'Being screened', tone: 'info' },
  awaiting_owner: { label: 'Waits for you', tone: 'warn' },
  running: { label: 'Team working', tone: 'info' },
  needs_owner: { label: 'Run stopped: waits for you', tone: 'warn' },
  delivered: { label: 'Delivered, in review', tone: 'good' },
  closed: { label: 'Closed', tone: '' },
};

const CLOSED: Record<string, { label: string; tone: string }> = {
  SETTLED: { label: 'Paid', tone: 'good' },
  DECLINED: { label: 'Declined, refunded', tone: '' },
  FAILED: { label: 'Failed, refunded', tone: 'bad' },
  EXPIRED: { label: 'Expired, refunded', tone: 'bad' },
  DISPUTED: { label: 'Disputed, refunded', tone: 'bad' },
};

function Orders({ m, onChanged }: { m: MarketView; onChanged: () => Promise<void> }) {
  const open = m.orders.filter((o) => o.stage !== 'closed');
  const closed = m.orders.filter((o) => o.stage === 'closed');
  const hires = m.hires ?? [];
  if (!m.orders.length && !hires.length)
    return (
      <div className="card">
        <Empty icon={<IconCoin />} title="No orders yet" action={m.teams.some((t) => t.listingId !== undefined) ? undefined : <button className="btn primary" onClick={() => go('market', 'storefronts')}>Publish a storefront</button>}>
          {m.watching
            ? 'covibe is watching the contract. An order shows here as soon as a customer places one.'
            : 'Turn on “Watch for orders” (top right) and covibe screens each new order, runs the team once you accept, and delivers when its gates pass.'}
        </Empty>
      </div>
    );
  return (
    <>
      {hires.filter((h) => h.stage !== 'closed').map((h) => (
        <HireCard key={h.key} h={h} m={m} onChanged={onChanged} />
      ))}
      {open.map((o) => (
        <OrderCard key={o.id} o={o} m={m} onChanged={onChanged} />
      ))}
      {hires.some((h) => h.stage === 'closed') && (
        <div className="card">
          <div className="card-head">
            <h2>Finished on NEAR AI Agent Market</h2>
          </div>
          <table className="table">
            <tbody>
              {hires.filter((h) => h.stage === 'closed').map((h) => (
                <tr key={h.key}>
                  <td className="mono">{h.key}</td>
                  <td>{h.title}</td>
                  <td>
                    <span className={`pill ${h.status === 'accepted' ? 'good' : ''}`}>{HIRE_CLOSED[h.status] ?? h.status}</span>
                  </td>
                  <td className="muted">{h.note ?? (h.gates?.length ? h.gates.map((g) => `${g.name} ${g.passed ? '✓' : '✗'}`).join(', ') : '')}</td>
                  <td className="r mono">
                    {h.price} {h.token}
                  </td>
                  <td className="r faint">{ago(h.updatedAt)}</td>
                  <td className="r">{h.runId && h.projectId && <a href={href('runs', h.projectId, h.runId)}>Run</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closed.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Finished</h2>
          </div>
          <table className="table">
            <tbody>
              {closed.map((o) => (
                <tr key={o.id}>
                  <td className="mono">#{o.id}</td>
                  <td>{teamName(m, o)}</td>
                  <td className="muted">{o.chain.customer}</td>
                  <td>
                    <span className={`pill ${CLOSED[o.chain.status]?.tone ?? ''}`}>{CLOSED[o.chain.status]?.label ?? o.chain.status}</span>
                  </td>
                  <td className="muted">{o.chain.review ? `${'★'.repeat(o.chain.review.stars)}${'☆'.repeat(5 - o.chain.review.stars)} ${o.chain.review.comment}` : o.chain.reason ?? (o.gates?.length ? o.gates.map((g) => `${g.name} ${g.passed ? '✓' : '✗'}`).join(' ') : '')}</td>
                  <td className="r mono">{near(o.chain.price)} NEAR</td>
                  <td className="r faint">{ago(o.updatedAt)}</td>
                  <td className="r">{o.runId && o.projectId && <a href={href('runs', o.projectId, o.runId)}>Run</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const HIRE_CLOSED: Record<string, string> = { accepted: 'Accepted by the buyer', cancelled: 'Handed back or cancelled, refunded', dispute_resolved: 'Dispute settled with a split' };

/** A job from NEAR AI Agent Market: the same steps as an order, paid there when the buyer accepts. */
function HireCard({ h, m, onChanged }: { h: Hire; m: MarketView; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [ask, setAsk] = useState<null | 'decline' | 'fail'>(null);
  const [reason, setReason] = useState('');
  const changes = h.stage === 'awaiting_owner' && !!h.delivery && !!h.revision;
  const [act, busy] = useAction(async (what: 'accept' | 'decline' | 'fail' | 'retry', why?: string) => {
    await post(`/api/market/hires/${h.key}/${what}`, why ? { reason: why } : {});
    toast(what === 'accept' ? `${h.key} taken: the team starts` : what === 'decline' ? (changes ? `${h.key}: the earlier delivery was submitted again` : `${h.key} declined: the buyer is refunded`) : what === 'fail' ? `${h.key} handed back: the buyer is refunded` : `${h.key}: the team runs again`);
    setAsk(null);
    await onChanged();
  });
  const stage = STAGE[h.stage];
  const failed = (h.prechecks ?? []).filter((c) => !c.ok);
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {h.key} · {h.title}
        </h2>
        <span className={`pill ${stage.tone}`}>{changes ? 'Changes asked: waits for you' : h.stage === 'running' && h.revisionRun ? `Team working on revision ${h.revisionRun}` : h.stage === 'delivered' ? 'Delivered: the buyer reviews' : stage.label}</span>
        <span className="hint">
          {h.price} {h.token} held by NEAR AI Agent Market · {m.teams.find((t) => t.agentMarket && h.team.endsWith(t.id))?.title ?? 'Agent Market'}
          {h.slaDeadlineAt && h.stage !== 'delivered' ? ` · due ${new Date(h.slaDeadlineAt).toLocaleString()}` : ''}
        </span>
        <div className="right">
          {h.runId && h.projectId && (
            <a className="btn sm" href={href('runs', h.projectId, h.runId)}>
              <IconPlay /> {h.stage === 'running' ? 'Watch the run' : 'Open the run'}
            </a>
          )}
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        {h.brief &&
          Object.entries(h.brief).map(([k, v]) => (
            <div key={k} className="col" style={{ gap: 2 }}>
              <span className="tiny faint">{k}</span>
              <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
                {v}
              </div>
            </div>
          ))}
        {!!h.files?.length && <div className="small muted">Files: {h.files.map((f) => `${f.name} (${(f.size / (1 << 20)).toFixed(1)} MB, ${f.field})`).join(', ')}</div>}
        {h.prechecks && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="tiny faint" title="Rules covibe enforces itself, before any model sees the job">
              Pre-checks
            </span>
            {h.prechecks.map((c) => (
              <span key={c.name} className={`pill ${c.ok ? 'good' : 'bad'}`} title={c.detail}>
                {c.ok ? <IconCheck /> : <IconX />} {c.name.replace('_', ' ')}
              </span>
            ))}
          </div>
        )}
        {failed.length > 0 && <div className="small">{failed.map((c) => c.detail).join('; ')}</div>}
        {h.intake && (
          <div className="banner info">
            <IconShield />
            <div className="col" style={{ gap: 4 }}>
              <div>
                <strong>The intake agent says {h.intake.decision === 'need_info' ? 'it needs more information' : h.intake.decision}</strong> · scope fit {h.intake.scope_fit.toFixed(2)}
              </div>
              <div>{h.intake.reason}</div>
              {h.intake.risks.length > 0 && <div className="small muted">Risks: {h.intake.risks.join('; ')}</div>}
            </div>
          </div>
        )}
        {h.note && (
          <div className="banner warn">
            <IconAlert /> {h.note}
          </div>
        )}
        {h.gates && h.gates.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="tiny faint">Gates</span>
            {h.gates.map((g) => (
              <span key={g.name} className={`pill ${g.passed ? 'good' : 'bad'}`}>
                {g.passed ? <IconCheck /> : <IconX />} {g.name}
              </span>
            ))}
            {h.costUsd !== undefined && <span className="tiny faint">run cost {money(h.costUsd)}</span>}
          </div>
        )}
        {h.revision && h.stage !== 'closed' && (
          <div className="small">
            <strong>Changes asked ({h.revision.n})</strong>: <span className="muted">{h.revision.note ?? h.revision.problem}</span>
          </div>
        )}
        {h.stage === 'delivered' && <div className="small muted">Submitted {h.delivery ? ago(h.delivery.at) : ''}. You are paid there when the buyer accepts, or when their acceptance window ends.</div>}
        {h.stage === 'awaiting_owner' && (
          <div className="row">
            <span className="small grow muted">
              {changes ? 'The buyer asks for changes beyond the revisions this storefront includes. Saying no submits the earlier delivery again.' : 'Taking the job declares it started; after that the buyer cannot cancel it. Declining refunds them.'}
            </span>
            <button className="btn" disabled={busy} onClick={() => (setReason(h.recommendation?.action === 'decline' ? h.recommendation.reason : ''), setAsk('decline'))}>
              {changes ? 'Turn it down' : 'Decline'}
            </button>
            <button className="btn primary" disabled={busy || (changes ? !h.revision?.note : !h.workspace)} onClick={() => void act('accept')}>
              <IconCheck /> {changes ? 'Take the changes' : 'Take the job'}
            </button>
          </div>
        )}
        {h.stage === 'needs_owner' && (
          <div className="row">
            <span className="grow" />
            <button className="btn" disabled={busy} onClick={() => (setReason(''), setAsk('fail'))}>
              Hand back and refund
            </button>
            <button className="btn primary" disabled={busy || !h.workspace} onClick={() => void act('retry')}>
              <IconLoop /> Run the team again
            </button>
          </div>
        )}
      </div>
      {ask && (
        <Modal title={ask === 'decline' ? (changes ? `Turn down the changes on ${h.key}` : `Decline ${h.key}`) : `Hand back ${h.key}`} onClose={() => setAsk(null)}>
          <div className="col" style={{ gap: 10 }}>
            <label className="field">
              Reason (the buyer reads it)
              <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <span className="grow" />
              <button className="btn" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void act(ask, reason.trim() || undefined)}>
                {ask === 'decline' ? (changes ? 'Turn it down' : 'Decline') : 'Hand back'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const teamName = (m: MarketView, o: LocalOrder) => m.teams.find((t) => t.listingId === o.listingId)?.title ?? m.listings.find((l) => l.listingId === o.listingId)?.listing?.title ?? `Listing ${o.listingId}`;

function OrderCard({ o, m, onChanged }: { o: LocalOrder; m: MarketView; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [ask, setAsk] = useState<null | 'decline' | 'fail'>(null);
  const [reason, setReason] = useState('');
  const revision = o.chain.status === 'REVISION_REQUESTED';
  const [act, busy] = useAction(async (what: 'accept' | 'decline' | 'fail' | 'retry', why?: string) => {
    await post(`/api/market/orders/${o.id}/${what}`, why ? { reason: why } : {});
    toast(revision && what === 'accept' ? `Revision of order #${o.id} taken: the team starts` : revision && what === 'decline' ? `Revision of order #${o.id} turned down; the delivery stands` : what === 'accept' ? `Order #${o.id} accepted: the team starts` : what === 'retry' ? 'The team runs again' : `Order #${o.id} ${what === 'decline' ? 'declined' : 'failed'}; the customer is refunded`);
    setAsk(null);
    await onChanged();
  });
  const stage = STAGE[o.stage];
  const failed = (o.prechecks ?? []).filter((c) => !c.ok);
  const rec = o.recommendation;
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          Order #{o.id} · {teamName(m, o)}
        </h2>
        <span className={`pill ${stage.tone}`}>{revision ? 'Revision asked: waits for you' : o.stage === 'running' && o.revisionRun ? `Team working on revision ${o.revisionRun}` : stage.label}</span>
        <span className="hint">
          {near(o.chain.price)} NEAR in escrow · from {o.chain.customer} · {ago(new Date(o.chain.created_at).toISOString())}
        </span>
        <div className="right">
          {o.runId && o.projectId && (
            <a className="btn sm" href={href('runs', o.projectId, o.runId)}>
              <IconPlay /> {o.stage === 'running' ? 'Watch the run' : 'Open the run'}
            </a>
          )}
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        {o.brief &&
          Object.entries(o.brief).map(([k, v]) => (
            <div key={k} className="col" style={{ gap: 2 }}>
              <span className="tiny faint">{k}</span>
              <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
                {v}
              </div>
            </div>
          ))}
        {!!o.files?.length && (
          <div className="small muted">
            Files: {o.files.map((f) => `${f.name} (${(f.size / (1 << 20)).toFixed(1)} MB, ${f.field})`).join(', ')}
          </div>
        )}
        {o.prechecks && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="tiny faint" title="Rules covibe enforces itself, before any model sees the order">
              Pre-checks
            </span>
            {o.prechecks.map((c) => (
              <span key={c.name} className={`pill ${c.ok ? 'good' : 'bad'}`} title={c.detail}>
                {c.ok ? <IconCheck /> : <IconX />} {c.name.replace('_', ' ')}
              </span>
            ))}
          </div>
        )}
        {failed.length > 0 && <div className="small">{failed.map((c) => c.detail).join('; ')}</div>}
        {o.intake && (
          <div className="banner info">
            <IconShield />
            <div className="col" style={{ gap: 4 }}>
              <div>
                <strong>The intake agent says {o.intake.decision === 'need_info' ? 'it needs more information' : o.intake.decision}</strong> · scope fit {o.intake.scope_fit.toFixed(2)}
                {o.intake.estimated_cost ? ` · effort: ${o.intake.estimated_cost}` : ''}
              </div>
              <div>{o.intake.reason}</div>
              {o.intake.risks.length > 0 && <div className="small muted">Risks: {o.intake.risks.join('; ')}</div>}
              {o.intakeRunId && o.projectId && (
                <a className="small" href={href('runs', o.projectId, o.intakeRunId)}>
                  See its answer
                </a>
              )}
            </div>
          </div>
        )}
        {o.note && (
          <div className="banner warn">
            <IconAlert /> {o.note}
          </div>
        )}
        {o.gates && o.gates.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="tiny faint">Gates</span>
            {o.gates.map((g) => (
              <span key={g.name} className={`pill ${g.passed ? 'good' : 'bad'}`}>
                {g.passed ? <IconCheck /> : <IconX />} {g.name}
              </span>
            ))}
            {o.costUsd !== undefined && <span className="tiny faint">run cost {money(o.costUsd)}</span>}
          </div>
        )}
        {o.stage === 'delivered' && (
          <div className="small muted">
            Delivered {o.chain.delivered_at ? ago(new Date(o.chain.delivered_at).toISOString()) : ''}. The customer can confirm or dispute; when their review window ends, covibe settles and you are paid.
            {o.txs.deliver && m.explorer.tx[o.txs.deliver] && (
              <>
                {' '}
                <a onClick={() => openUrl(m.explorer.tx[o.txs.deliver!]!)}>Delivery on the explorer</a>
              </>
            )}
          </div>
        )}
        {o.revision && (revision || (o.revisionRun ?? 0) > 0) && o.stage !== 'closed' && (
          <div className="small">
            <strong>Revision {o.revision.n}</strong>
            {(o.chain.revisions_included ?? 0) >= o.revision.n ? ' (included in the order, taken automatically)' : ''}: <span className="muted">{o.revision.note ?? o.revision.problem}</span>
          </div>
        )}
        {o.stage === 'awaiting_owner' && revision && (
          <div className="row">
            <span className="small grow muted">The customer asks for changes beyond the revisions this storefront includes. Saying no leaves the delivery as it is.</span>
            <button className="btn" disabled={busy} onClick={() => (setReason(''), setAsk('decline'))}>
              Turn it down
            </button>
            <button className="btn primary" disabled={busy || !o.revision?.note} title={o.revision?.note ? 'answer_revision on-chain, then the team runs again' : 'The note cannot be read'} onClick={() => void act('accept')}>
              <IconCheck /> Take the revision
            </button>
          </div>
        )}
        {o.stage === 'awaiting_owner' && !revision && (
          <div className="row">
            {rec && (
              <span className="small grow">
                Recommended: <strong>{rec.action}</strong>
                {rec.action === 'decline' ? ` (${rec.reason})` : ''}
              </span>
            )}
            {!rec && <span className="grow" />}
            <button className="btn" disabled={busy} onClick={() => (setReason(rec?.action === 'decline' ? rec.reason : ''), setAsk('decline'))}>
              Decline and refund
            </button>
            <button className="btn primary" disabled={busy || !o.workspace} title={o.workspace ? 'accept_order on-chain, then the team starts' : 'The order cannot be taken as it is'} onClick={() => void act('accept')}>
              <IconCheck /> Accept and start the team
            </button>
          </div>
        )}
        {o.stage === 'needs_owner' && (
          <div className="row">
            <span className="grow" />
            <button className="btn" disabled={busy} onClick={() => (setReason("The team's checks did not pass, so the order was not delivered."), setAsk('fail'))}>
              Fail and refund
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void act('retry')}>
              <IconLoop /> Run the team again
            </button>
          </div>
        )}
      </div>
      {ask && (
        <Modal
          title={revision ? `Turn down the revision of order #${o.id}` : ask === 'decline' ? `Decline order #${o.id}` : `Fail order #${o.id}`}
          onClose={() => setAsk(null)}
          footer={
            <>
              <button className="btn" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void act(ask, reason.trim())}>
                {revision ? 'Turn it down' : ask === 'decline' ? 'Decline and refund' : 'Fail and refund'}
              </button>
            </>
          }
        >
          <label className="field">
            Reason the customer reads (stored on-chain, 280 characters at most)
            <textarea className="input" rows={3} maxLength={280} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <p className="small muted">{revision ? `The delivery stands. ${o.chain.customer} gets a fresh review window to confirm or dispute it.` : `The ${near(o.chain.price)} NEAR in escrow go back to ${o.chain.customer} at once.`}</p>
        </Modal>
      )}
    </div>
  );
}

// ---- earnings

function EarningsTab({ m }: { m: MarketView }) {
  const e = m.earnings;
  const paid = m.orders.filter((o) => o.chain.status === 'SETTLED');
  const tile = (label: string, value: string, foot: string) => (
    <div className="card tile">
      <span className="label">
        <IconCoin />
        {label}
      </span>
      <span className="value">{value}</span>
      <span className="foot">{foot}</span>
    </div>
  );
  return (
    <>
      <div className="grid grid-3">
        {tile('Earned', `${near(e.earned)} NEAR`, `${e.settled} order${e.settled === 1 ? '' : 's'} paid · ${near(e.fees)} NEAR platform fee${m.feeBps !== undefined ? ` (${(m.feeBps / 100).toFixed(2)}%)` : ''}`)}
        {tile('In review', `${near(e.inReview)} NEAR`, 'Delivered; released when the customer confirms or their review window ends')}
        {tile('In escrow', `${near(e.inEscrow)} NEAR`, `Orders placed or being worked on · ${e.refunded} refunded so far`)}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Payouts</h2>
          <span className="hint">{m.balance !== undefined ? `${near(m.balance)} NEAR on ${m.settings.accountId}` : m.settings.accountId}</span>
          <div className="right">
            {m.explorer.account && (
              <button className="btn sm" onClick={() => openUrl(m.explorer.account!)}>
                Account on the NEAR explorer
              </button>
            )}
            {m.explorer.contract && (
              <button className="btn sm" onClick={() => openUrl(m.explorer.contract!)}>
                Contract
              </button>
            )}
          </div>
        </div>
        {paid.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Storefront</th>
                <th>Customer</th>
                <th className="r">Price</th>
                <th className="r">Fee</th>
                <th className="r">You received</th>
                <th className="r">Run cost</th>
                <th className="r">On NEAR</th>
              </tr>
            </thead>
            <tbody>
              {paid.map((o) => {
                const fee = (BigInt(o.chain.price) * BigInt(o.chain.fee_bps)) / 10000n;
                const link = o.txs.settle ?? o.txs.deliver;
                return (
                  <tr key={o.id}>
                    <td className="mono">#{o.id}</td>
                    <td>{teamName(m, o)}</td>
                    <td className="muted">{o.chain.customer}</td>
                    <td className="r mono">{near(o.chain.price)}</td>
                    <td className="r mono">{near(fee.toString())}</td>
                    <td className="r mono">{near((BigInt(o.chain.price) - fee).toString())}</td>
                    <td className="r mono">{o.costUsd !== undefined ? money(o.costUsd) : ''}</td>
                    <td className="r">{link && m.explorer.tx[link] ? <a onClick={() => openUrl(m.explorer.tx[link]!)}>{o.txs.settle ? 'Settlement' : 'Delivery'}</a> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={<IconCoin />} title="Nothing paid out yet">
            An order pays out when the customer confirms the delivery, or when their review window ends without a dispute.
          </Empty>
        )}
      </div>
    </>
  );
}

// ---- settings

function SettingsTab({ m, onChanged }: { m: MarketView; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState(m.settings);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<{ chain?: string; relay?: string; balance?: string; feeBps?: number } | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const check = async () => setStatus(await get('/api/market/status'));
  useEffect(() => {
    if (m.ready) void check();
  }, [m.ready]);
  const [save, saving] = useAction(async () => {
    await put('/api/market/settings', { ...form, ...(key.trim() ? { privateKey: key.trim() } : {}) });
    setKey('');
    toast('Market settings saved');
    await onChanged();
    await check();
  });
  const [forget] = useAction(async () => {
    await put('/api/market/settings', { privateKey: null });
    toast('The NEAR key was removed');
    await onChanged();
  });
  return (
    <>
    <AgentMarketCard m={m} onChanged={onChanged} />
    <div className="card">
      <div className="card-head">
        <h2>Connection</h2>
        <span className="hint">Where your listings and orders live</span>
      </div>
      <div className="card-pad col" style={{ gap: 14 }}>
        {status && (status.chain || status.relay) ? (
          <div className="banner bad">
            <IconAlert />
            <div className="col" style={{ gap: 2 }}>
              {status.chain && <div>NEAR: {status.chain}</div>}
              {status.relay && <div>Relay: {status.relay}</div>}
            </div>
          </div>
        ) : status ? (
          <div className="banner good">
            <IconCheck /> Connected: {near(status.balance)} NEAR on {m.settings.accountId}; the platform fee is {((status.feeBps ?? 0) / 100).toFixed(2)}%; the relay answers.
          </div>
        ) : null}
        <div className="grid grid-2">
          <label className="field">
            Network
            <select className="input" value={form.network} onChange={(e) => setForm((f) => ({ ...f, network: e.target.value as typeof f.network, ...(e.target.value === 'custom' ? {} : { rpcUrl: e.target.value === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com' }) }))}>
              <option value="testnet">NEAR testnet</option>
              <option value="mainnet">NEAR mainnet</option>
              <option value="custom">Custom RPC</option>
            </select>
          </label>
          <label className="field">
            RPC URL
            <input className="input" value={form.rpcUrl} onChange={(e) => set('rpcUrl', e.target.value)} disabled={form.network !== 'custom'} />
          </label>
          <label className="field">
            Market contract
            <input className="input" placeholder="covibe-market.testnet" value={form.contractId} onChange={(e) => set('contractId', e.target.value)} />
            <span className="help">The account the escrow contract is deployed to.</span>
          </label>
          <label className="field">
            Your NEAR account
            <input className="input" placeholder="you.testnet" value={form.accountId} onChange={(e) => set('accountId', e.target.value)} />
            <span className="help">Owns your listings and receives the payouts.</span>
          </label>
          <label className="field">
            Relay
            <input className="input" value={form.relayUrl} onChange={(e) => set('relayUrl', e.target.value)} />
            <span className="help">Carries encrypted order inputs, listing pages and delivery bundles. It holds no funds.</span>
          </label>
          <label className="field">
            Storefront address
            <input className="input" value={form.storefrontUrl} onChange={(e) => set('storefrontUrl', e.target.value)} />
            <span className="help">Where customers order; used for the links to your listings.</span>
          </label>
        </div>
        <label className="field">
          NEAR key of your account
          <input className="input mono" type="password" autoComplete="off" placeholder={m.publicKey ? 'Paste a new key to replace the one kept' : 'ed25519:…'} value={key} onChange={(e) => setKey(e.target.value)} />
          <span className="help">
            {m.publicKey ? (
              <>
                Kept in {m.secretStore === 'keychain' ? 'your Keychain' : "covibe's secrets file"}; public key <span className="mono">{m.publicKey}</span>. <a onClick={() => void forget()}>Remove it</a>
              </>
            ) : (
              <>Signs accept, decline and deliver, and the receipts. It is kept in {m.secretStore === 'keychain' ? 'your Keychain' : "covibe's secrets file"} and is never shown again. A key limited to the market contract is enough.</>
            )}
          </span>
        </label>
        <div className="row">
          <label className="check small">
            <input type="checkbox" checked={form.watch} onChange={(e) => set('watch', e.target.checked)} /> Watch for orders while covibe is open, every
          </label>
          <input className="input" style={{ width: 64 }} type="number" min={5} max={600} value={form.pollSeconds} onChange={(e) => set('pollSeconds', Number(e.target.value))} />
          <span className="small">seconds</span>
          <span className="grow" />
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

/** Connect a team to an agent on NEAR AI Agent Market, so its jobs come in as orders. */
function AgentMarketCard({ m, onChanged }: { m: MarketView; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const candidates = m.teams.filter((t) => t.hasStorefront && !t.problems.length && !t.agentMarket);
  const [team, setTeam] = useState('');
  const [token, setToken] = useState('');
  const chosen = team || candidates[0]?.id || '';
  const [connect, connecting] = useAction(async () => {
    await post(`/api/market/agent-market/${encodeURIComponent(chosen)}`, { token: token.trim() });
    setToken('');
    toast('Connected: the team takes the jobs of that agent');
    await onChanged();
  });
  const [disconnect] = useAction(async (id: string) => {
    await del(`/api/market/agent-market/${encodeURIComponent(id)}`);
    toast('Disconnected; the token was removed');
    await onChanged();
  });
  return (
    <div className="card">
      <div className="card-head">
        <h2>NEAR AI Agent Market</h2>
        <span className="hint">Take jobs from market.near.ai with a team that has a storefront</span>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <div className="small muted">
          Register an agent at market.near.ai and create a token for it (aat_…). covibe then picks up its jobs, screens them like orders, and submits only work that passed the team's gates; a job it does not take or cannot pass is handed back and the buyer
          refunded. You are paid there, when the buyer accepts. No NEAR account is needed for this.
        </div>
        {m.teams.filter((t) => t.agentMarket).map((t) => (
          <div key={t.id} className="row">
            <span className="pill good">
              <IconCheck /> {t.title ?? t.name}
            </span>
            <span className="small muted grow">takes the jobs of its agent{m.watching ? '' : ' while “Watch for orders” is on'}</span>
            <button className="btn sm" onClick={() => void disconnect(t.id)}>
              Disconnect
            </button>
          </div>
        ))}
        {candidates.length > 0 ? (
          <div className="row">
            <select className="input" style={{ width: 220 }} value={chosen} onChange={(e) => setTeam(e.target.value)}>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title ?? t.name}
                </option>
              ))}
            </select>
            <input className="input mono grow" type="password" autoComplete="off" placeholder="aat_… (the agent's token)" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="btn primary" disabled={connecting || !token.trim() || !chosen} onClick={() => void connect()}>
              Connect
            </button>
          </div>
        ) : (
          !m.teams.some((t) => t.agentMarket) && <div className="small muted">Give a team a storefront first (Storefronts): it says what the team takes, its spend cap, and which gates must pass.</div>
        )}
      </div>
    </div>
  );
}
