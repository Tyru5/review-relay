import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Config, RepoConfig } from './config.ts';
import { exec, execOrThrow } from './exec.ts';
import { parseGithubRemote } from './repos.ts';
import { RUNNER_DEPS, runReview, type ReviewOutcome, type RunnerDeps } from './runner.ts';
import type { StateStore } from './state.ts';
import { jobKey, type ResolvedJob } from './types.ts';

export interface LocalOptions {
  /** The ref to diff against; unset means the remote's default branch, as `origin/HEAD` names it. */
  base?: string;
  /** The ref to review; unset means `HEAD`. */
  head?: string;
  /** The name to show for `head`, when the caller already resolved a branch to its SHA. */
  headName?: string;
  /** The name to show and route by for `base`, when the caller already resolved it to its SHA. */
  baseName?: string;
  route?: string;
}

/** A branch in a checkout, ready for `runReview`: the job, and a repo entry that never posts. */
export interface LocalTarget {
  job: ResolvedJob;
  repo: RepoConfig;
  /** Commits on the head that the base lacks. */
  commits: number;
  /** True when the checkout has uncommitted changes to tracked files, which the review leaves out. */
  dirty: boolean;
}

/** Bases tried in order when `origin/HEAD` isn't set, as in a clone made with `git init` and `git remote add`. */
const FALLBACK_BASES = ['origin/main', 'origin/master', 'main', 'master'];

/** The path with symlinks resolved, so two spellings of one clone compare equal. */
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Resolves the branch to review in the checkout at `cwd`, against a base, without GitHub: nothing is fetched, so the
 * base is whatever the clone last fetched. The repo's config entry applies when one names this clone; otherwise the
 * repo is named from its origin remote, or its folder.
 */
export async function localTarget(config: Config, cwd: string, opts: LocalOptions = {}): Promise<LocalTarget> {
  const top = await exec(['git', '-C', cwd, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`${cwd} is not inside a git checkout`);
  const dir = top.stdout.trim();
  const git = (...args: string[]) => exec(['git', '-C', dir, ...args]);
  const commitOf = async (ref: string) => {
    const r = await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };

  const head = opts.head ?? 'HEAD';
  const headSha = await commitOf(head);
  if (!headSha) throw new Error(`no commit named "${head}"`);
  const headRef =
    opts.headName ??
    (head === 'HEAD'
      ? (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim() || headSha.slice(0, 8)
      : head);

  const requested = opts.base ?? (await defaultBase(dir));
  // Pinned here: in the review's worktree HEAD is the head commit, so `HEAD~2` would name another commit there, and a
  // base branch can move while a background review runs.
  const base = await commitOf(requested);
  if (!base) {
    throw new Error(
      opts.base
        ? `no commit named "${requested}"`
        : `found no base branch (tried ${FALLBACK_BASES.join(', ')}); pass --base`,
    );
  }
  const baseName = opts.baseName ?? requested;
  if ((await git('merge-base', base, headSha)).code !== 0) {
    throw new Error(`${headRef} and ${baseName} share no history`);
  }
  const commits = Number((await execOrThrow(['git', '-C', dir, 'rev-list', '--count', `${base}..${headSha}`])).trim());
  if (commits === 0) throw new Error(`nothing to review: ${headRef} has no commits that ${baseName} lacks`);
  const dirty =
    head === 'HEAD' && (await git('status', '--porcelain', '--untracked-files=no')).stdout.trim().length > 0;

  const configured = config.repos.find((r) => real(r.localPath) === real(dir));
  const fullName = configured?.fullName ?? (await originName(dir)) ?? basename(dir);
  const repo: RepoConfig = {
    trigger: 'auto',
    github: { onPush: false, mention: '@review-relay' },
    authors: [],
    ...configured,
    fullName,
    // The checkout itself, which may be a linked worktree of the configured clone.
    localPath: dir,
    postToPr: false,
  };
  const job: ResolvedJob = {
    repo: fullName,
    pr: 0,
    source: 'local',
    reason: `local review of ${headRef} against ${baseName}`,
    headSha,
    headRef,
    baseRef: await branchOf(dir, baseName),
    base,
    baseName,
    ...(opts.route ? { route: opts.route } : {}),
  };
  return { job, repo, commits, dirty };
}

/** The remote's default branch as the clone recorded it (`origin/main`), else the first fallback that exists. */
async function defaultBase(dir: string): Promise<string> {
  const head = await exec(['git', '-C', dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of FALLBACK_BASES) {
    const r = await exec(['git', '-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.code === 0) return ref;
  }
  return FALLBACK_BASES[0]!;
}

/** The branch name routes match `baseBranches` against: `origin/main` is `main`; a local branch or SHA stays as is. */
async function branchOf(dir: string, base: string): Promise<string> {
  const remotes = (await exec(['git', '-C', dir, 'remote'])).stdout.split('\n').filter(Boolean);
  const remote = remotes.find((name) => base.startsWith(`${name}/`));
  return remote ? base.slice(remote.length + 1) : base;
}

/** `owner/name` from the clone's origin remote, when it is on GitHub. */
async function originName(dir: string): Promise<string | undefined> {
  const url = await exec(['git', '-C', dir, 'remote', 'get-url', 'origin']);
  return url.code === 0 ? parseGithubRemote(url.stdout) : undefined;
}

/** Why a local review can't start: another process is reviewing the same commit. */
export const busyLocal = (job: { headRef?: string; headSha: string }) =>
  `${job.headRef} @ ${job.headSha.slice(0, 8)} is already being reviewed`;

/** The prefix of a local review's log lines, which the TUI also uses to find them. */
export const localTag = (job: { repo: string; branch?: string; headSha: string }) =>
  `[${job.repo}] branch ${job.branch} @ ${job.headSha.slice(0, 8)}`;

/** A local review reads the checkout's own commits and refs, so nothing is fetched. */
export const LOCAL_DEPS: RunnerDeps = { ...RUNNER_DEPS, fetch: async () => {} };

export interface LocalRun {
  state: StateStore;
  log: (message: string) => void;
  /** Aborting stops the reviewers; the job is recorded as failed and no report is written. */
  signal?: AbortSignal;
  deps?: RunnerDeps;
}

/**
 * Runs a local review and records it in job state as it goes, so `status` and the TUI list it whether it runs in the
 * foreground or the background. Throws, after recording the failure, when the review fails, and without touching
 * the record when another live process is already reviewing the same commit.
 */
export async function reviewLocal(target: LocalTarget, config: Config, run: LocalRun): Promise<ReviewOutcome> {
  const { job, repo } = target;
  const key = jobKey(job);
  const tag = localTag({ ...job, branch: job.headRef });
  const claimed = run.state.claim({
    key,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    source: job.source,
    branch: job.headRef,
    // The name, so a re-run diffs against where the base is then.
    base: job.baseName,
    localPath: repo.localPath,
  });
  // Another review of this commit would write the same report folder, so it waits its turn.
  if (!claimed) throw new Error(`${busyLocal(job)}; wait for it to finish or follow it in review-relay tui`);
  run.state.begin(key);
  run.log(`${tag}: reviewing (${job.reason})`);
  try {
    const outcome = await runReview(job, repo, config, run.deps ?? LOCAL_DEPS, run.signal);
    if (run.signal?.aborted) {
      run.state.finish(key, { status: 'failed', error: 'stopped before finishing', route: outcome.route?.name });
      run.log(`${tag}: stopped before finishing`);
      return outcome;
    }
    const via = outcome.route ? `route ${outcome.route.name} (${outcome.route.reason}), ` : '';
    run.state.finish(key, { status: 'done', reportDir: outcome.reportDir, route: outcome.route?.name });
    run.log(`${tag}: ${via}done -> ${outcome.reportDir}`);
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    run.state.finish(key, { status: 'failed', error });
    run.log(`${tag}: failed: ${error}`);
    throw err;
  }
}
