import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RepoConfig } from './config.ts';
import type { ForwarderInfo } from './daemon.ts';
import type { TriggerMode } from './types.ts';

/**
 * Event types each trigger mode needs. Greptile starts with a `check_run`; CodeRabbit sets a commit `status` (or, with
 * its newer progress reports, a `check_run`). `issue_comment` carries the mention trigger in every mode.
 */
export const EVENTS_BY_MODE: Record<TriggerMode, string[]> = {
  greptile: ['check_run', 'issue_comment'],
  coderabbit: ['status', 'check_run', 'issue_comment'],
  github: ['pull_request', 'issue_comment'],
  auto: ['check_run', 'status', 'pull_request', 'issue_comment'],
};

/** What `gh` prints when another forwarder holds the repo's hook: GitHub allows one `cli` hook per repo. */
export const HOOK_HELD = 'Hook already exists';
/** What `gh webhook forward` prints once its hook is active and its websocket is up. */
const FORWARDING = 'Forwarding Webhook events from GitHub';
/** How often a standby forwarder tries for the hook. GitHub drops a hook within a second of its socket closing. */
export const STANDBY_RETRY_MS = 30_000;
/**
 * The wait before a second try when a run first finds the hook held. After a quick restart the held hook is often
 * this forwarder's own, which GitHub drops about a second after the old socket closed.
 */
export const HELD_RETRY_MS = 2_000;
/**
 * A run's output is logged once the run has been up this long without reporting the hook held, so a slow start
 * doesn't hide it. Standby ends only when `gh` reports forwarding: the hook may still be in the making.
 */
export const SETTLE_MS = 10_000;

export interface ForwarderOptions {
  /** The `gh` executable; tests point it at a fake. */
  bin?: string;
  /** First wait before restarting a forwarder that exited; doubles up to a minute. */
  backoffMs?: number;
  heldRetryMs?: number;
  standbyRetryMs?: number;
  settleMs?: number;
}

/**
 * Keeps `gh webhook forward` running for one repo. It creates a temporary repo hook named `cli`, which GitHub deletes
 * within a second of the forwarder's websocket closing, however the process ends. `gh` runs the extension as a child
 * that does not receive signals sent to `gh`, so the forwarder gets its own process group and `stop()` signals the
 * whole group: signalling `gh` alone leaves the child, and the hook, alive.
 *
 * GitHub allows one `cli` hook per repo. A run that finds the hook held tries once more after `heldRetryMs`, in case
 * the hook is this forwarder's own from a run that just ended. When that try finds it held too, another instance has
 * the repo, and the forwarder stands by: it logs that once, tries again every `standbyRetryMs`, and logs again when
 * it gets the hook.
 */
export class Forwarder {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private standby = false;
  /** Runs in a row that found the hook held. */
  private heldRuns = 0;
  private backoffMs: number;
  private restarts = -1;
  private since = new Date().toISOString();
  private readonly bin: string;
  private readonly heldRetryMs: number;
  private readonly standbyRetryMs: number;
  private readonly settleMs: number;

  constructor(
    private readonly repo: RepoConfig,
    private readonly url: string,
    private readonly secret: string,
    private readonly log: (message: string) => void = console.log,
    /** Called after each spawn and exit, and when standby begins or ends, so the daemon can record it for `status`. */
    private readonly onChange: () => void = () => {},
    options: ForwarderOptions = {},
  ) {
    this.bin = options.bin ?? 'gh';
    this.backoffMs = options.backoffMs ?? 1_000;
    this.heldRetryMs = options.heldRetryMs ?? HELD_RETRY_MS;
    this.standbyRetryMs = options.standbyRetryMs ?? STANDBY_RETRY_MS;
    this.settleMs = options.settleMs ?? SETTLE_MS;
  }

  /** What `status` shows for this forwarder. */
  info(): ForwarderInfo {
    return {
      repo: this.repo.fullName,
      pid: this.proc?.pid ?? null,
      events: EVENTS_BY_MODE[this.repo.trigger].join(','),
      since: this.since,
      restarts: Math.max(0, this.restarts),
      standby: this.standby,
    };
  }

  start(): void {
    if (this.stopped) return;
    const events = EVENTS_BY_MODE[this.repo.trigger].join(',');
    const tag = `[${this.repo.fullName}]`;
    const startedAt = Date.now();
    // A try after a held run is not a restart: `status` would otherwise count one every half minute of standby.
    const retry = this.heldRuns > 0;
    if (!retry) this.restarts++;
    this.since = new Date(startedAt).toISOString();
    const proc = spawn(
      this.bin,
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
    if (!retry) this.log(`${tag} forwarding ${events} (trigger=${this.repo.trigger})`);
    this.onChange();
    // A run that finds the hook held says so only in its second line, and everything it prints is noise, so its
    // lines wait here until the run is known to have the hook, or to have ended for some other reason.
    let pending: string[] | null = [];
    let held = false;
    const flush = () => {
      if (!pending) return;
      for (const text of pending) this.log(`${tag} gh: ${text}`);
      pending = null;
    };
    const hasHook = () => {
      if (this.standby) {
        this.standby = false;
        this.log(`${tag} forwarding ${events} (trigger=${this.repo.trigger}), the other forwarder is gone`);
        this.onChange();
      }
      this.heldRuns = 0;
      flush();
    };
    const settle = setTimeout(() => {
      if (!held) flush();
    }, this.settleMs);
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on('line', (line) => {
        const text = line.trim();
        if (!text || held) return;
        if (text.includes(HOOK_HELD)) {
          held = true;
          pending = null;
          return;
        }
        if (text.startsWith(FORWARDING)) hasHook();
        if (pending) pending.push(text);
        else this.log(`${tag} gh: ${text}`);
      });
    }
    // `close` rather than `exit`: it waits for the output streams, so a run that printed the held line and exited at
    // once still counts as held.
    proc.on('close', (code) => {
      clearTimeout(settle);
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return this.onChange();
      if (held) {
        this.heldRuns++;
        if (this.heldRuns === 1) {
          // Likely this forwarder's own hook from a run that just ended; GitHub drops it in about a second.
          this.onChange();
          setTimeout(() => this.start(), this.heldRetryMs);
          return;
        }
        if (!this.standby) {
          this.standby = true;
          this.log(
            `${tag} another forwarder holds this repo; standing by, trying again every ${this.standbyRetryMs / 1000}s`,
          );
        }
        this.onChange();
        setTimeout(() => this.start(), this.standbyRetryMs);
        return;
      }
      // Ended for some other reason, so whatever is wrong is this forwarder's own: back to the ordinary path, where
      // `status` counts it as down and restarts are counted.
      this.standby = false;
      this.heldRuns = 0;
      flush();
      this.onChange();
      if (Date.now() - startedAt > 60_000) this.backoffMs = 1_000;
      this.log(`${tag} forwarder exited (${code}); restarting in ${this.backoffMs / 1000}s`);
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
    // The hook goes away when the socket closes, which exiting does; give the group a moment, then force it down.
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
