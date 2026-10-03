import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { opt, runText } from './run.ts';
import type { Harness } from './types.ts';

export const hermes: Harness = {
  label: 'Hermes',
  product: 'Hermes Agent',
  bins: ['hermes'],
  defaults: {},
  choices: { model: [], effort: [] },
  schema: 'prompt',
  // Its only command tool is an unrestricted shell, and one-shot mode approves every call.
  shell: 'none',
  projectFiles: ['.hermes'],
  async run(input) {
    // With approvals off, the lockdown is the `file` toolset (read, search, write, patch) plus a write root that
    // is an empty scratch directory, so writes anywhere else are refused.
    const writeRoot = join(input.scratchDir, 'hermes-writes');
    await mkdir(writeRoot, { recursive: true });
    return runText(input, {
      argv: [
        input.bin,
        '-z',
        input.prompt,
        '--safe-mode',
        '-t',
        'file',
        ...opt('-m', input.model),
        ...opt('--provider', input.provider),
        ...opt('--reasoning', input.effort),
      ],
      stdin: false,
      env: { HERMES_WRITE_SAFE_ROOT: writeRoot, TERMINAL_CWD: input.dir },
    });
  },
};
