import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../exec.ts';
import { opt, resultText, runText } from './run.ts';
import type { Harness } from './types.ts';

/** Tools that only read the checkout or track the agent's own task list. */
const READ_TOOLS = new Set([
  'view',
  'view-range-untruncated',
  'grep-search',
  'search-untruncated',
  'codebase-retrieval-raw',
  'view_tasklist',
  'add_tasks',
  'update_tasks',
  'reorganize_tasklist',
]);

/** Names from `auggie tools list` lines such as `  ✓ view   enabled`. */
export const listedTools = (stdout: string) => [...stdout.matchAll(/^\s*[✓✗]\s+(\S+)/gm)].map((m) => m[1]!);

export const auggie: Harness = {
  label: 'Auggie',
  product: 'Augment Auggie',
  bins: ['auggie'],
  defaults: {},
  schema: 'prompt',
  shell: 'none',
  // Hooks and MCP servers in a PR's .augment/ run on startup.
  projectFiles: ['.augment'],
  async run(input) {
    // A fresh cache dir keeps ~/.augment's settings, MCP servers, and rules out of the run, so the login is
    // handed over through the variable Auggie documents for headless use.
    const session = await Bun.file(join(homedir(), '.augment', 'session.json'))
      .text()
      .catch(() => '');
    const env = session && !process.env.AUGMENT_SESSION_AUTH ? { AUGMENT_SESSION_AUTH: session.trim() } : undefined;
    const cache = ['--augment-cache-dir', join(input.scratchDir, 'augment')];

    // Auggie has deny rules but no allowlist, and new tools (including the user's sub-agents) start enabled,
    // so list what this install has and remove everything that isn't read-only.
    const listing = await exec([input.bin, 'tools', 'list', ...cache], { cwd: input.dir, env, timeoutMs: 120_000 });
    const tools = listedTools(listing.stdout);
    if (!tools.includes('view')) {
      const raw = (listing.stderr || listing.stdout).trim();
      return { ...listing, code: listing.code || 1, raw, error: `could not list auggie tools to lock it down: ${raw}` };
    }
    const remove = tools.filter((tool) => !READ_TOOLS.has(tool)).flatMap((tool) => ['--remove-tool', tool]);

    return runText(input, {
      argv: [
        input.bin,
        '--print',
        '--output-format',
        'json',
        '--dont-save-session',
        ...cache,
        ...opt('-m', input.model),
        ...opt('--reasoning-effort', input.effort),
        ...remove,
      ],
      env,
      reply: resultText,
    });
  },
};
