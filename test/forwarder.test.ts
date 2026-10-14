import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoConfig } from '../src/config.ts';
import { isAlive } from '../src/daemon.ts';
import { Forwarder } from '../src/forwarder.ts';

const repo: RepoConfig = {
  fullName: 'o/r',
  localPath: '/tmp/r',
  trigger: 'github',
  postToPr: true,
  github: { onPush: false, mention: '@review-relay' },
  authors: [],
};

const dirs: string[] = [];
const forwarders: Forwarder[] = [];
afterEach(async () => {
  for (const f of forwarders.splice(0)) await f.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `gh` that plays one line of `modes` per run, repeating the last: `held` fails as a second forwarder on a repo does,
 * `up` prints what a working forwarder prints and then waits to be killed, `crash` exits as a dropped socket does, and
 * `slow` prints a warning and waits without ever reporting forwarding.
 */
function fakeGh(modes: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rr-gh-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'modes'), modes.join('\n') + '\n');
  const bin = join(dir, 'gh');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/count"
mode=$(sed -n "$((n + 1))p" "${dir}/modes"); [ -z "$mode" ] && mode=$(tail -n 1 "${dir}/modes")
case "$mode" in
  held)
    echo "Error: error creating webhook: HTTP 422: Validation Failed (https://api.github.com/repos/o/r/hooks)" >&2
    echo "Hook already exists on this repository" >&2
    echo "Usage:" >&2
    echo "  forward --events=<types> [--url=<url>] [flags]" >&2
    exit 1;;
  up) echo "Forwarding Webhook events from GitHub..."; sleep 30;;
  slow) echo "warning: slow start" >&2; sleep 30;;
  crash) echo "Error: error receiving json event: websocket: close 1006 (abnormal closure): unexpected EOF" >&2; exit 1;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(20);
  }
};

function start(modes: string[], options: { backoffMs?: number; standbyRetryMs?: number; settleMs?: number } = {}) {
  const logs: string[] = [];
  const changes: boolean[] = [];
  const f = new Forwarder(
    repo,
    'http://127.0.0.1:1/hook',
    's',
    (m) => logs.push(m),
    () => changes.push(f.info().standby ?? false),
    { bin: fakeGh(modes), backoffMs: 20, heldRetryMs: 20, standbyRetryMs: 30, ...options },
  );
  forwarders.push(f);
  f.start();
  return { f, logs, changes };
}

describe('Forwarder', () => {
  test('a hook held once is tried again at once, without standing by', async () => {
    // After a quick restart the held hook is this forwarder's own, which GitHub drops a second later.
    const { f, logs } = start(['held', 'up']);
    await until(() => logs.some((l) => l.includes('gh: Forwarding')));
    expect(logs).toEqual([
      '[o/r] forwarding pull_request,issue_comment (trigger=github)',
      '[o/r] gh: Forwarding Webhook events from GitHub...',
    ]);
    expect(f.info()).toMatchObject({ standby: false, restarts: 0 });
  });

  test('stands by while another forwarder holds the repo, then takes over', async () => {
    const { f, logs, changes } = start(['held', 'held', 'held', 'up']);
    await until(() => logs.some((l) => l.includes('the other forwarder is gone')));
    expect(logs.filter((l) => l.includes('standing by'))).toEqual([
      '[o/r] another forwarder holds this repo; standing by, trying again every 0.03s',
    ]);
    expect(logs.at(-1)).toBe('[o/r] gh: Forwarding Webhook events from GitHub...');
    // gh's error lines, its usage text, and the exits while standing by are noise.
    expect(logs.some((l) => l.includes('HTTP 422') || l.includes('Usage') || l.includes('exited'))).toBe(false);
    expect(logs.filter((l) => l.startsWith('[o/r] forwarding'))).toEqual([
      '[o/r] forwarding pull_request,issue_comment (trigger=github)',
      '[o/r] forwarding pull_request,issue_comment (trigger=github), the other forwarder is gone',
    ]);
    expect(f.info()).toMatchObject({ standby: false, restarts: 0 });
    expect(changes).toContain(true);
  });

  test('an exit for any other reason restarts with backoff and counts', async () => {
    const { f, logs } = start(['crash', 'up']);
    await until(() => logs.some((l) => l.includes('gh: Forwarding')));
    expect(logs).toContain(
      '[o/r] gh: Error: error receiving json event: websocket: close 1006 (abnormal closure): unexpected EOF',
    );
    expect(logs).toContain('[o/r] forwarder exited (1); restarting in 0.02s');
    expect(f.info()).toMatchObject({ standby: false, restarts: 1 });
  });

  test('a slow run has its output logged after a while, but standby ends only on forwarding', async () => {
    const { f, logs } = start(['slow'], { settleMs: 100 });
    await until(() => logs.includes('[o/r] gh: warning: slow start'));
    expect(f.info()).toMatchObject({ standby: false, restarts: 0 });

    // Standing by, a run that is slow to answer may still come back held, so the wait proves nothing.
    const held = start(['held', 'held', 'slow'], { settleMs: 100 });
    await until(() => held.logs.includes('[o/r] gh: warning: slow start'));
    expect(held.f.info()).toMatchObject({ standby: true, restarts: 0 });
    expect(held.logs.some((l) => l.includes('the other forwarder is gone'))).toBe(false);
  });

  test('a standby retry that fails for another reason ends the standby', async () => {
    const { f, logs, changes } = start(['held', 'held', 'crash', 'up']);
    await until(() => logs.some((l) => l.includes('gh: Forwarding')));
    expect(logs.filter((l) => l.includes('standing by'))).toHaveLength(1);
    expect(logs).toContain(
      '[o/r] gh: Error: error receiving json event: websocket: close 1006 (abnormal closure): unexpected EOF',
    );
    expect(logs).toContain('[o/r] forwarder exited (1); restarting in 0.02s');
    expect(logs.some((l) => l.includes('the other forwarder is gone'))).toBe(false);
    expect(f.info()).toMatchObject({ standby: false, restarts: 1 });
    // Standby began on the held run and ended on the crash, before the restart.
    expect(changes.indexOf(true)).toBeLessThan(changes.lastIndexOf(false));
  });

  test('stop ends the process group', async () => {
    const { f, logs } = start(['up']);
    await until(() => logs.some((l) => l.includes('gh: Forwarding')));
    const pid = f.info().pid!;
    expect(isAlive(pid)).toBe(true);
    await f.stop();
    await until(() => !isAlive(pid));
    expect(f.info().pid).toBeNull();
  });
});
