export const DIMENSIONS = ['correctness', 'security', 'codeQuality', 'standards', 'blastRadius', 'testing'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  correctness: 'Correctness',
  security: 'Security',
  codeQuality: 'Code quality',
  standards: 'Standards (repo + industry)',
  blastRadius: 'Blast radius',
  testing: 'Testing',
};

export type Severity = 'critical' | 'major' | 'minor';
export const SEVERITIES: Severity[] = ['critical', 'major', 'minor'];

export interface Finding {
  severity: Severity;
  file: string;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string;
}

export interface Verdict {
  summary: string;
  score: number;
  scoreRationale: string;
  dimensions: Record<Dimension, { score: number; note: string }>;
  findings: Finding[];
}

const scoreField = { type: 'integer', minimum: 1, maximum: 5 };
const dimensionField = {
  type: 'object',
  properties: { score: scoreField, note: { type: 'string' } },
  required: ['score', 'note'],
  additionalProperties: false,
};

/**
 * Shared by `claude --json-schema` and `codex exec --output-schema` (strict mode: every field required).
 * Harnesses without a schema flag get it in the prompt instead.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    score: scoreField,
    scoreRationale: { type: 'string' },
    dimensions: {
      type: 'object',
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionField])),
      required: [...DIMENSIONS],
      additionalProperties: false,
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'title', 'detail', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'score', 'scoreRationale', 'dimensions', 'findings'],
  additionalProperties: false,
} as const;

const clampScore = (n: unknown) => Math.min(5, Math.max(1, Math.round(Number(n) || 1)));

/** Validates model output; throws with a readable reason when it does not match the schema. */
export function parseVerdict(raw: unknown): Verdict {
  const v = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>;
  if (!v || typeof v !== 'object') throw new Error('verdict is not an object');
  if (typeof v.summary !== 'string') throw new Error('verdict.summary missing');
  if (!v.dimensions || typeof v.dimensions !== 'object') throw new Error('verdict.dimensions missing');
  const dimensions = {} as Verdict['dimensions'];
  for (const d of DIMENSIONS) {
    const dim = v.dimensions[d];
    if (!dim) throw new Error(`verdict.dimensions.${d} missing`);
    dimensions[d] = { score: clampScore(dim.score), note: String(dim.note ?? '') };
  }
  const findings: Finding[] = (Array.isArray(v.findings) ? v.findings : []).map((f: Record<string, any>) => ({
    severity: SEVERITIES.includes(f.severity) ? f.severity : 'minor',
    file: String(f.file ?? ''),
    line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
    title: String(f.title ?? ''),
    detail: String(f.detail ?? ''),
    suggestion: String(f.suggestion ?? ''),
  }));
  return {
    summary: v.summary,
    score: clampScore(v.score),
    scoreRationale: String(v.scoreRationale ?? ''),
    dimensions,
    findings,
  };
}

/** Index just past the `}` that closes the object opening at `start`, or -1. Skips braces inside strings. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The verdict object in a free-text reply, for harnesses that can't enforce the schema. Models wrap JSON in
 * prose or code fences and sometimes print a draft first, so this takes the last top-level object that has
 * `summary` and `dimensions`, falling back to the last one that parses so `parseVerdict` can say what is missing.
 */
export function findVerdictJson(text: string): unknown {
  let verdict: unknown;
  let fallback: unknown;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    if (value && typeof value === 'object' && 'summary' in value && 'dimensions' in value) verdict = value;
    else fallback = value;
    // Objects nested in this one are part of it, not separate answers.
    start = end - 1;
  }
  if (verdict === undefined && fallback === undefined) throw new Error('no JSON object in the reply');
  return verdict ?? fallback;
}

/**
 * Merge confidence after hard caps, so a model cannot report 5/5 alongside a critical finding:
 * critical caps at 2, major at 3, and the overall can be at most one above the weakest dimension.
 */
export function finalScore(v: Verdict): number {
  let score = v.score;
  if (v.findings.some((f) => f.severity === 'critical')) score = Math.min(score, 2);
  else if (v.findings.some((f) => f.severity === 'major')) score = Math.min(score, 3);
  const weakest = Math.min(...DIMENSIONS.map((d) => v.dimensions[d].score));
  return clampScore(Math.min(score, weakest + 1));
}

export interface MergedFinding extends Finding {
  reviewers: string[];
}

/** Collapses findings that several reviewers reported on the same spot (same file, lines within 3). */
export function mergeFindings(byReviewer: { reviewer: string; findings: Finding[] }[]): MergedFinding[] {
  const merged: MergedFinding[] = [];
  for (const { reviewer, findings } of byReviewer) {
    for (const f of findings) {
      const match = merged.find(
        (m) =>
          m.file === f.file &&
          !m.reviewers.includes(reviewer) &&
          (m.line === f.line || (m.line !== null && f.line !== null && Math.abs(m.line - f.line) <= 3)),
      );
      if (!match) {
        merged.push({ ...f, reviewers: [reviewer] });
        continue;
      }
      match.reviewers.push(reviewer);
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(match.severity)) match.severity = f.severity;
    }
  }
  return merged.toSorted(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}
