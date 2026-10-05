import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDaemonInfo,
  daemonInfoPath,
  inspectDaemon,
  isAlive,
  isRelayCommand,
  isOutdated,
  isRelayProcess,
  matchesRecord,
  PID_HEADER,
  pidFilePath,
  portOwner,
  probeDaemon,
  RECORD_SKEW_MS,
  readLast,
  readRange,
  selfCommand,
  VERSION_HEADER,
  writeDaemonInfo,
} from '../src/daemon.ts';
import { healthResponse } from '../src/server.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'relay-daemon-'));
/** A port nothing listens on, so health probes fail fast. */
const DEAD_PORT = 1;

describe('daemon records', () => {
  test('writeDaemonInfo writes daemon.json and a plain pid file; clear removes both', () => {
    const d = dir();
    writeDaemonInfo(d, {
      pid: 4242,
      port: 9988,
      startedAt: '2026-10-03T00:00:00.000Z',
      version: '0.2.0',
      configPath: '/c.json',
      forwarders: [{ repo: 'o/r', pid: 4243, events: 'check_run', since: '2026-10-03T00:00:01.000Z', restarts: 0 }],
    });
    expect(JSON.parse(readFileSync(daemonInfoPath(d), 'utf8')).pid).toBe(4242);
    expect(readFileSync(pidFilePath(d), 'utf8')).toBe('4242\n');
    clearDaemonInfo(d);
    expect(() => readFileSync(daemonInfoPath(d))).toThrow();
    expect(() => readFileSync(pidFilePath(d))).toThrow();
  });

  test('clearDaemonInfo with a pid leaves a record that a newer daemon owns', () => {
    const d = dir();
    const info = {
      pid: 500,
      port: 1,
      startedAt: '2026-10-03T00:00:00.000Z',
      version: '0.3.0',
      configPath: '/c.json',
      forwarders: [],
    };
    writeDaemonInfo(d, info);
    clearDaemonInfo(d, 499); // the daemon that just exited
    expect(JSON.parse(readFileSync(daemonInfoPath(d), 'utf8')).pid).toBe(500);
    clearDaemonInfo(d, 500);
    expect(() => readFileSync(daemonInfoPath(d))).toThrow();
  });

  test('inspectDaemon with no record reports stopped, not stale', async () => {
    const state = await inspectDaemon(dir(), DEAD_PORT);
    expect(state).toMatchObject({ running: false, pid: null, stale: false, foreign: false, port: DEAD_PORT });
  });

  test('inspectDaemon flags a record whose pid is gone as stale', async () => {
    const d = dir();
    // A pid far above the default pid_max is never a live process.
    writeFileSync(pidFilePath(d), '4194304000\n');
    const state = await inspectDaemon(d, DEAD_PORT);
    expect(state.running).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.pid).toBe(4194304000);
  });

  test('inspectDaemon does not mistake a live non-relay process for the daemon', async () => {
    const d = dir();
    writeDaemonInfo(d, {
      pid: process.pid, // bun test, alive but not `review-relay start`
      port: DEAD_PORT,
      startedAt: new Date().toISOString(),
      version: '0.2.0',
      configPath: '/c.json',
      forwarders: [],
    });
    const state = await inspectDaemon(d, DEAD_PORT);
    expect(state.running).toBe(false);
    expect(state.stale).toBe(true);
  });
});

/** A `/health` listener on a free port: a current daemon (headers) or one from before 0.5.1 (plain `ok`). */
function listen(legacy = false) {
  return Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (legacy ? new Response('ok') : healthResponse()) });
}

describe('identifying the daemon on the port', () => {
  test('/health keeps the plain ok body and names its pid and version', async () => {
    const res = healthResponse();
    expect(await res.text()).toBe('ok');
    expect(res.headers.get(PID_HEADER)).toBe(String(process.pid));
    expect(res.headers.get(VERSION_HEADER)).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('probeDaemon reads the pid header, and null from an older daemon', async () => {
    const current = listen();
    const legacy = listen(true);
    try {
      expect(await probeDaemon(current.port!)).toMatchObject({ health: 'ok', pid: process.pid });
      expect(await probeDaemon(legacy.port!)).toEqual({ health: 'ok', pid: null, version: null });
    } finally {
      current.stop(true);
      legacy.stop(true);
    }
  });

  test('a record rejected on start time is kept when /health reports the same pid', async () => {
    const server = listen();
    try {
      const d = dir();
      writeDaemonInfo(d, {
        pid: process.pid, // not `review-relay start`, so only the health header can vouch for it
        port: server.port!,
        startedAt: '2000-01-01T00:00:00.000Z',
        version: '0.1.0',
        configPath: '/c.json',
        forwarders: [
          { repo: 'o/r', pid: process.pid, events: 'pull_request', since: '2000-01-01T00:00:00.000Z', restarts: 0 },
        ],
      });
      const state = await inspectDaemon(d, server.port!);
      expect(state).toMatchObject({ running: true, stale: false, foreign: false, pid: process.pid, health: 'ok' });
      expect(state.startedAt).toBe('2000-01-01T00:00:00.000Z');
      expect(state.forwarders).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test('with no record, the daemon answering /health is found by its reported pid', async () => {
    const server = listen();
    try {
      const state = await inspectDaemon(dir(), server.port!);
      expect(state).toMatchObject({ running: true, stale: false, foreign: false, pid: process.pid });
      expect(state.version).toBe(healthResponse().headers.get(VERSION_HEADER));
      expect(state.forwarders).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test('an older listener whose port owner is not review-relay stays foreign', async () => {
    const server = listen(true);
    try {
      // lsof or ss may be missing; when present they name this process.
      expect([process.pid, null]).toContain(portOwner(server.port!));
      const state = await inspectDaemon(dir(), server.port!);
      expect(state).toMatchObject({ running: false, foreign: true, health: 'ok' });
    } finally {
      server.stop(true);
    }
  });

  test('isOutdated flags a running daemon on another or unknown version', async () => {
    const state = await inspectDaemon(dir(), DEAD_PORT);
    expect(isOutdated(state, '0.5.0')).toBe(false); // stopped
    expect(isOutdated({ ...state, running: true, version: '0.5.0' }, '0.5.0')).toBe(false);
    expect(isOutdated({ ...state, running: true, version: '0.4.1' }, '0.5.0')).toBe(true);
    expect(isOutdated({ ...state, running: true, version: null }, '0.5.0')).toBe(true);
  });
});

describe('process checks', () => {
  test('isAlive is true for this process and false for an impossible pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(4194304000)).toBe(false);
  });

  test('isRelayProcess needs both a relay entrypoint and the start command', () => {
    // The test runner is neither.
    expect(isRelayProcess(process.pid)).toBe(false);
  });

  test('isRelayCommand matches the binary and the dev entrypoint, not other bun scripts', () => {
    expect(isRelayCommand('/home/u/.local/bin/review-relay start --config /c.json')).toBe(true);
    expect(isRelayCommand('bun src/cli.ts start')).toBe(true);
    expect(isRelayCommand('bun src/cli.ts status')).toBe(false);
    expect(isRelayCommand('bun test')).toBe(false);
  });

  test('matchesRecord rejects a reused pid whose process started after the record', () => {
    const startedAt = '2026-10-03T12:00:00.000Z';
    const t = Date.parse(startedAt);
    const cmd = 'review-relay start';
    expect(matchesRecord({ commandLine: cmd, startedMs: t - 2_000 }, startedAt)).toBe(true);
    expect(matchesRecord({ commandLine: cmd, startedMs: t + RECORD_SKEW_MS - 1 }, startedAt)).toBe(true);
    expect(matchesRecord({ commandLine: cmd, startedMs: t + RECORD_SKEW_MS + 60_000 }, startedAt)).toBe(false);
    // Legacy pid file (no start time) and platforms without one fall back to the command line alone.
    expect(matchesRecord({ commandLine: cmd, startedMs: null }, startedAt)).toBe(true);
    expect(matchesRecord({ commandLine: cmd, startedMs: t + 999_999 }, null)).toBe(true);
    expect(matchesRecord({ commandLine: 'bun test', startedMs: t }, startedAt)).toBe(false);
  });

  test('selfCommand re-runs the script under bun, or the compiled binary directly', () => {
    const cmd = selfCommand(['start']);
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd.at(-1)).toBe('start');
    // Under `bun test` argv[1] is a real file, so it is passed through.
    expect(cmd).toHaveLength(3);
  });
});

describe('log reading', () => {
  test('readLast returns the last n lines, nothing for 0, and keeps multibyte text across chunk boundaries', () => {
    const d = dir();
    const path = join(d, 'daemon.log');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ✓ héllo ● ${'x'.repeat(i % 7)}`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(readLast(path, 0)).toEqual([]);
    expect(readLast(path, 3)).toEqual(lines.slice(-3));
    // A 5-byte chunk splits every multibyte character somewhere.
    expect(readLast(path, 50, 5)).toEqual(lines);
    expect(readLast(path, 1000, 7)).toEqual(lines);
  });

  test('readLast handles a file with no trailing newline and readRange decodes a byte span', () => {
    const d = dir();
    const path = join(d, 'daemon.log');
    writeFileSync(path, 'a\nb\nc');
    expect(readLast(path, 2)).toEqual(['b', 'c']);
    expect(readRange(path, 2, 5)).toBe('b\nc');
  });
});
