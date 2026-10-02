import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobSource } from './types.ts';

export type JobStatus = 'running' | 'done' | 'failed';

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
  error?: string;
}

/** Job history persisted as one JSON file; `null` path keeps it in memory (tests, dry runs). */
export class StateStore {
  private records = new Map<string, JobRecord>();

  constructor(private readonly path: string | null) {
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

  /** True when this commit was already reviewed or is being reviewed. Failed runs may retry. */
  isHandled(key: string): boolean {
    const status = this.records.get(key)?.status;
    return status === 'running' || status === 'done';
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
    return [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
    renameSync(tmp, this.path);
  }
}
