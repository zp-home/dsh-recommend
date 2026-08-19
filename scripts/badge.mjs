/**
 * badge.mjs — shields.io endpoint 徽章生成（插件作者挂 README 用）
 *
 * 1) 分数徽章：为所有上榜项目生成 data/badges/<owner>__<name>.json；
 * 2) 精选认证徽章：为 scripts/curated.json 中通过 issue 审核的插件生成
 *    data/badges/<owner>__<name>.certified.json（金色「🏅 精选认证」）。
 *
 * 作者用法（README 里放一行）：
 *   [![dsh score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2F<owner>__<name>.json)](https://github.com/zp-home/dsh-recommend)
 *   [![certified](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2F<owner>__<name>.certified.json)](https://github.com/zp-home/dsh-recommend)
 *
 * 颜色按分数档位与站点视觉一致：>=0.85 金 / >=0.65 蓝 / >=0.5 灰蓝 / 其余浅灰。
 * 用法：node scripts/badge.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
const BADGE_DIR = join(DATA_DIR, 'badges')
const CURATED_FILE = join(ROOT, 'scripts', 'curated.json')

/** 分数档 → shields 颜色（6 位 hex，无 #）。 */
export function badgeColor(score) {
  if (score >= 0.85) return 'f5c518'
  if (score >= 0.65) return '4176e6'
  if (score >= 0.5) return '81858c'
  return '9ca3af'
}

/** 读取精选认证列表（issue 审核通过）。 */
export async function loadCurated() {
  try {
    return JSON.parse(await readFile(CURATED_FILE, 'utf8')).plugins ?? []
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`curated.json 读取失败：${err.message}`)
    return []
  }
}

export async function runBadge(outDir = DATA_DIR) {
  const rankings = JSON.parse(await readFile(join(outDir, 'rankings.json'), 'utf8'))
  const ranked = rankings.rankings ?? []
  const index = { generatedAt: new Date().toISOString(), scoringVersion: rankings.meta.scoringVersion, entries: {} }
  const badgeDir = join(outDir, 'badges')
  await mkdir(badgeDir, { recursive: true })

  // Score files are a complete projection of the current ranking. Keep certified badges intact.
  const scoreFiles = new Set(ranked.map((r) => r.fullName.replace(/\//g, '__') + '.json'))
  const stale = (await readdir(badgeDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json' && !entry.name.endsWith('.certified.json') && !scoreFiles.has(entry.name))
  await Promise.all(stale.map((entry) => rm(join(badgeDir, entry.name))))

  let written = 0
  for (const r of ranked) {
    const file = r.fullName.replace(/\//g, '__') + '.json'
    const badge = {
      schemaVersion: 1,
      label: 'dsh score',
      message: r.score.toFixed(2),
      color: badgeColor(r.score),
    }
    await writeFile(join(badgeDir, file), JSON.stringify(badge))
    index.entries[r.fullName] = { file, message: badge.message, color: badge.color, rank: r.rank }
    written += 1
  }

  // 精选认证徽章（M3）：为 issue 审核通过的插件生成金色认证徽章
  const curated = await loadCurated()
  let certifiedWritten = 0
  for (const c of curated) {
    const file = c.fullName.replace(/\//g, '__') + '.certified.json'
    await writeFile(join(badgeDir, file), JSON.stringify({
      schemaVersion: 1,
      label: 'dsh-recommend',
      message: '🏅 精选认证',
      color: 'c08a00',
    }))
    certifiedWritten += 1
  }
  if (certifiedWritten > 0) {
    await writeFile(join(badgeDir, 'certified.json'), JSON.stringify({
      schemaVersion: 1,
      label: 'dsh-recommend',
      message: `🏅 精选认证 ×${certifiedWritten}`,
      color: 'c08a00',
    }))
  }

  await writeFile(join(outDir, 'badges', 'index.json'), JSON.stringify(index, null, 2))
  return { written, removed: stale.length, certifiedWritten }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runBadge()
  console.log(`已生成 ${r.written} 个分数徽章、清理 ${r.removed} 个失效分数徽章 + ${r.certifiedWritten} 个认证徽章到 ${join(BADGE_DIR, '<owner>__<name>.json')}`)
}
