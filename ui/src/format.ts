export function money(usd: number | null | undefined, digits?: number): string {
  const v = usd ?? 0;
  const d = digits ?? (v === 0 ? 2 : v < 0.1 ? 3 : 2);
  return `$${v.toFixed(d)}`;
}

export function tokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(fromIso: string, toIso?: string): string {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/** "Edit web/app.tsx", "Bash npm test": tool calls in words, with worktree paths made relative. */
export function toolText(tool: string, input: unknown, roots: string[] = []): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url ?? i.query ?? i.to;
  const name = tool.replace(/^mcp__team__/, '');
  if (pick === undefined) return name;
  let shown = String(pick).replace(/\S*\/worktrees\/(?:[^/\s]+\/)?\d{8}-\d{6}-[0-9a-f]{4}\/[^/\s]+\/?/g, '');
  for (const r of roots) shown = shown.split(`${r}/`).join('').split(r).join('.');
  shown = shown.replace(/\s+/g, ' ').trim();
  return `${name} ${shown.length > 160 ? shown.slice(0, 159) + '…' : shown}`;
}

export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Plan utilization may arrive as a fraction (0..1) or a percentage. */
export function utilization(v: number | undefined): number | undefined {
  if (v === undefined || v === null || Number.isNaN(v)) return undefined;
  return v > 1 ? v / 100 : v;
}

export const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly (incl. extra usage)',
  overage: 'Extra usage',
};
