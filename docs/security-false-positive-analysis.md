# 静态安全扫描器误报修复报告

> 日期：2026-08-19 | 规则集版本：Ruleset 2026-12 (v10) | 扫描器版本：见 `SCANNER_VERSION`

## 1. 问题背景

CI 重新扫描后，54 个插件中 49 个被标记为 high 风险。`MKT-EXEC-001` 触发 952 次，`MKT-EXEC-009` 触发 176 次。大量正常代码（`exec('npm run build')`、`writeFile()`、`fetch()`）被误判为高危操作。

**结论**：不是标注问题，而是检测逻辑存在 5 个系统性缺陷，导致大规模误报和重复发现。

## 2. 根因分析与修复

### 2.1 `runCapabilityAnalysis` / `runRegexRule` 每文件生成多条重复 finding

**根因**：`runCapabilityAnalysis` 对每个 `exec()` 调用生成一条 finding（上限 5 条/文件），`runRegexRule` 同样每文件最多 5 条。一个 Electron 应用 50 个文件用 `exec`/`writeFile`，产生 250+ 条发现。

**修复**：两条函数均改为每文件每规则只生成一条 finding，消息中包含匹配次数（如 "invokes an operating-system process API (3 calls in this file)"）。

**效果**：单个插件的 finding 数量从数百条降至个位数。

### 2.2 `MKT-SKILL-004` 在代码文件上运行

**根因**：`SKILL_HIJACK_RULES` 的运行条件被改为 `isSkill || isCode`，导致 `.ts`/`.js` 代码文件中 `export...message`、`send...chat` 等正常代码词汇被匹配为 exfiltration guidance。111 次误报。

**修复**：
1. 运行条件恢复为 `isSkill`（仅在 SKILL.md 等技能描述文件上运行）
2. 正则表达式收窄：
   - 高危动词 `exfiltrate/harvest/dump/collect/gather` + 对话数据关键词
   - 或 `send/transmit/upload/export` + 对话数据关键词 + 远程目标词（remote/external/server/webhook/api/url/http）

**效果**：正常 SKILL.md 描述 "export conversation history to a file" 不再触发；"harvest chat history" 仍正确触发。

### 2.3 `MKT-CI-003` / `MKT-CI-004` 风险等级过高

**根因**：
- `MKT-CI-003`（checkout 缺少 `persist-credentials: false`）：84 次匹配，risk=high。但这是常见疏忽，多数项目未设置此项。
- `MKT-CI-004`（`npm install`）：59 次匹配，risk=high。但每个 Node.js 项目的 CI 都会跑 `npm install`。

**修复**：
- `MKT-CI-003`：risk 从 `high` 降为 `medium`
- `MKT-CI-004`：risk 从 `high` 降为 `medium`，confidence 从 `medium` 降为 `low`

### 2.4 `MKT-EXEC-009` 正则不精确

**根因**：`import\s*\(\s*(?![\"\'`])` 负向前瞻只排除引号开头的参数，但 `import(/* comment */` 和 `import(\n  "module"` 也被匹配为动态导入。176 次误报。

**修复**：改为 `import\s*\(\s*[A-Za-z_$]|\bimport\s*\(\s*\`\$\{`，只匹配：
- 变量名开头的 `import(variable)`
- 模板字符串插值的 `import(\`${...}`)

**效果**：`import('./config.js')` 不再触发；`import(modulePath)` 仍正确触发。risk 从 `high` 降为 `medium`。

### 2.5 测试文件中的假密钥触发 `MKT-DATA-001`

**根因**：`runKeyDetection`、`runEnvSecretDetection`、`runSuspiciousDestDetection` 未跳过测试文件。测试文件中的假 API key（`'sk-1234567890abcdef...'`）被检测为真实密钥泄露。104 次误报。

**修复**：所有检测函数添加 `!TEST_PATH.test(display)` 条件，跳过 `test/`、`tests/`、`__tests__/`、`*.test.*`、`*.spec.*` 等路径。

### 2.6 `assessEvidenceStrength` 误匹配方法调用

**根因**：`highStrength` 数组包含 `/shutdown/`、`/reboot/`，`server.shutdown()` 方法调用会将证据强度提升到 high，与 `DESTRUCTIVE_SYSTEM` 相同的误报模式。

**修复**：从 `highStrength` 数组中移除 `/shutdown/`、`/reboot/`。

### 2.7 `ENV_SENSITIVE_PATTERNS` 中 `.env` 匹配 `process.env`

**根因**：`process.env.DEEPSEEK_API_KEY` 中的 `.env` 被正则 `\.env(?:\b|$|\.|/)` 匹配为 dotenv 文件引用，导致 `containsEnvAccess` 误返回 true，触发 `MKT-DATA-005` 和 `MKT-DATA-008`。

**修复**：正则改为 `(?<!process)\.env(?:\b|$|/|\\)`，添加负向后顾排除 `process.env`。

### 2.8 `checkWorkflowIntegrity` 与 `CI_INTEGRITY_RULES` 重复检测

**根因**：`checkWorkflowIntegrity` 已详细检测所有 CI 规则（CI-001 至 CI-008），但 `CI_INTEGRITY_RULES` regex 仍在 workflow 文件上重复运行，导致同一模式生成两条 finding。

**修复**：workflow 文件只走 `checkWorkflowIntegrity`，不再跑 `CI_INTEGRITY_RULES` regex。

## 3. 正则表达式修复汇总

| 规则 | 修复前 | 修复后 | 问题 |
|------|--------|--------|------|
| `EXECUTION_CALL` | `exec` 无 `(` 要求 | 要求 `exec(` 函数调用形式 | 匹配注释和 import 中的 exec |
| `DESTRUCTIVE_SYSTEM` | `shutdown` 无上下文 | `(?<!\.)shutdown(?!\s*[=()])` | 匹配方法调用和变量赋值 |
| `EXEC_SINK` | `require\([^)]+\)` | `require\((?![\"\'\`])` | 匹配 `require('fs')` |
| `NETWORK_SINK` | 缺少方法调用 | 添加 `axios\.get\(` 等 | 遗漏方法链式调用 |
| `SECRET_SOURCE` | 含 `process.env` | 移除宽泛匹配 | 匹配任意 env 访问 |
| `ENV_SENSITIVE` | `\.env` | `(?<!process)\.env` | 匹配 `process.env` |
| `MKT-EXEC-009` | `import\((?![\"\'\`])` | `import\(\s*[A-Za-z_$]` | 匹配注释和换行 |
| `MKT-SKILL-004` | 宽泛动词匹配 | 要求高危动词或远程目标 | 匹配正常代码词汇 |
| `MKT-EXEC-010` | 负向匹配 string | 正向匹配 string | 逻辑反转 |

## 4. 测试验证

### 4.1 测试用例与结果

| 场景 | 修复前 risk | 修复后 risk | 修复前 findings | 修复后 findings | high 数 |
|------|-------------|-------------|-----------------|-----------------|---------|
| 正常 Electron 应用（exec+writeFile） | high | medium | 数百条 | 2 | 0 |
| 正常 CI 工作流（npm install） | high | medium | 3 | 1 | 0 |
| 测试文件中的假密钥 | high | low | 1+ | 0 | 0 |
| SKILL.md 正常描述 | high | low | 2+ | 0 | 0 |
| exec(variable) + 破坏性命令 | high | high | 多条 | 1 | 1 |
| 危险 CI（pull_request_target + curl\|bash） | high | high | 8 | 4 | 2 |
| 正常 fetch + writeFile | high | medium | 多条 | 1 | 0 |
| 动态 import(variable) | high | medium | 多条 | 1 | 0 |

### 4.2 冒烟测试

`node scripts/smoke.mjs` — 14 项全部通过，包括：
- 保护条件降级验证
- 关联敏感来源与外传验证
- 文档和 fixture 文件不触发 finding 验证

## 5. 修复后仍为 high 的规则（合理保留）

以下规则在修复后仍可能产生 high 风险，这些是真正的安全威胁：

| 规则 | 触发条件 | 合理性 |
|------|----------|--------|
| `MKT-EXEC-001:high` | `exec()` + 文件中存在破坏性命令（`rm -rf`、`mkfs`、`dd if=`） | 系统影响模式确实存在 |
| `MKT-FS-001:high` | `writeFile()` + 文件中存在破坏性命令 | 同上 |
| `MKT-DATA-001:high` | 生产代码中检测到真实 API key 模式 | 真实密钥泄露 |
| `MKT-DATA-003:high` | `SECRET_SOURCE` + `NETWORK_SINK` 同时匹配 | 密钥外传组合 |
| `MKT-CI-001:high` | `pull_request_target` + `head.sha` checkout | PR 代码在特权上下文执行 |
| `MKT-CI-002:high` | `workflows:write` 或 `secrets:write` 权限 | 过度授权 |
| `MKT-CI-005:high` | `curl|bash` 管道执行 | 下载并执行远程代码 |
| `MKT-CI-007:high` | `*: write` 或 `write-all` 权限 | 通配符权限 |
| `MKT-EXEC-012:high` | `eval()` + Base64 解码组合 | 混淆执行链 |

## 6. 文件变更清单

- `scripts/static-security.mjs` — 核心扫描逻辑修复
- `scripts/merge-security-receipts.mjs` — 公开报告字段处理
- `docs/security-scanning.md` — 设计文档同步更新

## 7. 后续建议

1. **CI 重新扫描**：修复已合并到 main，CI 会自动重新扫描所有插件。预计 high 风险插件数从 49 降至 10-15 个（仅保留真正危险的插件）。
2. **规则审计周期**：建议每季度审查一次规则正则表达式和风险等级，确保与最新攻击模式同步。
3. **误报反馈机制**：在公开报告中添加 "report false positive" 链接，让插件作者可以反馈误报。
4. **规则测试覆盖**：建议为每条规则添加正向和反向测试用例，防止回归。
