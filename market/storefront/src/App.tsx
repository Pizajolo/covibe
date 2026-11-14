// The covibe market's storefront: browse listings, order with a NEAR wallet,
// follow the order, download and check the delivery, then confirm or dispute.
// Everything is read from the contract and the relay; there is no backend.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Chain, connectKey, connectWallet, explorer, near, restoreSession, type Session } from './chain';
import { generateAccessKey, generateSealKey, open, seal, sha256Hex, utf8, verify } from './crypto';
import { Docs } from './Docs';
import { Landing } from './Landing';
import { fetchFile, fileSize, save, sendFile, ZIP_LIMIT, zipFiles } from './files';
import { loadKeys, Relay, saveKeys } from './relay';
import type { Config, Delivery, InputField, Listing, ListingMeta, Order, OrderKeys, OrderStatus, Receipt, Review } from './types';

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

  const landing = !route[0] || route[0] === 'download';
  const docs = route[0] === 'docs';
  let page: ReactNode = null;
  if (ctx && !landing && !docs) {
    if (route[0] === 'listing' && route[1]) page = <ListingPage ctx={ctx} id={Number(route[1])} />;
    else if (route[0] === 'order' && route[1]) page = <OrderPage ctx={ctx} id={Number(route[1])} />;
    else if (route[0] === 'orders') page = <OrdersPage ctx={ctx} />;
    else page = <Listings ctx={ctx} />;
  }

  return (
    <>
      <header className="top">
        <a className="brand" href="#/">
          <span className="mark">✓</span> covibe
        </a>
        <nav>
          <a href="#/market" className={route[0] === 'market' || route[0] === 'listing' ? 'on' : ''}>
            Marketplace
          </a>
          <a href="#/docs" className={docs ? 'on' : ''}>
            Docs
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
      {landing ? (
        <Landing network={config?.network} section={route[0]} />
      ) : docs ? (
        <Docs section={route[1]} />
      ) : (
        <main>
          {problem && <div className="note bad">{problem}</div>}
          {!problem && !ctx && <p className="muted">Loading…</p>}
          {page}
        </main>
      )}
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

/** One to five stars, read out as a number. */
function Stars({ n }: { n: number }) {
  const full = Math.round(n);
  return (
    <span className="stars" role="img" aria-label={`${n.toFixed(1).replace(/\.0$/, '')} of 5 stars`}>
      {'★'.repeat(full)}
      <span className="off">{'★'.repeat(5 - full)}</span>
    </span>
  );
}

function Stats({ l }: { l: Listing }) {
  const s = l.stats;
  const refunded = s.failed + s.expired;
  const average = l.rating_count ? (l.rating_sum ?? 0) / l.rating_count : undefined;
  return (
    <span className="stats" title="Public record of this listing, kept by the contract">
      {average !== undefined && (
        <span className="rating">
          <Stars n={average} /> {average.toFixed(1)} ({l.rating_count})
        </span>
      )}
      <span>{s.completed} delivered</span>
      {s.declined > 0 && <span>{s.declined} declined</span>}
      {refunded > 0 && <span>{refunded} refunded</span>}
      <span className={s.disputed ? 'warn' : ''}>{s.disputed} disputed</span>
    </span>
  );
}

function Listings({ ctx }: { ctx: Ctx }) {
  const { value, error } = useLoad(async () => {
    const listings = (await ctx.chain.listings()).filter((l) => l.active).reverse();
    // Each listing's page, for its picture: the first example that is an image or a video.
    return Promise.all(
      listings.map(async (l) => {
        const meta = await ctx.relay.meta(l.id, l.meta_hash).catch(() => undefined);
        return { l, cover: meta?.examples.find((e) => e.media && /^(image|video)\//.test(e.media_type ?? '')) };
      }),
    );
  }, [ctx.chain]);
  return (
    <>
      <section className="hero">
        <h1>Teams taking orders</h1>
        <p>
          Pick a team, send your brief, and pay into escrow. The owner is paid only if the team's own checks pass. <a href="#/">How it works</a>
        </p>
      </section>
      {error && <div className="note bad">{error}</div>}
      {!value && !error && <p className="muted">Loading the teams…</p>}
      {value && !value.length && <p className="muted">No team takes orders right now.</p>}
      <div className="cards">
        {value?.map(({ l, cover }) => (
          <a key={l.id} className="card listing" href={`#/listing/${l.id}`}>
            {cover?.media_type?.startsWith('image/') && <img className="cover" src={ctx.relay.mediaUrl(cover.media!)} alt="" loading="lazy" />}
            {cover?.media_type?.startsWith('video/') && <video className="cover" src={`${ctx.relay.mediaUrl(cover.media!)}#t=0.1`} muted playsInline preload="metadata" />}
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
    // A contract from before reviews has no such method: the page then shows none.
    const reviews = await ctx.chain.reviews(id).catch(() => [] as Review[]);
    return { listing, meta: await ctx.relay.meta(id, listing.meta_hash), reviews: reviews.reverse() };
  }, [id, ctx.chain]);
  if (error) return <div className="note bad">{error}</div>;
  if (!value) return <p className="muted">Loading…</p>;
  const { listing: l, meta, reviews } = value;
  const included = l.revisions ?? 0;
  return (
    <div className="split">
      <article>
        <a className="back" href="#/market">
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
            {e.media && e.media_type?.startsWith('video/') && <video src={`${ctx.relay.mediaUrl(e.media)}#t=0.1`} controls playsInline preload="metadata" />}
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
          <li>
            Not quite right? Ask for a revision in that time.{' '}
            {included > 0 ? (
              <>
                <strong>{included === 1 ? 'One revision is' : `${included} revisions are`} included</strong>: the team goes back to work at once. Further ones need the owner's yes.
              </>
            ) : (
              "The owner decides whether the team takes it; if not, the delivery stands and you can still confirm or dispute."
            )}
          </li>
        </ol>
        <h2>Reviews</h2>
        {reviews.length === 0 && <p className="muted">No reviews yet. Only customers whose order was delivered can write one.</p>}
        <ul className="reviews">
          {reviews.map((r) => (
            <li key={r.order_id}>
              <div className="row">
                <Stars n={r.stars} />
                <span className="muted small">
                  {accountLink(ctx.config, r.customer)}, {when(r.created_at)}
                </span>
              </div>
              {r.comment && <p>{r.comment}</p>}
            </li>
          ))}
        </ul>
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
  const [progress, setProgress] = useState<number | undefined>();
  const bytes = Object.values(state.files).flat().reduce((n, f) => n + f.size, 0);
  const tooBig = bytes > meta.max_input_mb * (1 << 20);
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
      // Each file goes up in encrypted pieces, so footage of any size the team takes can be sent.
      const files = [];
      let done = 0;
      for (const [field, list] of Object.entries(state.files)) {
        for (const f of list) {
          setStep(`Encrypting and uploading ${f.name}…`);
          files.push({ field, name: f.name, type: f.type, ...(await sendFile(ctx.relay, f, (sent) => setProgress((done + sent) / Math.max(1, bytes)))) });
          done += f.size;
        }
      }
      setProgress(undefined);
      setStep('Encrypting your order in this browser…');
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
      setProgress(undefined);
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
      {meta.inputs.map((def) => {
        const body = (
          <>
            <span>
              {def.label ?? def.name}
              {!def.required && <em> (optional)</em>}
            </span>
            {def.type === 'text' ? (
              <textarea name={def.name} rows={(def.max_chars ?? 5000) > 300 ? 6 : 2} value={state.text[def.name] ?? ''} maxLength={def.max_chars ?? 5000} onChange={(e) => setState((s) => ({ ...s, text: { ...s.text, [def.name]: e.target.value } }))} />
            ) : (
              <FilePicker def={def} files={state.files[def.name] ?? []} disabled={!!step} onChange={(files) => setState((s) => ({ ...s, files: { ...s.files, [def.name]: files } }))} />
            )}
            {def.help && <small>{def.help}</small>}
            {tried && problems[def.name] && <small className="bad">{problems[def.name]}</small>}
          </>
        );
        // A label would hand every click on the chosen files to the file dialog.
        return def.type === 'text' ? <label key={def.name}>{body}</label> : <div key={def.name} className="field">{body}</div>;
      })}
      {tooBig && (
        <div className="note bad">
          The files are too large ({fileSize(bytes)}): this team takes {fileSize(meta.max_input_mb * (1 << 20))} per order.
        </div>
      )}
      <div className="note quiet">
        <strong>Who sees your order.</strong> {meta.privacy}
      </div>
      {error && <div className="note bad">{error}</div>}
      {progress !== undefined && <progress value={progress} max={1} aria-label="Upload progress" />}
      <button className="btn primary wide" disabled={!!step}>
        {step ?? (ctx.session ? `Pay ${near(listing.price)} NEAR into escrow and order` : `Sign in to order for ${near(listing.price)} NEAR`)}
      </button>
      <small className="muted">The keys to your delivery are kept in this browser. Use the same browser to download it.</small>
    </form>
  );
}

/** Choose the files of one field: drop them or pick them; each shows with its size and can be taken out again. */
function FilePicker({ def, files, disabled, onChange }: { def: InputField; files: File[]; disabled: boolean; onChange: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const max = def.max_files ?? 5;
  const add = (list: FileList | null) => {
    const next = max > 1 ? [...files, ...(list ?? [])].filter((f, i, all) => all.findIndex((x) => x.name === f.name && x.size === f.size) === i) : [...(list ?? [])].slice(0, 1);
    onChange(next);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="files">
      <div
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) add(e.dataTransfer.files);
        }}
      >
        <input ref={input} name={def.name} type="file" hidden multiple={max > 1} accept={def.accept?.join(',')} onChange={(e) => add(e.target.files)} />
        <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()}>
          {files.length && max > 1 ? 'Add more files' : files.length ? 'Choose another file' : max > 1 ? 'Choose files' : 'Choose a file'}
        </button>
        <span className="muted small">
          or drop {max > 1 ? `up to ${max} files` : 'a file'} here{def.accept ? ` (${def.accept.join(', ')})` : ''}
        </span>
      </div>
      {files.map((f) => (
        <div key={`${f.name}:${f.size}`} className="file">
          <span className="name">{f.name}</span>
          <span className="muted small">{fileSize(f.size)}</span>
          <button type="button" className="x" disabled={disabled} aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((x) => x !== f))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- orders

const STATUS: Record<OrderStatus, { label: string; tone: string; text: string }> = {
  REVISION_REQUESTED: { label: 'Revision asked: waiting for the owner', tone: 'info', text: 'You asked for a revision. The owner decides whether the team takes it. Until then you can still confirm or dispute the delivery you have.' },
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
          You have not ordered anything yet. <a href="#/market">See the teams.</a>
        </p>
      )}
      <div className="list">
        {value?.map((o) => (
          <a key={o.id} className="card rowcard" href={`#/order/${o.id}`}>
            <strong>Order #{o.id}</strong>
            <span className={`pill ${STATUS[o.status].tone}`}>{o.status === 'ACCEPTED' && o.revisions_used ? 'In revision' : STATUS[o.status].label}</span>
            {o.review && <Stars n={o.review.stars} />}
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
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [download, setDownload] = useState<string | undefined>();
  const [delivery, setDelivery] = useState<Delivery | undefined>();
  const [checked, setChecked] = useState<Checked | undefined>();
  const [, tick] = useState(0);
  // A revision replaces the delivery: forget the one that was opened.
  const bundleHash = value?.order.bundle_hash;
  useEffect(() => {
    setDelivery(undefined);
    setDownload(undefined);
  }, [bundleHash]);
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
  const inRevision = order.status === 'ACCEPTED' && (order.revisions_used ?? 0) > 0;
  const status = inRevision ? { label: 'In revision', tone: 'info', text: `The team is working on your revision (${order.revisions_used}). The delivery you have stays yours to confirm or dispute if the revision cannot be completed.` } : STATUS[order.status];
  const revisionsLeft = Math.max(0, (order.revisions_included ?? 0) - (order.revisions_used ?? 0));
  const requestWaiting = order.status === 'REVISION_REQUESTED';
  const answerBy = (order.revision_requested_at ?? 0) + listing.accept_window_s * 1000;
  const canReview = mine && !!order.closed_at && !!order.delivered_at && !order.review;
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
      setRevising(false);
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  /** Fetch the bundle, check it against the hash on-chain and open it: the list of delivered files. */
  const fetchBundle = async () => {
    if (!keys) return;
    setBusy('download');
    setActionError(undefined);
    try {
      const sealed = await ctx.relay.bundle(order.id, keys);
      if ((await sha256Hex(sealed)) !== order.bundle_hash) throw new Error('The bundle in the relay does not match the hash the owner put on-chain. Do not confirm; dispute instead.');
      const plain = sealed[0] === 0x43 && sealed[1] === 0x56 && sealed[2] === 0x42 && sealed[3] === 0x31 ? await open(sealed, keys.reply.privateJwk) : sealed;
      // Deliveries made before files travelled in pieces are one zip.
      if (plain[0] === 0x50 && plain[1] === 0x4b) {
        save(new Blob([plain], { type: 'application/zip' }), `order-${order.id}.zip`);
        setDownload(`Downloaded order-${order.id}.zip (${fileSize(plain.length)}). It matches the hash on-chain.`);
        return;
      }
      const d = JSON.parse(new TextDecoder().decode(plain)) as Delivery;
      if (d.v !== 2 || !Array.isArray(d.files)) throw new Error('This delivery is in a format this page does not know.');
      setDelivery(d);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  /** Ask for a revision: the note is encrypted to the team like the order was, and only its hash goes on-chain. */
  const requestRevision = async () => {
    if (!ctx.session) return ctx.signIn();
    setBusy('revision');
    setActionError(undefined);
    try {
      const hash = await ctx.relay.putBlob(await seal(utf8(JSON.stringify({ v: 1, note: note.trim() })), listing.intake_pubkey));
      await ctx.session.call('request_revision', { order_id: order.id, note_hash: hash });
      setRevising(false);
      setNote('');
      // The delivery shown is about to be replaced.
      setDelivery(undefined);
      setDownload(undefined);
      await reload();
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
          {near(order.price)} NEAR {['PLACED', 'ACCEPTED', 'DELIVERED', 'REVISION_REQUESTED'].includes(order.status) ? 'held by the contract' : order.status === 'SETTLED' ? 'paid to the owner' : 'refunded to you'}
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
        {requestWaiting && (
          <>
            <dt>Owner's answer</dt>
            <dd>{Date.now() > answerBy ? 'The owner did not answer in time. You can stop waiting; the delivery stands and your review time starts again.' : `due in ${left(answerBy)} (by ${when(answerBy)})`}</dd>
          </>
        )}
        {(order.revisions_included ?? 0) > 0 && (
          <>
            <dt>Revisions</dt>
            <dd>
              {order.revisions_used ?? 0} used, {revisionsLeft} of {order.revisions_included} included left
            </dd>
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
              {checked.receipt.attestation && (
                <p className="small muted">
                  {checked.receipt.attestation.calls.filter((c) => c.verified).length} of {checked.receipt.attestation.calls.length} model calls behind this order ran in a hardware enclave at {checked.receipt.attestation.provider} and carry
                  its signature, which the owner's covibe checked. The receipt holds the signatures and the hardware quotes; this page does not re-check them, and the quotes can be verified with Intel's tools.
                </p>
              )}
              <p className="small muted">
                Run finished {when(Date.parse(checked.receipt.finished))}. The receipt is the owner's signed statement; the full log stays with the owner (hash <span className="mono">{checked.receipt.event_log_hash.slice(0, 12)}…</span>).
              </p>
            </>
          ) : (
            <p className="muted">Checking the receipt…</p>
          )}
          {delivery ? (
            <DeliveryFiles relay={ctx.relay} delivery={delivery} orderId={order.id} />
          ) : keys ? (
            <button className="btn primary" disabled={busy === 'download'} onClick={() => void fetchBundle()}>
              {busy === 'download' ? 'Opening and checking…' : 'Open the result'}
            </button>
          ) : (
            <div className="note warn">The keys for this order are not in this browser, so the result cannot be opened here. Open this page in the browser you ordered with.</div>
          )}
          {download && <div className="note good">{download}</div>}
        </section>
      )}

      {actionError && <div className="note bad">{actionError}</div>}
      <div className="actions">
        {(order.status === 'DELIVERED' || requestWaiting) && mine && (
          <>
            <button className="btn primary" disabled={!!busy} onClick={() => void act('confirm', 'confirm_order', { order_id: order.id })}>
              {busy === 'confirm' ? 'Confirming…' : 'Confirm and pay the owner'}
            </button>
            {reviewOpen && (
              <button className="btn" disabled={!!busy} onClick={() => setRevising(true)}>
                Ask for a revision
              </button>
            )}
            {(reviewOpen || requestWaiting) && (
              <button className="btn" disabled={!!busy} onClick={() => setDisputing(true)}>
                Dispute
              </button>
            )}
          </>
        )}
        {requestWaiting && Date.now() > answerBy && (
          <button className="btn" disabled={!!busy} onClick={() => void act('expire', 'expire_order', { order_id: order.id })}>
            {busy === 'expire' ? 'One moment…' : 'Stop waiting for the owner'}
          </button>
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
        {!ctx.session && ['PLACED', 'ACCEPTED', 'DELIVERED', 'REVISION_REQUESTED'].includes(order.status) && (
          <button className="btn" onClick={ctx.signIn}>
            Sign in to act on this order
          </button>
        )}
      </div>

      {order.review && (
        <section className="card review">
          <h2>{mine ? 'Your review' : 'Review'}</h2>
          <Stars n={order.review.stars} />
          {order.review.comment && <p>{order.review.comment}</p>}
        </section>
      )}
      {canReview && (
        <section className="card review">
          <h2>Rate this order</h2>
          <p className="muted">Your stars and comment appear on the team's page under your account name. A review is stored on-chain and cannot be changed.</p>
          <div className="star-pick" role="radiogroup" aria-label="Stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} of 5 stars`} className={n <= stars ? 'on' : ''} onClick={() => setStars(n)}>
                ★
              </button>
            ))}
          </div>
          <label>
            Comment <em>(optional)</em>
            <textarea rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} name="comment" />
          </label>
          <div className="row">
            <button className="btn primary" disabled={!!busy || !stars} onClick={() => void act('review', 'review_order', { order_id: order.id, stars, comment: comment.trim() || null })}>
              {busy === 'review' ? 'Publishing…' : 'Publish the review'}
            </button>
            {!stars && <span className="muted small">Choose one to five stars.</span>}
          </div>
        </section>
      )}

      {revising && (
        <div className="veil" onClick={() => setRevising(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ask for a revision">
            <h2>Ask for a revision</h2>
            <p className="muted">
              {revisionsLeft > 0
                ? `This order includes ${revisionsLeft === 1 ? 'one more revision' : `${revisionsLeft} more revisions`}: the team goes back to work at once and has ${duration(listing.delivery_window_s)} to deliver again.`
                : `The owner decides within ${duration(listing.accept_window_s)} whether the team takes it. If not, the delivery you have stands and your review time starts again.`}{' '}
              Your payment stays in escrow.
            </p>
            <label>
              What should change?
              <textarea rows={5} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} name="revision" />
              <small>Encrypted in your browser; only the team's owner can read it. Keep it within what you ordered.</small>
            </label>
            <div className="row">
              <span className="spacer" />
              <button className="btn" onClick={() => setRevising(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!!busy || !note.trim()} onClick={() => void requestRevision()}>
                {busy === 'revision' ? 'Sending…' : 'Ask for the revision'}
              </button>
            </div>
          </div>
        </div>
      )}

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


/**
 * The delivered files. Each is fetched from the relay in pieces, checked and
 * decrypted here; a video, an image or a sound can be looked at before it is saved.
 */
function DeliveryFiles({ relay, delivery, orderId }: { relay: Relay; delivery: Delivery; orderId: number }) {
  const blobs = useRef(new Map<string, Blob>());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [shown, setShown] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [zipping, setZipping] = useState(false);
  const total = delivery.files.reduce((n, f) => n + f.size, 0);

  const get = async (f: Delivery['files'][number]): Promise<Blob> => {
    const kept = blobs.current.get(f.name);
    if (kept) return kept;
    setProgress((p) => ({ ...p, [f.name]: 0 }));
    try {
      const blob = await fetchFile(relay, f.blob, f.size, f.type, (got) => setProgress((p) => ({ ...p, [f.name]: got / Math.max(1, f.size) })));
      blobs.current.set(f.name, blob);
      return blob;
    } finally {
      setProgress(({ [f.name]: _done, ...rest }) => rest);
    }
  };
  const run = (work: () => Promise<void>) => {
    setError(undefined);
    work().catch((err) => setError((err as Error).message));
  };
  const show = (f: Delivery['files'][number]) => run(async () => {
    const url = URL.createObjectURL(await get(f));
    setShown((s) => ({ ...s, [f.name]: url }));
  });
  const all = () => run(async () => {
    setZipping(true);
    try {
      const files = [];
      for (const f of delivery.files) files.push({ name: f.name, blob: await get(f) });
      save(await zipFiles(files), `order-${orderId}.zip`);
    } finally {
      setZipping(false);
    }
  });
  useEffect(() => {
    const urls = shown;
    return () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="delivery">
      <div className="note good">The delivery matches the hash on-chain. {delivery.files.length === 1 ? 'One file' : `${delivery.files.length} files`}, {fileSize(total)}.</div>
      {delivery.files.map((f) => {
        const kind = /^(video|image|audio)\//.exec(f.type ?? '')?.[1];
        const url = shown[f.name];
        const busy = progress[f.name] !== undefined;
        return (
          <div key={f.name} className="delivered">
            <div className="row">
              <strong className="name">{f.name}</strong>
              <span className="muted small">{fileSize(f.size)}</span>
              <span className="spacer" />
              {kind && !url && (
                <button className="btn" disabled={busy} onClick={() => show(f)}>
                  {kind === 'video' ? 'Watch' : kind === 'audio' ? 'Listen' : 'View'}
                </button>
              )}
              <button className="btn primary" disabled={busy} onClick={() => run(async () => save(await get(f), f.name))}>
                Download
              </button>
            </div>
            {busy && <progress value={progress[f.name]} max={1} aria-label={`Fetching ${f.name}`} />}
            {url && kind === 'video' && <video src={url} controls playsInline />}
            {url && kind === 'image' && <img src={url} alt={f.name} />}
            {url && kind === 'audio' && <audio src={url} controls />}
          </div>
        );
      })}
      {delivery.files.length > 1 && total < ZIP_LIMIT && (
        <button className="btn" disabled={zipping} onClick={all}>
          {zipping ? 'Fetching everything…' : 'Download everything as a zip'}
        </button>
      )}
      {error && <div className="note bad">{error}</div>}
    </div>
  );
}
