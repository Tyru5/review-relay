import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, RepoConfig } from './config.ts';
import { diffStats, type DiffStats } from './diffstats.ts';
import { upsertComment } from './github.ts';
import { reviewPrompt } from './prompt.ts';
import { commentBody, writeReport } from './report.ts';
import { runClaude } from './reviewers/claude.ts';
import { runCodex } from './reviewers/codex.ts';
import type { ReviewerInput, ReviewerOutput } from './reviewers/types.ts';
import { jobKey, type ResolvedJob, type ReviewerName, type ReviewerResult } from './types.ts';
import { finalScore, VERDICT_SCHEMA } from './verdict.ts';
import { baseRemoteRef, withWorktree } from './worktree.ts';

const REVIEWERS: Record<ReviewerName, (input: ReviewerInput) => Promise<ReviewerOutput>> = {
  codex: runCodex,
  claude: runClaude,
};

async function runReviewer(name: ReviewerName, input: ReviewerInput): Promise<ReviewerResult> {
  const started = Date.now();
  const durationMs = () => Date.now() - started;
  try {
    const r = await REVIEWERS[name](input);
    if (r.timedOut)
      return {
        name,
        ok: false,
        output: r.raw,
        error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`,
        durationMs: durationMs(),
      };
    if (r.code !== 0 || !r.verdict)
      return {
        name,
        ok: false,
        output: r.raw,
        error: `exit ${r.code}: ${r.raw.slice(-2000)}`,
        durationMs: durationMs(),
      };
    return {
      name,
      ok: true,
      output: r.raw,
      verdict: r.verdict,
      score: finalScore(r.verdict),
      durationMs: durationMs(),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: durationMs(),
    };
  }
}

/** Runs all configured reviewers in parallel on a fresh worktree; one failing never drops the others. */
export async function runReview(job: ResolvedJob, repo: RepoConfig, config: Config): Promise<{ reportDir: string }> {
  const scratchRoot = join(config.dataDir, 'tmp', jobKey(job).replace(/[^\w.-]+/g, '_'));
  const schemaPath = join(config.dataDir, 'verdict-schema.json');
  await Bun.write(schemaPath, JSON.stringify(VERDICT_SCHEMA, null, 2));

  let stats: DiffStats | undefined;
  const results = await withWorktree(repo, job, config.dataDir, async (dir) => {
    stats = await diffStats(dir, baseRemoteRef(job));
    const prompt = reviewPrompt(job, stats);
    return Promise.all(
      config.reviewers.map(async (name) => {
        const scratchDir = join(scratchRoot, name);
        await mkdir(scratchDir, { recursive: true });
        return runReviewer(name, { dir, prompt, schemaPath, scratchDir, timeoutMs: config.timeoutMs });
      }),
    );
  }).finally(() => rm(scratchRoot, { recursive: true, force: true }));

  const body = commentBody(job, results, stats!);
  const reportDir = await writeReport(config.dataDir, job, results, body);
  if (results.every((r) => !r.ok)) {
    throw new Error(`all reviewers failed (${results.map((r) => `${r.name}: ${r.error}`).join('; ')})`);
  }
  if (repo.postToPr) await upsertComment(job.repo, job.pr, body);
  return { reportDir };
}
