# 0005 - Version-bound security and compatibility signals

- Date: 2026-09
- Status: adopted
- Related: [0001 data and presentation separation](0001-data-and-presentation-separation.md), [0004 non-plugin filtering](0004-trustworthiness-non-plugin-filter.md)

## Context

Plugin installation fetches and executes third-party code. Ranking metadata cannot prove that code is safe, and compatibility with a publisher's clean environment does not prove compatibility with each user's local Web profile.

## Decision

The registry adds optional, version-bound verification metadata. It is deliberately separate from scoring and does not change a plugin's eligibility for listing or installation.

1. A market-owned GitHub Actions queue scans a bounded batch of public repositories every 15 minutes. Workers shallow-checkout the selected repository without persisted credentials, submodules, or LFS; run source-only static rules; and never install, build, test, import, or execute target code. A single publisher job validates the receipt schema and updates `data/verification.json`.
2. The generated registry projects only market-owned static-security evidence into `verification.staticSecurity`. It is bound to a repository, exact commit, scanner version, ruleset version, and timestamp. Incomplete scans do not receive a completed label.
3. A publisher can call the reusable `dsh-plugin-verification` workflow. Its source-only report is author-facing. A `baseline-compatibility` label is separate and requires a `dsh-dev-sandbox` receipt for the same repository, exact commit, and `clean` profile. The label is explicitly publisher-provided, not a marketplace security attestation.
4. A market user may run an explicit local sandbox check against a manually prepared local directory using either `clean` or `host-web`. The marketplace never downloads a plugin merely to check it and never installs one as a side effect of checking. The result remains local to that user session.
5. `unavailable`, expired, incomplete, warning, invalid, and failed signals remain visible but do not block installation. Labels are evidence and compatibility indicators, not security certification.

## Consequences

- Registry consumers must tolerate missing `verification` fields.
- Verification is display-only and excluded from the ranking score.
- The market's dedicated GitHub workflow is the only component that clones indexed repositories, and it follows the source-only constraints above.
- The sandbox isolates DSH state and Web composition, not the host operating system. Dynamic security analysis remains out of scope.
