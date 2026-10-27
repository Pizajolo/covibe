import { useEffect, useState } from 'react';
import { desktop } from './api';
import { Composer } from './components/Composer';
import { IconFolder, IconGear, IconHome, IconPlus, IconRuns, IconSparkle, IconTeam } from './components/icons';
import { ProjectPage } from './pages/ProjectPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NewProjectWizard } from './components/NewProjectWizard';
import { QuestionPopup } from './components/Notifications';
import { Modal } from './components/ui';
import { go, href, useData, useRoute } from './data';
import { Home } from './pages/Home';
import { Projects } from './pages/Projects';
import { RunView } from './pages/RunView';
import { Runs } from './pages/Runs';
import { Settings } from './pages/Settings';
import { Skills } from './pages/Skills';
import { TeamEditor } from './pages/TeamEditor';
import { Teams } from './pages/Teams';

if (desktop) document.body.classList.add('desktop');

export function App() {
  const route = useRoute();
  const { overview, connected, error } = useData();
  const [composer, setComposer] = useState(false);
  const [wizard, setWizard] = useState(false);
  useEffect(() => {
    const open = () => setWizard(true);
    window.addEventListener('covibe:new-project', open);
    return () => window.removeEventListener('covibe:new-project', open);
  }, []);
  const section = route[0] ?? '';
  const running = overview?.runs.filter((r) => r.status === 'running') ?? [];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setComposer(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  let page;
  if (section === 'runs' && route[1] && route[2]) page = <RunView projectId={route[1]} runId={route[2]} tab={route[3]} />;
  else if (section === 'runs') page = <Runs />;
  else if (section === 'teams' && route[1]) page = <TeamEditor teamId={route[1]} tab={route[2]} />;
  else if (section === 'teams') page = <Teams />;
  else if (section === 'projects' && route[1]) page = <ProjectPage projectId={route[1]} tab={route[2]} />;
  else if (section === 'projects') page = <Projects />;
  else if (section === 'skills') page = <Skills tab={route[1]} name={route[2]} />;
  else if (section === 'settings') page = <Settings />;
  else page = <Home onNewGoal={() => setComposer(true)} />;

  const nav = (id: string, label: string, icon: React.ReactNode, extra?: React.ReactNode) => (
    <a className={`nav-item ${section === id ? 'active' : ''}`} href={href(id)}>
      {icon}
      {label}
      {extra}
    </a>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="brand">
          <img src="/icon.svg" alt="" />
          covibe
        </div>
        <button className="btn primary" style={{ margin: '0 4px 10px' }} onClick={() => setComposer(true)}>
          <IconPlus /> New goal
        </button>
        {nav('', 'Home', <IconHome />)}
        {nav('runs', 'Runs', <IconRuns />, running.length ? <span className="count">{running.length} live</span> : null)}
        {nav('teams', 'Teams', <IconTeam />, <span className="count">{overview?.teams.length ?? ''}</span>)}
        {nav('projects', 'Projects', <IconFolder />, <span className="count">{overview?.projects.length ?? ''}</span>)}
        {nav('skills', 'Skills', <IconSparkle />)}
        {nav('settings', 'Settings', <IconGear />)}

        {running.length > 0 && (
          <>
            <div className="nav-section">Working now</div>
            {running.slice(0, 6).map((r) => (
              <a key={r.id} className="nav-item" href={href('runs', r.projectId, r.id)} title={r.paused ? `${r.goal} (paused: a question waits for you)` : r.goal}>
                <span className={`dot ${r.paused ? 'asking' : 'working'}`} />
                <span className="ellipsis">{r.goal}</span>
              </a>
            ))}
          </>
        )}
        <div className="sidebar-foot">
          <span className={`dot ${connected ? 'done' : 'waiting'}`} />
          {error ? 'Cannot reach covibe' : connected ? 'Live' : 'Connecting…'}
        </div>
      </aside>
      <main className="main">
        <ErrorBoundary resetKey={route.join('/')}>{page}</ErrorBoundary>
      </main>
      <QuestionPopup />
      {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
      {composer && (
        <Modal title="What should the team do?" onClose={() => setComposer(false)} wide>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer autoFocus onDone={() => setComposer(false)} />
          </div>
          {!overview?.projects.length && (
            <p className="small muted">
              First <a onClick={() => (setComposer(false), setWizard(true))}>set up a project</a>.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
