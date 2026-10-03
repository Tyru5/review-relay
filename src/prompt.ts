import { describeStats, type DiffStats } from './diffstats.ts';
import type { ResolvedJob } from './types.ts';
import { VERDICT_SCHEMA } from './verdict.ts';
import { baseRemoteRef } from './worktree.ts';

export interface PromptOptions {
  /** Spell out the verdict schema, for harnesses that can't enforce one. */
  schema?: boolean;
  /** Commits and diff to include, for harnesses run without a shell. */
  diff?: string;
}

/** One rubric for every reviewer so their scores are comparable. */
export function reviewPrompt(job: ResolvedJob, stats: DiffStats, opts: PromptOptions = {}): string {
  const base = baseRemoteRef(job);
  const read = opts.diff
    ? `1. Read the change: its commits and \`git diff ${base}...HEAD\` are below. You have no shell, so use your file read and search tools for everything else.`
    : `1. Read the change: \`git diff ${base}...HEAD\` and \`git log ${base}..HEAD\`.`;
  const answer = opts.schema
    ? `Do not modify any files. Reply with only a JSON object, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(VERDICT_SCHEMA)}`
    : 'Do not modify any files. Respond only with JSON matching the provided schema.';
  return `You are a senior engineer scoring pull request #${job.pr} in ${job.repo} for merge confidence.
The working directory is checked out at the PR head (${job.headSha}). The base is ${base}.
Computed diff stats: ${describeStats(stats)}.

Steps:
${read}
2. Learn this repo's standards before judging. Read whichever exist: AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md, .greptile/ and greptile.json rules, .cursor/rules, lint and format configs (eslint, oxlint, biome, prettier, ruff, golangci, editorconfig), tsconfig, and existing code next to the changed files.
3. Measure blast radius: for each changed exported function, type, API route, schema, config value, or shared module, search for its callers and importers. Note how many places depend on it and whether their behavior changes.
4. Check whether the changed behavior is covered by new or existing tests.

Score each dimension from 1 to 5 (5 is best) with a one-sentence note:
- correctness: bugs, edge cases, error handling, races, data loss.
- security: injection, authn/authz, secrets, unsafe input handling, risky dependencies.
- codeQuality: readability, structure, duplication, complexity, naming, dead code.
- standards: follows this repo's documented conventions and established industry practice for the language and framework.
- blastRadius: 5 means an isolated change with few dependents; 1 means it changes shared or core code, public APIs, schemas, or config that many call sites rely on, with behavior changes.
- testing: the changed behavior is covered by meaningful tests.

Overall score (merge confidence) from 1 to 5:
5 = safe to merge as is. 4 = minor issues only. 3 = at least one major issue or notable unmitigated risk; fix before merging. 2 = a critical issue, or a wide blast radius with weak tests. 1 = broken, unsafe, or should not merge.

Findings: report only real problems. Skip style nits unless they break a documented repo rule.
Severity: critical = will break production, security, or data; major = likely bug or significant risk; minor = small correctness or maintainability issue.
For each finding give the file path relative to the repo root, the line in the new version (null if not line-specific), a short title, what goes wrong, and a concrete suggested fix.
summary: two or three sentences on what the PR does and its overall state. scoreRationale: one or two sentences on why the overall score.
${opts.diff ? `\n${opts.diff}\n` : ''}
${answer}`;
}
