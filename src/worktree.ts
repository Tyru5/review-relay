import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RepoConfig } from './config.ts';
import { isAlive } from './daemon.ts';
import { exec, execOrThrow } from './exec.ts';
import { isLocal, type ResolvedJob } from './types.ts';

export const baseRemoteRef = (job: ResolvedJob) => job.base ?? `origin/${job.baseRef}`;

/**
 * Names a review's worktree and scratch folders. A local review adds the pid, so two runs on one commit, or one next
 * to the daemon's review of the same commit, never share or remove each other's folders.
 */
export const workName = (job: ResolvedJob) =>
  `${job.repo.replace('/', '__')}-${isLocal(job) ? `local${process.pid}` : `pr${job.pr}`}-${job.headSha.slice(0, 8)}`.replace(
    /[^\w.-]+/g,
    '_',
  );

/** Fetches the base branch and the PR head into the local clone, so the diff can be read before any checkout. */
export async function fetchPr(repo: RepoConfig, job: ResolvedJob): Promise<void> {
  const git = (...args: string[]) => execOrThrow(['git', '-C', repo.localPath, ...args]);
  // `refs/pull/N/head` also covers fork PRs, whose commits are not on any branch of origin.
  await git(
    'fetch',
    '--quiet',
    'origin',
    `+refs/heads/${job.baseRef}:refs/remotes/origin/${job.baseRef}`,
    `+refs/pull/${job.pr}/head:refs/review-relay/pr-${job.pr}`,
  );
  const hasCommit = await exec(['git', '-C', repo.localPath, 'cat-file', '-e', `${job.headSha}^{commit}`]);
  if (hasCommit.code !== 0) await git('fetch', '--quiet', 'origin', job.headSha);
}

/** A local review's worktree or scratch folder name, with the pid of the process that made it. */
const LOCAL_WORK = /-local(\d+)-[0-9a-f]{8}$/;

/**
 * Removes the worktrees and scratch folders that local reviews of this clone left when their process was killed
 * before it could clean up. Their names carry the pid, so a later review never reuses one and removes it itself.
 */
export async function sweepLocal(clone: string, dataDir: string): Promise<void> {
  let root: string;
  try {
    root = realpathSync(join(dataDir, 'worktrees'));
  } catch {
    return;
  }
  const listed = await exec(['git', '-C', clone, 'worktree', 'list', '--porcelain']);
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length);
    const pid = LOCAL_WORK.exec(basename(dir))?.[1];
    if (dirname(dir) !== root || !pid || isAlive(Number(pid))) continue;
    await exec(['git', '-C', clone, 'worktree', 'remove', '--force', dir]);
    rmSync(join(dataDir, 'tmp', basename(dir)), { recursive: true, force: true });
  }
}

/** Checks out the fetched PR head in a detached worktree of the local clone, runs `fn`, then removes it. */
export async function withCheckout<T>(
  repo: RepoConfig,
  job: ResolvedJob,
  dataDir: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const root = join(dataDir, 'worktrees');
  mkdirSync(root, { recursive: true });
  if (isLocal(job)) await sweepLocal(repo.localPath, dataDir);
  const dir = join(root, workName(job));
  await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  await execOrThrow(['git', '-C', repo.localPath, 'worktree', 'add', '--detach', '--quiet', dir, job.headSha]);
  try {
    return await fn(dir);
  } finally {
    await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  }
}
