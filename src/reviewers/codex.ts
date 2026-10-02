import { exec } from '../exec.ts';
import { parseVerdict } from '../verdict.ts';
import type { ReviewerInput, ReviewerOutput } from './types.ts';

export async function runCodex({ dir, prompt, schemaPath, scratchDir, timeoutMs }: ReviewerInput): Promise<ReviewerOutput> {
  const outFile = `${scratchDir}/codex-verdict.json`;
  const result = await exec(
    ['codex', 'exec', '--sandbox', 'read-only', '--ephemeral', '--output-schema', schemaPath, '-o', outFile, '-'],
    { cwd: dir, timeoutMs, stdin: prompt },
  );
  if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || result.stdout.trim() };
  const raw = (await Bun.file(outFile).text().catch(() => '')).trim();
  return { ...result, raw, verdict: parseVerdict(raw) };
}
