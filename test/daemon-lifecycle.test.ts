import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDaemonLock,
  readDaemonInfo,
  reapForwarders,
  writeDaemonInfo,
  inspectDaemon,
  stopDaemon,
} from '../src/daemon.ts';
import { processMembers, secretHash } from '../src/daemon-lifecycle.ts';

test('lifetime ownership is exclusive across simultaneous processes and recovers on owner death', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-lock-'));
  const module = new URL('../src/daemon.ts', import.meta.url).pathname;
  const script = `import {acquireDaemonLock} from ${JSON.stringify(module)};
    try { await acquireDaemonLock(${JSON.stringify(dir)}); console.log('owned'); setInterval(()=>{},1000); }
    catch { console.log('locked'); }`;
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    const results = await Promise.all(
      children.map(async (p) => {
        const reader = p.stdout.getReader();
        const result = await reader.read();
        reader.releaseLock();
        return new TextDecoder().decode(result.value).trim();
      }),
    );
    expect(results.toSorted()).toEqual(['locked', 'owned']);
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map((p) => p.exited));
    const release = await acquireDaemonLock(dir);
    await expect(acquireDaemonLock(dir)).rejects.toThrow('locked');
    await release();
    await release();
  } finally {
    for (const child of children) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'linux')(
  'reaps an orphan group after its leader exits, refuses wrong identity and live owners',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-reap-'));
    const testSecret = crypto.randomUUID();
    const child = Bun.spawn(
      [
        'bash',
        '-c',
        `trap '' HUP; (trap - INT; exec "${process.execPath}" -e 'process.on("SIGINT",()=>{}); setInterval(()=>{},1000)' webhook forward --repo=o/r --events=check_run --url=http://127.0.0.1:9988/hook --secret=${testSecret}) >/dev/null 2>&1 & sleep 0.1`,
      ],
      { detached: true, stdout: 'ignore', stderr: 'ignore' },
    );
    const group = child.pid;
    const info = {
      pid: 4194304000,
      port: 9988,
      startedAt: new Date().toISOString(),
      version: '',
      configPath: '',
      sessionId: 'test-session',
      secretHash: secretHash(testSecret),
      forwarders: [{ pid: group, repo: 'o/reused', events: 'check_run', since: '', restarts: 0 }],
    };
    try {
      await child.exited;
      const deadline = Date.now() + 3000;
      while (!processMembers()?.some((p) => p.group === group && p.args?.includes(`--secret=${testSecret}`))) {
        if (Date.now() > deadline) throw new Error('orphan did not exec');
        await Bun.sleep(20);
      }
      writeDaemonInfo(dir, info);
      expect(readDaemonInfo(dir)?.sessionId).toBe('test-session');
      expect((await reapForwarders(dir, info.pid)).unverified).toEqual([group]);
      info.forwarders[0]!.repo = 'o/r';
      info.secretHash = secretHash('wrong');
      writeDaemonInfo(dir, info);
      expect((await reapForwarders(dir, info.pid)).unverified).toEqual([group]);
      const refused = await stopDaemon(await inspectDaemon(dir, 1), dir, 0);
      expect(refused.unverified).toEqual([group]);
      expect(readDaemonInfo(dir)?.pid).toBe(info.pid);
      info.secretHash = secretHash(testSecret);
      info.pid = process.pid;
      writeDaemonInfo(dir, info);
      expect((await reapForwarders(dir, info.pid)).unverified).toEqual([group]);
      info.pid = 4194304000;
      writeDaemonInfo(dir, info);
      expect((await reapForwarders(dir, info.pid - 1)).stopped).toEqual([]);
      expect(await reapForwarders(dir, info.pid)).toEqual({ stopped: [group], survivors: [], unverified: [] });
      expect(readDaemonInfo(dir)?.pid).toBe(info.pid);
      const stopped = await stopDaemon(await inspectDaemon(dir, 1), dir, 0);
      expect(stopped.daemonStopped).toBe(true);
      expect(readDaemonInfo(dir)).toBeNull();
    } finally {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10000,
);

test('forced daemon stop waits for exit and reports cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-stop-'));
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)',
      'cli.ts',
      'start',
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  try {
    const reader = child.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    writeDaemonInfo(dir, {
      pid: child.pid,
      port: 1,
      startedAt: new Date().toISOString(),
      version: '',
      configPath: '',
      forwarders: [],
    });
    const state = await inspectDaemon(dir, 1);
    expect(state.running).toBe(true);
    const result = await stopDaemon(state, dir, 50);
    expect(result).toEqual({
      pid: child.pid,
      clean: false,
      daemonStopped: true,
      stopped: [],
      survivors: [],
      unverified: [],
    });
    expect(readDaemonInfo(dir)).toBeNull();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
