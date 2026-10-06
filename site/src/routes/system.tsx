import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CommandBlock, InlineCode } from '../components/Code';
import { Install } from '../components/Install';
import { Logo } from '../components/Logo';
import { ReviewPreview } from '../components/ReviewPreview';
import { Timeline, TimelineDot, type Signal } from '../components/Timeline';

// Dev only: production builds answer 404 here and the page itself is compiled out.
export const Route = createFileRoute('/system')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  head: () => ({ meta: [{ title: 'review-relay design system' }, { name: 'robots', content: 'noindex' }] }),
  component: import.meta.env.DEV ? SystemPage : () => null,
});

const COLORS = [
  { token: 'night', hex: '#0d0f1c', className: 'bg-night', role: 'Page ground. The dark the night shift works in.' },
  {
    token: 'surface',
    hex: '#14172b',
    className: 'bg-surface',
    role: 'First tonal step: comment card, install box, code.',
  },
  {
    token: 'raised',
    hex: '#1b1f38',
    className: 'bg-raised',
    role: 'Second step: selected tab, pressed and hovered controls.',
  },
  { token: 'line', hex: '#262b4a', className: 'bg-line', role: 'Hairlines, dividers, quiet rail, idle borders.' },
  { token: 'ink', hex: '#eceef8', className: 'bg-ink', role: 'Headlines, body emphasis, command text.' },
  { token: 'muted', hex: '#9398ba', className: 'bg-muted', role: 'Supporting copy, metadata, prompts, labels.' },
  {
    token: 'relay',
    hex: '#38d3f6',
    className: 'bg-relay',
    role: 'Signal: in flight. Triggers, steps under way, focus.',
  },
  { token: 'go', hex: '#3deb8e', className: 'bg-go', role: 'Signal: landed. Verdicts and completed actions only.' },
  { token: 'flag', hex: '#b3a6f7', className: 'bg-flag', role: 'Signal: needs attention. Findings and weak scores.' },
];

const SIGNALS: { signal: Signal; label: string }[] = [
  { signal: 'quiet', label: 'Not yet happening' },
  { signal: 'relay', label: 'In flight' },
  { signal: 'go', label: 'Landed' },
];

function SystemPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6">
        <Link to="/" className="site-brand flex shrink-0 items-center gap-2.5 text-lg font-extrabold tracking-tight">
          <Logo className="size-8" />
          review-relay
        </Link>
        <span className="text-right text-xs text-muted">Dev only. Not served on reviewrelay.dev.</span>
      </header>

      <div className="pt-10 pb-16">
        <h1 className="text-5xl font-extrabold tracking-tight">The Night Shift</h1>
        <p className="mt-4 max-w-[60ch] text-lg leading-relaxed text-muted">
          A calm dark workspace where reviews happen while you are away. Surfaces stay quiet; light appears only when
          something lands. The source of truth is <InlineCode>DESIGN.md</InlineCode> at the repo root.
        </p>
      </div>

      <Block title="Colors" note="Three neutrals step up in tone; three signals carry meaning and nothing else.">
        <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {COLORS.map((c) => (
            <li key={c.token} className="bg-night p-4">
              <div className={`h-14 rounded-lg border border-line ${c.className}`} />
              <p className="mt-3 flex items-baseline justify-between gap-3">
                <span className="font-semibold">{c.token}</span>
                <span className="font-mono text-xs text-muted">{c.hex}</span>
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{c.role}</p>
            </li>
          ))}
        </ul>
      </Block>

      <Block
        title="Typography"
        note="Schibsted Grotesk for every voice; JetBrains Mono only for code, paths, and numbers."
      >
        <div className="space-y-8">
          <Specimen label="Display, 800, 60px / 1.05, -0.025em">
            <p className="text-6xl leading-[1.05] font-extrabold tracking-tight">Every pull request</p>
          </Specimen>
          <Specimen label="Headline, 800, 30px">
            <p className="text-3xl font-extrabold tracking-tight">How a review runs</p>
          </Specimen>
          <Specimen label="Title, 600, 16px">
            <p className="font-semibold">One scored comment lands on the PR</p>
          </Specimen>
          <Specimen label="Lede, 400, 18px / 1.625, muted">
            <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
              review-relay starts your agents the moment a review begins on GitHub.
            </p>
          </Specimen>
          <Specimen label="Body, 400, 16px / 1.625">
            <p className="max-w-[60ch] leading-relaxed">
              Every agent reviews against the same rubric, reading your repo's own conventions.
            </p>
          </Specimen>
          <Specimen label="Small and caption, 400, 14px / 12px, muted">
            <p className="text-sm text-muted">Installs a standalone binary and verifies its checksum.</p>
            <p className="mt-1 text-xs text-muted">Example review on a fictional repo.</p>
          </Specimen>
          <Specimen label="Mono, JetBrains Mono, 13px">
            <p className="font-mono text-[0.8rem]">src/invoices/retry.ts:57 4/5 v0.1.0</p>
          </Specimen>
        </div>
      </Block>

      <Block title="Signals" note="A dot on a rail. The rail is quiet until something is in flight.">
        <div className="grid gap-10 sm:grid-cols-2">
          <Timeline>
            <ul className="space-y-5">
              {SIGNALS.map((s) => (
                <li key={s.signal} className="relative">
                  <TimelineDot signal={s.signal} className="top-1" />
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-2 font-mono text-xs text-muted">{s.signal}</span>
                </li>
              ))}
            </ul>
          </Timeline>
          <div className="space-y-3 text-sm">
            <p>
              <span className="text-go">4</span>
              <span className="text-muted">/5</span> verdict, completed action
            </p>
            <p>
              <span className="rounded border border-flag/40 px-1.5 text-xs font-medium text-flag">Minor</span> finding
            </p>
            <p className="text-muted">
              Weak dimension score in a table: <span className="font-mono text-flag">3</span>
            </p>
          </div>
        </div>
      </Block>

      <Block title="Surfaces" note="Depth is a tonal step plus a hairline. No shadows, no blur, no glow.">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['night', 'bg-night', 'Ground'],
            ['surface', 'bg-surface', 'Cards, panels, code'],
            ['raised', 'bg-raised', 'Selected and hovered controls'],
          ].map(([token, bg, use]) => (
            <div key={token} className={`rounded-xl border border-line p-5 ${bg}`}>
              <p className="font-semibold">{token}</p>
              <p className="mt-1 text-sm text-muted">{use}</p>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Components" note="The pieces the landing page is built from, live.">
        <div className="space-y-12">
          <Specimen label="Install (tabs, command, copy)">
            <div className="max-w-[38rem]">
              <Install />
            </div>
          </Specimen>
          <Specimen label="Command block">
            <div className="max-w-[38rem]">
              <CommandBlock lines={['review-relay start', 'review-relay status']} />
            </div>
          </Specimen>
          <Specimen label="Inline code">
            <p>
              Edit <InlineCode>~/.review-relay/config.json</InlineCode> and run{' '}
              <InlineCode>review-relay start</InlineCode>.
            </p>
          </Specimen>
          <Specimen label="Review preview (signature, plays once on load)">
            <div className="max-w-[27rem] pt-6">
              <ReviewPreview />
            </div>
          </Specimen>
        </div>
      </Block>
    </div>
  );
}

function Block({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-16 gap-y-8 border-t border-line py-16 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div>
        <h2 className="text-2xl font-extrabold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs text-muted">{label}</p>
      {children}
    </div>
  );
}
