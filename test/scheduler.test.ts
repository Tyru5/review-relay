import { describe, expect, test } from 'bun:test';
import type { RepoConfig } from '../src/config.ts';
import type { Classified } from '../src/match.ts';
import { Scheduler } from '../src/scheduler.ts';
import { StateStore } from '../src/state.ts';
import type { ResolvedJob, ReviewJob, TriggerMode } from '../src/types.ts';

const SHA = '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0';

const repoWith = (trigger: TriggerMode): RepoConfig => ({
  fullName: 'Tyru5/Agendex',
  localPath: '/tmp/agendex',
  trigger,
  postToPr: false,
  github: { onPush: false, mention: '@review-relay' },
});

const job = (source: ReviewJob['source'], sha = SHA): ReviewJob => ({
  repo: 'Tyru5/Agendex', pr: 223, source, reason: source, headSha: sha, baseRef: 'main',
});
const greptileStart = (sha = SHA): Classified => ({ kind: 'greptileStart', job: job('greptile', sha) });
const prEvent = (sha = SHA): Classified => ({ kind: 'prEvent', job: job('github', sha) });
const mention: Classified = { kind: 'mention', job: { repo: 'Tyru5/Agendex', pr: 223, source: 'mention', reason: 'mention' } };

/** Scheduler with manual timers so grace periods fire only when the test says so. */
function setup(graceMs = 120_000) {
  const runs: ResolvedJob[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = new Scheduler({
    state: new StateStore(null),
    graceMs,
    resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
    run: async (j) => {
      runs.push(j);
      return {};
    },
    log: () => {},
    setTimer: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const fireTimers = () => {
    const fns = [...timers.values()];
    timers.clear();
    for (const fn of fns) fn();
  };
  return { scheduler, runs, timers, fireTimers };
}

describe('auto mode', () => {
  test('Greptile start runs immediately', async () => {
    const { scheduler, runs } = setup();
    scheduler.handle(repoWith('auto'), greptileStart());
    await scheduler.idle();
    expect(runs.map((r) => r.source)).toEqual(['greptile']);
  });

  test('Greptile arriving inside the grace period cancels the fallback (one run)', async () => {
    const { scheduler, runs, timers } = setup();
    const repo = repoWith('auto');
    scheduler.handle(repo, prEvent());
    expect(timers.size).toBe(1);
    scheduler.handle(repo, greptileStart());
    expect(timers.size).toBe(0);
    await scheduler.idle();
    expect(runs.map((r) => r.source)).toEqual(['greptile']);
  });

  test('no Greptile start: the GitHub event runs when the grace period ends', async () => {
    const { scheduler, runs, fireTimers } = setup();
    scheduler.handle(repoWith('auto'), prEvent());
    expect(runs).toHaveLength(0);
    fireTimers();
    await scheduler.idle();
    expect(runs.map((r) => r.source)).toEqual(['github']);
  });

  test('Greptile starting after the fallback ran is deduped by commit', async () => {
    const { scheduler, runs, fireTimers } = setup();
    const repo = repoWith('auto');
    scheduler.handle(repo, prEvent());
    fireTimers();
    await scheduler.idle();
    scheduler.handle(repo, greptileStart());
    await scheduler.idle();
    expect(runs.map((r) => r.source)).toEqual(['github']);
  });

  test('a new commit is reviewed again', async () => {
    const { scheduler, runs } = setup();
    const repo = repoWith('auto');
    scheduler.handle(repo, greptileStart(SHA));
    await scheduler.idle();
    scheduler.handle(repo, greptileStart('ffffffffffffffffffffffffffffffffffffffff'));
    await scheduler.idle();
    expect(runs).toHaveLength(2);
  });
});

describe('github mode', () => {
  test('PR events run immediately and Greptile is ignored', async () => {
    const { scheduler, runs, timers } = setup();
    const repo = repoWith('github');
    scheduler.handle(repo, greptileStart('ffffffffffffffffffffffffffffffffffffffff'));
    scheduler.handle(repo, prEvent());
    expect(timers.size).toBe(0);
    await scheduler.idle();
    expect(runs.map((r) => r.source)).toEqual(['github']);
  });
});

describe('greptile mode', () => {
  test('PR events are ignored', async () => {
    const { scheduler, runs, timers } = setup();
    scheduler.handle(repoWith('greptile'), prEvent());
    expect(timers.size).toBe(0);
    await scheduler.idle();
    expect(runs).toHaveLength(0);
  });
});

test('mentions resolve the PR head and bypass dedupe in every mode', async () => {
  const { scheduler, runs } = setup();
  const repo = repoWith('greptile');
  scheduler.handle(repo, greptileStart());
  await scheduler.idle();
  scheduler.handle(repo, mention);
  await scheduler.idle();
  expect(runs.map((r) => [r.source, r.headSha])).toEqual([
    ['greptile', SHA],
    ['mention', SHA],
  ]);
});

test('a failed run can be retried by the next trigger', async () => {
  const state = new StateStore(null);
  let calls = 0;
  const scheduler = new Scheduler({
    state,
    graceMs: 0,
    resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
    run: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return {};
    },
    log: () => {},
  });
  const repo = repoWith('auto');
  scheduler.handle(repo, greptileStart());
  await scheduler.idle();
  expect(state.list()[0]?.status).toBe('failed');
  scheduler.handle(repo, greptileStart());
  await scheduler.idle();
  expect(calls).toBe(2);
  expect(state.list()[0]?.status).toBe('done');
});
