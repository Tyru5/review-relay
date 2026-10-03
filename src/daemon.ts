/**
 * Where the background daemon records itself and how other commands find it.
 *
 * `start` writes `daemon.json` in the data dir (pid, port, start time, forwarder pids) and keeps it
 * current as forwarders restart. `status`, `stop`, and `info` read it, confirm the pid is still a
 * review-relay process, and ping `/health` on the port.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ForwarderInfo {
  repo: string;
  pid: number | null;
  events: string;
  /** ISO time the current `gh webhook forward` process started. */
  since: string;
  /** How many times the forwarder has been respawned since the daemon started. */
  restarts: number;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  configPath: string;
  forwarders: ForwarderInfo[];
}

export const daemonInfoPath = (dataDir: string) => join(dataDir, 'daemon.json');
/** Plain pid written by older `scripts/relay start`; still honored when `daemon.json` is missing. */
export const pidFilePath = (dataDir: string) => join(dataDir, 'daemon.pid');
export const logFilePath = (dataDir: string) => join(dataDir, 'daemon.log');

export function writeDaemonInfo(dataDir: string, info: DaemonInfo): void {
  mkdirSync(dataDir, { recursive: true });
  const path = daemonInfoPath(dataDir);
  writeFileSync(`${path}.tmp`, JSON.stringify(info, null, 2));
  renameSync(`${path}.tmp`, path);
  writeFileSync(pidFilePath(dataDir), `${info.pid}\n`);
}

export function clearDaemonInfo(dataDir: string): void {
  for (const path of [daemonInfoPath(dataDir), pidFilePath(dataDir)]) rmSync(path, { force: true });
}

/** `kill -0`; EPERM still means the process exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process's command line, or null when it cannot be read. */
export function commandLine(pid: number): string | null {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const out = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    return out.success ? out.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** True when the pid is a `review-relay start` (or `bun src/cli.ts start`) process. */
export function isRelayProcess(pid: number): boolean {
  const cmd = commandLine(pid);
  if (!cmd) return false;
  return /\bstart\b/.test(cmd) && /review-relay|cli\.ts/.test(cmd);
}

/** Seconds the process has been running, from `ps`; null when unavailable (Windows, or the pid is gone). */
function elapsedSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  const out = Bun.spawnSync(['ps', '-o', 'etimes=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const n = Number(out.stdout.toString().trim());
  return out.success && Number.isFinite(n) ? n : null;
}

function readInfoFile(dataDir: string): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(daemonInfoPath(dataDir), 'utf8')) as Partial<DaemonInfo>;
    if (typeof raw.pid !== 'number') return null;
    return {
      pid: raw.pid,
      port: raw.port ?? 0,
      startedAt: raw.startedAt ?? new Date(statSync(daemonInfoPath(dataDir)).mtimeMs).toISOString(),
      version: raw.version ?? '',
      configPath: raw.configPath ?? '',
      forwarders: Array.isArray(raw.forwarders) ? raw.forwarders : [],
    };
  } catch {
    return null;
  }
}

function readLegacyPid(dataDir: string): number | null {
  try {
    const n = Number(readFileSync(pidFilePath(dataDir), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export type Health = 'ok' | 'unreachable' | 'unexpected';

export async function probeHealth(port: number, timeoutMs = 1_500): Promise<Health> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && (await res.text()) === 'ok' ? 'ok' : 'unexpected';
  } catch {
    return 'unreachable';
  }
}

export interface DaemonState {
  running: boolean;
  /** Set when a pid was found, even one that turned out to be dead (stale files). */
  pid: number | null;
  /** The file named a pid that is no longer a review-relay process. */
  stale: boolean;
  port: number;
  /** Milliseconds since the daemon started, when known. */
  uptimeMs: number | null;
  startedAt: string | null;
  version: string | null;
  health: Health | null;
  forwarders: (ForwarderInfo & { alive: boolean })[];
  /** Something answers `/health` on the port although no daemon record points at it. */
  foreign: boolean;
}

/** What `status` and `stop` work from: the record on disk, checked against live processes and the port. */
export async function inspectDaemon(dataDir: string, port: number): Promise<DaemonState> {
  const info = readInfoFile(dataDir);
  const pid = info?.pid ?? readLegacyPid(dataDir);
  const state: DaemonState = {
    running: false,
    pid,
    stale: false,
    port: info?.port || port,
    uptimeMs: null,
    startedAt: info?.startedAt ?? null,
    version: info?.version ?? null,
    health: null,
    forwarders: [],
    foreign: false,
  };
  if (pid !== null && isAlive(pid) && isRelayProcess(pid)) {
    state.running = true;
    const elapsed = elapsedSeconds(pid);
    state.uptimeMs =
      elapsed !== null ? elapsed * 1000 : info?.startedAt ? Date.now() - Date.parse(info.startedAt) : null;
    if (state.startedAt === null && elapsed !== null)
      state.startedAt = new Date(Date.now() - elapsed * 1000).toISOString();
    state.health = await probeHealth(state.port);
    state.forwarders = (info?.forwarders ?? []).map((f) => ({ ...f, alive: f.pid !== null && isAlive(f.pid) }));
    return state;
  }
  if (pid !== null) state.stale = true;
  const health = await probeHealth(port);
  if (health === 'ok') {
    state.foreign = true;
    state.health = health;
  }
  return state;
}

/** Command line that re-runs this CLI, whether it is the compiled binary or `bun src/cli.ts`. */
export function selfCommand(args: string[]): string[] {
  const script = process.argv[1];
  const compiled = !script || script.startsWith('/$bunfs') || script.startsWith('B:\\~BUN');
  return compiled ? [process.execPath, ...args] : [process.execPath, script, ...args];
}

/** Starts `review-relay start` in the background with its output appended to the log file. */
export function spawnDetached(dataDir: string, args: string[]): number {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(logFilePath(dataDir), 'a');
  const [cmd, ...rest] = selfCommand(args);
  const child = spawn(cmd!, rest, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  return child.pid ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `/health` answers or the spawned process exits; returns the error, if any. */
export async function waitForStart(
  dataDir: string,
  pid: number,
  port: number,
  timeoutMs = 10_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeHealth(port, 500)) === 'ok') return null;
    if (!isAlive(pid)) return 'exited during startup';
    await sleep(200);
  }
  return `no health response on :${port} after ${Math.round(timeoutMs / 1000)}s`;
}

export interface StopResult {
  pid: number;
  /** False when SIGTERM was not enough and the process was killed. */
  clean: boolean;
}

/** SIGTERM so the daemon deletes its temporary webhooks; SIGKILL the daemon and forwarder groups after `graceMs`. */
export async function stopDaemon(state: DaemonState, dataDir: string, graceMs = 20_000): Promise<StopResult> {
  const pid = state.pid!;
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) await sleep(200);
  const clean = !isAlive(pid);
  if (!clean) {
    signal(pid, 'SIGKILL');
    for (const f of state.forwarders) if (f.pid) signal(-f.pid, 'SIGINT');
  }
  clearDaemonInfo(dataDir);
  return { pid, clean };
}

function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    // Already gone.
  }
}

export const logExists = (dataDir: string) => existsSync(logFilePath(dataDir));
