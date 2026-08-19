# 静态安全扫描器误报修复报告

> 日期：2026-08-19 | 扫描器版本：v10 | 规则集：Ruleset 2026-18

## 1. 问题背景

CI 重新扫描后，54 个插件中 49 个被标记为 high 风险，`MKT-EXEC-001` 触发 952 次。大量正常代码（`exec('npm run build')`、`writeFile()`、`fetch()`）被误判为高危操作。经过三轮修复，72 个插件中 30 个已用 v10 重新扫描，其中 17 个 high / 13 个 medium。

**结论**：检测逻辑在文件级别匹配，导致远距离无关代码互相影响。修复方向是从文件级降为调用点级检测。

## 2. 三轮修复总览

| 轮次 | PR | 核心修复 | 效果 |
|------|-----|---------|------|
| 第一轮 | #26 | 重复 finding 消除、正则修正、SKILL 规则范围、CI 风险降级 | 952→数百条 |
| 第二轮 | #27 | CI 规则重复检测消除 | 数百→数十条 |
| 第三轮 | #28 | 文件级→调用点级检测、scripts/ 精细排除 | 49→17 high（v10） |

## 3. 根因分析与修复详情

### 3.1 重复 finding 生成（第一轮）

**根因**：`runCapabilityAnalysis` 对每个 `exec()` 调用生成一条 finding（上限 5 条/文件），`runRegexRule` 同样每文件最多 5 条。一个 Electron 应用 50 个文件用 `exec`/`writeFile`，产生 250+ 条发现。

**修复**：两条函数均改为每文件每规则只生成一条 finding，消息中包含匹配次数。

### 3.2 SKILL 规则在代码文件上运行（第一轮）

**根因**：`SKILL_HIJACK_RULES` 的运行条件被改为 `isSkill || isCode`，导致 `.ts`/`.js` 代码文件中 `export...message`、`send...chat` 等正常代码词汇被匹配为 exfiltration guidance。111 次误报。

**修复**：运行条件恢复为 `isSkill`；正则表达式收窄，要求高危动词或远程目标词。

### 3.3 CI 规则风险等级过高（第一轮）

**根因**：
- `MKT-CI-003`（checkout 缺少 `persist-credentials: false`）：risk=high，但这是常见疏忽。
- `MKT-CI-004`（`npm install`）：risk=high，但每个 Node.js 项目 CI 都会跑。

**修复**：`MKT-CI-003` 降为 medium，`MKT-CI-004` 降为 medium/low。

### 3.4 EXEC-009 正则不精确（第一轮）

**根因**：`import\s*\(\s*(?![\"\'`])` 负向前瞻只排除引号开头的参数，`import(/* comment */` 也被匹配。176 次误报。

**修复**：改为 `import\s*\(\s*[A-Za-z_$]`，只匹配变量名开头的动态导入。

### 3.5 测试文件中的假密钥（第一轮）

**根因**：`runKeyDetection`、`runEnvSecretDetection` 未跳过测试文件。104 次误报。

**修复**：所有检测函数添加 `!TEST_PATH.test(display)` 条件。

### 3.6 DESTRUCTIVE_SYSTEM 文件级匹配（第三轮 — 关键修复）

**根因**：`DESTRUCTIVE_SYSTEM.test(text)` 在整个文件文本上检测。如果文件任何位置有 `rm -rf`、`shutdown` 等词（包括注释、方法调用 `server.shutdown()`），整个文件所有 `exec()`/`writeFile()` 都变 high。9 次 FS-001 + 4 次 EXEC-001 误报。

**修复**：改为在 `exec()` 调用点 150 字符窗口内检测 `DESTRUCTIVE_SYSTEM`。大文件中 `exec('npm build')` + 远处 `rm -rf`（>150 字符）正确降为 medium。

### 3.7 EXEC-012 Base64+eval 文件级关联（第三轮）

**根因**：`Buffer.from()` 和 `eval()` 在同一文件就触发 `MKT-EXEC-012`。但 `Buffer.from` 是极常见的 Node.js API，两者可能完全无关。6 次误报。

**修复**：两者必须在 150 字符内（同一代码块）才触发。

### 3.8 scripts/ 目录排除策略（第三轮）

**根因**：`scripts/` 目录中的构建脚本（`update-contributors.mjs`、`pr-review.mjs`）中的配置变量 `api_key = '...'`、`password = '...'` 被检测为密钥泄露。13 次误报。同时 `install.sh` 中的 `curl|bash` 需要保留检测。

**修复**：
- 新增 `SCRIPTS_PATH` 正则
- `isProductionCode` 排除 `scripts/` 目录（跳过密钥、env、能力分析）
- `scripts/` 中的 `.sh`/`.ps1` 文件仍检测 `MKT-EXEC-003`（curl|bash）

### 3.9 EXEC-002 正则修正（第三轮）

**根因**：`\b(?:eval|Function)\s*\(` 匹配普通函数调用 `Function(`。

**修复**：改为 `\b(?:eval|new\s+Function)\s*\(`，仅匹配 `eval()` 和 `new Function()` 构造函数。

### 3.10 其他正则修复（第一轮）

| 正则 | 修复前 | 修复后 |
|------|--------|--------|
| `EXECUTION_CALL` | `exec` 无 `(` 要求 | 要求 `exec(` 函数调用形式 |
| `DESTRUCTIVE_SYSTEM` | `shutdown` 无上下文 | `(?<!\.)shutdown(?!\s*[=()])` |
| `EXEC_SINK` | `require\([^)]+\)` | `require\((?![\"\'\`])` |
| `NETWORK_SINK` | 缺少方法调用 | 添加 `axios\.get\(` 等 |
| `SECRET_SOURCE` | 含 `process.env` | 移除宽泛匹配 |
| `ENV_SENSITIVE` | `\.env` | `(?<!process)\.env` |
| `MKT-EXEC-010` | 负向匹配 string | 正向匹配 string |

## 4. 修复后验证数据

### 4.1 v10 扫描结果（30 个已重新扫描的插件）

| 风险等级 | 插件数 | 占比 |
|----------|--------|------|
| high | 17 | 57% |
| medium | 13 | 43% |
| low | 0 | 0% |

### 4.2 v10 high 规则分布

| 规则 | 次数 | 说明 |
|------|------|------|
| `MKT-DATA-001` | 21 | 生产代码中检测到 API key 模式 |
| `MKT-FS-001` | 11 | 文件系统操作 + 调用点附近有破坏性命令 |
| `MKT-EXEC-003` | 8 | `curl|bash` 下载执行模式 |
| `MKT-PERSIST-001` | 8 | 持久化/自启动模式 |
| `MKT-EXEC-012` | 7 | Base64 解码 + eval 在同一代码块 |
| `MKT-DATA-005` | 7 | 环境变量读取 + 网络请求 |
| `MKT-DATA-008` | 7 | 环境变量 + 网络复合检测 |
| `MKT-EXEC-001` | 6 | 进程 API + 调用点附近有破坏性命令 |
| `MKT-EXEC-002` | 6 | `eval()` 或 `new Function()` |
| `MKT-DATA-003` | 5 | 密钥源 + 网络连接 |
| `MKT-SKILL-001` | 2 | SKILL 文件中的指令覆盖 |
| `MKT-FS-005` | 2 | 敏感数据写入外部位置 |
| `MKT-CI-005` | 1 | CI 工作流中 curl|bash |

### 4.3 测试用例验证

| 场景 | 修复前 risk | 修复后 risk | 修复前 high | 修复后 high |
|------|-------------|-------------|-------------|-------------|
| 正常 Electron 应用（exec+writeFile） | high | medium | 数百 | 0 |
| 正常 CI 工作流（npm install） | high | medium | 3 | 0 |
| 测试文件中的假密钥 | high | low | 1+ | 0 |
| SKILL.md 正常描述 | high | low | 2+ | 0 |
| scripts/ 中的假密钥 | high | low | 1+ | 0 |
| 大文件 exec + 远处 rm -rf | high | **medium** | 1 | **0** |
| 大文件 Buffer.from + 远处 eval | high | high | 2 | **1**（仅 EXEC-002） |
| exec(variable) + 附近破坏性命令 | high | high | 多条 | 1 |
| 危险 CI（pull_request_target + curl\|bash） | high | high | 8 | 4 |
| scripts/install.sh 中 curl\|bash | 漏检 | **high** | 0 | **1** |

### 4.4 冒烟测试

`node scripts/smoke.mjs` — 14 项全部通过。

## 5. 仍为 high 的规则分析

### 5.1 合理保留的 high（真实威胁）

| 规则 | 说明 | 典型案例 |
|------|------|----------|
| `MKT-EXEC-003` | `curl|bash` 下载执行 | `scripts/install.sh` 中的安装脚本 |
| `MKT-EXEC-002` | `eval()` 执行动态代码 | 代码中直接调用 `eval(userInput)` |
| `MKT-CI-005` | CI 中 `curl|bash` | 工作流下载并执行远程脚本 |
| `MKT-SKILL-001` | SKILL 文件指令覆盖 | 包含 "ignore previous instructions" + 破坏性指导 |
| `MKT-DATA-003` | 密钥源 + 网络连接 | 文件中同时有 `API_KEY` 和 `fetch()` |
| `MKT-EXEC-012` | Base64 + eval 同一代码块 | `Buffer.from(base64).toString()` 紧邻 `eval()` |
| `MKT-EXEC-001:high` | exec + 调用点附近有破坏性命令 | `exec(cmd)` + `rm -rf` 在 150 字符内 |
| `MKT-FS-001:high` | writeFile + 调用点附近有破坏性命令 | 同上 |

### 5.2 需要持续关注的规则（可能有残留误报）

| 规则 | 潜在问题 | 后续方向 |
|------|----------|----------|
| `MKT-DATA-001` (21次) | 配置文件中的 `api_key = 'placeholder'` 可能被匹配 | 考虑排除 `.env.example`、`config.example.*` |
| `MKT-DATA-005/008` (各7次) | env + 网络在同文件出现，但不一定是外传 | 考虑调用点级关联 |
| `MKT-PERSIST-001` (8次) | 自启动/持久化模式可能在合法工具中出现 | 审查具体匹配内容 |

## 6. 文件变更清单

| 文件 | 变更 |
|------|------|
| `scripts/static-security.mjs` | 核心扫描逻辑修复（三轮共 ~100 行改动） |
| `docs/security-false-positive-analysis.md` | 本报告 |

## 7. 后续建议

1. **等待 CI 全量重扫**：72 个插件中 30 个已用 v10 扫描，剩余 42 个（v3 或 unknown）会在后续 CI 轮次中重扫。
2. **DATA-001 误报优化**：排除示例配置文件（`*.example.*`、`*.template.*`）中的占位密钥。
3. **DATA-005/008 调用点级关联**：当前仍为文件级匹配，可考虑降为调用点级。
4. **规则测试覆盖**：为每条规则添加正向/反向测试用例到 `smoke.mjs`。
5. **误报反馈机制**：在公开报告中添加 "report false positive" 链接。
