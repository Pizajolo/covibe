import { useState } from 'react';
import { get, post, type Template, type TeamListing } from '../api';
import { DesignChat } from '../components/DesignChat';
import { IconAlert, IconChat, IconCheck, IconPlus, IconTeam } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { Avatar, Empty, Modal, useAction } from '../components/ui';
import { go, href, useData, useLive } from '../data';

export function Teams() {
  const { overview } = useData();
  const [creating, setCreating] = useState(false);
  const teams = overview?.teams ?? [];
  return (
    <>
      <Toolbar title="Teams" sub="Who is on each team, what they may touch, and how work flows between them">
        <button className="btn primary" onClick={() => setCreating(true)}>
          <IconPlus /> New team
        </button>
      </Toolbar>
      <div className="content">
        <div className="page">
          {teams.length ? (
            <div className="grid grid-3">
              {teams.map((t) => (
                <TeamCard key={t.id} team={t} />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty icon={<IconTeam />} title="No teams yet" action={<button className="btn primary" onClick={() => setCreating(true)}><IconPlus /> Create your first team</button>}>
                A team is a set of members (planner, builders, reviewer, tester…) and the workflow that connects them.
              </Empty>
            </div>
          )}
        </div>
      </div>
      {creating && <NewTeam onClose={() => setCreating(false)} />}
    </>
  );
}

function TeamCard({ team }: { team: TeamListing }) {
  return (
    <a className="card team-card" href={href('teams', team.id)} style={{ color: 'var(--text)' }}>
      <div className="row">
        <h2 className="grow ellipsis">{team.name}</h2>
        {team.valid ? (
          <span className="pill good">
            <IconCheck /> Ready
          </span>
        ) : (
          <span className="pill bad">
            <IconAlert /> {team.problems.length} problem{team.problems.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <p className="small muted" style={{ minHeight: 36 }}>
        {team.description ?? 'No description'}
      </p>
      <div className="row">
        <div className="avatars">
          {team.agents.map((a, i) => (
            <Avatar key={a} name={a} index={i} size="sm" />
          ))}
        </div>
        <span className="tiny faint grow">{team.agents.join(', ')}</span>
      </div>
      <div className="tiny faint">{team.steps.join(' → ')}</div>
    </a>
  );
}

export function NewTeam({ onClose }: { onClose: () => void }) {
  const { refresh, overview } = useData();
  const { value: templates } = useLive(() => get<Template[]>('/api/templates'), []);
  const [template, setTemplate] = useState('feature-team');
  const [name, setName] = useState('');
  const [chat, setChat] = useState(false);
  const [project, setProject] = useState('');
  const [create, busy] = useAction(async () => {
    const t = await post<TeamListing>('/api/teams', { name: name || template, template });
    await refresh();
    onClose();
    go('teams', t.id);
  });
  if (chat)
    return (
      <Modal title="Design a team with chat" onClose={() => (void refresh(), onClose())} wide>
        <div className="row">
          <label className="field grow">
            Name
            <input className="input" value={name} placeholder="e.g. web-app team" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field grow">
            For project (lets Claude look at the code)
            <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {overview?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <DesignChat key={project} projectId={project || undefined} name={name || 'new-team'} height={440} onTeam={() => void refresh()} />
      </Modal>
    );
  const blurbs: Record<string, string> = {
    'feature-team': 'Manager plans, frontend and backend build in parallel, QA reviews, tester tests. Up to 3 fix rounds.',
    'build-and-review': 'A builder and a reviewer with a review gate and two fix rounds.',
    starter: 'One assistant, one step. Grow it from here.',
  };
  return (
    <Modal
      title="New team"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            Create team
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input className="input" autoFocus value={name} placeholder="e.g. web-app team" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
      <button className="template" style={{ textAlign: 'left', font: 'inherit', background: 'var(--accent-soft)', borderColor: 'var(--accent)' }} onClick={() => setChat(true)}>
        <IconChat width={18} height={18} style={{ color: 'var(--accent)', flex: 'none' }} />
        <div className="col" style={{ gap: 2 }}>
          <strong>Design it with chat</strong>
          <span className="small muted">Describe the team you need; Claude sets it up and you refine it by talking.</span>
        </div>
      </button>
      <div className="col">
        <span className="small muted" style={{ fontWeight: 500 }}>
          Or start from a template
        </span>
        {(templates ?? []).map((t) => (
          <div key={t.id} className={`template ${template === t.id ? 'on' : ''}`} onClick={() => setTemplate(t.id)}>
            <input type="radio" checked={template === t.id} onChange={() => setTemplate(t.id)} style={{ accentColor: 'var(--accent)', marginTop: 2 }} />
            <div className="col" style={{ gap: 2 }}>
              <strong>{t.name}</strong>
              <span className="small muted">{blurbs[t.id] ?? t.description}</span>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
