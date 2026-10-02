import { exec } from '../exec.ts';
import type { ResolvedJob } from '../types.ts';
import { baseRemoteRef } from '../worktree.ts';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];

export function claudePrompt(job: ResolvedJob): string {
  const base = baseRemoteRef(job);
  return [
    `Review pull request #${job.pr} in ${job.repo}. The working directory is checked out at the PR head (${job.headSha}).`,
    `See the change with \`git diff ${base}...HEAD\` and \`git log ${base}..HEAD\`. Read surrounding code as needed.`,
    'Report only real problems: bugs, security issues, data loss, race conditions, broken error handling, and missing edge cases.',
    'Skip style nits. For each finding give severity (critical/major/minor), file:line, what goes wrong, and a suggested fix.',
    'If you find nothing worth flagging, say so in one line. Do not modify any files. Reply in Markdown.',
  ].join('\n');
}

export async function runClaude(job: ResolvedJob, dir: string, timeoutMs: number) {
  const result = await exec(
    ['claude', '-p', '--output-format', 'json', '--allowedTools', ...READ_ONLY_TOOLS],
    { cwd: dir, timeoutMs, stdin: claudePrompt(job) },
  );
  let output = result.stdout.trim();
  try {
    const parsed = JSON.parse(output) as { result?: string; is_error?: boolean };
    if (parsed.is_error) return { ...result, code: result.code || 1, output: parsed.result ?? output };
    output = parsed.result ?? output;
  } catch {
    // Non-JSON output (e.g. auth errors) is reported as-is.
  }
  return { ...result, output };
}
