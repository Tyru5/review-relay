import type { Config, RepoConfig } from './config.ts';
import { postComment } from './github.ts';
import { commentBody, writeReport } from './report.ts';
import { runClaude } from './reviewers/claude.ts';
import { runCodex } from './reviewers/codex.ts';
import type { ResolvedJob, ReviewerName, ReviewerResult } from './types.ts';
import { withWorktree } from './worktree.ts';

const REVIEWERS: Record<ReviewerName, typeof runCodex> = { codex: runCodex, claude: runClaude };

async function runReviewer(name: ReviewerName, job: ResolvedJob, dir: string, timeoutMs: number): Promise<ReviewerResult> {
  const started = Date.now();
  try {
    const r = await REVIEWERS[name](job, dir, timeoutMs);
    const ok = r.code === 0 && !r.timedOut && r.output.length > 0;
    const error = r.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : ok
        ? undefined
        : `exit ${r.code}: ${(r.stderr.trim() || r.output).slice(-2000)}`;
    return { name, ok, output: r.output, error, durationMs: Date.now() - started };
  } catch (err) {
    return { name, ok: false, output: '', error: String(err), durationMs: Date.now() - started };
  }
}

/** Runs all configured reviewers in parallel on a fresh worktree; one failing never drops the others. */
export async function runReview(job: ResolvedJob, repo: RepoConfig, config: Config): Promise<{ reportDir: string }> {
  const results = await withWorktree(repo, job, config.dataDir, (dir) =>
    Promise.all(config.reviewers.map((name) => runReviewer(name, job, dir, config.timeoutMs))),
  );
  const reportDir = await writeReport(config.dataDir, job, results);
  if (repo.postToPr && results.some((r) => r.ok)) await postComment(job.repo, job.pr, commentBody(job, results));
  if (results.every((r) => !r.ok)) {
    throw new Error(`all reviewers failed (${results.map((r) => `${r.name}: ${r.error}`).join('; ')})`);
  }
  return { reportDir };
}
