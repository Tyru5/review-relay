import type { StatusConfig } from './config.ts';
import type { CommitState } from './github.ts';
import { combinedScore } from './report.ts';
import type { ReviewOutcome } from './runner.ts';
import type { ResolvedJob } from './types.ts';

/** How a PR review ended, as the scheduler records it. */
export type FinishedStatus = 'done' | 'skipped' | 'failed' | 'cancelled' | 'superseded';

/** A PR review starting (once its commit is confirmed as the head) or ending. */
export type JobEvent =
  | { phase: 'started'; job: ResolvedJob }
  | { phase: 'finished'; job: ResolvedJob; status: FinishedStatus; outcome?: ReviewOutcome; error?: string };

export interface CommitStatus {
  state: CommitState;
  description: string;
  targetUrl: string;
}

const prUrl = (job: ResolvedJob) => `https://github.com/${job.repo}/pull/${job.pr}`;

/**
 * The `review-relay` status a review event sets, or null for one that leaves the commit alone: a superseded review,
 * whose PR head has its own status. Starting names the reviewers once known; the route picks them inside the run.
 */
export function commitStatusFor(event: JobEvent, config: StatusConfig): CommitStatus | null {
  const target = prUrl(event.job);
  if (event.phase === 'started') return { state: 'pending', description: 'Reviewing', targetUrl: target };
  const { outcome } = event;
  switch (event.status) {
    case 'superseded':
      return null;
    case 'skipped':
      return {
        state: 'success',
        description: `Skipped by route ${outcome?.route?.name ?? 'skip'}`,
        targetUrl: target,
      };
    case 'cancelled':
      return { state: 'error', description: 'Review cancelled', targetUrl: target };
    case 'failed':
      return {
        state: 'error',
        description: `Review failed: ${(event.error ?? 'unknown error').slice(0, 100)}`,
        targetUrl: target,
      };
    case 'done': {
      const results = outcome?.results ?? [];
      const score = combinedScore(results);
      const perReviewer = results.map((r) => `${r.label} ${r.ok ? r.score : 'failed'}`).join(', ');
      return {
        state: score !== null && score >= config.minScore ? 'success' : 'failure',
        description: `Confidence ${score ?? '?'}/5 (needs ${config.minScore})${perReviewer ? ` · ${perReviewer}` : ''}`,
        targetUrl: outcome?.commentUrl ?? target,
      };
    }
  }
}
