import type { Verdict } from './verdict.ts';

export type TriggerMode = 'auto' | 'greptile' | 'coderabbit' | 'github';

/** An AI review bot whose start triggers a review. */
export type Bot = 'greptile' | 'coderabbit';

/** `local`: `review-relay review` on a branch in a checkout, before any PR exists. */
export type JobSource = Bot | 'github' | 'mention' | 'manual' | 'local';

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
  /** A route the request named: the word after a mention, or `run --route`. Routing decides if it is one. */
  route?: string;
  /** Who asked for the review, for mentions. */
  requestedBy?: string;
  /** The PR author's login, when the event named it. */
  author?: string;
  /** The commit a local review diffs against, pinned when it started; PR reviews use `origin/<baseRef>`. */
  base?: string;
  /** What a local review's base was called, such as `origin/main`, for display and re-runs. */
  baseName?: string;
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

/** A review of a branch in a checkout rather than a PR: `pr` is 0, and nothing is fetched or posted. */
export const isLocal = (job: { source?: JobSource }) => job.source === 'local';

/** One record per commit; a local review of a commit is its own record, apart from any PR review of it. */
export const jobKey = (job: { repo: string; headSha: string; source?: JobSource }) =>
  `${job.repo}@${job.headSha}${isLocal(job) ? ':local' : ''}`;
