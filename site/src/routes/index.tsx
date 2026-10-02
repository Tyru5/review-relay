import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Install } from '../components/Install';
import { Logo } from '../components/Logo';
import { ReviewPreview } from '../components/ReviewPreview';
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
    body: 'review-relay fetches the PR head into a temporary worktree of your own clone, so reviews run against real code with your own codex and claude logins.',
  },
  {
    title: 'Codex and Claude review in parallel',
    body: "Both run read-only against the same rubric, reading your repo's own conventions, lint config, and the callers of changed code.",
  },
  {
    title: 'One scored comment lands on the PR',
    body: 'Findings are merged across reviewers and linked to exact lines. The headline is the lower of the two scores, and later reviews edit the same comment.',
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
        {version && (
          <a
            href={`${DOWNLOADS}/v${version}/SHA256SUMS`}
            className="font-mono text-xs text-muted transition-colors hover:text-ink"
          >
            v{version}
          </a>
        )}
      </header>

      <main>
        <section className="grid items-center gap-12 pt-10 pb-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:pt-16">
          <div className="min-w-0">
            <h1 className="max-w-xl text-[2.5rem] leading-[1.05] font-extrabold tracking-tight text-balance sm:text-6xl">
              Codex and Claude review every pull request, from your machine.
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-muted">
              review-relay starts both reviewers the moment a review begins on GitHub, then posts one comment with their
              findings and a 1-5 merge confidence score.
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

        <Section title="How a review runs">
          <ol className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line font-mono text-sm text-relay">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="mt-1.5 leading-relaxed text-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Before you start">
          <div className="grid gap-10 lg:grid-cols-2">
            <ul className="space-y-4 leading-relaxed">
              <Requirement>
                <code className="font-mono text-[0.9em]">gh</code> signed in with access to the repos you watch, plus
                its webhook extension: <Command>gh extension install cli/gh-webhook</Command>
              </Requirement>
              <Requirement>
                The <code className="font-mono text-[0.9em]">codex</code> and{' '}
                <code className="font-mono text-[0.9em]">claude</code> CLIs, signed in
              </Requirement>
              <Requirement>A local clone of each repo you want reviewed</Requirement>
            </ul>
            <div>
              <p className="leading-relaxed text-muted">
                The installer writes an example config to{' '}
                <code className="font-mono text-[0.9em] text-ink">~/.review-relay/config.json</code>. Point it at your
                repos and local clones, then start watching:
              </p>
              <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface/90 px-4 py-3 font-mono text-[0.84rem] leading-relaxed">
                <span className="text-muted select-none">$ </span>review-relay start{'\n'}
                <span className="text-muted select-none">$ </span>review-relay status
              </pre>
            </div>
          </div>
        </Section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line py-8 text-sm text-muted">
        <span className="flex items-center gap-2">
          <Logo className="size-5" />
          review-relay
        </span>
        <nav aria-label="Downloads" className="flex gap-6">
          <a href={`${DOWNLOADS}/install.sh`} className="transition-colors hover:text-ink">
            install.sh
          </a>
          <a href={`${DOWNLOADS}/install.ps1`} className="transition-colors hover:text-ink">
            install.ps1
          </a>
          {version && (
            <a href={`${DOWNLOADS}/v${version}/SHA256SUMS`} className="transition-colors hover:text-ink">
              Checksums for v{version}
            </a>
          )}
        </nav>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-20">
      <h2 className="mb-10 text-3xl font-extrabold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Requirement({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-go" />
      <span>{children}</span>
    </li>
  );
}

function Command({ children }: { children: ReactNode }) {
  return (
    <code className="mt-2 block w-fit max-w-full overflow-x-auto rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-[0.84rem] whitespace-nowrap">
      {children}
    </code>
  );
}
