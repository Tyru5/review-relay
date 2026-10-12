/** `review-relay cost`: what each review cost, reviewer by reviewer, read from the reports' `meta.json`. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportDirFor } from './report.ts';
import { activeJob, jobTarget, type JobRecord } from './state.ts';
import { DIM, fmtStarted, renderTable, type Cell, type ReviewerMeta } from './status.ts';
import type { ReviewerId } from './types.ts';
import { row, type Styles } from './ui.ts';
import {
  addCost,
  fmtCost,
  fmtTokens,
  fmtUsage,
  recordedUsage,
  totalCost,
  type CostTotal,
  type Price,
} from './usage.ts';

/** A finished review and what each of its reviewers spent. */
export interface ReviewCost {
  job: JobRecord;
  reviewers: ReviewerMeta[];
  /** Null when no reviewer reported a cost. */
  total: CostTotal | null;
}

function readMeta(dir: string, prices?: Record<string, Price>): ReviewerMeta[] | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    if (!Array.isArray(meta?.reviewers)) return null;
    return (meta.reviewers as ReviewerMeta[]).map((r) => ({ ...r, usage: recordedUsage(r.usage, r.model, prices) }));
  } catch {
    return null;
  }
}

/**
 * The finished jobs that wrote a report, newest first as given; skipped jobs and ones that never ran are left out.
 * `prices` prices usage recorded without a cost.
 */
export function reviewCosts(records: JobRecord[], dataDir: string, prices?: Record<string, Price>): ReviewCost[] {
  return records.flatMap((job) => {
    if (activeJob(job)) return [];
    const reviewers = readMeta(job.reportDir ?? reportDirFor(dataDir, job), prices);
    return reviewers ? [{ job, reviewers, total: totalCost(reviewers.map((r) => r.usage)) }] : [];
  });
}

export interface ReviewerSpend {
  name: ReviewerId;
  /** Reviews it ran in. */
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  cost: CostTotal | null;
}

export interface Spend {
  reviews: number;
  cost: CostTotal | null;
  /** Reviews with a cost; reviews without one (from before costs were recorded, say) aren't in the average. */
  costed: number;
  /** The mean cost of the reviews that have one; null when none has. */
  average: CostTotal | null;
  /** In the order the columns show them: configured reviewers first, then any others the reports name. */
  reviewers: ReviewerSpend[];
  /** Models that reported tokens but have no price, so their runs have no cost. */
  unpriced: string[];
}

/** Reviewer ids in column order: the configured ones, then others as the reports name them. */
const columns = (reviews: ReviewCost[], configured: ReviewerId[]) => {
  const names = [...configured];
  for (const review of reviews) for (const r of review.reviewers) if (!names.includes(r.name)) names.push(r.name);
  return names.filter((name) => reviews.some((review) => review.reviewers.some((r) => r.name === name)));
};

/** The sum of the reviews' totals, partial when one has none; null when none has one. */
export function sumTotals(totals: (CostTotal | null)[]): CostTotal | null {
  const sum = totals.reduce<CostTotal | null>((acc, total) => addCost(acc, total), null);
  return sum && { ...sum, partial: sum.partial || totals.includes(null) };
}

/** Totals across `reviews`, overall and per reviewer. */
export function spend(reviews: ReviewCost[], configured: ReviewerId[]): Spend {
  const unpriced = new Set<string>();
  for (const review of reviews) {
    for (const r of review.reviewers) if (r.usage && r.usage.costUsd === undefined) unpriced.add(r.model ?? r.name);
  }
  const reviewers = columns(reviews, configured).map((name): ReviewerSpend => {
    const runs = reviews.flatMap((review) => review.reviewers.filter((r) => r.name === name));
    return {
      name,
      reviews: runs.length,
      inputTokens: runs.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: runs.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
      cost: totalCost(runs.map((r) => r.usage)),
    };
  });
  const totals = reviews.flatMap((review) => (review.total ? [review.total] : []));
  const costed = sumTotals(totals);
  return {
    reviews: reviews.length,
    cost: sumTotals(reviews.map((review) => review.total)),
    costed: totals.length,
    average: costed && { ...costed, costUsd: costed.costUsd / totals.length },
    reviewers,
    unpriced: [...unpriced].toSorted(),
  };
}

export interface CostOptions {
  reviewers: ReviewerId[];
  color: boolean;
  styles?: Styles;
}

/** One row per review: when, what, each reviewer's cost and tokens, and the review's total. */
export function renderCosts(reviews: ReviewCost[], opts: CostOptions): string[] {
  if (reviews.length === 0) return ['no finished reviews yet'];
  const names = columns(reviews, opts.reviewers);
  const none: Cell = { text: '-', color: DIM };
  const header = ['STARTED', 'REPO', 'PR', 'COMMIT', ...names.map((n) => n.toUpperCase()), 'TOTAL'];
  const rows = reviews.map(({ job, reviewers, total }): Cell[] => [
    { text: fmtStarted(job.startedAt) },
    { text: job.repo },
    { text: jobTarget(job) },
    { text: job.headSha.slice(0, 8) },
    ...names.map((name): Cell => {
      const usage = reviewers.find((r) => r.name === name)?.usage;
      return usage ? { text: fmtUsage(usage) } : none;
    }),
    total ? { text: fmtCost(total) } : none,
  ]);
  return renderTable(header, rows, opts);
}

/** The totals block under the table, and what `~` and `+` mean when either shows. */
export function renderSpend(total: Spend, st: Styles): string[] {
  const reviews = `${total.reviews} ${total.reviews === 1 ? 'review' : 'reviews'}`;
  const lines = [
    row(
      st,
      'total',
      total.cost ? st.bold(fmtCost(total.cost)) : st.muted('no cost reported'),
      total.average
        ? `${reviews}${total.costed < total.reviews ? ` (${total.costed} with a cost)` : ''} · ${fmtCost(total.average)} per review`
        : reviews,
    ),
  ];
  for (const r of total.reviewers) {
    const tokens =
      r.inputTokens || r.outputTokens ? ` · ${fmtTokens(r.inputTokens)} in/${fmtTokens(r.outputTokens)} out` : '';
    lines.push(
      row(
        st,
        r.name,
        r.cost ? fmtCost(r.cost) : st.muted('-'),
        `${r.reviews} ${r.reviews === 1 ? 'review' : 'reviews'}${tokens}`,
      ),
    );
  }
  const costs = [total.cost, ...total.reviewers.map((r) => r.cost)];
  const notes: string[] = [];
  if (costs.some((c) => c?.estimated)) {
    notes.push('~ estimated: the tokens at the model’s list price (set pricing in the config to change it)');
  }
  if (costs.some((c) => c?.partial)) {
    notes.push('+ at least this much: some runs reported no cost (failed early, or a CLI that reports no usage)');
  }
  if (total.unpriced.length > 0) {
    notes.push(`no price for ${total.unpriced.join(', ')}; add it under pricing in the config`);
  }
  return notes.length ? [...lines, '', ...notes.map((n) => `  ${st.muted(n)}`)] : lines;
}
