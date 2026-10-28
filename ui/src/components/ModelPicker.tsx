// Model, effort and thinking for a member, a team's defaults or the team
// architect. The model list comes from Claude Code (what this account can use),
// with the effort levels each model supports, followed by the models of the
// providers set up in Settings → Advanced.
import { useEffect, useState } from 'react';
import { get, type Effort, type EnvironmentInfo, type ModelChoice, type Thinking } from '../api';
import { KIND_LABEL, useConnections } from './Connections';

const FALLBACK: ModelChoice[] = [
  {
    value: 'opus',
    name: 'Opus',
    description: 'Strongest, for planning and hard problems',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    adaptiveThinking: true,
  },
  { value: 'sonnet', name: 'Sonnet', description: 'Balanced, good for building', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], adaptiveThinking: true },
  { value: 'haiku', name: 'Haiku', description: 'Fast and cheap, for simple checks', efforts: [], adaptiveThinking: false },
];

export const EFFORTS: { value: Effort; label: string; help: string }[] = [
  { value: 'low', label: 'Low', help: 'Quick answers, fewest tokens' },
  { value: 'medium', label: 'Medium', help: 'Some care, still economical' },
  { value: 'high', label: 'High', help: 'Careful work, the usual choice' },
  { value: 'xhigh', label: 'Extra high', help: 'More thinking for hard tasks' },
  { value: 'max', label: 'Max', help: 'Deepest and slowest, most tokens' },
];

let cache: Promise<ModelChoice[]> | undefined;

/** What Claude Code offers this account (read once per app start; the built-in list until it arrives). */
export function useModels(): ModelChoice[] {
  const [models, setModels] = useState<ModelChoice[]>(FALLBACK);
  useEffect(() => {
    cache ??= get<EnvironmentInfo>('/api/environment')
      .then((e) => (e.models?.length ? e.models : FALLBACK))
      .catch(() => FALLBACK);
    let live = true;
    void cache.then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, []);
  return models;
}

export interface ModelSettings {
  model?: string;
  effort?: Effort;
  thinking?: Thinking;
}

/** A provider's model, chosen in place of a Claude model. */
export interface ProviderChoice {
  id: string;
  model: string;
}

const SEP = '\u0001';
const providerValue = (c: { id: string; model?: string }) => `conn${SEP}${c.id}${SEP}${c.model ?? ''}`;

/**
 * Three fields: model, effort, thinking. Empty means "inherit" (the team
 * default, or Claude Code's default); `inherit` names what that is.
 */
export function ModelPicker({
  value,
  onChange,
  inherit,
  compact,
  provider,
  onProvider,
}: {
  value: ModelSettings;
  onChange: (key: keyof ModelSettings, v: string | number | null) => void;
  inherit: string;
  /** Model and effort only. */
  compact?: boolean;
  /** The provider model in use (the member's or team's connection), if any. */
  provider?: { id: string; model?: string };
  /** Offer the providers' models; called when one is chosen. */
  onProvider?: (c: ProviderChoice) => void;
}) {
  const models = useModels();
  const connections = useConnections();
  const providers = onProvider ? (connections?.connections ?? []).filter((c) => c.kind !== 'claude' && c.models?.length) : [];
  const known = provider ? undefined : models.find((m) => m.value === value.model || m.resolved === value.model);
  const custom = !provider && !!value.model && !known;
  const [customOpen, setCustomOpen] = useState(custom);
  const levels = known ? known.efforts : EFFORTS.map((e) => e.value);
  const budget = typeof value.thinking === 'number';
  const providerListed = provider && providers.some((c) => c.id === provider.id && c.models?.some((m) => m.id === provider.model));
  const claudeOptions = models.map((m) => (
    <option key={m.value} value={m.value}>
      {m.name}
      {m.description ? `: ${m.description}` : ''}
    </option>
  ));

  return (
    <div className={`model-picker ${compact ? 'compact' : ''}`}>
      <label className="field">
        Model
        <select
          className="input"
          value={provider ? providerValue(provider) : customOpen || custom ? '__custom' : (known?.value ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith(`conn${SEP}`)) {
              const [, id, model] = v.split(SEP);
              setCustomOpen(false);
              return onProvider?.({ id: id!, model: model! });
            }
            setCustomOpen(v === '__custom');
            if (v !== '__custom') onChange('model', v || null);
          }}
        >
          <option value="">{inherit}</option>
          {providers.length ? <optgroup label="Claude">{claudeOptions}</optgroup> : claudeOptions}
          {providers.map((c) => (
            <optgroup key={c.id} label={`${c.label} · ${KIND_LABEL[c.kind]}`}>
              {c.models!.map((m) => (
                <option key={m.id} value={providerValue({ id: c.id, model: m.id })}>
                  {m.name ?? m.id}
                  {m.price ? ` · $${m.price.input}/$${m.price.output} per M` : ''}
                </option>
              ))}
            </optgroup>
          ))}
          {provider && !providerListed && (
            <option value={providerValue(provider)}>
              {provider.model ?? 'no model'} on {provider.id} (not set up)
            </option>
          )}
          <option value="__custom">Other model id…</option>
        </select>
        {!provider && (customOpen || custom) && <IdField value={value.model} onCommit={(v) => onChange('model', v || null)} />}
        {known?.resolved && known.resolved !== known.value && <span className="help mono">{known.resolved}</span>}
        {provider && <span className="help">Runs on {connections?.connections.find((c) => c.id === provider.id)?.label ?? provider.id}, with Claude Code's tools.</span>}
      </label>
      <label className="field">
        Effort
        <select
          className="input"
          value={value.effort ?? ''}
          onChange={(e) => onChange('effort', e.target.value || null)}
          disabled={(!!known && !levels.length && !value.effort) || !!provider}
        >
          <option value="">{provider ? 'Not adjustable for this provider' : known && !levels.length ? 'Not adjustable for this model' : `${inherit} (model's default)`}</option>
          {EFFORTS.filter((e) => levels.includes(e.value) || e.value === value.effort).map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}: {e.help}
              {!levels.includes(e.value) ? ' (not supported by this model)' : ''}
            </option>
          ))}
        </select>
        <span className="help">How much thinking and care goes into each answer. Higher costs more tokens and time.</span>
      </label>
      {!compact && (
        <label className="field">
          Thinking
          <select
            className="input"
            value={budget ? 'budget' : (value.thinking ?? '')}
            disabled={!!provider && value.thinking === undefined}
            onChange={(e) => {
              const v = e.target.value;
              onChange('thinking', v === 'budget' ? 8000 : v || null);
            }}
          >
            <option value="">{inherit}</option>
            <option value="adaptive">
              Adaptive: Claude decides when and how much{known && !known.adaptiveThinking ? ' (not supported by this model)' : ''}
            </option>
            <option value="off">Off: answer without extended thinking</option>
            <option value="budget">Fixed budget (older models)…</option>
          </select>
          {budget && (
            <span className="row" style={{ gap: 6 }}>
              <IdField
                value={String(value.thinking)}
                type="number"
                onCommit={(v) => onChange('thinking', Math.min(128000, Math.max(1024, Number(v) || 8000)))}
              />
              <span className="help">tokens (1,024 to 128,000)</span>
            </span>
          )}
        </label>
      )}
    </div>
  );
}

function IdField({ value, onCommit, type = 'text' }: { value?: string; onCommit: (v: string) => void; type?: string }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <input
      className="input mono"
      type={type}
      value={v}
      placeholder={type === 'number' ? '8000' : 'e.g. claude-opus-5-5'}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value ?? '') && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
