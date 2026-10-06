import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobSource } from './types.ts';

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
}

/** Jobs kept in state.json. Older ones are dropped, so a commit that old can be reviewed again if an event names it. */
export const MAX_RECORDS = 1000;

/** Job history persisted as one JSON file; `null` path keeps it in memory (tests, dry runs). */
export class StateStore {
  private records = new Map<string, JobRecord>();

  constructor(
    private readonly path: string | null,
    private readonly max = MAX_RECORDS,
  ) {
    if (!path) return;
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as JobRecord[];
      for (const r of saved) {
        // A record left `queued` or `running` means the daemon died before it finished; allow a retry.
        if (activeJob(r)) r.status = 'failed';
        this.records.set(r.key, r);
      }
    } catch {
      // Missing or unreadable state starts fresh.
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
  queue(record: Omit<JobRecord, 'status' | 'startedAt'>): void {
    this.records.set(record.key, { ...record, status: 'queued', startedAt: new Date().toISOString() });
    this.save();
  }

  /** Marks a queued review as running from now. */
  begin(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, { status: 'running', startedAt: new Date().toISOString() });
    this.save();
  }

  finish(key: string, patch: Pick<JobRecord, 'status'> & Partial<JobRecord>): void {
    const record = this.records.get(key);
    if (!record) return;
    Object.assign(record, patch, { finishedAt: new Date().toISOString() });
    this.save();
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

  private save(): void {
    this.prune();
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
    renameSync(tmp, this.path);
  }
}
