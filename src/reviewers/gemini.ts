import { opt, runText } from './run.ts';
import type { Harness } from './types.ts';

/** `.response` from `--output-format json`, which is `{ session_id, response, stats, error? }`. */
export function geminiReply(stdout: string): string {
  const out = JSON.parse(stdout) as { response?: unknown; error?: unknown };
  if (out.error) throw new Error(`the CLI reported an error: ${JSON.stringify(out.error).slice(0, 500)}`);
  return String(out.response ?? '');
}

export const gemini: Harness = {
  label: 'Gemini',
  product: 'Gemini CLI',
  bins: ['gemini'],
  // Thinking is a settings-file option, so there is no per-run effort.
  defaults: {},
  schema: 'prompt',
  // Plan mode denies the shell tool outright.
  shell: 'none',
  // Trusting the run (below) lets project settings and .env load, and settings can define MCP servers.
  projectFiles: ['.gemini', '.env'],
  run: (input) =>
    runText(input, {
      argv: [
        input.bin,
        // In headless runs plan mode allows only read and search tools, and anything that would ask is denied.
        '--approval-mode',
        'plan',
        '--output-format',
        'json',
        '-e',
        'none',
        // An allowlist naming no real server loads none of the user's MCP servers.
        '--allowed-mcp-server-names',
        'review-relay-none',
        ...opt('-m', input.model),
        '-p',
        input.prompt,
      ],
      stdin: false,
      // An untrusted folder makes headless runs exit 55 and would drop plan mode, so trust this run only.
      env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      reply: geminiReply,
    }),
};
