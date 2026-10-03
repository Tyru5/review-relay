import type { HarnessName } from '../types.ts';
import { auggie } from './auggie.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { copilot } from './copilot.ts';
import { droid } from './droid.ts';
import { gemini } from './gemini.ts';
import { grok } from './grok.ts';
import { hermes } from './hermes.ts';
import { kilo, opencode } from './opencode.ts';
import { pi } from './pi.ts';
import { qwen } from './qwen.ts';
import { vibe } from './vibe.ts';
import type { Harness } from './types.ts';

/** Every supported harness, in the order setup lists them: the defaults first, then alphabetical. */
export const HARNESSES: Record<HarnessName, Harness> = {
  claude,
  codex,
  auggie,
  copilot,
  droid,
  gemini,
  grok,
  hermes,
  kilo,
  opencode,
  pi,
  qwen,
  vibe,
};

export const HARNESS_NAMES = Object.keys(HARNESSES) as HarnessName[];

export const isHarness = (name: unknown): name is HarnessName => HARNESS_NAMES.includes(name as HarnessName);

/** Path of the harness's preferred executable on PATH, or null when it isn't installed. */
export function findBin(name: HarnessName, which = (bin: string) => Bun.which(bin)): string | null {
  for (const bin of HARNESSES[name].bins) {
    const path = which(bin);
    if (path) return path;
  }
  return null;
}
