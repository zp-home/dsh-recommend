/**
 * invite.mjs — 针对性邀请清单生成器（M3 运营工具）
 *
 * 从 data/registry.json 筛出高价值但未认证的插件，按优先级分层输出：
 *   docs/invites.md  —— 邀请清单（markdown 表格 + 每位作者个性化话术模板）
 *
 * 分层标准：
 *   - Tier 1（头部标杆）：stars >= 800，已实际证明受欢迎 —— 邀请能快速建立「认证=优质」认知
 *   - Tier 2（优质活跃）：stars >= 100 且 30 天内活跃 —— 邀请成功率最高的中坚力量
 *   - Tier 3（潜力新星）：stars >= 30 且 score >= 0.6 且 30 天内活跃 —— 扩大认证池
 *
 * 用法：node scripts/invite.mjs [--out docs/invites.md] [--tier 1]
 * 生成的话术已预填该插件的真实数据（名称/星级/分数），可直接复制发给作者。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')

/** 分层判定。 */
export function tierOf(p) {
  if (p.stars >= 800) return 1
  if (p.stars >= 100 && p.daysSincePush <= 30) return 2
  if (p.stars >= 30 && p.score >= 0.6 && p.daysSincePush <= 30) return 3
  return null
}

/** 个性化邀请话术（作者名从 fullName 提取）。 */
export function inviteMessage(p) {
  const author = p.fullName.split('/')[0]
  const cat = p.category ? `（${p.category}）` : ''
  return [
    `Hi @${author} 👋 我是 [dsh-recommend](https://github.com/zp-home/dsh-recommend) 的维护者。`,
    ``,
    `你的插件 **${p.fullName}**${cat} 已被自动收录进 DSH 插件榜（★${p.stars} · 综合分 ${p.score.toFixed(2)}），在生态里属于头部/优质项目。`,
    ``,
    `想邀请你**提交收录并申请 🏅 精选认证**——通过后你的插件会获得：`,
    `- 首页右侧「精选认证」推荐位曝光`,
    `- 认证徽章（可挂到你的 README）+ 分数徽章`,
    `- 进入「精选认证」排行榜`,
    ``,
    `一分钟搞定：填写这个 [收录表单](https://github.com/zp-home/dsh-recommend/issues/new?template=submit-plugin.yml)，勾选「申请精选认证」即可。`,
    ``,
    `有任何问题随时提 issue，谢谢你的优秀插件！🚀`,
  ].join('\n')
}

/** 生成邀请清单 markdown。 */
export async function generateInvites(outFile = join(ROOT, 'docs', 'invites.md'), minTier = 1) {
  const registry = JSON.parse(await readFile(join(DATA_DIR, 'registry.json'), 'utf8'))
  const certified = new Set(registry.plugins.filter((p) => p.certified).map((p) => p.fullName))

  const targets = (registry.plugins ?? [])
    .filter((p) => !p.excluded && !certified.has(p.fullName))
    .map((p) => ({ ...p, tier: tierOf(p) }))
    .filter((p) => p.tier !== null && p.tier >= minTier)
    .sort((a, b) => a.tier - b.tier || b.stars - a.stars)

  const lines = [
    '# 针对性邀请清单（自动生成）',
    '',
    `> 生成时间：${new Date().toISOString()} · 数据源：data/registry.json（每 2 小时自动更新）`,
    `> 上榜插件 ${registry.plugins?.length ?? 0} 个 · 已认证 ${certified.size} 个 · 本期邀请目标 ${targets.length} 个`,
    '',
    '分层标准：**Tier 1** 头部标杆（★≥800）· **Tier 2** 优质活跃（★≥100 且 30 天活跃）· **Tier 3** 潜力新星（★≥30 且 score≥0.6 且活跃）',
    '',
    '## 邀请清单',
    '',
    '| Tier | 插件 | 星级 | 综合分 | 分类 | 活跃 | 作者 |',
    '|---|---|---|---|---|---|---|',
    ...targets.map((p) =>
      `| ${p.tier} | [${p.fullName}](${p.url}) | ★${p.stars} | ${p.score.toFixed(2)} | ${p.category ?? '—'} | ${p.daysSincePush <= 30 ? '✅' : '❌'} | @${p.fullName.split('/')[0]} |`,
    ),
    '',
    '## 个性化话术（按作者复制）',
    '',
    ...targets.map((p) => `### ${p.fullName}\n\n${inviteMessage(p)}\n\n---\n`),
  ]

  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, lines.join('\n'), 'utf8')
  return { total: targets.length, tiers: { 1: targets.filter((t) => t.tier === 1).length, 2: targets.filter((t) => t.tier === 2).length, 3: targets.filter((t) => t.tier === 3).length } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const outIdx = argv.indexOf('--out')
  const tierIdx = argv.indexOf('--tier')
  const out = outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'docs', 'invites.md')
  const minTier = tierIdx >= 0 ? Number(argv[tierIdx + 1]) || 1 : 1
  const r = await generateInvites(out, minTier)
  console.log(`已生成邀请清单 ${out}：Tier1=${r.tiers[1]} Tier2=${r.tiers[2]} Tier3=${r.tiers[3]} 共 ${r.total} 个目标`)
}