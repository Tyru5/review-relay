import { useState } from 'react';
import { DIMENSIONS, findings, headline, JUDGES, PR, verdicts, type Severity } from '../lib/panel';

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: 'minor', label: 'Minor' },
  { id: 'major', label: 'Major' },
  { id: 'critical', label: 'Critical' },
];

const RULE: Record<Severity, string> = {
  minor: 'A minor finding leaves the score alone.',
  major: 'A major finding limits every judge who reported it to 3/5.',
  critical: 'A critical finding limits every judge who reported it to 2/5.',
};

/** The example scoresheet with a live control for the retry-loop finding's severity, so the caps can be watched working. */
export function Scoresheet() {
  const [severity, setSeverity] = useState<Severity>('minor');
  const panel = verdicts(severity);
  const score = headline(panel);
  const list = findings(severity);

  return (
    <div className="grid gap-x-14 gap-y-10 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <div>
        <h2 className="type-broadcast text-[clamp(2.75rem,5.5vw,4.25rem)] text-balance">The scoresheet</h2>
        <p className="mt-4 leading-relaxed text-pretty text-haze">
          Every judge scores the same six dimensions from 1 to 5. Findings cap the score, so the number never outruns
          the problems. The comment&rsquo;s headline is the lowest judge.
        </p>

        <fieldset className="mt-9">
          <legend className="font-semibold">Set the severity of the retry-loop finding</legend>
          <div className="mt-3 flex border border-rule">
            {SEVERITIES.map((s) => (
              <label
                key={s.id}
                className="type-label flex-1 cursor-pointer px-3 py-2.5 text-center text-[0.8rem] text-haze transition-colors not-last:border-r not-last:border-rule hover:text-chalk has-checked:bg-chalk has-checked:text-navy has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-gold"
              >
                <input
                  type="radio"
                  name="severity"
                  value={s.id}
                  checked={severity === s.id}
                  onChange={() => setSeverity(s.id)}
                  className="sr-only"
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-6 flex items-center gap-5 border-t border-rule pt-6">
          <p className="type-led w-[4.5rem] text-[4.5rem] text-gold" aria-live="polite" aria-atomic>
            <span className="sr-only">Headline score </span>
            {score}
          </p>
          <p className="text-sm leading-relaxed text-haze">{RULE[severity]}</p>
        </div>
      </div>

      <article aria-label="Example scoresheet" className="on-paper min-w-0 rounded-md bg-paper p-5 text-navy sm:p-8">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-2 border-navy pb-3">
          <h3 className="type-broadcast text-[1.9rem]">{PR.title}</h3>
          <p className="font-mono text-xs text-slate">
            {PR.repo} #{PR.number} &middot; {PR.commit}
          </p>
        </header>
        <p className="mt-2 text-xs text-slate">Example review on a fictional repo with three configured agents.</p>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="type-label text-left text-[0.7rem] text-slate">
                <th className="pb-2 font-[inherit]">Dimension</th>
                {JUDGES.map((j) => (
                  <th key={j} className="w-12 pb-2 text-right font-[inherit] sm:w-20">
                    <span className="sm:hidden" aria-hidden>
                      {j.replace('Agent ', '')}
                    </span>
                    <span className="max-sm:sr-only">{j}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-[0.85rem] tabular-nums">
              {DIMENSIONS.map(([label, scores]) => (
                <tr key={label} className="border-t border-paper-rule">
                  <td className="py-2 font-sans text-[0.95rem]">{label}</td>
                  {JUDGES.map((j) => (
                    <td key={j} className={`py-2 text-right ${scores[j] <= 3 ? 'font-bold text-red' : ''}`}>
                      {scores[j]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy">
                <th scope="row" className="pt-3 text-left font-semibold">
                  Merge confidence
                </th>
                {panel.map((v) => (
                  <td key={v.judge} className="pt-3 text-right">
                    <span
                      className={`relative inline-block px-1.5 type-broadcast text-[2.1rem] tabular-nums sm:px-2 sm:text-[2.4rem] ${v.capped ? 'text-red' : ''}`}
                    >
                      {v.score}
                      {v.score === score && (
                        <svg
                          aria-hidden
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                          className="absolute -inset-1 h-[calc(100%+0.5rem)] w-[calc(100%+0.5rem)] overflow-visible"
                        >
                          <path
                            d="M52 6c26 0 42 18 42 44S76 95 50 95 6 76 6 50 24 7 47 7c8 0 15 2 21 6"
                            fill="none"
                            stroke="var(--color-gold-deep)"
                            strokeWidth="3"
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                      )}
                    </span>
                    {v.capped && <span className="block text-[0.7rem] font-semibold text-red">capped</span>}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        <h4 className="type-label mt-8 text-[0.75rem] text-slate">Findings ({list.length})</h4>
        <ul className="mt-3 space-y-3 text-sm">
          {list.map((f) => (
            <li key={f.file} className="flex gap-3">
              <SeverityChip severity={f.severity} />
              <span className="min-w-0">
                <code className="font-mono text-[0.8rem] break-all underline decoration-paper-rule underline-offset-3">
                  {f.file}
                </code>
                <span className="block">
                  {f.title} <span className="text-slate">({f.by.join(', ')})</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}

function SeverityChip({ severity }: { severity: Severity }) {
  const tone =
    severity === 'critical'
      ? 'border-red bg-red text-paper'
      : severity === 'major'
        ? 'border-red text-red'
        : 'border-slate/50 text-slate';
  return (
    <span className={`type-label mt-0.5 h-fit w-[4.75rem] shrink-0 border py-0.5 text-center text-[0.68rem] ${tone}`}>
      {severity}
    </span>
  );
}
