/**
 * Where the background daemon records itself and how other commands find it.
 *
 * `start` writes `daemon.json` in the data dir (pid, port, start time, forwarder pids) and keeps it
 * current as forwarders restart. `status`, `stop`, and `info` read it, confirm the pid is still a
 * review-relay process, and ping `/health` on the port.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** Removes the record; with `pid`, only while the record still names that pid (a newer daemon may own it now). */
export function clearDaemonInfo(dataDir: string, pid?: number): void {
  if (pid !== undefined) {
    const recorded = readInfoFile(dataDir)?.pid ?? readLegacyPid(dataDir);
    if (recorded !== null && recorded !== pid) return;
  }
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

export interface ProcessInfo {
  commandLine: string;
  /** Epoch ms the process started, when the platform reports it. */
  startedMs: number | null;
}

function powershell(script: string): string | null {
  const out = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return out.success ? out.stdout.toString().trim() : null;
}

/** Seconds the process has been running, from `ps`; null when unavailable. */
function elapsedSeconds(pid: number): number | null {
  const out = Bun.spawnSync(['ps', '-o', 'etimes=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const n = Number(out.stdout.toString().trim());
  return out.success && Number.isFinite(n) ? n : null;
}

/** Command line and start time of a process, or null when it cannot be read (gone, or no permission). */
export function probeProcess(pid: number): ProcessInfo | null {
  try {
    if (process.platform === 'win32') {
      // One CIM query for both; `ps` does not exist on a stock Windows install.
      const raw = powershell(
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { ConvertTo-Json @{ cmd = $p.CommandLine; start = [int64](Get-Date $p.CreationDate -UFormat %s) * 1000 } }`,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { cmd?: string | null; start?: number };
      return parsed.cmd ? { commandLine: parsed.cmd, startedMs: parsed.start ?? null } : null;
    }
    let commandLine: string | null;
    if (process.platform === 'linux') {
      commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } else {
      const out = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
      commandLine = out.success ? out.stdout.toString().trim() : null;
    }
    if (!commandLine) return null;
    const elapsed = elapsedSeconds(pid);
    return { commandLine, startedMs: elapsed === null ? null : Date.now() - elapsed * 1000 };
  } catch {
    return null;
  }
}

/** The process's command line, or null when it cannot be read. */
export const commandLine = (pid: number): string | null => probeProcess(pid)?.commandLine ?? null;

/** True for a `review-relay start` (or `bun src/cli.ts start`) command line. */
export const isRelayCommand = (cmd: string): boolean => /\bstart\b/.test(cmd) && /review-relay|cli\.ts/.test(cmd);

/** True when the pid is a `review-relay start` (or `bun src/cli.ts start`) process. */
export function isRelayProcess(pid: number): boolean {
  const cmd = commandLine(pid);
  return cmd !== null && isRelayCommand(cmd);
}

/**
 * Pids get reused. A process that started well after the record was written is a different daemon,
 * even when it is also `review-relay start`; the record's own daemon started just before it was written.
 */
export const RECORD_SKEW_MS = 10_000;
export function matchesRecord(proc: ProcessInfo, startedAt: string | null): boolean {
  if (!isRelayCommand(proc.commandLine)) return false;
  if (startedAt === null || proc.startedMs === null) return true;
  const recorded = Date.parse(startedAt);
  return Number.isNaN(recorded) || proc.startedMs <= recorded + RECORD_SKEW_MS;
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
  const proc = pid !== null && isAlive(pid) ? probeProcess(pid) : null;
  if (pid !== null && proc && matchesRecord(proc, info?.startedAt ?? null)) {
    state.running = true;
    const startedMs = proc.startedMs ?? (info?.startedAt ? Date.parse(info.startedAt) : null);
    state.uptimeMs = startedMs === null ? null : Date.now() - startedMs;
    if (state.startedAt === null && startedMs !== null) state.startedAt = new Date(startedMs).toISOString();
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
  // A daemon started meanwhile owns the record now; leave it alone.
  clearDaemonInfo(dataDir, pid);
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

/** Bytes `[from, to)` of a file, decoded as one UTF-8 string. */
export function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Last `n` lines of a file, reading from the end in chunks and decoding once so multibyte text stays intact. */
export function readLast(path: string, n: number, chunk = 64 * 1024): string[] {
  if (n <= 0) return [];
  const fd = openSync(path, 'r');
  try {
    let pos = statSync(path).size;
    const parts: Buffer[] = [];
    let newlines = 0;
    while (pos > 0 && newlines <= n) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      parts.unshift(buf);
      for (const byte of buf) if (byte === 10) newlines++;
    }
    const lines = Buffer.concat(parts).toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}
