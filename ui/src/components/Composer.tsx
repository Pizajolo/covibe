import { useEffect, useMemo, useRef, useState } from 'react';
import { post } from '../api';
import { go, useData } from '../data';
import { IconBranch, IconPlay, IconPlus, IconQuestion } from './icons';
import { AttachButton, AttachmentChips, useAttachments } from './Attachments';
import { MicButton, withSpoken } from './MicButton';
import { useAction } from './ui';

const LAST = 'covibe-composer';

type Mode = 'run' | 'backlog' | 'ask';

function remembered(): { project?: string; team?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Give the team a new goal, line goals up in a project's backlog, or ask one
 * member a question. The project and team you used last are preselected.
 */
export function Composer({
  base,
  fixedProject,
  fixedTeam,
  autoFocus,
  onDone,
  initialMode = 'run',
  defaultTeam,
}: {
  /** Build on an earlier run's branch. */
  base?: string;
  fixedProject?: string;
  fixedTeam?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  initialMode?: Mode;
  /** Preselected team (the backlog's), over the one used last. */
  defaultTeam?: string;
}) {
  const { overview, refresh } = useData();
  const projects = overview?.projects ?? [];
  const teams = (overview?.teams ?? []).filter((t) => t.valid);
  const last = useMemo(remembered, []);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [text, setText] = useState('');
  const [project, setProject] = useState(fixedProject ?? last.project ?? '');
  const [team, setTeam] = useState(fixedTeam ?? defaultTeam ?? last.team ?? '');
  const [perLine, setPerLine] = useState(true);
  const [agent, setAgent] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const files = useAttachments();

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
    if (mode === 'backlog') {
      const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
      const several = multiline && perLine && lines.length > 1;
      await post(`/api/projects/${project}/goals`, several ? { goals: lines, team } : { goal: text.trim(), team, attachments: files.ids });
      setText('');
      files.clear();
      onDone?.();
      go('projects', project, 'backlog');
      return;
    }
    const res =
      mode === 'run'
        ? await post<{ runId: string; projectId: string }>('/api/runs', { project, team, goal: text.trim(), base, attachments: files.ids })
        : await post<{ runId: string; projectId: string }>('/api/ask', { project, team, agent, question: text.trim(), attachments: files.ids });
    setText('');
    files.clear();
    await refresh();
    onDone?.();
    go('runs', res.projectId, res.runId, mode === 'ask' ? 'chat' : '');
  });

  const multiline = text.trim().includes('\n');
  // Files go with one goal; a list of goals goes without.
  const splitWithFiles = mode === 'backlog' && multiline && perLine && files.ids.length > 0;
  const ready = text.trim() && project && team && (mode !== 'ask' || agent) && !files.uploading && !files.failed && !splitWithFiles;

  return (
    <div className={`composer ${files.dragging ? 'drop-target' : ''}`} {...files.drop}>
      <div className="row">
        <div className="seg" role="tablist">
          <button className={mode === 'run' ? 'on' : ''} onClick={() => setMode('run')}>
            New goal
          </button>
          <button className={mode === 'backlog' ? 'on' : ''} onClick={() => setMode('backlog')} title="Line goals up: the team works them off one after another">
            Add to backlog
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
            : mode === 'backlog'
              ? 'Line up goals for the team, one per line. Each is checked for anything unclear first, then worked off when the team is free.'
              : 'Ask about the code, e.g. "How does authentication work, and where would rate limiting fit?"'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) void submit();
        }}
        onPaste={files.onPaste}
        rows={3}
      />
      <AttachmentChips files={files} />
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
        <AttachButton files={files} />
        <MicButton onText={(t) => (setText((prev) => withSpoken(prev, t)), ref.current?.focus())} />
        <span className="tiny faint">
          <span className="kbd">⌘</span> <span className="kbd">↩</span>
        </span>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
          {mode === 'run' ? <IconPlay /> : mode === 'backlog' ? <IconPlus /> : <IconQuestion />}
          {mode === 'run' ? 'Start' : mode === 'backlog' ? 'Add to backlog' : 'Ask'}
        </button>
      </div>
      {files.failed && <div className="tiny" style={{ color: 'var(--bad)' }}>A file could not be uploaded; take it out to go on.</div>}
      {mode === 'ask' && <div className="tiny faint">Questions are read-only: the member can look at the code but not change it.</div>}
      {mode === 'backlog' && multiline && (
        <label className="check tiny">
          <input type="checkbox" checked={perLine} onChange={(e) => setPerLine(e.target.checked)} />
          Each line is a goal of its own{splitWithFiles ? ' (files go with one goal: add them to it on its own)' : ''}
        </label>
      )}
    </div>
  );
}
