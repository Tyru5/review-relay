import { runText } from './run.ts';
import type { Harness } from './types.ts';

interface VibeEntry {
  type?: string;
  role?: string;
  content?: { type?: string; text?: string }[];
}

/** The last assistant message in the history array `--output json` prints. */
export function vibeReply(stdout: string): string {
  const history = JSON.parse(stdout) as VibeEntry[];
  const last = history.findLast((entry) => entry.type === 'message' && entry.role === 'assistant');
  if (!last) throw new Error('no assistant message in the output');
  return (last.content ?? []).map((part) => part.text ?? '').join('');
}

export const vibe: Harness = {
  label: 'Vibe',
  product: 'Mistral Vibe',
  bins: ['vibe'],
  // No model flag: the model is a config alias picked through VIBE_ACTIVE_MODEL. No effort setting either.
  defaults: {},
  choices: { model: [] },
  schema: 'prompt',
  // The plan agent runs git diff and git log on its own and refuses flags that write or run programs.
  shell: 'git',
  // Read only for trusted folders; never passing --trust keeps it that way, and these go regardless.
  projectFiles: ['.vibe', '.agents'],
  run: (input) =>
    runText(input, {
      // Programmatic mode denies anything that needs approval, and plan never allows writes or edits.
      argv: [input.bin, '-p', '--agent', 'plan', '--output', 'json', '--max-turns', '100'],
      env: { VIBE_ENABLE_TELEMETRY: 'false', ...(input.model ? { VIBE_ACTIVE_MODEL: input.model } : {}) },
      reply: vibeReply,
    }),
};
