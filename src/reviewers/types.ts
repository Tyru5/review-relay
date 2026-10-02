import type { ExecResult } from '../exec.ts';
import type { Verdict } from '../verdict.ts';

export interface ReviewerInput {
  dir: string;
  prompt: string;
  schemaPath: string;
  /** Per-job directory for reviewer output files. */
  scratchDir: string;
  timeoutMs: number;
  model: string;
  effort: string;
}

export interface ReviewerOutput extends ExecResult {
  raw: string;
  verdict?: Verdict;
}
