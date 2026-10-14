import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Logo } from '../components/Logo';
import { LowerThird } from '../components/LowerThird';
import {
  COMMANDS,
  DOC_SECTIONS,
  ENVIRONMENT,
  GLOBAL_OPTIONS,
  LOCAL_OPTIONS,
  MCP_CONFIG,
  MCP_TOOLS,
  MODEL_OPTIONS,
  QUICK_CONFIG,
  REPO_OPTIONS,
  REVIEWERS,
  ROUTE_CONDITIONS,
  ROUTE_OPTIONS,
  ROUTED_CONFIG,
  TUI_KEYS,
  type ReferenceRow,
} from '../lib/docs';
import docsCss from '../docs.css?url';

const TITLE = 'Documentation | review-relay';
const DESCRIPTION =
  'Install review-relay, configure your reviewers and routing rules, connect your agents over MCP, and understand triggers, scores, costs, and local reports.';

export const Route = createFileRoute('/docs')({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:url', content: 'https://reviewrelay.dev/docs' },
    ],
    links: [
      { rel: 'canonical', href: 'https://reviewrelay.dev/docs' },
      { rel: 'stylesheet', href: docsCss },
    ],
  }),
  component: Docs,
});

function Docs() {
  const [active, setActive] = useState<string>('quick-start');

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const current = [...DOC_SECTIONS]
        .reverse()
        .find(([id]) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= 140);
      setActive(current?.[0] ?? 'quick-start');
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="docs-page">
      <a href="#docs-content" className="docs-skip">
        Skip to documentation
      </a>
      <header className="docs-header">
        <div className="docs-header-inner">
          <Link to="/" className="site-brand docs-brand">
            <Logo className="size-7" cue="var(--color-haze)" check="var(--color-gold)" />
            review-relay
          </Link>
          <nav aria-label="Site navigation">
            <Link to="/">Home</Link>
            <Link to="/docs" viewTransition={false} aria-current="page">
              Docs
            </Link>
          </nav>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-sidebar">
          <nav aria-label="Documentation contents">
            <p className="type-broadcast text-2xl">Documentation</p>
            <ol>
              {DOC_SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`} aria-current={active === id ? 'location' : undefined}>
                    {title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <p className="docs-sidebar-note">
            One config file.
            <br />
            Your agents. Your repos.
          </p>
          <a className="docs-sidebar-link" href="#configuration">
            Find a config option
          </a>
        </aside>

        <main id="docs-content" className="docs-content on-paper" tabIndex={-1}>
          <div className="docs-intro">
            <h1 className="type-broadcast">Put your panel to work.</h1>
            <p>Install the relay, choose your reviewers, and get a scored review on your next pull request.</p>
            <div className="docs-shortcuts">
              <a href="#quick-start">Set up the relay</a>
              <a href="#local">Review before a PR</a>
              <a href="#mcp">Connect an agent</a>
              <a href="#configuration">Config reference</a>
              <a href="#troubleshooting">Something not working?</a>
            </div>
          </div>

          <Section id="quick-start" title="Quick start">
            <p>
              You need Git, the GitHub CLI, a local clone of each watched repo, and at least one supported coding agent.
              Sign in to your agents or configure their API keys before starting.
            </p>
            <h3>1. Connect GitHub</h3>
            <p>
              Your GitHub account needs permission to manage repository webhooks and, when publishing is enabled, write
              PR comments.
            </p>
            <Snippet label="Terminal" code={'gh auth login\ngh extension install cli/gh-webhook\ngh auth status'} />
            <h3>2. Install review-relay</h3>
            <div className="docs-install">
              <LowerThird id="docs-install" />
            </div>
            <p className="docs-small">
              Standalone binaries for macOS and glibc Linux on x64/arm64, and Windows x64. No Bun or Node installation
              required. Alpine/musl is not supported.
            </p>
            <h3>3. Choose your repos and start</h3>
            <Snippet label="Terminal" code={'review-relay setup\nreview-relay start -d\nreview-relay tui'} />
            <p>
              <code>setup</code> finds GitHub clones under your home directory and agent CLIs on your PATH. Choose the
              repos, reviewers, models, and effort. It saves <code>~/.review-relay/config.json</code>. <code>tui</code>{' '}
              shows the jobs live as the daemon runs them; <code>status</code> prints a one-shot summary.
            </p>
            <Note title="Try a local-only review first">
              Set <code>postToPr: false</code> on the repo before running a review. Reports still save locally and the
              agents still use their providers. Replace the example repo and PR below with your own.
            </Note>
            <Snippet label="Review an open PR" code="review-relay run --repo acme/widget --pr 42" />
            <p>
              No pull request yet? Run <code>review-relay review</code> inside the clone to score the checked-out branch
              without GitHub or the daemon. See <a href="#local">Review before a PR</a>.
            </p>
            <p>
              Use <code>start</code> without <code>-d</code> for foreground logs. The machine and daemon must stay
              running to receive events.
            </p>
            <details>
              <summary>Install locations, updates, and pinned versions</summary>
              <p>
                Unix installs to <code>~/.local/bin/review-relay</code>. Add <code>~/.local/bin</code> to your PATH if
                needed. Windows installs to <code>%LOCALAPPDATA%\review-relay\bin</code> and adds it to your user PATH
                by default.
              </p>
              <p>
                Both installers also add <code>rr</code> as a shortcut for <code>review-relay</code>. An existing{' '}
                <code>rr</code> from another tool is left alone.
              </p>
              <p>
                The installers verify the binary’s SHA-256 checksum and preserve an existing config. Run the installer
                again to update, then restart the daemon. To pin a release, pass <code>--version x.y.z</code> to the
                Unix installer, or <code>-Version x.y.z</code> to the PowerShell script.
              </p>
              <p>
                Unix also accepts <code>--bin-dir</code> and <code>--no-alias</code>. PowerShell accepts{' '}
                <code>-BinDir</code>, <code>-NoModifyPath</code>, and <code>-NoAlias</code>. See{' '}
                <a href="#environment">environment variables</a> for equivalent settings.
              </p>
            </details>
          </Section>

          <Section id="configuration" title="Configuration">
            <p>
              Configuration is JSON. The CLI uses <code>--config &lt;path&gt;</code> first, then{' '}
              <code>REVIEW_RELAY_CONFIG</code>, then <code>~/.review-relay/config.json</code>. Restart the daemon after
              editing it.
            </p>
            <Snippet label="~/.review-relay/config.json · example" code={JSON.stringify(QUICK_CONFIG, null, 2)} />
            <p>
              This example watches a fictional repo through GitHub events and keeps reports local. Replace{' '}
              <code>fullName</code> and <code>localPath</code>, then set <code>postToPr</code> to <code>true</code> when
              you want comments.
            </p>
            <h3>Top-level options</h3>
            <Reference rows={GLOBAL_OPTIONS} label="Top-level configuration options" />
            <h3>Repository options</h3>
            <p>
              Each object in <code>repos</code> accepts these settings. Use an absolute path, or <code>~/</code>, so the
              clone resolves consistently.
            </p>
            <Reference rows={REPO_OPTIONS} label="Repository configuration options" />
            <Snippet
              label="Use a different config"
              code={'review-relay info --config ./relay.json\nreview-relay start -d --config ./relay.json'}
            />
            <p>
              Use the same <code>--config</code> for status, stop, and other commands targeting that daemon.{' '}
              <code>info --json</code> and <code>config</code> show resolved values, including defaults.
            </p>
            <details id="environment">
              <summary>Environment variables and installer overrides</summary>
              <Reference rows={ENVIRONMENT} label="Environment variables" />
              <p>Agent authentication belongs to each agent CLI. review-relay does not store API keys in its config.</p>
            </details>
          </Section>

          <Section id="reviewers" title="Reviewers & models">
            <p>
              <code>reviewers</code> names the default panel. Every ID selects a built-in CLI or a custom entry in{' '}
              <code>models</code>. Selected reviewers run in parallel; they do not need to use different CLIs.
            </p>
            <Reference
              label="Supported reviewers"
              headings={['Reviewer ID', 'Product', 'Relay defaults']}
              rows={REVIEWERS.map((reviewer) => [
                reviewer.id,
                reviewer.product,
                'model' in reviewer
                  ? `${reviewer.model}, effort ${reviewer.effort}`
                  : `CLI default model${reviewer.supportsEffort ? '; effort supported' : '; no per-run effort option'}`,
              ])}
            />
            <p>
              The executable normally matches the ID. Kilo also accepts <code>kilocode</code>. Install and authenticate
              each selected CLI separately; review-relay does not install agents.
            </p>
            <h3>Model entry options</h3>
            <Reference rows={MODEL_OPTIONS} label="Model entry options" />
            <p>
              For example, <code>models.codex</code> changes the built-in Codex reviewer. To run two Codex models,
              create two custom IDs with <code>harness: "codex"</code> and put both IDs in <code>reviewers</code>.
            </p>
            <p>
              Custom IDs use up to 32 lowercase letters, digits, and dashes, starting with a letter or digit. Omitted
              settings inherit the harness defaults, not another entry’s overrides. Add or remove custom entries in
              JSON; setup can edit existing entries.
            </p>
            <p>
              Unknown custom-entry fields are errors. Invalid legacy built-in settings may warn and be ignored.
              Unsupported model or effort values can still be rejected by the agent CLI at runtime.
            </p>
          </Section>

          <Section id="routing" title="Routing rules">
            <p>
              Routes choose a panel from the PR’s diff and trigger. The first matching, applicable route wins. If none
              matches, the global <code>reviewers</code> and <code>timeoutMs</code> apply.
            </p>
            <Snippet label="Routed config · example" code={JSON.stringify(ROUTED_CONFIG, null, 2)} />
            <p>
              This example skips documentation-only automatic reviews, sends sensitive changes to a larger panel, and
              sends small changes to Codex. Everything else uses the default panel.
            </p>
            <h3>Route options</h3>
            <Reference rows={ROUTE_OPTIONS} label="Route options" />
            <h3>Match conditions</h3>
            <p>
              All conditions in <code>when</code> must hold. Lists match any listed value or glob. Path globs use
              repository-relative paths and are case-sensitive. Use <code>**</code> to span directories.
            </p>
            <Reference
              rows={ROUTE_CONDITIONS}
              label="Route match conditions"
              headings={['Condition', 'Value', 'Matches when']}
            />
            <Note title="Skip rules have limits">
              Skip routes may use only <code>onlyPaths</code>, <code>repos</code>, <code>baseBranches</code>, and{' '}
              <code>sources</code>. Mentions, manual runs, and local reviews never skip. Changes to recognized agent
              instructions or agent config files also prevent a skip, even when a docs glob matches.
            </Note>
            <p>
              Size conditions exclude recognized lockfiles; path conditions still see them. Binary files count as files
              with zero added or deleted lines. Renames consider both old and new paths.
            </p>
            <h3>Request a named panel</h3>
            <Snippet label="PR comment" code="@review-relay sensitive" />
            <p>
              A trusted commenter can name a non-skip route after the mention. That route runs even if its conditions do
              not match. Unknown names and skip-route names fall back to normal routing.
            </p>
            <p>
              Route names must be unique. Unknown fields, duplicate reviewers, empty conditions, and a minimum above its
              maximum stop config loading.
            </p>
          </Section>

          <Section id="triggers" title="Triggers & review flow">
            <Reference
              label="Trigger modes"
              headings={['Mode', 'Starts on', 'Behavior']}
              rows={[
                [
                  'auto',
                  'Greptile, CodeRabbit, or GitHub',
                  'Default. A Greptile or CodeRabbit start runs immediately. A GitHub PR event waits graceMs, then runs if neither bot has started for that commit.',
                ],
                [
                  'github',
                  'GitHub PR events',
                  'Runs immediately on opened, reopened, and ready_for_review. Add github.onPush: true for synchronize events.',
                ],
                [
                  'greptile',
                  'Greptile check start',
                  'Only the Greptile start triggers automatic reviews. No GitHub fallback.',
                ],
                [
                  'coderabbit',
                  'CodeRabbit review start',
                  'Only the CodeRabbit start triggers automatic reviews. No GitHub fallback.',
                ],
              ]}
            />
            <p>
              Mentions work in every mode. Only new PR comments by an OWNER, MEMBER, or COLLABORATOR qualify. Bot
              comments and ordinary issues do not.
            </p>
            <ol className="docs-flow">
              <li>
                <strong>Receive an event.</strong> Each repo has a temporary webhook forwarded through{' '}
                <code>gh webhook forward</code> to the local signed endpoint. No public relay URL is needed.
              </li>
              <li>
                <strong>Resolve and deduplicate.</strong> The scheduler keys automatic reviews by repository and head
                commit. Completed, skipped, cancelled, queued, and in-progress jobs suppress duplicates. Failed jobs can
                retry on another trigger. At most <code>maxConcurrent</code> reviews run at once; the rest wait as{' '}
                <code>queued</code>.
              </li>
              <li>
                <strong>Check the commit is current.</strong> When a job&rsquo;s turn comes, it runs only if its commit
                is still the PR&rsquo;s head on GitHub, and it stops any review still running on an older commit of that
                PR. Either way the stale job is recorded as <code>superseded</code>.
              </li>
              <li>
                <strong>Choose the route.</strong> Fetch the PR and base branch, inspect the diff, and select reviewers.
                A skip stops before a worktree is created.
              </li>
              <li>
                <strong>Run the panel.</strong> Create a detached worktree, remove executable project-level agent
                config, and run the selected CLIs concurrently against the same rubric.
              </li>
              <li>
                <strong>Save and publish.</strong> Remove the temporary worktree, save reports, and create or update a
                PR comment if enabled. The comment is posted only if the commit is still the PR&rsquo;s head, one post
                per PR at a time, so a slow review of an older commit never replaces a newer one&rsquo;s comment.
              </li>
            </ol>
            <p>
              A <a href="#cancel">cancel</a> stops a job at any of these steps: a queued job never starts, and a running
              one kills its reviewers, removes the worktree, posts nothing, and is recorded as <code>cancelled</code>.
            </p>
            <p>
              GitHub PR events ignore drafts and closed PRs. Explicit mentions and manual runs require an open PR but
              can review a draft. They bypass completed-job deduplication, but not an already-running job in the same
              scheduler.
            </p>
            <p>
              Greptile matching requires app <code>greptile-apps</code>, check name <code>Greptile Review</code>, and a
              created check that is queued or in progress. Completed checks only log a result. Fork checks without an
              associated PR are ignored; use <code>auto</code> for the GitHub fallback.
            </p>
            <p>
              CodeRabbit matching requires a <code>CodeRabbit</code> commit status set by <code>coderabbitai[bot]</code>{' '}
              to <code>pending</code> with <code>Review in progress</code>. <code>Review queued</code> and{' '}
              <code>Review skipped: ...</code> do not start a review. The status names only a commit, so the open,
              non-draft PR whose head is that commit is looked up, forks included. A check run created by the{' '}
              <code>coderabbitai</code> app, other than <code>CodeRabbit Security</code>, also counts, for installs that
              report progress through check runs.
            </p>
            <Note title="One daemon per config">
              Deduplication, the <code>maxConcurrent</code> limit, and the one-post-per-PR lock all live in one process.
              Avoid running a separate manual review while that same commit is already being reviewed by the daemon.
            </Note>
          </Section>

          <Section id="local" title="Review before a PR">
            <p>
              <code>review-relay review</code> scores the branch you have checked out, so you can rate a change before
              opening a pull request. It runs in your own clone, needs no PR, no GitHub access, and no running daemon,
              and posts nothing.
            </p>
            <ul>
              <li>
                <strong>Foreground</strong>, the default, waits for the reviewers and prints the score, findings, and
                dimension notes. Use it in scripts and hooks.
              </li>
              <li>
                <strong>Background</strong>, with <code>-d</code>, returns at once. A background process reviews the
                commit <code>HEAD</code> was at, so you can keep working while it runs. Follow it in{' '}
                <code>review-relay tui</code> or <code>review-relay logs -f</code>.
              </li>
            </ul>
            <Snippet
              label="Score the current branch"
              code={
                'review-relay review\nreview-relay review -d\nreview-relay review --base origin/main --min-score 4\nreview-relay review --reviewers claude,codex --json'
              }
            />
            <ul>
              <li>
                <strong>Same range as the PR.</strong> It reviews the commits on <code>--head</code> (default{' '}
                <code>HEAD</code>) that <code>--base</code> lacks. The base defaults to the remote&rsquo;s default
                branch as the clone recorded it (<code>origin/HEAD</code>), else <code>origin/main</code>.
              </li>
              <li>
                <strong>Same panel and score.</strong> The reviewers, rubric, lockdown, caps, and lowest-score headline
                match a PR review. Linked worktrees work too.
              </li>
              <li>
                <strong>Committed work only.</strong> Uncommitted changes are left out with a warning. Nothing is
                fetched, so run <code>git fetch</code> first for an up-to-date base. Both refs are pinned to commits
                when the review starts.
              </li>
              <li>
                <strong>Any clone.</strong> The repo&rsquo;s config entry applies when one names the clone. Any other
                clone still works, named from its origin remote or its folder.
              </li>
            </ul>
            <Reference rows={LOCAL_OPTIONS} label="review options" headings={['Option', 'Default', 'What it does']} />
            <p>
              Routes pick the reviewers as they would for a PR, with source <code>local</code> and the base&rsquo;s
              branch name (<code>main</code> for <code>origin/main</code>). A skip route never applies, and{' '}
              <code>{'"sources": ["local"]'}</code> sends local reviews to a panel of their own.
            </p>
            <Note title="Gate a push on the score">
              <code>--min-score</code> exits 1 when the confidence is under the threshold, and a review where every
              reviewer failed exits 1 too, so a pre-push hook or script can stop on it. It and <code>--json</code> need
              the foreground. Ctrl-C stops the reviewers, removes the worktree, and records the job as failed;{' '}
              <code>review-relay cancel</code> from the same checkout stops it the same way and records it as{' '}
              <code>cancelled</code>.
            </Note>
            <p>
              Both ways record the job, so <code>status</code> and <code>tui</code> list it with its branch in the PR
              column and <code>local</code> as its source, and save the report under{' '}
              <code>&lt;dataDir&gt;/reports/&lt;owner__repo&gt;/local/&lt;sha8&gt;/</code>. In <code>tui</code>,{' '}
              <code>r</code> reviews the branch&rsquo;s current head again in the background, in the checkout it ran in,
              and <code>c</code> cancels it while it runs. Each local review is its own process, so{' '}
              <code>maxConcurrent</code> does not limit them.
            </p>
          </Section>

          <Section id="mcp" title="Agents & MCP">
            <p>
              <code>review-relay mcp</code> serves review-relay to agents over the{' '}
              <a href="https://modelcontextprotocol.io">Model Context Protocol</a> on stdin and stdout, so an agent can
              score the branch it is working on before it opens a PR, or review a PR, and act on the findings. Register
              it with your agent&rsquo;s client as a stdio server that runs <code>review-relay mcp</code>.
            </p>
            <Snippet
              label="Register the server"
              code={
                'claude mcp add review-relay -- review-relay mcp    # Claude Code\ncodex mcp add review-relay -- review-relay mcp     # Codex'
              }
            />
            <p>
              Other clients take the same command in their MCP config. Add <code>--config &lt;path&gt;</code> to the
              arguments for a config other than the default.
            </p>
            <Snippet label="MCP config · other clients" code={JSON.stringify(MCP_CONFIG, null, 2)} />
            <h3>Tools</h3>
            <Reference rows={MCP_TOOLS} label="MCP tools" headings={['Tool', 'Arguments', 'What it does']} />
            <ul>
              <li>
                <strong>Reviews run in the background.</strong> A review takes minutes, longer than many clients wait
                for one tool call, so the start tools return the job&rsquo;s <code>key</code> at once and a separate
                process runs the review, as <code>review -d</code> does. Until that process records the job, its status
                is <code>starting</code>.
              </li>
              <li>
                <strong>Wait when you want to.</strong> <code>waitSeconds</code>, up to 600 on the start tools and{' '}
                <code>get_review</code>, holds the call until the review finishes, sending progress notifications to
                clients that ask for them. A process that exits before recording the job fails the call with the lines
                it logged.
              </li>
              <li>
                <strong>Same jobs as everywhere else.</strong> They land in <code>state.json</code>, so{' '}
                <code>status</code>, <code>cost</code>, and <code>tui</code> show them, and their output goes to{' '}
                <code>daemon.log</code>. Starting a review of a commit already under review returns that job instead of
                starting another.
              </li>
              <li>
                <strong>Config read on every call.</strong> Edits apply without restarting the client. A missing or
                broken config comes back as a tool error.
              </li>
            </ul>
            <Note title="Agents review their own work">
              The server tells the agent to commit, call <code>review_branch</code>, then poll <code>get_review</code>{' '}
              with the key until the status is <code>done</code>, and address the findings. Uncommitted changes are left
              out of the review.
            </Note>
          </Section>

          <Section id="commands" title="CLI commands">
            <p>
              Run <code>review-relay help &lt;command&gt;</code> or <code>review-relay &lt;command&gt; --help</code> for
              command help. Global options are <code>--config &lt;path&gt;</code>, <code>-h / --help</code>, and{' '}
              <code>-v / --version</code>.
            </p>
            <Reference rows={COMMANDS} label="CLI commands" headings={['Command', 'Arguments / options', 'Purpose']} />
            <h3>Watch jobs live</h3>
            <Snippet label="Full-screen job view" code="review-relay tui" />
            <p>
              <code>tui</code> takes over the terminal: the job table in a panel taking about four fifths of the screen,
              the highlighted job’s detail in a panel below it, and the daemon’s state and the total spent in the status
              line, refreshing as the daemon writes <code>state.json</code>. Enter expands a job: the published score,
              each reviewer’s score, model, cost, and time, the merged findings with their file and line, and the review
              comment from <code>comment.md</code>, which is only posted to the PR when <code>postToPr</code> is on and
              a reviewer succeeded. A job with no comment yet shows its log lines instead.
            </p>
            <p>
              The table has a <code>COST</code> column and a <code>PR STATE</code> column that shows GitHub’s{' '}
              <code>open</code>, <code>closed</code>, or <code>merged</code> state apart from the review result. The TUI
              checks nearby rows through your signed-in <code>gh</code> in the background, at most once a minute;
              unchecked PRs show <code>unknown</code> and local reviews <code>-</code>.
            </p>
            <Reference rows={TUI_KEYS} label="TUI keys" headings={['Key', 'Where', 'What it does']} />
            <p>
              <code>?</code> lists every key. The TUI reads <code>state.json</code>, the report directories, and{' '}
              <code>daemon.log</code> directly, so it works whether or not the daemon is running. A queued or running
              job whose process has exited shows as failed in both <code>tui</code> and <code>status</code>, so it can
              retry.
            </p>
            <details>
              <summary>Themes, small terminals, and wide rows</summary>
              <p>
                <code>t</code> cycles Dark, Light, and Terminal. Terminal uses your terminal’s own foreground,
                background, and ANSI palette and follows its theme changes; Dark and Light use truecolor where the
                terminal supports it. The choice is saved as <code>theme</code> in the active config without restarting
                the daemon, and <code>NO_COLOR</code> still disables color in every mode.
              </p>
              <p>
                On a narrow terminal the table, a job’s detail, and the log pan sideways with <code>←</code> and{' '}
                <code>→</code>, and the panel’s top edge counts the columns hidden on each side. A long message wraps
                onto up to three rows instead of being cut. The status line and footer drop their least important parts
                first, and the detail panel is dropped when the terminal is too short for both. The layout needs at
                least 40 columns by 10 rows.
              </p>
            </details>
            <h3 id="cancel">Cancel a review</h3>
            <Snippet
              label="Stop a queued or running review"
              code={
                'review-relay cancel --repo acme/widget --pr 42\nreview-relay cancel\nreview-relay cancel --head feature'
              }
            />
            <p>
              With <code>--repo</code> and <code>--pr</code>, <code>cancel</code> stops the PR&rsquo;s queued or running
              reviews. With neither, it stops the local reviews running in the checkout you run it from, and{' '}
              <code>--head</code> narrows that to one branch. In <code>tui</code>, <code>c</code> does the same for the
              highlighted job, after asking.
            </p>
            <p>
              The request is written to <code>state.json</code>. Whichever process runs the review (the daemon,{' '}
              <code>run</code>, or a local review) notices within a second, stops its reviewers, removes the worktree,
              posts nothing, and records the job as <code>cancelled</code>; until then the job shows as{' '}
              <code>cancelling</code>. <code>cancel</code> waits up to 20 seconds for that, and exits 1 when there was
              nothing to cancel or a review did not stop in time. Triggers leave a cancelled commit alone, while{' '}
              <code>run</code>, a mention, or <code>r</code> in the TUI reviews it again.
            </p>
            <Note title="Restart the daemon after upgrading">
              A daemon started before cancel existed ignores the request, so its reviews keep running. Run{' '}
              <code>review-relay restart</code> once after upgrading.
            </Note>
            <h3>Preview or force a route</h3>
            <Snippet
              label="Explain routing without running agents"
              code="review-relay route --repo acme/widget --pr 42 --source github"
            />
            <p>
              <code>run --route sensitive</code> forces that non-skip route. Unlike mentions, an unknown or skip route
              is rejected. <code>route --source</code> accepts <code>github</code>, <code>greptile</code>,{' '}
              <code>coderabbit</code>, <code>mention</code>, <code>manual</code>, or <code>local</code>. Route
              inspection also works on closed PRs.
            </p>
            <h3>Replay recorded deliveries</h3>
            <p>
              Use a JSONL file with one <code>{'{"event":"pull_request","payload":{...}}'}</code> object per line.{' '}
              <code>body</code> is accepted as an alternative to <code>payload</code>. The payload must contain the
              original GitHub fields.
            </p>
            <Snippet
              label="Inspect triggers without running agents"
              code="review-relay replay events.jsonl --dry-run --grace 0"
            />
            <p>
              Dry-run uses fresh in-memory state and logs which jobs would be dispatched. It does not fetch diffs or
              evaluate routes. Without <code>--dry-run</code>, replay can run agents, write state, and publish comments.
            </p>
          </Section>

          <Section id="reports" title="Scores & reports">
            <p>
              Each successful reviewer scores correctness, security, code quality, standards, blast radius, and testing
              from 1 to 5, plus an overall merge confidence.
            </p>
            <ul>
              <li>
                A critical finding caps that reviewer at <strong>2/5</strong>.
              </li>
              <li>
                A major finding caps that reviewer at <strong>3/5</strong>.
              </li>
              <li>Overall confidence cannot exceed the weakest dimension by more than one point.</li>
              <li>
                The published score is the <strong>lowest capped score</strong> among successful reviewers, never an
                average.
              </li>
            </ul>
            <p>
              Findings from different reviewers at the same file and within three lines are merged, retaining the
              highest severity. The comment links findings to the reviewed commit and includes dimension notes.
            </p>
            <h3>One comment, local reports</h3>
            <p>
              Publishing edits the signed-in GitHub user’s latest comment carrying the relay marker, or creates one if
              none exists. Switching GitHub accounts can create a separate comment. Scores are advisory; review-relay
              does not install a merge gate.
            </p>
            <Snippet
              label="Report directory"
              code={
                '<dataDir>/reports/<owner__repo>/pr-<number>/<sha8>/\n  comment.md\n  <reviewer-id>.json\n  meta.json\n<dataDir>/reports/<owner__repo>/local/<sha8>/   # review, before a PR'
              }
            />
            <p>
              <code>meta.json</code> records the job, route, selected models, timeouts, durations, scores, and each
              reviewer's tokens and cost (Claude Code's own figure; Codex estimated from tokens at list price), which{' '}
              <code>cost</code> totals. Reviewer JSON contains the verdict, or an error and raw output on failure.
              Re-running the same PR commit writes to the same directory. <code>tui</code> renders these reports in the
              terminal: open a job to read its scores, findings, and <code>comment.md</code> without leaving the shell.
            </p>
            <p>
              One failed reviewer does not cancel the others. A partial result can publish with the failure noted. If
              all reviewers fail, local reports are saved but no comment is posted, and the job fails. A publishing
              failure also leaves the local report available.
            </p>
            <h3>What a review cost</h3>
            <Snippet
              label="Costs per review and per reviewer"
              code={
                'review-relay cost\nreview-relay cost --repo acme/widget --pr 42\nreview-relay cost --json | jq .costUsd'
              }
            />
            <p>
              <code>cost</code> lists the finished reviews newest first with each reviewer’s cost and tokens and the
              review’s total, then the totals across them, overall and per reviewer. <code>--repo</code> and{' '}
              <code>--pr</code> narrow it, <code>--limit</code> and <code>--page</code> page it like <code>status</code>
              , and <code>--json</code> prints every matching review. <code>status</code> and <code>tui</code> show the
              same <code>COST</code> column.
            </p>
            <ul>
              <li>
                <strong>Claude Code</strong> reports its own cost, at list price even on a subscription, and it is used
                as is.
              </li>
              <li>
                <strong>Codex</strong> reports only tokens, so its cost is those tokens at the model’s list price,
                marked <code>~</code>. Built-in prices cover <code>gpt-6-astra</code>, <code>gpt-6-sol</code>,{' '}
                <code>gpt-6.1-sol</code>, and <code>gpt-6-luna</code>; <code>pricing</code> in the config adds a model
                or changes a price, and a run whose model had no price when it ran is priced when it is read.
              </li>
              <li>
                <strong>Other CLIs</strong> do not report usage yet, so their columns show <code>-</code>. A total that
                leaves out a run with no cost, such as one that timed out, is marked <code>+</code>.
              </li>
              <li>
                A re-review of the same commit replaces its report, cost included, so <code>cost</code> counts the
                latest run of each commit.
              </li>
            </ul>
          </Section>

          <Section id="security" title="Security & privacy">
            <p>
              Reviews run on your machine, but your code goes to the providers used by your selected agents and models.{' '}
              <code>postToPr: false</code> disables GitHub comments, not provider requests.
            </p>
            <p>
              The webhook server binds to <code>127.0.0.1</code>. <code>POST /hook</code> requires an HMAC-SHA256
              signature using a secret generated at daemon startup. <code>GET /health</code> returns a local health
              response.
            </p>
            <p>
              Reviewers use each CLI’s read-only controls, restricted tools, sandbox, or no-shell mode. The runner
              removes recognized project configs that could load hooks, plugins, or MCP servers from the review worktree
              before starting agents. Your original clone is not stripped.
            </p>
            <p>
              These controls depend on the agent CLI and its version. They are not a separate VM boundary. Keep CLIs
              updated, review their authentication and provider settings, and treat PR content and model output as
              untrusted.
            </p>
            <p>
              Reports and daemon logs can contain source code and findings. Protect <code>dataDir</code> accordingly.
              Stop the daemon normally so the forwarders can remove their temporary repository webhooks.
            </p>
          </Section>

          <Section id="troubleshooting" title="Troubleshooting">
            <Snippet
              label="Start with these checks"
              code={'review-relay status\nreview-relay info\nreview-relay logs 100\ngh auth status'}
            />
            <p>
              <code>tui</code> shows a job’s log lines while it runs, and <code>l</code> opens them for any job,
              including a failed one whose saved comment fills the detail view. <code>r</code> re-runs it once the cause
              is fixed.
            </p>
            <details>
              <summary>No review appeared</summary>
              <p>
                Check that the daemon and repo forwarder are running, your machine is awake, and <code>fullName</code>{' '}
                matches. In auto mode, allow the two-minute default grace period. Push events require{' '}
                <code>github.onPush: true</code>. Check for a draft, already-reviewed commit, or skip route.
              </p>
              <p>
                For mention triggers, use a new PR comment from a trusted collaborator. To see ignored-event reasons,
                set <code>REVIEW_RELAY_DEBUG=1</code> in the daemon’s environment and restart it.
              </p>
            </details>
            <details>
              <summary>A reviewer failed or timed out</summary>
              <p>
                Confirm its executable is on the daemon’s PATH and that the CLI can authenticate outside review-relay.
                Check model and effort support. Read that reviewer’s JSON in the report directory for the error and raw
                output. Increase <code>timeoutMs</code> if needed, then restart.
              </p>
              <p>
                A failed job can retry on a later trigger. A partial review is completed, so use a mention or{' '}
                <code>run</code> to request it again.
              </p>
            </details>
            <details>
              <summary>Config edits had no effect</summary>
              <p>
                Run <code>info</code> with the same <code>--config</code> as the daemon. It flags unapplied edits,
                missing binaries, and missing clones. The daemon does not hot-reload its config; use{' '}
                <code>restart</code>.
              </p>
            </details>
            <details>
              <summary>The report exists but there is no PR comment</summary>
              <p>
                Check <code>postToPr</code>, GitHub authentication, and permission to comment. If every reviewer failed,
                the relay saves the report without publishing. Read <code>comment.md</code> and the log before retrying.
              </p>
            </details>
            <details>
              <summary>Port conflict, stale daemon, or leftover webhooks</summary>
              <p>
                <code>status</code> distinguishes a live relay from a stale daemon record or a different listener. Do
                not stop an unrelated service. Choose another <code>port</code> or stop the correct relay before
                starting again.
              </p>
              <p>
                Forced exits and Windows shutdown can leave temporary webhooks behind. Inspect the repository’s Settings
                → Webhooks and remove only hooks you can identify as stale relay forwarders.
              </p>
            </details>
            <details>
              <summary>An agent’s MCP call failed or never finished</summary>
              <p>
                A tool error names a missing or broken config; fix the file and call again, since the server reads it on
                every call. A start tool that fails quotes the lines the review process logged. A job left at{' '}
                <code>starting</code> or <code>running</code> shows up in <code>tui</code> and <code>logs</code> like
                any other, so read its log lines there. Long reviews outlast many clients’ tool timeouts: start without
                waiting, then poll <code>get_review</code> with a shorter <code>waitSeconds</code>.
              </p>
            </details>
            <details>
              <summary>Git cannot fetch the PR</summary>
              <p>
                Check that <code>localPath</code> is an existing clone with an <code>origin</code> remote pointing at
                the configured GitHub repository. Confirm Git authentication works for that remote. The relay fetches
                the base branch and <code>refs/pull/N/head</code>, including fork PRs.
              </p>
            </details>
            <p className="docs-end">
              <a href="#quick-start">Back to quick start</a>
              <Link to="/">Back to the landing page</Link>
            </p>
          </Section>
        </main>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="docs-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="type-broadcast">
        <a href={`#${id}`}>
          {title}
          <span aria-hidden="true">#</span>
        </a>
      </h2>
      {children}
    </section>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="docs-note">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  );
}

function Reference({
  rows,
  label,
  headings = ['Option', 'Default', 'What it does'],
}: {
  rows: readonly ReferenceRow[];
  label: string;
  headings?: readonly [string, string, string];
}) {
  return (
    <div className="docs-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value, description]) => (
            <tr key={name}>
              <th scope="row">
                <code>{name}</code>
              </th>
              <td>{value}</td>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState<'Copy' | 'Copied' | 'Selected'>('Copy');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (copied === 'Copy') return;
    const timer = setTimeout(() => setCopied('Copy'), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('Copied');
    } catch {
      if (ref.current) window.getSelection()?.selectAllChildren(ref.current);
      setCopied('Selected');
    }
  };
  return (
    <figure className="docs-snippet">
      <figcaption>
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
          <span aria-live="polite">{copied}</span>
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={label}>
        <code ref={ref}>{code}</code>
      </pre>
    </figure>
  );
}
