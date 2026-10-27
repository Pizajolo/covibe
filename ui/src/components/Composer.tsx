import { useEffect, useMemo, useRef, useState } from 'react';
import { post } from '../api';
import { go, useData } from '../data';
import { IconBranch, IconPlay, IconQuestion } from './icons';
import { useAction } from './ui';

const LAST = 'covibe-composer';

function remembered(): { project?: string; team?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Give the team a new goal, or ask one member a question. The project and
 * team you used last are preselected.
 */
export function Composer({
  base,
  fixedProject,
  fixedTeam,
  autoFocus,
  onDone,
  initialMode = 'run',
}: {
  /** Build on an earlier run's branch. */
  base?: string;
  fixedProject?: string;
  fixedTeam?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  initialMode?: 'run' | 'ask';
}) {
  const { overview, refresh } = useData();
  const projects = overview?.projects ?? [];
  const teams = (overview?.teams ?? []).filter((t) => t.valid);
  const last = useMemo(remembered, []);
  const [mode, setMode] = useState<'run' | 'ask'>(initialMode);
  const [text, setText] = useState('');
  const [project, setProject] = useState(fixedProject ?? last.project ?? '');
  const [team, setTeam] = useState(fixedTeam ?? last.team ?? '');
  const [agent, setAgent] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!projects.some((p) => p.id === project) && projects[0]) setProject(projects[0].id);
    if (!teams.some((t) => t.id === team) && teams[0]) setTeam(teams[0].id);
  }, [projects, teams, project, team]);
  const members = teams.find((t) => t.id === team)?.agents ?? [];
  useEffect(() => {
    if (!members.includes(agent)) setAgent(members[0] ?? '');
  }, [members, agent]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const [submit, busy] = useAction(async () => {
    if (!text.trim()) return;
    try {
      localStorage.setItem(LAST, JSON.stringify({ project, team }));
    } catch {
      // not essential
    }
    const res =
      mode === 'run'
        ? await post<{ runId: string; projectId: string }>('/api/runs', { project, team, goal: text.trim(), base })
        : await post<{ runId: string; projectId: string }>('/api/ask', { project, team, agent, question: text.trim() });
    setText('');
    await refresh();
    onDone?.();
    go('runs', res.projectId, res.runId, mode === 'ask' ? 'chat' : '');
  });

  const ready = text.trim() && project && team && (mode === 'run' || agent);

  return (
    <div className="composer">
      <div className="row">
        <div className="seg" role="tablist">
          <button className={mode === 'run' ? 'on' : ''} onClick={() => setMode('run')}>
            New goal
          </button>
          <button className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>
            Ask a question
          </button>
        </div>
        {base && (
          <span className="pill info" title="The team starts from this run's result">
            <IconBranch /> builds on {base}
          </span>
        )}
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          mode === 'run'
            ? 'Describe what the team should build or fix, e.g. "Add a dark mode toggle to the settings page and remember the choice"'
            : 'Ask about the code, e.g. "How does authentication work, and where would rate limiting fit?"'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) void submit();
        }}
        rows={3}
      />
      <div className="controls">
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} disabled={!!fixedProject} aria-label="Project">
          {!projects.length && <option value="">No projects yet</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="input" value={team} onChange={(e) => setTeam(e.target.value)} disabled={!!fixedTeam} aria-label="Team">
          {!teams.length && <option value="">No valid teams yet</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {mode === 'ask' && (
          <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Team member">
            {members.map((m) => (
              <option key={m} value={m}>
                Ask {m}
              </option>
            ))}
          </select>
        )}
        <span className="grow" />
        <span className="tiny faint">
          <span className="kbd">⌘</span> <span className="kbd">↩</span>
        </span>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
          {mode === 'run' ? <IconPlay /> : <IconQuestion />}
          {mode === 'run' ? 'Start' : 'Ask'}
        </button>
      </div>
      {mode === 'ask' && <div className="tiny faint">Questions are read-only: the member can look at the code but not change it.</div>}
    </div>
  );
}
