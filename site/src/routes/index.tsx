import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { GitHubMark } from '../components/GitHubMark';
import { JudgesDesk, ResultBoard } from '../components/JudgesPanel';
import { Logo } from '../components/Logo';
import { CheckIcon, LowerThird } from '../components/LowerThird';
import { Scoresheet } from '../components/Scoresheet';
import { checksumsUrl, getLatestVersion, INSTALL_PS1, INSTALL_SH, REPO } from '../lib/downloads';

export const Route = createFileRoute('/')({
  loader: () => getLatestVersion(),
  // Vercel's CDN serves the page and refreshes the release version in the background.
  headers: () => ({ 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' }),
  component: Home,
});

const EVENTS: { title: string; body: ReactNode }[] = [
  {
    title: 'A review starts',
    body: (
      <>
        Greptile&rsquo;s check run begins, a pull request is opened or marked ready, or a collaborator comments{' '}
        <Code>@review-relay</Code>. Each repo picks its trigger: <Code>auto</Code>, <Code>greptile</Code>, or{' '}
        <Code>github</Code>.
      </>
    ),
  },
  {
    title: 'The commit is checked out locally',
    body: 'review-relay fetches the PR head into a temporary worktree of your own clone, so the panel reads real code using your own agent logins and keys.',
  },
  {
    title: 'The panel reviews in parallel',
    body: "Every agent on your panel reviews against the same rubric: your repo's conventions, lint config, and the callers of changed code. Each CLI runs headless and read-only, locked down by its own flags rather than by the prompt, and config files a PR could use to run code through it are removed from the worktree first.",
  },
  {
    title: 'One scored comment lands',
    body: 'Findings are merged across judges and linked to exact lines. Later reviews edit the same comment. Each commit is reviewed once, and drafts wait until they are ready.',
  },
];

/** The agent CLIs review-relay can seat, with the name each takes in `reviewers`. Defaults first, then alphabetical, as setup lists them. */
const AGENTS: { name: string; product: string }[] = [
  { name: 'claude', product: 'Claude Code' },
  { name: 'codex', product: 'Codex CLI' },
  { name: 'auggie', product: 'Augment Auggie' },
  { name: 'copilot', product: 'GitHub Copilot CLI' },
  { name: 'droid', product: 'Factory Droid' },
  { name: 'gemini', product: 'Gemini CLI' },
  { name: 'grok', product: 'Grok Build' },
  { name: 'hermes', product: 'Hermes Agent' },
  { name: 'kilo', product: 'Kilo Code CLI' },
  { name: 'opencode', product: 'opencode' },
  { name: 'pi', product: 'pi' },
  { name: 'qwen', product: 'Qwen Code' },
  { name: 'vibe', product: 'Mistral Vibe' },
];

const CONTAINER = 'mx-auto w-full max-w-[84rem] px-5 sm:px-8';

function Home() {
  const version = Route.useLoaderData();

  return (
    <>
      <section className="flex min-h-svh flex-col">
        <header className={`${CONTAINER} flex items-center justify-between pt-5`}>
          <a
            href="/"
            className="flex items-center gap-2.5 bg-board py-2 pr-4 pl-3 text-lg font-extrabold [font-stretch:85%]"
          >
            <Logo className="size-7" cue="var(--color-haze)" check="var(--color-gold)" />
            review-relay
          </a>
          <div className="flex items-center gap-2">
            {version && <span className="bg-board px-3 py-2 font-mono text-xs text-haze">v{version}</span>}
            <a
              href={REPO}
              className="flex items-center gap-2 bg-board px-3 py-2 text-xs font-bold text-haze transition-colors hover:text-chalk"
              aria-label="review-relay on GitHub"
            >
              <GitHubMark className="size-5" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </header>

        <main
          className={`${CONTAINER} grid flex-1 content-center gap-x-12 gap-y-6 pt-6 pb-10 sm:gap-y-9 sm:pt-8 lg:grid-cols-[minmax(0,1fr)_22rem]`}
        >
          <h1 className="type-broadcast text-[clamp(3.1rem,6.4vw,5.25rem)] text-balance">
            <span className="block">Your agents judge every pull request.</span>
            <span className="block text-gold">The lowest score counts.</span>
          </h1>
          <p className="max-w-[34rem] self-end text-lg leading-relaxed text-pretty text-haze">
            Seat Claude Code, Codex, Gemini CLI, Copilot, or any of {AGENTS.length} supported agent CLIs, as many as you
            like. <span className="whitespace-nowrap text-chalk">review-relay</span> starts them on your machine the
            moment a review begins on GitHub, then posts one comment with their findings and a{' '}
            <span className="whitespace-nowrap">1&ndash;5</span> merge confidence score.
          </p>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <JudgesDesk />
          </div>
          <div className="max-lg:order-last lg:col-start-2 lg:row-start-2 lg:self-end">
            <ResultBoard />
          </div>
          <div id="install" className="min-w-0 lg:col-span-2 lg:row-start-3">
            <LowerThird id="hero-install" />
            <p className="mt-3 text-sm text-haze">
              Installs a standalone binary and verifies its checksum. Run it again to update.
            </p>
          </div>
        </main>
      </section>

      <section className="border-t-2 border-rule py-24">
        <div className={CONTAINER}>
          <Scoresheet />
        </div>
      </section>

      <section className="bg-arena-deep py-24">
        <div className={CONTAINER}>
          <div className="grid items-end gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
            <h2 className="type-broadcast text-[clamp(2.75rem,5.5vw,4.25rem)]">Order of events</h2>
            <p className="leading-relaxed text-haze">
              Nothing to click. The panel convenes on its own, and GitHub events reach your machine through{' '}
              <Code>gh webhook forward</Code>, so there is no public URL to host.
            </p>
          </div>
          <ol className="mt-14 space-y-2">
            {EVENTS.map((event, i) => {
              const lands = i === EVENTS.length - 1;
              return (
                <li
                  key={event.title}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] bg-arena sm:grid-cols-[6.5rem_minmax(0,1fr)]"
                >
                  <span
                    aria-hidden
                    className={`type-led grid place-items-center text-[3rem] sm:text-[4rem] ${lands ? 'bg-gold text-navy' : 'bg-board text-haze'}`}
                  >
                    {i + 1}
                  </span>
                  <div className="grid gap-x-10 gap-y-2 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                    <h3 className="type-broadcast text-[1.9rem] text-balance">{event.title}</h3>
                    <p className="max-w-[62ch] leading-relaxed text-haze lg:pt-1">{event.body}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="on-paper bg-paper py-24 text-navy">
        <div className={`${CONTAINER} grid gap-x-14 gap-y-10 lg:grid-cols-[19rem_minmax(0,1fr)]`}>
          <div>
            <h2 className="type-broadcast text-[clamp(2.75rem,5.5vw,4.25rem)] text-balance">Before the panel sits</h2>
            <p className="mt-4 leading-relaxed text-slate">
              review-relay drives tools you already use. Have these signed in first.
            </p>
          </div>
          <div className="min-w-0 max-w-[44rem]">
            <ul className="divide-y divide-paper-rule border-y border-paper-rule">
              <Requirement>
                <Code tone="paper">gh</Code> signed in with access to the repos you watch, plus its webhook extension:
                <Terminal lines={['gh extension install cli/gh-webhook']} />
              </Requirement>
              <Requirement>
                At least one of these agent CLIs, signed in or set up with an API key. Claude Code and Codex are the
                defaults.
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Supported agent CLIs">
                  {AGENTS.map((a) => (
                    <li
                      key={a.name}
                      className="flex items-baseline gap-1.5 border border-paper-rule px-2 py-1 text-[0.8rem] leading-none"
                    >
                      {a.product}
                      <code className="font-mono text-[0.7rem] text-slate">{a.name}</code>
                    </li>
                  ))}
                </ul>
              </Requirement>
              <Requirement>A local clone of each repo you want reviewed</Requirement>
            </ul>
            <p className="mt-10 leading-relaxed">
              <Code tone="paper">setup</Code> finds the GitHub clones under your home folder so you can pick the repos
              to watch, then lists the agent CLIs on your PATH so you can pick your panel and each judge&rsquo;s model
              and effort. It writes <Code tone="paper">~/.review-relay/config.json</Code>, and{' '}
              <Code tone="paper">start</Code> keeps watching:
            </p>
            <Terminal lines={['review-relay setup', 'review-relay start -d', 'review-relay status']} />
            <p className="mt-8 border-t border-paper-rule pt-5 text-sm leading-relaxed text-slate">
              Reviews run from your machine, and your code goes to whichever providers your chosen agents and models
              use.
            </p>
          </div>
        </div>
      </section>

      <section className="on-paper bg-gold py-20 text-navy">
        <div className={CONTAINER}>
          <h2 className="type-broadcast text-[clamp(3.25rem,9vw,6rem)]">Seat your panel.</h2>
          <p className="mt-4 max-w-[40rem] text-lg leading-relaxed">
            Free to use. One command installs a standalone binary for macOS, Linux, or Windows.
          </p>
          <div className="mt-9">
            <LowerThird id="close-install" tone="gold" />
          </div>
        </div>
      </section>

      <footer className="bg-board">
        <div className={`${CONTAINER} flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-haze`}>
          <span className="flex items-center gap-2 font-bold [font-stretch:85%] text-chalk">
            <Logo className="size-5" cue="var(--color-haze)" check="var(--color-gold)" />
            review-relay
          </span>
          <nav aria-label="Project links" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              href={REPO}
              className="flex items-center gap-2 text-chalk transition-colors hover:text-gold"
              aria-label="review-relay source on GitHub"
            >
              <GitHubMark className="size-5" />
              <span className="font-bold">GitHub</span>
            </a>
            <FooterLink href={INSTALL_SH}>install.sh</FooterLink>
            <FooterLink href={INSTALL_PS1}>install.ps1</FooterLink>
            {version && <FooterLink href={checksumsUrl(version)}>Checksums for v{version}</FooterLink>}
          </nav>
        </div>
      </footer>
    </>
  );
}

function Code({ children, tone = 'arena' }: { children: ReactNode; tone?: 'arena' | 'paper' }) {
  return <code className={`font-mono text-[0.86em] ${tone === 'paper' ? 'text-navy' : 'text-chalk'}`}>{children}</code>;
}

/** Terminal lines with a non-selectable prompt, so copying a selection yields runnable commands. */
function Terminal({ lines }: { lines: string[] }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-md bg-navy px-4 py-3 font-mono text-[0.84rem] leading-relaxed text-chalk">
      {lines.map((line) => (
        <span key={line} className="block">
          <span className="text-haze select-none">$ </span>
          {line}
        </span>
      ))}
    </pre>
  );
}

function Requirement({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 py-4 leading-relaxed">
      <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-navy text-paper">
        <CheckIcon className="size-3" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="underline decoration-rule underline-offset-4 transition-colors hover:text-chalk hover:decoration-haze"
    >
      {children}
    </a>
  );
}
