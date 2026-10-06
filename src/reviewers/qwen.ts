import { exec } from '../exec.ts';
import { VERDICT_SCHEMA } from '../verdict.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

interface QwenMessage {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  structured_result?: unknown;
}

export const qwen: Harness = {
  label: 'Qwen',
  product: 'Qwen Code',
  bins: ['qwen'],
  // Reasoning effort is a settings-file option, so there is no per-run effort.
  defaults: {},
  choices: { model: [] },
  schema: 'native',
  // Headless plan mode puts the shell, edit, and write tools on the deny list.
  shell: 'none',
  projectFiles: ['.qwen'],
  async run({ bin, dir, prompt, timeoutMs, signal, model }) {
    const result = await exec(
      [
        bin,
        '--approval-mode',
        'plan',
        // Skips project context files, hooks, extensions, skills, MCP servers, and approval overrides.
        '--safe-mode',
        '-o',
        'json',
        '--json-schema',
        JSON.stringify(VERDICT_SCHEMA),
        ...opt('-m', model),
      ],
      { cwd: dir, timeoutMs, signal, stdin: prompt },
    );
    const raw = result.stdout.trim();
    if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw };
    let final: QwenMessage | undefined;
    try {
      final = (JSON.parse(raw) as QwenMessage[]).findLast((m) => m.type === 'result');
    } catch {
      // Not the message array: reported below as an unreadable verdict, with the output kept.
    }
    if (final?.is_error) return { ...result, code: 1, raw: String(final.result ?? raw) };
    return withVerdict(result, raw, () => final?.structured_result ?? final?.result);
  },
};
