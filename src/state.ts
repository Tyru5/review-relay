import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
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

/** Keys this process queued. Its own records are live only for these; any other with its pid is a reused pid's. */
const mine = new Set<string>();

/** Epoch ms the machine booted. A process that started a job before then can't still be running it. */
const bootedAt = () => Date.now() - uptime() * 1000;

/**
 * True for a queued or running record whose process is gone, so it will never finish. A record without a pid was
 * written by an older version; it counts as stopped when `noPid` says so. One this process didn't queue but that
 * carries its pid, or that started before the last boot, belongs to an earlier process whose pid was reused.
 */
export function orphaned(record: JobRecord, noPid: boolean, alive: (pid: number) => boolean = isAlive): boolean {
  if (!activeJob(record)) return false;
  if (record.pid === undefined) return noPid;
  if (record.pid === process.pid) return !mine.has(record.key);
  if (Date.parse(record.startedAt) < bootedAt()) return true;
  return !alive(record.pid);
}

/** A lock with no owner written into it yet is this old before it counts as abandoned. */
const LOCK_UNWRITTEN_MS = 1_000;
/** A write holds the lock for milliseconds, so a live owner this old has a reused pid or is suspended. */
const LOCK_ABANDONED_MS = 30_000;

/**
 * True when the lock's owner can't be writing: its process is gone, or it has held the lock far longer than a write
 * takes. An owner that was only suspended finds the lock gone when it resumes, and starts its write again.
 */
function staleLock(lock: string): boolean {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    const owner = Number(readFileSync(lock, 'utf8').split(' ')[0]);
    if (!Number.isInteger(owner) || owner <= 0) return age > LOCK_UNWRITTEN_MS;
    return !isAlive(owner) || age > LOCK_ABANDONED_MS;
  } catch {
    // Released while it was being checked.
    return false;
  }
}

/**
 * Runs `fn` holding `<path>.lock`, so processes that share state.json read and write it one at a time. The lock
 * names its owner; `fn` gets `held`, to confirm the lock is still its own right before it writes.
 */
function withLock<T>(path: string, fn: (held: () => boolean) => T): T {
  const lock = `${path}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (staleLock(lock)) rmSync(lock, { force: true });
      Bun.sleepSync(5);
    }
  }
  const held = () => {
    try {
      return readFileSync(lock, 'utf8') === token;
    } catch {
      return false;
    }
  };
  try {
    return fn(held);
  } finally {
    if (held()) rmSync(lock, { force: true });
  }
}

/** A new record as `queue` writes it: queued from now, owned by this process. */
const queued = (record: Omit<JobRecord, 'status' | 'startedAt' | 'pid'>): JobRecord => ({
  ...record,
  status: 'queued',
  startedAt: new Date().toISOString(),
  pid: process.pid,
});

/**
 * The records in state.json by key, or none when it is missing or unreadable. A queued or running record whose
 * process is gone reads as failed, so a retry is allowed and the next write settles it on disk.
 */
function readRecords(path: string): Map<string, JobRecord> {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing or unreadable state starts fresh.
    return new Map();
  }
  const records = new Map<string, JobRecord>();
  for (const r of Array.isArray(saved) ? (saved as JobRecord[]) : []) {
    if (orphaned(r, true)) r.status = 'failed';
    records.set(r.key, r);
  }
  return records;
}

/** Records newest first. */
const newestFirst = (records: Map<string, JobRecord>) =>
  [...records.values()].toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));

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
    // Only the view changes here: the next write settles the file under the lock, where a newer record can't be
    // overwritten.
    if (path) this.records = readRecords(path);
  }

  /**
   * True when this commit was reviewed, skipped by a route, or is queued or being reviewed. Failed and superseded
   * runs may retry, since neither left a comment for the commit.
   */
  isHandled(key: string): boolean {
    const record = this.current(key);
    return !!record && (record.status === 'done' || record.status === 'skipped' || activeJob(record));
  }

  /** True while the commit is queued or being reviewed. */
  isActive(key: string): boolean {
    const record = this.current(key);
    return !!record && activeJob(record);
  }

  /**
   * The record as the file has it now, so another process finishing, failing, or exiting counts at once rather than
   * at this store's next write.
   */
  private current(key: string): JobRecord | undefined {
    if (!this.path) return this.records.get(key);
    const record = readRecords(this.path).get(key);
    if (record) this.records.set(key, record);
    else this.records.delete(key);
    return record;
  }

  /** Records a review waiting for a slot. A re-review replaces the commit's earlier record. */
  queue(record: Omit<JobRecord, 'status' | 'startedAt' | 'pid'>): void {
    this.records.set(record.key, queued(record));
    mine.add(record.key);
    this.save(record.key);
  }

  /**
   * Queues the record unless a live process has the same key queued or running, and returns whether it did. The
   * check reads the file under the same lock as the write, so two processes can't both claim one key. A finished,
   * failed, or orphaned record is replaced, as `queue` replaces it.
   */
  claim(record: Omit<JobRecord, 'status' | 'startedAt' | 'pid'>, alive: (pid: number) => boolean = isAlive): boolean {
    return this.write((current) => {
      const held = current.get(record.key);
      if (held && !orphaned(held, false, alive) && activeJob(held)) return false;
      // Into the records being written, so a write that has to start again leaves nothing behind.
      current.set(record.key, queued(record));
      mine.add(record.key);
      return true;
    });
  }

  /** Marks a queued review as running from now. */
  begin(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, { status: 'running', startedAt: new Date().toISOString() });
    this.save(key);
  }

  /** Records how a review ended; `finishedAt` is now. */
  finish(key: string, patch: Pick<JobRecord, 'status'> & Partial<JobRecord>): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, patch, { finishedAt: new Date().toISOString() });
    this.save(key);
  }

  /** Every record, newest first. */
  list(): JobRecord[] {
    return newestFirst(this.records);
  }

  /** Drops the oldest finished jobs past `max`; queued and running jobs always stay. */
  private prune(records: Map<string, JobRecord>): void {
    let excess = records.size - this.max;
    if (excess <= 0) return;
    for (const r of newestFirst(records).toReversed()) {
      if (excess === 0) break;
      if (activeJob(r)) continue;
      records.delete(r.key);
      excess--;
    }
  }

  private save(key: string): void {
    this.dirty.add(key);
    this.write(() => true);
  }

  /**
   * Writes this store's changed records over the ones on disk, keeping every other process's records. `decide` sees
   * the records as they are now, on disk or in memory, before the write; its answer is returned.
   */
  private write(decide: (current: Map<string, JobRecord>) => boolean): boolean {
    const path = this.path;
    if (!path) {
      const answer = decide(this.records);
      this.prune(this.records);
      return answer;
    }
    mkdirSync(dirname(path), { recursive: true });
    for (;;) {
      const written = withLock(path, (held) => {
        const merged = readRecords(path);
        const answer = decide(merged);
        for (const changed of this.dirty) {
          const record = this.records.get(changed);
          if (record) merged.set(changed, record);
        }
        this.prune(merged);
        const tmp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(tmp, JSON.stringify(newestFirst(merged), null, 2));
        // Taken over while this process was suspended, so another may have written since: read it again.
        if (!held()) {
          rmSync(tmp, { force: true });
          return undefined;
        }
        renameSync(tmp, path);
        this.records = merged;
        this.dirty.clear();
        return { answer };
      });
      if (written) return written.answer;
    }
  }
}
