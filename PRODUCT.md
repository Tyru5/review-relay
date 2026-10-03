# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Developers and maintainers who already use coding agents or LLMs and want the ones they choose reviewing every pull request automatically, alongside Greptile on repos that use it.
- Teams on repos with no AI reviewer bot who want scored reviews without adding another hosted reviewer.

Both are comfortable in a terminal: they install a CLI, edit a JSON config, and keep `gh` and their chosen agents signed in or configured with API keys.

## Product Purpose

review-relay runs reviews from the coding agents and models the user chooses on a pull request the moment a review starts on GitHub, then posts one PR comment with their merged findings and a 1-5 merge confidence score. Success means every PR gets independent reviews from the user's chosen agents without anyone remembering to ask, and the score tells the author whether it is safe to merge.

The website at reviewrelay.dev exists so people can understand the tool and install it.

## Positioning

- Bring your agents: users seat any of the 13 supported agent CLIs (Claude Code, Codex, Augment Auggie, GitHub Copilot CLI, Factory Droid, Gemini CLI, Grok Build, Hermes Agent, Kilo Code CLI, opencode, pi, Qwen Code, Mistral Vibe), as many as they want, each on the model and effort they choose. Claude Code and Codex are the defaults; no vendor is required. CLIs whose lockdown a PR could escape are not supported (see README).
- Reviews run on the user's machine through their own agent logins and API keys, against a temporary worktree of their own clone. No hosted reviewer, no public URL: GitHub events arrive through `gh webhook forward`.
- It rides existing triggers: Greptile's check run starting, GitHub PR events, or an `@review-relay` mention.
- Every reviewer scores the same six dimensions (correctness, security, code quality, standards, blast radius, testing). The headline is the lowest score among reviewers, with caps tied to findings (a critical finding limits a reviewer to 2/5, a major one to 3/5).

## Operating Context

GitHub pull requests and their timeline, the `gh` CLI with the `cli/gh-webhook` extension, local clones of watched repos, a long-running local daemon (`review-relay start`), an interactive `review-relay setup` that picks reviewers and their model and effort, and a config file at `~/.review-relay/config.json`. Reports also land locally under `~/.review-relay/reports/`.

## Capabilities and Constraints

- Trigger modes per repo: `auto`, `greptile`, `github`. Each commit is reviewed once; mentions and `run` review again. Drafts are skipped.
- One PR comment, edited in place on later reviews, with findings linked to exact lines.
- Distributed as standalone binaries attached to GitHub Releases at https://github.com/Tyru5/review-relay/releases (macOS and glibc Linux on x64/arm64, Windows x64), installed with `curl ... | bash` or `irm ... | iex`. Versions are published by tagging `v*.*.*`.
- Code is sent to whichever providers the user's chosen agents and models use; the site must never claim code stays on the machine.
- Windows: daemon shutdown may not clean up temporary repo webhooks.
- Free to use and open source; installs and the site both point at the GitHub repo, so it must stay public.

## Brand Commitments

- Name is always lowercase `review-relay`.
- Icon, favicons, and social preview in `assets/` (`icon-512.png`, `og-image.png`, favicons) are the existing identity.

## Evidence on Hand

- Real product facts: the README, the scoring rubric (`src/verdict.ts`), and the comment format (`src/report.ts`).
- No testimonials, customers, usage numbers, benchmarks, or pricing exist. Do not fabricate them.
- Any sample review on the site is illustrative (fictional repo, fictional findings) and must read as an example.

## Product Principles

1. Truth over pitch: every claim maps to something the tool actually does today.
2. The review is the proof: show the scored comment, not adjectives about it.
3. Install is the action: the command is always one copy away.
4. Respect the terminal user: plain language, exact commands, no hand-holding.
