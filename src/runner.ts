import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, RepoConfig, ReviewerEntry } from './config.ts';
import { diffStats, promptDiff, type DiffStats } from './diffstats.ts';
import { upsertComment } from './github.ts';
import { reviewPrompt } from './prompt.ts';
import { commentBody, routeLine, writeReport } from './report.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import type { Harness, ReviewerInput } from './reviewers/types.ts';
import { pickRoute, type RouteChoice } from './routes.ts';
import { jobKey, type HarnessName, type ResolvedJob, type ReviewerId, type ReviewerResult } from './types.ts';
import { finalScore, VERDICT_SCHEMA } from './verdict.ts';
import { baseRemoteRef, fetchPr, withCheckout } from './worktree.ts';

/** What a review touches outside its own logic: the CLIs, git, and GitHub. Tests stand in for them. */
export interface RunnerDeps {
  harnesses: Record<HarnessName, Harness>;
  /** The harness's executable on PATH, or null when it isn't installed. */
  findBin: (harness: HarnessName) => string | null;
  /** Fetches the base branch and the PR head into the local clone. */
  fetch: (repo: RepoConfig, job: ResolvedJob) => Promise<void>;
  /** The PR's diff stats, read in the clone before any checkout exists. */
  diffStats: (repo: RepoConfig, job: ResolvedJob) => Promise<DiffStats>;
  /** Runs `fn` in a checkout of the fetched PR head, as `withCheckout` does. */
  checkout: <T>(repo: RepoConfig, job: ResolvedJob, dataDir: string, fn: (dir: string) => Promise<T>) => Promise<T>;
  promptDiff: (dir: string, baseRef: string) => Promise<string>;
  /** Posts or updates the PR comment. */
  post: (repo: string, pr: number, body: string) => Promise<void>;
}

export const RUNNER_DEPS: RunnerDeps = {
  harnesses: HARNESSES,
  findBin: (harness) => findBin(harness),
  fetch: fetchPr,
  diffStats: (repo, job) => diffStats(repo.localPath, baseRemoteRef(job), job.headSha),
  checkout: withCheckout,
  promptDiff,
  post: upsertComment,
};

async function runReviewer(
  name: ReviewerId,
  entry: ReviewerEntry,
  harness: Harness,
  input: ReviewerInput,
): Promise<ReviewerResult> {
  const started = Date.now();
  const ran = { name, ...entry, timeoutMs: input.timeoutMs };
  const durationMs = () => Date.now() - started;
  try {
    const r = await harness.run(input);
    if (r.timedOut)
      return {
        ...ran,
        ok: false,
        output: r.raw,
        error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`,
        durationMs: durationMs(),
      };
    if (r.code !== 0 || !r.verdict)
      return {
        ...ran,
        ok: false,
        output: r.raw,
        error: r.error ?? `exit ${r.code}: ${r.raw.slice(-2000)}`,
        durationMs: durationMs(),
      };
    return {
      ...ran,
      ok: true,
      output: r.raw,
      verdict: r.verdict,
      score: finalScore(r.verdict),
      durationMs: durationMs(),
    };
  } catch (err) {
    return {
      ...ran,
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: durationMs(),
    };
  }
}

/** Deletes the harness config a PR could ship to loosen the lockdown; see `Harness.projectFiles`. */
export async function removeProjectFiles(
  dir: string,
  harnesses: HarnessName[],
  table: Record<HarnessName, Harness> = HARNESSES,
) {
  const paths = new Set(harnesses.flatMap((name) => table[name].projectFiles ?? []));
  // rm removes a symlink itself rather than its target, so a PR can't aim one of these outside the worktree.
  await Promise.all([...paths].map((path) => rm(join(dir, path), { recursive: true, force: true })));
}

/** What a review did: ran and wrote a report, or stopped at a skip route. `route` is unset when no route matched. */
export interface ReviewOutcome {
  reportDir?: string;
  route?: RouteChoice;
  skipped?: boolean;
}

/**
 * Picks the PR's route from its diff, read in the clone, then runs that route's reviewers in parallel on a fresh
 * worktree; one failing never drops the others. A skip route stops before any worktree exists.
 */
export async function runReview(
  job: ResolvedJob,
  repo: RepoConfig,
  config: Config,
  deps: RunnerDeps = RUNNER_DEPS,
): Promise<ReviewOutcome> {
  await deps.fetch(repo, job);
  const stats = await deps.diffStats(repo, job);
  const pick = pickRoute(config, job, stats);
  if (pick.skip) return { route: pick.route, skipped: true };

  const scratchRoot = join(config.dataDir, 'tmp', jobKey(job).replace(/[^\w.-]+/g, '_'));
  const schemaPath = join(config.dataDir, 'verdict-schema.json');
  await Bun.write(schemaPath, JSON.stringify(VERDICT_SCHEMA, null, 2));
  const reviewers = pick.reviewers.map((name) => ({ name, entry: config.models[name]! }));
  const harnessOf = (entry: ReviewerEntry) => deps.harnesses[entry.harness];

  const results = await deps
    .checkout(repo, job, config.dataDir, async (dir) => {
      await removeProjectFiles(
        dir,
        reviewers.map(({ entry }) => entry.harness),
        deps.harnesses,
      );
      const shellless = reviewers.some(({ entry }) => harnessOf(entry).shell === 'none');
      const inlineDiff = shellless ? await deps.promptDiff(dir, baseRemoteRef(job)) : undefined;
      return Promise.all(
        reviewers.map(async ({ name, entry }) => {
          const harness = harnessOf(entry);
          // Keyed by reviewer id, so two reviewers on one CLI never share output files.
          const scratchDir = join(scratchRoot, name);
          await mkdir(scratchDir, { recursive: true });
          return runReviewer(name, entry, harness, {
            // An uninstalled harness still runs by name, so its failure reads "executable not found".
            bin: deps.findBin(entry.harness) ?? harness.bins[0]!,
            dir,
            prompt: reviewPrompt(job, stats, {
              schema: harness.schema === 'prompt',
              diff: harness.shell === 'none' ? inlineDiff : undefined,
            }),
            schemaPath,
            scratchDir,
            timeoutMs: pick.timeoutMs,
            model: entry.model,
            effort: entry.effort,
            provider: entry.provider,
          });
        }),
      );
    })
    .finally(() => rm(scratchRoot, { recursive: true, force: true }));

  // The routing line shows only for configs that route, so a config without routes keeps its comment as it was.
  const routing = config.routes.length > 0 ? routeLine(pick.route, results) : undefined;
  const body = commentBody(job, results, stats, routing);
  const reportDir = await writeReport(config.dataDir, job, results, body, pick.route);
  if (results.every((r) => !r.ok)) {
    throw new Error(`all reviewers failed (${results.map((r) => `${r.name}: ${r.error}`).join('; ')})`);
  }
  if (repo.postToPr) await deps.post(job.repo, job.pr, body);
  return { reportDir, route: pick.route };
}
