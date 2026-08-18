# dsh-recommend 设计文档

> 状态：M0 骨架。本文描述目标架构；落地状态以 [roadmap.md](roadmap.md) 为准。

## 1. 定位与边界

一句话：**DSH 插件生态的透明评分、排行与推荐**。

明确不做的事：

- 不做插件安装/更新（那是 `dsh plugin`、plugin-registry、WhaleHub 的事）
- 不做兼容性实测（那是 dsh-plugin-radar、AdamPlatin123/awesome-dsh-plugins 的事；我们把它们的结论当信号，不重复造）
- 不执行任何被收录插件的代码（安全边界，见 SECURITY.md）
- 不做黑盒评分（评分公式与数据全程公开可复算，这是本项目的信任基石）

## 2. 总体架构：数据与展示分离

```
                    ┌────────────────────────────────────────────┐
                    │                数据层（本仓库）              │
                    │  .github/workflows/sync.yml（每 5 小时 cron） │
                    │        │  node scripts/sync.mjs            │
                    │        ▼                                   │
                    │  fetch（采集）→ score（过滤+评分）           │
                    │        → validate（门禁）→ data/*.json      │
                    │  data/ 提交回仓库（Git 即数据库）            │
                    └───────────────┬────────────────────────────┘
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │ DSH bundle 插件   │   │ 静态排行站 site/  │   │ 外部消费者        │
   │ 仓库根（src/→lib/）│   │ GitHub Pages     │   │ （其他工具/脚本）  │
   │ host: 4 个工具    │   │ 零构建，吃 JSON   │   │                   │
   │ browser: 排行页   │   └──────────────────┘   └──────────────────┘
   └──────────────────┘
```

原则：

1. **data/ 是唯一事实源**。任何消费端都读 `data/registry.json`（全量+信号）或 `data/rankings.json`（榜单），不各自抓取。
2. **管道是纯函数**：`fetch → score → validate` 无状态、幂等、可重跑，输出确定性由 validate 门禁保证。
3. **零依赖**：脚本只用 Node 18+ 内置能力（fetch/fs），CI 无需 `npm install`。
4. **自动优先于人工**：除 awesome 列表与 hub 目录天然的人工信号外，管道全自动；人工只做「审核 PR / 更新权重（走 ADR）」。

## 3. 数据层设计

### 3.1 采集（scripts/fetch.mjs）

| 数据源 | 接口 | 频率 | 失败策略 |
|---|---|---|---|
| GitHub topic 仓库 | `GET /search/repositories?q=topic:dsh-plugin&per_page=100` 翻页 | 每 5 小时 | 抛错 → 管道红（数据过期比没有数据好） |
| hub 目录公开镜像 | `0xsline/awesome-deepseek-harness` 的 CATALOG.md（hub 组织仓库本身私有，每日镜像公开） | 每 5 小时 | 降级：跳过，仅警告 |
| awesome 列表 ×3 | 各仓库 raw README | 每 5 小时 | 降级：逐列表跳过并警告 |

输出 `data/raw/repos.json`（含 fetchedAt 时间戳与全部源数据，便于重算）和 `data/raw/topic-coverage.json`（查询分片、每个叶子的 `total_count`/去重数/重试/溢出，便于审计）。

GitHub Search 每个查询最多只能返回 1000 条：先按 `created` 日期二分，单日仍饱和时按 `size`、`stars` 的闭区间继续拆分，所有同层范围无重叠且无缺口。只有每个叶子查询未触发 `incomplete_results` 且去重数等于 `total_count`，该次采集才完整；否则不发布部分 registry。GitHub API 限额：未认证 10 次/分（够一轮）；CI 用 `GITHUB_TOKEN` 提到 30 次/分。**逐仓库深扫**（读 package.json 检测 `dsh.bundle`、读 README）在 v0 不做——653 个仓库的逐仓请求会让限额不够；作为 M1.5 的「精选前 N 深扫」加入（见 roadmap）。

### 3.2 过滤与评分（scripts/score.mjs）

见 [scoring.md](scoring.md)（权威定义）。要点：

- 排除规则独立于评分：fork / archived / 空仓库 / 无描述 / 占位特征 → 进 registry 不进 rankings，附 `excluded` 原因
- 每个仓库产出 `signals`（四个维度）与 `score`（加权和），**权重与公式写进 meta.json 与文档双份**，改权重必须同时改两者（CI 可校验一致性）
- 精选信号：hub catalog 收录或任一 awesome 列表提及 → ecosystem = 1.0；否则 0.2（新插件不因「没被收录」被清零）

### 3.3 校验（scripts/validate.mjs）

CI 门禁：结构完整、无重复、分数在 [0,1]、排名降序、rankings 无排除条目。任一失败 exit 1。

### 3.4 数据文件

| 文件 | 内容 |
|---|---|
| `data/registry.json` | `{ meta, plugins: [...] }` 全量信号与分数 |
| `data/rankings.json` | `{ meta, rankings: [...] }` 降序榜单（带 rank） |
| `data/meta.json` | 生成时间 / 数量 / 评分版本 / 公式快照 |
| `data/raw/` | 采集原始数据（gitignore，不入库） |

## 4. DSH 插件设计（仓库根即 bundle）

单包 bundle（仓库根 `package.json` 声明 `dsh.bundle` + `dsh.client`），patch 插入三行：

```yaml
- insert:
    - id: dsh-recommend
      name: dsh-recommend              # host 半：工具
    - id: dsh-recommend-client
      name: 'dsh-recommend/client'      # browser 半：设置页排行标签
```

### 4.1 Host 半（工具）

基于 `@deepseek-ai/dsh-tools` 的 `defineTool`（官方契约，见 harness `docs/cookbook/adding-a-tool.md`）：

| 工具 | 作用 |
|---|---|
| `rank_plugins` | 按分数/维度/分类查询榜单 |
| `recommend_plugins` | 按目标描述做关键词匹配推荐（v0 规则式；M3 升级） |
| `search_plugins` | 名称/描述/分类检索（含被排除仓库的标注） |
| `sync_registry` | 拉取最新 registry.json 到本地缓存 |

数据获取：config 指定 `dataUrl`（默认 raw.githubusercontent 上本仓库 main 分支的 registry.json）+ 本地缓存路径（默认 `$DSH_HOME/dsh-recommend/registry.json`）；工具读缓存，`sync_registry` 负责更新。**工具只读数据，不执行任何插件代码。**

### 4.2 Browser 半（设置页标签）

遵循官方 client 插件模型（`dsh.client` manifest + `exports["./client"]` + tsdown 构建，见 harness `.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md`）：

- `ctx.slots.inject('settings.plugins.tab', ...)` 注册「插件排行」标签（id: `rankings`，与官方 `all` 标签并列，参考 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` 的写法）
- 数据经 host 半同源供给（M2 实现时二选一：host 注册同源 JSON 路由 / 官方 Remote 命名空间，见 roadmap 中的验证项）

## 5. 静态站（site/）

零构建：`index.html + app.js + style.css`，fetch `data/rankings.json`（GitHub Pages 直接服务仓库根目录）。功能：榜单表格（分数构成可展开）、搜索、分类筛选、多视图（热门/最新/精选）。

## 6. 可持续性机制（本项目的「活法」）

1. **自动化**：每 5 小时 cron 全量重算并提交 `data/`，无人值守。新鲜度与 API 成本保持平衡。
2. **Git 即数据库**：数据变更全部走 git 历史，天然审计日志、天然可回滚。
3. **零成本**：Actions 免费额度 + Pages 静态托管 + 零依赖脚本。
4. **透明可复算**：公式/权重/原始数据全公开；任何质疑 = 「跑一遍脚本」。
5. **生态联动**：hub catalog 分类、awesome 精选、雷达兼容性（M1.5）作为信号；反向给各列表导流。
6. **防刷榜**：多视图并存（热门/最新/精选/分类/推荐），排行不是唯一视图；人工信号（精选收录）只占 0.15 权重且不可被 star 操纵。
7. **免责**：收录≠兼容≠安全，SECURITY.md 明确边界。

## 7. 关键决策记录

- [0001：数据与展示分离](decisions/0001-data-and-presentation-separation.md)
- [0002：评分透明可复算是第一原则](decisions/0002-scoring-transparency.md)
- [0003：单包双半的 bundle 形态](decisions/0003-single-package-dual-half.md)

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| GitHub API 限额/断流 | 管道失败即红（数据过期可见）；raw.githubusercontent 不受 Search 限额影响 |
| 话题仓库水分（占位/WIP） | 独立排除规则 + `excluded` 原因透明展示 |
| 官方机制漂移（如 0811 删 repository 插件） | 只依赖官方 bundle 契约；README 注明上游 release 跟进 |
| 评分被操纵/质疑 | 公式公开 + 多视图 + 人工信号兜底 |
| 单维护者风险 | CONTRIBUTING 明确「数据变更无需代码能力即可贡献」；提交表单 1 分钟入口 |
