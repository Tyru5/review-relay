import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobSource } from './types.ts';

/** `skipped`: a skip route matched, so nothing ran. */
export type JobStatus = 'running' | 'done' | 'failed' | 'skipped';

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
        // A record left `running` means the daemon died mid-review; allow a retry.
        if (r.status === 'running') r.status = 'failed';
        this.records.set(r.key, r);
      }
    } catch {
      // Missing or unreadable state starts fresh.
    }
  }

  /** True when this commit was reviewed, skipped by a route, or is being reviewed. Failed runs may retry. */
  isHandled(key: string): boolean {
    const status = this.records.get(key)?.status;
    return status === 'running' || status === 'done' || status === 'skipped';
  }

  isRunning(key: string): boolean {
    return this.records.get(key)?.status === 'running';
  }

  start(record: Omit<JobRecord, 'status' | 'startedAt'>): void {
    this.records.set(record.key, { ...record, status: 'running', startedAt: new Date().toISOString() });
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

  /** Drops the oldest finished jobs past `max`; running jobs always stay. */
  private prune(): void {
    let excess = this.records.size - this.max;
    if (excess <= 0) return;
    for (const r of this.list().toReversed()) {
      if (excess === 0) break;
      if (r.status === 'running') continue;
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
