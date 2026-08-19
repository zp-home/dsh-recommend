# Static Security Scanning Algorithm

> Status: advisory-only, source-only, and version-bound. This is not a code audit, malware verdict, safety guarantee, or security certification.

## Purpose and boundary

The marketplace scans a shallow, credential-free checkout of a public plugin revision. It reads text files only. It never installs dependencies, runs lifecycle scripts, builds, tests, imports, or executes target code. The scanner is zero-dependency Node code so the complete implementation and its exact rule set remain auditable.

A source-only scanner can establish that a pattern was observed at a specific location. It cannot establish exploitability, author intent, runtime data flow, endpoint ownership, or whether a permission is necessary. Findings are review prompts, never automatic installation blocks or ranking inputs.

## Public design basis

The rules are derived from public guidance, adapted to DSH plugins and agent skills:

- [OWASP npm Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
- [OpenSSF npm supply-chain practices](https://openssf.org/blog/2022/09/01/npm-best-practices-for-the-supply-chain/)
- [OpenSSF Scorecards](https://openssf.org/blog/2022/01/19/reducing-security-risks-in-open-source-software-at-scale-scorecards-launches-v4/)
- [MCP authorization security considerations](https://modelcontextprotocol.io/specification/draft/basic/authorization/security-considerations)

360 Browser extension platform material is useful for platform compatibility and CSP reference, but no public modern 360 plugin-market review policy was found. The marketplace therefore does not claim or imply 360 certification.

## Evidence contract

Every public finding is bound to `repository + commit + scannerVersion + rulesetVersion`. It contains:

- Stable rule ID and family
- Risk level, confidence, and suggested disposition
- Relative source path and line number, linked to the exact public commit
- Short scanner explanation, remediation guidance, and public-basis name
- Evidence-oriented fields (current ruleset 2026-21):
  - `impact`: concrete harm description (what an attacker could achieve)
  - `attack_vector`: how the pattern could be exploited
  - `cwe`: MITRE CWE identifier (e.g. CWE-78, CWE-95)
  - `evidence_risk`: the rule's baseline risk before evidence-based adjustment
  - `evidence_confidence`: strength of the matched evidence (high / medium / low)
  - `risk_adjustment`: explanation of any risk-level adjustment applied

The index never publishes source excerpts (the `evidence` field containing matched code snippets is internal-only and stripped by `publicFindings`), local paths, logs, credentials, or execution output. Findings are length-bounded and schema-validated before publication.

## Outcome model

- **No static rule match**: no current risk rule matched in the files read. This is not proof of safety.
- **Low / medium / high risk rule match**: one or more source-only review rules matched. The label is the highest observed risk, not a malware verdict.
- **Scan incomplete**: a file, file-count, or finding limit was reached. The highest observed risk remains visible, but undisplayed matches may remain.
- **No static advisory**: no valid receipt exists for the displayed revision.

A normal capability such as `fetch()`, `process.env`, base64 decoding, or a process API import is not by itself treated as a risk verdict. The scanner uses narrow direct rules and correlated patterns instead.

## Ruleset 2026-21

Supersedes `2026-20`. Existing receipts remain displayable; new scans use the expanded ruleset with evidence-oriented fields. The rules below are grouped by family.

### Execution (MKT-EXEC-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-EXEC-001` | high | high / medium / low | OS process launch API, protection-aware | CWE-78 | Manual review |
| `MKT-EXEC-002` | high | high | `eval()` or `Function()` constructor | CWE-95 | Manual review |
| `MKT-EXEC-003` | high | high | download-and-execute shell or PowerShell pattern | CWE-494 | Manual review |
| `MKT-EXEC-006` | high | high | WebAssembly compilation or instantiation | CWE-94 | Manual review |
| `MKT-EXEC-007` | high | high | Native `.node` addon via `process.dlopen` or `require("*.node")` | CWE-912 | Manual review |
| `MKT-EXEC-008` | high | high | `vm.runInNewContext()` with untrusted data | CWE-94 | Manual review |
| `MKT-EXEC-009` | medium | medium | Dynamic `import()` with variable path | CWE-94 | Manual review |
| `MKT-EXEC-010` | medium | medium | `setTimeout`/`setInterval` with non-literal arguments | CWE-95 | Manual review |
| `MKT-EXEC-011` | high | high | constructor-chain sandbox escape pattern | CWE-94 | Manual review |
| `MKT-EXEC-012` | high | high | Composite: decode (`atob`/`Buffer.from`) + execute (`eval`/`Function`) in same file | CWE-94 | Manual review |
| `MKT-EXEC-013` | medium | medium | shell-enabled process API or command-template helper | CWE-78 | Manual review |

### Data egress (MKT-DATA-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-DATA-001` | high | high | value shaped like a private key or provider token | CWE-798 | Rotate and review |
| `MKT-DATA-002` | medium | medium | plaintext HTTP or disabled TLS verification | CWE-295 | Manual review |
| `MKT-DATA-003` | high | high | likely non-environment secret source and nearby network sink | CWE-200 | Manual review |
| `MKT-DATA-004` | medium | medium | raw TCP/UDP socket (`net.connect`, `dgram.createSocket`) | CWE-923 | Manual review |
| `MKT-DATA-005` | medium | not emitted | legacy identifier retained for receipt compatibility; environment access is reported by `MKT-DATA-008` only when correlated | CWE-532 | Manual review |
| `MKT-DATA-006` | medium | medium | access to system credential stores (`~/.ssh/id_rsa`, `~/.aws/credentials`) | CWE-200 | Manual review |
| `MKT-DATA-007` | medium | medium | known anonymous/high-risk destination | CWE-200 | Manual review |
| `MKT-DATA-008` | medium | medium | Composite review lead: environment secrets + nearby network request | CWE-200 | Manual review |
| `MKT-DATA-009` | medium | medium | executable code patterns (`eval`, `Function`) in README/documentation | CWE-94 | Manual review |
| `MKT-DATA-010` | medium | medium | cloud metadata address or non-HTTP SSRF-capable scheme passed to a network API | CWE-918 | Manual review |

### Agent and skill (MKT-SKILL-* / MKT-HIJACK-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-SKILL-001` | high | high | instruction override language + destructive/egress guidance in agent-instruction files | CWE-1039 | Manual review |
| `MKT-SKILL-002` | medium | medium | role impersonation ("you are now system/admin") in skill content | CWE-1039 | Manual review |
| `MKT-SKILL-003` | medium | medium | multi-step prompt injection chain in skill files | CWE-1039 | Manual review |
| `MKT-SKILL-004` | medium | medium | exfiltration guidance targeting conversation/history/memory | CWE-200 | Manual review |
| `MKT-SKILL-005` | medium | medium | disabling/bypassing safety features in skill content | CWE-1039 | Manual review |
| `MKT-HIJACK-001` | medium | medium | prompt injection patterns ("ignore all previous instructions") in code files | CWE-1039 | Manual review |
| `MKT-HIJACK-004` | medium | medium | tool override directives ("use exec_command instead") in code files | CWE-1039 | Manual review |
| `MKT-HIJACK-005` | medium | medium | instruction override with specific goal redirection in code files | CWE-1039 | Manual review |

### File system (MKT-FS-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-FS-001` | high | high / medium / low | unbounded file-system mutation API, protection-aware | CWE-73 | Manual review |
| `MKT-FS-002` | high | high | path literal starts with `../` or `/etc/` (workspace escape) | CWE-22 | Manual review |
| `MKT-FS-003` | medium | medium | reading system credential files (`/etc/passwd`, `~/.ssh/id_rsa`) | CWE-200 | Manual review |
| `MKT-FS-004` | medium | medium | encoded path traversal (`%2e%2e%2f`) or nested `../..` sequences | CWE-22 | Manual review |
| `MKT-FS-005` | high | high | Composite: sensitive data read + external file write in same file | CWE-200 | Manual review |

### Supply chain (MKT-SUPPLY-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-SUPPLY-001` | high | high | non-empty npm install lifecycle script (`preinstall`/`install`/`postinstall`/`prepare`) | CWE-506 | Manual review |
| `MKT-SUPPLY-002` | high | high | unpinned git/URL dependency (`git+https://`, `github:`) | CWE-494 | Manual review |
| `MKT-SUPPLY-004` | medium | medium | mutable remote archive dependency (`.tgz`, `.tar.gz`, `.zip`) | CWE-494 | Manual review |

### CI integrity (MKT-CI-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-CI-001` | high | high | `pull_request_target` plus pull-request head checkout | CWE-250 | Manual review |
| `MKT-CI-002` | high | high | excessive GitHub token permissions (`workflows:write`, `secrets:write`) | CWE-250 | Manual review |
| `MKT-CI-003` | medium | medium | checkout without `persist-credentials: false` | CWE-200 | Manual review |
| `MKT-CI-005` | high | high | `curl`/`wget` piped to interpreter in workflow | CWE-494 | Manual review |
| `MKT-CI-006` | medium | medium | `pull_request_target` without head checkout (still risky) | CWE-250 | Manual review |
| `MKT-CI-007` | high | high | wildcard (`*`) GitHub token permission | CWE-250 | Manual review |
| `MKT-CI-008` | medium | medium | workflow downloads remote scripts without integrity verification | CWE-494 | Manual review |
| `MKT-CI-009` | medium | medium | sensitive GitHub token scope granted write access | CWE-250 | Manual review |
| `MKT-CI-010` | medium | medium | untrusted PR/issue text interpolated directly into `run` | CWE-78 | Manual review |

### Persistence (MKT-PERSIST-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-PERSIST-001` | high | high | operating-system persistence mechanisms (`schtasks`, `crontab`, services, Run keys) | CWE-506 | Manual review |
| `MKT-PERSIST-002` | medium | medium | writing to startup files (`~/.bashrc`, `~/.zshrc`) | CWE-506 | Manual review |
| `MKT-PERSIST-003` | medium | medium | system directory or boot-location reference | CWE-506 | Manual review |
| `MKT-PERSIST-004` | high | high | system service or driver installation command | CWE-506 | Manual review |

### Anti-analysis (MKT-ANALYZE-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-ANALYZE-001` | medium | medium | anti-debugging patterns (`debugger` statement, `--inspect` detection) | CWE-506 | Manual review |
| `MKT-ANALYZE-002` | medium | medium | `Error().stack` inspection for debugger detection | CWE-506 | Manual review |

### Manifest and reviewability

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-MAN-001` | medium | medium | invalid root `package.json` | — | Fix before review |
| `MKT-REVIEW-001` | medium | medium | decode-then-dynamic-execution chain (alias of `MKT-EXEC-012`) | CWE-94 | Manual review |
| `MKT-REVIEW-002` | medium | medium | character-code or hexadecimal string construction | CWE-506 | Manual review |
| `MKT-REVIEW-003` | medium | medium | repeated encoded escape layers | CWE-506 | Manual review |
| `MKT-REVIEW-004` | medium | medium | obfuscation/minification tooling reference | CWE-506 | Manual review |
| `MKT-REVIEW-005` | medium | medium | lines longer than 500 characters (possible obfuscation) | CWE-506 | Manual review |
| `MKT-REVIEW-006` | medium | medium | assignment to `__proto__` or `constructor.prototype` | CWE-1321 | Manual review |
| `MKT-REVIEW-007` | low | low | dynamic regular expression from a non-literal value | CWE-1333 | Manual review |

### Composite rules (cross-pattern correlation)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-DATA-003` | high | high | secret source + nearby network sink | CWE-200 | Manual review |
| `MKT-SKILL-001` | high | high | instruction override + destructive/egress guidance | CWE-1039 | Manual review |
| `MKT-CI-001` | high | high | `pull_request_target` + head SHA/ref checkout | CWE-250 | Manual review |
| `MKT-DATA-008` | medium | medium | env secrets + nearby network request | CWE-200 | Manual review |
| `MKT-EXEC-012` | high | high | decode + execute in same file | CWE-94 | Manual review |
| `MKT-FS-005` | high | high | sensitive read + file write in same file | CWE-200 | Manual review |

### Evidence-based risk adjustment

Each finding carries an `evidence_confidence` field (high / medium / low) computed from the matched pattern:

- **High confidence**: explicit dangerous calls and targets (`eval(`, `spawn(`, `shell: true`, `rm -rf`, metadata endpoints, `pull_request_target`, etc.).
- **Test context**: only explicit test-runner syntax or a known test/fixture path can reduce confidence. Incidental words such as `test` in a URL do not.
- **Composite findings**: when both correlated sides match, evidence confidence is high unless the finding is explicitly in test context.

The `risk_adjustment` field documents the reasoning. The rule's original risk is preserved in `evidence_risk`.

### Protection-aware downgrade conditions

File mutations and operating-system process execution begin at **high** baseline risk because they can cause consequential local changes. The final static level is calculated separately and the public receipt includes `baselineRisk`, `protections`, and `downgrade`.

1. If a conventional system-impact pattern is detected in the same production source file, the final level remains high. Examples include destructive recursive deletion of a root/home target, disk formatting, disk-writing, shutdown, or reboot. Protection text does not lower this result.
2. If no system-impact pattern matches, the final level is reduced to medium. This means only that this finite ruleset did not observe such a pattern; it is not a finding of benign intent or safety.
3. The final level is reduced to low only when both relevant controls are statically observed near the same capability call site:
   - File mutation: an explicit user-approval mechanism and a workspace-path boundary.
   - Process execution: an explicit user-approval mechanism and a fixed command target through `execFile` or `spawn`.

The scanner ignores test and fixture paths for these protection-aware capability findings. It does not infer protection from README text, comments, variable names alone, or a generic "safe" claim. Dynamic execution, remote download-and-execute, credential exposure, persistence, lifecycle scripts, and other direct high-risk rules are not eligible for this downgrade.

### Agent and skill safeguards

`MKT-SKILL-001` applies only to conventional agent-instruction filenames such as `SKILL.md`, `AGENTS.md`, and `CLAUDE.md`. It requires both instruction-override language and destructive or external-action guidance. `MKT-HIJACK-*` rules apply to code files and detect prompt injection patterns in source code. Both prevent ordinary security documentation, tests, examples, or a single phrase from being labeled as an agent attack.

### Correlation safeguards

`MKT-DATA-003` and `MKT-DATA-008` are mutually exclusive: one correlated finding is emitted per production file, and the environment-specific rule is used when a sensitive `process.env` access is present. The two signals must occur within a bounded call-site window; a secret lookup in one unrelated function and a network call elsewhere is not sufficient. The scanner intentionally does not emit a finding for an environment lookup or a network API alone.

## Bounds and coverage

The scanner reads eligible production code, manifest, workflow, and conventional agent-instruction files, including generated `dist/` and `build/` install artifacts. Test, fixture, contract, mock, spec, example, and integration paths are excluded from production code rules. It skips dependency/cache directories, reads at most 8,000 files, reads at most 1 MiB per file, emits at most 300 findings, and emits at most one occurrence of the same rule in one file. Any bound hit produces `incomplete` status.

The marketplace security queue treats receipts older than 24 hours as stale and increases the default batch size to 12. Receipt merging is monotonic by `checkedAt`; an older receipt cannot replace a newer commit, and missing compatibility evidence clears an older compatibility label.

Binary analysis, AST/data-flow analysis, SBOM vulnerability resolution, reputation checks, runtime network capture, permission necessity, authorization correctness, and human intent are outside this source-only scanner. Those concerns require separate dynamic analysis, repository metadata, or manual review.

## Versioning and migration

`scannerVersion: 13` and `rulesetVersion: 2026-21` mark the current evidence-oriented ruleset. Existing receipts remain displayable, but new scans use the expanded `MKT-*` ruleset with evidence-oriented fields (`impact`, `attack_vector`, `cwe`, `evidence_confidence`, `risk_adjustment`). A later scanner/ruleset revision must document added, removed, or reclassified rules here before it is published.

### Changes from 2026-20 to 2026-21

**Added rules:**
- `MKT-EXEC-013`: shell-enabled process APIs and command-template helpers.
- `MKT-DATA-010`: cloud metadata addresses and non-HTTP SSRF-capable schemes used as network destinations.
- `MKT-SUPPLY-004`: mutable remote archive dependencies.
- `MKT-CI-009` and `MKT-CI-010`: sensitive write scopes and direct event-text shell interpolation.
- `MKT-REVIEW-006` and `MKT-REVIEW-007`: prototype-pollution assignments and dynamic regular expressions.

**Accuracy corrections:**
- `actions/checkout` is evaluated by YAML step boundaries, so multiline `persist-credentials: false` is honored.
- `pull_request_target` is high risk only when an untrusted PR head/repository is correlated to an `actions/checkout` step; unrelated head-ref use remains a medium review lead.
- Download integrity is correlated to the downloaded artifact; a checksum for another file no longer suppresses the finding.
- Ordinary workflow API requests are not treated as artifact downloads.
- Git dependencies pinned to a full 40-character commit are not reported as mutable.
- `WebAssembly.validate`, `Memory`, and `Table` are not treated as code execution; compile/instantiate remain high.
- Sensitive-read plus file-write correlation uses a bounded 500-character window.
- Capability findings reach low risk only when an actual approval guard and the rule-specific boundary control are both near every call; helper declarations alone do not count as approval.

The 2026-20 correction remains in force: sensitive environment variables combined with a nearby ordinary network request are a medium review lead. Common API-backed plugins need this capability; high risk requires a hardcoded credential, credential-store read, suspicious destination, or an explicit execution/destructive chain.
