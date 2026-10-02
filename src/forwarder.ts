import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RepoConfig } from './config.ts';
import type { TriggerMode } from './types.ts';

/** Event types each trigger mode needs; `issue_comment` carries the mention trigger in every mode. */
export const EVENTS_BY_MODE: Record<TriggerMode, string[]> = {
  greptile: ['check_run', 'issue_comment'],
  github: ['pull_request', 'issue_comment'],
  auto: ['check_run', 'pull_request', 'issue_comment'],
};

/**
 * Keeps `gh webhook forward` running for one repo. It creates a temporary repo webhook and deletes
 * it on SIGINT. `gh` runs the extension as a child that does not receive signals sent to `gh`, so
 * the forwarder gets its own process group and `stop()` signals the whole group.
 */
export class Forwarder {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1_000;

  constructor(
    private readonly repo: RepoConfig,
    private readonly url: string,
    private readonly secret: string,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    if (this.stopped) return;
    const events = EVENTS_BY_MODE[this.repo.trigger].join(',');
    const startedAt = Date.now();
    const proc = spawn(
      'gh',
      [
        'webhook',
        'forward',
        `--repo=${this.repo.fullName}`,
        `--events=${events}`,
        `--url=${this.url}`,
        `--secret=${this.secret}`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    this.log(`[${this.repo.fullName}] forwarding ${events} (trigger=${this.repo.trigger})`);
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim()) this.log(`[${this.repo.fullName}] gh: ${line.trim()}`);
      });
    }
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > 60_000) this.backoffMs = 1_000;
      this.log(`[${this.repo.fullName}] forwarder exited (${code}); restarting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
  }

  /** Last-resort synchronous signal for `process.on('exit')`, where async cleanup cannot run. */
  stopSync(): void {
    this.stopped = true;
    if (this.proc?.pid) signal(-this.proc.pid, 'SIGINT');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (!proc?.pid) return;
    const group = -proc.pid;
    signal(group, 'SIGINT');
    // The extension deletes its webhook before exiting; give it time, then force the group down.
    for (let waited = 0; waited < 5_000 && signal(group, 0); waited += 100) await Bun.sleep(100);
    signal(group, 'SIGKILL');
  }
}

/** Sends `sig` to a pid or process group; false once nothing is left to signal. */
function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}
