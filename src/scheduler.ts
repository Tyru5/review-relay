import type { RepoConfig } from './config.ts';
import { BOT_NAMES, type BotStartJob, type Classified } from './match.ts';
import type { ReviewOutcome } from './runner.ts';
import type { StateStore } from './state.ts';
import { jobKey, type Bot, type ResolvedJob, type ReviewJob, type TriggerMode } from './types.ts';

/** The PR a bot start names only by its head commit. */
export interface CommitPr {
  pr: number;
  headRef: string;
  baseRef: string;
}

/** The PR a pull_request event named for a commit. A missing ref is resolved later, like any other job's. */
type KnownPr = Pick<ReviewJob, 'pr' | 'headRef' | 'baseRef'>;

interface Claim {
  known?: KnownPr;
}

const prOf = ({ pr, headRef, baseRef }: ReviewJob): KnownPr => ({ pr, headRef, baseRef });

/** The review bots whose start each trigger mode follows. */
export const BOTS_BY_MODE: Record<TriggerMode, Bot[]> = {
  auto: ['greptile', 'coderabbit'],
  greptile: ['greptile'],
  coderabbit: ['coderabbit'],
  github: [],
};

export interface SchedulerDeps {
  state: StateStore;
  graceMs: number;
  /** Fills in head SHA / base ref for comment and manual triggers. */
  resolve: (job: ReviewJob) => Promise<ResolvedJob>;
  /** The open, ready PR whose head is `headSha`, for a bot start that names only a commit; null when none is. */
  findPr: (repo: string, headSha: string) => Promise<CommitPr | null>;
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
 * - `coderabbit`: only CodeRabbit's start (commit status or check run).
 * - `github`: only pull_request events.
 * - `auto`: a Greptile or CodeRabbit start runs at once; a pull_request event waits `graceMs` for one, then runs as the
 *   fallback.
 * Mentions and manual runs always run and bypass the per-commit dedupe.
 *
 * At most `maxConcurrent` reviews run at once. When a job's turn comes, it runs only if its commit is still the PR's
 * head, and then stops any review of an older commit on the same PR.
 */
export class Scheduler {
  /** GitHub fallbacks waiting out the grace period, by job key, with the PR each one knows. */
  private readonly pending = new Map<string, { handle: unknown; job: ReviewJob }>();
  /**
   * Commits a PR-less bot start (a CodeRabbit status) holds, by job key, from its arrival until its review finishes.
   * Holding the commit stops a PR event from starting a rival fallback, even while the PR's refs are still being
   * resolved; a PR event that arrives meanwhile leaves its PR here instead, for when the lookup fails or finds nothing.
   */
  private readonly claims = new Map<string, Claim>();
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
      case 'botStart': {
        if (!BOTS_BY_MODE[repo.trigger].includes(event.job.source)) {
          return this.log(`[${repo.fullName}] ${event.job.reason} ignored (trigger=${repo.trigger})`);
        }
        return this.startBot(repo, event.job);
      }
      case 'prEvent': {
        if (repo.trigger === 'github') return this.dispatch(repo, event.job, false);
        if (repo.trigger !== 'auto') {
          return this.log(`[${repo.fullName}] ${event.job.reason} ignored (trigger=${repo.trigger})`);
        }
        return this.scheduleFallback(repo, event.job);
      }
      case 'mention':
        return this.dispatch(repo, event.job, true);
      case 'botDone':
        return this.log(
          `[${repo.fullName}] ${BOT_NAMES[event.bot]} finished ${event.headSha.slice(0, 8)}: ${event.result ?? 'done'}`,
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

  /**
   * A bot start runs at once and replaces the commit's GitHub fallback. One that names only a commit (a CodeRabbit status)
   * claims the commit, then takes its PR from that fallback when there was one, and otherwise looks the PR up.
   */
  private startBot(repo: RepoConfig, start: BotStartJob): void {
    const key = jobKey({ repo: repo.fullName, headSha: start.headSha });
    const fallback = this.takePending(key);
    if (start.pr !== undefined) return this.dispatch(repo, start as ReviewJob, false);
    if (this.claims.has(key)) return this.log(`[${repo.fullName}] ${key} already started by a bot`);
    if (!fallback) {
      if (this.deps.state.isActive(key)) return this.log(`[${repo.fullName}] ${key} already queued or running`);
      if (this.deps.state.isHandled(key)) return this.log(`[${repo.fullName}] ${key} already reviewed`);
    }
    const claim: Claim = fallback ? { known: prOf(fallback) } : {};
    this.claims.set(key, claim);
    this.track(repo, `commit ${start.headSha.slice(0, 8)}`, this.runClaimed(repo, start, key, claim, !fallback));
  }

  /** Finds the start's PR, then reviews it, holding the commit's claim until the review is over. */
  private async runClaimed(repo: RepoConfig, start: BotStartJob, key: string, claim: Claim, lookUp: boolean) {
    try {
      const found = lookUp ? await this.lookUpPr(repo, start) : null;
      const pr: KnownPr | undefined = found ?? claim.known;
      if (!pr) return;
      if (lookUp && !found) {
        this.log(`[${repo.fullName}] ${start.headSha.slice(0, 8)}: using PR #${pr.pr} from its pull_request event`);
      }
      await this.execute(repo, { ...start, ...pr }, false);
    } finally {
      this.claims.delete(key);
    }
  }

  /** The open, ready PR whose head is the start's commit; null when there is none or the lookup failed. */
  private async lookUpPr(repo: RepoConfig, start: BotStartJob): Promise<CommitPr | null> {
    const tag = `[${repo.fullName}] ${start.reason} on ${start.headSha.slice(0, 8)}`;
    try {
      const found = await this.deps.findPr(start.repo, start.headSha);
      if (!found) this.log(`${tag}: no open, ready PR has it as its head`);
      return found;
    } catch (err) {
      this.log(`${tag}: PR lookup failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private scheduleFallback(repo: RepoConfig, job: ReviewJob): void {
    if (!job.headSha) return;
    const key = jobKey({ repo: repo.fullName, headSha: job.headSha });
    if (this.pending.has(key) || this.deps.state.isHandled(key)) return;
    const claim = this.claims.get(key);
    if (claim) {
      claim.known = prOf(job);
      return this.log(`[${repo.fullName}] PR #${job.pr} ${job.reason}: a bot already started on this commit`);
    }
    this.log(
      `[${repo.fullName}] PR #${job.pr} ${job.reason}: waiting ${Math.round(this.deps.graceMs / 1000)}s for Greptile or CodeRabbit`,
    );
    const handle = this.setTimer(() => {
      this.pending.delete(key);
      this.log(`[${repo.fullName}] PR #${job.pr}: no Greptile or CodeRabbit start, running fallback`);
      this.dispatch(repo, job, false);
    }, this.deps.graceMs);
    this.pending.set(key, { handle, job });
  }

  /** Cancels the commit's fallback and returns the job it would have run. */
  private takePending(key: string): ReviewJob | undefined {
    const pending = this.pending.get(key);
    if (pending === undefined) return undefined;
    this.clearTimer(pending.handle);
    this.pending.delete(key);
    return pending.job;
  }

  private dispatch(repo: RepoConfig, job: ReviewJob, force: boolean): void {
    this.track(repo, `PR #${job.pr}`, this.execute(repo, job, force));
  }

  /** Keeps `idle()` waiting on the task and logs a failure it didn't record itself. */
  private track(repo: RepoConfig, what: string, work: Promise<void>): void {
    const task = work.catch((err) => {
      this.log(`[${repo.fullName}] ${what} failed before review: ${err instanceof Error ? err.message : err}`);
    });
    this.active.add(task);
    void task.finally(() => this.active.delete(task));
  }

  private async execute(repo: RepoConfig, job: ReviewJob, force: boolean): Promise<void> {
    const resolved = job.headSha && job.baseRef ? (job as ResolvedJob) : await this.deps.resolve(job);
    // Resolving missing refs must not move a commit-bound trigger to the PR's newer head.
    // Mentions and manual requests without a SHA still adopt the head returned by resolve.
    if (job.headSha) resolved.headSha = job.headSha;
    const key = jobKey(resolved);
    if (this.deps.state.isActive(key)) return this.log(`[${repo.fullName}] ${key} already queued or running`);
    if (!force && this.deps.state.isHandled(key)) return this.log(`[${repo.fullName}] ${key} already reviewed`);
    this.takePending(key);

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
