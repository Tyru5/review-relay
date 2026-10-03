import { opt, runText } from './run.ts';
import type { Harness } from './types.ts';

const AGENT = 'relay-review';

/** Read and search only. `*` also denies bash, web fetch, and MCP tools, and drops them from the tool list. */
const PERMISSION = { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' };

/** Inline config for one run: no sharing, LSP, formatter, snapshots, or MCP, plus the read-only review agent. */
const inlineConfig = (schema: string) =>
  JSON.stringify({
    $schema: schema,
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    lsp: false,
    formatter: false,
    mcp: {},
    agent: { [AGENT]: { mode: 'primary', description: 'Read-only pull request reviewer', permission: PERMISSION } },
  });

/** The final message from `run --format json`: the text of the last `text` event. */
export function lastTextEvent(stdout: string): string {
  let text: string | undefined;
  for (const line of stdout.split('\n')) {
    let event: { type?: string; part?: { text?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') text = event.part.text;
  }
  if (text === undefined) throw new Error('no text event in the output');
  return text;
}

const argv = (bin: string, model?: string, effort?: string) => [
  bin,
  'run',
  // Skips the user's plugins, which can add agents and MCP servers.
  '--pure',
  '--agent',
  AGENT,
  '--format',
  'json',
  ...opt('-m', model),
  ...opt('--variant', effort),
];

export const opencode: Harness = {
  label: 'opencode',
  product: 'opencode',
  bins: ['opencode'],
  defaults: {},
  choices: { model: [], effort: [] },
  schema: 'prompt',
  // Bash rules are patterns, and an allowed `git diff *` also passes `git diff --output=<file>`, so no shell.
  shell: 'none',
  // Plugins under .opencode/ load even with project config disabled and --pure.
  projectFiles: ['.opencode', 'opencode.json', 'opencode.jsonc'],
  run: (input) =>
    runText(input, {
      argv: argv(input.bin, input.model, input.effort),
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_CONFIG_CONTENT: inlineConfig('https://opencode.ai/config.json'),
        // Also set on its own: an invalid OPENCODE_PERMISSION is skipped with only a warning, a bad config fails.
        OPENCODE_PERMISSION: JSON.stringify(PERMISSION),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      },
      reply: lastTextEvent,
    }),
};

/** Kilo Code's CLI is an opencode fork: the same flags and config, with KILO_ variables and its own file names. */
export const kilo: Harness = {
  label: 'Kilo',
  product: 'Kilo Code CLI',
  bins: ['kilo', 'kilocode'],
  defaults: {},
  choices: { model: [], effort: [] },
  schema: 'prompt',
  shell: 'none',
  projectFiles: ['.kilo', '.kilocode', 'kilo.json', 'kilo.jsonc', 'opencode.json', 'opencode.jsonc'],
  run: (input) =>
    runText(input, {
      argv: argv(input.bin, input.model, input.effort),
      env: {
        // A running `kilo daemon` would otherwise take the run, in its own environment without these settings.
        KILO_NO_DAEMON: '1',
        KILO_DISABLE_PROJECT_CONFIG: '1',
        KILO_CONFIG_CONTENT: inlineConfig('https://app.kilo.ai/config.json'),
        KILO_PERMISSION: JSON.stringify(PERMISSION),
        KILO_DISABLE_AUTOUPDATE: '1',
        KILO_DISABLE_LSP_DOWNLOAD: '1',
        KILO_DISABLE_CLAUDE_CODE: '1',
        KILO_DISABLE_EXTERNAL_SKILLS: '1',
        KILO_DISABLE_SKILL_SHELL: '1',
        KILO_DISABLE_SESSION_INGEST: '1',
        KILO_DISABLE_SHARE: '1',
        KILO_TELEMETRY_LEVEL: 'off',
      },
      reply: lastTextEvent,
    }),
};
