import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.ts';

const job = (key: string) => ({ key, repo: 'o/r', pr: 1, headSha: key, source: 'github' as const });

test('keeps only the newest jobs on disk', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-state-')), 'state.json');
  const store = new StateStore(path, 3);
  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    store.queue(job(key));
    store.begin(key);
    store.finish(key, { status: 'done' });
    Bun.sleepSync(2);
  }
  expect(store.list().map((r) => r.key)).toEqual(['e', 'd', 'c']);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { key: string }[];
  expect(saved.map((r) => r.key)).toEqual(['e', 'd', 'c']);
  expect(new StateStore(path, 3).isHandled('a')).toBe(false);
});

test('never drops a queued or running job', () => {
  const store = new StateStore(null, 2);
  store.queue(job('old'));
  Bun.sleepSync(2);
  for (const key of ['x', 'y']) {
    store.queue(job(key));
    store.begin(key);
    store.finish(key, { status: 'done' });
    Bun.sleepSync(2);
  }
  expect(store.isActive('old')).toBe(true);
  expect(store.list().map((r) => r.key)).toEqual(['y', 'old']);
});

test('a queued or running job left by a daemon that died becomes failed, so it can retry', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-state-')), 'state.json');
  const store = new StateStore(path);
  store.queue(job('waiting'));
  store.queue(job('busy'));
  store.begin('busy');
  store.queue(job('stale'));
  store.finish('stale', { status: 'superseded', supersededBy: 'newer' });
  const reloaded = new StateStore(path);
  expect(
    reloaded
      .list()
      .map((r) => [r.key, r.status])
      .toSorted(),
  ).toEqual([
    ['busy', 'failed'],
    ['stale', 'superseded'],
    ['waiting', 'failed'],
  ]);
  expect(['waiting', 'busy', 'stale'].map((key) => reloaded.isHandled(key))).toEqual([false, false, false]);
});
