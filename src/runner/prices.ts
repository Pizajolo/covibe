import type { Pricing } from '../connections/types.js';

// Claude list prices in USD per million tokens, for the live spend estimate
// while a turn runs. When the turn ends, Claude Code's own figure (which also
// knows about 1-hour cache writes, fast mode and organization rates) replaces
// the estimate. Cache reads default to a tenth of input, cache writes to 1.25×.
const CLAUDE: [match: string, price: Pricing][] = [
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['fable-5', { input: 10, output: 50 }],
  ['mythos-5', { input: 10, output: 50 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25 }],
  ['opus-4-8', { input: 5, output: 25 }],
  ['opus-4-7', { input: 5, output: 25 }],
  ['opus-4-6', { input: 5, output: 25 }],
  ['opus-4-5', { input: 5, output: 25 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-5', { input: 2, output: 10 }],
  ['sonnet-4', { input: 3, output: 15 }],
  ['haiku-5-5', { input: 0.1, output: 0.5 }],
  ['haiku-4-5', { input: 1, output: 5 }],
];

/** List prices for a Claude model id (any provider spelling, e.g. "us.anthropic.claude-opus-5-5"), if known. */
export function claudePrice(model: string | undefined): Pricing | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  // The table lists longer names first, so "opus-5-5" wins over "opus-5".
  const p = CLAUDE.find(([key]) => m.includes(key))?.[1];
  return p && { ...p, cacheRead: p.cacheRead ?? p.input / 10, cacheWrite: p.cacheWrite ?? p.input * 1.25 };
}
