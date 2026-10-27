import { desktop } from '../api';
import { IconInfo } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { useData } from '../data';

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

          <div className="card">
            <div className="card-head">
              <h2>Safety</h2>
            </div>
            <div className="card-pad">
              <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>Every member that changes code works in its own git worktree; your checkout is never modified.</li>
                <li>File writes outside a member's allowed paths are blocked, and anything a shell command changes outside them is discarded before merging.</li>
                <li>Gates, fix rounds, turn limits and timeouts are enforced by covibe, not left to the models.</li>
                <li>Shell commands are not sandboxed yet. Do not run untrusted goals, and keep secrets out of the environment.</li>
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
