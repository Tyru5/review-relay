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
    store.start(job(key));
    store.finish(key, { status: 'done' });
    Bun.sleepSync(2);
  }
  expect(store.list().map((r) => r.key)).toEqual(['e', 'd', 'c']);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { key: string }[];
  expect(saved.map((r) => r.key)).toEqual(['e', 'd', 'c']);
  expect(new StateStore(path, 3).isHandled('a')).toBe(false);
});

test('never drops a running job', () => {
  const store = new StateStore(null, 2);
  store.start(job('old'));
  Bun.sleepSync(2);
  for (const key of ['x', 'y']) {
    store.start(job(key));
    store.finish(key, { status: 'done' });
    Bun.sleepSync(2);
  }
  expect(store.isRunning('old')).toBe(true);
  expect(store.list().map((r) => r.key)).toEqual(['y', 'old']);
});
