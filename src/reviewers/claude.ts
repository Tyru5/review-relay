import { exec } from '../exec.ts';
import { VERDICT_SCHEMA } from '../verdict.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

interface ClaudeMessage {
  type?: string;
  structured_output?: unknown;
  result?: string;
  is_error?: boolean;
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
    if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw };
    let final: ClaudeMessage | undefined;
    try {
      // Older CLIs print the result object alone; newer ones print every message as an array.
      const parsed = JSON.parse(raw) as ClaudeMessage | ClaudeMessage[];
      final = Array.isArray(parsed) ? parsed.findLast((m) => m.type === 'result') : parsed;
    } catch {
      // Not JSON at all: reported below as an unreadable verdict, with the output kept.
    }
    if (final?.is_error) return { ...result, code: 1, raw: final.result ?? raw };
    return withVerdict(result, raw, () => final?.structured_output ?? final?.result);
  },
};
