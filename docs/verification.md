# Plugin Verification Signals

The marketplace displays optional, version-bound evidence. Missing labels never prevent installation, and every label is advisory only: it is not a security certification, code audit, or guarantee of safety.

## Marketplace static security scan

`marketplace-security-scan` is a market-owned GitHub Actions queue. Every 15 minutes it selects up to six missing, source-changed, or expired entries and scans them concurrently. A worker shallow-checks out a public repository, resolves the checked-out commit, and runs the trusted `scripts/static-security.mjs` scanner. The complete public algorithm, bounds, rule table, and limitations are in [Static Security Scanning Algorithm](security-scanning.md).

The worker has no target-repository credentials and never runs `npm install`, package lifecycle scripts, builds, tests, or plugin code. It disables submodules and Git LFS. The public `data/verification.json` index records only validated evidence bound to `repository + commit`, including the scanner and ruleset versions. When the same revision contains a valid `.dsh/compatibility.json` `clean` baseline receipt, the worker recomputes the target `package.json` SHA-256 fingerprint and requires the receipt's plugin name and fingerprint to match before projecting it as a separate developer sandbox compatibility label; it still does not execute plugin code.

The UI distinguishes these states:

- **Static advisory, no rule match**: no current rule emitted a warning in the files read; this is not a safety guarantee.
- **Static advisory**: one or more source-only heuristic rules matched; the report is not a verdict that the plugin is malicious.
- **No static security advisory**: the queue has not reached this version, the receipt expired, or scanning could not complete.

The static-security field is display-only. It never changes ranking score or automatically blocks installation. Each published warning carries a bounded, source-only evidence record: rule ID, severity, scanner explanation, relative file path, and line number. The UI links that location to the exact public GitHub commit and links the rule ID to the public algorithm; it never publishes source excerpts, local paths, logs, credentials, or target-code output. A later GitHub push has a newer `pushedAt` value than its last receipt, so the central queue selects it again and refreshes both public labels without requiring the market browser to download the plugin.

## Publisher baseline compatibility

Plugin authors can call the reusable workflow:

```yaml
name: plugin-verification
on:
  push:
    branches: [main]
  release:
    types: [published]

permissions:
  contents: read

jobs:
  verify:
    uses: zp-home/dsh-recommend/.github/workflows/plugin-verification.yml@main
```

The workflow has two independent jobs:

- `static-security` provides an author-facing, source-only report. Marketplace security labels always come from the market-owned queue, not a third-party Check summary.
- `baseline-compatibility` reads a local `dsh-dev-sandbox` receipt and displays a **publisher clean-compatible** label only when it is for the exact `GITHUB_SHA`, identifies the same repository, and records a passed `clean` profile result.

Create the portable compatibility receipt with an already-built local checkout:

```text
sandbox_verify pluginPath=E:\path\to\plugin repository=owner/repo commit=<full-commit-sha> profileMode=clean kind=baseline-compatibility
```

Commit only the returned `attestation` projection as `.dsh/compatibility.json` with the tested source revision. It excludes local scan paths, profile bundles, diagnostics, and logs. Do not commit the raw `verification` object, credentials, or settings. `host-web` is intentionally local-only and never earns a public baseline label.

## Local market check

The DSH Settings > Plugins > Plugin rankings installation confirmation includes **Local compatibility**. It accepts only a path the user has already prepared; rankings never show the local path or result, and the market never downloads or installs a plugin as a side effect of checking. The user chooses:

- `clean` to test stock DSH Web composition.
- `host-web` to test their own installed plugin stack and Web profile.

The action calls the installed `dsh-dev-sandbox` plugin with host API/model inheritance disabled and builds disabled. Results are local to the current browser session and are not uploaded to the market.

This is a compatibility check, not a host-level security sandbox. It does not establish that a plugin is safe to execute.
