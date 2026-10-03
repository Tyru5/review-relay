import type { ExecResult } from '../exec.ts';
import type { Verdict } from '../verdict.ts';

export interface ReviewerInput {
  /** Executable to spawn: the first of the harness's `bins` found on PATH. */
  bin: string;
  dir: string;
  prompt: string;
  schemaPath: string;
  /** Per-job directory for reviewer output files. */
  scratchDir: string;
  timeoutMs: number;
  /** Unset means the CLI's own default. */
  model?: string;
  effort?: string;
  provider?: string;
}

export interface ReviewerOutput extends ExecResult {
  raw: string;
  verdict?: Verdict;
  /** Why no verdict came back when the CLI itself exited cleanly. */
  error?: string;
}

/** An agentic coding CLI that can review a checkout headlessly with writes and arbitrary shell blocked. */
export interface Harness {
  /** Name in PR comments, e.g. "Claude". */
  label: string;
  /** Product name in setup, e.g. "Claude Code". */
  product: string;
  /** Executables to look for on PATH, preferred first. */
  bins: string[];
  /** Used when the config sets none; unset falls back to the CLI's own default. */
  defaults: { model?: string; effort?: string };
  /** `native`: the CLI enforces the verdict schema. `prompt`: the schema goes in the prompt and the reply is parsed. */
  schema: 'native' | 'prompt';
  /** `git`: the CLI can allow read-only git commands alone. `none`: no shell, so the diff goes in the prompt. */
  shell: 'git' | 'none';
  /**
   * Paths in the checkout that the CLI loads as its own config and can run code from (hooks, plugins, MCP
   * servers), so a PR could use them to escape the lockdown. The runner deletes them before any reviewer starts.
   */
  projectFiles?: string[];
  run(input: ReviewerInput): Promise<ReviewerOutput>;
}
