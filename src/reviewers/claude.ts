import { exec } from '../exec.ts';
import type { Usage } from '../usage.ts';
import { VERDICT_SCHEMA } from '../verdict.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

interface ClaudeMessage {
  type?: string;
  structured_output?: unknown;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: unknown;
  /** The main model's tokens, with cached input counted apart from `input_tokens`. */
  usage?: Record<string, unknown>;
  /** Tokens per model the run used, side calls to a smaller model included. */
  modelUsage?: Record<string, Record<string, unknown>>;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Sums `rows` into a usage, given each row's keys for fresh input, cache reads, cache writes, and output. */
function tally(rows: Record<string, unknown>[], keys: [string, string, string, string]): Usage {
  const [input, cached, written, output] = keys.map((key) => rows.reduce((n, row) => n + count(row[key]), 0));
  return {
    inputTokens: input! + cached! + written!,
    cachedInputTokens: cached!,
    cacheWriteTokens: written!,
    outputTokens: output!,
  };
}

/** Tokens across every model the result message lists, and the cost the CLI worked out for them. */
export function claudeUsage(message: ClaudeMessage | undefined): Usage | undefined {
  if (!message) return undefined;
  const isRow = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object';
  // A malformed entry is skipped rather than thrown on, so usage can never fail a review that returned a verdict.
  const models = isRow(message.modelUsage) ? Object.values(message.modelUsage).filter(isRow) : [];
  let usage =
    models.length > 0
      ? tally(models, ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'])
      : isRow(message.usage)
        ? tally(
            [message.usage],
            ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'],
          )
        : undefined;
  if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd)) {
    usage ??= { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    usage.costUsd = message.total_cost_usd;
  }
  return usage;
}

export const claude: Harness = {
  label: 'Claude',
  product: 'Claude Code',
  bins: ['claude'],
  defaults: { model: 'claude-opus-5-5', effort: 'max' },
  choices: {
    model: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  schema: 'native',
  // A `git diff:*` allow rule also matches `git diff --output=<file>`, which writes anywhere, and `git grep -O<cmd>`
  // runs a program, so Bash stays off and the diff goes in the prompt.
  shell: 'none',
  async run({ bin, dir, prompt, timeoutMs, signal, model, effort }) {
    const result = await exec(
      [
        bin,
        '-p',
        // Ignores user, project, and local settings files, so neither a user's bypassPermissions default nor
        // a .claude/settings.json in the PR can widen access, and refuses bypassPermissions outright.
        '--restricted',
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
        '--no-session-persistence',
        '--tools',
        'Read,Grep,Glob',
        ...opt('--model', model),
        ...opt('--effort', effort),
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(VERDICT_SCHEMA),
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
      ],
      { cwd: dir, timeoutMs, signal, stdin: prompt },
    );
    const raw = result.stdout.trim();
    let final: ClaudeMessage | undefined;
    try {
      // Older CLIs print the result object alone; newer ones print every message as an array.
      const parsed = JSON.parse(raw) as ClaudeMessage | ClaudeMessage[];
      final = Array.isArray(parsed) ? parsed.findLast((m) => m.type === 'result') : parsed;
    } catch {
      // Not JSON at all: reported below as an unreadable verdict, with the output kept.
    }
    // A failed run can still have spent tokens, so its usage is kept too.
    const usage = claudeUsage(final);
    if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw, usage };
    if (final?.is_error) return { ...result, code: 1, raw: final.result ?? raw, usage };
    return { ...withVerdict(result, raw, () => final?.structured_output ?? final?.result), usage };
  },
};
