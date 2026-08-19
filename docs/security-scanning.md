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
- Evidence-oriented fields (current ruleset 2026-19):
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

## Ruleset 2026-19

Supersedes `2026-16`. Existing receipts remain displayable; new scans use the expanded ruleset with evidence-oriented fields. The rules below are grouped by family.

### Execution (MKT-EXEC-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-EXEC-001` | high | high / medium / low | OS process launch API, protection-aware | CWE-78 | Manual review |
| `MKT-EXEC-002` | high | high | `eval()` or `Function()` constructor | CWE-95 | Manual review |
| `MKT-EXEC-003` | high | high | download-and-execute shell or PowerShell pattern | CWE-494 | Manual review |
| `MKT-EXEC-004` | high | high | `vm` module sandbox escape (`runInNewContext`, `runInThisContext`) | CWE-94 | Manual review |
| `MKT-EXEC-005` | high | high | `execSync` or `spawnSync` blocking process call | CWE-78 | Manual review |
| `MKT-EXEC-006` | high | high | WebAssembly compilation or instantiation | CWE-94 | Manual review |
| `MKT-EXEC-007` | high | high | Native `.node` addon via `process.dlopen` or `require("*.node")` | CWE-912 | Manual review |
| `MKT-EXEC-008` | high | high | `vm.runInNewContext()` with untrusted data | CWE-94 | Manual review |
| `MKT-EXEC-009` | medium | medium | Dynamic `import()` with variable path | CWE-94 | Manual review |
| `MKT-EXEC-010` | medium | medium | `setTimeout`/`setInterval` with non-literal arguments | CWE-95 | Manual review |
| `MKT-EXEC-012` | high | high | Composite: decode (`atob`/`Buffer.from`) + execute (`eval`/`Function`) in same file | CWE-94 | Manual review |

### Data egress (MKT-DATA-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-DATA-001` | high | high | value shaped like a private key or provider token | CWE-798 | Rotate and review |
| `MKT-DATA-002` | medium | medium | plaintext HTTP or disabled TLS verification | CWE-295 | Manual review |
| `MKT-DATA-003` | high | high | likely secret source and network sink in one code file | CWE-200 | Manual review |
| `MKT-DATA-004` | medium | medium | raw TCP/UDP socket (`net.connect`, `dgram.createSocket`) | CWE-923 | Manual review |
| `MKT-DATA-005` | medium / high | medium / high | reads environment variables (high if combined with network sink) | CWE-532 | Manual review |
| `MKT-DATA-006` | high | high | access to system credential stores (`~/.ssh/id_rsa`, `~/.aws/credentials`) | CWE-200 | Manual review |
| `MKT-DATA-008` | high | high | Composite: environment secrets + network request in same file | CWE-200 | Manual review |
| `MKT-DATA-009` | high | high | executable code patterns (`eval`, `Function`) in README/documentation | CWE-94 | Manual review |

### Agent and skill (MKT-SKILL-* / MKT-HIJACK-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-SKILL-001` | high | high | instruction override language + destructive/egress guidance in agent-instruction files | CWE-1039 | Manual review |
| `MKT-SKILL-002` | high | high | role impersonation ("you are now system/admin") in skill content | CWE-1039 | Manual review |
| `MKT-SKILL-003` | high | high | multi-step prompt injection chain in skill files | CWE-1039 | Manual review |
| `MKT-SKILL-004` | high | high | exfiltration guidance targeting conversation/history/memory | CWE-200 | Manual review |
| `MKT-SKILL-005` | high | high | disabling/bypassing safety features in skill content | CWE-1039 | Manual review |
| `MKT-HIJACK-001` | high | high | prompt injection patterns ("ignore all previous instructions") in code files | CWE-1039 | Manual review |
| `MKT-HIJACK-004` | high | high | tool override directives ("use exec_command instead") in code files | CWE-1039 | Manual review |
| `MKT-HIJACK-005` | high | high | instruction override with specific goal redirection in code files | CWE-1039 | Manual review |

### File system (MKT-FS-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-FS-001` | high | high / medium / low | unbounded file-system mutation API, protection-aware | CWE-73 | Manual review |
| `MKT-FS-002` | high | high | path literal starts with `../` or `/etc/` (workspace escape) | CWE-22 | Manual review |
| `MKT-FS-003` | high | high | reading system credential files (`/etc/passwd`, `~/.ssh/id_rsa`) | CWE-200 | Manual review |
| `MKT-FS-004` | high | high | encoded path traversal (`%2e%2e%2f`) or nested `../..` sequences | CWE-22 | Manual review |
| `MKT-FS-005` | high | high | Composite: sensitive data read + external file write in same file | CWE-200 | Manual review |

### Supply chain (MKT-SUPPLY-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-SUPPLY-001` | high | high | non-empty npm install lifecycle script (`preinstall`/`install`/`postinstall`/`prepare`) | CWE-506 | Manual review |
| `MKT-SUPPLY-002` | high | high | unpinned git/URL dependency (`git+https://`, `github:`) | CWE-494 | Manual review |

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

### Persistence (MKT-PERSIST-*)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-PERSIST-001` | high | high | plugin lifecycle hooks (`install`/`uninstall`/`activate`) | CWE-506 | Manual review |
| `MKT-PERSIST-002` | high | high | writing to startup files (`~/.bashrc`, `~/.zshrc`) | CWE-506 | Manual review |

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
| `MKT-REVIEW-005` | medium | medium | lines longer than 500 characters (possible obfuscation) | CWE-506 | Manual review |

### Composite rules (cross-pattern correlation)

| ID | Baseline | Final level | Trigger | CWE | Suggested handling |
|---|---:|---:|---|---|---|
| `MKT-DATA-003` | high | high | secret source + network sink in one file | CWE-200 | Manual review |
| `MKT-SKILL-001` | high | high | instruction override + destructive/egress guidance | CWE-1039 | Manual review |
| `MKT-CI-001` | high | high | `pull_request_target` + head SHA/ref checkout | CWE-250 | Manual review |
| `MKT-DATA-008` | high | high | env secrets + network request in one file | CWE-200 | Manual review |
| `MKT-EXEC-012` | high | high | decode + execute in same file | CWE-94 | Manual review |
| `MKT-FS-005` | high | high | sensitive read + file write in same file | CWE-200 | Manual review |

### Evidence-based risk adjustment

Each finding carries an `evidence_confidence` field (high / medium / low) computed from the matched pattern:

- **High confidence**: explicit dangerous function calls (`eval(`, `spawn(`, `rm -rf`, `/etc/passwd`, `pull_request_target`, etc.) — risk level is confirmed.
- **Low confidence**: patterns that may appear in benign contexts (`require('./...`, `console.`, `test`, `mock`) — risk level is downgraded by one step (high → medium, medium → low).
- **Composite findings**: when both sides of a composite rule match, evidence confidence is automatically high.

The `risk_adjustment` field documents the reasoning. The rule's original risk is preserved in `evidence_risk`.

### Protection-aware downgrade conditions

File mutations and operating-system process execution begin at **high** baseline risk because they can cause consequential local changes. The final static level is calculated separately and the public receipt includes `baselineRisk`, `protections`, and `downgrade`.

1. If a conventional system-impact pattern is detected in the same production source file, the final level remains high. Examples include destructive recursive deletion of a root/home target, disk formatting, disk-writing, shutdown, or reboot. Protection text does not lower this result.
2. If no system-impact pattern matches, the final level is reduced to medium. This means only that this finite ruleset did not observe such a pattern; it is not a finding of benign intent or safety.
3. The final level is reduced to low only when both relevant controls are statically observed in the same production source file:
   - File mutation: an explicit user-approval mechanism and a workspace-path boundary.
   - Process execution: an explicit user-approval mechanism and a fixed command target through `execFile` or `spawn`.

The scanner ignores test and fixture paths for these protection-aware capability findings. It does not infer protection from README text, comments, tool names, or a generic "safe" claim. Dynamic execution, remote download-and-execute, credential exposure, persistence, lifecycle scripts, and other direct high-risk rules are not eligible for this downgrade.

### Agent and skill safeguards

`MKT-SKILL-001` applies only to conventional agent-instruction filenames such as `SKILL.md`, `AGENTS.md`, and `CLAUDE.md`. It requires both instruction-override language and destructive or external-action guidance. `MKT-HIJACK-*` rules apply to code files and detect prompt injection patterns in source code. Both prevent ordinary security documentation, tests, examples, or a single phrase from being labeled as an agent attack.

### Correlation safeguards

`MKT-DATA-003` requires both a likely secret source and a network API in the same code file. It is a review lead, not proof that a secret leaves the device. The scanner intentionally does not emit a finding for an environment lookup or a network API alone. The same principle applies to all composite rules: both sides must match in the same file.

## Bounds and coverage

The scanner reads eligible production code, manifest, workflow, and conventional agent-instruction files, including generated `dist/` and `build/` install artifacts. Test, fixture, contract, mock, spec, example, and integration paths are excluded from production code rules. It skips dependency/cache directories, reads at most 8,000 files, reads at most 1 MiB per file, emits at most 300 findings, and emits at most one occurrence of the same rule in one file. Any bound hit produces `incomplete` status.

Binary analysis, AST/data-flow analysis, SBOM vulnerability resolution, reputation checks, runtime network capture, permission necessity, authorization correctness, and human intent are outside this source-only scanner. Those concerns require separate dynamic analysis, repository metadata, or manual review.

## Versioning and migration

`scannerVersion: 11` and `rulesetVersion: 2026-19` mark the current evidence-oriented ruleset. Existing receipts remain displayable, but new scans use the expanded `MKT-*` ruleset with evidence-oriented fields (`impact`, `attack_vector`, `cwe`, `evidence_confidence`, `risk_adjustment`). A later scanner/ruleset revision must document added, removed, or reclassified rules here before it is published.

### Changes from 2026-11 to 2026-19

**Added rules:**
- `MKT-EXEC-004` through `MKT-EXEC-012` (vm, execSync, WebAssembly, native addons, dynamic import, setTimeout eval, decode+execute composite)
- `MKT-DATA-004` through `MKT-DATA-009` (raw sockets, env secrets, credential stores, env+network composite, README code execution)
- `MKT-HIJACK-001`, `MKT-HIJACK-004`, `MKT-HIJACK-005` (prompt injection in code files)
- `MKT-SKILL-002` through `MKT-SKILL-005` (role impersonation, multi-step injection, exfiltration guidance, safety bypass)
- `MKT-FS-002` through `MKT-FS-005` (path escape, credential file read, encoded traversal, sensitive read+write composite)
- `MKT-SUPPLY-002` (unpinned git/URL dependencies)
- `MKT-CI-002` through `MKT-CI-008` (token permissions, checkout credentials, curl-pipe, pull_request_target without head, wildcard permissions, unverified downloads)
- `MKT-PERSIST-002` (startup file persistence)
- `MKT-ANALYZE-001` through `MKT-ANALYZE-002` (anti-debugging, stack inspection)
- `MKT-REVIEW-005` (long line obfuscation)

**2026-19 corrections:**
- Production rules exclude documentation, test, fixture, contract, mock, spec, example, and integration paths.
- Sensitive environment access requires a recognizable secret-bearing variable and a network sink in the same production file.
- CI rules inspect workflow files only; Skill rules inspect conventional instruction files only.
- Public evidence retains up to 300 schema-validated findings, matching the scanner bound.
- Standalone Skill exfiltration language is medium risk; only override-plus-destructive/egress composites are high.
- `Proxy` and `Reflect` are not standalone sandbox-escape findings; the high rule requires a constructor-chain pattern.
- Destructive execution and decode-plus-execute composites require both signals within a 150-character call-site window.
- Under `scripts/` and `bin/`, only shell download-and-execute patterns are evaluated; generic credential and environment-variable rules do not run.

**Added finding fields:**
- `impact`, `attack_vector`, `cwe` (evidence-oriented harm description)
- `evidence_risk`, `evidence_confidence`, `risk_adjustment` (evidence-based risk adjustment)
- `evidence` (source excerpt — internal only, stripped from public index)

**No rules removed or reclassified.**
