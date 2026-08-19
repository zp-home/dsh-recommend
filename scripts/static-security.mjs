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
export const SCANNER_VERSION = 1
export const RULESET_VERSION = '2026-09'
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 5000
// Generated plugin bundles are part of the install surface, so lib/ and dist/
// are intentionally scanned. Only dependency/cache directories are excluded.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', '.next', '.turbo'])
const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx', '.json', '.yml', '.yaml', '.sh', '.ps1', '.cmd', '.bat'])

const RULES = [
  { id: 'process-execution', risk: 'high', expression: /\b(?:child_process|execFileSync?|execSync|spawnSync?|fork)\b/g, message: 'starts an OS process' },
  { id: 'dynamic-code', risk: 'medium', expression: /\b(?:eval|Function)\s*\(/g, message: 'evaluates dynamically generated code' },
  { id: 'credential-access', risk: 'medium', expression: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|process\.env|credentials?\.ya?ml)\b/g, message: 'reads a process environment or credential source' },
  { id: 'network-access', risk: 'medium', expression: /\b(?:fetch|https?\.request|WebSocket)\s*\(/g, message: 'opens a network connection' },
  { id: 'persistence', risk: 'high', expression: /\b(?:schtasks|crontab|startup|RunOnce|LaunchAgents)\b/gi, message: 'references an operating-system persistence mechanism' },
  { id: 'obfuscation', risk: 'medium', expression: /\b(?:atob|Buffer\.from)\s*\([^\n]{0,160}base64|String\.fromCharCode\s*\(/g, message: 'contains a common code-obfuscation primitive' },
]

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length
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
        findings.push({ rule: 'install-lifecycle', risk: 'high', file, line: 1, message: `declares a ${name} lifecycle script` })
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
        findings.push({ rule: 'invalid-manifest', risk: 'medium', file: display, line: 1, message: 'package.json is not valid JSON' })
      }
    }
    for (const rule of RULES) {
      rule.expression.lastIndex = 0
      for (;;) {
        const match = rule.expression.exec(text)
        if (match === null) break
        findings.push({ rule: rule.id, risk: rule.risk, file: display, line: lineOf(text, match.index), message: rule.message })
        if (findings.length >= 200) break
      }
      if (findings.length >= 200) break
    }
    if (findings.length >= 200) break
  }
  const risk = riskFrom(findings)
  const truncated = sourceTruncated || findings.length >= 200
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
