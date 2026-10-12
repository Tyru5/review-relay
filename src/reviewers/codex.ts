import { exec } from '../exec.ts';
import type { Usage } from '../usage.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

interface CodexEvent {
  type?: string;
  usage?: Record<string, unknown>;
  message?: unknown;
  error?: { message?: unknown };
}

/** The events `exec --json` prints, one per line; anything else on stdout is skipped. */
function events(stdout: string): CodexEvent[] {
  return stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as CodexEvent;
      return event && typeof event === 'object' ? [event] : [];
    } catch {
      return [];
    }
  });
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Tokens over every `turn.completed` event. Cached reads and cache writes are part of `input_tokens`, and reasoning
 * is part of `output_tokens`, as the OpenAI API counts them. Codex reports no cost, so the runner prices the tokens.
 */
export function codexUsage(stdout: string): Usage | undefined {
  const turns = events(stdout).filter((e) => e.type === 'turn.completed' && e.usage && typeof e.usage === 'object');
  if (turns.length === 0) return undefined;
  const sum = (key: string) => turns.reduce((n, e) => n + count(e.usage![key]), 0);
  return {
    inputTokens: sum('input_tokens'),
    cachedInputTokens: sum('cached_input_tokens'),
    cacheWriteTokens: sum('cache_write_input_tokens'),
    outputTokens: sum('output_tokens'),
  };
}

/** What the `error` and `turn.failed` events said, for a run that failed with nothing on stderr. */
export const codexErrors = (stdout: string) =>
  events(stdout)
    .map((e) => (e.type === 'error' ? e.message : e.type === 'turn.failed' ? e.error?.message : undefined))
    .filter((message): message is string => typeof message === 'string' && message !== '')
    .join('\n');

export const codex: Harness = {
  label: 'Codex',
  product: 'Codex CLI',
  bins: ['codex'],
  defaults: { model: 'gpt-6-astra', effort: 'high' },
  choices: {
    model: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-pro'],
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  schema: 'native',
  // The read-only sandbox blocks writes at the OS level, so any shell command is safe to allow.
  shell: 'git',
  async run({ bin, dir, prompt, schemaPath, scratchDir, timeoutMs, signal, model, effort }) {
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
        // Events on stdout, so the run's token usage can be read; the verdict still comes from the -o file.
        '--json',
        '--output-schema',
        schemaPath,
        '-o',
        outFile,
        '-',
      ],
      { cwd: dir, timeoutMs, signal, stdin: prompt },
    );
    const usage = codexUsage(result.stdout);
    if (result.code !== 0 || result.timedOut) {
      return { ...result, raw: result.stderr.trim() || codexErrors(result.stdout) || result.stdout.trim(), usage };
    }
    const raw = (
      await Bun.file(outFile)
        .text()
        .catch(() => '')
    ).trim();
    return { ...withVerdict(result, raw, () => raw), usage };
  },
};
