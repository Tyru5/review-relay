import { opt, runText } from './run.ts';
import type { Harness } from './types.ts';

export const copilot: Harness = {
  label: 'Copilot',
  product: 'GitHub Copilot CLI',
  bins: ['copilot'],
  defaults: {},
  choices: { model: [], effort: [] },
  schema: 'prompt',
  shell: 'none',
  // Repo hooks and MCP servers load only in trusted folders, and prompt runs never auto-trust, but these go anyway.
  projectFiles: ['.github/hooks', '.github/copilot', '.mcp.json', '.vscode/mcp.json'],
  run: (input) =>
    runText(input, {
      argv: [
        input.bin,
        '-p',
        input.prompt,
        // Prints only the agent's reply.
        '-s',
        '--no-color',
        // Prompt runs deny every tool without an allow rule; this also hides all but the read tools from the model.
        '--available-tools',
        'view,read,grep,glob',
        '--deny-tool',
        'write',
        '--deny-tool',
        'shell',
        '--no-ask-user',
        // Keeps AGENTS.md and other instruction files from loading as instructions; the prompt has them read as data.
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--no-auto-update',
        ...opt('--model', input.model),
        ...opt('--reasoning-effort', input.effort),
      ],
      // Piped stdin is ignored once -p is given.
      stdin: false,
    }),
};
