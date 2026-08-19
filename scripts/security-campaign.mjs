/**
 * security-campaign.mjs - Run a bounded source-only marketplace scan campaign.
 * Target repositories are cloned without credentials and their code is never run.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { mergeSecurityReceipts } from './merge-security-receipts.mjs'
import { selectSecurityTargets } from './security-queue.mjs'
import { scanPluginSource, validateCompatibilityAttestationForSource } from './static-security.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const execFile = promisify(execFileCallback)
const BATCH_SIZE = 12
const MAX_BATCHES = 100

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function targetReceipt(target, root, sequence) {
  const source = join(root, `${String(sequence).padStart(4, '0')}-${target.id}`)
  const gitOptions = {
    cwd: root,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024,
  }

  try {
    await execFile('git', [
      '-c', 'credential.helper=',
      '-c', 'http.https://github.com/.extraheader=',
      '-c', 'filter.lfs.smudge=',
      '-c', 'filter.lfs.required=false',
      'clone', '--depth', '1', '--no-tags', '--no-recurse-submodules',
      `https://github.com/${target.fullName}.git`, source,
    ], gitOptions)
    const { stdout } = await execFile('git', ['-C', source, 'rev-parse', 'HEAD'], gitOptions)
    const commit = stdout.trim()
    const receipt = await scanPluginSource(source, { repository: target.fullName, commit })
    const compatibility = await readJson(join(source, '.dsh', 'compatibility.json'), null)
    const attestation = await validateCompatibilityAttestationForSource(source, compatibility, commit, target.fullName)
    if (attestation !== null) receipt.publisherCompatibility = attestation
    return receipt
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

async function main() {
  const batches = boundedInteger(arg('--batches'), 1, 1, MAX_BATCHES)
  const concurrency = boundedInteger(arg('--concurrency'), BATCH_SIZE, 1, BATCH_SIZE)
  const limit = batches * BATCH_SIZE
  const registry = await readJson(arg('--registry') ?? join(ROOT, 'data', 'registry.json'), { plugins: [] })
  const verificationPath = arg('--verification') ?? join(ROOT, 'data', 'verification.json')
  const index = process.argv.includes('--force') ? { plugins: {} } : await readJson(verificationPath, { plugins: {} })
  const targets = selectSecurityTargets(registry.plugins, index, limit)
  const receiptDir = arg('--receipts') ?? join(ROOT, 'tmp-security-receipts')
  const out = arg('--out') ?? verificationPath
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-security-campaign-'))
  const receipts = []
  let next = 0
  let failures = 0

  await mkdir(receiptDir, { recursive: true })
  try {
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= targets.length) return
        const target = targets[index]
        try {
          const receipt = await targetReceipt(target, tempRoot, index)
          receipts.push(receipt)
          await writeFile(join(receiptDir, `${String(index).padStart(4, '0')}-${target.id}.json`), `${JSON.stringify(receipt)}\n`, 'utf8')
          console.log(`completed ${index + 1}/${targets.length}: ${target.fullName}`)
        } catch {
          failures += 1
          console.warn(`failed ${index + 1}/${targets.length}: ${target.fullName}`)
        }
      }
    })
    await Promise.all(workers)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }

  const merged = mergeSecurityReceipts(await readJson(out, {}), receipts)
  await writeFile(out, `${JSON.stringify({ format: merged.format, updatedAt: merged.updatedAt, plugins: merged.plugins }, null, 2)}\n`, 'utf8')
  console.log(`campaign batches=${batches} requested=${limit} selected=${targets.length} completed=${receipts.length} failed=${failures} concurrency=${concurrency} merged=${merged.merged}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
