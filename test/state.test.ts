import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('stores on one file keep each other’s records, and a job whose process is alive stays running', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-state-')), 'state.json');
  const daemon = new StateStore(path);
  const local = new StateStore(path);
  daemon.queue(job('pr'));
  daemon.begin('pr');
  local.queue(job('branch'));
  local.finish('branch', { status: 'done' });
  daemon.finish('pr', { status: 'done' });
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { key: string; status: string; pid: number }[];
  expect(saved.map((r) => [r.key, r.status]).toSorted()).toEqual([
    ['branch', 'done'],
    ['pr', 'done'],
  ]);
  expect(saved.every((r) => r.pid === process.pid)).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);

  // Another live process's job is left running; a dead process's job is failed.
  const gone = Bun.spawnSync(['true']).pid;
  writeFileSync(
    path,
    JSON.stringify([
      { ...job('live'), status: 'running', startedAt: '2026-10-02T10:00:00Z', pid: process.ppid },
      { ...job('dead'), status: 'running', startedAt: '2026-10-02T10:00:00Z', pid: gone },
    ]),
  );
  const loaded = new StateStore(path);
  expect([loaded.isActive('live'), loaded.isActive('dead')]).toEqual([true, false]);
});

test('claim refuses a key a live process holds and takes one that finished or whose process died', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-state-')), 'state.json');
  const gone = Bun.spawnSync(['true']).pid;
  const held = (key: string, pid: number, status = 'running') => ({
    ...job(key),
    status,
    startedAt: '2026-10-02T10:00:00Z',
    pid,
  });
  writeFileSync(
    path,
    JSON.stringify([held('live', process.ppid), held('dead', gone), held('done', process.ppid, 'done')]),
  );
  // Each store loaded before the other wrote, so only the file under the lock can tell them apart.
  const first = new StateStore(path);
  const second = new StateStore(path);
  expect(first.claim(job('live'))).toBe(false);
  expect(first.claim(job('dead'))).toBe(true);
  expect(first.claim(job('done'))).toBe(true);
  expect(second.claim(job('fresh'))).toBe(true);
  expect(first.claim(job('fresh'))).toBe(false);

  const saved = JSON.parse(readFileSync(path, 'utf8')) as { key: string; status: string; pid: number }[];
  const byKey = Object.fromEntries(saved.map((r) => [r.key, [r.status, r.pid]]));
  expect(byKey).toEqual({
    live: ['running', process.ppid],
    dead: ['queued', process.pid],
    done: ['queued', process.pid],
    fresh: ['queued', process.pid],
  });
});
