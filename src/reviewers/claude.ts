import { exec } from '../exec.ts';
import { parseVerdict, VERDICT_SCHEMA } from '../verdict.ts';
import type { ReviewerInput, ReviewerOutput } from './types.ts';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git grep:*)'];

export async function runClaude({ dir, prompt, timeoutMs }: ReviewerInput): Promise<ReviewerOutput> {
  const result = await exec(
    [
      'claude', '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(VERDICT_SCHEMA),
      '--allowedTools', ...READ_ONLY_TOOLS,
    ],
    { cwd: dir, timeoutMs, stdin: prompt },
  );
  const raw = result.stdout.trim();
  if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw };
  const parsed = JSON.parse(raw) as { structured_output?: unknown; result?: string; is_error?: boolean };
  if (parsed.is_error) return { ...result, code: 1, raw: parsed.result ?? raw };
  return { ...result, raw, verdict: parseVerdict(parsed.structured_output ?? parsed.result) };
}
