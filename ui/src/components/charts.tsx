import { useEffect, useRef, useState } from 'react';

/** Width of a container, tracked with ResizeObserver. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp;
}

/** A bar with 4px rounded top corners, anchored square to the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

/** Single-series vertical bars with a hover tooltip per bar. The title names the series, so no legend. */
export function BarChart({ data, height = 160, format, ariaLabel }: { data: BarDatum[]; height?: number; format: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const left = 44;
  const bottom = 20;
  const top = 8;
  const plotW = Math.max(0, width - left);
  const plotH = height - bottom - top;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const step = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(28, step - Math.max(2, step * 0.3)));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));

  return (
    <div className="chart" ref={ref} role="img" aria-label={ariaLabel}>
      {width > 0 && (
        <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
          <g className="axis">
            {ticks.map((t) => {
              const y = top + plotH - (t / max) * plotH;
              return (
                <g key={t}>
                  <line className="gridline" x1={left} x2={width} y1={y} y2={y} />
                  <text x={left - 8} y={y + 3} textAnchor="end">
                    {format(t)}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) =>
              // Count back from the newest bar so the latest label is always shown and never crowded.
              (data.length - 1 - i) % labelEvery === 0 ? (
                <text key={d.key} x={left + step * i + step / 2} y={height - 4} textAnchor="middle">
                  {d.label}
                </text>
              ) : null,
            )}
          </g>
          {data.map((d, i) => {
            const h = (d.value / max) * plotH;
            const x = left + step * i + (step - barW) / 2;
            return (
              <g key={d.key} onMouseEnter={() => setHover(i)}>
                <rect className="hit" x={left + step * i} y={top} width={step} height={plotH} />
                <path className={`bar ${hover !== null && hover !== i ? 'dim' : ''}`} d={barPath(x, top + plotH - h, barW, h)} />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="tooltip" style={{ left: left + step * hover + step / 2, top: top + plotH - (data[hover]!.value / max) * plotH }}>
          <div className="t-label">{data[hover]!.label}</div>
          <div className="t-value">{format(data[hover]!.value)}</div>
          {data[hover]!.detail && <div className="t-label">{data[hover]!.detail}</div>}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars with direct value labels (one series). */
export function HBars({ data, format }: { data: { key: string; label: React.ReactNode; value: number; title?: string }[]; format: (v: number) => string }) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div>
      {data.map((d) => (
        <div className="hbar" key={d.key} title={d.title}>
          <div className="ellipsis">{d.label}</div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <div className="num" style={{ textAlign: 'right' }}>
            {format(d.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A usage meter; the status color always comes with a text label. */
export function Meter({ label, fraction, caption, status }: { label: string; fraction?: number; caption?: string; status?: string }) {
  // Without a utilization number, fall back to the status Claude Code reported.
  const level =
    fraction === undefined ? (status === 'rejected' ? 'bad' : status === 'allowed_warning' ? 'warn' : '') : fraction >= 0.9 ? 'bad' : fraction >= 0.7 ? 'warn' : '';
  const state =
    fraction === undefined
      ? status === 'rejected' ? 'Limit reached' : status === 'allowed_warning' ? 'Getting close' : status ? 'OK' : ''
      : fraction >= 0.9 ? 'Nearly used up' : fraction >= 0.7 ? 'Getting close' : 'OK';
  return (
    <div className="meter">
      <div className="row small">
        <span className="grow">{label}</span>
        <span className="num">{fraction === undefined ? '—' : `${Math.round(fraction * 100)}%`}</span>
      </div>
      <div className="meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === undefined ? undefined : Math.round(fraction * 100)} aria-label={label}>
        <div className={`meter-fill ${level}`} style={{ width: `${Math.min(100, (fraction ?? 0) * 100)}%` }} />
      </div>
      <div className="tiny faint">
        {state && <strong style={{ color: level === 'bad' ? 'var(--bad)' : level === 'warn' ? 'var(--warn)' : 'var(--text-2)' }}>{state}</strong>}
        {state && caption ? ' · ' : ''}
        {caption}
      </div>
    </div>
  );
}
