import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentState, MemberInfo, RunSummary } from '../api';
import { money } from '../format';
import { drawPortrait, drawScene, figureFor, kindOf, layout, spotBox, W, type BoardStep, type DeskState, type Figure, type Scene } from './office-art';
import { IconBrowser } from './icons';
import { DESK_HELP, DESK_LABEL, deskNote, deskQuestion, deskState } from './office-state';

export { DESK_LABEL, deskNote, deskState, questionDesk } from './office-state';
export type { DeskState } from './office-art';

/** Light or dark, following the app's theme. */
export function useDark(): boolean {
  const query = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const read = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : query.matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const on = () => setDark(read());
    query.addEventListener('change', on);
    const watch = new MutationObserver(on);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      query.removeEventListener('change', on);
      watch.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return dark;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Call draw(time) about 20 times a second while mounted (time stays 0 with reduced motion). */
function useAnimation(draw: (t: number) => void) {
  const ref = useRef(draw);
  ref.current = draw;
  useEffect(() => {
    const still = reducedMotion();
    let raf = 0;
    let last = -Infinity;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 50) return;
      last = now;
      ref.current(still ? 0 : now);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Each member's look: color from its place in the roster (like its avatar), role from its name. */
export function useFigures(run: RunSummary, members: MemberInfo[]): Map<string, Figure> {
  const dark = useDark();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const byName = new Map(members.map((m) => [m.name, m]));
    return new Map(
      run.agents.map((a, i) => {
        const m = byName.get(a.name);
        const color = (i < 8 && css.getPropertyValue(`--series-${i + 1}`).trim()) || '#86857e';
        return [a.name, figureFor(a.name, color, kindOf(a.name, m?.description, m?.lead))];
      }),
    );
  }, [run.agents, members, dark]);
}

function boardFor(run: RunSummary): Scene['board'] {
  const steps: BoardStep[] = run.steps.map((s) => ({
    label: s.id,
    status: s.status === 'running' ? 'now' : s.status === 'failed' ? 'failed' : s.status === 'pending' ? 'next' : 'done',
  }));
  // Room for six steps: keep the current one in view.
  const at = Math.max(0, steps.findIndex((s) => s.status === 'now' || s.status === 'next'));
  const start = Math.min(Math.max(0, at - 2), Math.max(0, steps.length - 6));
  const live = run.status === 'running';
  const [status, statusTone]: [string, Scene['board']['statusTone']] = run.paused
    ? ['paused', 'warn']
    : live
      ? ['working', 'ink']
      : run.status === 'succeeded'
        ? ['done', 'good']
        : run.status === 'escalated'
          ? ['needs you', 'warn']
          : ['stopped', 'bad'];
  return {
    status,
    statusTone,
    steps: steps.slice(start, start + 6),
    cost: money(run.costUsd),
    footLeft: run.maxLoops !== undefined || run.loops ? `loop ${run.loops}/${run.maxLoops ?? '?'}` : '',
    footRight: run.paused ? 'waiting for you' : run.status === 'succeeded' ? 'all gates passed' : '',
    footTone: run.paused ? 'warn' : 'good',
  };
}

/**
 * The run as an office: a desk per member with a name plate. Members sleep
 * when idle, type when working, raise a hand when they ask, and wait with
 * their hands off the keyboard while the run is paused. Click a desk to open
 * that member.
 */
export function OfficeStage({
  run,
  members,
  answering,
  selected,
  onSelect,
  onQuestion,
  onBrowser,
  children,
}: {
  run: RunSummary;
  members: MemberInfo[];
  answering: string[];
  selected?: string;
  onSelect: (name: string) => void;
  /** Open a question for you; its desk (the lead's, usually) shows a question mark. */
  onQuestion?: (id: number) => void;
  /** Open what a member sees in its browser; members using one show a browser button. */
  onBrowser?: (name: string) => void;
  /** Shown under the room, at its width. */
  children?: React.ReactNode;
}) {
  const dark = useDark();
  const figures = useFigures(run, members);
  const { h, spots } = layout(run.agents.length);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hovered = useRef<string | undefined>(undefined);
  const desks = run.agents.map((a, i) => {
    const state = deskState(a, run, answering.includes(a.name));
    const busy = answering.includes(a.name);
    // The browser button shows while the member's latest turn uses a browser and the run (or a chat) is live.
    const browsing = !!a.browser && (busy || (run.status === 'running' && state !== 'sleeping'));
    return { agent: a, state, note: deskNote(a, state, run), question: deskQuestion(a, run), browsing, ...spots[i]! };
  });
  const scene: Scene = {
    w: W,
    h,
    desks: desks.map((d) => ({ fig: figures.get(d.agent.name)!, state: d.state, cx: d.cx, by: d.by })),
    board: boardFor(run),
    selected,
    dark,
  };
  useAnimation((t) => {
    const c = canvas.current?.getContext('2d');
    if (c) drawScene(c, { ...scene, hovered: hovered.current }, t);
  });

  return (
    <div className="office-room" style={{ ['--ratio' as string]: W / h }}>
      <div className="office-stage" style={{ aspectRatio: `${W} / ${h}` }}>
        <canvas ref={canvas} width={W} height={h} aria-hidden />
        {onQuestion &&
          desks.map(
            (d) =>
              d.question && (
                <button
                  key={`ask-${d.agent.name}`}
                  className="office-ask"
                  aria-label={`${d.question.from} asks you: ${d.question.forHuman ?? d.question.question}. Answer`}
                  title={`${d.question.from} asks you: ${d.question.forHuman ?? d.question.question}`}
                  // Over the thought bubble beside the head (see stateBubble in office-art).
                  style={{ left: `${((d.cx - 17) / W) * 100}%`, top: `${((d.by - 23) / h) * 100}%` }}
                  onClick={() => onQuestion(d.question!.id)}
                >
                  ?
                </button>
              ),
          )}
        {onBrowser &&
          desks.map(
            (d) =>
              d.browsing && (
                <button
                  key={`web-${d.agent.name}`}
                  className={`office-web ${d.agent.lastView ? 'seen' : ''}`}
                  aria-label={`${d.agent.name} is using a browser${d.agent.browser?.url ? ` on ${d.agent.browser.url}` : ''}. See what it sees`}
                  title={`What ${d.agent.name} sees${d.agent.browser?.url ? ` · ${d.agent.browser.url}` : ''}`}
                  // Right of the head, opposite the thought bubble.
                  style={{ left: `${((d.cx + 19) / W) * 100}%`, top: `${((d.by - 23) / h) * 100}%` }}
                  onClick={() => onBrowser(d.agent.name)}
                >
                  <IconBrowser />
                </button>
              ),
          )}
        {desks.map((d) => {
          const box = spotBox(d.cx, d.by);
          return (
            <button
              key={d.agent.name}
              className="office-spot"
              data-state={d.state}
              aria-pressed={selected === d.agent.name}
              aria-label={`${d.agent.name}: ${DESK_LABEL[d.state]}, ${d.note}. Open details`}
              title={`${d.agent.name} · ${d.note}`}
              style={{ left: `${(box.x / W) * 100}%`, top: `${(box.y / h) * 100}%`, width: `${(box.w / W) * 100}%`, height: `${(box.h / h) * 100}%` }}
              onClick={() => onSelect(d.agent.name)}
              onPointerEnter={() => (hovered.current = d.agent.name)}
              onPointerLeave={() => (hovered.current = undefined)}
              onFocus={() => (hovered.current = d.agent.name)}
              onBlur={() => (hovered.current = undefined)}
            >
              <span className="office-plate" style={{ top: `${((box.plateTop - box.y) / box.h) * 100}%` }}>
                <span className="role">{d.agent.name}</span>
                <span className="note">
                  <i />
                  <span>{d.note}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

/** What the desk states mean, with a small animated member for each. */
export function OfficeLegend({ figure, states }: { figure?: Figure; states: DeskState[] }) {
  return (
    <div className="office-legend">
      {states.map((s) => (
        <div key={s} className="item" title={DESK_HELP[s]}>
          {figure ? <Portrait figure={figure} state={s} small /> : null}
          <span className={`desk-pill ${s}`}>
            <i />
            {DESK_LABEL[s]}
          </span>
          <span className="help">{DESK_HELP[s]}</span>
        </div>
      ))}
    </div>
  );
}

/** A member at its desk, head and shoulders, animated. */
export function Portrait({ figure, state, small }: { figure: Figure; state: DeskState; small?: boolean }) {
  const dark = useDark();
  const canvas = useRef<HTMLCanvasElement>(null);
  useAnimation((t) => {
    const c = canvas.current?.getContext('2d');
    if (c) drawPortrait(c, figure, state, t, dark);
  });
  return <canvas ref={canvas} className={`office-portrait ${small ? 'small' : ''}`} width={44} height={34} aria-hidden />;
}

export function DeskPill({ state }: { state: DeskState }) {
  return (
    <span className={`desk-pill ${state}`}>
      <i />
      {DESK_LABEL[state]}
    </span>
  );
}
