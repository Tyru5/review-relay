import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.ts';

const job = (key: string) => ({ key, repo: 'o/r', pr: 1, headSha: key, source: 'github' as const });

/** Every temp folder a test made, removed after it whether it passed or not. */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A state.json path in a fresh temp folder. */
const statePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-state-'));
  made.push(dir);
  return join(dir, 'state.json');
};

test('keeps only the newest jobs on disk', () => {
  const path = statePath();
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

/** A pid no process has now: one that just exited. */
const gonePid = () => Bun.spawnSync(['true']).pid;
const now = () => new Date().toISOString();

test('a queued or running job left by a daemon that died becomes failed, so it can retry', () => {
  const path = statePath();
  const pid = gonePid();
  writeFileSync(
    path,
    JSON.stringify([
      { ...job('waiting'), status: 'queued', startedAt: now(), pid },
      { ...job('busy'), status: 'running', startedAt: now(), pid },
      { ...job('stale'), status: 'superseded', startedAt: now(), pid, supersededBy: 'newer' },
    ]),
  );
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
  const path = statePath();
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
  const gone = gonePid();
  writeFileSync(
    path,
    JSON.stringify([
      { ...job('live'), status: 'running', startedAt: now(), pid: process.ppid },
      { ...job('dead'), status: 'running', startedAt: now(), pid: gone },
    ]),
  );
  const loaded = new StateStore(path);
  expect([loaded.isActive('live'), loaded.isActive('dead')]).toEqual([true, false]);
});

test('claim refuses a key a live process holds and takes one that finished or whose process died', () => {
  const path = statePath();
  const gone = gonePid();
  const held = (key: string, pid: number, status = 'running') => ({
    ...job(key),
    status,
    startedAt: now(),
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

test('a job this process queued stays live, one with its pid it never queued is a reused pid’s, and so is one from before boot', () => {
  const path = statePath();
  const store = new StateStore(path);
  store.queue(job('ours'));
  const booted = new Date(Date.now() - uptime() * 1000 - 60_000).toISOString();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    JSON.stringify([
      ...saved,
      { ...job('reused'), status: 'running', startedAt: now(), pid: process.pid },
      { ...job('rebooted'), status: 'running', startedAt: booted, pid: process.ppid },
    ]),
  );
  const reloaded = new StateStore(path);
  expect(['ours', 'reused', 'rebooted'].map((key) => reloaded.isActive(key))).toEqual([true, false, false]);
});

test('isActive and isHandled read the file, so another process finishing or dying counts before any write', () => {
  const path = statePath();
  const daemon = new StateStore(path);
  writeFileSync(path, JSON.stringify([{ ...job('run'), status: 'running', startedAt: now(), pid: process.ppid }]));
  expect(daemon.isActive('run')).toBe(true);
  writeFileSync(path, JSON.stringify([{ ...job('run'), status: 'done', startedAt: now(), pid: process.ppid }]));
  expect([daemon.isActive('run'), daemon.isHandled('run')]).toEqual([false, true]);
  writeFileSync(path, JSON.stringify([{ ...job('run'), status: 'running', startedAt: now(), pid: gonePid() }]));
  expect([daemon.isActive('run'), daemon.isHandled('run')]).toEqual([false, false]);
});

test('a lock whose owner is gone is taken over; a live owner’s lock is waited on', async () => {
  const path = statePath();
  writeFileSync(`${path}.lock`, `${gonePid()} dead-owner`);
  const store = new StateStore(path);
  store.queue(job('a'));
  expect(existsSync(`${path}.lock`)).toBe(false);
  expect(store.isActive('a')).toBe(true);

  // A live owner (the parent) holds it: another process's write waits until it is released.
  writeFileSync(`${path}.lock`, `${process.ppid} live-owner`);
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { StateStore } = await import(${JSON.stringify(join(import.meta.dir, '../src/state.ts'))});
       const store = new StateStore(${JSON.stringify(path)});
       console.log('ready');
       store.queue({ key: 'b', repo: 'o/r', pr: 1, headSha: 'b', source: 'github' });`,
    ],
    { stdout: 'pipe' },
  );
  try {
    // Started and about to write, so what follows watches its lock loop, not its startup.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    while (!out.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    expect(out).toBe('ready\n');
    reader.releaseLock();
    // Waiting can only be seen over time: across many of its 5ms retries it neither writes nor exits.
    for (let i = 0; i < 20; i++) {
      expect(child.exitCode).toBeNull();
      expect(store.isHandled('b')).toBe(false);
      await Bun.sleep(5);
    }
    rmSync(`${path}.lock`);
    expect(await child.exited).toBe(0);
    expect(
      new StateStore(path)
        .list()
        .map((r) => r.key)
        .toSorted(),
    ).toEqual(['a', 'b']);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
