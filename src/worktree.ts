import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './config.ts';
import { exec, execOrThrow } from './exec.ts';
import type { ResolvedJob } from './types.ts';

export const baseRemoteRef = (job: ResolvedJob) => `origin/${job.baseRef}`;

/** Checks out the PR head in a detached worktree of the local clone, runs `fn`, then removes it. */
export async function withWorktree<T>(
  repo: RepoConfig,
  job: ResolvedJob,
  dataDir: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
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

  const root = join(dataDir, 'worktrees');
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${job.repo.replace('/', '__')}-pr${job.pr}-${job.headSha.slice(0, 8)}`);
  await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  await git('worktree', 'add', '--detach', '--quiet', dir, job.headSha);
  try {
    return await fn(dir);
  } finally {
    await exec(['git', '-C', repo.localPath, 'worktree', 'remove', '--force', dir]);
  }
}
