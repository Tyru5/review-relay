import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './config.ts';
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

/** Checks out the fetched PR head in a detached worktree of the local clone, runs `fn`, then removes it. */
export async function withCheckout<T>(
  repo: RepoConfig,
  job: ResolvedJob,
  dataDir: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const root = join(dataDir, 'worktrees');
  mkdirSync(root, { recursive: true });
  const dir = join(root, workName(job));
  await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  await execOrThrow(['git', '-C', repo.localPath, 'worktree', 'add', '--detach', '--quiet', dir, job.headSha]);
  try {
    return await fn(dir);
  } finally {
    await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  }
}
