import { opt, runText } from './run.ts';
import type { Harness } from './types.ts';

export const pi: Harness = {
  label: 'Pi',
  product: 'pi',
  bins: ['pi'],
  defaults: {},
  schema: 'prompt',
  shell: 'none',
  projectFiles: ['.pi'],
  run: (input) =>
    runText(input, {
      argv: [
        input.bin,
        '-p',
        '--no-session',
        // Ignores project-local files even when a trust entry covers the worktree, and loads no extensions,
        // skills, templates, themes, or AGENTS.md/CLAUDE.md.
        '--no-approve',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--tools',
        'read,grep,find,ls',
        ...opt('--model', input.model),
        ...opt('--thinking', input.effort),
        input.prompt,
      ],
      // pi prepends any piped stdin to the prompt; the prompt is already in argv.
      stdin: false,
    }),
};
