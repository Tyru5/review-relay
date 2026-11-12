import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, execOrThrow } from '../src/exec.ts';
import { HOOK_MARKER, installHook, uninstallHook, type HookOptions } from '../src/hook.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A clone of a bare remote with one pushed commit, and a fake review-relay that records its arguments and exits with
 * the code in its `exit-code` file, so the hook runs for real under `git push`.
 */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'relay hook '));
  dirs.push(root);
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  await execOrThrow(['git', 'init', '-q', '--bare', '-b', 'main', remote]);
  await execOrThrow(['git', 'clone', '-q', remote, clone]);
  const git = (...args: string[]) => exec(['git', '-C', clone, ...args]);
  await git('config', 'user.email', 't@example.com');
  await git('config', 'user.name', 't');
  await git('commit', '-q', '--allow-empty', '-m', 'base');
  await git('push', '-q', 'origin', 'HEAD:main');

  const calls = join(root, 'calls');
  const exitCode = join(root, 'exit-code');
  const fake = join(root, 'fake relay');
  writeFileSync(exitCode, '0');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s|' "$@" >> '${calls}'\necho >> '${calls}'\nexit "$(cat '${exitCode}')"\n`);
  chmodSync(fake, 0o755);
  const opts: HookOptions = { command: [fake], minScore: 4 };
  const commit = async (message: string) => {
    await git('commit', '-q', '--allow-empty', '-m', message);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  const reviews = () =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('|').filter(Boolean))
      : [];
  return { clone, git, opts, commit, reviews, exitCode, fake };
}

describe('pre-push hook', () => {
  test('reviews each pushed branch with new commits and blocks the push when a review fails', async () => {
    const t = await setup();
    const { path, replaced } = await installHook(t.clone, { ...t.opts, minScore: 3, base: 'origin/main' });
    expect(path).toBe(join(t.clone, '.git', 'hooks', 'pre-push'));
    expect(replaced).toBe(false);

    await t.git('switch', '-qc', 'feat/a');
    const sha = await t.commit('a');
    expect((await t.git('push', '-q', 'origin', 'feat/a')).code).toBe(0);
    expect(t.reviews()).toEqual([
      ['review', '--min-score', '3', '--base', 'origin/main', '--head', sha, '--head-name', 'feat/a'],
    ]);

    // Already on the remote, a deletion, and a tag: nothing new to score.
    expect((await t.git('push', '-q', 'origin', 'feat/a:feat/b')).code).toBe(0);
    expect((await t.git('push', '-q', 'origin', ':feat/b')).code).toBe(0);
    await t.git('tag', 'v1');
    expect((await t.git('push', '-q', 'origin', 'v1')).code).toBe(0);
    expect(t.reviews()).toHaveLength(1);

    // Under the threshold: the push stops and the remote keeps the old commit; --no-verify gets through.
    const blocked = await t.commit('b');
    writeFileSync(t.exitCode, '1');
    expect((await t.git('push', '-q', 'origin', 'feat/a')).code).not.toBe(0);
    expect((await t.git('ls-remote', 'origin', 'feat/a')).stdout).toStartWith(sha);
    expect((await t.git('push', '-q', '--no-verify', 'origin', 'feat/a')).code).toBe(0);
    expect((await t.git('ls-remote', 'origin', 'feat/a')).stdout).toStartWith(blocked);
    expect(t.reviews()).toHaveLength(2);
  });

  test('follows core.hooksPath, replaces its own hook, and never touches another', async () => {
    const t = await setup();
    await t.git('config', 'core.hooksPath', '.husky');
    const first = await installHook(t.clone, t.opts);
    expect(first.path).toBe(join(t.clone, '.husky', 'pre-push'));
    const again = await installHook(t.clone, { ...t.opts, minScore: 5, config: '/etc/relay.json' });
    expect(again.replaced).toBe(true);
    expect(readFileSync(again.path, 'utf8')).toContain(`'--config' '/etc/relay.json' 'review' '--min-score' '5'`);
    expect(await uninstallHook(t.clone)).toBe(again.path);
    expect(existsSync(again.path)).toBe(false);
    expect(await uninstallHook(t.clone)).toBeNull();

    mkdirSync(join(t.clone, '.husky'), { recursive: true });
    writeFileSync(join(t.clone, '.husky', 'pre-push'), '#!/bin/sh\nnpm test\n');
    await expect(installHook(t.clone, t.opts)).rejects.toThrow(/did not write it[\s\S]*'review' '--min-score' '4'/);
    await expect(uninstallHook(t.clone)).rejects.toThrow('was not written by review-relay');
    expect(readFileSync(join(t.clone, '.husky', 'pre-push'), 'utf8')).not.toContain(HOOK_MARKER);
  });
});
