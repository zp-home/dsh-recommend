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

The index never publishes source excerpts, local paths, logs, credentials, or execution output. Findings are length-bounded and schema-validated before publication.

## Outcome model

- **No static rule match**: no current risk rule matched in the files read. This is not proof of safety.
- **Low / medium / high risk rule match**: one or more source-only review rules matched. The label is the highest observed risk, not a malware verdict.
- **Scan incomplete**: a file, file-count, or finding limit was reached. The highest observed risk remains visible, but undisplayed matches may remain.
- **No static advisory**: no valid receipt exists for the displayed revision.

A normal capability such as `fetch()`, `process.env`, base64 decoding, or a process API import is not by itself treated as a risk verdict. V2 uses narrow direct rules and correlated patterns instead.

## Ruleset 2026-11

| ID | Family | Baseline | Final level | Trigger | Suggested handling |
|---|---|---:|---:|---|---|
| `MKT-EXEC-001` | execution | high | high / medium / low | OS process launch API, protection-aware | Manual review |
| `MKT-FS-001` | file-system | high | high / medium / low | File-system mutation API, protection-aware | Manual review |
| `MKT-EXEC-002` | execution | high | high | `eval()` or `Function()` | Manual review |
| `MKT-EXEC-003` | execution | high | high | download-and-execute shell or PowerShell pattern | Manual review |
| `MKT-DATA-001` | data-egress | high | high | value shaped like a private key or provider token | Rotate and review |
| `MKT-DATA-002` | transport | medium | medium | plaintext HTTP or disabled TLS verification | Manual review |
| `MKT-DATA-003` | data-egress | high | high | likely secret source and network sink in one code file | Manual review |
| `MKT-PERSIST-001` | persistence | high | high | OS persistence/autostart mechanism | Manual review |
| `MKT-SUPPLY-001` | supply-chain | high | high | non-empty npm install lifecycle script | Manual review |
| `MKT-MAN-001` | manifest | medium | medium | invalid root `package.json` | Fix before review |
| `MKT-REVIEW-001` | reviewability | medium | medium | decode-then-dynamic-execution chain | Manual review |
| `MKT-SKILL-001` | agent-skill | high | high | skill instruction override language combined with destructive or external-action guidance | Manual review |
| `MKT-CI-001` | ci-integrity | high | high | `pull_request_target` plus pull-request head checkout | Manual review |

### Protection-aware downgrade conditions

File mutations and operating-system process execution begin at **high** baseline risk because they can cause consequential local changes. The final static level is calculated separately and the public receipt includes `baselineRisk`, `protections`, and `downgrade`.

1. If a conventional system-impact pattern is detected in the same production source file, the final level remains high. Examples include destructive recursive deletion of a root/home target, disk formatting, disk-writing, shutdown, or reboot. Protection text does not lower this result.
2. If no system-impact pattern matches, the final level is reduced to medium. This means only that this finite ruleset did not observe such a pattern; it is not a finding of benign intent or safety.
3. The final level is reduced to low only when both relevant controls are statically observed in the same production source file:
   - File mutation: an explicit user-approval mechanism and a workspace-path boundary.
   - Process execution: an explicit user-approval mechanism and a fixed command target through `execFile` or `spawn`.

The scanner ignores test and fixture paths for these protection-aware capability findings. It does not infer protection from README text, comments, tool names, or a generic "safe" claim. Dynamic execution, remote download-and-execute, credential exposure, persistence, lifecycle scripts, and other direct high-risk rules are not eligible for this downgrade.

### Agent and skill safeguards

`MKT-SKILL-001` applies only to conventional agent-instruction filenames such as `SKILL.md`, `AGENTS.md`, and `CLAUDE.md`. It requires both instruction-override language and destructive or external-action guidance. This prevents ordinary security documentation, tests, examples, or a single phrase from being labeled as an agent attack.

### Correlation safeguards

`MKT-DATA-003` requires both a likely secret source and a network API in the same code file. It is a review lead, not proof that a secret leaves the device. The scanner intentionally does not emit a finding for an environment lookup or a network API alone.

## Bounds and coverage

The scanner reads eligible code, manifest, workflow, and conventional agent-instruction files. It skips dependency/cache directories, reads at most 5,000 files, reads at most 1 MiB per file, emits at most 200 findings, and emits at most three occurrences of the same rule in one file. Any bound hit produces `incomplete` status.

Binary analysis, AST/data-flow analysis, SBOM vulnerability resolution, reputation checks, runtime network capture, permission necessity, authorization correctness, and human intent are outside this source-only scanner. Those concerns require separate dynamic analysis, repository metadata, or manual review.

## Versioning and migration

`scannerVersion: 3` and `rulesetVersion: 2026-11` mark the protection-aware redesign. Existing receipts remain displayable, but new scans use stable `MKT-*` IDs and the richer evidence contract. A later scanner/ruleset revision must document added, removed, or reclassified rules here before it is published.
