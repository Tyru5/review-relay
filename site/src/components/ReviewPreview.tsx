import { Logo } from './Logo';

const DIMENSIONS = [
  ['Correctness', 4, 4],
  ['Security', 5, 5],
  ['Code quality', 4, 5],
  ['Standards', 4, 4],
  ['Blast radius', 3, 4],
  ['Testing', 4, 5],
] as const;

const FINDINGS = [
  { file: 'src/invoices/retry.ts:57', title: 'Retry loop has no cap on total delay', by: 'Codex, Claude' },
  { file: 'src/invoices/retry.test.ts', title: 'No test for the exhausted-retries path', by: 'Claude' },
];

const SCORE = 4;
const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

/** A sample of the comment review-relay posts, played as one sequence on load. */
export function ReviewPreview() {
  return (
    <figure
      aria-label="Example review-relay comment on a pull request"
      className="rounded-2xl border border-line bg-surface/90 p-5 shadow-[0_30px_80px_-40px_rgb(0_0_0/0.9)] backdrop-blur-sm sm:p-6"
    >
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="truncate font-medium">Retry failed invoice webhooks</span>
        <span className="shrink-0 font-mono text-xs text-muted">acme/billing #482</span>
      </div>

      <div className="relative mt-5 pl-7">
        <div
          aria-hidden
          className="relay-draw absolute top-2.5 bottom-6 left-[5px] w-0.5 bg-relay/60"
          style={delay(300)}
        />

        <div className="relay-rise relative flex items-center gap-3 text-sm" style={delay(0)}>
          <span aria-hidden className="relay-pulse absolute -left-7 size-3 rounded-full bg-relay" />
          <span className="font-medium">Greptile Review</span>
          <span className="text-muted">started</span>
        </div>

        <div className="relay-rise relative mt-5 rounded-xl border border-line bg-night/70" style={delay(800)}>
          <span aria-hidden className="absolute top-4 -left-7 size-3 rounded-full bg-go" />
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
            <Logo className="size-5" />
            <span className="font-semibold">review-relay</span>
            <span className="text-muted">commented</span>
          </div>

          <div className="px-4 py-4">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <p className="text-[2.6rem] leading-none font-extrabold tracking-tight text-go">
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
                      style={delay(1100 + i * 90)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">Lowest of Codex 4/5 and Claude 5/5 on commit 9f3c2a1e.</p>

            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-1.5 font-medium">Dimension</th>
                  <th className="w-16 pb-1.5 text-right font-medium">Codex</th>
                  <th className="w-16 pb-1.5 text-right font-medium">Claude</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[0.8rem]">
                {DIMENSIONS.map(([label, codex, claude]) => (
                  <tr key={label} className="border-t border-line/70">
                    <td className="py-1.5 font-sans text-sm">{label}</td>
                    <td className={`py-1.5 text-right ${codex <= 3 ? 'text-score' : ''}`}>{codex}</td>
                    <td className={`py-1.5 text-right ${claude <= 3 ? 'text-score' : ''}`}>{claude}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-4 text-sm font-semibold">Findings (2)</p>
            <ul className="mt-2 space-y-2.5 text-sm">
              {FINDINGS.map((f) => (
                <li key={f.file} className="flex gap-2.5">
                  <span className="mt-0.5 h-fit shrink-0 rounded border border-score/40 px-1.5 text-xs font-medium text-score">
                    Minor
                  </span>
                  <span className="min-w-0">
                    <code className="font-mono text-[0.78rem] break-all text-relay">{f.file}</code>
                    <span className="block text-ink/90">
                      {f.title} <span className="text-muted">({f.by})</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </figure>
  );
}
