/**
 * sync.mjs — 数据管道总入口
 *
 * fetch → score(phase1, 无深扫) → scan(榜单前 N 深扫) → score(phase2, 合并深扫)
 *       → history(每日快照) → trends(趋势派生) → badge(徽章) → validate
 * CI 每 5 小时 cron 调用的就是它：
 *   node scripts/sync.mjs [--limit N] [--no-awesome] [--skip-topic] [--no-scan] [--no-badge]
 *
 * --limit N      只抓取 GitHub Search 前 N 页（本地快速调试用）
 * --no-awesome   跳过 awesome 列表抓取（离线调试）
 * --skip-topic   复用现有 raw 的 topic 数据，只刷新目录/awesome（本地快速重建）
 * --no-scan      跳过深扫（默认：有 GITHUB_TOKEN 才跑，无 token 时自动跳过）
 * --no-badge     跳过徽章生成，并跳过仅依赖徽章的完整性门禁（本地调试提速）
 *
 * 退出码：管道任意一步失败即非零（GitHub Actions 红）。
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)))

async function step(name, args) {
  const started = Date.now()
  try {
    const { stdout, stderr } = await run(process.execPath, [join(SCRIPTS, name), ...args], {
      encoding: 'utf8',
    })
    console.log(`[ok] ${name} ${args.join(' ') || ''} (${Date.now() - started}ms)`)
    for (const line of stdout.trim().split('\n')) console.log(`     ${line}`)
    if (stderr.trim()) for (const line of stderr.trim().split('\n')) console.log(`     [warn] ${line}`)
  } catch (err) {
    console.error(`[fail] ${name}`)
    console.error(err.stdout ?? '')
    console.error(err.stderr ?? err.message)
    process.exit(1)
  }
}

const args = process.argv.slice(2)
const noScan = args.includes('--no-scan')
const noBadge = args.includes('--no-badge')
// 深扫默认只在有 token 时执行（core API 无 token 限额 60/小时，撑不起 200 仓库）
const scanEnabled = !noScan && Boolean(process.env.GITHUB_TOKEN)

await step('fetch.mjs', args)
await step('score.mjs', ['--no-scan']) // 第一阶段：先出初步榜单供深扫定位 top N
if (scanEnabled) {
  await step('scan.mjs', ['--top', '200'])
} else {
  console.log(`[skip] scan.mjs（${noScan ? '--no-scan 指定' : '未设置 GITHUB_TOKEN'}，深扫留待 CI）`)
}
await step('score.mjs', []) // 第二阶段：合并深扫结果（unverified → 排除出榜）
await step('build-site-data.mjs', [])
await step('history.mjs', [])
await step('trends.mjs', [])
if (!noBadge) await step('badge.mjs', [])
await step('validate.mjs', noBadge ? ['--skip-badges'] : [])

console.log('✓ 数据管道完成')
