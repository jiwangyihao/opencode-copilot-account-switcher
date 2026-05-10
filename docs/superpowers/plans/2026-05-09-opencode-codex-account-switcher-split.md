# opencode-openai-account-switcher 拆分与首发实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。所有新启动的子代理提示词必须超过 2000 字，并包含本计划与规格的完整路径。

**目标：** 将 Codex / OpenAI 账号切换能力从 `opencode-copilot-account-switcher` 拆成独立包 `opencode-openai-account-switcher@0.1.0`，把当前 root 包回迁为 Copilot-only，并为 Codex / OpenAI 独立包补齐首发发布链路。

**架构：** 新 Codex / OpenAI 包拥有 `OpenAICodexAccountSwitcher`、`openai` provider、Codex store、status、retry、upstream snapshot、菜单和 snapshot sync；root Copilot 包删除 Codex export、provider wiring、hook 分支、tests、scripts 与打包产物。首轮不抽 shared-core，必要的稳定公共运行时代码按最小集合复制到 Codex 包；Codex 菜单直接移除微信相关动作。首发链路只发布 `opencode-openai-account-switcher@0.1.0`，不发布 root Copilot 包。

**技术栈：** TypeScript、Node.js 24、ESM、`@opencode-ai/plugin`、Node test runner、npm pack dry-run、临时 tarball import smoke、PowerShell、Git（所有 git 命令必须设置 `$env:GIT_MASTER='1'`）、npm publish、npm Trusted Publisher、GitHub CLI。

---

## 文档与执行入口

- 规格：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\specs\2026-05-09-opencode-codex-account-switcher-split-design.md`
- 计划：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\plans\2026-05-09-opencode-codex-account-switcher-split.md`
- 主工作区：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher`
- 新 Codex 包目录：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher`
- 新 npm 包名：`opencode-openai-account-switcher`
- 旧候选包名：`opencode-codex-account-switcher`，已被他人发布且当前 npm 用户不是 maintainer，本轮不再使用。
- 临时 split worktree：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-codex-account-switcher-split`，只作为已审查规格来源，不用于实现。

## 全局执行约束

- 直接在主工作区的 `master` 上修改 root Copilot 包；不创建新的 worktree，不在现有 split worktree 中实现。
- 新 Codex 包目录是普通 sibling 目录，不是当前仓库的 worktree。若目录已存在且非空，先读取内容并确认没有用户未整合工作，再继续。
- 不推送非主分支；root `opencode-copilot-account-switcher` 仅保留本地拆分与文档提交，任何 root 发版动作都排除在 Codex / OpenAI 首发链路之外。
- Codex / OpenAI 独立包 `opencode-openai-account-switcher@0.1.0` 需要在 fresh 验证后执行首发链路：初始化 git、创建 GitHub repo、发布 npm、配置 Trusted Publisher、推送 tag、创建并验证 GitHub Release。执行外部发布动作前必须确认用户授权。
- 写实现前先运行：`$env:GIT_MASTER='1'; git status --short --branch` 与 `$env:GIT_MASTER='1'; git ls-remote --heads origin`，确认 root 在 `master...origin/master` 且远端只有 `refs/heads/master`。
- 用户已授权本地 commit；push、npm publish、tag 和 GitHub Release 属于外部发布动作，执行前需要再次确认授权。
- 每个行为变更按 TDD：先写或翻转测试，运行确认失败，再写最小实现，最后运行 targeted 测试和相关 build/typecheck。
- 每个新启动的子代理必须收到完整规格路径、完整计划路径、当前任务编号、工作目录、禁止 root release、禁止非主分支 push、禁止未经授权执行外部发布动作和禁止 worktree 实现的约束，并且提示词超过 2000 字。
- 子代理完成任务后，父会话必须检查 diff、运行对应验证，再进入下一任务。
- 所有 pack 边界验证必须先 `npm run build` 触发 clean-dist，再执行 `npm pack --dry-run --json`，解析第一个结果的 `files[].path`。
- Windows WeChat real-host gate 若出现 `AttachConsole failed`，按既有环境 caveat 记录 fresh 输出；Codex 自身迁移测试不能依赖该 gate。

## 文件结构预分解

### 新 Codex 包

- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\package.json`：Codex 包元数据、exports、scripts、dependencies、files 白名单。
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\tsconfig.json`、`tsconfig.build.json`：NodeNext TypeScript 配置。
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\scripts\clean-dist.mjs`：fresh build 前删除 `dist/`。
- 迁入：`scripts\sync-codex-upstream.mjs`：Codex upstream snapshot sync/check。
- 创建：`src\index.ts`：只导出 `OpenAICodexAccountSwitcher`。
- 创建：`src\plugin.ts`：Codex-only plugin assembly，注册 `openai` auth provider 和 Codex 菜单。
- 创建：`src\plugin-hooks.ts`：Codex-only hook builder，处理 Codex loader、chat headers、retry、`codex-status`。
- 创建：`src\providers\descriptor.ts`、`src\providers\registry.ts`：只包含 Codex descriptor 与 Codex provider registry。
- 迁入：`src\providers\codex-menu-adapter.ts`：删除微信 actions 与动态 import。
- 迁入：`src\codex-auth-source.ts`、`src\codex-store.ts`、`src\codex-status-fetcher.ts`、`src\codex-status-command.ts`、`src\codex-invalid-account.ts`、`src\codex-network-retry.ts`、`src\network-retry-engine.ts`、`src\retry\codex-policy.ts`、`src\retry\common-policy.ts`。
- 迁入：`src\upstream\codex-loader-adapter.ts`、`src\upstream\codex-plugin.snapshot.ts`。
- 复制并精简最小公共运行时：`src\store-paths.ts`、`src\common-settings-store.ts`、`src\common-settings-actions.ts`、`src\menu-runtime.ts`、`src\ui\menu.ts`、`src\ui\select.ts`、`src\ui\ansi.ts`、`src\ui\confirm.ts`；新建 Codex-only `src\auth-store.ts`，只提供 `readAuth()` 与 `AccountEntry`。不得复制 root `src\store.ts` 到 Codex 包，因为它读写 `copilot-accounts.json`；复制后删除 Codex 包中无法触达的 Copilot / WeChat 分支，只保留 Codex 需要的公共 settings、auth 读取、菜单渲染、删除确认与选择器。
- 迁入测试：`test\codex-auth-source.test.js`、`test\codex-invalid-account.test.js`、`test\codex-loader-adapter.test.js`、`test\codex-menu-adapter.test.js`、`test\codex-network-retry.test.js`、`test\codex-plugin-config.test.js`、`test\codex-status-command.test.js`、`test\codex-status-fetcher.test.js`、`test\codex-store.test.js`、`test\codex-sync.test.js`。
- 创建：`test\index-exports.test.js`、`test\package-boundary.test.js` 和 Codex-only `test\menu.test.js`。
- 创建：`README.md`：Codex / OpenAI 独立包说明，包含明确版本号安装命令和发布资料入口。
- 创建：`docs\release-notes-template.md`：Codex / OpenAI 独立包 GitHub Release 正文模板。
- 创建：`docs\release-notes-v0.1.0.md`：首发 GitHub Release 正文。
- 创建：`docs\publishing.md`：fresh 验证、npm publish、Trusted Publisher、GitHub Release、部分失败恢复流程。
- 创建：`.github\workflows\release.yml`：GitHub Release published 触发的 npm Trusted Publishing workflow。
- 创建：`.gitignore`：排除 `node_modules/`、`dist/` 和临时 `.tgz`。
- 复制：`LICENSE`：沿用 root 包 MPL-2.0 授权文本。

### Root Copilot 包

- 修改：`package.json`：删除 `sync:codex-snapshot`、`check:codex-sync` 和 `test:parallel:shard` 中的 `test/codex-*.test.js`。
- 修改：`src\index.ts`：只导出 `CopilotAccountSwitcher`。
- 修改：`src\plugin.ts`：删除 `OpenAICodexAccountSwitcher`、Codex auth methods、`runCodexMenu()`、Codex adapter/import、`openai` provider assembly。
- 修改：`src\plugin-hooks.ts`：删除 Codex imports、`CODEX_PROVIDER_DESCRIPTOR`、`createCodexRetryingFetch`、Codex upstream loader、`handleCodexStatusCommand`、`authLoaderMode === "codex"`、Codex chat headers 分支、`codex-status` config/command 分支。
- 修改：`src\providers\descriptor.ts`：删除 `CODEX_PROVIDER_DESCRIPTOR` 与 `createCodexProviderDescriptor()`。
- 修改：`src\providers\registry.ts`：只保留 Copilot descriptor 和 Copilot runtime wiring。
- 修改：`src\provider-descriptor.ts`、`src\provider-registry.ts`：删除 Codex facade export。
- 修改：`src\ui\menu.ts`：删除 root 中 Codex-only copy；root tests 不再依赖 `getMenuCopy("en", "codex")`。
- 删除：`src\codex-auth-source.ts`、`src\codex-store.ts`、`src\codex-status-fetcher.ts`、`src\codex-status-command.ts`、`src\codex-invalid-account.ts`、`src\codex-network-retry.ts`、`src\retry\codex-policy.ts`、`src\providers\codex-menu-adapter.ts`、`src\upstream\codex-loader-adapter.ts`、`src\upstream\codex-plugin.snapshot.ts`、`scripts\sync-codex-upstream.mjs`。
- 删除或迁出：`test\codex-*.test.js`。
- 修改：`test\index-exports.test.js`、`test\plugin.test.js`、`test\menu.test.js`：翻转为 root Codex 缺席断言。

## 任务 0：执行前安全基线

**文件：**
- 读取：规格与计划文件。
- 检查：root 主工作区与远端分支。

- [ ] **步骤 1：确认 root 工作区和远端分支**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
$env:GIT_MASTER='1'; git status --short --branch
$env:GIT_MASTER='1'; git ls-remote --heads origin
```

预期：第一条输出为 `## master...origin/master`，只允许出现本规格和本计划两个未提交文档；第二条只包含 `refs/heads/master`。

- [ ] **步骤 2：确认新包目录可安全使用**

```powershell
$target = "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
if (Test-Path -LiteralPath $target) {
  $items = @(Get-ChildItem -LiteralPath $target -Force)
  if ($items.Count -gt 0) { throw "Codex package directory is not empty: $target" }
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}
```

预期：目标目录存在且为空；若非空，停止并由父会话审阅。

## 任务 1：Codex 包骨架与红灯测试

**文件：**
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\package.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\tsconfig.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\tsconfig.build.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\scripts\clean-dist.mjs`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\test\index-exports.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\test\package-boundary.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\test\menu.test.js`
- 复制：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\LICENSE` 到 `C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\LICENSE`

- [ ] **步骤 1：写入 package 与 TypeScript 配置**

`package.json` 必须包含这些稳定字段：

```json
{
  "name": "opencode-openai-account-switcher",
  "version": "0.1.0",
  "description": "OpenAI Codex account switcher plugin for OpenCode",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist/", "scripts/sync-codex-upstream.mjs", "README.md", "LICENSE"],
  "scripts": {
    "prebuild": "node scripts/clean-dist.mjs",
    "build": "tsc -p tsconfig.build.json",
    "sync:codex-snapshot": "node scripts/sync-codex-upstream.mjs --output src/upstream/codex-plugin.snapshot.ts",
    "check:codex-sync": "node scripts/sync-codex-upstream.mjs --output src/upstream/codex-plugin.snapshot.ts --check",
    "test": "npm run build && node --test test/*.test.js",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "engines": { "node": ">=24.0.0" },
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.26",
    "@opencode-ai/sdk": "^1.2.26",
    "xdg-basedir": "^5.1.0"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "^5.0.0"
  }
}
```

`tsconfig.json` 使用 `module: "NodeNext"`、`moduleResolution: "NodeNext"`、`target: "ES2022"`、`strict: true`、`rootDir: "src"`、`outDir: "dist"`。`tsconfig.build.json` 继承它并开启 declaration、关闭 sourcemap 和 declarationMap。

- [ ] **步骤 2：写 clean-dist 脚本**

`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\scripts\clean-dist.mjs`：

```js
import { rm } from "node:fs/promises"

await rm(new URL("../dist/", import.meta.url), { force: true, recursive: true })
```

- [ ] **步骤 3：写 Codex public export 红灯测试**

`test/index-exports.test.js`：

```js
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("codex package source exports only OpenAICodexAccountSwitcher", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /OpenAICodexAccountSwitcher/)
  assert.doesNotMatch(source, /CopilotAccountSwitcher/)
})

test("codex package dist exports OpenAICodexAccountSwitcher", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")
  const dts = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")
  assert.equal(typeof indexExports.OpenAICodexAccountSwitcher, "function")
  assert.equal(indexExports.OpenAICodexAccountSwitcher, pluginExports.OpenAICodexAccountSwitcher)
  assert.equal("CopilotAccountSwitcher" in indexExports, false)
  assert.match(dts, /OpenAICodexAccountSwitcher/)
  assert.doesNotMatch(dts, /CopilotAccountSwitcher/)
})
```

- [ ] **步骤 4：写 Codex pack 红灯测试**

`test/package-boundary.test.js`：

```js
import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function readPackFiles() {
  const command = process.platform === "win32" ? "cmd.exe" : "npm"
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --dry-run --json"] : ["pack", "--dry-run", "--json"]
  const { stdout } = await execFileAsync(command, args, { cwd: process.cwd(), windowsHide: true })
  const pack = JSON.parse(stdout)
  return pack[0].files.map((entry) => entry.path)
}

test("codex package pack list contains codex runtime and sync script", async () => {
  const files = await readPackFiles()
  assert.equal(files.some((filePath) => filePath === "dist/plugin.js"), true)
  assert.equal(files.some((filePath) => filePath.includes("dist/codex-status-command")), true)
  assert.equal(files.some((filePath) => filePath.includes("dist/upstream/codex-plugin.snapshot")), true)
  assert.equal(files.includes("scripts/sync-codex-upstream.mjs"), true)
})

test("codex package pack list excludes copilot and wechat runtime", async () => {
  const files = await readPackFiles()
  assert.equal(files.some((filePath) => /copilot|wechat|loop-safety|notify-tool|wait-tool/i.test(filePath)), false)
})
```

- [ ] **步骤 5：写 Codex 菜单微信缺席红灯测试**

`test/menu.test.js`：

```js
import test from "node:test"
import assert from "node:assert/strict"

import { buildMenuItems, getMenuCopy } from "../dist/ui/menu.js"

test("codex menu copy and items omit WeChat actions", () => {
  const enCopy = getMenuCopy("en", "codex")
  const zhCopy = getMenuCopy("zh", "codex")
  const items = buildMenuItems({
    provider: "codex",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })
  const visibleText = [
    ...Object.values(enCopy),
    ...Object.values(zhCopy),
    ...items.map((item) => item.label),
    ...items.map((item) => item.value.type),
  ].join("\n")

  assert.doesNotMatch(visibleText, /wechat|WeChat|微信/i)
  assert.equal(items.some((item) => item.value.type.startsWith("wechat")), false)
})
```

- [ ] **步骤 6：运行红灯验证**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm install
Copy-Item -LiteralPath "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\LICENSE" -Destination "LICENSE" -Force
node --test test/index-exports.test.js test/package-boundary.test.js test/menu.test.js
```

预期：测试失败，原因是 `src/index.ts`、`src/plugin.ts` 或 `dist/` 尚不存在，而不是测试语法错误。

## 任务 2：迁入 Codex runtime、upstream 与同步脚本

**文件：**
- 迁入：Codex runtime、retry、upstream、sync script。
- 复制：最小公共运行时文件。
- 测试：所有 `test/codex-*.test.js`。

- [ ] **步骤 1：复制源码和测试**

从 root 主工作区复制以下文件到新包同名路径：

```powershell
$root = "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
$pkg = "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
$paths = @(
  "src\codex-auth-source.ts", "src\codex-store.ts", "src\codex-status-fetcher.ts",
  "src\codex-status-command.ts", "src\codex-invalid-account.ts", "src\codex-network-retry.ts",
  "src\network-retry-engine.ts", "src\retry\codex-policy.ts", "src\retry\common-policy.ts",
  "src\providers\codex-menu-adapter.ts",
  "src\upstream\codex-loader-adapter.ts", "src\upstream\codex-plugin.snapshot.ts",
  "src\store-paths.ts", "src\common-settings-store.ts",
  "src\common-settings-actions.ts", "src\menu-runtime.ts", "src\ui\ansi.ts",
  "src\ui\menu.ts", "src\ui\select.ts", "src\ui\confirm.ts",
  "scripts\sync-codex-upstream.mjs"
)
foreach ($relative in $paths) {
  $dest = Join-Path $pkg $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $relative) -Destination $dest -Force
}
Get-ChildItem -Path "$root\test\codex-*.test.js" | Copy-Item -Destination "$pkg\test" -Force
Copy-Item -LiteralPath "$root\LICENSE" -Destination "$pkg\LICENSE" -Force
```

预期：新包拥有 Codex runtime 与测试，包含 `codex-network-retry.ts` 的直接依赖 `network-retry-engine.ts`，以及 `retry/codex-policy.ts` 的直接依赖 `retry/common-policy.ts`；测试 import 仍指向 `../dist/` 下的构建产物。

- [ ] **步骤 1b：创建 Codex-only auth store**

不要把 root `src\store.ts` 复制进 Codex 包。创建 `C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher\src\auth-store.ts`，只保留从 OpenCode `auth.json` 读取 OAuth 条目的最小逻辑：

```ts
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgConfig, xdgData } from "xdg-basedir"

export type AccountEntry = {
  name: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  email?: string
  workspaceName?: string
  source?: "auth"
  providerId?: string
}

export async function readAuth(filePath?: string): Promise<Record<string, AccountEntry>> {
  const authFile = "auth.json"
  const dataFile = path.join(xdgData ?? path.join(os.homedir(), ".local", "share"), "opencode", authFile)
  const configFile = path.join(xdgConfig ?? path.join(os.homedir(), ".config"), "opencode", authFile)
  const files = filePath ? [filePath] : [dataFile, configFile]
  let raw = ""
  for (const file of files) {
    raw = await fs.readFile(file, "utf-8").catch(() => "")
    if (raw) break
  }
  if (!raw) return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return Object.entries(parsed).reduce((acc, [key, value]) => {
    if (!value || typeof value !== "object") return acc
    const info = value as { type?: string; refresh?: string; access?: string; expires?: number; accountId?: string; enterpriseUrl?: string; email?: string; workspaceName?: string }
    if (info.type !== "oauth" || !(info.refresh || info.access)) return acc
    acc[key] = {
      name: `auth:${key}`,
      refresh: info.refresh ?? info.access!,
      access: info.access ?? info.refresh!,
      expires: info.expires ?? 0,
      accountId: info.accountId,
      enterpriseUrl: info.enterpriseUrl,
      email: info.email,
      workspaceName: info.workspaceName,
      source: "auth",
      providerId: key,
    }
    return acc
  }, {} as Record<string, AccountEntry>)
}
```

随后把 Codex 包中所有 auth fallback import 改到 `auth-store`：

- `src\providers\codex-menu-adapter.ts` 的 `readAuth` / `AccountEntry` import 从 `../store.js` 改为 `../auth-store.js`。
- `src\codex-status-command.ts` 的 `readAuth` / `AccountEntry` import 从 `./store.js` 改为 `./auth-store.js`。

Codex 包不得出现 `../store.js`、`./store.js`、`copilotAccountsPath()`、`legacyCopilotStorePath()`、`parseStore()` 或 `copilot-accounts.json`。

- [ ] **步骤 2：移除 Codex 包中的微信 action 分支**

在新包 `src/providers/codex-menu-adapter.ts` 删除：

- 删除 `action.name === "wechat-bind" || action.name === "wechat-rebind"` 的完整条件分支。
- 删除 `action.name === "wechat-export-debug-bundle"` 的完整条件分支。
- 删除 `toggle-wechat-notifications`、`toggle-wechat-question-notify`、`toggle-wechat-permission-notify`、`toggle-wechat-session-error-notify` 这些 action name 的处理和传递。

同时精简 Codex 包复制后的公共文件：

- `src\common-settings-actions.ts`：`CommonSettingsActionType` 只保留 `toggle-experimental-slash-commands` 与 `toggle-network-retry`；`applyCommonSettingsAction()` 删除所有 `wechat-*` 分支和初始化 `settings.wechat` 的逻辑。
- `src\common-settings-store.ts`：删除 `WechatBinding`、`WechatMenuSettings`、`WechatNotificationDispatchSettings`、`normalizeWechatSettings()`、`readWechatNotificationDispatchSettings()`；`CommonSettingsStore` 只保留 `networkRetryEnabled`、`experimentalSlashCommandsEnabled`、`experimentalStatusSlashCommandEnabled`；删除 `legacyCopilotStorePath` 与 `parseStore` import，`readCommonSettingsStore()` / `readCommonSettingsStoreSync()` 只读 `account-switcher/settings.json`，不得回读 `copilot-accounts.json`。
- `src\store-paths.ts`：Codex 包只保留 `accountSwitcherConfigDir()`、`commonSettingsPath()`、`codexAccountsPath()`、`legacyCodexStorePath()`；删除 `copilotAccountsPath()`、`wechatConfigDir()`、`legacyCopilotStorePath()`。
- `src\menu-runtime.ts`：`providerActionReason()` 直接返回 `provider-action:${name}`；`isNonPersistentProviderAction()` 删除 `wechat-bind` 和 `wechat-export-debug-bundle` 特例，若 Codex 包没有非持久 provider action，可让该函数恒为 `false` 或内联删除。

删除 `getWechatDebugBundleMode()` 和 `getWechatDebugBundleFlowInput()` 这两个不再使用的函数。

- [ ] **步骤 3：移除 Codex 包菜单 UI 中的微信入口**

在新包 `src/ui/menu.ts` 删除 Codex 菜单可见的微信入口和依赖：

- 删除 `../wechat/operator-store.js` import，以及 `MenuWechatPrimaryBinding`、`MenuWechatOperatorBinding`、`pickPrimaryBindingFromSettings()`、`pickOperatorBinding()`、`buildWechatSubmenuItems()`、`buildWechatDebugBundleModeItems()`。
- 从 `MenuAction` 删除 `wechat-menu`、`wechat-bind`、`wechat-rebind`、`wechat-export-debug-bundle-menu`、`wechat-export-debug-bundle`、`toggle-wechat-*`。
- 从 `ShowMenuInput`、`buildMenuItems()` 输入和 `getMenuCopy()` 返回文案中删除 `wechat*` 字段。
- 从 Codex 包复制后的 `MenuCapabilities` 与 `defaultMenuCapabilities(provider)` 删除 `wechatNotificationsMenu` 字段，确保 Codex 路径无法渲染任何 `wechat*` item；root Copilot 包的同名文件后续仍保留微信能力。
- 删除 `showMenuWithDeps()` 中 `result.type === "wechat-menu"` 的分支；保留语言切换、账号 submenu、删除确认和 Codex 的 experimental slash/network retry toggles。

新增或保留 Codex-only `test/menu.test.js`，断言 `getMenuCopy("en", "codex")`、`getMenuCopy("zh", "codex")` 和 `buildMenuItems({ provider: "codex" })` 产物不包含 `wechat`、`WeChat`、`微信` 或任何 `value.type` 以 `wechat` 开头的菜单动作，同时仍包含 `Experimental slash commands` 和 `Network Retry`。

- [ ] **步骤 4：收敛复制的公共文件**

在 Codex 包中执行静态搜索：

```powershell
$forbidden = "wechat|WeChat|微信|src/wechat|\.\./wechat|toggle-wechat|wechat-|CopilotAccountSwitcher|COPILOT_PROVIDER_DESCRIPTOR|modelAccountAssignments|github-copilot|\.\./store\.js|\./store\.js|copilotAccountsPath|legacyCopilotStorePath|copilot-accounts\.json|parseStore"
$matches = rg -n $forbidden src
if ($LASTEXITCODE -eq 0) { throw "Codex package still contains forbidden root/WeChat/Copilot boundary terms:`n$matches" }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit code $LASTEXITCODE" }
```

预期：强制断言通过；Codex 包 `src` 中不保留 `src/wechat/**` import、`wechat-*` action/runtime、Copilot model routing、root Copilot store helper 或 `copilot-accounts.json` 路径。

- [ ] **步骤 5：调整 Codex 测试中微信动作期望**

修改 `test/codex-menu-adapter.test.js` 和 `test/codex-plugin-config.test.js`，新增源码负向断言：

```js
const source = await readFile(new URL("../dist/providers/codex-menu-adapter.js", import.meta.url), "utf8")
assert.equal(source.includes("../wechat/"), false)
assert.equal(source.includes("wechat-bind"), false)
assert.equal(source.includes("wechat-export-debug-bundle"), false)
assert.equal(source.includes("toggle-wechat"), false)
```

删除或改写原本期望 Codex adapter 处理微信绑定、重绑、debug bundle 的测试；保留账号导入、切换、刷新、invalid account recovery、browser/headless auth 的断言。

- [ ] **步骤 6：运行 Codex runtime targeted 测试**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm run build
node --test test/codex-auth-source.test.js test/codex-invalid-account.test.js test/codex-status-fetcher.test.js test/codex-status-command.test.js test/codex-store.test.js test/codex-network-retry.test.js test/codex-loader-adapter.test.js test/codex-menu-adapter.test.js test/codex-sync.test.js test/menu.test.js
npm run typecheck
```

预期：所有 targeted Codex runtime 测试通过，typecheck 退出码为 0。

## 任务 3：实现 Codex-only plugin、hooks 与 provider registry

**文件：**
- 创建：`src\index.ts`
- 创建：`src\plugin.ts`
- 创建：`src\plugin-hooks.ts`
- 创建：`src\providers\descriptor.ts`
- 创建：`src\providers\registry.ts`
- 测试：`test\codex-plugin-config.test.js`、`test\index-exports.test.js`

- [ ] **步骤 1：写 Codex provider descriptor**

`src/providers/descriptor.ts` 只包含 Codex descriptor：

```ts
import type { buildPluginHooks as buildPluginHooksFn } from "../plugin-hooks.js"

export type ProviderCapability = "auth" | "chat-headers" | "network-retry" | "slash-commands"
export type ProviderDescriptor = {
  key: string
  providerIDs: string[]
  storeNamespace: string
  commands: string[]
  menuEntries: string[]
  capabilities: ProviderCapability[]
}

type BuildPluginHooks = typeof buildPluginHooksFn

export const CODEX_PROVIDER_DESCRIPTOR: ProviderDescriptor = {
  key: "codex",
  providerIDs: ["openai"],
  storeNamespace: "codex",
  commands: ["codex-status"],
  menuEntries: ["switch-account", "add-account", "refresh-snapshot"],
  capabilities: ["auth", "chat-headers", "network-retry", "slash-commands"],
}

export function createCodexProviderDescriptor(input: { buildPluginHooks: BuildPluginHooks }) {
  return {
    key: "codex",
    auth: { provider: "openai" },
    buildPluginHooks: input.buildPluginHooks,
    enabledByDefault: true,
  }
}
```

- [ ] **步骤 2：写 Codex provider registry**

`src/providers/registry.ts` 只返回 `codex.descriptor`，并把 descriptor capabilities 映射到 Codex hook runtime：`authLoaderMode: "codex"`、`enableModelRouting: false`、`loadOfficialCodexConfig`、`loadOfficialCodexChatHeaders`、`createCodexRetryingFetch`。不要导入任何 Copilot retry、Copilot upstream 或 Copilot descriptor。

- [ ] **步骤 3：写 Codex-only plugin hooks**

从 root `src/plugin-hooks.ts` 复制必要 hook 类型与 helper，但只保留 Codex 路径：

- `auth.loader` 使用 Codex loader。
- `chat.headers` 在 `hookInput.model.providerID === "openai"` 时调用 upstream Codex chat headers 后立即返回。
- `config` 在 settings 允许时注册 `codex-status`。
- `command.execute.before` 只处理 `codex-status`。
- `fetch` hook 只包 `createCodexRetryingFetch()`。
- 不包含 `x-initiator`、`INTERNAL_DEBUG_LINK_HEADER`、model routing、Copilot quota、Copilot compact、Copilot stop-tool、WeChat bridge。

`test/codex-plugin-config.test.js` 的断言应继续覆盖：enabled 注册 `codex-status`，disabled 不新增但保留预置命令，command hook 只在开关开启时委派，且不会调用 Copilot quota refresh。

- [ ] **步骤 4：写 Codex-only plugin entry**

`src/index.ts`：

```ts
export { OpenAICodexAccountSwitcher } from "./plugin.js"
```

`src/plugin.ts` 只保留 `OpenAICodexAccountSwitcher`。实现要点：创建 `Manage OpenAI Codex accounts` OAuth method；`runCodexMenu()` 使用 `createCodexMenuAdapter()`、`showMenu({ provider: "codex" })`、`runProviderMenu()`；只把 `cancel/add/remove/remove-all/switch/toggle-experimental-slash-commands/toggle-network-retry/refresh-snapshot/toggle-refresh/set-interval` 转成 runtime action；返回 `registry.codex.descriptor.buildPluginHooks({ auth: { provider: "openai", methods }, ... })`。

Codex `src/plugin.ts` 不得传递或处理 `wechat-*` action，不得导入 `src/wechat/**`，也不得在 Codex `showMenu()` 调用中启用微信 capability。

Codex 包 `src\providers\codex-menu-adapter.ts` 的 auth bootstrap 必须从 `../auth-store.js` 读取 OpenCode `auth.json`，不得从 root `store.ts` 继承 `copilot-accounts.json` 读写逻辑。

- [ ] **步骤 5：运行 Codex plugin targeted 测试**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm run build
node --test test/index-exports.test.js test/codex-plugin-config.test.js test/menu.test.js
npm run typecheck
```

预期：Codex plugin entry、provider registry、slash command、typecheck 均通过。

## 任务 4：Codex 包 pack 与导入 smoke

**文件：**
- 修改：`test\package-boundary.test.js`
- 创建或修改：`README.md`

- [ ] **步骤 1：补充实际 tarball import smoke**

在 `test/package-boundary.test.js` 增加实际 `npm pack --json`、临时目录 `npm install <tarball>`、`node smoke.mjs` 的 smoke。`smoke.mjs` 内容必须验证：

```js
import * as pkg from "opencode-openai-account-switcher"
if (typeof pkg.OpenAICodexAccountSwitcher !== "function") throw new Error("missing codex export")
if ("CopilotAccountSwitcher" in pkg) throw new Error("unexpected copilot export")
```

测试 finally 中必须删除生成的 `.tgz` 和临时目录。

- [ ] **步骤 2：写 README 最小使用说明**

`README.md` 必须包含：包名、用途、明确版本号安装命令、导出入口、不会包含微信动作、发布资料入口。确认 `LICENSE` 已复制到 Codex 包根目录，因为 `package.json` 的 `files` 白名单会把它作为必需文件打包。示例导入：

```md
import { OpenAICodexAccountSwitcher } from "opencode-openai-account-switcher"
```

- [ ] **步骤 3：运行 Codex 包完整验证**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
```

预期：全部退出码为 0；pack dry-run 的 `files[].path` 含 Codex runtime、upstream snapshot、sync script，不含 Copilot、WeChat、Loop Safety、wait、notify。

## 任务 5：Root Copilot 包先写回迁红灯测试

**文件：**
- 修改：`test\index-exports.test.js`
- 修改：`test\plugin.test.js`
- 修改：`test\menu.test.js`

- [ ] **步骤 1：翻转 root export 测试**

`test/index-exports.test.js` 改为：

```js
test("package root source exports only Copilot account switcher", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /CopilotAccountSwitcher/)
  assert.doesNotMatch(source, /OpenAICodexAccountSwitcher/)
})

test("package root dist exports only Copilot switcher", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")
  const distTypeSource = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")
  assert.equal(typeof indexExports.CopilotAccountSwitcher, "function")
  assert.equal(indexExports.CopilotAccountSwitcher, pluginExports.CopilotAccountSwitcher)
  assert.equal("OpenAICodexAccountSwitcher" in indexExports, false)
  assert.equal("OpenAICodexAccountSwitcher" in pluginExports, false)
  assert.match(distTypeSource, /CopilotAccountSwitcher/)
  assert.doesNotMatch(distTypeSource, /OpenAICodexAccountSwitcher/)
})
```

- [ ] **步骤 2：新增 root Codex 缺席 pack/source 测试**

在 `test/plugin.test.js` 的 pack 边界区域增加 source/dist 缺席、public entry negative import、`npm pack --dry-run --json` 负向清单测试。必须给出可执行断言，而不是只写文字说明。

Source / dist 缺席断言使用固定路径数组：

```js
for (const relative of [
  "../src/codex-auth-source.ts",
  "../src/codex-store.ts",
  "../src/codex-status-fetcher.ts",
  "../src/codex-status-command.ts",
  "../src/codex-invalid-account.ts",
  "../src/codex-network-retry.ts",
  "../src/retry/codex-policy.ts",
  "../src/providers/codex-menu-adapter.ts",
  "../src/upstream/codex-loader-adapter.ts",
  "../src/upstream/codex-plugin.snapshot.ts",
  "../scripts/sync-codex-upstream.mjs",
  "../dist/codex-store.js",
  "../dist/codex-status-command.js",
  "../dist/providers/codex-menu-adapter.js",
  "../dist/upstream/codex-plugin.snapshot.js",
]) {
  assert.equal(existsSync(new URL(relative, import.meta.url)), false, relative)
}
```

Pack 负向测试必须解析 `JSON.parse(stdout)[0].files.map((entry) => entry.path)`，并使用精确模式数组，避免笼统 `/codex/i` 误伤文档：

```js
const forbiddenPackNeedles = [
  "dist/codex-",
  "dist/providers/codex-menu-adapter",
  "dist/upstream/codex-",
  "codex-plugin.snapshot",
  "sync-codex-upstream",
]
for (const needle of forbiddenPackNeedles) {
  assert.equal(files.some((filePath) => filePath.replace(/\\/g, "/").includes(needle)), false, needle)
}
```

- [ ] **步骤 3：翻转 provider registry 测试**

把 root `test/plugin.test.js` 中 provider registry 测试改为只断言 Copilot：

```js
const descriptors = listProviderDescriptors()
assert.equal(descriptors.length, 1)
assert.equal(descriptors[0]?.key, "copilot")
assert.equal(getProviderDescriptorByKey("codex"), undefined)
assert.equal(getProviderDescriptorByProviderID("openai"), undefined)
```

删除 root 中 `codex descriptor declares independent menu capabilities`、`provider registry exposes both Copilot and Codex descriptors`、`openai auth provider is wired to Codex menu entry and codex auth loader` 等 Codex 正向期望。

- [ ] **步骤 4：翻转 menu 测试**

删除 `test/menu.test.js` 中 `getMenuCopy returns Codex-specific titles without Copilot-only wording`。新增 root 负向测试：

```js
test("root Copilot menu copy no longer exposes Codex provider title", () => {
  const copy = getMenuCopy("en")
  assert.equal(copy.menuTitle, "GitHub Copilot accounts")
})
```

- [ ] **步骤 5：运行红灯验证**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
npm run build
node --test test/index-exports.test.js --test-name-pattern "only Copilot"
node --test --test-concurrency=1 --test-name-pattern "codex|Codex|provider registry" test/plugin.test.js test/menu.test.js
```

预期：新增/翻转测试失败，原因是 root 仍导出或打包 Codex，而不是测试语法错误。

## 任务 6：Root Copilot 包删除 Codex runtime 与 wiring

**文件：**
- 修改 root package、entry、plugin、hooks、provider registry、menu。
- 删除 root Codex runtime、sync script、Codex tests。

- [ ] **步骤 1：收敛 package scripts 和测试分片**

`package.json` 删除：

- `"sync:codex-snapshot"`。
- `"check:codex-sync"`。

并从 `test:parallel:shard` 删除所有 `test/codex-*.test.js`。保留 Copilot、common settings、menu runtime、WeChat 和其他 root tests。

- [ ] **步骤 2：删除 root public Codex export 和 plugin entry**

`src/index.ts` 改为：

```ts
export { CopilotAccountSwitcher } from "./plugin.js"
```

`src/plugin.ts` 删除 `createCodexMenuAdapter`、`loadOfficialCodexAuthMethods`、`codexClient`、`codexMethods`、`runCodexMenu()`、`provider: "openai"` 参数分支、`OpenAICodexAccountSwitcher` export。保留 `CopilotAccountSwitcher`、Copilot menu、WeChat broker lifecycle、Copilot provider assembly。

- [ ] **步骤 3：删除 root Codex provider registry**

`src/providers/descriptor.ts` 删除 `CODEX_PROVIDER_DESCRIPTOR` 和 `createCodexProviderDescriptor()`。`src/providers/registry.ts` 删除 Codex imports 和 `codex` return，只保留：

```ts
const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [COPILOT_PROVIDER_DESCRIPTOR]
```

`getProviderDescriptorByProviderID("openai")` 应返回 `undefined`。

- [ ] **步骤 4：删除 root plugin-hooks Codex 分支**

`src/plugin-hooks.ts` 删除 Codex imports、`isCodexProviderID()`、`enableCodexAuthLoader`、Codex loader、Codex chat headers early return、`codex-status` config/command branch、`handleCodexStatusCommandImpl` 参数。`buildPluginHooks()` 的默认 runtime 只服务 Copilot 和 WeChat bridge。

- [ ] **步骤 5：删除 root Codex 文件和测试**

删除：

```text
src/codex-auth-source.ts
src/codex-store.ts
src/codex-status-fetcher.ts
src/codex-status-command.ts
src/codex-invalid-account.ts
src/codex-network-retry.ts
src/retry/codex-policy.ts
src/providers/codex-menu-adapter.ts
src/upstream/codex-loader-adapter.ts
src/upstream/codex-plugin.snapshot.ts
scripts/sync-codex-upstream.mjs
test/codex-*.test.js
```

`src/store-paths.ts` 可暂时保留 `codexAccountsPath()` 和 `legacyCodexStorePath()` 只有在 root 无引用且测试允许时再删除；如果 root WeChat 或 docs 仍引用路径 helper，应保留到 WeChat 拆分阶段。

- [ ] **步骤 6：运行 root targeted 测试转绿**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
npm run build
node --test test/index-exports.test.js
node --test --test-concurrency=1 --test-name-pattern "codex|Codex|provider registry|github-copilot auth methods" test/plugin.test.js test/menu.test.js
npm run typecheck
```

预期：root export、provider registry、pack/source 负向断言通过；typecheck 退出码为 0。

## 任务 7：双包 pack 边界和完整验证

**文件：**
- 修改：root `test\plugin.test.js`
- 修改：Codex `test\package-boundary.test.js`
- 验证：两个包 build/typecheck/test/pack。

- [ ] **步骤 1：Codex 包 fresh verification**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm run build
npm run typecheck
npm test
$pack = npm pack --dry-run --json | ConvertFrom-Json
$files = $pack[0].files.path
$files | Where-Object { $_ -match "codex|sync-codex" }
```

将打印式检查改为强制断言：

```powershell
$required = @("dist/plugin.js", "dist/providers/codex-menu-adapter", "dist/network-retry-engine", "dist/retry/common-policy", "dist/upstream/codex-plugin.snapshot", "scripts/sync-codex-upstream.mjs")
foreach ($needle in $required) {
  if (-not ($files | Where-Object { $_ -like "*$needle*" })) { throw "missing $needle" }
}
$forbidden = @("copilot", "wechat", "loop-safety", "notify-tool", "wait-tool")
foreach ($needle in $forbidden) {
  if ($files | Where-Object { $_ -match $needle }) { throw "unexpected $needle" }
}
```

预期：命令退出码为 0；所有 required needle 命中，所有 forbidden needle 无命中。

- [ ] **步骤 2：Root Copilot 包 fresh verification**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
npm run build
npm run typecheck
npm test
$pack = npm pack --dry-run --json | ConvertFrom-Json
$files = $pack[0].files.path
$files | Where-Object { $_ -match "codex|sync-codex|codex-plugin" }
```

将打印式检查改为强制断言：

```powershell
$forbidden = @("dist/codex-", "sync-codex", "codex-plugin", "dist/providers/codex-menu-adapter", "dist/upstream/codex-")
foreach ($needle in $forbidden) {
  if ($files | Where-Object { $_.Replace("\", "/").Contains($needle) }) { throw "unexpected $needle" }
}
```

预期：前三条退出码为 0；所有 forbidden needle 无命中。若 `npm test` 唯一失败是 WeChat real-host PTY `AttachConsole failed`，保留完整输出并 targeted rerun 对应 failing test；如果 targeted rerun 通过，按既有 caveat 记录为 pre-existing 环境问题。

- [ ] **步骤 3：Root public import negative smoke**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
node --input-type=module -e "const pkg = await import('./dist/index.js'); if (typeof pkg.CopilotAccountSwitcher !== 'function') throw new Error('missing CopilotAccountSwitcher'); if ('OpenAICodexAccountSwitcher' in pkg) throw new Error('unexpected Codex export');"
```

预期：退出码为 0。

- [ ] **步骤 4：Codex packed tarball public import positive smoke**

最终验收不能降级为 `./dist/index.js` smoke。必须重新执行实际 tarball 安装 smoke：

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
$pack = npm pack --json | ConvertFrom-Json
$tarball = Join-Path (Get-Location) $pack[0].filename
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-package-smoke-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$smokeExitCode = 0
try {
  Set-Location $tmp
  npm install $tarball
  Set-Content -LiteralPath "smoke.mjs" -Encoding UTF8 -Value @'
import * as pkg from "opencode-codex-account-switcher"
if (typeof pkg.OpenAICodexAccountSwitcher !== "function") throw new Error("missing OpenAICodexAccountSwitcher")
if ("CopilotAccountSwitcher" in pkg) throw new Error("unexpected Copilot export")
'@
  node smoke.mjs
  $smokeExitCode = $LASTEXITCODE
} finally {
  Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
  Remove-Item -LiteralPath $tarball -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if ($smokeExitCode -ne 0) { throw "Codex tarball smoke failed with exit code $smokeExitCode" }
```

预期：退出码为 0；实际安装后的 package public entry 导出 `OpenAICodexAccountSwitcher`，不导出 `CopilotAccountSwitcher`。

## 任务 8：文档、清理与交接前检查

**文件：**
- 修改：root `README.md` 中 Codex 相关说明。
- 创建或修改：Codex `README.md`。
- 清理：临时 split worktree / branch，在确认主工作区已有规格与计划后进行。

- [ ] **步骤 1：更新 root README 边界说明**

Root README 中若存在 Codex / OpenAI 账号切换用法，改为指向新包 `opencode-openai-account-switcher`。root README 继续只描述 Copilot 能力、微信尚未拆分能力，以及 wait / notify / loop-safety 独立插件关系。不要暗示 root Copilot 包随 Codex / OpenAI 独立包首发发布。

- [ ] **步骤 2：补齐 Codex README**

Codex README 至少包含：

```text
# opencode-openai-account-switcher

OpenAI / Codex account switcher plugin for OpenCode.

## Install

    opencode plugin opencode-openai-account-switcher@0.1.0 --force -g

## Usage

    import { OpenAICodexAccountSwitcher } from "opencode-openai-account-switcher"

## Scope

- Manages the openai provider.
- Preserves ~/.config/opencode/account-switcher/codex-accounts.json.
- Does not include GitHub Copilot routing or WeChat binding actions.
```

- [ ] **步骤 3：清理临时 split worktree 和本地分支**

先执行清理前置检查，确认规格和计划已经迁回主工作区、远端仍只有主分支、目标 worktree 确实是临时 Codex split worktree：

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
Test-Path -LiteralPath "docs\superpowers\specs\2026-05-09-opencode-codex-account-switcher-split-design.md"
Test-Path -LiteralPath "docs\superpowers\plans\2026-05-09-opencode-codex-account-switcher-split.md"
$env:GIT_MASTER='1'; git status --short --branch
$env:GIT_MASTER='1'; git ls-remote --heads origin
$env:GIT_MASTER='1'; git worktree list
$env:GIT_MASTER='1'; git -C "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-codex-account-switcher-split" status --short --branch
```

只有当两个 `Test-Path` 都输出 `True`，远端输出只包含 `refs/heads/master`，`git worktree list` 确认目标路径是 `.worktrees\opencode-codex-account-switcher-split`，且 split worktree `status` 只包含已迁回主工作区的规格文件或为空时，才允许继续执行清理：

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
$env:GIT_MASTER='1'; git worktree remove "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-codex-account-switcher-split"
$env:GIT_MASTER='1'; git branch -D split/opencode-codex-account-switcher
$env:GIT_MASTER='1'; git worktree list
$env:GIT_MASTER='1'; git branch --list "split/opencode-codex-account-switcher"
$env:GIT_MASTER='1'; git ls-remote --heads origin
```

预期：worktree list 不再包含 Codex split worktree；本地 split branch 删除；远端仍只有 `refs/heads/master`。如果任一前置检查不满足，先停止并报告，不执行 `git worktree remove` 或 `git branch -D`。

- [ ] **步骤 4：最终工作树和验证证据汇总**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
$env:GIT_MASTER='1'; git status --short --branch
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
Get-ChildItem -LiteralPath . -Force | Select-Object Name
```

预期：root 仅包含本次拆分相关文件变更；新 Codex 包目录结构完整；root 未 release、未 tag、未 npm publish、未 GitHub Release，且没有非主分支 push。

## 任务 9：Codex / OpenAI 独立包首发链路

**文件与远端：**
- 操作：`C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher`
- 操作：GitHub repo `jiwangyihao/opencode-openai-account-switcher`
- 操作：npm package `opencode-openai-account-switcher@0.1.0`

- [ ] **步骤 1：首发前 fresh 验证**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-codex-account-switcher"
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
npm view opencode-openai-account-switcher@0.1.0 version --json
```

预期：前三类验证退出码为 0；pack 清单包含 Codex runtime、upstream snapshot 和 sync script，不包含 Copilot、WeChat、Loop Safety、wait、notify；`npm view` 在首发前返回 404。如果版本已存在，停止并重新确认版本策略。

- [ ] **步骤 2：驱动实际 tarball install/import surface**

必须重新执行实际 tarball 安装 smoke，导入包名为 `opencode-openai-account-switcher`，并断言只导出 `OpenAICodexAccountSwitcher`、不导出 `CopilotAccountSwitcher`。

- [ ] **步骤 3：本地初始提交**

```powershell
$env:GIT_MASTER = "1"
git init
git branch -M master
git add .
git commit -m "feat(openai): 初始化 Codex 账号切换独立包"
```

预期：提交只包含 Codex / OpenAI 独立包源码、测试、README、release notes、publishing 文档、workflow 和 lockfile。

- [ ] **步骤 4：外部发布链路**

在用户确认允许外部发布后执行：

```powershell
gh repo create jiwangyihao/opencode-openai-account-switcher --public --source . --remote origin --push
npm whoami
npm publish --access public
npm view opencode-openai-account-switcher@0.1.0 version --json
npm exec --package npm@11 -- npm trust github opencode-openai-account-switcher --file release.yml --repo jiwangyihao/opencode-openai-account-switcher --yes
npm exec --package npm@11 -- npm trust list opencode-openai-account-switcher --json
$env:GIT_MASTER = "1"; git tag v0.1.0
$env:GIT_MASTER = "1"; git push origin v0.1.0
gh release create v0.1.0 --repo jiwangyihao/opencode-openai-account-switcher --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
gh release view v0.1.0 --repo jiwangyihao/opencode-openai-account-switcher --json tagName,publishedAt,isDraft,isPrerelease,body
```

预期：npm 远端 version 返回 `"0.1.0"`；Trusted Publisher 指向 `jiwangyihao/opencode-openai-account-switcher` 和 `release.yml`；GitHub Release 已发布、非 draft、非 prerelease，正文包含三个必需章节和明确版本号安装命令。

## 审查门禁与 notify 报告

- 进入实现前、关键实现任务完成后、最终交付前，都要并行启动 3-5 个只读 review 子代理。至少覆盖架构边界、测试与 pack、流程约束、文档清晰度。
- 每个新 review 子代理提示词必须超过 2000 字，并包含完整规格路径、完整计划路径、审查范围、禁止编辑、禁止 commit、禁止 root release、禁止未经授权执行外部发布动作、禁止非主分支 push、禁止 worktree 实现等约束。
- Review 子代理只读审查，不得修改文件，不得运行破坏性命令，不得创建 commit。
- 如果任一 review 子代理 FAIL，父会话先修复计划或实现，再对失败维度重新发起复审。
- 全部 review 子代理 PASS 后，父会话可以自动进入下一阶段，无需再次询问用户。
- 阶段开始、review 全部通过、阻塞、验证失败、最终完成都使用 `notify` 报告；需要用户决策或最终交接时使用 `question`。
## 子代理执行建议

建议按以下方式分派子代理，每个任务结束后由父会话读取 diff 并运行验证：

1. 子代理 A：任务 1-4，新 Codex 包骨架、runtime、plugin、pack smoke。
2. 子代理 B：任务 5-6，root Copilot 包红灯测试和回迁实现。
3. 子代理 C：任务 7，双包验证与 pack/import smoke。
4. 子代理 D：任务 8，README、发布资料、临时 worktree 清理准备和交接检查。
5. 父会话：任务 9，外部发布链路必须由父会话在获得用户确认后执行。

每个新子代理提示词必须包括本规格与计划完整路径、任务编号、禁止 root release、禁止未经授权执行外部发布动作、禁止非主分支 push、直接在主工作区修改 root、不得使用 worktree 实现、新包目录不是 worktree、以及该子代理负责的精确文件清单。提示词长度必须超过 2000 字。子代理不得创建 commit，除非父会话已经获得用户明确提交授权。

## 自检清单

- [ ] 规格中的每个目标都有对应任务：Codex 包创建、Codex runtime 迁入、Codex tests 迁入、root 回迁、pack 边界、import smoke、Codex / OpenAI 独立包首发链路、root 不发布、无非主分支 push。
- [ ] 每个任务都有精确文件路径。
- [ ] 每个行为变更都有先红后绿的测试步骤。
- [ ] Pack 验证都要求先 fresh `npm run build`，再解析 `npm pack --dry-run --json` 的 `files[].path`。
- [ ] Codex 包移除微信功能有明确测试和源码负向断言。
- [ ] Root 包移除 Codex export 有 public import negative smoke。
- [ ] 计划中没有未决标记、矛盾范围或把 root Copilot 包误纳入 Codex / OpenAI 首发链路的描述。







