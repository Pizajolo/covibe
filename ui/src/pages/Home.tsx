import { BarChart, HBars, Meter } from '../components/charts';
import { Composer } from '../components/Composer';
import { IconBolt, IconCheck, IconCoin, IconFolder, IconGauge, IconInfo, IconPlus, IconTeam } from '../components/icons';
import { RunCard, RunRow } from '../components/RunCard';
import { Toolbar } from '../components/Toolbar';
import { UsageMeters } from '../components/Usage';
import { Empty } from '../components/ui';
import { href, openNewProject, useData } from '../data';
import { dayLabel, greeting, money, tokens } from '../format';

export function Home({ onNewGoal }: { onNewGoal: () => void }) {
  const { overview } = useData();
  if (!overview) return <Toolbar title="covibe" />;
  const { stats, runs, projects, teams } = overview;
  const live = runs.filter((r) => r.status === 'running');
  const recent = runs.filter((r) => r.status !== 'running').slice(0, 8);
  const needsSetup = !projects.length || !teams.some((t) => t.valid);

  return (
    <>
      <Toolbar
        title={greeting()}
        sub={
          stats.activeAgents
            ? `${stats.activeAgents} team member${stats.activeAgents === 1 ? '' : 's'} working · ${money(stats.costUsd.today)} today`
            : `Nothing running · ${money(stats.costUsd.today)} today`
        }
      >
        <button className="btn primary" onClick={onNewGoal}>
          <IconPlus /> New goal
        </button>
      </Toolbar>
      <div className="content">
        <div className="page">
          {needsSetup && <Onboarding hasProject={projects.length > 0} hasTeam={teams.some((t) => t.valid)} />}

          {!needsSetup && (
            <div className="card">
              <Composer />
            </div>
          )}

          <div className="tiles">
            <Tile icon={<IconCoin />} label="Spend today" value={money(stats.costUsd.today)} foot={`${money(stats.costUsd.week)} this week · ${money(stats.costUsd.month)} in 30 days`} />
            <Tile icon={<IconBolt />} label="Tokens this week" value={tokens(stats.tokens.week)} foot={`${tokens(stats.tokens.all)} in the last 60 days`} />
            <Tile icon={<IconTeam />} label="Working now" value={String(stats.activeAgents)} foot={`${live.length} live run${live.length === 1 ? '' : 's'}`} />
            <Tile
              icon={<IconCheck />}
              label="Runs"
              value={String(stats.runs.total)}
              foot={`${stats.runs.succeeded} succeeded · ${stats.runs.escalated} need you · ${stats.runs.failed} failed`}
            />
            <Tile
              icon={<IconGauge />}
              label="Gates passed first time"
              value={stats.gatePassRate === undefined ? '—' : `${Math.round(stats.gatePassRate * 100)}%`}
              foot={`${stats.runs.questions} question${stats.runs.questions === 1 ? '' : 's'} asked`}
            />
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Estimated spend per day</h2>
                <span className="hint">last 14 days</span>
              </div>
              <div className="card-pad">
                <BarChart
                  ariaLabel="Estimated spend per day, last 14 days"
                  data={stats.daily.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.costUsd, detail: `${tokens(d.tokens)} tokens · ${d.runs} runs` }))}
                  format={(v) => money(v, v === 0 ? 0 : v < 1 ? 2 : Number.isInteger(v) ? 0 : 1)}
                />
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Plan usage</h2>
                <span className="hint">your Claude subscription</span>
              </div>
              <div className="card-pad col" style={{ gap: 16 }}>
                <UsageMeters />
                <div className="banner info small">
                  <IconInfo />
                  <span>
                    Dollar amounts are estimates of what the same usage would cost on the API. On a subscription you are not billed per token; it counts
                    against your plan's limits instead.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {live.length > 0 && (
            <section className="col" style={{ gap: 10 }}>
              <h2>Live now</h2>
              <div className="grid grid-3">
                {live.map((r) => (
                  <RunCard key={r.id} run={r} />
                ))}
              </div>
            </section>
          )}

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Recent</h2>
                <div className="right">
                  <a className="btn sm ghost" href={href('runs')}>
                    All runs
                  </a>
                </div>
              </div>
              {recent.length ? (
                <div className="list">
                  {recent.map((r) => (
                    <RunRow key={r.id} run={r} />
                  ))}
                </div>
              ) : (
                <Empty title="No runs yet">Give a team a goal and it shows up here.</Empty>
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Spend by team member</h2>
                <span className="hint">last 60 days</span>
              </div>
              <div className="card-pad">
                {stats.byAgent.length ? (
                  <HBars
                    data={stats.byAgent.slice(0, 8).map((a) => ({
                      key: `${a.team}/${a.agent}`,
                      label: (
                        <span>
                          {a.agent} <span className="faint">· {a.team}</span>
                        </span>
                      ),
                      value: a.costUsd,
                      title: `${a.turns} turns · ${tokens(a.tokens)} tokens`,
                    }))}
                    format={(v) => money(v)}
                  />
                ) : (
                  <p className="small muted">Nothing yet.</p>
                )}
                {stats.byModel.length > 0 && (
                  <table className="table" style={{ marginTop: 14 }}>
                    <thead>
                      <tr>
                        <th style={{ paddingLeft: 0 }}>Model</th>
                        <th className="r">Tokens</th>
                        <th className="r" style={{ paddingRight: 0 }}>
                          Est. spend
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byModel.map((m) => (
                        <tr key={m.model}>
                          <td style={{ paddingLeft: 0 }}>{m.model}</td>
                          <td className="r num">{tokens(m.tokens)}</td>
                          <td className="r num" style={{ paddingRight: 0 }}>
                            {money(m.costUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Tile({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return (
    <div className="card tile">
      <span className="label">
        {icon}
        {label}
      </span>
      <span className="value">{value}</span>
      <span className="foot">{foot}</span>
    </div>
  );
}

function Onboarding({ hasProject, hasTeam }: { hasProject: boolean; hasTeam: boolean }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <h2 className="grow">Get set up in three steps</h2>
        <button className="btn primary" onClick={openNewProject}>
          <IconPlus /> Set up a project
        </button>
      </div>
      <div className="steps-onboard">
        <div className={`card onboard-step ${hasProject ? 'done' : ''}`}>
          <span className="n">{hasProject ? '✓' : 1}</span>
          <h3>Add a project</h3>
          <p className="small muted">Open a folder on this Mac, clone a repository, or start from scratch. Your checkout is never changed; each run works on its own branch.</p>
          <button className="btn" onClick={openNewProject}>
            <IconFolder /> Add project
          </button>
        </div>
        <div className={`card onboard-step ${hasTeam ? 'done' : ''}`}>
          <span className="n">{hasTeam ? '✓' : 2}</span>
          <h3>Create a team</h3>
          <p className="small muted">Start from a template, or describe what you need and let Claude design the team for your project.</p>
          <a className="btn" href={href('teams')}>
            <IconTeam /> Create team
          </a>
        </div>
        <div className="card onboard-step">
          <span className="n">3</span>
          <h3>Give it a goal</h3>
          <p className="small muted">Describe what to build. Watch each member work, chat with them, and review the result branch.</p>
        </div>
      </div>
    </div>
  );
}
