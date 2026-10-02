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
  output: string;
  error?: string;
  durationMs: number;
}

export const jobKey = (job: { repo: string; headSha: string }) => `${job.repo}@${job.headSha}`;
