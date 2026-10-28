// The plan's limits: a compact meter in the sidebar and the card on Home.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, type UsageReport } from '../api';
import { useLive } from '../data';
import { countdown, resetTime } from '../format';
import { Meter } from './charts';

const Ctx = createContext<{ usage: UsageReport | null; refresh(): Promise<void> }>({ usage: null, refresh: async () => undefined });

/** Reads /api/usage once a minute, and right away when a member reports a limit. */
export function UsageProvider({ children }: { children: ReactNode }) {
  const { value, reload } = useLive(() => get<UsageReport>('/api/usage'), [], (e) => e.event.type === 'usage.limit' || e.event.type === 'run.finished');
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(t);
  }, [reload]);
  return <Ctx.Provider value={{ usage: value, refresh: reload }}>{children}</Ctx.Provider>;
}

export const useUsage = () => useContext(Ctx);

/** Re-render every `ms` so countdowns move. */
export function useTick(ms = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

const level = (w: UsageReport['windows'][number]) =>
  w.status === 'rejected' || (w.utilization ?? 0) >= 0.9 ? 'bad' : w.status === 'allowed_warning' || (w.utilization ?? 0) >= 0.7 ? 'warn' : '';

/** The two windows that matter most, small, at the bottom of the sidebar; one line per account when there are several. */
export function SidebarUsage() {
  const { usage } = useUsage();
  useTick(30_000);
  if (!usage) return null;
  const others = usage.accounts ?? [];
  if (others.length) {
    const rows = [{ key: 'main', label: 'Your login', u: usage as Omit<UsageReport, 'accounts' | 'balance'> }, ...others.map((a) => ({ key: a.id, label: a.label, u: a.usage }))];
    return (
      <a className="side-usage" href="#/" title={`Plan usage per account${usage.balance ? ' (shared)' : ''} (details on Home)`}>
        {rows.slice(0, 4).map(({ key, label, u }) => {
          const five = u.windows.find((w) => w.window === 'five_hour');
          const week = u.windows.find((w) => w.window === 'seven_day');
          // The fuller of the two windows decides how close the account is to stopping.
          const top = [five, week].filter((w) => !!w).sort((a, b) => (b!.utilization ?? 0) - (a!.utilization ?? 0))[0];
          return (
            <div key={key} className="side-usage-row">
              <div className="row tiny">
                <span className="grow ellipsis">{label}</span>
                <span className="num">{u.windows.length ? `${five ? pctOf(five) : '—'} · ${week ? pctOf(week) : '—'}` : '—'}</span>
              </div>
              <div className="meter-track thin">
                <div className={`meter-fill ${top ? level(top) : ''}`} style={{ width: `${Math.min(100, (top?.utilization ?? (top?.status === 'rejected' ? 1 : 0)) * 100)}%` }} />
              </div>
            </div>
          );
        })}
        <div className="tiny faint">5-hour · weekly{usage.balance ? ' · shared' : ''}</div>
      </a>
    );
  }
  if (!usage.windows.length) return null;
  const shown = ['five_hour', 'seven_day'].map((k) => usage.windows.find((w) => w.window === k)).filter((w) => !!w);
  const list = shown.length ? shown : usage.windows.slice(0, 2);
  return (
    <a className="side-usage" href="#/" title="Plan usage (details on Home)">
      {list.map((w) => (
        <div key={w.window} className="side-usage-row">
          <div className="row tiny">
            <span className="grow">{w.window === 'five_hour' ? '5-hour' : w.window === 'seven_day' ? 'Weekly' : w.label}</span>
            <span className="num">{pctOf(w)}</span>
          </div>
          <div className="meter-track thin">
            <div className={`meter-fill ${level(w)}`} style={{ width: `${Math.min(100, (w.utilization ?? (w.status === 'rejected' ? 1 : 0)) * 100)}%` }} />
          </div>
          {w.resetsAt && <div className="tiny faint">resets in {countdown(w.resetsAt)}</div>}
        </div>
      ))}
    </a>
  );
}

const pctOf = (w: UsageReport['windows'][number]) => (w.utilization === undefined ? (w.status === 'rejected' ? 'limit' : '—') : `${Math.round(w.utilization * 100)}%`);

/** Every window, with what is left and when it resets: for your login, and for each other Claude account. */
export function UsageMeters() {
  const { usage } = useUsage();
  useTick(30_000);
  if (!usage) return <p className="small muted">Checking your plan…</p>;
  const others = usage.accounts ?? [];
  if (!others.length) return <AccountMeters usage={usage} />;
  return (
    <>
      {usage.balance && <span className="small muted">Members share work across your {others.filter((a) => a.kind === 'claude').length + 1} Claude accounts.</span>}
      <section className="usage-account">
        <h3 className="small">
          Your login{usage.subscription ? <span className="faint"> · {usage.subscription}</span> : null}
        </h3>
        <AccountMeters usage={usage} />
      </section>
      {others.map((a) => (
        <section key={a.id} className="usage-account">
          <h3 className="small">
            {a.label}
            <span className="faint"> · {[a.kind === 'codex' ? 'ChatGPT' : '', a.email, a.usage.subscription].filter(Boolean).join(' · ') || 'Claude'}</span>
          </h3>
          <AccountMeters usage={a.usage} other />
        </section>
      ))}
    </>
  );
}

function AccountMeters({ usage, other }: { usage: Omit<UsageReport, 'accounts' | 'balance'>; other?: boolean }) {
  if (!usage.windows.length)
    return (
      <p className="small muted">
        {other
          ? 'Nothing reported yet. If the account is not signed in, sign it in under Settings → Advanced.'
          : usage.subscription === undefined && usage.source === 'none'
            ? "Your plan's 5-hour and weekly usage shows up here once Claude Code reports it (it needs a claude login on your subscription)."
            : 'No plan limits apply to this account (API key, Bedrock or Vertex).'}
      </p>
    );
  return (
    <>
      {usage.windows.map((w) => (
        <Meter
          key={w.window}
          label={w.label}
          fraction={w.utilization}
          status={w.status}
          caption={[
            w.status === 'rejected' ? 'Limit reached' : '',
            w.resetsAt ? `resets in ${countdown(w.resetsAt)} (${resetTime(w.resetsAt)})` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      ))}
      {usage.extra?.enabled && (
        <Meter
          label="Extra usage this month"
          fraction={usage.extra.utilization === null ? undefined : usage.extra.utilization / 100}
          caption={usage.extra.used !== null && usage.extra.limit !== null ? `${usage.extra.used} of ${usage.extra.limit} ${usage.extra.currency ?? ''}`.trim() : undefined}
        />
      )}
      <span className="tiny faint">
        {usage.source === 'claude'
          ? `Read from Claude Code${usage.subscription && !other ? ` (${usage.subscription} plan)` : ''}`
          : usage.source === 'codex'
            ? 'Read from the ChatGPT account'
            : 'As members last reported it'}{' '}
        at{' '}
        {new Date(usage.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.
      </span>
    </>
  );
}
