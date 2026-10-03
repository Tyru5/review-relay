import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDaemonInfo,
  daemonInfoPath,
  inspectDaemon,
  isAlive,
  isRelayProcess,
  pidFilePath,
  selfCommand,
  writeDaemonInfo,
} from '../src/daemon.ts';

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

describe('process checks', () => {
  test('isAlive is true for this process and false for an impossible pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(4194304000)).toBe(false);
  });

  test('isRelayProcess needs both a relay entrypoint and the start command', () => {
    // The test runner is neither.
    expect(isRelayProcess(process.pid)).toBe(false);
  });

  test('selfCommand re-runs the script under bun, or the compiled binary directly', () => {
    const cmd = selfCommand(['start']);
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd.at(-1)).toBe('start');
    // Under `bun test` argv[1] is a real file, so it is passed through.
    expect(cmd).toHaveLength(3);
  });
});
