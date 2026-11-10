// The covibe market's storefront: browse listings, order with a NEAR wallet,
// follow the order, download and check the delivery, then confirm or dispute.
// Everything is read from the contract and the relay; there is no backend.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Chain, connectKey, connectWallet, explorer, near, restoreSession, type Session } from './chain';
import { generateAccessKey, generateSealKey, open, seal, sha256Hex, toBase64, utf8, verify } from './crypto';
import { loadKeys, Relay, saveKeys } from './relay';
import type { Config, InputField, Listing, ListingMeta, Order, OrderKeys, OrderStatus, Receipt } from './types';

interface Ctx {
  config: Config;
  chain: Chain;
  relay: Relay;
  session?: Session;
  signIn(): void;
}

const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
};

/** Load something, and again every `every` ms while the page is open. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[], every?: number) {
  const [value, setValue] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setValue(await loadRef.current());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    setValue(undefined);
    void reload();
    if (!every) return;
    const timer = setInterval(() => void reload(), every);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error, reload };
}

const duration = (seconds: number) => (seconds < 90 ? `${seconds} seconds` : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : seconds < 172800 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 86400)} days`);
const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function left(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

export function App() {
  const [config, setConfig] = useState<Config | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [session, setSession] = useState<Session | undefined>();
  const [signingIn, setSigningIn] = useState(false);
  const route = useHash();

  useEffect(() => {
    fetch('./config.json', { cache: 'no-store' })
      .then((r) => r.json() as Promise<Config>)
      .then(async (c) => {
        if (!c.contractId) throw new Error('No market contract is set. Put its account id into config.json (see the README).');
        setConfig(c);
        setSession(await restoreSession(c));
      })
      .catch((err) => setProblem((err as Error).message));
  }, []);

  const ctx = useMemo<Ctx | undefined>(() => (config ? { config, chain: new Chain(config), relay: new Relay(config), session, signIn: () => setSigningIn(true) } : undefined), [config, session]);

  let page: ReactNode = null;
  if (ctx) {
    if (route[0] === 'listing' && route[1]) page = <ListingPage ctx={ctx} id={Number(route[1])} />;
    else if (route[0] === 'order' && route[1]) page = <OrderPage ctx={ctx} id={Number(route[1])} />;
    else if (route[0] === 'orders') page = <OrdersPage ctx={ctx} />;
    else page = <Listings ctx={ctx} />;
  }

  return (
    <>
      <header className="top">
        <a className="brand" href="#/">
          <span className="mark">✓</span> covibe market
        </a>
        <nav>
          <a href="#/" className={!route[0] || route[0] === 'listing' ? 'on' : ''}>
            Teams
          </a>
          <a href="#/orders" className={route[0] === 'orders' || route[0] === 'order' ? 'on' : ''}>
            My orders
          </a>
        </nav>
        <div className="spacer" />
        {config && config.network !== 'mainnet' && <span className="tag">{config.network === 'testnet' ? 'NEAR testnet' : 'local chain'}</span>}
        {session ? (
          <button
            className="btn"
            title="Sign out"
            onClick={() => {
              void session.signOut().catch(() => undefined);
              setSession(undefined);
            }}
          >
            {session.accountId} · Sign out
          </button>
        ) : (
          config && (
            <button className="btn primary" onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          )
        )}
      </header>
      <main>
        {problem && <div className="note bad">{problem}</div>}
        {!problem && !ctx && <p className="muted">Loading…</p>}
        {page}
      </main>
      <footer className="foot">
        The price of an order is held by the market contract{config ? <> ({accountLink(config, config.contractId)})</> : null} and released to the team owner only after the team's own checks passed and you confirmed, or your review window ended. Otherwise you are refunded.
      </footer>
      {signingIn && config && (
        <SignIn
          config={config}
          onClose={() => setSigningIn(false)}
          onSession={(s) => {
            setSession(s);
            setSigningIn(false);
          }}
        />
      )}
    </>
  );
}

function accountLink(config: Config, account: string) {
  const url = explorer(config, 'account', account);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {account}
    </a>
  ) : (
    <span className="mono">{account}</span>
  );
}

function SignIn({ config, onClose, onSession }: { config: Config; onClose: () => void; onSession: (s: Session) => void }) {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState('');
  const [key, setKey] = useState('');
  const wallet = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSession(await connectWallet(config));
    } catch (err) {
      setError((err as Error).message || 'the wallet did not connect');
    } finally {
      setBusy(false);
    }
  };
  const withKey = () => {
    try {
      onSession(connectKey(config, account, key));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="veil" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Sign in">
        <h2>Sign in</h2>
        {config.network !== 'custom' && (
          <>
            <p className="muted">Use your NEAR wallet. You approve every payment in the wallet; this site never sees your keys.</p>
            <button className="btn primary wide" disabled={busy} onClick={() => void wallet()}>
              Connect a NEAR wallet
            </button>
          </>
        )}
        {config.network !== 'mainnet' && (
          <details open={config.network === 'custom'}>
            <summary>Use a developer key ({config.network === 'testnet' ? 'testnet' : 'local chain'} only)</summary>
            <p className="muted small">For demos and automated tests: sign with an account's key directly. It stays in this browser tab and is forgotten when the tab closes. Never paste a key that holds real funds.</p>
            <label>
              Account
              <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="you.testnet" name="dev-account" />
            </label>
            <label>
              Private key
              <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="ed25519:…" type="password" autoComplete="off" name="dev-key" />
            </label>
            <button className="btn wide" disabled={!account.trim() || !key.trim()} onClick={withKey}>
              Sign in with this key
            </button>
          </details>
        )}
        {error && <div className="note bad">{error}</div>}
      </div>
    </div>
  );
}

// ---- listings

function Stats({ l }: { l: Listing }) {
  const s = l.stats;
  const refunded = s.failed + s.expired;
  return (
    <span className="stats" title="Public record of this listing, kept by the contract">
      <span>{s.completed} delivered</span>
      {s.declined > 0 && <span>{s.declined} declined</span>}
      {refunded > 0 && <span>{refunded} refunded</span>}
      <span className={s.disputed ? 'warn' : ''}>{s.disputed} disputed</span>
    </span>
  );
}

function Listings({ ctx }: { ctx: Ctx }) {
  const { value, error } = useLoad(async () => (await ctx.chain.listings()).filter((l) => l.active).reverse(), [ctx.chain]);
  return (
    <>
      <section className="hero">
        <h1>Hire an AI team like you'd hire a studio.</h1>
        <p>Pick a team, send your brief, and pay into escrow. The owner is paid only if the team's own checks pass. If they don't, you get your NEAR back.</p>
      </section>
      {error && <div className="note bad">{error}</div>}
      {!value && !error && <p className="muted">Loading the teams…</p>}
      {value && !value.length && <p className="muted">No team takes orders right now.</p>}
      <div className="cards">
        {value?.map((l) => (
          <a key={l.id} className="card listing" href={`#/listing/${l.id}`}>
            <h3>{l.title}</h3>
            <p>{l.summary}</p>
            <div className="row">
              <strong className="price">{near(l.price)} NEAR</strong>
              <span className="spacer" />
              <Stats l={l} />
            </div>
            <div className="small muted">by {l.owner}</div>
          </a>
        ))}
      </div>
    </>
  );
}

interface FormState {
  text: Record<string, string>;
  files: Record<string, File[]>;
}

function ListingPage({ ctx, id }: { ctx: Ctx; id: number }) {
  const { value, error } = useLoad(async () => {
    const listing = await ctx.chain.listing(id);
    if (!listing) throw new Error('This listing does not exist.');
    return { listing, meta: await ctx.relay.meta(id, listing.meta_hash) };
  }, [id, ctx.chain]);
  if (error) return <div className="note bad">{error}</div>;
  if (!value) return <p className="muted">Loading…</p>;
  const { listing: l, meta } = value;
  return (
    <div className="split">
      <article>
        <a className="back" href="#/">
          ← All teams
        </a>
        <h1>{meta.title}</h1>
        <p className="lead">{meta.summary}</p>
        <div className="row facts">
          <span>by {accountLink(ctx.config, l.owner)}</span>
          <Stats l={l} />
        </div>
        {meta.description.split(/\n{2,}/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {meta.examples.length > 0 && <h2>Examples</h2>}
        {meta.examples.map((e, i) => (
          <figure key={i} className="example">
            {e.media && e.media_type?.startsWith('image/') && <img src={ctx.relay.mediaUrl(e.media)} alt={e.title} />}
            {e.media && e.media_type?.startsWith('video/') && <video src={ctx.relay.mediaUrl(e.media)} controls />}
            {e.media && !/^(image|video)\//.test(e.media_type ?? '') && (
              <a href={ctx.relay.mediaUrl(e.media)} target="_blank" rel="noreferrer">
                Open the example
              </a>
            )}
            <figcaption>
              <strong>{e.title}</strong>
              {e.text ? ` ${e.text}` : ''}
            </figcaption>
          </figure>
        ))}
        <h2>How an order goes</h2>
        <ol className="steps">
          <li>
            You pay <strong>{near(l.price)} NEAR</strong> into the market contract. Nobody can take it out yet.
          </li>
          <li>
            The owner answers within <strong>{duration(l.accept_window_s)}</strong>
            {meta.intake_mode === 'auto' ? ' (an intake agent screens orders and usually answers at once)' : meta.intake_mode === 'recommend' ? ' (an intake agent screens orders for them)' : ''}. A decline refunds you at once, with a reason.
          </li>
          <li>
            The team delivers within <strong>{duration(l.delivery_window_s)}</strong> of accepting, and only if its own checks pass. If not, or if nothing comes in time, you are refunded.
          </li>
          <li>
            You have <strong>{duration(l.review_window_s)}</strong> to download the result and confirm or dispute it. A dispute refunds you and counts against this listing in public. If you do nothing, the owner is paid when the time is up.
          </li>
        </ol>
      </article>
      <aside>
        {l.active ? <OrderForm ctx={ctx} listing={l} meta={meta} /> : <div className="note warn">This team takes no new orders right now.</div>}
      </aside>
    </div>
  );
}

function fieldProblem(def: InputField, state: FormState): string | undefined {
  if (def.type === 'text') {
    const text = state.text[def.name] ?? '';
    if (def.required && !text.trim()) return 'Please fill this in.';
    if (text.length > (def.max_chars ?? 5000)) return `At most ${def.max_chars ?? 5000} characters.`;
    return undefined;
  }
  const files = state.files[def.name] ?? [];
  if (def.required && !files.length) return 'Please add a file.';
  if (files.length > (def.max_files ?? 5)) return `At most ${def.max_files ?? 5} files.`;
  const bad = files.find((f) => def.accept && !def.accept.some((a) => f.name.toLowerCase().endsWith(a.toLowerCase())));
  return bad ? `${bad.name} is not one of ${def.accept!.join(', ')}.` : undefined;
}

function OrderForm({ ctx, listing, meta }: { ctx: Ctx; listing: Listing; meta: ListingMeta }) {
  const [state, setState] = useState<FormState>({ text: {}, files: {} });
  const [step, setStep] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [tried, setTried] = useState(false);
  const bytes = Object.values(state.files).flat().reduce((n, f) => n + f.size, 0);
  // base64 inside the encrypted input makes files a third larger.
  const tooBig = bytes * 1.37 > meta.max_input_mb * (1 << 20);
  const problems = Object.fromEntries(meta.inputs.map((d) => [d.name, fieldProblem(d, state)]));
  const valid = !tooBig && Object.values(problems).every((p) => !p);

  const submit = async () => {
    setTried(true);
    if (!valid) return;
    if (!ctx.session) return ctx.signIn();
    setError(undefined);
    try {
      setStep('Encrypting your order in this browser…');
      const keys: OrderKeys = { access: await generateAccessKey(), reply: await generateSealKey(), listingId: listing.id, createdAt: Date.now() };
      const files = [];
      for (const [field, list] of Object.entries(state.files)) for (const f of list) files.push({ field, name: f.name, type: f.type, data: toBase64(new Uint8Array(await f.arrayBuffer())) });
      const fields = Object.fromEntries(Object.entries(state.text).filter(([, v]) => v.trim()));
      const sealed = await seal(utf8(JSON.stringify({ v: 1, fields, files, reply_pubkey: keys.reply.publicKey })), listing.intake_pubkey);
      setStep('Uploading the encrypted order…');
      const hash = await ctx.relay.putInput(sealed);
      // Kept before the payment, so a wallet that reloads the page does not lose them.
      saveKeys(ctx.config, hash, keys);
      setStep(`Waiting for you to approve ${near(listing.price)} NEAR in your wallet…`);
      let id = await ctx.session.call('place_order', { listing_id: listing.id, input_hash: hash, access_key: keys.access.publicKey }, listing.price);
      if (typeof id !== 'number') id = (await ctx.chain.ordersOf(ctx.session.accountId)).reverse().find((o) => o.input_hash === hash)?.id;
      if (typeof id !== 'number') throw new Error('The payment went out, but the order does not show yet. Look under “My orders” in a moment.');
      location.hash = `#/order/${id}`;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStep(undefined);
    }
  };

  return (
    <form
      className="card order-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Order</h2>
      {meta.inputs.map((def) => (
        <label key={def.name}>
          <span>
            {def.label ?? def.name}
            {!def.required && <em> (optional)</em>}
          </span>
          {def.type === 'text' ? (
            <textarea name={def.name} rows={(def.max_chars ?? 5000) > 300 ? 6 : 2} value={state.text[def.name] ?? ''} maxLength={def.max_chars ?? 5000} onChange={(e) => setState((s) => ({ ...s, text: { ...s.text, [def.name]: e.target.value } }))} />
          ) : (
            <input name={def.name} type="file" multiple={(def.max_files ?? 5) > 1} accept={def.accept?.join(',')} onChange={(e) => setState((s) => ({ ...s, files: { ...s.files, [def.name]: [...(e.target.files ?? [])] } }))} />
          )}
          {def.help && <small>{def.help}</small>}
          {tried && problems[def.name] && <small className="bad">{problems[def.name]}</small>}
        </label>
      ))}
      {tooBig && <div className="note bad">The files are too large: this team takes {meta.max_input_mb} MB per order.</div>}
      <div className="note quiet">
        <strong>Who sees your order.</strong> {meta.privacy}
      </div>
      {error && <div className="note bad">{error}</div>}
      <button className="btn primary wide" disabled={!!step}>
        {step ?? (ctx.session ? `Pay ${near(listing.price)} NEAR into escrow and order` : `Sign in to order for ${near(listing.price)} NEAR`)}
      </button>
      <small className="muted">The keys to your delivery are kept in this browser. Use the same browser to download it.</small>
    </form>
  );
}

// ---- orders

const STATUS: Record<OrderStatus, { label: string; tone: string; text: string }> = {
  PLACED: { label: 'Waiting for the owner', tone: 'info', text: 'Your payment is in escrow. The owner has not answered yet.' },
  ACCEPTED: { label: 'The team is working', tone: 'info', text: 'The owner took your order. The price stays in escrow until the result is delivered and reviewed.' },
  DELIVERED: { label: 'Delivered: your review', tone: 'good', text: "The team's checks passed and the result is ready. Download it, then confirm or dispute." },
  SETTLED: { label: 'Completed', tone: 'good', text: 'The order is complete and the owner was paid.' },
  DECLINED: { label: 'Declined, refunded', tone: '', text: 'The owner turned this order down. Your NEAR is back in your account.' },
  FAILED: { label: 'Not delivered, refunded', tone: 'bad', text: 'The team could not complete this order. Your NEAR is back in your account.' },
  EXPIRED: { label: 'Expired, refunded', tone: 'bad', text: 'The owner did not answer or deliver in time. Your NEAR is back in your account.' },
  DISPUTED: { label: 'Disputed, refunded', tone: 'bad', text: 'You disputed the delivery. Your NEAR is back in your account and the dispute is on the listing’s public record.' },
};

function OrdersPage({ ctx }: { ctx: Ctx }) {
  const account = ctx.session?.accountId;
  const { value, error } = useLoad(async () => (account ? (await ctx.chain.ordersOf(account)).reverse() : []), [account, ctx.chain], 8000);
  if (!account)
    return (
      <div className="empty">
        <p>Sign in to see your orders.</p>
        <button className="btn primary" onClick={ctx.signIn}>
          Sign in
        </button>
      </div>
    );
  return (
    <>
      <h1>My orders</h1>
      {error && <div className="note bad">{error}</div>}
      {value && !value.length && (
        <p className="muted">
          You have not ordered anything yet. <a href="#/">See the teams.</a>
        </p>
      )}
      <div className="list">
        {value?.map((o) => (
          <a key={o.id} className="card rowcard" href={`#/order/${o.id}`}>
            <strong>Order #{o.id}</strong>
            <span className={`pill ${STATUS[o.status].tone}`}>{STATUS[o.status].label}</span>
            <span className="spacer" />
            <span className="muted">{when(o.created_at)}</span>
            <strong>{near(o.price)} NEAR</strong>
          </a>
        ))}
      </div>
    </>
  );
}

interface Checked {
  receipt: Receipt;
  hashOk: boolean;
  signatureOk: boolean;
  ownerKey: boolean;
  matchesOrder: boolean;
}

function OrderPage({ ctx, id }: { ctx: Ctx; id: number }) {
  const { value, error, reload } = useLoad(async () => {
    const order = await ctx.chain.order(id);
    if (!order) throw new Error('This order does not exist.');
    const listing = await ctx.chain.listing(order.listing_id);
    const keys = loadKeys(ctx.config, order.input_hash);
    const feed = keys ? await ctx.relay.status(id, keys).catch(() => []) : [];
    return { order, listing: listing!, keys, feed };
  }, [id, ctx.chain], 5000);
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const [download, setDownload] = useState<string | undefined>();
  const [checked, setChecked] = useState<Checked | undefined>();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const order = value?.order;
  // The signed receipt, checked against the chain: its hash, its signature, and that the key is the owner's.
  useEffect(() => {
    if (!order?.receipt_hash) return setChecked(undefined);
    let cancelled = false;
    void (async () => {
      const got = await ctx.relay.receipt(order.id);
      if (!got || cancelled) return;
      const { signature, ...body } = got.receipt;
      const result: Checked = {
        receipt: got.receipt,
        hashOk: (await sha256Hex(utf8(got.text))) === order.receipt_hash,
        signatureOk: !!signature && (await verify(got.receipt.public_key, JSON.stringify(body), signature)),
        ownerKey: await ctx.chain.hasKey(order.owner, got.receipt.public_key),
        matchesOrder: got.receipt.order_id === order.id && got.receipt.bundle_hash === order.bundle_hash && got.receipt.input_hash === order.input_hash,
      };
      if (!cancelled) setChecked(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [order?.id, order?.receipt_hash, order?.bundle_hash, order?.input_hash, order?.owner, ctx.relay, ctx.chain]);

  if (error && !value) return <div className="note bad">{error}</div>;
  if (!value || !order) return <p className="muted">Loading…</p>;
  const { listing, keys, feed } = value;
  const mine = ctx.session?.accountId === order.customer;
  const status = STATUS[order.status];
  const acceptBy = order.created_at + listing.accept_window_s * 1000;
  const deliverBy = (order.accepted_at ?? 0) + listing.delivery_window_s * 1000;
  const reviewBy = (order.delivered_at ?? 0) + listing.review_window_s * 1000;
  const overdue = (order.status === 'PLACED' && Date.now() > acceptBy) || (order.status === 'ACCEPTED' && Date.now() > deliverBy);
  const reviewOpen = order.status === 'DELIVERED' && Date.now() <= reviewBy;

  const act = async (label: string, method: string, args: Record<string, unknown>) => {
    if (!ctx.session) return ctx.signIn();
    setBusy(label);
    setActionError(undefined);
    try {
      await ctx.session.call(method, args);
      setDisputing(false);
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const fetchBundle = async () => {
    if (!keys) return;
    setBusy('download');
    setActionError(undefined);
    try {
      const sealed = await ctx.relay.bundle(order.id, keys);
      if ((await sha256Hex(sealed)) !== order.bundle_hash) throw new Error('The bundle in the relay does not match the hash the owner put on-chain. Do not confirm; dispute instead.');
      const zip = sealed[0] === 0x50 && sealed[1] === 0x4b ? sealed : await open(sealed, keys.reply.privateJwk);
      const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `order-${order.id}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownload(`Downloaded order-${order.id}.zip (${zip.length < 10240 ? `${zip.length} bytes` : `${(zip.length / 1024).toFixed(0)} KB`}). It matches the hash on-chain.`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="order">
      <a className="back" href="#/orders">
        ← My orders
      </a>
      <div className="row">
        <h1>Order #{order.id}</h1>
        <span className={`pill ${status.tone}`}>{status.label}</span>
      </div>
      <p className="lead">{status.text}</p>
      {order.reason && (
        <div className="note quiet">
          <strong>{order.status === 'DISPUTED' ? 'Your reason' : 'Reason'}:</strong> {order.reason}
        </div>
      )}
      <dl className="facts-grid">
        <dt>Team</dt>
        <dd>
          <a href={`#/listing/${listing.id}`}>{listing.title}</a> by {accountLink(ctx.config, order.owner)}
        </dd>
        <dt>In escrow</dt>
        <dd>
          {near(order.price)} NEAR {['PLACED', 'ACCEPTED', 'DELIVERED'].includes(order.status) ? 'held by the contract' : order.status === 'SETTLED' ? 'paid to the owner' : 'refunded to you'}
        </dd>
        <dt>Ordered</dt>
        <dd>{when(order.created_at)}</dd>
        {order.status === 'PLACED' && (
          <>
            <dt>Owner's answer</dt>
            <dd>{overdue ? 'The time to answer is over.' : `due in ${left(acceptBy)} (by ${when(acceptBy)})`}</dd>
          </>
        )}
        {order.status === 'ACCEPTED' && (
          <>
            <dt>Delivery</dt>
            <dd>{overdue ? 'The time to deliver is over.' : `due in ${left(deliverBy)} (by ${when(deliverBy)})`}</dd>
          </>
        )}
        {order.status === 'DELIVERED' && (
          <>
            <dt>Your review</dt>
            <dd>{reviewOpen ? `${left(reviewBy)} left (until ${when(reviewBy)}); after that the owner is paid` : 'The review window is over; the order can be settled.'}</dd>
          </>
        )}
      </dl>

      {feed.length > 0 && (
        <section>
          <h2>Progress</h2>
          <ul className="feed">
            {feed.map((f, i) => (
              <li key={i} className={f.state}>
                <time>{new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> {f.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {order.receipt_hash && (
        <section className="card receipt">
          <h2>Delivery</h2>
          {checked ? (
            <>
              <ul className="checks">
                {checked.receipt.gates.map((g) => (
                  <li key={g.name} className={g.passed ? 'ok' : 'no'}>
                    The team's check “{g.name}” {g.passed ? 'passed' : 'did not pass'}
                  </li>
                ))}
                <li className={checked.hashOk && checked.matchesOrder ? 'ok' : 'no'}>{checked.hashOk && checked.matchesOrder ? 'The receipt is the one recorded on-chain for this order' : 'The receipt does not match what is recorded on-chain'}</li>
                <li className={checked.signatureOk && checked.ownerKey ? 'ok' : 'no'}>{checked.signatureOk && checked.ownerKey ? `Signed by ${order.owner}` : checked.signatureOk ? 'Signed, but not with a key of the owner’s account' : 'The signature is missing or wrong'}</li>
              </ul>
              <p className="small muted">
                Run finished {when(Date.parse(checked.receipt.finished))}. The receipt is the owner's signed statement; the full log stays with the owner (hash <span className="mono">{checked.receipt.event_log_hash.slice(0, 12)}…</span>).
              </p>
            </>
          ) : (
            <p className="muted">Checking the receipt…</p>
          )}
          {keys ? (
            <button className="btn primary" disabled={busy === 'download'} onClick={() => void fetchBundle()}>
              {busy === 'download' ? 'Downloading and checking…' : 'Download the result'}
            </button>
          ) : (
            <div className="note warn">The keys for this order are not in this browser, so the result cannot be opened here. Open this page in the browser you ordered with.</div>
          )}
          {download && <div className="note good">{download}</div>}
        </section>
      )}

      {actionError && <div className="note bad">{actionError}</div>}
      <div className="actions">
        {order.status === 'DELIVERED' && mine && (
          <>
            <button className="btn primary" disabled={!!busy} onClick={() => void act('confirm', 'confirm_order', { order_id: order.id })}>
              {busy === 'confirm' ? 'Confirming…' : 'Confirm and pay the owner'}
            </button>
            {reviewOpen && (
              <button className="btn" disabled={!!busy} onClick={() => setDisputing(true)}>
                Dispute
              </button>
            )}
          </>
        )}
        {order.status === 'DELIVERED' && !reviewOpen && !mine && (
          <button className="btn" disabled={!!busy} onClick={() => void act('settle', 'settle_order', { order_id: order.id })}>
            Settle the order
          </button>
        )}
        {overdue && (
          <button className="btn primary" disabled={!!busy} onClick={() => void act('expire', 'expire_order', { order_id: order.id })}>
            {busy === 'expire' ? 'Refunding…' : 'Get the refund now'}
          </button>
        )}
        {order.status === 'DELIVERED' && !mine && ctx.session && <span className="muted small">Sign in as {order.customer} to confirm or dispute.</span>}
        {!ctx.session && ['PLACED', 'ACCEPTED', 'DELIVERED'].includes(order.status) && (
          <button className="btn" onClick={ctx.signIn}>
            Sign in to act on this order
          </button>
        )}
      </div>

      {disputing && (
        <div className="veil" onClick={() => setDisputing(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Dispute">
            <h2>Dispute this delivery</h2>
            <p className="muted">You get the {near(order.price)} NEAR back and the dispute is counted on the listing's public record. Say what is wrong; the reason is stored on-chain.</p>
            <label>
              Reason
              <textarea rows={3} maxLength={280} value={reason} onChange={(e) => setReason(e.target.value)} name="reason" />
            </label>
            <div className="row">
              <span className="spacer" />
              <button className="btn" onClick={() => setDisputing(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!!busy || !reason.trim()} onClick={() => void act('dispute', 'dispute_order', { order_id: order.id, reason: reason.trim() })}>
                {busy === 'dispute' ? 'Disputing…' : 'Dispute and get the refund'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

