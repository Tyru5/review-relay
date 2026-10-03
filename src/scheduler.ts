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
  run: (job: ResolvedJob, repo: RepoConfig) => Promise<ReviewOutcome>;
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
 */
export class Scheduler {
  private readonly pending = new Map<string, unknown>();
  private readonly active = new Set<Promise<void>>();
  private readonly log: (message: string) => void;
  private readonly setTimer: NonNullable<SchedulerDeps['setTimer']>;
  private readonly clearTimer: NonNullable<SchedulerDeps['clearTimer']>;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? ((m) => console.log(m));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
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
    if (this.deps.state.isRunning(key)) return this.log(`[${repo.fullName}] ${key} already running`);
    if (!force && this.deps.state.isHandled(key)) return this.log(`[${repo.fullName}] ${key} already reviewed`);
    this.cancelPending(key);

    this.log(`[${repo.fullName}] PR #${resolved.pr} @ ${resolved.headSha.slice(0, 8)}: reviewing (${resolved.reason})`);
    this.deps.state.start({
      key,
      repo: resolved.repo,
      pr: resolved.pr,
      headSha: resolved.headSha,
      source: resolved.source,
    });
    try {
      const { reportDir, route, skipped } = await this.deps.run(resolved, repo);
      const via = route ? `route ${route.name} (${route.reason}), ` : '';
      if (skipped) {
        this.deps.state.finish(key, { status: 'skipped', route: route?.name });
        return this.log(`[${repo.fullName}] PR #${resolved.pr}: ${via}skipped`);
      }
      this.deps.state.finish(key, { status: 'done', reportDir, route: route?.name });
      this.log(`[${repo.fullName}] PR #${resolved.pr}: ${via}done${reportDir ? ` -> ${reportDir}` : ''}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.state.finish(key, { status: 'failed', error });
      this.log(`[${repo.fullName}] PR #${resolved.pr}: failed: ${error}`);
    }
  }
}
