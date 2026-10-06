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
  repo: 'Tyru5/Agendex',
  pr: 223,
  source,
  reason: source,
  headSha: sha,
  baseRef: 'main',
});
const greptileStart = (sha = SHA): Classified => ({ kind: 'greptileStart', job: job('greptile', sha) });
const prEvent = (sha = SHA): Classified => ({ kind: 'prEvent', job: job('github', sha) });
const mention: Classified = {
  kind: 'mention',
  job: { repo: 'Tyru5/Agendex', pr: 223, source: 'mention', reason: 'mention' },
};

/** Scheduler with manual timers so grace periods fire only when the test says so. */
function setup(graceMs = 120_000) {
  const runs: ResolvedJob[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = new Scheduler({
    state: new StateStore(null),
    graceMs,
    resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
    prHead: async (j) => j.headSha,
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
    prHead: async (j) => j.headSha,
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

test('a skip route records the commit as skipped and handled, with its route', async () => {
  const state = new StateStore(null);
  const logs: string[] = [];
  let calls = 0;
  const route = { name: 'docs', reason: 'onlyPaths: 2 files', forced: false };
  const scheduler = new Scheduler({
    state,
    graceMs: 0,
    resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
    prHead: async (j) => j.headSha,
    run: async () => {
      calls += 1;
      return calls === 1 ? { route, skipped: true } : { reportDir: '/tmp/r', route };
    },
    log: (message) => logs.push(message),
  });
  const repo = repoWith('auto');
  scheduler.handle(repo, greptileStart());
  await scheduler.idle();
  expect(state.list()[0]).toMatchObject({ status: 'skipped', route: 'docs' });
  expect(logs.at(-1)).toBe('[Tyru5/Agendex] PR #223: route docs (onlyPaths: 2 files), skipped');
  // The same commit isn't routed again, but a mention reviews it.
  scheduler.handle(repo, greptileStart());
  await scheduler.idle();
  expect(calls).toBe(1);
  scheduler.handle(repo, mention);
  await scheduler.idle();
  expect(calls).toBe(2);
  expect(state.list()[0]).toMatchObject({ status: 'done', route: 'docs', reportDir: '/tmp/r' });
  expect(logs.at(-1)).toBe('[Tyru5/Agendex] PR #223: route docs (onlyPaths: 2 files), done -> /tmp/r');
});

describe('stale commits and the queue', () => {
  const NEWER = 'ffffffffffffffffffffffffffffffffffffffff';
  const settle = () => Bun.sleep(5);

  /** A scheduler whose PR heads come from `heads` and whose reviews each wait for `finish(sha)`. */
  function gated(opts: { maxConcurrent?: number } = {}) {
    const state = new StateStore(null);
    const heads = new Map<number, string>();
    const runs: ResolvedJob[] = [];
    const signals = new Map<string, AbortSignal>();
    const gates = new Map<string, () => void>();
    const scheduler = new Scheduler({
      state,
      graceMs: 0,
      maxConcurrent: opts.maxConcurrent,
      resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
      prHead: async (j) => heads.get(j.pr) ?? j.headSha,
      run: (j, _repo, signal) => {
        runs.push(j);
        signals.set(j.headSha, signal);
        return new Promise((resolve, reject) => {
          gates.set(j.headSha, () => resolve({ reportDir: `/tmp/${j.headSha}` }));
          signal.addEventListener('abort', () => reject(new Error('reviewer exited 143')));
        });
      },
      log: () => {},
    });
    const start = (pr: number, sha: string) =>
      scheduler.handle(repoWith('greptile'), { kind: 'greptileStart', job: { ...job('greptile', sha), pr } });
    const finish = (sha: string) => gates.get(sha)!();
    const status = (sha: string) => state.list().find((r) => r.headSha === sha);
    return { scheduler, state, heads, runs, signals, start, finish, status };
  }

  test('a commit that is no longer the PR head is not reviewed, and stays open to a later review', async () => {
    const t = gated();
    t.heads.set(223, NEWER);
    t.start(223, SHA);
    await t.scheduler.idle();
    expect(t.runs).toEqual([]);
    expect(t.status(SHA)).toMatchObject({ status: 'superseded', supersededBy: NEWER });

    // Force-pushed back: the commit is the head again, so it gets its review.
    t.heads.set(223, SHA);
    t.start(223, SHA);
    await settle();
    t.finish(SHA);
    await t.scheduler.idle();
    expect(t.status(SHA)).toMatchObject({ status: 'done', reportDir: `/tmp/${SHA}` });
  });

  test('reviewing the new head stops the review of the older commit on the same PR only', async () => {
    const OTHER_PR = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const t = gated();
    t.start(223, SHA);
    t.start(9, OTHER_PR);
    await settle();
    expect(t.status(SHA)?.status).toBe('running');

    t.heads.set(223, NEWER);
    t.start(223, NEWER);
    await settle();
    expect(t.signals.get(SHA)?.aborted).toBe(true);
    expect(t.signals.get(SHA)?.reason).toBe(NEWER);
    expect(t.signals.get(OTHER_PR)?.aborted).toBe(false);
    expect(t.status(SHA)).toMatchObject({ status: 'superseded', supersededBy: NEWER });
    expect(t.status(SHA)?.error).toBeUndefined();

    t.finish(NEWER);
    t.finish(OTHER_PR);
    await t.scheduler.idle();
    expect(t.status(NEWER)?.status).toBe('done');
    expect(t.status(OTHER_PR)?.status).toBe('done');
  });

  test('a review the runner could not post because the PR moved on is superseded, with its report', async () => {
    const state = new StateStore(null);
    const scheduler = new Scheduler({
      state,
      graceMs: 0,
      resolve: async (j) => ({ ...j, headSha: SHA, baseRef: 'main' }),
      prHead: async (j) => j.headSha,
      run: async () => ({ reportDir: '/tmp/r', supersededBy: NEWER }),
      log: () => {},
    });
    scheduler.handle(repoWith('greptile'), greptileStart());
    await scheduler.idle();
    expect(state.list()[0]).toMatchObject({ status: 'superseded', supersededBy: NEWER, reportDir: '/tmp/r' });
    expect(state.isHandled(state.list()[0]!.key)).toBe(false);
  });

  test('maxConcurrent runs that many reviews and queues the rest, oldest first', async () => {
    const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(40)) as [string, string, string];
    const t = gated({ maxConcurrent: 2 });
    t.start(1, A);
    t.start(2, B);
    t.start(3, C);
    await settle();
    expect(t.runs.map((r) => r.headSha)).toEqual([A, B]);
    expect(t.status(C)?.status).toBe('queued');
    // A second event for a queued commit doesn't queue it twice.
    t.start(3, C);
    t.finish(B);
    await settle();
    expect(t.runs.map((r) => r.headSha)).toEqual([A, B, C]);
    expect(t.status(C)?.status).toBe('running');
    t.finish(A);
    t.finish(C);
    await t.scheduler.idle();
    expect(t.runs).toHaveLength(3);
    expect([A, B, C].map((sha) => t.status(sha)?.status)).toEqual(['done', 'done', 'done']);
  });

  test('a queued commit whose PR moved on while it waited is dropped when its turn comes', async () => {
    const A = 'a'.repeat(40);
    const t = gated({ maxConcurrent: 1 });
    t.start(1, A);
    t.start(223, SHA);
    await settle();
    expect(t.status(SHA)?.status).toBe('queued');
    t.heads.set(223, NEWER);
    t.finish(A);
    await t.scheduler.idle();
    expect(t.runs.map((r) => r.headSha)).toEqual([A]);
    expect(t.status(SHA)).toMatchObject({ status: 'superseded', supersededBy: NEWER });
  });
});
