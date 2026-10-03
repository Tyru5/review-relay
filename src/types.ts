import type { Verdict } from './verdict.ts';

export type TriggerMode = 'auto' | 'greptile' | 'github';

export type JobSource = 'greptile' | 'github' | 'mention' | 'manual';

/** A supported agent CLI. */
export type HarnessName =
  | 'claude'
  | 'codex'
  | 'auggie'
  | 'copilot'
  | 'droid'
  | 'gemini'
  | 'grok'
  | 'hermes'
  | 'kilo'
  | 'opencode'
  | 'pi'
  | 'qwen'
  | 'vibe';

/** A reviewer: a CLI name, or a custom key in `models` that names its CLI in `harness`. */
export type ReviewerId = string;

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
  /** The reviewer's id, which also names its report file. */
  name: ReviewerId;
  harness: HarnessName;
  /** Name in the PR comment. */
  label: string;
  /** What the reviewer ran with; unset model and effort mean the CLI's own default. */
  model?: string;
  effort?: string;
  provider?: string;
  timeoutMs: number;
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
