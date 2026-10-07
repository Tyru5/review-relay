import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAlive } from './daemon.ts';
import { isLocal, type JobSource } from './types.ts';

/**
 * `queued`: waiting for a free review slot. `skipped`: a skip route matched, so nothing ran. `superseded`: the PR moved
 * to a newer commit first, so the review stopped or its comment was not posted.
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'superseded';

/** True for a job that hasn't finished: queued or running. */
export const activeJob = (job: { status: JobStatus }) => job.status === 'queued' || job.status === 'running';

export interface JobRecord {
  key: string;
  repo: string;
  pr: number;
  headSha: string;
  source: JobSource;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  reportDir?: string;
  /** The route that decided the review, when one matched. */
  route?: string;
  error?: string;
  /** The PR's newer head, for a superseded job. */
  supersededBy?: string;
  /** The process that queued the job, so other processes can tell a live job from one whose process died. */
  pid?: number;
  /** A local review's branch (or short SHA when detached), the ref its base was, and the checkout it ran in. */
  branch?: string;
  base?: string;
  localPath?: string;
}

/**
 * True for a queued or running record whose process is gone, so it will never finish. A record without a pid was
 * written by an older version; it counts as stopped when `noPid` says so.
 */
export function orphaned(record: JobRecord, noPid: boolean, alive: (pid: number) => boolean = isAlive): boolean {
  if (!activeJob(record)) return false;
  if (record.pid === undefined) return noPid;
  return record.pid === process.pid || !alive(record.pid);
}

/** How long a lock on state.json may be held before it counts as left by a process that died holding it. */
const LOCK_STALE_MS = 5_000;

/** Runs `fn` holding `<path>.lock`, so processes that share state.json read and write it one at a time. */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // Released between the open and the stat.
      }
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function readRecords(path: string): JobRecord[] {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(saved) ? saved : [];
  } catch {
    // Missing or unreadable state starts fresh.
    return [];
  }
}

/** What a job reviewed: `#12` for a PR, the branch name for a local review. */
export const jobTarget = (job: Pick<JobRecord, 'pr' | 'source' | 'branch'>) =>
  isLocal(job) ? (job.branch ?? 'local') : `#${job.pr}`;

/** Jobs kept in state.json. Older ones are dropped, so a commit that old can be reviewed again if an event names it. */
export const MAX_RECORDS = 1000;

/**
 * Job history persisted as one JSON file; `null` path keeps it in memory (tests, dry runs). The daemon, `run`, and
 * local reviews each hold a store on the same file, so a save writes only the records this store changed, merged
 * into what is on disk under a lock.
 */
export class StateStore {
  private records = new Map<string, JobRecord>();
  /** Keys this store changed since its last save. */
  private readonly dirty = new Set<string>();

  constructor(
    private readonly path: string | null,
    private readonly max = MAX_RECORDS,
  ) {
    if (!path) return;
    for (const r of readRecords(path)) {
      // A record left `queued` or `running` by a process that died never finishes; allow a retry.
      if (orphaned(r, true)) {
        r.status = 'failed';
        this.dirty.add(r.key);
      }
      this.records.set(r.key, r);
    }
  }

  /**
   * True when this commit was reviewed, skipped by a route, or is queued or being reviewed. Failed and superseded
   * runs may retry, since neither left a comment for the commit.
   */
  isHandled(key: string): boolean {
    const record = this.records.get(key);
    return !!record && (record.status === 'done' || record.status === 'skipped' || activeJob(record));
  }

  /** True while the commit is queued or being reviewed. */
  isActive(key: string): boolean {
    const record = this.records.get(key);
    return !!record && activeJob(record);
  }

  /** Records a review waiting for a slot. A re-review replaces the commit's earlier record. */
  queue(record: Omit<JobRecord, 'status' | 'startedAt' | 'pid'>): void {
    this.records.set(record.key, {
      ...record,
      status: 'queued',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    this.save(record.key);
  }

  /** Marks a queued review as running from now. */
  begin(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, { status: 'running', startedAt: new Date().toISOString() });
    this.save(key);
  }

  finish(key: string, patch: Pick<JobRecord, 'status'> & Partial<JobRecord>): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, patch, { finishedAt: new Date().toISOString() });
    this.save(key);
  }

  list(): JobRecord[] {
    return [...this.records.values()].toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Drops the oldest finished jobs past `max`; queued and running jobs always stay. */
  private prune(): void {
    let excess = this.records.size - this.max;
    if (excess <= 0) return;
    for (const r of this.list().toReversed()) {
      if (excess === 0) break;
      if (activeJob(r)) continue;
      this.records.delete(r.key);
      excess--;
    }
  }

  /** Writes this store's changed records over the ones on disk, keeping every other process's records. */
  private save(key: string): void {
    this.dirty.add(key);
    const path = this.path;
    if (!path) return this.prune();
    mkdirSync(dirname(path), { recursive: true });
    withLock(path, () => {
      const merged = new Map(readRecords(path).map((r) => [r.key, r]));
      for (const changed of this.dirty) {
        const record = this.records.get(changed);
        if (record) merged.set(changed, record);
      }
      this.records = merged;
      this.dirty.clear();
      this.prune();
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
      renameSync(tmp, path);
    });
  }
}
