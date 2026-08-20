/**
 * merge-security-receipts.mjs - Merge source-only GitHub Actions receipts into
 * the public marketplace verification index. No target repository code runs.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSiteData } from './build-site-data.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORMAT = 'dsh-plugin-verification/v1'
const INDEX_FORMAT = 'dsh-plugin-verification-index/v1'
const NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i
const RULE_PATTERN = /^(?:MKT-[A-Z]+-\d{3}|[a-z][a-z0-9-]{0,63})$/
const RISK_VALUES = new Set(['low', 'medium', 'high'])

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
}

/** Preserve only bounded, source-location evidence safe for the public index.
 * Source excerpts (evidence field) are intentionally NOT published. */
function publicFindings(receipt) {
  if (!Array.isArray(receipt.findings)) return []
  return receipt.findings.slice(0, 300).flatMap((finding) => {
    if (!finding || typeof finding !== 'object') return []
    if (typeof finding.rule !== 'string' || !RULE_PATTERN.test(finding.rule)) return []
    if (typeof finding.risk !== 'string' || !RISK_VALUES.has(finding.risk)) return []
    if (!safeRelativePath(finding.file)) return []
    if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > 1_000_000) return []
    if (typeof finding.message !== 'string' || finding.message.length === 0 || finding.message.length > 300 || /[\u0000-\u001f\u007f]/.test(finding.message)) return []
    const detail = (name, limit = 120) => typeof finding[name] === 'string' && finding[name].length > 0 && finding[name].length <= limit
      ? { [name]: finding[name] }
      : {}
    return [{
      rule: finding.rule,
      risk: finding.risk,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      ...detail('family', 64),
      ...detail('confidence', 16),
      ...detail('disposition', 32),
      ...detail('basis', 160),
      ...detail('remediation', 300),
      ...detail('baselineRisk', 16),
      ...detail('protections', 240),
      ...detail('downgrade', 300),
      ...detail('impact', 300),
      ...detail('attack_vector', 300),
      ...detail('cwe', 16),
      ...detail('evidence_risk', 16),
      ...detail('evidence_confidence', 16),
      ...detail('risk_adjustment', 300),
    }]
  })
}

function validReceipt(value) {
  if (!value || typeof value !== 'object') return false
  return value.format === FORMAT
    && value.kind === 'static-security'
    && typeof value.repository === 'string'
    && NAME_PATTERN.test(value.repository)
    && typeof value.commit === 'string'
    && SHA_PATTERN.test(value.commit)
    && (value.status === 'passed' || value.status === 'warnings' || value.status === 'incomplete')
    && (value.risk === 'low' || value.risk === 'medium' || value.risk === 'high')
    && typeof value.checkedAt === 'string'
    && Number.isFinite(Date.parse(value.checkedAt))
    && Number.isInteger(value.scannerVersion)
    && value.scannerVersion > 0
    && typeof value.rulesetVersion === 'string'
    && /^[0-9]{4}-[0-9]{2}$/.test(value.rulesetVersion)
}

/** Validate portable publisher evidence attached by the central source worker. */
function publisherCompatibility(receipt) {
  const value = receipt?.publisherCompatibility
  if (!value || typeof value !== 'object') return null
  if (value.format !== FORMAT || value.kind !== 'baseline-compatibility') return null
  if (value.repository !== receipt.repository || value.commit !== receipt.commit) return null
  if (value.status !== 'passed' || value.profileMode !== 'clean') return null
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null
  return {
    commit: value.commit,
    status: 'passed',
    profileMode: 'clean',
    checkedAt: value.checkedAt,
  }
}

/**
 * Merge only validated receipts, preserving any other verification facets on
 * existing entries. The central scan result is intentionally display-only.
 */
export function mergeSecurityReceipts(existing, receipts, now = new Date().toISOString()) {
  const current = existing && typeof existing === 'object' ? existing : {}
  const plugins = current.plugins && typeof current.plugins === 'object' ? { ...current.plugins } : {}
  let merged = 0
  for (const receipt of receipts) {
    if (!validReceipt(receipt)) continue
    const previous = plugins[receipt.repository]
    const previousCheckedAt = previous?.staticSecurity?.checkedAt
    if (typeof previousCheckedAt === 'string'
      && Number.isFinite(Date.parse(previousCheckedAt))
      && Date.parse(receipt.checkedAt) < Date.parse(previousCheckedAt)) {
      continue
    }
    const compatibility = publisherCompatibility(receipt)
    const nextPlugin = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      staticSecurity: {
        commit: receipt.commit,
        status: receipt.status,
        risk: receipt.risk,
        checkedAt: receipt.checkedAt,
        scannedFiles: typeof receipt.scannedFiles === 'number' ? receipt.scannedFiles : null,
        findingCount: Array.isArray(receipt.findings) ? receipt.findings.length : null,
        findings: publicFindings(receipt),
        truncated: receipt.truncated === true,
        scannerVersion: receipt.scannerVersion,
        rulesetVersion: receipt.rulesetVersion,
      },
    }
    if (compatibility !== null) nextPlugin.publisherCompatibility = compatibility
    else delete nextPlugin.publisherCompatibility
    plugins[receipt.repository] = nextPlugin
    merged += 1
  }
  return { format: INDEX_FORMAT, updatedAt: now, plugins, merged }
}

async function receiptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(directory, entry.name))
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return fallback
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = arg('--dir')
  if (!source) throw new Error('--dir is required')
  const out = arg('--out') ?? join(ROOT, 'data', 'verification.json')
  const files = await receiptFiles(source)
  const receipts = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))))
  const next = mergeSecurityReceipts(await readJson(out, {}), receipts)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({ format: next.format, updatedAt: next.updatedAt, plugins: next.plugins }, null, 2) + '\n', 'utf8')
  await buildSiteData({ dataDir: dirname(out) })
  console.log(`merged ${next.merged}/${receipts.length} security receipts into ${out}`)
}
