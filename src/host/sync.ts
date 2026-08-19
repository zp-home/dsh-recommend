import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Upstream publishes every five hours; refresh local snapshots no more than once per six hours. */
export const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface RegistrySyncConfig {
  dataUrl: string
  cachePath: string
  historyUrl?: string
  historyPath?: string
  trendsUrl?: string
  trendsPath?: string
  verificationUrl?: string
  verificationPath?: string
  refreshIntervalMs?: number
}

export interface RegistrySyncResult {
  fetchedAt: string
  count: number
  historyDays: number
  updated: boolean
}

interface RegistryDoc {
  meta?: { generatedAt?: string }
  plugins?: unknown[]
}

interface HistoryDoc {
  days?: unknown[]
}

interface TrendsDoc {
  trends?: unknown[]
}

const activeSyncs = new Map<string, Promise<RegistrySyncResult>>()

function companionPath(cachePath: string, filename: string): string {
  return cachePath.replace(/registry\.json$/, filename)
}

function companionUrl(dataUrl: string, filename: string): string {
  return dataUrl.replace(/registry\.json(?=$|\?)/, filename)
}

function refreshInterval(config: RegistrySyncConfig): number {
  return config.refreshIntervalMs && config.refreshIntervalMs > 0
    ? config.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS
}

/** Returns true when the cache is absent or older than the configured refresh interval. */
export async function isRegistryStale(config: RegistrySyncConfig, now = Date.now()): Promise<boolean> {
  try {
    const info = await stat(config.cachePath)
    return now - info.mtimeMs >= refreshInterval(config)
  } catch {
    return true
  }
}

/**
 * Fetches and validates the shared snapshot once, then updates every available local data file.
 * Concurrent callers sharing a cache path await the same request.
 */
export function syncRegistry(config: RegistrySyncConfig): Promise<RegistrySyncResult> {
  const existing = activeSyncs.get(config.cachePath)
  if (existing) return existing

  const work = downloadRegistry(config)
  activeSyncs.set(config.cachePath, work)
  void work.then(
    () => { if (activeSyncs.get(config.cachePath) === work) activeSyncs.delete(config.cachePath) },
    () => { if (activeSyncs.get(config.cachePath) === work) activeSyncs.delete(config.cachePath) },
  )
  return work
}

/** Refreshes only when no usable cache exists or the local snapshot has reached its TTL. */
export async function syncRegistryIfStale(config: RegistrySyncConfig): Promise<RegistrySyncResult | { updated: false }> {
  if (!(await isRegistryStale(config))) return { updated: false }
  return syncRegistry(config)
}

async function downloadRegistry(config: RegistrySyncConfig): Promise<RegistrySyncResult> {
  const historyPath = config.historyPath ?? companionPath(config.cachePath, 'history.json')
  const trendsPath = config.trendsPath ?? companionPath(config.cachePath, 'trends.json')
  const verificationPath = config.verificationPath ?? companionPath(config.cachePath, 'verification.json')
  const historyUrl = config.historyUrl ?? companionUrl(config.dataUrl, 'history.json')
  const trendsUrl = config.trendsUrl ?? companionUrl(config.dataUrl, 'trends.json')
  const verificationUrl = config.verificationUrl ?? companionUrl(config.dataUrl, 'verification.json')
  const [registryResult, historyResult, trendsResult, verificationResult] = await Promise.allSettled([
    fetch(config.dataUrl),
    fetch(historyUrl),
    fetch(trendsUrl),
    fetch(verificationUrl),
  ])

  if (registryResult.status === 'rejected') throw registryResult.reason
  const registryResponse = registryResult.value
  if (!registryResponse.ok) throw new Error(`下载 registry 失败: ${registryResponse.status}`)

  const registryText = await registryResponse.text()
  const registry = JSON.parse(registryText) as RegistryDoc
  if (!Array.isArray(registry.plugins)) throw new Error('下载的 registry 结构异常')

  await mkdir(dirname(config.cachePath), { recursive: true })
  await writeFile(config.cachePath, registryText, 'utf8')

  let historyDays = 0
  if (historyResult.status === 'fulfilled' && historyResult.value.ok) {
    const historyText = await historyResult.value.text()
    try {
      const history = JSON.parse(historyText) as HistoryDoc
      if (Array.isArray(history.days)) {
        await writeFile(historyPath, historyText, 'utf8')
        historyDays = history.days.length
      }
    } catch { /* History data is optional. */ }
  }

  if (trendsResult.status === 'fulfilled' && trendsResult.value.ok) {
    const trendsText = await trendsResult.value.text()
    try {
      const trends = JSON.parse(trendsText) as TrendsDoc
      if (Array.isArray(trends.trends)) await writeFile(trendsPath, trendsText, 'utf8')
    } catch { /* Trend data is optional. */ }
  }

  if (verificationResult.status === 'fulfilled' && verificationResult.value.ok) {
    const verificationText = await verificationResult.value.text()
    try {
      const verification = JSON.parse(verificationText) as { plugins?: unknown }
      if (verification.plugins && typeof verification.plugins === 'object' && !Array.isArray(verification.plugins)) {
        await writeFile(verificationPath, verificationText, 'utf8')
      }
    } catch { /* Verification evidence is optional. */ }
  }

  return {
    fetchedAt: registry.meta?.generatedAt ?? new Date().toISOString(),
    count: registry.plugins.length,
    historyDays,
    updated: true,
  }
}

/** Reads the current registry after a successful sync for callers that need its metadata. */
export async function readSyncedRegistry(cachePath: string): Promise<RegistryDoc> {
  return JSON.parse(await readFile(cachePath, 'utf8')) as RegistryDoc
}
