import type { Verdict } from './verdict.ts';

export type TriggerMode = 'auto' | 'greptile' | 'github';

export type JobSource = 'greptile' | 'github' | 'mention' | 'manual';

export type ReviewerName = 'codex' | 'claude';

/** A review request. `headSha`/`baseRef` are absent for comment triggers until resolved via `gh`. */
export interface ReviewJob {
  repo: string;
  pr: number;
  source: JobSource;
  reason: string;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
}

export interface ResolvedJob extends ReviewJob {
  headSha: string;
  baseRef: string;
}

export interface ReviewerResult {
  name: ReviewerName;
  ok: boolean;
  /** Raw reviewer output, kept for debugging. */
  output: string;
  verdict?: Verdict;
  /** Merge confidence 1-5 after `finalScore` caps. */
  score?: number;
  error?: string;
  durationMs: number;
}

export const jobKey = (job: { repo: string; headSha: string }) => `${job.repo}@${job.headSha}`;
