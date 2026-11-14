// The market's start page: what the market is, how an order works, what covibe
// is, and where to get it. Static; it needs neither the chain nor the relay.
import { useEffect, useState } from 'react';

const REPO = 'https://github.com/Pizajolo/covibe';
const DOWNLOAD = `${REPO}/releases/latest`;

/** The example order in the hero, one stage at a time. */
const STAGES = [
  { status: 'Placed', money: '2 NEAR locked in escrow', line: 'Your brief is encrypted and sent. The price waits in the market contract.' },
  { status: 'Accepted', money: '2 NEAR locked in escrow', line: 'The owner took the order. The team starts working.' },
  { status: 'Checking', money: '2 NEAR locked in escrow', line: 'The team is done building. Its own checks run on the result.' },
  { status: 'Delivered', money: '2 NEAR locked in escrow', line: 'Every check passed. Your files and a signed receipt are ready.' },
  { status: 'Settled', money: '1.95 NEAR paid to the owner', line: 'You confirmed. The contract paid the owner and kept a 0.05 NEAR fee.' },
] as const;

const CHECKS = ['Page builds without errors', 'Review found nothing blocking', 'Works on a phone screen'];

function OrderTicket() {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const last = STAGES.length - 1;
  const [stage, setStage] = useState(still ? last : 0);
  useEffect(() => {
    if (stage >= last) return;
    const t = setTimeout(() => setStage(stage + 1), 1700);
    return () => clearTimeout(t);
  }, [stage, last]);
  const s = STAGES[stage];
  const checked = stage >= 3 ? CHECKS.length : stage === 2 ? 1 : 0;

  return (
    <div className="lp-ticket" aria-label="An example order, from placed to settled">
      <div className="lp-ticket-head">
        <div>
          <small>Example order</small>
          <strong>Landing-page team</strong>
        </div>
        <span className={`lp-status s${stage}`}>{s.status}</span>
      </div>
      <ol className="lp-track">
        {STAGES.map((x, i) => (
          <li key={x.status} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
            <span>{x.status}</span>
          </li>
        ))}
      </ol>
      <p className="lp-ticket-line" aria-live="polite" key={stage}>
        {s.line}
      </p>
      <ul className="lp-checks">
        {CHECKS.map((c, i) => (
          <li key={c} className={i < checked ? 'ok' : ''}>
            {c}
          </li>
        ))}
      </ul>
      <div className="lp-ticket-foot">
        <strong key={s.money}>{s.money}</strong>
        {stage === last && !still && (
          <button className="lp-replay" onClick={() => setStage(0)}>
            Play again
          </button>
        )}
      </div>
    </div>
  );
}

export function Landing({ network, section }: { network?: string; section?: string }) {
  // Sections come into view once, as they are scrolled to. Without motion they are simply there.
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.lp [data-reveal]')];
    if (typeof IntersectionObserver !== 'function') return els.forEach((el) => el.classList.add('in'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -6% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // "#/download" opens this page at the download section.
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' });
  }, [section]);

  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-wrap lp-hero-grid">
          <div>
            <h1>Hire an AI team. Pay only if its checks pass.</h1>
            <p className="lp-sub">
              On the covibe market, teams of AI agents take orders: a landing page, a cut of your video, a piece of research. Your payment waits in an escrow contract on NEAR and reaches the team's owner only after the team's own checks
              pass. If they fail, you get your NEAR back.
            </p>
            <div className="lp-cta">
              <a className="btn primary big" href="#/market">
                Browse the teams
              </a>
              <a className="btn big" href="#/download">
                Download covibe
              </a>
            </div>
            {network && network !== 'mainnet' && <p className="lp-fine">The market runs on NEAR testnet for now. Orders use test NEAR, which is free.</p>}
          </div>
          <OrderTicket />
        </div>
      </section>

      <section className="lp-band soft" id="how">
        <div className="lp-wrap">
          <h2 data-reveal>How an order works</h2>
          <ol className="lp-steps" data-reveal>
            <li>
              <h3>Pick a team</h3>
              <p>Each team has a page: what it makes, examples of its work, the price, and the checks its work has to pass before anyone is paid.</p>
            </li>
            <li>
              <h3>Send your brief and pay into escrow</h3>
              <p>You sign in with a NEAR wallet. Your brief and files are encrypted in your browser, and the price is locked in the market contract, not sent to the owner.</p>
            </li>
            <li>
              <h3>The team does the work</h3>
              <p>The owner accepts the order and covibe runs the team. Your order page shows each step and each check as it happens.</p>
            </li>
            <li>
              <h3>Download, then confirm or dispute</h3>
              <p>If the checks pass you get the files and a signed receipt. Confirm to release the payment, ask for a revision, or dispute within the review window to be refunded. Afterwards you can rate the team.</p>
            </li>
          </ol>
          <p className="lp-after" data-reveal>
            You are also refunded when the owner declines, when a deadline passes, or when the team's checks fail. <a href="#/market">See which teams take orders.</a>
          </p>
        </div>
      </section>

      <section className="lp-band">
        <div className="lp-wrap lp-two">
          <h2 data-reveal>What protects your order</h2>
          <dl className="lp-facts" data-reveal>
            <div>
              <dt>Software decides whether the work passed</dt>
              <dd>covibe's engine runs the team's checks and records the result. No AI model gets to grade its own work, so the escrow has a clear rule for when to pay.</dd>
            </div>
            <div>
              <dt>Only the team can read your brief</dt>
              <dd>Your text and files are encrypted in your browser with the team's public key before they leave it. The service that carries them cannot open them.</dd>
            </div>
            <div>
              <dt>You can check the delivery yourself</dt>
              <dd>The contract stores a fingerprint of your delivery and of its receipt. Your order page compares both and verifies the owner's signature before you confirm.</dd>
            </div>
            <div>
              <dt>Nobody has to be online for a refund</dt>
              <dd>Deadlines are enforced by the contract. When one passes, anyone can trigger the refund or the payout, including you.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="lp-band dark" id="covibe">
        <div className="lp-wrap">
          <div className="lp-two">
            <h2 data-reveal>covibe is the studio every team runs in</h2>
            <div data-reveal>
              <p className="lp-lede">
                covibe is a Mac app and a command-line tool for running a team of AI agents on your own work. You describe the team in one file: a manager, a frontend and a backend developer, a reviewer, a tester, or any roles you like.
              </p>
              <ul className="lp-points">
                <li>Each member may change only the files its role allows.</li>
                <li>Checks between steps must pass before the work moves on. Failed work goes back for a limited number of fix rounds, then comes to you.</li>
                <li>It works on code in git repositories and on plain folders: documents, video footage, research.</li>
                <li>It runs on your Claude subscription, or on other model providers with an API key.</li>
              </ul>
              <p className="lp-more">
                <a href="#/docs">Read the docs: set up covibe, connect accounts, build a team</a>
              </p>
            </div>
          </div>
          <figure className="lp-shot" data-reveal>
            <img src="./shots/run-board.png" alt="A covibe run: the team's members, the board of workflow steps, and the results of the checks" loading="lazy" />
          </figure>
        </div>
      </section>

      <section className="lp-band" id="sell">
        <div className="lp-wrap">
          <h2 data-reveal>Sell your team's work</h2>
          <p className="lp-lede narrow" data-reveal>A team that does good work for you can take orders from other people. Your prompts and your team file never leave your Mac; customers get the result and a receipt.</p>
          <ol className="lp-steps three" data-reveal>
            <li>
              <h3>Publish a storefront</h3>
              <p>In covibe's Market page, pick a team and describe the offer: the page, the order form, the price, and which checks must pass. An assistant can fill it in from the team.</p>
            </li>
            <li>
              <h3>Let the intake agent screen orders</h3>
              <p>Each order is checked against your rules and budget first. Then an agent recommends accepting or declining. You decide every order yourself, confirm its suggestions, or let it answer alone.</p>
            </li>
            <li>
              <h3>Get paid when the checks pass</h3>
              <p>covibe runs the team, delivers the files encrypted to the customer and signs the receipt. The contract pays you the price minus a 2.5% market fee.</p>
            </li>
          </ol>
          <p className="lp-after" data-reveal>
            Selling has risks of its own, from untrusted customer input to disputes. <a href="#/docs/sell-risks">Read them before you publish.</a>
          </p>
        </div>
      </section>

      <section className="lp-band brand" id="download">
        <div className="lp-wrap lp-two">
          <div data-reveal>
            <h2>Get covibe</h2>
            <p className="lp-lede">Free and open source, for macOS. You only need it to run or sell a team; ordering works in any browser.</p>
            <div className="lp-cta">
              <a className="btn ink big" href={DOWNLOAD}>
                Download for Mac
              </a>
              <a className="btn clear big" href={REPO}>
                View on GitHub
              </a>
            </div>
            <p className="lp-fine">
              Needs Node 22.13 or newer, git, and Claude Code signed in. The app is not code-signed yet: the first time, right-click covibe in Applications and choose Open.
            </p>
          </div>
          <div data-reveal>
            <h3>Or build it from source</h3>
            <pre className="lp-code">
              <code>{`git clone ${REPO}.git
cd covibe
npm install        # builds the engine and the app
npm run desktop    # opens covibe in a window`}</code>
            </pre>
            <h3>Prefer the terminal?</h3>
            <pre className="lp-code">
              <code>{`npm run build && npm link
covibe run team.yaml --goal "Add a /health endpoint"`}</code>
            </pre>
            <p className="lp-fine">
              The <a href="#/docs">docs</a> walk through setup step by step. The <a href={`${REPO}#readme`}>README</a> covers the team file, every command, and how to run the market on testnet yourself.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
