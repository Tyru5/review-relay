import { Logo } from './Logo';
import { Timeline, TimelineDot } from './Timeline';

const REVIEWERS = ['Agent A', 'Agent B', 'Agent C'];
const SCORES = [4, 5, 4];

const DIMENSIONS: [string, number[]][] = [
  ['Correctness', [4, 4, 5]],
  ['Security', [5, 5, 5]],
  ['Code quality', [4, 5, 4]],
  ['Standards', [4, 4, 4]],
  ['Blast radius', [3, 4, 4]],
  ['Testing', [4, 5, 3]],
];

const FINDINGS = [
  { file: 'src/invoices/retry.ts:57', title: 'Retry loop has no cap on total delay', by: 'Agent A, Agent C' },
  { file: 'src/invoices/retry.test.ts', title: 'No test for the exhausted-retries path', by: 'Agent C' },
];

const SCORE = Math.min(...SCORES);
const LANDS_AT = 900;
const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

/** An illustrative review-relay comment, played once on load: a review starts, the relay fires, the verdict lands. */
export function ReviewPreview() {
  return (
    <figure className="relative">
      <div aria-hidden className="dot-canvas absolute -inset-10 -z-10" />

      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="truncate font-medium">Retry failed invoice webhooks</span>
        <span className="shrink-0 font-mono text-xs text-muted">acme/billing #482</span>
      </div>

      <Timeline rail="relay" railClassName="relay-draw" railStyle={delay(250)} className="mt-5">
        <p className="relay-rise relative flex items-center gap-3 text-sm" style={delay(0)}>
          <TimelineDot signal="relay" className="relay-wait" style={delay(150)} />
          <span className="font-medium">Greptile Review</span>
          <span className="text-muted">started</span>
        </p>

        <article
          aria-label="review-relay comment"
          className="relay-rise relative mt-5 rounded-xl border border-line bg-surface"
          style={delay(LANDS_AT)}
        >
          <TimelineDot signal="go" className="top-4" />
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
            <Logo className="size-5" />
            <span className="font-semibold">review-relay</span>
            <span className="text-muted">commented</span>
          </header>

          <div className="px-4 py-4">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <p className="text-[2.6rem] leading-none font-extrabold tracking-tight text-go tabular-nums">
                {SCORE}
                <span className="text-2xl text-muted">/5</span>
              </p>
              <div className="pb-1">
                <p className="text-sm font-semibold">Merge confidence</p>
                <div aria-hidden className="mt-1.5 flex gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <span
                      key={i}
                      className={`h-1.5 w-6 rounded-full ${i <= SCORE ? 'relay-fill bg-go' : 'bg-line'}`}
                      style={delay(LANDS_AT + 250 + i * 90)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">
              Lowest of {REVIEWERS.map((r, i) => `${r} ${SCORES[i]}/5`).join(', ')} on commit 9f3c2a1e.
            </p>

            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-1.5 font-medium">Dimension</th>
                  {REVIEWERS.map((r) => (
                    <th key={r} className="w-14 pb-1.5 text-right font-medium whitespace-nowrap">
                      {r.replace('Agent ', '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono text-[0.8rem] tabular-nums">
                {DIMENSIONS.map(([label, scores]) => (
                  <tr key={label} className="border-t border-line/70">
                    <td className="py-1.5 font-sans text-sm">{label}</td>
                    {scores.map((s, i) => (
                      <td key={REVIEWERS[i]} className={`py-1.5 text-right ${s <= 3 ? 'text-flag' : ''}`}>
                        {s}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-4 text-sm font-semibold">Findings (2)</p>
            <ul className="mt-2 space-y-2.5 text-sm">
              {FINDINGS.map((f) => (
                <li key={f.file} className="flex gap-2.5">
                  <span className="mt-0.5 h-fit shrink-0 rounded border border-flag/40 px-1.5 text-xs font-medium text-flag">
                    Minor
                  </span>
                  <span className="min-w-0">
                    <code className="font-mono text-[0.78rem] break-all underline decoration-line underline-offset-3">
                      {f.file}
                    </code>
                    <span className="block text-ink/90">
                      {f.title} <span className="text-muted">({f.by})</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </article>
      </Timeline>

      <figcaption className="mt-4 pl-7 text-xs text-muted">
        Example review on a fictional repo with three configured agents.
      </figcaption>
    </figure>
  );
}
