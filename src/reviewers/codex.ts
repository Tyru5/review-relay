import { exec } from '../exec.ts';
import type { ResolvedJob } from '../types.ts';
import { baseRemoteRef } from '../worktree.ts';

export async function runCodex(job: ResolvedJob, dir: string, timeoutMs: number) {
  const result = await exec(
    [
      'codex', 'review',
      '-c', 'sandbox_mode="read-only"',
      '-c', 'approval_policy="never"',
      '--base', baseRemoteRef(job),
    ],
    { cwd: dir, timeoutMs },
  );
  return { ...result, output: result.stdout.trim() };
}
