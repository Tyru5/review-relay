import { exec } from '../exec.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

export const codex: Harness = {
  label: 'Codex',
  product: 'Codex CLI',
  bins: ['codex'],
  defaults: { model: 'gpt-6-astra', effort: 'high' },
  schema: 'native',
  // The read-only sandbox blocks writes at the OS level, so any shell command is safe to allow.
  shell: 'git',
  async run({ bin, dir, prompt, schemaPath, scratchDir, timeoutMs, model, effort }) {
    const outFile = `${scratchDir}/codex-verdict.json`;
    const result = await exec(
      [
        bin,
        'exec',
        // Skips ~/.codex/config.toml (its MCP servers run outside the sandbox) and execpolicy rules that
        // could let commands escape it. Auth still loads from CODEX_HOME.
        '--ignore-user-config',
        '--ignore-rules',
        ...opt('--model', model),
        ...opt('-c', effort && `model_reasoning_effort="${effort}"`),
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--output-schema',
        schemaPath,
        '-o',
        outFile,
        '-',
      ],
      { cwd: dir, timeoutMs, stdin: prompt },
    );
    if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || result.stdout.trim() };
    const raw = (
      await Bun.file(outFile)
        .text()
        .catch(() => '')
    ).trim();
    return withVerdict(result, raw, () => raw);
  },
};
