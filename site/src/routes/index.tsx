import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CommandBlock, InlineCode } from '../components/Code';
import { Install } from '../components/Install';
import { Logo } from '../components/Logo';
import { ReviewPreview } from '../components/ReviewPreview';
import { Timeline, TimelineDot } from '../components/Timeline';
import { DOWNLOADS, getLatestVersion } from '../lib/downloads';

export const Route = createFileRoute('/')({
  loader: () => getLatestVersion(),
  // Vercel's CDN serves the page and refreshes the release version in the background.
  headers: () => ({ 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' }),
  component: Home,
});

const STEPS = [
  {
    title: 'A review starts',
    body: "Greptile's check run begins, a pull request is opened or marked ready, or a collaborator comments @review-relay.",
  },
  {
    title: 'The commit is checked out locally',
    body: 'review-relay fetches the PR head into a temporary worktree of your own clone, so reviews run against real code with your own agent logins and keys.',
  },
  {
    title: 'Your agents review in parallel',
    body: "Every agent you configured, whichever harness or model it runs on, reviews against the same rubric, reading your repo's own conventions, lint config, and the callers of changed code.",
  },
  {
    title: 'One scored comment lands on the PR',
    body: 'Findings are merged across reviewers and linked to exact lines. The headline is the lowest score among your reviewers, and later reviews edit the same comment.',
  },
];

function Home() {
  const version = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <a href="/" className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight">
          <Logo className="size-8" />
          review-relay
        </a>
        {version && <span className="font-mono text-xs text-muted">v{version}</span>}
      </header>

      <main>
        <section className="grid items-center gap-x-12 gap-y-16 pt-10 pb-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:pt-16">
          <div className="min-w-0">
            <h1 className="max-w-xl text-[2.5rem] leading-[1.05] font-extrabold tracking-tight text-balance sm:text-6xl">
              Your coding agents review every pull request, from your machine.
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-pretty text-muted">
              Pick any agentic CLI or model, as many as you like.{' '}
              <span className="whitespace-nowrap">review-relay</span> starts them the moment a review begins on GitHub,
              then posts one comment with their findings and a 1-5 merge confidence score.
            </p>
            <div className="mt-9 max-w-[38rem]">
              <Install />
              <p className="mt-3 text-sm text-muted">
                Installs a standalone binary and verifies its checksum. Run it again to update.
              </p>
            </div>
          </div>
          <div className="min-w-0">
            <ReviewPreview />
          </div>
        </section>

        <Section title="How a review runs" lede="Nothing to click. The review shows up on the pull request by itself.">
          <Timeline>
            <ol className="space-y-9">
              {STEPS.map((step, i) => (
                <li key={step.title} className="relative">
                  <TimelineDot signal={i === STEPS.length - 1 ? 'go' : 'relay'} className="top-1.5" />
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="mt-1.5 max-w-[60ch] leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </Timeline>
        </Section>

        <Section title="Before you start" lede="review-relay drives tools you already use. Have these signed in first.">
          <ul className="max-w-[60ch] divide-y divide-line border-y border-line">
            <Requirement>
              <InlineCode>gh</InlineCode> signed in with access to the repos you watch, plus its webhook extension:
              <code className="mt-2 block w-fit max-w-full overflow-x-auto font-mono text-[0.84rem] whitespace-nowrap text-ink">
                <span className="text-muted select-none">$ </span>gh extension install cli/gh-webhook
              </code>
            </Requirement>
            <Requirement>
              The coding agents or models you want reviewing, signed in or set up with an API key
            </Requirement>
            <Requirement>A local clone of each repo you want reviewed</Requirement>
          </ul>
          <p className="mt-10 max-w-[60ch] leading-relaxed text-muted">
            The installer writes an example config to <InlineCode>~/.review-relay/config.json</InlineCode>. Point it at
            your repos and local clones, list the agents you want reviewing, then start watching:
          </p>
          <div className="mt-4 max-w-[60ch]">
            <CommandBlock lines={['review-relay start', 'review-relay status']} />
          </div>
        </Section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line py-8 text-sm text-muted">
        <span className="flex items-center gap-2">
          <Logo className="size-5" />
          review-relay
        </span>
        <nav aria-label="Downloads" className="flex flex-wrap gap-x-6 gap-y-2">
          <FooterLink href={`${DOWNLOADS}/install.sh`}>install.sh</FooterLink>
          <FooterLink href={`${DOWNLOADS}/install.ps1`}>install.ps1</FooterLink>
          {version && <FooterLink href={`${DOWNLOADS}/v${version}/SHA256SUMS`}>Checksums for v{version}</FooterLink>}
        </nav>
      </footer>
    </div>
  );
}

/** The ledger: heading and one-line lede on the left, the content on the right. */
function Section({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-16 gap-y-10 border-t border-line py-20 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div>
        <h2 className="text-3xl font-extrabold tracking-tight text-balance">{title}</h2>
        <p className="mt-3 leading-relaxed text-muted">{lede}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Requirement({ children }: { children: ReactNode }) {
  return <li className="py-4 leading-relaxed">{children}</li>;
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="underline decoration-line underline-offset-4 transition-colors hover:text-ink hover:decoration-muted"
    >
      {children}
    </a>
  );
}
