import { useState } from 'react';
import { get, type RunSummary } from '../api';
import { IconRuns } from '../components/icons';
import { RunRow } from '../components/RunCard';
import { Toolbar } from '../components/Toolbar';
import { Empty } from '../components/ui';
import { useData, useLive } from '../data';

const FILTERS = [
  ['all', 'All'],
  ['running', 'Live'],
  ['escalated', 'Needs you'],
  ['succeeded', 'Succeeded'],
  ['failed', 'Failed'],
  ['ask', 'Questions'],
] as const;

export function Runs() {
  const { overview } = useData();
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const { value: runs } = useLive(() => get<RunSummary[]>(`/api/runs?limit=300${project ? `&project=${project}` : ''}`), [project], () => true);

  const shown = (runs ?? []).filter(
    (r) =>
      (filter === 'all' || (filter === 'ask' ? r.kind === 'ask' : r.status === filter && r.kind !== 'ask')) &&
      (!q || `${r.goal} ${r.team} ${r.projectName}`.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <>
      <Toolbar title="Runs" sub={`${runs?.length ?? 0} runs and questions`}>
        <input className="input" placeholder="Search goals…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      </Toolbar>
      <div className="content">
        <div className="page">
          <div className="row wrap">
            <div className="seg">
              {FILTERS.map(([id, label]) => (
                <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="grow" />
            <select className="input" style={{ width: 200 }} value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects</option>
              {overview?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="card">
            {shown.length ? (
              <div className="list">
                {shown.map((r) => (
                  <RunRow key={`${r.projectId}/${r.id}`} run={r} />
                ))}
              </div>
            ) : (
              <Empty icon={<IconRuns />} title={runs ? 'Nothing here' : 'Loading…'}>
                {runs ? 'Runs from the app and from the covibe command line both show up here.' : ''}
              </Empty>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
