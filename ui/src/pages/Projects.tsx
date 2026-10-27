import { useState } from 'react';
import { del, desktop, post } from '../api';
import { IconFolder, IconPlus, IconTrash } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { Empty, Modal, useAction, useToast } from '../components/ui';
import { useData } from '../data';
import { money } from '../format';

export function Projects() {
  const { overview, refresh } = useData();
  const toast = useToast();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');

  const [add, adding] = useAction(async (p: string) => {
    await post('/api/projects', { path: p });
    await refresh();
    setTyping(false);
    setPath('');
    toast('Project added');
  });
  const [remove] = useAction(async (id: string) => {
    await del(`/api/projects/${id}`);
    await refresh();
  });

  const pick = async () => {
    if (desktop) {
      const p = await desktop.pickFolder();
      if (p) await add(p);
    } else setTyping(true);
  };

  const projects = overview?.projects ?? [];
  const runsFor = (id: string) => overview?.runs.filter((r) => r.projectId === id) ?? [];

  return (
    <>
      <Toolbar title="Projects" sub="Git repositories your teams work on">
        <button className="btn primary" onClick={() => void pick()} disabled={adding}>
          <IconPlus /> Add project
        </button>
      </Toolbar>
      <div className="content">
        <div className="page">
          <div className="card">
            {projects.length ? (
              <div className="list">
                {projects.map((p) => {
                  const runs = runsFor(p.id);
                  return (
                    <div key={p.id} className="list-row">
                      <IconFolder width={20} height={20} style={{ color: 'var(--accent)', flex: 'none' }} />
                      <div className="grow col" style={{ gap: 2 }}>
                        <strong>{p.name}</strong>
                        <span className="tiny faint mono ellipsis">{p.path}</span>
                      </div>
                      <span className="tiny faint num">
                        {runs.length} recent runs · {money(runs.reduce((n, r) => n + r.costUsd, 0))}
                      </span>
                      {desktop && (
                        <button className="btn sm" onClick={() => void desktop!.reveal(p.path)}>
                          Show in Finder
                        </button>
                      )}
                      <button className="btn sm ghost icon-btn" title="Remove from covibe (files are not touched)" onClick={() => void remove(p.id)}>
                        <IconTrash />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty icon={<IconFolder />} title="No projects yet" action={<button className="btn primary" onClick={() => void pick()}><IconPlus /> Add a git repository</button>}>
                A project is a git repository on this Mac. Teams work on their own branches and never touch your checkout.
              </Empty>
            )}
          </div>
          <p className="tiny faint">
            Removing a project only removes it from this list. Run history stays in the repository's <span className="mono">.covibe</span> folder, which covibe keeps out
            of git.
          </p>
        </div>
      </div>
      {typing && (
        <Modal
          title="Add project"
          onClose={() => setTyping(false)}
          footer={
            <>
              <button className="btn" onClick={() => setTyping(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!path.trim() || adding} onClick={() => void add(path.trim())}>
                Add
              </button>
            </>
          }
        >
          <label className="field">
            Folder path
            <input className="input mono" autoFocus placeholder="~/code/my-app" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && void add(path.trim())} />
            <span className="help">A git repository with at least one commit.</span>
          </label>
        </Modal>
      )}
    </>
  );
}
