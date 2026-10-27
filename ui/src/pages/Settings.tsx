import { desktop, get, put, type AppSettings } from '../api';
import { IconInfo } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { useAction, useToast } from '../components/ui';
import { useData, useLive } from '../data';

function ClaudeAccount() {
  const toast = useToast();
  const { value: env } = useLive(() => get<{ skills: unknown[]; account?: { email?: string; subscriptionType?: string; apiProvider?: string; organization?: string } }>('/api/environment'), []);
  const { value: settings, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const [save] = useAction(async (model: string) => {
    setValue(await put<AppSettings>('/api/settings', { designerModel: model }));
    toast('Saved');
  });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Claude</h2>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        <dl className="kv">
          <dt>Signed in</dt>
          <dd>{env ? (env.account?.email ? `${env.account.email}${env.account.subscriptionType ? ` · ${env.account.subscriptionType}` : ''}` : env.account?.subscriptionType ?? 'Not signed in (run claude login in Terminal)') : 'Checking…'}</dd>
          {env?.account?.organization && (
            <>
              <dt>Organization</dt>
              <dd>{env.account.organization}</dd>
            </>
          )}
        </dl>
        {settings && (
          <label className="field" style={{ maxWidth: 320 }}>
            Model for designing teams in chat
            <select className="input" value={settings.designerModel ?? 'sonnet'} onChange={(e) => void save(e.target.value)}>
              <option value="opus">Opus: best designs, costs more</option>
              <option value="sonnet">Sonnet: good and quick (default)</option>
              <option value="haiku">Haiku: cheapest</option>
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function DiskSpace() {
  const toast = useToast();
  const { value, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const [save] = useAction(async (days: number | null) => {
    setValue(await put<AppSettings>('/api/settings', { autoCleanDays: days }));
    toast(days === null ? 'Worktrees are kept until you clean them up' : `Worktrees are removed ${days === 0 ? 'right after' : `${days} day${days > 1 ? 's' : ''} after`} a run finishes`);
  });
  if (!value) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Disk space</h2>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        <p className="small">
          Each member that writes code gets a full working copy of the repository for the run. Removing them frees disk space; the run's result branch, history and chat stay
          (a member's working copy is restored if you chat with it later).
        </p>
        <label className="field" style={{ maxWidth: 320 }}>
          Remove worktrees of finished runs
          <select className="input" value={value.autoCleanDays === null ? '' : String(value.autoCleanDays)} onChange={(e) => void save(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">Only when I clean up</option>
            <option value="0">Right after the run</option>
            <option value="1">After 1 day</option>
            <option value="3">After 3 days</option>
            <option value="7">After a week</option>
            <option value="30">After 30 days</option>
          </select>
          <span className="help">Checked hourly while covibe is open. Clean up by hand in Projects.</span>
        </label>
      </div>
    </div>
  );
}

export function Settings() {
  const { overview } = useData();
  return (
    <>
      <Toolbar title="Settings" />
      <div className="content">
        <div className="page" style={{ maxWidth: 760 }}>
          <div className="card">
            <div className="card-head">
              <h2>Library</h2>
            </div>
            <div className="card-pad">
              <dl className="kv">
                <dt>Teams and settings</dt>
                <dd className="mono">{overview?.home}</dd>
                <dt>Run history</dt>
                <dd>
                  Stored per project in <span className="mono">.covibe/covibe.db</span> inside the repository (ignored by git).
                </dd>
              </dl>
              {desktop && overview && (
                <button className="btn sm" style={{ marginTop: 12 }} onClick={() => void desktop!.reveal(overview.home)}>
                  Show in Finder
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>How members connect to Claude</h2>
            </div>
            <div className="card-pad col" style={{ gap: 10 }}>
              <p className="small">
                Each member runs its own Claude Code process. Which account it uses is set per team (Team → Settings) or per member (Members → Connection):
              </p>
              <dl className="kv">
                <dt>Claude subscription</dt>
                <dd>
                  Uses your <span className="mono">claude login</span> on this Mac. Usage counts against your plan's 5-hour and weekly limits, shown on Home. An{' '}
                  <span className="mono">ANTHROPIC_API_KEY</span> in your environment is ignored so it cannot quietly bill the API.
                </dd>
                <dt>API key</dt>
                <dd>Pay as you go, read from an environment variable.</dd>
                <dt>Gateway</dt>
                <dd>A LiteLLM or company proxy at a URL you set, for cheaper or non-Claude models on some members.</dd>
                <dt>Bedrock / Vertex</dt>
                <dd>Your cloud credentials.</dd>
              </dl>
              <div className="banner info small">
                <IconInfo />
                <span>
                  Using your subscription this way is meant for your own work on your own Mac. For a team or a product, use API keys. Check Anthropic's current
                  terms, as they have changed several times.
                </span>
              </div>
            </div>
          </div>

          <ClaudeAccount />

          <DiskSpace />

          <div className="card">
            <div className="card-head">
              <h2>Safety</h2>
            </div>
            <div className="card-pad">
              <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>Every member that changes code works in its own git worktree; your checkout is never modified.</li>
                <li>File writes outside a member's allowed paths are blocked, and anything a shell command changes outside them is discarded before merging.</li>
                <li>Gates, fix rounds, turn limits and timeouts are enforced by covibe, not left to the models.</li>
                <li>
                  Shell commands run in the macOS sandbox: they can write only in the member's own working copy, temp folders and package caches, and reach only the
                  domains the team allows. Change this per team (Team settings → Sandbox) or per member.
                </li>
                <li>Messages to a working member can steer it between tool calls or stop its current turn; nothing else can take over a running member.</li>
              </ul>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Keyboard</h2>
            </div>
            <div className="card-pad">
              <dl className="kv">
                <dt>⌘ ↩</dt>
                <dd>Start a goal or send a question</dd>
                <dt>↩ in chat</dt>
                <dd>Send (⇧ ↩ for a new line)</dd>
                <dt>⌘ S</dt>
                <dd>Save in the YAML and file editors</dd>
                <dt>⌘ N</dt>
                <dd>New goal</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
