# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。`data/` 的数据变化另有自动记录（每日 sync 提交的 git 历史本身就是变更日志）。

## [Unreleased]

### 变更

- **Topic 全量采集**：GitHub Search 单查询超过 1000 条时，采集器从仅按 `created` 日期二分升级为日期后接 `size`/`stars` 无重叠闭区间的自适应分片；新增 `data/raw/topic-coverage.json` 审计每个叶子查询。存在溢出、页预算截断、`incomplete_results` 或分页去重计数不一致时，全量同步失败，不再静默发布部分 registry
- **同步频率调整**：数据全量同步由每 2 小时改为每 5 小时（UTC cron `17 */5 * * *`），降低 GitHub API、深扫与 Actions 资源消耗；仍保留手动触发。

### 新增（精选认证 + 趋势榜 + 一键安装，M3）

- **精选认证闭环**：作者提 issue（可选勾选「申请精选认证」并填 npm 包名）→ 维护者打 `approved` 标签 → [curate workflow](.github/workflows/curate.yml) 自动收录进 `scripts/curated.json` → `score.mjs` 打 `certified` 标记 → site / DSH 设置页显示 🏅 徽章。认证是展示层激励，**不改变评分**
- **npm 下载量字段**：fetch 阶段抓 npm API 周/月下载量（`npmWeekly` / `npmMonthly`），作为「下载量最多」榜数据源
- **发展排行榜**（`scripts/trends.mjs`）：读 `data/history.json` 派生 `data/trends.json`（7/30/90 天 stars/score/rank delta + sparkline + 方向判定 + 7 类榜：star 增长 ×3 窗口 / 排名上升 / npm 下载量 / 本周新上榜 / 精选认证）
- **排行榜独立页**（`site/rankings.html`）：7 个 Tab 发展榜 + SVG sparkline 曲线，零构建；综合榜页顶新增导航
- **`trend_plugins` 工具**（host 半第 5 个工具）：按榜单查询发展数据；`sync_registry` 同时拉取 registry + history + trends
- **设置页一键安装**：每行「⬇ 安装」按钮（`POST /dsh-recommend/install` 执行 `dsh plugin add`，spec 由服务端构造 + Origin 校验防注入/CSRF）；已装检测走官方 pluginInventory Remote，已装插件显示「✓ 已安装」；原「复制安装命令」保留为「复制命令」
- **设置页紧凑排版**：删除分数进度条、收紧留白与字号（保留详情展开 / 深扫状态 / 走势 sparkline）

### 新增（榜单可信度，评分模型 v2）

- **官方本体/非插件 denylist**（`scripts/exclude-list.json`）：`deepseek-ai/deepseek-harness` 等官方本体排除出榜（仍在 registry 保留原因，可审计）
- **深扫插件性验证**（`scripts/scan.mjs`）：对榜单前 200 名逐仓检测 `dsh` 声明 / `@deepseek-ai/*` 依赖 / cordis 配置 / skills 特征，未检出 → 排除出榜（`未检出插件特征（深扫）`）；`sync.mjs` 升级为两阶段评分（初步榜单 → 深扫 → 合并）
- **hub 目录健康度可见化**：抓取失败不再静默降级——`meta.signals.hubCatalog` 记录 `fetchedAt/error`，`validate.mjs` 对空目录 / 0 awesome 命中直接红（修复了分类筛选与 curated 精选信号长期静默失效的问题：目录恢复 271 条/9 类，curated 0 → 245）
- **历史快照**（`scripts/history.mjs`）：每日 `data/history.json`（top 100 + 总量，同天幂等，保留 366 天），设置页与静态站新增**综合分走势 sparkline**
- **README 徽章**（`scripts/badge.mjs`）：为榜单前 200 生成 shields endpoint 徽章 `data/badges/<owner>__<name>.json`，插件作者可挂 README；静态站/设置页可一键复制徽章链接
- **月度生态报告**（`scripts/report.mjs`）：新秀榜 / 涨幅榜 / 排名下滑榜 / Top10 变动，sync.yml 每次同步自动生成 `docs/reports/<YYYY-MM>.md`
- **设置页体验**：一键「刷新数据」（web 半新增 `POST /dsh-recommend/sync`）、「复制安装命令」（`dsh plugin --profile web add github:...`）、详情展开（主题标签 / 许可证 / 发布时间 / 深扫状态 / 排除原因）、全量 i18n（zh/en，此前仅标签名翻译）
- **模型工具升级**：`recommend_plugins` 增加中英同义词组扩展与 `keywords` 参数（公式：0.6×匹配度 + 0.4×综合分，文档化）；`rank_plugins` / `search_plugins` / `recommend_plugins` 输出附安装命令；`sync_registry` 输出 hub 目录 / 深扫健康度并同时下载历史数据
- **零依赖冒烟测试**（`scripts/smoke.mjs`）：评分公式 / 排除规则 / awesome 链接提取 / 徽章颜色，挂入 validate.yml
- **awesome 链接提取修复**：不再把 `github.com/topics/...` 等非仓库链接误当仓库（键统一小写，修复大小写不一致导致的精选信号漏匹配）
- **fetch 网络重试**：`gh()`/`text()` 对 ECONNRESET/超时等网络层错误退避重试（此前只重试 403/429，瞬时断连会让整个管道红）
- **深扫误杀修复**：被 hub 目录 / awesome 列表人工收录的仓库即使深扫未检出特征也保留上榜（人工审核优先，避免 dsh-web-ui 等真插件被误杀）
- **cordis.patch.yml 修复**：`dsh-recommend-web` 行补充 `dataUrl`（新 web 半「刷新数据」路由依赖它，缺失会导致 `fetch(undefined)` 报错）
- **全量 fetch 回归修复**：skip-topic 改造时丢失 `toRepoRecord` 归一化，raw item（`full_name`）被当 record 合并导致数据损坏——已恢复

### 新增（此前已记录）

- 排行榜新增「按最新发布」排序视图（静态站 + 设置页排行标签），按仓库创建时间倒序
- 榜单卡片新增联动链接（静态站 + 设置页排行标签）：**⭐ Star 支持作者** 引导按钮（打开仓库点 Star 感谢作者）、**仓库地址** 链接（`github.com/owner/name`），有主页/静态站的插件额外显示 **🌐 站点** 链接；静态站页脚新增本仓库源码链接（含 Star 引导）
- 静态站渲染对 GitHub API 文本（仓库名 / 描述 / 主页 / 排除原因）统一做 HTML 转义，防止特殊字符破坏卡片布局
- 榜单分页：每页 50 条（静态站 + 设置页排行标签），全部插件可翻页浏览；搜索 / 分类 / 排序变化自动回到第 1 页；排名与奖牌按全局位置连续显示
- 仓库地址链接上移到卡片顶部（插件名下方等宽字体展示），底部操作行只保留 ⭐ Star 支持作者 与 🌐 站点
- npm 发布（`dsh-recommend@0.2.0`）：新增 npm 安装方式（国内可走 npmmirror 镜像）；package.json 补齐 repository/homepage/keywords/author 元数据；README 增加三种安装方式与国内数据源（jsDelivr）提示
- 手动收录清单（`scripts/manual-repos.json`）：兜底 Search API 永远取不到的仓库（单日仓库数 ≥1000 的溢出区），按 `owner/repo` 填写后由 `/repos` 接口抓取合并，不改变 registry 结构

### 变更

- 静态站默认主题改为浅色（原为深色底）
- 数据自动同步频率：每日 03:17 UTC → 每 2 小时（cron `17 */2 * * *`）
- 评分模型 v1 → v2：排除规则扩展（denylist + 深扫验证），四维权重不变

### 修复

- 时间展示：registry 生成时间由 ISO 字符串（如 `2026-08-13T21:27:05.874Z`）改为本地可读格式（如 `2026-08-14 05:27（UTC+8）`），静态站 / 设置页排行标签 / sync_registry 输出三处统一
- 全量抓取突破 GitHub Search API 1000 条上限：`scripts/fetch.mjs` 改为按 `created` 日期区间分桶 + 递归拆分（单查询最多 1000 条、单日最多 1000 条是 API 硬限制，单日超限时告警截断并注明不完整）；话题仓库数 >1000 后全量请求数达百级，需配 `GITHUB_TOKEN`（CI 已注入，不受影响）

### 新增（M0 骨架）

- 数据管道 v0：`scripts/fetch.mjs`（GitHub topic 抓取 + hub 目录 + awesome 列表）、`scripts/score.mjs`（排除规则 + 四维评分）、`scripts/validate.mjs`（CI 门禁）、`scripts/sync.mjs`（总入口）
- 评分模型 v1：维护性 0.35 / 热度 0.30 / 质量 0.20 / 生态 0.15，公式公开可复算（`docs/scoring.md`）
- `data/registry.json` / `rankings.json` / `meta.json` 全量数据
- 文档：DESIGN / scoring / roadmap / ADR ×3 / CONTRIBUTING（双语）/ SECURITY / AGENTS
- GitHub Actions：每日 cron 同步 + PR 校验
- DSH bundle 插件脚手架（`packages/plugin`）：host 工具半 + browser 设置页半骨架
- 静态站骨架（`site/`）

## [0.1.0] - 2026-08

### 首个版本

- 项目启动（M0）
