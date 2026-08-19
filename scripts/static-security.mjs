/**
 * static-security.mjs - zero-dependency source-only plugin security scanner.
 *
 * This scanner never installs dependencies or imports a target plugin. It is
 * intended for a GitHub Actions checkout and writes a small, versioned receipt
 * that the marketplace can later read from a completed Actions check run.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FORMAT = 'dsh-plugin-verification/v1'
export const SCANNER_VERSION = 3
export const RULESET_VERSION = '2026-11'
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 5000
const MAX_FINDINGS = 200
const MAX_MATCHES_PER_RULE_FILE = 3
// Generated plugin bundles are part of the install surface, so lib/ and dist/
// are intentionally scanned. Only dependency/cache directories are excluded.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', '.next', '.turbo'])
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx', '.sh', '.ps1', '.cmd', '.bat'])
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.yml', '.yaml', '.md'])
const SKILL_FILE = /(?:^|\/)(?:SKILL|AGENTS|CLAUDE)\.md$/i
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i

// Rules are source-only leads, not exploit findings. A single capability such
// as fetch() or process.env is deliberately not a risk finding on its own.
const RULES = [
  { id: 'MKT-EXEC-002', family: 'execution', risk: 'high', confidence: 'high', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Remove dynamic evaluation and use fixed allowlisted implementations.', expression: /\b(?:eval|Function)\s*\(/g, message: 'evaluates dynamically generated JavaScript' },
  { id: 'MKT-EXEC-003', family: 'execution', risk: 'high', confidence: 'high', disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet', remediation: 'Do not execute code downloaded at runtime; pin and review shipped code.', expression: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]{0,180}\|\s*(?:sh|bash|zsh|pwsh|powershell)|\b(?:IEX|Invoke-Expression)\b/g, message: 'contains a download-and-execute command pattern' },
  { id: 'MKT-DATA-001', family: 'data-egress', risk: 'high', confidence: 'high', disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet', remediation: 'Remove embedded credentials, rotate exposed secrets, and load them only from a protected secret store.', expression: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|(?:github_pat|ghp|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/g, message: 'contains a value shaped like a private credential' },
  { id: 'MKT-DATA-002', family: 'transport', risk: 'medium', confidence: 'high', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Use HTTPS and keep TLS certificate verification enabled.', expression: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]?0|http:\/\/(?!localhost\b|127\.0\.0\.1\b)/g, message: 'disables TLS verification or references plaintext HTTP transport' },
  { id: 'MKT-PERSIST-001', family: 'persistence', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Document and require explicit user approval for persistent operating-system changes.', expression: /\b(?:schtasks|crontab|RunOnce|LaunchAgents|systemctl\s+enable)\b/gi, message: 'references an operating-system persistence mechanism' },
  { id: 'MKT-REVIEW-001', family: 'reviewability', risk: 'medium', confidence: 'low', disposition: 'manual-review', basis: 'OpenSSF npm supply-chain practices', remediation: 'Ship readable source or document generated artifacts and their reproducible build inputs.', expression: /\b(?:atob|Buffer\.from)\s*\([^\n]{0,160}base64[^\n]{0,160}\)\s*(?:;|\.)[^\n]{0,160}\b(?:eval|Function)\s*\(/g, message: 'decodes encoded content before dynamic execution' },
]

const COMPOSITE_RULES = {
  secretEgress: { id: 'MKT-DATA-003', family: 'data-egress', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP MCP Security Cheat Sheet', remediation: 'Keep secrets out of agent-visible output and require an allowlisted destination before egress.', message: 'reads a likely secret source and opens a network connection in the same source file' },
  skillHijack: { id: 'MKT-SKILL-001', family: 'agent-skill', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Top 10 for LLM Applications', remediation: 'Treat external content as data, preserve approval boundaries, and remove instruction-override or concealment directives.', message: 'contains instruction override language together with destructive or external-action guidance' },
  dangerousWorkflow: { id: 'MKT-CI-001', family: 'ci-integrity', risk: 'high', confidence: 'high', disposition: 'manual-review', basis: 'OpenSSF Scorecards', remediation: 'Do not check out untrusted pull-request code in pull_request_target workflows.', message: 'uses pull_request_target with a pull-request head checkout reference' },
}

const SECRET_SOURCE = /\b(?:process\.env|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|\.env|\.npmrc|\.ssh|credentials?\.ya?ml)\b/i
const NETWORK_SINK = /\b(?:fetch|https?\.request|WebSocket)\s*\(/i
const INSTRUCTION_OVERRIDE = /\b(?:ignore|override|disregard)\b[^\n]{0,120}\b(?:previous|system|developer|approval|sandbox|guardrail|instruction)/i
const DESTRUCTIVE_OR_EGRESS_GUIDANCE = /\b(?:rm\s+-rf|git\s+reset\s+--hard|curl|wget|upload|webhook|pastebin|do not ask|auto-approve)\b/i
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const DESTRUCTIVE_SYSTEM = /\b(?:rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$HOME)|Remove-Item\b[^\n]{0,120}-Recurse\b[^\n]{0,120}(?:[A-Za-z]:|\\)|\b(?:format|diskpart|mkfs(?:\.\w+)?|shutdown|reboot)\b|\bdd\s+if=[^\n]{0,80}\bof=\/dev\/)/i
const EXPLICIT_APPROVAL = /\b(?:ask_user_question|requestApproval|requires?Approval|confirm(?:ation)?|prompt)\b/i
const WORKSPACE_BOUNDARY = /\b(?:workspace(?:Root|Path|Dir)?|isWithinWorkspace|path\.relative|relative\([^\n]{0,120}workspace|startsWith\([^\n]{0,120}workspace)\b/i
const FIXED_COMMAND = /\b(?:execFile(?:Sync)?|spawn(?:Sync)?)\s*\(\s*['\"][^'\"]+['\"]/i
const CAPABILITY_RULES = {
  execution: { id: 'MKT-EXEC-001', family: 'execution', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Require explicit user approval and use a fixed allowlisted command with bounded arguments.', message: 'invokes an operating-system process API' },
  fileWrite: { id: 'MKT-FS-001', family: 'file-system', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Require explicit user approval and restrict mutations to an allowlisted workspace path.', message: 'invokes a file-system mutation API' },
}
const EXECUTION_CALL = /\b(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|fork)\s*\(/g
const FILE_MUTATION_CALL = /\b(?:writeFile|appendFile|copyFile|rename|mkdir|chmod|truncate|unlink|rm|rmdir)\s*\(|\b(?:Set-Content|Add-Content|Remove-Item|New-Item)\b/g
const MANIFEST_RULES = {
  lifecycle: { id: 'MKT-SUPPLY-001', family: 'supply-chain', risk: 'high', confidence: 'high', disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet', remediation: 'Remove install-time side effects or document and review each lifecycle script.', message: 'declares an install lifecycle script' },
  invalid: { id: 'MKT-MAN-001', family: 'manifest', risk: 'medium', confidence: 'high', disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet', remediation: 'Publish a valid manifest so install behavior can be reviewed.', message: 'package.json is not valid JSON' },
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function makeFinding(rule, file, line, message = rule.message, details = {}) {
  return {
    rule: rule.id,
    family: rule.family,
    risk: rule.risk,
    confidence: rule.confidence,
    disposition: rule.disposition,
    basis: rule.basis,
    remediation: rule.remediation,
    file,
    line,
    message,
    ...details,
  }
}

function capabilityFinding(rule, text, file, line, requiredBoundary, message) {
  const protections = []
  const destructive = DESTRUCTIVE_SYSTEM.test(text)
  const approved = EXPLICIT_APPROVAL.test(text)
  const bounded = requiredBoundary.test(text)
  let risk = 'high'
  let downgrade = 'No downgrade: a system-impact pattern is present in the same source file.'
  if (!destructive) {
    risk = 'medium'
    downgrade = 'Downgraded from high: no system-impact pattern matched this ruleset.'
    if (approved && bounded) {
      risk = 'low'
      protections.push('explicit user approval', rule.id === 'MKT-EXEC-001' ? 'fixed command target' : 'workspace path boundary')
      downgrade = `Downgraded from high: no system-impact pattern matched; ${protections.join(' and ')} detected.`
    } else {
      if (approved) protections.push('explicit user approval')
      if (bounded) protections.push(rule.id === 'MKT-EXEC-001' ? 'fixed command target' : 'workspace path boundary')
    }
  }
  return makeFinding(rule, file, line, message, {
    risk,
    baselineRisk: 'high',
    protections: protections.join(', '),
    downgrade,
  })
}

function capabilityFindings(text, file) {
  if (TEST_PATH.test(file)) return []
  const findings = []
  for (const [rule, expression, boundary] of [
    [CAPABILITY_RULES.execution, EXECUTION_CALL, FIXED_COMMAND],
    [CAPABILITY_RULES.fileWrite, FILE_MUTATION_CALL, WORKSPACE_BOUNDARY],
  ]) {
    expression.lastIndex = 0
    let matches = 0
    for (;;) {
      const match = expression.exec(text)
      if (match === null || matches >= MAX_MATCHES_PER_RULE_FILE) break
      findings.push(capabilityFinding(rule, text, file, lineOf(text, match.index), boundary))
      matches += 1
    }
  }
  return findings
}

function compositeFindings(text, file) {
  const findings = []
  if (CODE_EXTENSIONS.has(extname(file).toLowerCase()) && SECRET_SOURCE.test(text) && NETWORK_SINK.test(text)) {
    findings.push(makeFinding(COMPOSITE_RULES.secretEgress, file, 1))
  }
  if (SKILL_FILE.test(file) && INSTRUCTION_OVERRIDE.test(text) && DESTRUCTIVE_OR_EGRESS_GUIDANCE.test(text)) {
    findings.push(makeFinding(COMPOSITE_RULES.skillHijack, file, 1))
  }
  if (WORKFLOW_FILE.test(file) && /\bpull_request_target\b/.test(text) && /github\.event\.pull_request\.head\.(?:sha|ref)/.test(text)) {
    findings.push(makeFinding(COMPOSITE_RULES.dangerousWorkflow, file, 1))
  }
  return findings
}

function rank(risk) {
  return risk === 'high' ? 2 : risk === 'medium' ? 1 : 0
}

function riskFrom(findings) {
  let highest = 'low'
  for (const finding of findings) {
    if (rank(finding.risk) > rank(highest)) highest = finding.risk
  }
  return highest
}

function statusFrom(risk) {
  return risk === 'low' ? 'passed' : 'warnings'
}

function likelyText(buffer) {
  return !buffer.includes(0)
}

async function sourceFiles(root) {
  const files = []
  let truncated = false
  async function visit(directory) {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name))
      } else if (entry.isFile() && (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) || entry.name === 'package.json')) {
        const path = join(directory, entry.name)
        const info = await stat(path)
        if (info.size <= MAX_FILE_BYTES) files.push(path)
        else truncated = true
      }
    }
  }
  await visit(root)
  return { files, truncated }
}

function scanManifest(manifest, file) {
  const findings = []
  const scripts = manifest?.scripts
  if (scripts && typeof scripts === 'object') {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') {
        findings.push(makeFinding(MANIFEST_RULES.lifecycle, file, 1, `declares a ${name} lifecycle script`))
      }
    }
  }
  return findings
}

/** Scan local source files without evaluating any target code. */
export async function scanPluginSource(root, { commit = null, repository = null } = {}) {
  const { files, truncated: sourceTruncated } = await sourceFiles(root)
  const findings = []
  for (const file of files) {
    const body = await readFile(file)
    if (!likelyText(body)) continue
    const text = body.toString('utf8')
    const display = relative(root, file).replaceAll('\\', '/')
    if (display === 'package.json') {
      try {
        findings.push(...scanManifest(JSON.parse(text.replace(/^\uFEFF/, '')), display))
      } catch {
        findings.push(makeFinding(MANIFEST_RULES.invalid, display, 1))
      }
    }
    findings.push(...compositeFindings(text, display))
    if (CODE_EXTENSIONS.has(extname(display).toLowerCase())) {
      findings.push(...capabilityFindings(text, display))
      for (const rule of RULES) {
        rule.expression.lastIndex = 0
        let matches = 0
        for (;;) {
          const match = rule.expression.exec(text)
          if (match === null || matches >= MAX_MATCHES_PER_RULE_FILE) break
          findings.push(makeFinding(rule, display, lineOf(text, match.index)))
          matches += 1
          if (findings.length >= MAX_FINDINGS) break
        }
        if (findings.length >= MAX_FINDINGS) break
      }
    }
    if (findings.length >= MAX_FINDINGS) break
  }
  const risk = riskFrom(findings)
  const truncated = sourceTruncated || findings.length >= MAX_FINDINGS
  return {
    format: FORMAT,
    kind: 'static-security',
    repository,
    commit,
    checkedAt: new Date().toISOString(),
    scannerVersion: SCANNER_VERSION,
    rulesetVersion: RULESET_VERSION,
    status: truncated ? 'incomplete' : statusFrom(risk),
    risk,
    scannedFiles: files.length,
    findings,
    truncated,
  }
}

/** Validate a publisher's dsh-dev-sandbox compatibility receipt. */
export function readCompatibilityAttestation(value, commit, repository = null) {
  if (!value || typeof value !== 'object') return null
  if (value.format !== FORMAT || value.kind !== 'baseline-compatibility') return null
  if (value.commit !== commit || value.result !== 'passed' || value.profileMode !== 'clean') return null
  if (repository !== null && value.repository !== repository) return null
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null
  if (!value.plugin || typeof value.plugin !== 'object' || !/^[a-f0-9]{64}$/i.test(value.plugin.sourceFingerprint ?? '')) return null
  return {
    format: FORMAT,
    kind: 'baseline-compatibility',
    repository: repository ?? value.repository ?? null,
    commit,
    checkedAt: value.checkedAt,
    status: 'passed',
    profileMode: 'clean',
    pluginName: typeof value.plugin.name === 'string' ? value.plugin.name : null,
    sourceFingerprint: value.plugin.sourceFingerprint,
  }
}

/** Bind a sandbox receipt to the checked target's package manifest. */
export async function validateCompatibilityAttestationForSource(root, value, commit, repository = null) {
  const attestation = readCompatibilityAttestation(value, commit, repository)
  if (attestation === null) return null
  try {
    const manifestText = await readFile(join(root, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''))
    if (typeof manifest?.name !== 'string' || manifest.name !== attestation.pluginName) return null
    const fingerprint = createHash('sha256').update(manifestText).digest('hex')
    if (fingerprint !== attestation.sourceFingerprint) return null
  } catch {
    return null
  }
  const { pluginName, sourceFingerprint, ...portable } = attestation
  return portable
}

/** Marker embedded into an Actions check summary and consumed through GitHub's API. */
export function formatCheckMarker(receipt) {
  return `<!-- dsh-plugin-verification:${JSON.stringify(receipt)} -->`
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = arg('--path') ?? process.cwd()
  const commit = arg('--commit') ?? process.env.GITHUB_SHA ?? null
  const repository = arg('--repository') ?? process.env.GITHUB_REPOSITORY ?? null
  const out = arg('--out')
  const compatibilityPath = arg('--compatibility')
  const receipt = await scanPluginSource(root, { commit, repository })
  if (compatibilityPath !== undefined) {
    try {
      const compatibility = await validateCompatibilityAttestationForSource(root, JSON.parse(await readFile(compatibilityPath, 'utf8')), commit, repository)
      if (compatibility !== null) receipt.publisherCompatibility = compatibility
    } catch {
      // A receipt is optional; absent or invalid publisher evidence is not a scan failure.
    }
  }
  if (out !== undefined) {
    await writeFile(out, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  }
  console.log(formatCheckMarker(receipt))
  console.log(`static security: ${receipt.status}, risk=${receipt.risk}, findings=${receipt.findings.length}, files=${receipt.scannedFiles}`)
}
