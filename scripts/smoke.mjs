/**
 * smoke.mjs — 数据管道零依赖冒烟测试（CI 用）
 *
 * 对纯函数做固定断言：评分公式、排除规则、denylist、awesome 链接提取、徽章颜色。
 * 失败退出码非零（可挂进 validate.yml）。用法：node scripts/smoke.mjs
 */
import { equal, ok } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exclusionReason, scoreRepo } from './score.mjs'
import { extractRepoRefs, splitTopicShard, topicQueryForShard } from './fetch.mjs'
import { badgeColor, runBadge } from './badge.mjs'
import { scanPluginSource, readCompatibilityAttestation, validateCompatibilityAttestationForSource } from './static-security.mjs'
import { selectSecurityTargets } from './security-queue.mjs'
import { mergeSecurityReceipts } from './merge-security-receipts.mjs'

let n = 0
function t(name, fn) {
  fn()
  n += 1
  console.log(`  ✓ ${name}`)
}

t('评分：维护性半衰期', () => {
  const { signals } = scoreRepo({ pushedAt: new Date(Date.now() - 180 * 86_400_000).toISOString(), stars: 0, description: 'x'.repeat(40), license: 'MIT', sizeKb: 10 }, 0.2)
  // 阈值 1e-6：toISOString() 会截断毫秒（亚毫秒误差），经 exp 放大后在 Linux runner
  // 上会突破 1e-9 的旧阈值，导致 flaky 失败。1e-6 对 float64 维护性计算绰绰有余。
  ok(Math.abs(signals.maintenance - Math.exp(-1)) < 1e-6, '180 天未更新应 ≈ e^-1')
})

t('评分：popularity 对数压缩封顶', () => {
  const a = scoreRepo({ pushedAt: new Date().toISOString(), stars: 1000, description: 'x'.repeat(40), license: 'MIT', sizeKb: 1 }, 0.2).signals.popularity
  const b = scoreRepo({ pushedAt: new Date().toISOString(), stars: 100000, description: 'x'.repeat(40), license: 'MIT', sizeKb: 1 }, 0.2).signals.popularity
  ok(a === 1 && b === 1, '1000+ stars 封顶为 1')
})

t('评分：总分 = 加权和', () => {
  const repo = { pushedAt: new Date().toISOString(), stars: 100, description: 'x'.repeat(40), license: 'MIT', sizeKb: 10 }
  const { score, signals } = scoreRepo(repo, 1.0)
  const expect = 0.35 * signals.maintenance + 0.30 * signals.popularity + 0.20 * signals.quality + 0.15 * 1.0
  ok(Math.abs(score - expect) < 1e-12)
})

t('排除规则：占位/无描述/空仓库', () => {
  ok(exclusionReason({ description: 'coming soon placeholder', sizeKb: 10 }) === '占位/WIP 特征')
  ok(exclusionReason({ description: '', sizeKb: 10 }) === '无描述')
  ok(exclusionReason({ description: 'ok', sizeKb: 0 }) === '空仓库（sizeKb=0）')
  ok(exclusionReason({ description: 'ok', sizeKb: 10, fork: true }) === 'fork 仓库')
  ok(exclusionReason({ description: 'ok', sizeKb: 10, archived: true }) === '已归档')
  ok(exclusionReason({ description: 'ok', sizeKb: 10 }) === null)
})

t('awesome 链接提取：排除 topics/动作/徽章 URL', () => {
  const md = [
    'see [repo](https://github.com/Owner/Repo)',
    '[topic](https://github.com/topics/dsh-plugin)',
    '![badge](https://github.com/actions/workflows/ci.yml)',
    'https://github.com/Awesome-dsh-plugin/awesome-dsh-plugin#readme',
    'https://github.com/a/b/tree/main/docs',
  ].join('\n')
  const refs = extractRepoRefs(md)
  ok(refs.includes('owner/repo'), '普通仓库应被提取')
  ok(refs.includes('awesome-dsh-plugin/awesome-dsh-plugin'), '列表自身仓库应被提取（小写）')
  ok(refs.includes('a/b'), '带 /tree/ 后缀的应提取 owner/repo')
  ok(!refs.some((r) => r.startsWith('topics/')), 'topics 链接不得被当作仓库')
  ok(!refs.some((r) => r.startsWith('actions/')), 'actions 链接不得被当作仓库')
})

t('Topic 分片：跨年日期范围无重叠且无缺口', () => {
  const shard = { createdFrom: '2025-12-31', createdTo: '2026-01-01', numeric: {}, depth: 0 }
  const split = splitTopicShard(shard)
  ok(split?.dimension === 'created')
  ok(split.children[0].createdFrom === '2025-12-31' && split.children[0].createdTo === '2025-12-31')
  ok(split.children[1].createdFrom === '2026-01-01' && split.children[1].createdTo === '2026-01-01')
})

t('Topic 分片：size 闭区间完整覆盖且查询稳定', () => {
  const shard = { createdFrom: '2026-08-14', createdTo: '2026-08-14', numeric: {}, depth: 0 }
  const split = splitTopicShard(shard, [
    { size: 0, stargazers_count: 0 },
    { size: 10, stargazers_count: 0 },
    { size: 20, stargazers_count: 1 },
    { size: 30, stargazers_count: 1 },
  ])
  ok(split?.dimension === 'size')
  const [lower, upper] = split.children
  ok(lower.numeric.size.min === 0 && lower.numeric.size.max === 10)
  ok(upper.numeric.size.min === 11 && upper.numeric.size.max === null)
  ok(topicQueryForShard(lower) === 'topic:dsh-plugin created:2026-08-14..2026-08-14 size:0..10')
  ok(topicQueryForShard(upper) === 'topic:dsh-plugin created:2026-08-14..2026-08-14 size:>=11')
})

t('Topic 分片：1474 条同日簇可按 size 打散', () => {
  const shard = { createdFrom: '2026-08-14', createdTo: '2026-08-14', numeric: {}, depth: 0 }
  const burst = Array.from({ length: 1474 }, (_, index) => ({ size: index % 73, stargazers_count: index % 5 }))
  const split = splitTopicShard(shard, burst)
  ok(split?.dimension === 'size')
  ok(split.children[0].numeric.size.max !== null)
  ok(split.children[1].numeric.size.min === split.children[0].numeric.size.max + 1)
})

t('Topic 分片：集中 size=0 后继续按 stars 切分', () => {
  const shard = { createdFrom: '2026-08-14', createdTo: '2026-08-14', numeric: {}, depth: 0 }
  const bySize = splitTopicShard(shard, [
    { size: 0, stargazers_count: 0 },
    { size: 0, stargazers_count: 0 },
  ])
  ok(bySize?.dimension === 'size')
  const zeroSize = bySize.children[0]
  const byStars = splitTopicShard(zeroSize, [
    { size: 0, stargazers_count: 0 },
    { size: 0, stargazers_count: 0 },
  ])
  ok(byStars?.dimension === 'stars')
  ok(topicQueryForShard(byStars.children[0]).endsWith('size:0 stars:0'))
  ok(topicQueryForShard(byStars.children[1]).endsWith('size:0 stars:>=1'))
})

t('徽章颜色分档', () => {
  ok(badgeColor(0.9) === 'f5c518')
  ok(badgeColor(0.7) === '4176e6')
  ok(badgeColor(0.55) === '81858c')
  ok(badgeColor(0.3) === '9ca3af')
})

{
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-recommend-badge-'))
  const badgeDir = join(outDir, 'badges')
  try {
    await mkdir(badgeDir)
    await writeFile(join(outDir, 'rankings.json'), JSON.stringify({
      meta: { scoringVersion: 2 },
      rankings: [
        { rank: 1, fullName: 'top/repo', score: 0.9 },
        { rank: 400, fullName: 'guo6x/dsh-pilot', score: 0.7678 },
      ],
    }))
    await writeFile(join(badgeDir, 'stale__repo.json'), '{}')
    await writeFile(join(badgeDir, 'guo6x__dsh-pilot.certified.json'), '{}')

    const result = await runBadge(outDir)
    const files = await readdir(badgeDir)
    const index = JSON.parse(await readFile(join(badgeDir, 'index.json'), 'utf8'))
    equal(result.written, 2)
    equal(result.removed, 1)
    ok(files.includes('guo6x__dsh-pilot.json'), '第 400 名也必须生成分数徽章')
    ok(!files.includes('stale__repo.json'), '失效分数徽章必须被清理')
    ok(files.includes('guo6x__dsh-pilot.certified.json'), '认证徽章不得被清理')
    equal(index.entries['guo6x/dsh-pilot'].rank, 400)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
  n += 1
  console.log('  ✓ 徽章：覆盖全量排名并清理失效分数文件')
}

{
  const now = Date.parse('2026-09-01T00:00:00.000Z')
  const targets = selectSecurityTargets([
    { fullName: 'owner/old', score: 0.7, pushedAt: '2026-08-01', excluded: null },
    { fullName: 'owner/new', score: 0.9, pushedAt: '2026-09-01T00:00:01.000Z', excluded: null },
    { fullName: 'owner/excluded', score: 1, pushedAt: '2026-08-30', excluded: 'placeholder' },
  ], {
    plugins: {
      'owner/old': { staticSecurity: { checkedAt: '2026-08-01T00:00:00.000Z' } },
      'owner/new': { staticSecurity: { checkedAt: '2026-08-31T00:00:00.000Z' } },
    },
  }, 6, now)
  equal(targets.length, 2)
  equal(targets[0].fullName, 'owner/new')
  equal(targets[1].fullName, 'owner/old')
  n += 1
  console.log('  ✓ 安全队列：优先选择新 revision、过期或缺失的未排除插件')
}

{
  const receipt = {
    format: 'dsh-plugin-verification/v1',
    kind: 'static-security',
    repository: 'owner/plugin',
    commit: '0123456789abcdef',
    checkedAt: '2026-09-01T00:00:00.000Z',
    scannerVersion: 1,
    rulesetVersion: '2026-09',
    status: 'passed',
    risk: 'low',
    scannedFiles: 3,
    findings: [],
    truncated: false,
    publisherCompatibility: {
      format: 'dsh-plugin-verification/v1',
      kind: 'baseline-compatibility',
      repository: 'owner/plugin',
      commit: '0123456789abcdef',
      checkedAt: '2026-09-01T00:00:00.000Z',
      status: 'passed',
      profileMode: 'clean',
    },
  }
  const merged = mergeSecurityReceipts({}, [receipt, { ...receipt, repository: 'bad value' }], '2026-09-01T01:00:00.000Z')
  equal(merged.merged, 1)
  equal(merged.plugins['owner/plugin'].staticSecurity.commit, receipt.commit)
  equal(merged.plugins['owner/plugin'].publisherCompatibility.profileMode, 'clean')
  n += 1
  console.log('  ✓ 安全回执：仅合并带版本的有效市场回执')
}

{
  const root = await mkdtemp(join(tmpdir(), 'dsh-recommend-security-'))
  try {
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(join(root, 'lib', 'index.js'), "import { exec } from 'node:child_process'\nexec('echo test')\n")
    const receipt = await scanPluginSource(root, { repository: 'owner/plugin', commit: '0123456789abcdef' })
    equal(receipt.status, 'warnings')
    equal(receipt.risk, 'high')
    ok(receipt.findings.some((finding) => finding.file === 'lib/index.js'), 'published lib must be scanned')
    equal(readCompatibilityAttestation({
      format: 'dsh-plugin-verification/v1',
      kind: 'baseline-compatibility',
      repository: 'owner/plugin',
      commit: '0123456789abcdef',
      checkedAt: '2026-09-01T00:00:00.000Z',
      profileMode: 'host-web',
      result: 'passed',
      plugin: { sourceFingerprint: 'sha256' },
    }, '0123456789abcdef', 'owner/plugin'), null)
    const manifestText = await readFile(join(root, 'package.json'), 'utf8')
    const sourceFingerprint = createHash('sha256').update(manifestText).digest('hex')
    const portable = await validateCompatibilityAttestationForSource(root, {
      format: 'dsh-plugin-verification/v1',
      kind: 'baseline-compatibility',
      repository: 'owner/plugin',
      commit: '0123456789abcdef',
      checkedAt: '2026-09-01T00:00:00.000Z',
      profileMode: 'clean',
      result: 'passed',
      plugin: { name: 'fixture', sourceFingerprint },
    }, '0123456789abcdef', 'owner/plugin')
    equal(portable?.status, 'passed')
    equal(await validateCompatibilityAttestationForSource(root, {
      format: 'dsh-plugin-verification/v1',
      kind: 'baseline-compatibility',
      repository: 'owner/plugin',
      commit: '0123456789abcdef',
      checkedAt: '2026-09-01T00:00:00.000Z',
      profileMode: 'clean',
      result: 'passed',
      plugin: { name: 'fixture', sourceFingerprint: '0'.repeat(64) },
    }, '0123456789abcdef', 'owner/plugin'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  n += 1
  console.log('  ✓ 静态扫描：扫描发布 bundle，公开回执绑定 target manifest')
}

console.log(`\n✓ smoke 全部通过（${n} 项）`)
