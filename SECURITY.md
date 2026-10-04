# Security

review-relay runs coding agents on pull request content, and anyone who can open a PR controls that content. A way around a reviewer's lockdown is a vulnerability.

## Reporting

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Tyru5/review-relay/security/advisories/new), not in a public issue or PR. Include the review-relay version (`review-relay --version`), the reviewer CLI and its version, and the steps or PR content that reproduce it.

## In scope

- A PR that makes a supported reviewer write files, run commands, or reach the network beyond what [Supported agents](README.md#supported-agents) allows
- A PR that runs code through a config file review-relay should have deleted from the review worktree
- A webhook delivery accepted without a valid signature, or a review requested by a commenter the mention rules should refuse
- An installer that skips the checksum check or accepts a bad checksum

[Limits](README.md#limits) lists known, documented gaps, such as reviewers that can read files outside the worktree. A model talked into a wrong score or a bad finding is not a vulnerability on its own; one made to leak data or escape its lockdown is.

## Supported versions

Only the latest release gets fixes. Rerun the installer to update.
