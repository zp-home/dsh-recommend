# Static Security Scanning Algorithm

## Status and scope

This document specifies the marketplace's open, source-only heuristic algorithm. The executable implementation is [`scripts/static-security.mjs`](../scripts/static-security.mjs). Its receipt contains `scannerVersion` and `rulesetVersion`, so a result can be interpreted against the exact published rules.

The scan is advisory evidence only. A `passed` result means that the current rules emitted no finding in the files read; it does not prove that a plugin, its dependencies, its releases, or its future revisions are safe. A warning is not a finding of malicious behavior.

## Inputs and execution boundary

The market GitHub Actions worker shallow-checks out one public repository revision with no persistent target credentials, Git submodules, or Git LFS. It reads candidate text files and never installs packages, imports target modules, runs package lifecycle scripts, builds, tests, or executes plugin code.

The scanner recursively reads these file types: JavaScript and TypeScript variants, JSON, YAML, shell scripts, Windows command scripts, and every file named `package.json`. It intentionally includes `lib/` and `dist/`, because installed plugin bundles are part of the execution surface. It excludes `.git`, `node_modules`, `coverage`, `.next`, and `.turbo`.

## Bounds and result state

The worker reads at most 5,000 candidate files, at most 1 MiB per file, and emits at most 200 findings. Exceeding any bound produces `status: incomplete`; it must not be displayed as a completed static check.

For complete scans, the maximum matched severity determines the result:

| Condition | Receipt status | Risk |
|---|---|---|
| No rule matches | `passed` | `low` |
| One or more rule matches | `warnings` | highest matched severity |
| File, finding, or byte bound reached | `incomplete` | highest matched severity so far |

The receipt is bound to the selected `repository` and immutable Git `commit`. The marketplace does not reuse a receipt for a later revision. A repository with a newer `pushedAt` value is eligible for a new queued scan.

## Ruleset `2026-09`

All matching expressions are public in the implementation. The table below describes their intent; it is not a complete security policy.

| Rule ID | Severity | Signal |
|---|---:|---|
| `process-execution` | high | Node process-launch APIs such as `exec`, `spawn`, `fork`, or `child_process` |
| `dynamic-code` | medium | `eval()` or `Function()` dynamic evaluation |
| `credential-access` | medium | environment-variable or credential-source access, including `process.env` |
| `network-access` | medium | direct `fetch`, HTTP request, or WebSocket calls |
| `persistence` | high | operating-system persistence references such as `schtasks`, `crontab`, `RunOnce`, or `LaunchAgents` |
| `obfuscation` | medium | common base64 or character-code obfuscation primitives |
| `install-lifecycle` | high | non-empty `preinstall`, `install`, `postinstall`, or `prepare` package scripts |
| `invalid-manifest` | medium | a root `package.json` that cannot be parsed as JSON |

## Known limitations

The algorithm does not resolve dependencies, inspect binary code, trace runtime data flow, establish author identity, detect every obfuscation technique, or emulate operating-system behavior. Benign plugins can match rules, and harmful plugins can avoid them. It also does not replace code review, dependency review, release integrity checks, or local compatibility testing.

Users should review the source and requested permissions before installation. Plugin authors should treat findings as actionable review prompts and may explain intentional matches in their documentation. The marketplace keeps unscanned, incomplete, and warning-bearing plugins installable; these signals do not affect ranking score or form a security certification.
