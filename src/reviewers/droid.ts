import { opt, resultText, runText } from './run.ts';
import type { Harness } from './types.ts';

export const droid: Harness = {
  label: 'Droid',
  product: 'Factory Droid',
  bins: ['droid'],
  defaults: {},
  schema: 'prompt',
  // Read-only exec aborts the whole run when the model tries a command outside its allow rules, so no shell.
  shell: 'none',
  // Project hooks in .factory/ run even when the workspace is untrusted.
  projectFiles: ['.factory'],
  run: (input) =>
    runText(input, {
      argv: [
        input.bin,
        'exec',
        // exec is read-only unless --auto is passed; --only-tools also drops shell and the web tools.
        '--only-tools',
        'Read,Grep,Glob,LS',
        '-o',
        'json',
        ...opt('-m', input.model),
        ...opt('-r', input.effort),
      ],
      reply: resultText,
    }),
};
