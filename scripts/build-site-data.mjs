/** Build lightweight static-site indexes from complete auditable data. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function detailName(fullName) {
  return encodeURIComponent(fullName).replaceAll('%', '_')
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

function summary(plugin, verification) {
  const security = verification?.staticSecurity ?? plugin.verification?.staticSecurity ?? null
  return {
    fullName: plugin.fullName, rank: plugin.rank ?? null, score: plugin.score,
    url: plugin.url, description: plugin.description, stars: plugin.stars,
    category: plugin.category, topics: plugin.topics, license: plugin.license,
    homepage: plugin.homepage, createdAt: plugin.createdAt, pushedAt: plugin.pushedAt,
    excluded: plugin.excluded, scanStatus: plugin.scanStatus, certified: plugin.certified,
    signals: plugin.signals,
    verification: security ? { staticSecurity: {
      commit: security.commit, status: security.status, risk: security.risk,
      checkedAt: security.checkedAt, findingCount: security.findingCount,
      truncated: security.truncated === true, scannerVersion: security.scannerVersion,
      rulesetVersion: security.rulesetVersion,
    }, publisherCompatibility: verification?.publisherCompatibility ?? plugin.verification?.publisherCompatibility ?? null } : null,
    securityDetail: verification?.staticSecurity ? `security/${detailName(plugin.fullName)}.json` : null,
  }
}

export async function buildSiteData({ dataDir = join(ROOT, 'data') } = {}) {
  const registry = await readJson(join(dataDir, 'registry.json'), { meta: {}, plugins: [] })
  const verification = await readJson(join(dataDir, 'verification.json'), { plugins: {} })
  const output = join(dataDir, 'site')
  const securityDir = join(output, 'security')
  await mkdir(securityDir, { recursive: true })
  const entries = verification?.plugins && typeof verification.plugins === 'object' ? verification.plugins : {}
  const plugins = (registry.plugins ?? []).map((plugin) => summary(plugin, entries[plugin.fullName]))
  await writeFile(join(output, 'index.json'), JSON.stringify({ format: 'dsh-site-index/v1', meta: registry.meta, plugins }) + '\n', 'utf8')
  await Promise.all(Object.entries(entries).map(async ([fullName, value]) => {
    if (!value?.staticSecurity) return
    await writeFile(join(securityDir, `${detailName(fullName)}.json`), JSON.stringify({ format: 'dsh-site-security/v1', fullName, verification: value }) + '\n', 'utf8')
  }))
  return { plugins: plugins.length, details: Object.keys(entries).length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildSiteData()
  console.log(`site index plugins=${result.plugins} securityDetails=${result.details}`)
}
