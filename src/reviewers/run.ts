import { exec, type ExecResult } from '../exec.ts';
import { findVerdictJson, parseVerdict } from '../verdict.ts';
import type { ReviewerInput, ReviewerOutput } from './types.ts';

/** `[flag, value]` when the value is set, so unset models and efforts leave the CLI's default alone. */
export const opt = (flag: string, value: string | undefined): string[] => (value ? [flag, value] : []);

/** Attaches the parsed verdict, or an error that keeps the raw output for the report. */
export function withVerdict(result: ExecResult, raw: string, value: () => unknown): ReviewerOutput {
  try {
    return { ...result, raw, verdict: parseVerdict(value()) };
  } catch (err) {
    return { ...result, raw, error: `unreadable verdict: ${err instanceof Error ? err.message : err}` };
  }
}

export interface TextRun {
  argv: string[];
  /** False when the prompt is already in `argv`; otherwise it goes on stdin. */
  stdin?: boolean;
  env?: Record<string, string>;
  /** The final assistant message within stdout; all of stdout by default. */
  reply?: (stdout: string) => string;
}

/** Runs a harness that answers in free text and pulls the verdict JSON out of its final message. */
export async function runText(input: ReviewerInput, run: TextRun): Promise<ReviewerOutput> {
  const result = await exec(run.argv, {
    cwd: input.dir,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    stdin: run.stdin === false ? undefined : input.prompt,
    env: run.env,
  });
  const raw = result.stdout.trim();
  if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw };
  let reply: string;
  try {
    reply = run.reply ? run.reply(result.stdout) : result.stdout;
  } catch (err) {
    return { ...result, code: 1, raw, error: err instanceof Error ? err.message : String(err) };
  }
  return withVerdict(result, raw, () => findVerdictJson(reply));
}

/**
 * The final message from the Claude Code-style `{"type": "result", "result": ...}` envelope that several CLIs
 * print, either as all of stdout or as its last JSON line after banners and events. Throws on `is_error`.
 */
export function resultText(stdout: string): string {
  for (const text of [stdout, ...stdout.trimEnd().split('\n').toReversed()]) {
    let msg: { type?: unknown; result?: unknown; is_error?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    if (msg?.type !== 'result') continue;
    if (msg.is_error) throw new Error(`the CLI reported an error: ${String(msg.result ?? '').slice(0, 500)}`);
    return String(msg.result ?? '');
  }
  throw new Error('no result message in the output');
}
