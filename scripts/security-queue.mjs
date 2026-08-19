/**
 * security-queue.mjs - Select a small, deterministic batch of marketplace
 * repositories for source-only GitHub Actions security scanning.
 *
 * This script never fetches a plugin. The GitHub workflow checks out the
 * selected public repository without credentials and invokes the trusted
 * static scanner. Results are stored in data/verification.json.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RESCAN_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000
const NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function dateValue(value) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : null
}

function checkedAt(record) {
  return dateValue(record?.staticSecurity?.checkedAt)
}

/**
 * Select records with missing, source-changed, or expired security receipts.
 * Missing records win, then GitHub revisions newer than their receipt. The
 * result is safe for a dynamic Actions matrix and has no shell fragments.
 */
export function selectSecurityTargets(plugins, index, limit, now = Date.now(), intervalMs = DEFAULT_RESCAN_INTERVAL_MS) {
  const records = index?.plugins && typeof index.plugins === 'object' ? index.plugins : {}
  const candidates = (Array.isArray(plugins) ? plugins : [])
    .filter((plugin) => plugin && !plugin.excluded && typeof plugin.fullName === 'string' && NAME_PATTERN.test(plugin.fullName))
    .map((plugin) => {
      const checked = checkedAt(records[plugin.fullName])
      const pushed = dateValue(plugin.pushedAt)
      const age = checked === null ? Number.POSITIVE_INFINITY : Math.max(0, now - checked)
      const changed = checked !== null && pushed !== null && pushed > checked
      return { plugin, age, missing: checked === null, changed }
    })
    .filter((entry) => entry.missing || entry.changed || entry.age >= intervalMs)
    .sort((left, right) => {
      if (left.missing !== right.missing) return left.missing ? -1 : 1
      if (left.changed !== right.changed) return left.changed ? -1 : 1
      if (right.plugin.score !== left.plugin.score) return (right.plugin.score ?? 0) - (left.plugin.score ?? 0)
      return (right.plugin.pushedAt ?? '').localeCompare(left.plugin.pushedAt ?? '')
    })
    .slice(0, Math.max(0, Math.min(20, Number(limit) || 0)))

  return candidates.map(({ plugin }) => ({
    fullName: plugin.fullName,
    id: plugin.fullName.replace(/[^A-Za-z0-9_.-]/g, '-'),
  }))
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
  const limit = arg('--limit') ?? '6'
  const registry = await readJson(arg('--registry') ?? join(ROOT, 'data', 'registry.json'), { plugins: [] })
  const index = await readJson(arg('--verification') ?? join(ROOT, 'data', 'verification.json'), { plugins: {} })
  const targets = selectSecurityTargets(registry.plugins, index, limit)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(output, `targets=${JSON.stringify(targets)}\nhasTargets=${targets.length > 0}\n`, 'utf8')
  } else {
    process.stdout.write(`${JSON.stringify(targets)}\n`)
  }
}
