import type { RepoConfig } from './config.ts';
import type { Classified } from './match.ts';
import type { ReviewOutcome } from './runner.ts';
import type { StateStore } from './state.ts';
import { jobKey, type ResolvedJob, type ReviewJob } from './types.ts';

export interface SchedulerDeps {
  state: StateStore;
  graceMs: number;
  /** Fills in head SHA / base ref for comment and manual triggers. */
  resolve: (job: ReviewJob) => Promise<ResolvedJob>;
  /** Reviews the commit; aborting `signal` with a newer head means the PR moved on and the review should stop. */
  run: (job: ResolvedJob, repo: RepoConfig, signal: AbortSignal) => Promise<ReviewOutcome>;
  /** The PR's head commit on GitHub now. A job whose commit is no longer the head is stale and doesn't run. */
  prHead: (job: ResolvedJob) => Promise<string>;
  /** Reviews that run at once; later ones wait as `queued`, oldest first. Unlimited when unset. */
  maxConcurrent?: number;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Applies each repo's trigger mode:
 * - `greptile`: only Greptile's check_run start.
 * - `github`: only pull_request events.
 * - `auto`: Greptile runs at once; a pull_request event waits `graceMs` for Greptile, then runs as the fallback.
 * Mentions and manual runs always run and bypass the per-commit dedupe.
 *
 * At most `maxConcurrent` reviews run at once. When a job's turn comes, it runs only if its commit is still the PR's
 * head, and then stops any review of an older commit on the same PR.
 */
export class Scheduler {
  private readonly pending = new Map<string, unknown>();
  private readonly active = new Set<Promise<void>>();
  /** Running reviews by job key, so a review of the PR's new head can stop ones of its older commits. */
  private readonly inflight = new Map<string, { job: ResolvedJob; controller: AbortController }>();
  /** Turns handed out to queued jobs as running ones finish. */
  private readonly waiting: (() => void)[] = [];
  private slotsUsed = 0;
  private readonly maxConcurrent: number;
  private readonly log: (message: string) => void;
  private readonly setTimer: NonNullable<SchedulerDeps['setTimer']>;
  private readonly clearTimer: NonNullable<SchedulerDeps['clearTimer']>;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? ((m) => console.log(m));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.maxConcurrent = deps.maxConcurrent ?? Infinity;
  }

  handle(repo: RepoConfig, event: Classified): void {
    switch (event.kind) {
      case 'greptileStart': {
        if (repo.trigger === 'github') return this.log(`[${repo.fullName}] greptile start ignored (trigger=github)`);
        if (!event.job.headSha) return;
        this.cancelPending(jobKey({ repo: repo.fullName, headSha: event.job.headSha }));
        return this.dispatch(repo, event.job, false);
      }
      case 'prEvent': {
        if (repo.trigger === 'greptile')
          return this.log(`[${repo.fullName}] ${event.job.reason} ignored (trigger=greptile)`);
        if (repo.trigger === 'github') return this.dispatch(repo, event.job, false);
        return this.scheduleFallback(repo, event.job);
      }
      case 'mention':
        return this.dispatch(repo, event.job, true);
      case 'greptileDone':
        return this.log(
          `[${repo.fullName}] Greptile finished ${event.headSha.slice(0, 8)}: ${event.title ?? event.conclusion}`,
        );
      case 'ignore':
        return;
    }
  }

  /** Manual trigger from the CLI. */
  runNow(repo: RepoConfig, job: ReviewJob): void {
    this.dispatch(repo, job, true);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves once queued fallbacks have fired and in-flight reviews have finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0 || this.active.size > 0) {
      if (this.active.size > 0) await Promise.allSettled(this.active);
      else await Bun.sleep(25);
    }
  }

  private scheduleFallback(repo: RepoConfig, job: ReviewJob): void {
    if (!job.headSha) return;
    const key = jobKey({ repo: repo.fullName, headSha: job.headSha });
    if (this.pending.has(key) || this.deps.state.isHandled(key)) return;
    this.log(
      `[${repo.fullName}] PR #${job.pr} ${job.reason}: waiting ${Math.round(this.deps.graceMs / 1000)}s for Greptile`,
    );
    const handle = this.setTimer(() => {
      this.pending.delete(key);
      this.log(`[${repo.fullName}] PR #${job.pr}: no Greptile start, running fallback`);
      this.dispatch(repo, job, false);
    }, this.deps.graceMs);
    this.pending.set(key, handle);
  }

  private cancelPending(key: string): void {
    const handle = this.pending.get(key);
    if (handle === undefined) return;
    this.clearTimer(handle);
    this.pending.delete(key);
  }

  private dispatch(repo: RepoConfig, job: ReviewJob, force: boolean): void {
    const task = this.execute(repo, job, force).catch((err) => {
      this.log(`[${repo.fullName}] PR #${job.pr} failed before review: ${err instanceof Error ? err.message : err}`);
    });
    this.active.add(task);
    void task.finally(() => this.active.delete(task));
  }

  private async execute(repo: RepoConfig, job: ReviewJob, force: boolean): Promise<void> {
    const resolved = job.headSha && job.baseRef ? (job as ResolvedJob) : await this.deps.resolve(job);
    const key = jobKey(resolved);
    if (this.deps.state.isActive(key)) return this.log(`[${repo.fullName}] ${key} already queued or running`);
    if (!force && this.deps.state.isHandled(key)) return this.log(`[${repo.fullName}] ${key} already reviewed`);
    this.cancelPending(key);

    this.deps.state.queue({
      key,
      repo: resolved.repo,
      pr: resolved.pr,
      headSha: resolved.headSha,
      source: resolved.source,
    });
    if (this.slotsUsed >= this.maxConcurrent) {
      this.log(`[${repo.fullName}] PR #${resolved.pr} @ ${resolved.headSha.slice(0, 8)}: queued (${resolved.reason})`);
    }
    await this.acquireSlot();
    try {
      await this.review(repo, resolved, key);
    } finally {
      this.releaseSlot();
    }
  }

  private async review(repo: RepoConfig, job: ResolvedJob, key: string): Promise<void> {
    const tag = `[${repo.fullName}] PR #${job.pr}`;
    const supersede = (head: string, what: string) => {
      this.deps.state.finish(key, { status: 'superseded', supersededBy: head });
      this.log(`${tag} @ ${job.headSha.slice(0, 8)}: ${what}, the PR is now at ${head.slice(0, 8)}`);
    };
    this.deps.state.begin(key);
    const controller = new AbortController();
    try {
      const head = await this.deps.prHead(job);
      if (head !== job.headSha) return supersede(head, 'not reviewed');
      // This commit is the PR's head, so a review still running on an older one is stale.
      for (const other of this.inflight.values()) {
        if (other.job.repo === job.repo && other.job.pr === job.pr && other.job.headSha !== head) {
          other.controller.abort(head);
        }
      }
      this.inflight.set(key, { job, controller });

      this.log(`${tag} @ ${job.headSha.slice(0, 8)}: reviewing (${job.reason})`);
      const { reportDir, route, skipped, supersededBy } = await this.deps.run(job, repo, controller.signal);
      const via = route ? `route ${route.name} (${route.reason}), ` : '';
      if (skipped) {
        this.deps.state.finish(key, { status: 'skipped', route: route?.name });
        return this.log(`${tag}: ${via}skipped`);
      }
      if (supersededBy) {
        this.deps.state.finish(key, { status: 'superseded', supersededBy, reportDir, route: route?.name });
        return this.log(
          `${tag} @ ${job.headSha.slice(0, 8)}: ${via}not posted, the PR is now at ${supersededBy.slice(0, 8)}`,
        );
      }
      this.deps.state.finish(key, { status: 'done', reportDir, route: route?.name });
      this.log(`${tag}: ${via}done${reportDir ? ` -> ${reportDir}` : ''}`);
    } catch (err) {
      // An aborted review fails in whatever step it was in; the abort is the real outcome.
      if (controller.signal.aborted) return supersede(String(controller.signal.reason), 'stopped');
      const error = err instanceof Error ? err.message : String(err);
      this.deps.state.finish(key, { status: 'failed', error });
      this.log(`${tag}: failed: ${error}`);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Resolves when this job may run; slots pass straight to the oldest waiting job as they free up. */
  private acquireSlot(): Promise<void> {
    if (this.slotsUsed < this.maxConcurrent) {
      this.slotsUsed++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.slotsUsed--;
  }
}
