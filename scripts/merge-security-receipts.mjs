/**
 * merge-security-receipts.mjs - Merge source-only GitHub Actions receipts into
 * the public marketplace verification index. No target repository code runs.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORMAT = 'dsh-plugin-verification/v1'
const INDEX_FORMAT = 'dsh-plugin-verification-index/v1'
const NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

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
    && typeof value.rulesetVersion === 'string'
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
    const compatibility = publisherCompatibility(receipt)
    plugins[receipt.repository] = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      staticSecurity: {
        commit: receipt.commit,
        status: receipt.status,
        risk: receipt.risk,
        checkedAt: receipt.checkedAt,
        scannedFiles: typeof receipt.scannedFiles === 'number' ? receipt.scannedFiles : null,
        findingCount: Array.isArray(receipt.findings) ? receipt.findings.length : null,
        truncated: receipt.truncated === true,
        scannerVersion: receipt.scannerVersion,
        rulesetVersion: receipt.rulesetVersion,
      },
      ...(compatibility !== null ? { publisherCompatibility: compatibility } : {}),
    }
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
  console.log(`merged ${next.merged}/${receipts.length} security receipts into ${out}`)
}
