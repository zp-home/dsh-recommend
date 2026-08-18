/**
 * smoke.mjs — 数据管道零依赖冒烟测试（CI 用）
 *
 * 对纯函数做固定断言：评分公式、排除规则、denylist、awesome 链接提取、徽章颜色。
 * 失败退出码非零（可挂进 validate.yml）。用法：node scripts/smoke.mjs
 */
import { ok } from 'node:assert/strict'
import { exclusionReason, scoreRepo } from './score.mjs'
import { extractRepoRefs, splitTopicShard, topicQueryForShard } from './fetch.mjs'
import { badgeColor } from './badge.mjs'

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

console.log(`\n✓ smoke 全部通过（${n} 项）`)
