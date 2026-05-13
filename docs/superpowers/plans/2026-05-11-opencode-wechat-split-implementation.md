# opencode-wechat 全量复制拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 通过全量复制先行的路径创建独立 `opencode-wechat@0.1.0`，并把当前 root 包回迁为 Copilot-only 插件。

**架构：** 新仓库先从 root 工作区复制完整基线，再删除 Copilot-only 运行时并重写 WeChat-only 插件入口。Root 包执行相反方向的剥离，删除 WeChat broker / bridge / menu / settings / tests / dependencies，并用源码、`dist/`、真实 tarball 和 public export 负向验证锁住边界。

**技术栈：** Node.js >= 24、TypeScript、`@opencode-ai/plugin`、`@opencode-ai/sdk`、OpenClaw WeChat compat、`node --test`、npm pack / tarball smoke、GitHub Release + npm Trusted Publisher。

---

## 执行约束

1. 直接在 root `master` 主工作区执行，不创建 git worktree。
2. 新仓库路径固定为 `C:\Users\34404\Documents\GitHub\opencode-wechat`。
3. 不推送任何非主分支。
4. 不执行外部发布动作，除非用户再次明确授权。外部发布动作包括 `gh repo create`、`npm publish`、tag push、GitHub Release 和 Trusted Publisher 配置。
5. 所有 git 命令都显式设置 `GIT_MASTER=1`。
6. 文件列表搜索使用 `rg --files`，不得使用 `rtk grep --files`。
7. 每个新启动的开发或审查子代理 prompt 必须包含完整 spec 路径和完整 plan 路径，且正文超过 2000 字。
8. 当前计划文件与 spec 文件是开发输入。执行开发时不得跳过四路复审已经闭合的边界。
9. 提交动作只在用户明确授权时执行；未获授权时保留本地可审查工作树，不用 commit 代替交付。

## 关键输入

- Spec：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\specs\2026-05-11-opencode-wechat-split-design.md`
- Plan：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\plans\2026-05-11-opencode-wechat-split-implementation.md`
- Root 仓库：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher`
- 新仓库目标：`C:\Users\34404\Documents\GitHub\opencode-wechat`

## 文件结构决策

### 新 `opencode-wechat` 仓库

创建或保留：

- `src/index.ts`：只导出 `OpenCodeWechat` 和默认导出。
- `src/plugin.ts`：WeChat-only OpenCode 插件入口，负责 broker 连接、设置入口、hook 装配和测试 seam。
- `src/plugin-hooks.ts`：WeChat-only bridge lifecycle、TUI command、slash surface 和通知状态处理，不保留 Copilot fetch / routing / retry。
- `src/settings-store.ts`：由 `common-settings-store.ts` 重写而来，只负责 WeChat settings 与 legacy root settings 迁移。
- `src/settings-actions.ts`：由 `common-settings-actions.ts` 重写而来，只负责 WeChat bind / rebind / unbind / notification toggles。
- `src/store-paths.ts`：canonical path 改为 `~/.config/opencode/opencode-wechat/`，同时提供 legacy `account-switcher/wechat` 读取路径。
- `src/ui/wechat-menu.ts`：由 `src/ui/menu.ts` 重写而来，只保留 `OpenCode WeChat` 设置入口和 WeChat 菜单项。
- `src/wechat/**`：保留现有 broker、bridge、stores、OpenClaw compat 和 diagnostics。
- `scripts/clean-dist.mjs`：保留 build 前清理 `dist/`。
- `test/wechat-*.test.js`、`test/ui-menu-wechat.test.js`：迁入现有 WeChat 测试并修正 import。
- `test/wechat-plugin-entry.test.js`：新增插件入口与菜单 surface 测试。
- `test/package-boundary.test.js`：新增 source / dist / pack 负向边界测试。
- `test/wechat-migration.test.js`：新增 legacy settings / retained state / `/recover` 迁移测试。
- `test/wechat-surface-driver.test.js`：新增 slash surface 和 plugin load driver。
- `docs/publishing.md`、`docs/release-notes-template.md`、`docs/release-notes-v0.1.0.md`、`.github/workflows/release.yml`：首发发布链路文档与 OIDC workflow。

删除或重写：

- `src/active-account-quota.ts`
- `src/copilot-api-helpers.ts`
- `src/copilot-network-retry.ts`
- `src/copilot-retry-notifier.ts`
- `src/copilot-retry-policy.ts`
- `src/model-account-map.ts`
- `src/routing-state.ts`
- `src/session-control-command.ts`
- `src/status-command.ts`
- `src/store.ts`
- `src/providers/copilot-menu-adapter.ts`
- `src/providers/descriptor.ts`
- `src/providers/registry.ts`
- `src/menu-runtime.ts`
- `src/plugin-actions.ts`
- `src/upstream/copilot-loader-adapter.ts`
- `src/upstream/copilot-plugin.snapshot.ts`
- `scripts/sync-copilot-upstream.mjs`
- 所有 Copilot-only 测试。

### Root Copilot 仓库

修改：

- `src/plugin.ts`：删除 WeChat broker startup、WeChat action mapping、debug bundle 输出和 hook 传参。
- `src/plugin-hooks.ts`：删除 WeChat bridge global state、bridge-capable detection、TUI event tracking 和 lifecycle 调用。
- `src/providers/copilot-menu-adapter.ts`：删除 WeChat bind / rebind / debug bundle / toggle action。
- `src/ui/menu.ts`：删除 WeChat submenu、copy、binding 状态和 notification capability。
- `src/menu-runtime.ts`：删除 `wechat-*` provider action non-persistent 特例。
- `src/common-settings-store.ts`：删除 WeChat schema、legacy flat fields 和 `readWechatNotificationDispatchSettings()`。
- `src/common-settings-actions.ts`：删除 WeChat action。
- `src/store-paths.ts`：删除 `wechatConfigDir()`。
- `package.json`：删除 WeChat scripts、OpenClaw / WeChat dependencies 和 WeChat test shards。
- `package-lock.json`：重新生成，移除 OpenClaw / WeChat-only 依赖图。
- `README.md`：把内置微信功能改为独立 `opencode-wechat@0.1.0` 安装说明。
- `test/plugin.test.js`、`test/menu.test.js`、`test/common-settings-store.test.js`、`test/common-settings-actions.test.js`、`test/index-exports.test.js`：保留 Copilot 正向覆盖，加入 WeChat 缺席断言。

删除：

- `src/wechat/**`
- `test/wechat-*.test.js`
- `test/ui-menu-wechat.test.js`

---

### 任务 1：准备执行基线与复制新仓库

**文件：**
- 创建目录：`C:\Users\34404\Documents\GitHub\opencode-wechat`
- 读取：`package.json`
- 读取：`docs/superpowers/specs/2026-05-11-opencode-wechat-split-design.md`
- 读取：`docs/superpowers/plans/2026-05-11-opencode-wechat-split-implementation.md`

- [ ] **步骤 1：确认 root 工作区状态**

运行：

```powershell
$env:GIT_MASTER='1'; git status --short --branch
```

预期：第一行显示当前分支为 `master`；后续只看到当前 spec / plan 文档变更，或看到执行者明确拥有的本轮改动。若当前分支不是 `master`，或存在不属于本轮的源码改动，停止并向用户说明冲突文件。

- [ ] **步骤 2：确认新仓库目录不存在或为空**

运行：

```powershell
Test-Path -LiteralPath "C:\Users\34404\Documents\GitHub\opencode-wechat"
```

预期：返回 `False`，或返回 `True` 且目录为空。如果目录已存在且包含文件，停止并请用户确认是否删除或换路径。

- [ ] **步骤 3：复制 root 工作区为新仓库基线**

运行：

```powershell
robocopy "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher" "C:\Users\34404\Documents\GitHub\opencode-wechat" /E /XD .git node_modules dist .worktrees tmp /XF *.tgz
if ($LASTEXITCODE -le 7) { exit 0 } else { exit $LASTEXITCODE }
```

预期：目录复制完成，未复制 `.git/`、`node_modules/`、`dist/`、`.worktrees/`、`tmp/` 或 `*.tgz`。

- [ ] **步骤 4：确认复制后的新仓库不是 root worktree**

运行：

```powershell
Test-Path -LiteralPath "C:\Users\34404\Documents\GitHub\opencode-wechat\.git"
```

预期：返回 `False`。

- [ ] **步骤 5：列出新仓库关键文件**

运行：

```powershell
rg --files "C:\Users\34404\Documents\GitHub\opencode-wechat" | rg '(^|[\\/])(package\.json|src[\\/]plugin\.ts|src[\\/]wechat[\\/].*|test[\\/](wechat-.*\.test\.js|ui-menu-wechat\.test\.js)|README\.md|docs[\\/]release-notes-template\.md)$'
```

预期：能看到 `package.json`、`src/plugin.ts`、`src/wechat/**`、`README.md`，并能看到复制来的 WeChat 测试。

---

### 任务 2：新仓库元数据、脚本和发布文档

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\package.json`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\package-lock.json`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\README.md`
- 创建/修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\docs\publishing.md`
- 创建/修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\docs\release-notes-template.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\docs\release-notes-v0.1.0.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\.github\workflows\release.yml`

- [ ] **步骤 1：先写 package boundary 失败测试**

在 `test/package-boundary.test.js` 写入以下断言结构：

```js
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("package metadata targets opencode-wechat", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.name, "opencode-wechat")
  assert.equal(pkg.version, "0.1.0")
  assert.equal(pkg.description, "WeChat remote interaction plugin for OpenCode")
  assert.deepEqual(pkg.files, ["dist/", "README.md", "LICENSE"])
  assert.equal(pkg.dependencies["@tencent-weixin/openclaw-weixin"], "2.0.1")
  assert.equal(pkg.dependencies.openclaw, "2026.3.22")
  assert.equal(pkg.dependencies["@opencode-ai/plugin"], "^1.2.26")
  assert.equal(pkg.dependencies["@opencode-ai/sdk"], "^1.2.26")
  assert.equal(pkg.devDependencies.typescript, "^5.0.0")
  assert.equal(pkg.dependencies["github-copilot"], undefined)
})
```

- [ ] **步骤 2：运行边界测试确认失败**

运行：

```powershell
node --test test/package-boundary.test.js
```

预期：失败，错误显示 package name / version / dependencies 仍为 root 复制基线。

- [ ] **步骤 3：改写 `package.json`**

将 `package.json` 调整为 spec 中固定元数据：`name` 为 `opencode-wechat`、`version` 为 `0.1.0`、`main` 为 `./dist/index.js`、`types` 为 `./dist/index.d.ts`、`files` 为 `dist/` / `README.md` / `LICENSE`。scripts 必须显式保留 `prebuild: "node scripts/clean-dist.mjs"`，并只保留 build、typecheck、WeChat smoke、`test:wechat-real-host-gate`、`test` 和 `prepublishOnly`。删除 Copilot sync、Copilot-only test shards 和 root package scripts。

- [ ] **步骤 4：重新生成新仓库 lockfile**

运行：

```powershell
npm install --package-lock-only
```

预期：`package-lock.json` 顶层 `name` 为 `opencode-wechat`，`version` 为 `0.1.0`，依赖图不含 Copilot-only 包名。

- [ ] **步骤 5：写 release notes 模板**

`docs/release-notes-template.md` 必须包含：一句价值导语、`## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`。示例命令必须是：

```bash
opencode plugin opencode-wechat@0.1.0 --force -g
```

- [ ] **步骤 6：写 v0.1.0 release notes**

`docs/release-notes-v0.1.0.md` 使用模板结构，说明用户会获得独立 WeChat 远程交互插件，升级命令固定为 `opencode plugin opencode-wechat@0.1.0 --force -g`。

- [ ] **步骤 7：写 publishing 文档**

`docs/publishing.md` 必须包含这些二级标题：

```markdown
## 手动首发
## 发布前 fresh 验证
## npm Trusted Publisher 设置与验证
## 后续 GitHub Actions 发布
## GitHub Release 创建与验证
## 部分失败恢复
```

`部分失败恢复` 必须写明：`npm publish` 成功但 GitHub Release 失败时不得重复发布同版本，只补 `gh release create v0.1.0 --notes-file docs/release-notes-v0.1.0.md ...` 和远端验证。

- [ ] **步骤 8：写 OIDC release workflow**

`.github/workflows/release.yml` 必须在 GitHub Release published 后运行，包含 `permissions: id-token: write`，执行 install、build、test、version check、`npm publish --access public`。不得使用 `NODE_AUTH_TOKEN` 或 npm token secrets。

- [ ] **步骤 9：运行 package boundary 测试确认通过**

运行：

```powershell
node --test test/package-boundary.test.js
```

预期：`package metadata targets opencode-wechat` 通过。

---

### 任务 3：新仓库 WeChat-only 路径、settings 和迁移

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\store-paths.ts`
- 创建/重写：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\settings-store.ts`
- 创建/重写：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\settings-actions.ts`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\wechat\**`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\wechat-migration.test.js`

- [ ] **步骤 1：写 legacy 迁移失败测试**

`test/wechat-migration.test.js` 覆盖逐项映射：legacy `account-switcher/settings.json` 的 WeChat 字段迁入 `opencode-wechat/settings.json`，`operator.json`、`tokens/**`、`broker-state-store.json`、`latest-account.json`、`requests/**`、`notifications/**`、`dead-letter/**`、`instances/**` 迁入新路径。测试断言错误文件名 `broker-state.json` 和 `latest-account-state.json` 不会被创建。

- [ ] **步骤 2：运行迁移测试确认失败**

运行：

```powershell
node --test test/wechat-migration.test.js
```

预期：失败，错误显示 `settings-store.ts` 或新 canonical path 尚不存在。

- [ ] **步骤 3：重写 `src/store-paths.ts`**

导出这些路径函数：

```ts
export function opencodeWechatConfigDir(): string
export function wechatSettingsPath(): string
export function wechatLegacyConfigDir(): string
export function wechatOperatorPath(): string
export function wechatBrokerStateStorePath(): string
export function wechatLatestAccountPath(): string
export function wechatRequestsDir(): string
export function wechatNotificationsDir(): string
export function wechatDeadLetterDir(): string
export function wechatInstancesDir(): string
```

`opencodeWechatConfigDir()` 返回 `~/.config/opencode/opencode-wechat/`，`wechatLegacyConfigDir()` 返回旧 `~/.config/opencode/account-switcher/wechat/`。

- [ ] **步骤 4：重写 `src/settings-store.ts`**

实现 WeChat-only settings：binding、notification 总开关、question、permission、session error / retry-error。读取时新路径优先；新路径不存在且 legacy 存在时执行迁移；写入只写新路径。

- [ ] **步骤 5：重写 `src/settings-actions.ts`**

只保留 `wechat-bind`、`wechat-rebind`、`wechat-unbind`、`toggle-wechat-notifications`、`toggle-wechat-question-notifications`、`toggle-wechat-permission-notifications`、`toggle-wechat-session-error-notifications`、`toggle-wechat-retry-error-notifications`。

- [ ] **步骤 6：接入 retained state 迁移**

在 `src/wechat/**` 中把 requests、notifications、dead-letter、instances、diagnostics 路径改为新 canonical path。无法安全恢复旧 instance 时写稳定升级关闭原因，避免旧 handle 退化为 `not found`。

- [ ] **步骤 7：运行迁移测试确认通过**

运行：

```powershell
node --test test/wechat-migration.test.js
```

预期：legacy settings、operator、token、retained state 和 `/recover` 所需状态都迁入新路径，错误文件名不会出现。

---

### 任务 4：新仓库插件入口、菜单与 surface driver

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\index.ts`
- 重写：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\plugin.ts`
- 重写：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\plugin-hooks.ts`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\ui\wechat-menu.ts`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\wechat-plugin-entry.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\wechat-surface-driver.test.js`

- [ ] **步骤 1：写插件 entry 失败测试**

`test/wechat-plugin-entry.test.js` 断言 source entry 只导出 `OpenCodeWechat` 和默认导出，不导出 `CopilotAccountSwitcher`、`OpenAICodexAccountSwitcher` 或 `COPILOT_PROVIDER_DESCRIPTOR`。

- [ ] **步骤 2：写菜单 surface 失败测试**

同一测试文件断言插件注册入口的 `title` 为 `OpenCode WeChat`，`value` 为 `opencode-wechat.settings`，`category` 为 `OpenCode`。

- [ ] **步骤 3：写 slash surface driver 失败测试**

`test/wechat-surface-driver.test.js` 构造临时 broker authoritative view，调用 `/status`、`/todo`、`/reply q1 hello`、`/allow p1 once`、`/recover` 对应 handler，断言输出保持现有用户合同。

- [ ] **步骤 4：运行 entry / surface 测试确认失败**

运行：

```powershell
node --test test/wechat-plugin-entry.test.js test/wechat-surface-driver.test.js
```

预期：失败，错误显示仍导出 root 插件或无法找到 WeChat-only menu / slash seam。

- [ ] **步骤 5：重写 `src/index.ts`**

写成：

```ts
export { OpenCodeWechat } from "./plugin.js"
export { OpenCodeWechat as default } from "./plugin.js"
```

- [ ] **步骤 6：重写 `src/ui/wechat-menu.ts`**

菜单只包含当前绑定状态、绑定 / 重绑、通知总开关、question、permission、session error / retry-error、脱敏 debug bundle、完整 debug bundle、OpenClaw dry-run 命令展示。

- [ ] **步骤 7：重写 `src/plugin.ts`**

`OpenCodeWechat` 只做 WeChat 插件入口：读取 settings、连接或拉起 broker、注册 `OpenCode WeChat` 设置入口、注入 hook builder。不得导入 Copilot provider registry、Copilot menu adapter、Copilot retry、model routing 或 quota。

- [ ] **步骤 8：重写 `src/plugin-hooks.ts`**

只保留 WeChat broker / bridge lifecycle、TUI command、slash handlers、notification dispatch 和测试 seam。删除 Copilot auth loader、network retry、routing、status、compact、stop-tool 和 synthetic initiator。

- [ ] **步骤 9：运行 entry / surface 测试确认通过**

运行：

```powershell
node --test test/wechat-plugin-entry.test.js test/wechat-surface-driver.test.js
```

预期：插件 entry、菜单入口和 slash driver 全部通过。

---

### 任务 5：新仓库删除 Copilot 残留并锁 pack 边界

**文件：**
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\active-account-quota.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\copilot-api-helpers.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\copilot-network-retry.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\copilot-retry-notifier.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\copilot-retry-policy.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\model-account-map.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\routing-state.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\session-control-command.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\status-command.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\store.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\providers\copilot-menu-adapter.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\providers\descriptor.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\providers\registry.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\menu-runtime.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\plugin-actions.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\upstream\copilot-loader-adapter.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\src\upstream\copilot-plugin.snapshot.ts`
- 删除：`C:\Users\34404\Documents\GitHub\opencode-wechat\scripts\sync-copilot-upstream.mjs`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\package-boundary.test.js`

- [ ] **步骤 1：扩展 package boundary 负向测试**

在 `test/package-boundary.test.js` 增加 source scan：`rg` 或 Node 递归读取 `src/`，断言运行时代码不含 `CopilotAccountSwitcher`、`github-copilot`、`COPILOT_PROVIDER_DESCRIPTOR`、`createCopilotRetryingFetch`、`modelAccountAssignments`、`sync-copilot-upstream`、`copilot-plugin.snapshot`。

- [ ] **步骤 2：运行负向测试确认失败**

运行：

```powershell
node --test test/package-boundary.test.js
```

预期：失败，错误指向复制基线中的 Copilot-only 文件或关键词。

- [ ] **步骤 3：删除 Copilot-only 源码、脚本和测试**

删除本任务文件列表中的 Copilot-only 文件，并删除对应 Copilot-only 测试。保留 `src/wechat/**`、WeChat tests、UI primitives、`scripts/clean-dist.mjs` 和必要 TypeScript 配置。

- [ ] **步骤 4：修正 TypeScript imports**

运行：

```powershell
npm run typecheck
```

预期：第一次可能失败，错误全部是已删除 Copilot 模块的 import。逐个移除 import 或替换为 WeChat-only seam 后重跑，最终退出码为 0。

- [ ] **步骤 5：验证 dist 清理**

运行：

```powershell
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$matches = rg "CopilotAccountSwitcher|github-copilot|COPILOT_PROVIDER_DESCRIPTOR|createCopilotRetryingFetch|modelAccountAssignments" dist
if ($LASTEXITCODE -eq 0) { $matches; exit 1 }
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }
```

预期：`npm run build` 成功；`rg` 对 `dist/` 没有匹配。

- [ ] **步骤 6：实现真实 tarball 三段式 smoke**

在 `test/package-boundary.test.js` 或独立 helper 中添加三段式断言：实际 `npm pack --json`、临时目录解包并读 `package/package.json`、临时目录安装 tarball 后 import 包入口。只允许 `OpenCodeWechat` 和 default export。

- [ ] **步骤 7：运行新包边界测试确认通过**

运行：

```powershell
node --test test/package-boundary.test.js
```

预期：source、dist、pack JSON、解包 metadata、临时安装 import 均无 Copilot 残留。

---

### 任务 6：新仓库 fresh 验证与 manual QA drivers

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\wechat-plugin-entry.test.js`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\wechat-surface-driver.test.js`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\test\package-boundary.test.js`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-wechat\README.md`

- [ ] **步骤 1：运行新包 build**

运行：

```powershell
npm run build
```

预期：退出码 0，`dist/index.js` 和 `dist/wechat/**` 存在。

- [ ] **步骤 2：运行新包 typecheck**

运行：

```powershell
npm run typecheck
```

预期：退出码 0。

- [ ] **步骤 3：运行新包完整测试**

运行：

```powershell
npm test
```

预期：退出码 0，所有 WeChat tests、migration tests、surface drivers 和 package boundary tests 通过。

- [ ] **步骤 4：运行 pack dry-run**

运行：

```powershell
npm pack --dry-run --json
```

预期：pack 清单含 `dist/`、`README.md`、`LICENSE`、`package.json`，不含 Copilot-only source 或 test。

- [ ] **步骤 5：运行真实 tarball install / import smoke**

运行：

```powershell
$packJson = npm pack --json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$pack = @($packJson | ConvertFrom-Json)
$tgz = Join-Path (Get-Location) $pack[0].filename
$tmp = Join-Path $env:TEMP ("opencode-wechat-pack-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
npm init -y --prefix $tmp | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm install --prefix $tmp $tgz
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location $tmp
$nodeExit = 0
try {
  node --input-type=module -e "const mod = await import('opencode-wechat'); const keys = Object.keys(mod).sort(); console.log(keys.join(',')); if (keys.length !== 2 || !keys.includes('OpenCodeWechat') || !keys.includes('default') || keys.includes('CopilotAccountSwitcher')) process.exit(1)"
  $nodeExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($nodeExit -ne 0) { exit $nodeExit }
```

预期：输出只包含 `OpenCodeWechat` 和 `default` 相关 public exports，无 Copilot export。

- [ ] **步骤 6：运行 OpenClaw dry-run**

运行：

```powershell
npm run wechat:smoke:real-account -- --dry-run
```

预期：退出码 0，输出 OpenClaw dry-run 准备检查结果。

- [ ] **步骤 7：记录 optional observational gate 状态**

不要把 live real-account smoke 或 Windows PTY / 真实宿主 gate 作为 release-blocking。若运行并失败，记录具体环境错误和是否暴露代码缺陷；没有用户授权或环境不可用时，不运行真实账号登录。

---

### 任务 7：Root 先写 WeChat 缺席测试并重写测试脚本

**文件：**
- 修改：`package.json`
- 修改：`test/index-exports.test.js`
- 修改：`test/plugin.test.js`
- 修改：`test/menu.test.js`
- 修改：`test/common-settings-store.test.js`
- 修改：`test/common-settings-actions.test.js`
- 创建：`test/root-package-boundary.test.js`

- [ ] **步骤 1：扩展 public export 负向测试**

在 `test/index-exports.test.js` 中增加断言：source 和 dist entry 不导出 `OpenCodeWechat`，不导出 WeChat handler，不导出 WeChat provider descriptor。

- [ ] **步骤 2：新增 root package boundary 失败测试**

`test/root-package-boundary.test.js` 扫描 source、dist 和 `npm pack --dry-run --json`，断言不含 `src/wechat`、`dist/wechat`、`wechat:smoke`、`test/wechat-`、`@tencent-weixin/openclaw-weixin`、`openclaw`、`wechat-bind`、`wechat-export-debug-bundle`、`toggle-wechat`。

- [ ] **步骤 3：改写混合测试为 Copilot 正向 + WeChat 缺席**

`test/plugin.test.js` 删除 WeChat broker lifecycle 正向断言，新增 hooks driver 断言加载 Copilot plugin 时不会调用 `ensureWechatBrokerStarted` 或 `createWechatBridgeLifecycleImpl`。`test/menu.test.js` 新增菜单 action 列表不包含 `wechat-*`。`test/common-settings-store.test.js` 断言写入 settings 后不会持久化 `wechat` 或 legacy flat WeChat 字段。`test/common-settings-actions.test.js` 断言 WeChat actions 不再属于合法 action union。

- [ ] **步骤 4：运行新增/修改测试确认失败**

运行：

```powershell
node --test test/index-exports.test.js test/root-package-boundary.test.js test/plugin.test.js test/menu.test.js test/common-settings-store.test.js test/common-settings-actions.test.js
```

预期：失败，错误来自当前 root 仍包含 WeChat 源码、菜单或 settings。

- [ ] **步骤 5：先重写 root test scripts**

在 `package.json` 中删除 `test:wechat-real-host-gate`、`test:serial:wechat-*`、`wechat:smoke:*` 和 `test:parallel:shard` 中的 `test/wechat-*` / `test/ui-menu-wechat.test.js`。保留 Copilot、common settings、package boundary 和 root 缺席断言。`npm test` 必须覆盖完整 Copilot-only test suite。

Root scripts 必须继续显式保留 `prebuild: "node scripts/clean-dist.mjs"`，确保每次 `npm run build` 前清理旧 `dist/`，防止历史 `dist/wechat/**` 进入 pack smoke。

- [ ] **步骤 6：确认脚本不再引用 WeChat tests**

运行：

```powershell
node -e "const pkg=require('./package.json'); const text=JSON.stringify(pkg.scripts); for (const bad of ['test/wechat-','test/ui-menu-wechat.test.js','test:wechat-real-host-gate','wechat:smoke']) { if (text.includes(bad)) { console.error(bad); process.exit(1) } }"
```

预期：退出码 0。

---

### 任务 8：Root 删除 WeChat 运行时代码和依赖

**文件：**
- 修改：`src/plugin.ts`
- 修改：`src/plugin-hooks.ts`
- 修改：`src/providers/copilot-menu-adapter.ts`
- 修改：`src/ui/menu.ts`
- 修改：`src/menu-runtime.ts`
- 修改：`src/common-settings-store.ts`
- 修改：`src/common-settings-actions.ts`
- 修改：`src/store-paths.ts`
- 删除：`src/wechat/**`
- 删除：`test/wechat-*.test.js`
- 删除：`test/ui-menu-wechat.test.js`
- 修改：`package.json`
- 修改：`package-lock.json`

- [ ] **步骤 1：删除 WeChat source 和 tests**

删除 `src/wechat/**`、`test/wechat-*.test.js` 和 `test/ui-menu-wechat.test.js`。不要删除 Copilot tests 或 shared UI primitives。

- [ ] **步骤 2：剥离 `src/plugin.ts`**

删除 `connectOrSpawnBroker()`、broker startup diagnostics、`WechatBrokerConnection`、`toSharedRuntimeAction()` 中的 `wechat-*` mapping、debug bundle output handling、`initialWechatBrokerPromise`、`ensureWechatBrokerStarted` 和 `createWechatBridgeLifecycleImpl` 传参。保留 Copilot auth method、provider registry、menu adapter 和 Copilot hooks。

- [ ] **步骤 3：剥离 `src/plugin-hooks.ts`**

删除 `createWechatBridgeLifecycle()` import、WeChat bridge global state、session tracking、bridge-capable detection、TUI event tracking 和 lifecycle auto-close。保留 Copilot auth loader、network retry、model routing、status、compact、stop-tool 和 synthetic initiator。

- [ ] **步骤 4：剥离菜单和 action files**

`src/providers/copilot-menu-adapter.ts`、`src/ui/menu.ts`、`src/menu-runtime.ts`、`src/common-settings-actions.ts` 删除所有 WeChat actions 和 copy。`src/menu-runtime.ts` 的 non-persistent action 不再识别 `wechat-bind` 或 `wechat-export-debug-bundle`。

- [ ] **步骤 5：剥离 settings 和 path files**

`src/common-settings-store.ts` 删除 `WechatMenuSettings`、`WechatNotificationDispatchSettings`、legacy flat fields、`normalizeWechatSettings()`、`readWechatNotificationDispatchSettings()`。`src/store-paths.ts` 删除 `wechatConfigDir()`。

- [ ] **步骤 6：删除 WeChat dependencies 并重建 lockfile**

从 `package.json` dependencies 删除 `@tencent-weixin/openclaw-weixin`、`openclaw`、`fflate`、`xdg-basedir` 中只由 WeChat 使用的依赖。运行：

```powershell
npm install --package-lock-only
```

预期：`package-lock.json` 中不再包含 OpenClaw / WeChat-only 依赖图。

- [ ] **步骤 7：运行 TypeScript diagnostics 和 targeted tests**

运行：

```powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --test test/index-exports.test.js test/root-package-boundary.test.js test/plugin.test.js test/menu.test.js test/common-settings-store.test.js test/common-settings-actions.test.js
```

预期：typecheck 退出码 0；targeted tests 通过。

---

### 任务 9：Root README、package boundary 和三段式 tarball smoke

**文件：**
- 修改：`README.md`
- 修改：`test/root-package-boundary.test.js`
- 修改：`test/index-exports.test.js`

- [ ] **步骤 1：更新 README 微信说明**

删除 root 内置“微信通知功能”说明，替换为独立插件说明：

````markdown
## 微信远程交互

微信远程交互已经拆分到独立插件 `opencode-wechat`。如果你需要微信绑定、通知、`/status`、`/todo`、`/reply`、`/allow`、`/recover`、debug bundle 或 OpenClaw smoke，请安装：

```bash
opencode plugin opencode-wechat@0.1.0 --force -g
```
````

Root README 不再宣称 Copilot 包内置微信 broker 或 bridge。

- [ ] **步骤 2：扩展 README 边界测试**

`test/root-package-boundary.test.js` 读取 `README.md`，断言包含 `opencode-wechat@0.1.0` 安装命令，且不包含“内置微信通知功能”或 root 包安装微信能力的旧文案。

- [ ] **步骤 3：实现 root 三段式 tarball smoke 测试**

`test/root-package-boundary.test.js` 必须实际运行 `npm pack --json`，解析 pack JSON 文件列表；临时目录解包 tarball 并读取 `package/package.json`；临时目录安装 tarball 后从包入口 import。只允许 `CopilotAccountSwitcher` 和 root 既有 public export 白名单，禁止 `OpenCodeWechat` 或任何 WeChat export。

- [ ] **步骤 4：运行 root package boundary test**

运行：

```powershell
node --test test/root-package-boundary.test.js
```

预期：source、dist、pack JSON、解包 metadata、临时安装 import 和 README 边界全部通过。

---

### 任务 10：Root fresh 验证与 manual QA drivers

**文件：**
- 修改：`test/root-package-boundary.test.js`
- 修改：`test/plugin.test.js`
- 修改：`test/menu.test.js`

- [ ] **步骤 1：运行 root build**

运行：

```powershell
npm run build
```

预期：退出码 0，`dist/index.js` 存在，`dist/wechat/**` 不存在。

- [ ] **步骤 2：运行 root typecheck**

运行：

```powershell
npm run typecheck
```

预期：退出码 0。

- [ ] **步骤 3：运行 root 完整测试**

运行：

```powershell
npm test
```

预期：退出码 0，测试脚本不引用已删除 WeChat files。

- [ ] **步骤 4：运行 root pack dry-run**

运行：

```powershell
npm pack --dry-run --json
```

预期：pack 清单不包含 `dist/wechat/**`、`src/wechat/**`、WeChat tests、OpenClaw 或 WeChat-only scripts。

- [ ] **步骤 5：运行 root 三段式 tarball smoke**

运行 `test/root-package-boundary.test.js` 中的 tarball smoke，或执行等价命令：真实 `npm pack --json`、临时解包读取 `package/package.json`、临时安装后 import 包入口。

预期：临时安装 import 的 export keys 只包含 `CopilotAccountSwitcher` 和 root 既有 public export 白名单。

- [ ] **步骤 6：运行 manual QA driver**

运行：

```powershell
$packJson = npm pack --json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$pack = @($packJson | ConvertFrom-Json)
$tgz = Join-Path (Get-Location) $pack[0].filename
$tmp = Join-Path $env:TEMP ("opencode-copilot-pack-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
npm init -y --prefix $tmp | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm install --prefix $tmp $tgz
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location $tmp
$nodeExit = 0
try {
  node --input-type=module -e "const mod = await import('opencode-copilot-account-switcher'); const keys = Object.keys(mod).sort(); console.log(keys.join(',')); if (!keys.includes('CopilotAccountSwitcher') || keys.includes('OpenCodeWechat')) process.exit(1)"
  $nodeExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($nodeExit -ne 0) { exit $nodeExit }
node --test test/menu.test.js test/plugin.test.js
```

预期：临时安装后的 public entry 只有 Copilot；菜单 driver 无 WeChat entry；hooks driver 不触发 WeChat broker / bridge seam。

---

### 任务 11：新仓库本地待发布状态

**文件：**
- 读取：`C:\Users\34404\Documents\GitHub\opencode-wechat\docs\publishing.md`
- 读取：`C:\Users\34404\Documents\GitHub\opencode-wechat\docs\release-notes-v0.1.0.md`
- 读取：`C:\Users\34404\Documents\GitHub\opencode-wechat\.github\workflows\release.yml`

- [ ] **步骤 1：检查新仓库 publish docs 与 release notes**

运行：

```powershell
rg -n "适合谁升级|你会看到的变化|升级方式|opencode-wechat@0.1.0|Summary \+ Test Plan|opencode-copilot-account-switcher@" "C:\Users\34404\Documents\GitHub\opencode-wechat\docs"
```

预期：命中 required sections 和 `opencode-wechat@0.1.0`；`Summary + Test Plan` 只允许出现在禁止说明中；不得命中旧 root 安装命令。`NODE_AUTH_TOKEN` 只在下一步 workflow 文件检查中验证，不在 docs grep 中混查。

- [ ] **步骤 2：检查 release workflow OIDC 约束**

运行：

```powershell
rg -n "id-token: write|npm publish --access public|NODE_AUTH_TOKEN|secrets\.NPM" "C:\Users\34404\Documents\GitHub\opencode-wechat\.github\workflows\release.yml"
```

预期：命中 `id-token: write` 和 `npm publish --access public`；不得命中 `NODE_AUTH_TOKEN` 或 `secrets.NPM`。

- [ ] **步骤 3：停在本地待发布状态**

不要执行 `gh repo create`、`npm publish`、tag push 或 GitHub Release。向用户报告本地验证证据和需要授权的外部动作列表。若用户后续授权外部发布，新仓库初始化命令必须在 `C:\Users\34404\Documents\GitHub\opencode-wechat` 中执行，并写成：

```powershell
$env:GIT_MASTER='1'; git init
$env:GIT_MASTER='1'; git branch -M master
$env:GIT_MASTER='1'; git status --short
```

后续 initial commit、tag 和 push 命令也必须逐条设置 `$env:GIT_MASTER='1'`，不得推送非 `master` 分支。

---

### 任务 12：最终交叉验证与审查

**文件：**
- Root 全仓库
- `C:\Users\34404\Documents\GitHub\opencode-wechat` 全仓库

- [ ] **步骤 1：Root 源码 / dist / pack 负向扫描**

运行：

```powershell
rg -n "src/wechat|dist/wechat|wechat:smoke|test/wechat-|test/ui-menu-wechat\.test\.js|@tencent-weixin/openclaw-weixin|openclaw|wechat-bind|wechat-export-debug-bundle|toggle-wechat" src dist test scripts package.json package-lock.json
```

预期：root 运行时代码、测试脚本、dist、package metadata 和 lockfile 无匹配；README 边界由任务 9 单独检查，允许出现 `opencode-wechat@0.1.0` 独立安装说明和独立插件能力描述。

- [ ] **步骤 2：新仓库 Copilot 残留扫描**

运行：

```powershell
rg -n "CopilotAccountSwitcher|github-copilot|COPILOT_PROVIDER_DESCRIPTOR|createCopilotRetryingFetch|modelAccountAssignments|sync-copilot-upstream|copilot-plugin.snapshot" "C:\Users\34404\Documents\GitHub\opencode-wechat\src" "C:\Users\34404\Documents\GitHub\opencode-wechat\dist" "C:\Users\34404\Documents\GitHub\opencode-wechat\package.json"
```

预期：无匹配。README 的边界说明可以提到 root 包名，但运行时代码、dist 和 package metadata 不得含 Copilot runtime。

- [ ] **步骤 3：运行 LSP diagnostics**

对改动过的 root TypeScript 文件和新仓库 TypeScript 文件运行 diagnostics。预期：没有 error。

- [ ] **步骤 4：请求只读复审**

并发启动 3-5 个只读子代理，至少覆盖：新包边界、root 回迁边界、验证 / 发布链路。每个新子代理 prompt 必须包含完整 spec 路径和完整 plan 路径，正文超过 2000 字。

- [ ] **步骤 5：处理复审反馈**

若复审为 `NEEDS CHANGES`，按 `receiving-code-review` 流程验证反馈、修改、重跑相关验证，再进行 targeted 复审。所有 review 维度 PASS 后才报告完成。

---

## 子代理执行模板

新启动子代理时使用以下结构，并把正文扩展到超过 2000 字：

```text
CONTEXT:
Root 仓库路径：C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher
新仓库路径：C:\Users\34404\Documents\GitHub\opencode-wechat
Spec 完整路径：C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\specs\2026-05-11-opencode-wechat-split-design.md
Plan 完整路径：C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\plans\2026-05-11-opencode-wechat-split-implementation.md

GOAL:
执行或审查任务 N 的明确边界，不使用 worktree，不推非主分支，不执行外部 release 动作。

DOWNSTREAM:
主代理会读取你的结果，验证所有文件和命令输出，并继续下一任务或修复反馈。

REQUEST:
按 plan 的任务 N 操作。若发现 spec 与 plan 冲突，以 spec 为准并报告冲突。不得跳过 fresh 验证、pack smoke 或 manual QA driver。
```

## 计划自检清单

- [ ] 每个 spec 章节都能映射到一个任务：全量复制、opencode-wechat 剥离、root 回迁、迁移、测试、fresh gate、manual QA、发布链路、root 不发布。
- [ ] 计划不包含未完成占位词：`TODO`、`TBD`、`待定`、`类似任务`、`添加适当的错误处理`。
- [ ] `OpenCode WeChat`、`opencode-wechat.settings`、`opencode-wechat@0.1.0` 命名一致。
- [ ] 新包 `package-lock.json` 和 root `package-lock.json` 都有明确重新生成步骤。
- [ ] 新包和 root 都有真实 `npm pack --json`、临时解包、临时安装 import 的三段式 tarball smoke。
- [ ] 发布动作被明确标为需要用户再次授权。
