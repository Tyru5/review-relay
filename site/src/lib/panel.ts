/** The illustrative panel shown on the landing page: a fictional repo, three configured agents, the real scoring rules. */

export type Severity = 'minor' | 'major' | 'critical';

export const PR = { repo: 'acme/billing', number: 482, title: 'Retry failed invoice webhooks', commit: '9f3c2a1' };

export const JUDGES = ['Agent A', 'Agent B', 'Agent C'] as const;
export type Judge = (typeof JUDGES)[number];

/** Each judge's own overall call before code applies caps. */
const CALLED: Record<Judge, number> = { 'Agent A': 5, 'Agent B': 4, 'Agent C': 5 };

export const DIMENSIONS: [string, Record<Judge, number>][] = [
  ['Correctness', { 'Agent A': 5, 'Agent B': 4, 'Agent C': 5 }],
  ['Security', { 'Agent A': 5, 'Agent B': 5, 'Agent C': 5 }],
  ['Code quality', { 'Agent A': 4, 'Agent B': 4, 'Agent C': 5 }],
  ['Standards', { 'Agent A': 5, 'Agent B': 4, 'Agent C': 4 }],
  ['Blast radius', { 'Agent A': 4, 'Agent B': 4, 'Agent C': 4 }],
  ['Testing', { 'Agent A': 5, 'Agent B': 3, 'Agent C': 4 }],
];

export type Finding = { file: string; title: string; by: Judge[]; severity: Severity };

export function findings(retrySeverity: Severity): Finding[] {
  return [
    {
      file: 'src/invoices/retry.ts:57',
      title: 'Retry loop has no cap on total delay',
      by: ['Agent A', 'Agent B'],
      severity: retrySeverity,
    },
    {
      file: 'src/invoices/retry.test.ts',
      title: 'No test for the exhausted-retries path',
      by: ['Agent B'],
      severity: 'minor',
    },
  ];
}

const SEVERITY_CAP: Record<Severity, number> = { minor: 5, major: 3, critical: 2 };

export type Verdict = { judge: Judge; score: number; capped: boolean };

/** Caps from review-relay's rubric: a critical finding limits a judge to 2, a major one to 3, and the score can be at most one above the weakest dimension. */
export function verdicts(retrySeverity: Severity): Verdict[] {
  const list = findings(retrySeverity);
  return JUDGES.map((judge) => {
    const weakest = Math.min(...DIMENSIONS.map(([, scores]) => scores[judge]));
    const findingCap = Math.min(5, ...list.filter((f) => f.by.includes(judge)).map((f) => SEVERITY_CAP[f.severity]));
    const score = Math.min(CALLED[judge], findingCap, weakest + 1);
    return { judge, score, capped: score < CALLED[judge] };
  });
}

/** The headline is the lowest score on the panel. */
export function headline(list: Verdict[]) {
  return Math.min(...list.map((v) => v.score));
}
