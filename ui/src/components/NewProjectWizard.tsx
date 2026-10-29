import { useState } from 'react';
import { ApiError, desktop, get, post, type Project, type Template, type TeamListing } from '../api';
import { go, useData, useLive } from '../data';
import { Composer } from './Composer';
import { DesignChat } from './DesignChat';
import { IconAlert, IconBranch, IconCheck, IconChat, IconFolder, IconPlus, IconTeam } from './icons';
import { Modal, useAction } from './ui';

type Source = 'open' | 'clone' | 'empty';
type TeamMode = 'existing' | 'template' | 'chat';

/** New project → its team → the first goal, in one flow. */
export function NewProjectWizard({ onClose }: { onClose: () => void }) {
  const { overview, refresh } = useData();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [project, setProject] = useState<Project | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);

  const finish = () => {
    onClose();
    if (project) go('projects', project.id);
  };

  return (
    <Modal
      wide
      title={
        <div className="col" style={{ gap: 6 }}>
          <span>{step === 1 ? 'Where is the work?' : step === 2 ? `Who works on ${project?.name}?` : 'What should they do first?'}</span>
          <div className="wizard-steps">
            {['Project', 'Team', 'First goal'].map((label, i) => (
              <span key={label} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>
                {i + 1 < step ? '✓ ' : `${i + 1}. `}
                {label}
                {i < 2 ? ' →' : ''}
              </span>
            ))}
          </div>
        </div>
      }
      onClose={onClose}
    >
      {step === 1 && (
        <ProjectStep
          defaultParent={overview?.defaultParent ?? '~/Projects'}
          onDone={async (p) => {
            setProject(p);
            await refresh();
            setStep(2);
          }}
        />
      )}
      {step === 2 && project && (
        <TeamStep
          project={project}
          teams={(overview?.teams ?? []).filter((t) => t.valid)}
          teamId={teamId}
          onTeam={setTeamId}
          onNext={async () => {
            await refresh();
            setStep(3);
          }}
        />
      )}
      {step === 3 && project && teamId && (
        <div className="col" style={{ gap: 12 }}>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer fixedProject={project.id} fixedTeam={teamId} autoFocus onDone={onClose} />
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => setStep(2)}>
              Back
            </button>
            <span className="grow" />
            <button className="btn" onClick={finish}>
              Not now, open the project
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function FolderField({ label, value, onChange, help, placeholder }: { label: string; value: string; onChange: (v: string) => void; help?: string; placeholder?: string }) {
  return (
    <label className="field">
      {label}
      <div className="row">
        <input className="input mono" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {desktop && (
          <button
            className="btn"
            onClick={async (e) => {
              e.preventDefault();
              const p = await desktop!.pickFolder();
              if (p) onChange(p);
            }}
          >
            Choose…
          </button>
        )}
      </div>
      {help && <span className="help">{help}</span>}
    </label>
  );
}

function ProjectStep({ defaultParent, onDone }: { defaultParent: string; onDone: (p: Project) => void }) {
  const [source, setSource] = useState<Source>('open');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(defaultParent);
  const [name, setName] = useState('');
  const [needsGit, setNeedsGit] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);

  /** `as`: what to do with a folder that has no git yet: set git up, or use it as a plain folder. */
  const [submit, busy] = useAction(async (as?: 'git' | 'folder') => {
    try {
      const p =
        source === 'open'
          ? await post<Project>('/api/projects', { path, init: as === 'git', folder: as === 'folder' })
          : source === 'clone'
            ? await post<Project>('/api/projects/clone', { url, parent, name: name || undefined })
            : await post<Project>('/api/projects/create', { parent, name, folder: plain });
      onDone(p);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setNeedsGit(err.message);
      else throw err;
    }
  });

  const ready = source === 'open' ? !!path.trim() : source === 'clone' ? !!url.trim() && !!parent.trim() : !!name.trim() && !!parent.trim();
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="choice-grid">
        <button className={`choice ${source === 'open' ? 'on' : ''}`} onClick={() => (setSource('open'), setNeedsGit(null))}>
          <IconFolder />
          <strong>Open a folder</strong>
          <span className="tiny faint">Code, documents, footage: any folder on this Mac.</span>
        </button>
        <button className={`choice ${source === 'clone' ? 'on' : ''}`} onClick={() => setSource('clone')}>
          <IconBranch />
          <strong>Clone a repository</strong>
          <span className="tiny faint">From GitHub or any git URL.</span>
        </button>
        <button className={`choice ${source === 'empty' ? 'on' : ''}`} onClick={() => setSource('empty')}>
          <IconPlus />
          <strong>Start from scratch</strong>
          <span className="tiny faint">A new, empty folder.</span>
        </button>
      </div>

      {source === 'open' && <FolderField label="Folder" value={path} onChange={(v) => (setPath(v), setNeedsGit(null))} placeholder="~/code/my-app" />}
      {source === 'clone' && (
        <>
          <label className="field">
            Repository URL
            <input className="input mono" autoFocus value={url} placeholder="https://github.com/owner/repo" onChange={(e) => setUrl(e.target.value)} />
            <span className="help">Private repositories work if git on this Mac can already clone them.</span>
          </label>
          <div className="grid grid-2">
            <FolderField label="Clone into" value={parent} onChange={setParent} />
            <label className="field">
              Folder name (optional)
              <input className="input mono" value={name} placeholder="same as the repository" onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {source === 'empty' && (
        <div className="grid grid-2">
          <label className="field">
            Project name
            <input className="input" autoFocus value={name} placeholder="my-new-app" onChange={(e) => setName(e.target.value)} />
          </label>
          <FolderField label="Create it in" value={parent} onChange={setParent} />
          <label className="check small" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} /> Plain folder, without git (for documents, media or research rather than code)
          </label>
        </div>
      )}

      {needsGit && (
        <div className="banner warn">
          <IconAlert />
          <div className="col" style={{ gap: 8 }}>
            <span>
              {needsGit} Use it as it is, or set up git:
            </span>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                <strong>Plain folder</strong> (documents, footage, research): the team works in the folder itself. covibe records what each member changes and keeps the
                originals, so you can review a run and undo it.
              </li>
              <li>
                <strong>Git</strong> (code): covibe runs <span className="mono">git init</span> and commits what is in the folder, leaving out{' '}
                <span className="mono">node_modules</span>, <span className="mono">.env</span> files and build folders. Teams then work on their own branches and never touch
                your files until you merge.
              </li>
            </ul>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary sm" disabled={busy} onClick={() => void submit('folder')}>
                Use it as a plain folder
              </button>
              <button className="btn sm" disabled={busy} onClick={() => void submit('git')}>
                Set up git
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="row">
        <span className="grow" />
        <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? (source === 'clone' ? 'Cloning…' : 'Adding…') : 'Continue'}
        </button>
      </div>
    </div>
  );
}

function TeamStep({ project, teams, teamId, onTeam, onNext }: { project: Project; teams: TeamListing[]; teamId: string | null; onTeam: (id: string | null) => void; onNext: () => void }) {
  const [mode, setMode] = useState<TeamMode>(teams.length ? 'existing' : 'template');
  const { value: templates } = useLive(() => get<Template[]>('/api/templates'), []);
  const [template, setTemplate] = useState('build-and-review');
  const [valid, setValid] = useState(false);
  const [create, creating] = useAction(async () => {
    const t = await post<TeamListing>('/api/teams', { name: `${project.name} team`, template });
    onTeam(t.id);
    onNext();
  });
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="choice-grid">
        <button className={`choice ${mode === 'existing' ? 'on' : ''}`} disabled={!teams.length} onClick={() => setMode('existing')}>
          <IconTeam />
          <strong>Use a team I have</strong>
          <span className="tiny faint">{teams.length ? `${teams.length} ready` : 'You have no teams yet'}</span>
        </button>
        <button className={`choice ${mode === 'template' ? 'on' : ''}`} onClick={() => setMode('template')}>
          <IconPlus />
          <strong>Start from a template</strong>
          <span className="tiny faint">Adjust it later in the team editor.</span>
        </button>
        <button className={`choice ${mode === 'chat' ? 'on' : ''}`} onClick={() => setMode('chat')}>
          <IconChat />
          <strong>Design it with chat</strong>
          <span className="tiny faint">Describe what you need; Claude sets it up for this project.</span>
        </button>
      </div>

      {mode === 'existing' && (
        <div className="card" style={{ boxShadow: 'none' }}>
          <div className="list">
            {teams.map((t) => (
              <label key={t.id} className={`list-row clickable ${teamId === t.id ? 'selected' : ''}`}>
                <input type="radio" checked={teamId === t.id} onChange={() => onTeam(t.id)} style={{ accentColor: 'var(--accent)' }} />
                <div className="col grow" style={{ gap: 1 }}>
                  <strong>{t.name}</strong>
                  <span className="tiny faint">
                    {t.agents.join(', ')} · {t.steps.join(' → ')}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
      {mode === 'template' && (
        <div className="col">
          {(templates ?? []).map((t) => (
            <label key={t.id} className={`template ${template === t.id ? 'on' : ''}`}>
              <input type="radio" checked={template === t.id} onChange={() => setTemplate(t.id)} style={{ accentColor: 'var(--accent)', marginTop: 2 }} />
              <div className="col" style={{ gap: 2 }}>
                <strong>{t.name}</strong>
                <span className="small muted">{t.description}</span>
              </div>
            </label>
          ))}
        </div>
      )}
      {mode === 'chat' && (
        <DesignChat
          projectId={project.id}
          name={`${project.name} team`}
          height={420}
          onTeam={(id, ok) => {
            onTeam(id);
            setValid(ok);
          }}
        />
      )}

      <div className="row">
        <span className="grow" />
        {mode === 'existing' && (
          <button className="btn primary" disabled={!teamId} onClick={onNext}>
            Continue
          </button>
        )}
        {mode === 'template' && (
          <button className="btn primary" disabled={creating} onClick={() => void create()}>
            Create team and continue
          </button>
        )}
        {mode === 'chat' && (
          <button className="btn primary" disabled={!teamId || !valid} onClick={onNext} title={!valid ? 'Waiting for the architect to save a valid team' : ''}>
            {valid ? (
              <>
                <IconCheck /> Use this team
              </>
            ) : (
              'Waiting for a valid team…'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
