import { useState } from 'react';
import { desktop, get, put, type AppSettings, type NotificationKind, type NotifyChoice } from '../api';
import { UsageThreshold } from '../components/Backlog';
import { AdvancedSettings, useConnections } from '../components/Connections';
import { IconInfo } from '../components/icons';
import { ModelPicker } from '../components/ModelPicker';
import { Toolbar } from '../components/Toolbar';
import { UsageMeters } from '../components/Usage';
import { VoiceSettings } from '../components/VoiceSettings';
import { useAction, useToast } from '../components/ui';
import { useData, useLive } from '../data';
import { askPushPermission, pushState } from '../notify';

function ClaudeAccount() {
  const toast = useToast();
  const { value: env } = useLive(() => get<{ skills: unknown[]; account?: { email?: string; subscriptionType?: string; apiProvider?: string; organization?: string } }>('/api/environment'), []);
  const { value: settings, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const [save] = useAction(async (patch: Partial<AppSettings>) => {
    setValue(await put<AppSettings>('/api/settings', patch));
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
          <section className="form-section">
            <h3 className="small">Designing teams in chat</h3>
            <ModelPicker
              compact
              value={{ model: settings.designerModel, effort: settings.designerEffort }}
              inherit="Sonnet (default)"
              onChange={(k, v) => k !== 'thinking' && void save({ [k === 'model' ? 'designerModel' : 'designerEffort']: v } as Partial<AppSettings>)}
            />
            <span className="help tiny faint">Models and thinking for team members are set per team (Team → Settings) and per member (Members).</span>
          </section>
        )}
        {settings && (
          <section className="form-section" id="brain-model">
            <h3 className="small">Summarizing project brains</h3>
            <ModelPicker
              compact
              value={{ model: settings.brainModel ?? undefined, effort: settings.brainEffort ?? undefined }}
              inherit="Sonnet (default)"
              provider={settings.brainProvider ? { id: settings.brainProvider.connection, model: settings.brainProvider.model } : undefined}
              onProvider={(c) => void save({ brainProvider: { connection: c.id, model: c.model }, brainModel: null, brainEffort: null })}
              onChange={(k, v) => {
                if (k === 'model') void save({ brainModel: (v as string | null) ?? null, brainProvider: null });
                else if (k === 'effort') void save({ brainEffort: (v as AppSettings['brainEffort']) ?? null });
              }}
            />
            <span className="help tiny faint">Used by Summarize on a project's Brain tab: it rewrites the notes in fewer words. Reading and rewriting every note is work for a capable model; a cheap one may drop facts.</span>
          </section>
        )}
      </div>
    </div>
  );
}

function UsageLimits() {
  const toast = useToast();
  const { value, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const sharing = !!useConnections()?.balance;
  const [save] = useAction(async (onLimit: 'wait' | 'stop') => {
    setValue(await put<AppSettings>('/api/settings', { onLimit }));
    toast(onLimit === 'wait' ? 'Runs wait for the limit to reset and continue' : 'Runs stop at the limit; restart them from the run');
  });
  if (!value) return null;
  const mode = value.onLimit ?? 'wait';
  return (
    <div className="card">
      <div className="card-head">
        <h2>Usage limits</h2>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        <UsageMeters />
        <span className="small" style={{ marginTop: 6 }}>
          When a member hits your plan's 5-hour or weekly limit{value && sharing ? ' and no other account has room' : ''}:
        </span>
        <label className="check">
          <input type="radio" name="on-limit" checked={mode === 'wait'} onChange={() => void save('wait')} />
          Wait for the limit to reset, then continue where it stopped (the run shows a countdown)
        </label>
        <label className="check">
          <input type="radio" name="on-limit" checked={mode === 'stop'} onChange={() => void save('stop')} />
          Stop the run; restart it from the run page, right away or when the limit resets
        </label>
        <span className="small" style={{ marginTop: 6 }}>
          Project backlogs:
        </span>
        <UsageThreshold />
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

const NOTIFY_KINDS: { kind: NotificationKind; label: string; help: string }[] = [
  { kind: 'question', label: 'Questions', help: 'A member asks you something; the team waits for your answer.' },
  { kind: 'limit', label: 'Reaching a limit', help: "Your plan's 5-hour or weekly usage is close to or at its limit." },
  { kind: 'stopped', label: 'Stopping', help: 'A run was stopped, or ran out of fix rounds and needs you.' },
  { kind: 'error', label: 'Errors', help: 'A run failed.' },
  { kind: 'done', label: 'Job done', help: 'A run finished with every gate passed.' },
];

function Notifications() {
  const toast = useToast();
  const { value, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const [push, setPush] = useState(pushState);
  const [save] = useAction(async (kind: NotificationKind, choice: Partial<NotifyChoice>) => {
    setValue(await put<AppSettings>('/api/settings', { notifications: { [kind]: choice } }));
    toast('Saved');
  });
  const [allow] = useAction(async () => setPush(await askPushPermission()));
  if (!value) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Notifications</h2>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <p className="small">
          The bell at the top right lists the latest of these, and the questions waiting for you. Questions also open in a popup wherever you are; close it and answer later
          from the bell or the <strong>?</strong> on the lead's desk in the Office. System notifications go out while covibe is in the background.
        </p>
        <div className="notify-grid">
          <span className="head">Kind</span>
          <span className="head">Bell</span>
          <span className="head">System</span>
          {NOTIFY_KINDS.map(({ kind, label, help }) => (
            <div key={kind} style={{ display: 'contents' }}>
              <span className="col" style={{ gap: 0 }}>
                {label}
                <span className="tiny faint">{help}</span>
              </span>
              <input type="checkbox" aria-label={`${label} under the bell`} checked={value.notifications[kind].bell} onChange={(e) => void save(kind, { bell: e.target.checked })} />
              <input type="checkbox" aria-label={`${label} as system notifications`} checked={value.notifications[kind].push} onChange={(e) => void save(kind, { push: e.target.checked })} />
            </div>
          ))}
        </div>
        {push === 'default' && (
          <div className="banner info small">
            <IconInfo />
            <span className="grow">System notifications need your permission.</span>
            <button className="btn sm" onClick={() => void allow()}>
              Allow notifications
            </button>
          </div>
        )}
        {push === 'denied' && (
          <div className="banner warn small">
            <IconInfo />
            <span>System notifications are blocked. Allow them for covibe in your {desktop ? 'system' : 'browser'} settings; the bell works either way.</span>
          </div>
        )}
        {push === 'unsupported' && (
          <div className="banner info small">
            <IconInfo />
            <span>This browser cannot show system notifications; the bell and the question popup still work.</span>
          </div>
        )}
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
                <dt>Other Claude accounts</dt>
                <dd>Signed in under Advanced below, and chosen per team or member. Members can also share work across them.</dd>
                <dt>ChatGPT accounts</dt>
                <dd>Signed in with ChatGPT under Advanced below, like Codex; members use OpenAI's models within your ChatGPT plan's limits, with Claude Code's tools.</dd>
                <dt>Other providers</dt>
                <dd>DeepSeek, OpenAI, OpenRouter, a local Ollama and others with an API key, set up under Advanced below; their models show up in every team's model list.</dd>
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

          <Notifications />

          <ClaudeAccount />

          <UsageLimits />

          <VoiceSettings />

          <DiskSpace />

          <h2 className="settings-group">Advanced</h2>
          <AdvancedSettings />

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
                <li>
                  Plugins' hooks and servers run in the sandbox too, each with its own permissions: no access to your home folder or your keys, and only the domains and folders you
                  allowed for that plugin. An update that changes what a plugin runs waits for your approval.
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
