import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { execOrThrow } from '../src/exec.ts';
import { LOCAL_DEPS, localTarget, reviewLocal } from '../src/local.ts';
import { HARNESSES } from '../src/reviewers/index.ts';
import type { Harness } from '../src/reviewers/types.ts';
import type { RunnerDeps } from '../src/runner.ts';
import { StateStore } from '../src/state.ts';
import type { HarnessName } from '../src/types.ts';
import { sweepLocal } from '../src/worktree.ts';
import { DIMENSIONS, type Verdict } from '../src/verdict.ts';

const root = mkdtempSync(join(tmpdir(), 'relay-local-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
  execOrThrow(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

/** A clone of a bare origin with `main` pushed and a `feature` branch one commit ahead, checked out. */
async function clone(name: string) {
  const origin = join(root, `${name}.git`);
  const dir = join(root, name);
  await execOrThrow(['git', 'init', '--quiet', '--bare', '--initial-branch=main', origin]);
  await execOrThrow(['git', 'clone', '--quiet', origin, dir]);
  await git(dir, 'checkout', '--quiet', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  await git(dir, 'add', 'a.txt');
  await git(dir, 'commit', '--quiet', '-m', 'base');
  await git(dir, 'push', '--quiet', 'origin', 'main');
  await git(dir, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  await git(dir, 'add', 'b.txt');
  await git(dir, 'commit', '--quiet', '-m', 'add b');
  return dir;
}

const config = (repos: { fullName: string; localPath: string }[] = [{ fullName: 'o/other', localPath: root }]) =>
  parseConfig({ repos, dataDir: root });

describe('localTarget', () => {
  test('reviews the checked-out branch against the remote default branch, and never posts', async () => {
    const dir = await clone('plain');
    const head = (await git(dir, 'rev-parse', 'HEAD')).trim();
    const main = (await git(dir, 'rev-parse', 'origin/main')).trim();
    const target = await localTarget(config(), dir);
    expect(target.job).toEqual({
      repo: 'plain',
      pr: 0,
      source: 'local',
      reason: 'local review of feature against origin/main',
      headSha: head,
      headRef: 'feature',
      baseRef: 'main',
      base: main,
      baseName: 'origin/main',
    });
    expect(target.commits).toBe(1);
    expect(target.dirty).toBe(false);
    expect(target.repo).toMatchObject({ fullName: 'plain', localPath: dir, postToPr: false });
  });

  test('takes the config entry that names the clone, and flags uncommitted changes', async () => {
    const dir = await clone('configured');
    writeFileSync(join(dir, 'b.txt'), 'changed\n');
    const target = await localTarget(config([{ fullName: 'acme/widget', localPath: dir }]), dir, { route: 'deep' });
    expect(target.job.repo).toBe('acme/widget');
    expect(target.job.route).toBe('deep');
    expect(target.repo).toMatchObject({ fullName: 'acme/widget', postToPr: false, trigger: 'auto' });
    expect(target.dirty).toBe(true);
  });

  test('takes --base and --head refs, and refuses a branch with nothing to review', async () => {
    const dir = await clone('refs');
    const main = (await git(dir, 'rev-parse', 'main')).trim();
    const target = await localTarget(config(), dir, { base: 'main', head: 'feature' });
    expect(target.job).toMatchObject({ base: main, baseName: 'main', baseRef: 'main', headRef: 'feature' });

    // A HEAD-relative base is pinned where it was given, since HEAD is another commit in the review's worktree.
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    await git(dir, 'add', 'c.txt');
    await git(dir, 'commit', '--quiet', '-m', 'add c');
    const relative = await localTarget(config(), dir, { base: 'HEAD~2', head: 'HEAD~1' });
    expect(relative.job.base).toBe(main);
    expect(relative.commits).toBe(1);
    expect(relative.job.reason).toBe('local review of HEAD~1 against HEAD~2');
    // A worker given the resolved SHAs still shows and routes by the names.
    const worker = await localTarget(config(), dir, {
      base: main,
      baseName: 'origin/main',
      head: target.job.headSha,
      headName: 'feature',
    });
    expect(worker.job).toMatchObject({ base: main, baseName: 'origin/main', baseRef: 'main', headRef: 'feature' });
    await expect(localTarget(config(), dir, { base: 'feature' })).rejects.toThrow(
      'nothing to review: feature has no commits that feature lacks',
    );
    await expect(localTarget(config(), dir, { base: 'nope' })).rejects.toThrow('no commit named "nope"');
    await expect(localTarget(config(), root)).rejects.toThrow('is not inside a git checkout');
  });
});

const verdict: Verdict = {
  summary: 'Adds b.',
  score: 4,
  scoreRationale: 'Fine.',
  dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 4, note: 'ok' }])) as Verdict['dimensions'],
  findings: [],
};

/** The real checkout and git, with every CLI faked to answer `verdict`, or to fail. */
const deps = (ok: boolean): RunnerDeps => {
  const fake = (name: HarnessName): Harness => ({
    ...HARNESSES[name],
    run: async () =>
      ok
        ? { code: 0, stdout: '', stderr: '', timedOut: false, raw: '{}', verdict }
        : { code: 1, stdout: '', stderr: 'boom', timedOut: false, raw: 'boom' },
  });
  return {
    ...LOCAL_DEPS,
    findBin: () => '/bin/true',
    harnesses: Object.fromEntries(
      Object.keys(HARNESSES).map((name) => [name, fake(name as HarnessName)]),
    ) as RunnerDeps['harnesses'],
  };
};

describe('reviewLocal', () => {
  test('records the job as it runs, with the branch, base, and checkout, and logs under the branch tag', async () => {
    const dir = await clone('lifecycle');
    const c = parseConfig({
      repos: [{ fullName: 'acme/widget', localPath: dir }],
      dataDir: root,
      reviewers: ['claude'],
    });
    const target = await localTarget(c, dir);
    const state = new StateStore(join(root, 'state.json'));
    const logged: string[] = [];
    const outcome = await reviewLocal(target, c, { state, log: (m) => logged.push(m), deps: deps(true) });
    const sha = target.job.headSha;
    expect(state.list()[0]).toMatchObject({
      key: `acme/widget@${sha}:local`,
      pr: 0,
      source: 'local',
      status: 'done',
      branch: 'feature',
      base: 'origin/main',
      localPath: dir,
      reportDir: outcome.reportDir,
      pid: process.pid,
    });
    expect(logged).toEqual([
      `[acme/widget] branch feature @ ${sha.slice(0, 8)}: reviewing (local review of feature against origin/main)`,
      `[acme/widget] branch feature @ ${sha.slice(0, 8)}: done -> ${outcome.reportDir}`,
    ]);

    // A live process holding the commit keeps it: no second review, and its record is left alone.
    const holder = new StateStore(join(root, 'state.json'));
    writeFileSync(
      join(root, 'state.json'),
      JSON.stringify([{ ...holder.list()[0], status: 'running', pid: process.ppid }]),
    );
    await expect(reviewLocal(target, c, { state, log: () => {}, deps: deps(true) })).rejects.toThrow(
      `feature @ ${sha.slice(0, 8)} is already being reviewed`,
    );
    expect(new StateStore(join(root, 'state.json')).list()[0]).toMatchObject({ status: 'running', pid: process.ppid });
    writeFileSync(join(root, 'state.json'), '[]');

    await expect(reviewLocal(target, c, { state, log: () => {}, deps: deps(false) })).rejects.toThrow(
      'all reviewers failed',
    );
    expect(state.list()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('all reviewers failed') });
  });
});

describe('sweepLocal', () => {
  test('removes local worktrees and scratch whose process is gone, and keeps live ones and PR ones', async () => {
    const dir = await clone('sweep');
    const dataDir = join(root, 'sweep-data');
    const worktrees = join(dataDir, 'worktrees');
    const add = async (name: string) => {
      await git(dir, 'worktree', 'add', '--detach', '--quiet', join(worktrees, name), 'HEAD');
      mkdirSync(join(dataDir, 'tmp', name), { recursive: true });
    };
    const dead = Bun.spawnSync(['true']).pid;
    await add(`o__r-local${dead}-abcdef12`);
    await add(`o__r-local${process.pid}-abcdef12`);
    await add('o__r-pr7-abcdef12');
    await sweepLocal(dir, dataDir);
    expect(readdirSync(worktrees).toSorted()).toEqual([`o__r-local${process.pid}-abcdef12`, 'o__r-pr7-abcdef12']);
    expect(readdirSync(join(dataDir, 'tmp')).toSorted()).toEqual([
      `o__r-local${process.pid}-abcdef12`,
      'o__r-pr7-abcdef12',
    ]);
    expect(await git(dir, 'worktree', 'list')).not.toContain(`local${dead}`);
  });
});
