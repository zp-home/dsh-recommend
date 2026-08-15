/* dsh-recommend 发展排行榜页：消费 data/trends.json（由 scripts/trends.mjs 生成）。 */

/** HTML 转义。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 数字千分位。 */
function fmt(n) {
  if (n === null || n === undefined) return '—'
  return Number(n).toLocaleString('en-US')
}

/** 正负号前缀。 */
function signed(n) {
  if (n === null || n === undefined) return '—'
  return (n > 0 ? '+' : '') + fmt(n)
}

/** SVG sparkline（stars 序列）。 */
function sparkline(values, width = 120, height = 28) {
  if (!values || values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`).join(' ')
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

const PANEL_META = {
  stars7: { key: 'starsGain7d', value: (t) => t.deltas?.['7d']?.stars, suffix: '★', extra: (t) => `7 天前 ${fmt(t.deltas['7d'].stars)} ★` },
  stars30: { key: 'starsGain30d', value: (t) => t.deltas?.['30d']?.stars, suffix: '★', extra: (t) => `30 天前 ${fmt(t.deltas['30d'].stars)} ★` },
  stars90: { key: 'starsGain90d', value: (t) => t.deltas?.['90d']?.stars, suffix: '★', extra: (t) => `90 天前 ${fmt(t.deltas['90d'].stars)} ★` },
  rank30: { key: 'rankGain30d', value: (t) => t.deltas?.['30d']?.rank, suffix: ' 名', extra: (t) => `当前第 ${t.current.rank} 名 · 30 天前第 ${t.current.rank + t.deltas['30d'].rank} 名` },
  downloads: { key: 'downloads30d', value: (t) => t.current?.npmMonthly, suffix: ' 次', extra: (t) => `npm 月下载量（上周 ${fmt(t.current?.npmWeekly)}）` },
  new: { key: 'newlyListed', value: (t) => t.current?.stars, suffix: '★', extra: (t) => `上榜于 ${t.firstSeen}` },
  certified: { key: 'certified', value: (t) => t.current?.score, suffix: ' 分', extra: () => '精选认证 · 经 issue 审核' },
}

let doc = null // data/trends.json
let activePanel = 'stars7'

function rowHtml(t, rank, meta, withSpark) {
  const certified = t.current?.certified ? '<span class="badge-cert" title="精选认证（issue 审核通过）" aria-label="精选认证">🏅 精选</span>' : ''
  const value = meta.value(t)
  return `
    <article class="row">
      <div class="row-top">
        <span class="rank accent">#${rank + 1}</span>
        <div class="name">
          <div class="name-title">
            <a class="repo-name" href="https://github.com/${esc(t.fullName)}" target="_blank" rel="noopener">${esc(t.fullName)}</a>
            ${certified}
          </div>
          <span class="repo-addr">github.com/${esc(t.fullName)}</span>
        </div>
        ${withSpark ? `<span class="spark-cell">${sparkline(t.sparkline)}</span>` : ''}
        <div class="right">
          <span class="stars">${withSpark ? `${fmt(t.current?.stars)} ★` : ''}</span>
          <span class="gain">${signed(value)} ${meta.suffix}</span>
        </div>
      </div>
      ${meta.extra ? `<p class="desc">${meta.extra(t)}</p>` : ''}
    </article>`
}

function renderPanel(panelName) {
  const meta = PANEL_META[panelName]
  const list = doc?.rankings?.[meta.key] ?? []
  const el = document.querySelector(`.panel[data-panel="${panelName}"]`)
  if (!el) return
  el.innerHTML = list.length === 0
    ? '<p class="meta">暂无数据（历史快照积累中，通常需要 7 天以上才能形成有意义的趋势）</p>'
    : list.map((t, i) => rowHtml(t, i, meta, panelName.startsWith('stars') || panelName === 'new')).join('')
  document.getElementById('count').textContent =
    `${PANEL_META[panelName].key}：${list.length} 条 · 数据 ${doc?.meta?.generatedAt ? new Date(doc.meta.generatedAt).toLocaleString('zh-CN') : '—'} · 历史 ${doc?.meta?.historyDays ?? 0} 天`
}

function renderAll() {
  for (const name of Object.keys(PANEL_META)) {
    document.querySelector(`.panel[data-panel="${name}"]`).innerHTML = ''
    if (name === activePanel) renderPanel(name)
  }
}

async function load() {
  try {
    doc = await fetch('../data/trends.json').then((r) => r.json())
    document.getElementById('meta').textContent =
      `历史快照 ${doc?.meta?.historyDays ?? 0} 天（自 ${doc?.meta?.historyStart ?? '—'}）· 追踪 ${doc?.trends?.length ?? 0} 个插件`
    renderAll()
  } catch (err) {
    document.getElementById('meta').textContent = `加载失败：${err.message}（先跑 node scripts/sync.mjs 生成 data/trends.json）`
  }
}

// Tab 切换
for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => {
    activePanel = btn.dataset.panel
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b === btn)
    renderAll()
  })
}

load()
