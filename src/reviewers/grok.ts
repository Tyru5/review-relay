import { join } from 'node:path';
import { exec } from '../exec.ts';
import { VERDICT_SCHEMA } from '../verdict.ts';
import { opt, withVerdict } from './run.ts';
import type { Harness } from './types.ts';

/** Grok imports Claude Code and Cursor hooks, MCP servers, skills, rules, and agents unless told not to. */
const NO_IMPORTS = Object.fromEntries(
  ['CLAUDE', 'CURSOR'].flatMap((tool) =>
    ['HOOKS', 'MCPS', 'SKILLS', 'RULES', 'AGENTS'].map((kind) => [`GROK_${tool}_${kind}_ENABLED`, '0']),
  ),
);

export const grok: Harness = {
  label: 'Grok',
  product: 'Grok Build',
  bins: ['grok'],
  defaults: {},
  choices: { model: [], effort: [] },
  schema: 'native',
  // Allow rules match whole command strings and a rejected call ends the turn, so no shell.
  shell: 'none',
  // Loaded only for trusted folders, but trust covers subfolders, so they go regardless.
  projectFiles: ['.grok', '.envrc'],
  async run({ bin, dir, prompt, scratchDir, timeoutMs, model, effort }) {
    const promptFile = join(scratchDir, 'prompt.txt');
    await Bun.write(promptFile, prompt);
    const result = await exec(
      [
        bin,
        '--prompt-file',
        promptFile,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(VERDICT_SCHEMA),
        // Removing tools is what holds. Grok turns a Claude Code bypassPermissions default into an allow-all
        // rule that --permission-mode can't undo.
        '--tools',
        'read_file,grep,list_dir',
        '--disallowed-tools',
        'search_tool,use_tool',
        '--deny',
        'MCPTool',
        '--permission-mode',
        'default',
        '--no-subagents',
        '--disable-web-search',
        '--no-memory',
        '--no-auto-update',
        ...opt('-m', model),
        ...opt('--reasoning-effort', effort),
      ],
      { cwd: dir, timeoutMs, env: NO_IMPORTS },
    );
    const raw = result.stdout.trim();
    if (result.code !== 0 || result.timedOut) return { ...result, raw: result.stderr.trim() || raw };
    return withVerdict(result, raw, () => (JSON.parse(raw) as { structuredOutput?: unknown }).structuredOutput);
  },
};
