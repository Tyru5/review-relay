/**
 * What a reviewer's run cost: the tokens its CLI reported and their price. A CLI that reports its own cost (Claude
 * Code) is taken at its word; otherwise the tokens are priced from a per-model table, and the cost is an estimate.
 */

export interface Usage {
  /** Every input token, cached ones included. */
  inputTokens: number;
  /** Input read from the prompt cache; part of `inputTokens`. */
  cachedInputTokens: number;
  /** Input written to the prompt cache; part of `inputTokens`. */
  cacheWriteTokens: number;
  /** Output tokens, reasoning included. */
  outputTokens: number;
  /** USD. Unset when the CLI reported no cost and the model has no price. */
  costUsd?: number;
  /** `reported`: the CLI's own figure. `estimated`: the tokens at the model's price. */
  costSource?: 'reported' | 'estimated';
}

/** USD per million tokens. Cached reads and cache writes cost the input rate when unset. */
export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

/**
 * List prices (standard tier) for models whose CLI reports tokens but no cost. `pricing` in the config adds models
 * and overrides these. Long-context surcharges aren't modeled, so very large prompts cost somewhat more than this says.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
};

export const PRICE_FIELDS = ['input', 'output', 'cachedInput', 'cacheWrite'] as const;

/** The tokens at `price`, in USD. */
export function estimateCost(usage: Usage, price: Price): number {
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
  return (
    (fresh * price.input +
      usage.cachedInputTokens * (price.cachedInput ?? price.input) +
      usage.cacheWriteTokens * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** Settles the cost: the CLI's own when it reported one, else an estimate when the model has a price. */
export function priced(usage: Usage, model: string | undefined, prices: Record<string, Price>): Usage {
  if (usage.costUsd !== undefined) return { ...usage, costSource: 'reported' };
  const price = model === undefined ? undefined : prices[model];
  return price ? { ...usage, costUsd: estimateCost(usage, price), costSource: 'estimated' } : usage;
}

/** The sum of some reviewers' costs. */
export interface CostTotal {
  costUsd: number;
  /** Some part of it is an estimate. */
  estimated: boolean;
  /** Some reviewer has no cost (no usage reported, or an unpriced model), so the true total is higher. */
  partial: boolean;
}

/** The total of the costs that are known; null when none is. */
export function totalCost(usages: (Usage | undefined)[]): CostTotal | null {
  const known = usages.filter((u): u is Usage & { costUsd: number } => u?.costUsd !== undefined);
  if (known.length === 0) return null;
  return {
    costUsd: known.reduce((sum, u) => sum + u.costUsd, 0),
    estimated: known.some((u) => u.costSource === 'estimated'),
    partial: known.length < usages.length,
  };
}

/** Adds two totals; either may be null. */
export function addCost(a: CostTotal | null, b: CostTotal | null): CostTotal | null {
  if (!a || !b) return a ?? b;
  return { costUsd: a.costUsd + b.costUsd, estimated: a.estimated || b.estimated, partial: a.partial || b.partial };
}

/** `$1.84`, or `<$0.01` for a cost under a cent. */
export const fmtUsd = (usd: number) => (usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** `~$1.84` for an estimate, `$1.84+` when some of it is unknown. */
export const fmtCost = (cost: { costUsd: number; estimated?: boolean; partial?: boolean }) =>
  `${cost.estimated ? '~' : ''}${fmtUsd(cost.costUsd)}${cost.partial ? '+' : ''}`;

/** `850`, `412k`, `1.2M`. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A reviewer's cost and tokens in one cell: `~$0.62 · 288k in/9k out`, or just the tokens when unpriced. */
export function fmtUsage(usage: Usage): string {
  const tokens = `${fmtTokens(usage.inputTokens)} in/${fmtTokens(usage.outputTokens)} out`;
  return usage.costUsd === undefined
    ? tokens
    : `${fmtCost({ costUsd: usage.costUsd, estimated: usage.costSource === 'estimated' })} · ${tokens}`;
}

/**
 * A usage as a report recorded it, with the cost it was given then. One recorded without a cost (its model had no
 * price at the time) is priced from `prices` now, so adding a price to the config covers earlier reviews too.
 */
export function recordedUsage(
  raw: unknown,
  model: string | undefined,
  prices: Record<string, Price> = DEFAULT_PRICES,
): Usage | undefined {
  const usage = readUsage(raw);
  return usage && usage.costUsd === undefined ? priced(usage, model, prices) : usage;
}

/** A usage record read back from a report, or undefined when it is missing or malformed. */
export function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const count = (key: string) => (typeof u[key] === 'number' && Number.isFinite(u[key]) ? (u[key] as number) : 0);
  const usage: Usage = {
    inputTokens: count('inputTokens'),
    cachedInputTokens: count('cachedInputTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    outputTokens: count('outputTokens'),
  };
  if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd)) {
    usage.costUsd = u.costUsd;
    usage.costSource = u.costSource === 'estimated' ? 'estimated' : 'reported';
  }
  return usage;
}
