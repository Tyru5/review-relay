import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pricesFor, type Config, type RepoConfig, type ReviewerEntry } from './config.ts';
import { diffStats, promptDiff, type DiffStats } from './diffstats.ts';
import { postInlineReview, prHead, upsertComment } from './github.ts';
import { addedLines, planInline, type InlineComment } from './inline.ts';
import { priorReview, trackFindings } from './lifecycle.ts';
import { reviewPrompt } from './prompt.ts';
import { commentBody, routeLine, writeReport } from './report.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import type { Harness, ReviewerInput } from './reviewers/types.ts';
import { pickRoute, type RouteChoice } from './routes.ts';
import { isLocal, type HarnessName, type ResolvedJob, type ReviewerId, type ReviewerResult } from './types.ts';
import { priced, type Price } from './usage.ts';
import { finalScore, mergeFindings, VERDICT_SCHEMA } from './verdict.ts';
import { baseRemoteRef, fetchPr, withCheckout, workName } from './worktree.ts';

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
  /** Posts or updates the PR comment, and returns its URL. */
  post: (repo: string, pr: number, body: string) => Promise<string | void>;
  /** The added lines per file in the PR's diff, read in the clone, which inline comments may name. */
  addedLines: (repo: RepoConfig, job: ResolvedJob) => Promise<Map<string, Set<number>>>;
  /** Posts the comments as one review on the commit, skipping spots already commented on; returns how many it posted. */
  postInline: (repo: string, pr: number, sha: string, body: string, comments: InlineComment[]) => Promise<number>;
  /** The PR's head commit on GitHub now, checked just before posting. */
  prHead: (repo: string, pr: number) => Promise<string>;
}

export const RUNNER_DEPS: RunnerDeps = {
  harnesses: HARNESSES,
  findBin: (harness) => findBin(harness),
  fetch: fetchPr,
  diffStats: (repo, job) => diffStats(repo.localPath, baseRemoteRef(job), job.headSha),
  checkout: withCheckout,
  promptDiff,
  post: upsertComment,
  addedLines: (repo, job) => addedLines(repo.localPath, baseRemoteRef(job), job.headSha),
  postInline: postInlineReview,
  prHead,
};

async function runReviewer(
  name: ReviewerId,
  entry: ReviewerEntry,
  harness: Harness,
  input: ReviewerInput,
  prices: Record<string, Price>,
): Promise<ReviewerResult> {
  const started = Date.now();
  const ran = { name, ...entry, timeoutMs: input.timeoutMs };
  const durationMs = () => Date.now() - started;
  try {
    const out = await harness.run(input);
    // Priced now, so a later price change leaves this review's recorded cost as it was.
    const r = out.usage ? { ...out, usage: priced(out.usage, entry.model, prices) } : out;
    if (r.timedOut)
      return {
        ...ran,
        ok: false,
        output: r.raw,
        error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`,
        durationMs: durationMs(),
        usage: r.usage,
      };
    if (r.code !== 0 || !r.verdict)
      return {
        ...ran,
        ok: false,
        output: r.raw,
        error: r.error ?? `exit ${r.code}: ${r.raw.slice(-2000)}`,
        durationMs: durationMs(),
        usage: r.usage,
      };
    return {
      ...ran,
      ok: true,
      output: r.raw,
      verdict: r.verdict,
      score: finalScore(r.verdict),
      durationMs: durationMs(),
      usage: r.usage,
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
  /** The PR's newer head when one made this review stale, so nothing was posted. */
  supersededBy?: string;
  /** Each reviewer's result, once the reviewers ran. */
  results?: ReviewerResult[];
  /** The comment the review wrote, posted or not. */
  comment?: string;
  /** The posted comment's URL. */
  commentUrl?: string;
  /** How many findings were posted as inline comments. */
  inline?: number;
  /** Steps that failed without failing the review, such as the inline review post. */
  warnings?: string[];
}

/** The tail of each PR's chain of posts, so two reviews of one PR never post at once. */
const posting = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call with the same key has settled. */
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const result = (posting.get(key) ?? Promise.resolve()).then(fn);
  const tail = result.catch(() => {});
  posting.set(key, tail);
  void tail.then(() => {
    if (posting.get(key) === tail) posting.delete(key);
  });
  return result;
}

/**
 * Runs `publish` unless the PR has moved past the reviewed commit, and returns the newer head when it has. The check
 * and the posts share one turn per PR: a slower review of an older commit can't overwrite a newer one's comment, and
 * two first reviews can't both create a comment.
 */
function publishIfCurrent(
  job: ResolvedJob,
  deps: RunnerDeps,
  publish: () => Promise<void>,
): Promise<string | undefined> {
  return serialized(`${job.repo}#${job.pr}`, async () => {
    const head = await deps.prHead(job.repo, job.pr);
    if (head !== job.headSha) return head;
    await publish();
    return undefined;
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Picks the PR's route from its diff, read in the clone, then runs that route's reviewers in parallel on a fresh
 * worktree; one failing never drops the others. A skip route stops before any worktree exists. Aborting `signal`
 * with the PR's newer head kills the reviewers and ends the review without a report or a post.
 */
export async function runReview(
  job: ResolvedJob,
  repo: RepoConfig,
  config: Config,
  deps: RunnerDeps = RUNNER_DEPS,
  signal?: AbortSignal,
): Promise<ReviewOutcome> {
  await deps.fetch(repo, job);
  const stats = await deps.diffStats(repo, job);
  const pick = pickRoute(config, job, stats);
  if (pick.skip) return { route: pick.route, skipped: true };
  if (signal?.aborted) return { route: pick.route, supersededBy: String(signal.reason) };

  const scratchRoot = join(config.dataDir, 'tmp', workName(job));
  const schemaPath = join(config.dataDir, 'verdict-schema.json');
  await Bun.write(schemaPath, JSON.stringify(VERDICT_SCHEMA, null, 2));
  const reviewers = pick.reviewers.map((name) => ({ name, entry: config.models[name]! }));
  const harnessOf = (entry: ReviewerEntry) => deps.harnesses[entry.harness];
  const prices = pricesFor(config);

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
          return runReviewer(
            name,
            entry,
            harness,
            {
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
              signal,
              model: entry.model,
              effort: entry.effort,
              provider: entry.provider,
            },
            prices,
          );
        }),
      );
    })
    .finally(() => rm(scratchRoot, { recursive: true, force: true }));
  // Killed reviewers report failures that say nothing about the PR, so they get no report.
  if (signal?.aborted) return { route: pick.route, supersededBy: String(signal.reason) };

  // The routing line shows only for configs that route, so a config without routes keeps its comment as it was.
  const routing = config.routes.length > 0 ? routeLine(pick.route, results) : undefined;
  // Tracked against the PR's last reviewed commit, so the comment says what is new, still open, and fixed.
  const ok = results.filter((r) => r.ok && r.verdict);
  const merged = mergeFindings(ok.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings })));
  const tracked = trackFindings(
    job.headSha,
    merged,
    priorReview(config.dataDir, job),
    ok.map((r) => r.name),
  );
  const body = commentBody(job, results, stats, { routing, tracked });
  const reportDir = await writeReport(config.dataDir, job, results, body, pick.route, tracked);
  if (results.every((r) => !r.ok)) {
    throw new Error(`all reviewers failed (${results.map((r) => `${r.name}: ${r.error}`).join('; ')})`);
  }
  const outcome: ReviewOutcome = { reportDir, route: pick.route, results, comment: body };
  // A local review has no PR to post to.
  if (!repo.postToPr || isLocal(job)) return outcome;
  const labels = new Map(results.map((r) => [r.name, r.label]));
  const warnings: string[] = [];
  let comments: InlineComment[] = [];
  if (repo.inlineComments) {
    try {
      comments = planInline(tracked.findings, await deps.addedLines(repo, job), labels);
    } catch (err) {
      warnings.push(`inline comments skipped: ${message(err)}`);
    }
  }
  const supersededBy = await publishIfCurrent(job, deps, async () => {
    outcome.commentUrl = (await deps.post(job.repo, job.pr, body)) || undefined;
    if (comments.length === 0) return;
    // The summary comment stands whatever happens to the inline review.
    try {
      const summary = outcome.commentUrl ? `[review-relay](${outcome.commentUrl})` : 'review-relay';
      outcome.inline = await deps.postInline(
        job.repo,
        job.pr,
        job.headSha,
        `${summary}: findings on the changed lines. The scored review is in the summary comment.`,
        comments,
      );
    } catch (err) {
      warnings.push(`inline review not posted: ${message(err)}`);
    }
  });
  if (warnings.length > 0) outcome.warnings = warnings;
  return supersededBy ? { ...outcome, supersededBy } : outcome;
}
