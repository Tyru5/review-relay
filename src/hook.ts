/**
 * `review-relay hook install` and `uninstall`: a git pre-push hook that runs `review --min-score` on each pushed branch
 * with commits no remote has yet, and blocks the push when one scores under the threshold or fails.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec } from './exec.ts';

/** Marks a hook review-relay wrote; any other pre-push is never touched. */
export const HOOK_MARKER = '# review-relay pre-push hook';

export interface HookOptions {
  /** The command that runs review-relay, absolute, such as the binary or `bun /path/src/cli.ts`. */
  command: string[];
  minScore: number;
  /** Passed through to `review`. */
  base?: string;
  route?: string;
  reviewers?: string;
  config?: string;
}

/** Single-quotes for sh, so paths with spaces or quotes pass through whole. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `review` call the hook makes for one branch, ahead of its `--head` arguments. */
export function hookReviewArgs(opts: HookOptions): string[] {
  return [
    ...opts.command,
    ...(opts.config ? ['--config', opts.config] : []),
    'review',
    '--min-score',
    String(opts.minScore),
    ...(opts.base ? ['--base', opts.base] : []),
    ...(opts.route ? ['--route', opts.route] : []),
    ...(opts.reviewers ? ['--reviewers', opts.reviewers] : []),
  ];
}

/**
 * The hook script. git passes `<local ref> <local sha> <remote ref> <remote sha>` per pushed ref on stdin; a branch
 * deletion has an all-zero local sha. A branch whose commits are all on some remote already has nothing new to score.
 */
export function hookScript(opts: HookOptions): string {
  const review = hookReviewArgs(opts).map(shQuote).join(' ');
  return `#!/bin/sh
${HOOK_MARKER}. Remove it with: review-relay hook uninstall
# Skip it once with: git push --no-verify
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in refs/heads/*) ;; *) continue ;; esac
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  [ -n "$(git rev-list -n 1 "$local_sha" --not --remotes)" ] || continue
  ${review} --head "$local_sha" --head-name "\${local_ref#refs/heads/}" </dev/null || status=1
done
exit $status
`;
}

/** Where git looks for hooks in the checkout at `cwd`, following `core.hooksPath`. */
export async function hooksDir(cwd: string): Promise<string> {
  const r = await exec(['git', '-C', cwd, 'rev-parse', '--git-path', 'hooks']);
  if (r.code !== 0) throw new Error(`${cwd} is not inside a git checkout`);
  // Relative to the directory git ran in.
  return resolve(cwd, r.stdout.trim());
}

const ours = (path: string) => existsSync(path) && readFileSync(path, 'utf8').includes(HOOK_MARKER);

/**
 * Writes the pre-push hook, replacing review-relay's own. Throws, naming the line to add, when another pre-push is
 * there.
 */
export async function installHook(cwd: string, opts: HookOptions): Promise<{ path: string; replaced: boolean }> {
  const dir = await hooksDir(cwd);
  const path = join(dir, 'pre-push');
  const replaced = ours(path);
  if (existsSync(path) && !replaced) {
    const line = `${hookReviewArgs(opts).map(shQuote).join(' ')} --head HEAD`;
    throw new Error(
      `${path} exists and review-relay did not write it, so it was left alone. To score pushes from it, add:\n  ${line}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, hookScript(opts));
  chmodSync(path, 0o755);
  return { path, replaced };
}

/** Removes review-relay's pre-push hook; returns its path, or null when there was none to remove. */
export async function uninstallHook(cwd: string): Promise<string | null> {
  const path = join(await hooksDir(cwd), 'pre-push');
  if (!ours(path)) {
    if (existsSync(path)) throw new Error(`${path} was not written by review-relay, so it was left alone`);
    return null;
  }
  rmSync(path);
  return path;
}
