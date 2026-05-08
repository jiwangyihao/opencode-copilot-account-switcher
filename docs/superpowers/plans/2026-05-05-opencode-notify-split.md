# OpenCode Notify Tool 独立插件拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将当前 Copilot 包里的通用 `notify` tool 拆成独立插件 `opencode-notify-tool@0.1.0`，完成新仓库首发、npm Trusted Publisher、GitHub Release，并回迁清理当前 Copilot 包。

**架构：** `opencode-notify-tool` 是一个只拥有 `notify` tool 的独立 OpenCode 插件，参数面固定为 `message` 和可选 `variant`，toast 缺失或失败时 fail open。当前 Copilot 包删除本地 `notify` 注册和 `notify` definition 改写，只保留 Loop Safety 对外部 `notify` 的策略文本和 README 组合说明。

**技术栈：** TypeScript、Node.js 24、`@opencode-ai/plugin`、Node test runner、npm publish、npm Trusted Publisher、GitHub CLI、GitHub Actions OIDC。

---

## 文件结构预分解

- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\package.json`
  - 新包元数据、发布白名单、构建/测试脚本和唯一 runtime dependency。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\.gitignore`
  - 新仓库提交护栏，至少忽略 `node_modules/`，避免首个 release commit 收入依赖目录。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\tsconfig.json`
  - 开发期 TypeScript 配置，使用 ES2022、Bundler resolution、strict。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\tsconfig.build.json`
  - 发布构建配置，关闭 sourcemap 和 declaration map。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\src\notify-tool.ts`
  - `notify` tool 的唯一行为实现和测试 seam 类型。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\src\index.ts`
  - OpenCode plugin 入口、default export、`tool.definition` 描述改写。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\test\notify-tool.test.js`
  - 参数面、默认值、toast 映射、fail-open、warning、schema 边界测试。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\test\plugin-entry.test.js`
  - default plugin、factory、runtime client、seam client 优先级、definition 边界测试。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\README.md`
  - 中英双语使用文档，只介绍独立 `notify` 插件。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\publishing.md`
  - 手动首发、fresh 验证、Trusted Publisher、Actions 发布、Release 验证、部分失败恢复。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\release-notes-template.md`
  - GitHub Release 正文模板，升级命令必须固定到 `opencode-notify-tool@0.1.0`。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\release-notes-v0.1.0.md`
  - 首发 Release 正文，随初始 release commit 推送。
- `C:\Users\34404\Documents\GitHub\opencode-notify-tool\.github\workflows\release.yml`
  - GitHub Release published 触发的 npm Trusted Publishing workflow。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\plugin-hooks.ts`
  - Copilot 回迁时删除 `createNotifyTool` import、`tool.notify` 注册和 `notify` definition 改写。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\notify-tool.ts`
  - Copilot 回迁时删除。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\plugin.test.js`
  - 删除 Copilot 本地 notify 行为测试，新增不再拥有 `notify` 的边界测试和 pack 残留测试。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\loop-safety-plugin.test.js`
  - 保留外部 `notify` fail-open 策略断言；只有当前文本漂移时才修改。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\README.md`
  - 中英同步把 `notify` 从内置能力改成推荐组合插件。

## 全局执行约束

- 按顺序执行 3 个阶段：独立包阶段 → 首发链路阶段 → Copilot 回迁阶段。上一阶段没有 fresh 证据时不能进入下一阶段。
- 使用子代理驱动开发。每个任务交给单独实现子代理，任务完成后先做规格合规审查，再做代码质量审查。
- 当前 Copilot 仓库的代码回迁必须在项目内 worktree：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration`。
- 新包仓库固定在：`C:\Users\34404\Documents\GitHub\opencode-notify-tool`，不要在当前 Copilot 仓库里创建新包文件。
- 所有 git 写操作设置 `$env:GIT_MASTER = "1"`。当前 Copilot 仓库不创建 commit，除非用户在执行阶段明确要求；`opencode-notify-tool` 新仓库初始 commit 是首发链路的一部分。
- 不把微信通知传输、Copilot retry toast、quota toast、Loop Safety 主体、`question`、`wait`、通知历史、去重、限流、多通道中心放进 `opencode-notify-tool`。
- 不使用裸包名或 npm `latest` 安装命令；用户文档和 Release 正文必须使用 `opencode plugin opencode-notify-tool@0.1.0 --force -g`。

### 任务 1：创建独立包骨架并写失败测试

**文件：**
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\package.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\.gitignore`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\tsconfig.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\tsconfig.build.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\test\notify-tool.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\test\plugin-entry.test.js`

- [ ] **步骤 1：确认目标目录可安全创建**

运行：

```powershell
$target = "C:\Users\34404\Documents\GitHub\opencode-notify-tool"
if (Test-Path $target) {
  $items = Get-ChildItem -Force $target
  if ($items.Count -gt 0) { throw "Target directory is not empty: $target" }
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}
Set-Location $target
New-Item -ItemType Directory -Force -Path src,test,docs,".github\workflows" | Out-Null
Set-Content -Path .gitignore -Value "node_modules/`n" -NoNewline
```

预期：目录存在且可安全写入；如果已有非空目录，停止并把路径内容列给主代理判断；`.gitignore` 已存在且至少忽略 `node_modules/`，后续 `git add .` 不会把依赖目录收入首个 release commit。

- [ ] **步骤 2：写入 `package.json`**

创建 `package.json`，内容为：

```json
{
  "name": "opencode-notify-tool",
  "version": "0.1.0",
  "description": "Non-blocking notify tool plugin for OpenCode",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "type": "module",
  "license": "MPL-2.0",
  "author": "jiwangyihao",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jiwangyihao/opencode-notify-tool.git"
  },
  "homepage": "https://github.com/jiwangyihao/opencode-notify-tool#readme",
  "bugs": {
    "url": "https://github.com/jiwangyihao/opencode-notify-tool/issues"
  },
  "keywords": [
    "opencode",
    "plugin",
    "notify",
    "toast",
    "progress"
  ],
  "engines": {
    "node": ">=24.0.0"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test:built": "npm run build && node --test test/*.test.js",
    "test": "npm run test:built",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.26"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **步骤 3：写入 TypeScript 配置**

创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

创建 `tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src"]
}
```

- [ ] **步骤 4：写入 `test/notify-tool.test.js` 失败测试**

创建 `test/notify-tool.test.js`，内容为：

```js
import test from "node:test"
import assert from "node:assert/strict"

import { createNotifyTool } from "../dist/notify-tool.js"

function createToolContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "task",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("notify tool exposes message and optional variant only", () => {
  const notify = createNotifyTool()

  assert.deepEqual(Object.keys(notify.args).sort(), ["message", "variant"])
  assert.equal(Object.hasOwn(notify.args, "title"), false)
  assert.equal(Object.hasOwn(notify.args, "duration"), false)
  assert.equal(Object.hasOwn(notify.args, "channel"), false)
  assert.equal(Object.hasOwn(notify.args, "dedupeKey"), false)
})

test("notify tool defaults variant to info", async () => {
  const calls = []
  const notify = createNotifyTool({
    client: { tui: { showToast: async (options) => calls.push(options) } },
  })

  const result = await notify.execute({ message: "still working" }, createToolContext())

  assert.equal(result, "ok")
  assert.equal(calls[0]?.body?.message, "still working")
  assert.equal(calls[0]?.body?.variant, "info")
})

test("notify tool maps message and variant to tui.showToast", async () => {
  const calls = []
  const notify = createNotifyTool({
    client: { tui: { showToast: async (options) => calls.push(options) } },
  })

  const result = await notify.execute({ message: "running verification", variant: "success" }, createToolContext())

  assert.equal(result, "ok")
  assert.deepEqual(calls, [{ body: { message: "running verification", variant: "success" } }])
})

test("notify tool fails open when showToast is unavailable", async () => {
  const shapes = [
    undefined,
    {},
    { client: {} },
    { client: { tui: {} } },
  ]

  for (const input of shapes) {
    const notify = createNotifyTool(input)
    await assert.doesNotReject(() => notify.execute({ message: "still running" }, createToolContext()))
    assert.equal(await notify.execute({ message: "still running" }, createToolContext()), "ok")
  }
})

test("notify tool swallows toast failures and warns once", async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(" "))

  try {
    const notify = createNotifyTool({
      client: { tui: { showToast: async () => { throw new Error("toast failed") } } },
    })

    const result = await notify.execute({ message: "still running" }, createToolContext())
    assert.equal(result, "ok")
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? "", /\[notify-tool\] failed to show toast/)
})

test("notify tool validates schema boundaries", () => {
  const notify = createNotifyTool()

  assert.equal(notify.args.message.safeParse("").success, false)
  assert.equal(notify.args.message.safeParse("progress").success, true)
  for (const variant of ["info", "success", "warning", "error"]) {
    assert.equal(notify.args.variant.safeParse(variant).success, true)
  }
  assert.equal(notify.args.variant.safeParse("debug").success, false)
})
```

- [ ] **步骤 5：写入 `test/plugin-entry.test.js` 失败测试**

创建 `test/plugin-entry.test.js`，内容为：

```js
import test from "node:test"
import assert from "node:assert/strict"

import NotifyPlugin, { createNotifyPlugin } from "../dist/index.js"

function createToolContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "task",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("default export is a callable OpenCode plugin", () => {
  assert.equal(typeof NotifyPlugin, "function")
})

test("createNotifyPlugin returns hooks and tool.notify.execute is callable", async () => {
  const hooks = await createNotifyPlugin()({ client: {}, directory: process.cwd(), worktree: process.cwd() })

  assert.equal(typeof hooks.tool?.notify?.execute, "function")
})

test("plugin entry uses runtime injected client", async () => {
  const calls = []
  const hooks = await createNotifyPlugin()({
    client: { tui: { showToast: async (options) => calls.push(options) } },
    directory: process.cwd(),
    worktree: process.cwd(),
  })

  const result = await hooks.tool.notify.execute({ message: "runtime progress" }, createToolContext())

  assert.equal(result, "ok")
  assert.equal(calls[0]?.body?.message, "runtime progress")
  assert.equal(calls[0]?.body?.variant, "info")
})

test("explicit seam client takes precedence over runtime client", async () => {
  const seamCalls = []
  const runtimeCalls = []
  const hooks = await createNotifyPlugin({
    client: { tui: { showToast: async (options) => seamCalls.push(options) } },
  })({
    client: { tui: { showToast: async (options) => runtimeCalls.push(options) } },
    directory: process.cwd(),
    worktree: process.cwd(),
  })

  await hooks.tool.notify.execute({ message: "seam progress", variant: "warning" }, createToolContext())

  assert.equal(seamCalls.length, 1)
  assert.equal(runtimeCalls.length, 0)
  assert.equal(seamCalls[0]?.body?.variant, "warning")
})

test("tool.definition only rewrites notify", async () => {
  const hooks = await createNotifyPlugin()({ client: {}, directory: process.cwd(), worktree: process.cwd() })
  const notifyOutput = { description: "original notify", parameters: { type: "object" }, extra: "keep" }
  const questionOutput = { description: "original question", parameters: { type: "object" }, extra: "keep" }
  const waitOutput = { description: "original wait", parameters: { type: "object" }, extra: "keep" }
  const otherOutput = { description: "original other", parameters: { type: "object" }, extra: "keep" }

  await hooks["tool.definition"]?.({ toolID: "notify" }, notifyOutput)
  await hooks["tool.definition"]?.({ toolID: "question" }, questionOutput)
  await hooks["tool.definition"]?.({ toolID: "wait" }, waitOutput)
  await hooks["tool.definition"]?.({ toolID: "bash" }, otherOutput)

  assert.deepEqual(notifyOutput, {
    description: "Use for non-blocking progress and phase updates only; do not require immediate user response.",
    parameters: { type: "object" },
    extra: "keep",
  })
  assert.deepEqual(questionOutput, { description: "original question", parameters: { type: "object" }, extra: "keep" })
  assert.deepEqual(waitOutput, { description: "original wait", parameters: { type: "object" }, extra: "keep" })
  assert.deepEqual(otherOutput, { description: "original other", parameters: { type: "object" }, extra: "keep" })
})
```

- [ ] **步骤 6：安装依赖并确认测试先失败**

运行：

```powershell
npm install
npm test
```

预期：`npm install` 生成 `package-lock.json`；`npm test` 失败，原因是 `src/notify-tool.ts` 和 `src/index.ts` 还不存在，或 `dist/` 中没有对应构建产物。

### 任务 2：实现 `notify` tool 与插件入口

**文件：**
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\src\notify-tool.ts`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\src\index.ts`

- [ ] **步骤 1：写入 `src/notify-tool.ts`**

```typescript
import { tool } from "@opencode-ai/plugin"

export type ToastVariant = "info" | "success" | "warning" | "error"

export type NotifyToolInput = {
  client?: {
    tui?: {
      showToast?: (options: {
        body: {
          message: string
          variant: ToastVariant
        }
        query?: undefined
      }) => Promise<unknown>
    }
  }
}

export function createNotifyTool(input: NotifyToolInput = {}) {
  return tool({
    description: "Notify the user with a non-blocking progress update.",
    args: {
      message: tool.schema.string().min(1).describe("Progress message to show without blocking"),
      variant: tool.schema.enum(["info", "success", "warning", "error"]).optional().describe("Toast variant"),
    },
    async execute(args) {
      try {
        await input.client?.tui?.showToast?.({
          body: {
            message: args.message,
            variant: args.variant ?? "info",
          },
        })
      } catch (error) {
        console.warn("[notify-tool] failed to show toast", error)
      }

      return "ok"
    },
  })
}
```

- [ ] **步骤 2：写入 `src/index.ts`**

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { createNotifyTool, type NotifyToolInput } from "./notify-tool.js"

const NOTIFY_TOOL_DESCRIPTION = "Use for non-blocking progress and phase updates only; do not require immediate user response."

export { createNotifyTool }
export type { NotifyToolInput }

export function createNotifyPlugin(notifyInput: NotifyToolInput = {}): Plugin {
  return async (input) => ({
    tool: {
      notify: createNotifyTool({
        ...notifyInput,
        client: notifyInput.client ?? input.client,
      }),
    },
    "tool.definition": async (hookInput, output) => {
      if (hookInput.toolID === "notify") {
        output.description = NOTIFY_TOOL_DESCRIPTION
      }
    },
  })
}

export const NotifyPlugin: Plugin = createNotifyPlugin()

export default NotifyPlugin
```

- [ ] **步骤 3：运行单包测试转绿**

运行：

```powershell
npm run build
npm test
npm run typecheck
```

预期：三条命令退出码为 0；`dist/index.js`、`dist/index.d.ts`、`dist/notify-tool.js`、`dist/notify-tool.d.ts` 存在；没有 `.map` 文件。

- [ ] **步骤 4：确认 runtime dependency 没有扩张**

运行：

```powershell
npm ls --omit=dev --depth=0 --json
```

预期：`npm ls` 的直接 runtime dependency 只有 `@opencode-ai/plugin`。发布文件白名单在任务 3 写入 README/LICENSE 后验证，避免在文件尚未创建时检查 pack 列表。

### 任务 3：补齐独立包 README、发布文档、Release 模板和 workflow

**文件：**
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\README.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\publishing.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\release-notes-template.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\docs\release-notes-v0.1.0.md`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\.github\workflows\release.yml`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\LICENSE`

- [ ] **步骤 1：写入 README 的固定内容**

`README.md` 必须中文在前、英文镜像。中文段落包含以下内容：

````markdown
# opencode-notify-tool

`opencode-notify-tool` 为 OpenCode 提供独立的 `notify` tool，让模型可以用非阻塞 toast 汇报进度、阶段切换和后台状态，而不把纯进度升级成需要用户回复的提问。

## 安装

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

## 工具参数

```json
{
  "message": "Running verification",
  "variant": "info"
}
```

- `message`：必填，非空字符串。
- `variant`：可选，只能是 `info`、`success`、`warning`、`error`。

## 与 `question` 的边界

`notify` 只用于非阻塞进度。需要用户响应、确认、授权、最终交接或无安全工作可继续时，应使用 `question`。

## 与 `opencode-wait` 配合

等待交给 `opencode-wait`，进度交给 `opencode-notify-tool`。

## 与未来 `opencode-loop-safety` 配合

Loop Safety 可以通过外部 `notify`、`wait`、`question` 工具获得完整通道。本包只负责非阻塞通知。
````

英文段落必须包含同一组事实，并包含同一条安装命令 `opencode plugin opencode-notify-tool@0.1.0 --force -g`。

- [ ] **步骤 2：写入 `docs/publishing.md` 的发布流程**

`docs/publishing.md` 至少包含这些二级标题，且每节都有对应命令：

````markdown
# opencode-notify-tool 发布流程

## 手动首发
## 发布前 fresh 验证
## npm Trusted Publisher 设置与验证
## 后续 GitHub Actions 发布
## GitHub Release 创建与验证
## 部分失败恢复
````

关键命令必须逐字出现：

```powershell
npm test
npm pack --dry-run --json
npm view opencode-notify-tool version --json
npm whoami
npm publish --access public
npx --yes npm@latest trust github opencode-notify-tool --file release.yml --repo jiwangyihao/opencode-notify-tool --yes
npx --yes npm@latest trust list opencode-notify-tool --json
gh release create v0.1.0 --repo jiwangyihao/opencode-notify-tool --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md --latest
```

`部分失败恢复` 必须写清楚：如果 npm publish 已成功但 GitHub Release 失败，修复 `gh release create` 后重试，workflow 的 `Publish` step skipped 是预期；如果 GitHub Release 已创建但 workflow 失败，修复 Trusted Publisher 或 workflow 后重新触发 release workflow，不能只把 npm publish 当成完成。

- [ ] **步骤 3：写入 Release notes 模板和 v0.1.0 正文**

`docs/release-notes-template.md` 和 `docs/release-notes-v0.1.0.md` 都使用以下结构：

````markdown
`opencode-notify-tool` 让 OpenCode 模型可以用非阻塞 toast 汇报进度，而不把纯进度升级成需要用户回复的提问。

## 适合谁升级

- 需要让模型发送非阻塞进度提示的 OpenCode 用户。
- 正在组合 `opencode-wait` 与 Guided Loop Safety 工作流的用户。

## 你会看到的变化

- 新增独立 `notify` tool，用于进度、阶段切换和后台状态提示。
- `notify` 只暴露 `message` 与可选 `variant`，不承担确认、授权或最终交接。
- 缺失或失败的 toast 会 fail open，不会中断主工作流。

## 升级方式

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```
````

- [ ] **步骤 4：写入 GitHub Actions release workflow**

`.github/workflows/release.yml` 内容为：

```yaml
name: Release

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write # Required for npm Trusted Publishing (OIDC)

jobs:
  publish-npm:
    runs-on: ubuntu-latest
    env:
      NODE_AUTH_TOKEN: ""
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - name: Upgrade npm for trusted publishing
        run: npm install -g npm@latest

      - name: Install
        run: npm ci

      - name: Versions
        run: |
          node --version
          npm --version

      - name: Build
        run: npm run build

      - name: Test
        run: npm run test:built

      - name: Check if version already published
        id: npm
        shell: bash
        run: |
          NAME="$(node -p "require('./package.json').name")"
          VERSION="$(node -p "require('./package.json').version")"
          if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then
            echo "published=true" >> "$GITHUB_OUTPUT"
          else
            echo "published=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Publish
        if: steps.npm.outputs.published != 'true'
        run: npm publish --access public
```

- [ ] **步骤 5：写入 LICENSE 并检查文档口径**

创建 `LICENSE`，使用 MPL-2.0 license text，年份为 2026，copyright holder 为 `jiwangyihao`。

运行：

```powershell
rg -n "opencode plugin opencode-notify-tool@0.1.0 --force -g" README.md docs
rg -n "opencode-notify-tool@latest|opencode plugin opencode-notify-tool --force -g" README.md docs
npm test
npm pack --dry-run --json
```

预期：第一条命令能命中文档中的明确版本安装命令；第二条命令无输出；测试和 pack dry-run 通过。pack dry-run 的 `files` 数组必须精确匹配：`LICENSE`、`README.md`、`dist/index.d.ts`、`dist/index.js`、`dist/notify-tool.d.ts`、`dist/notify-tool.js`、`package.json`。

### 任务 4：独立包 fresh 验证与手工驱动 QA

**文件：**
- 验证：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\dist\index.js`
- 验证：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\dist\notify-tool.js`

- [ ] **步骤 1：运行发布前 fresh 验证**

运行：

```powershell
npm test
npm ls --omit=dev --depth=0 --json
npm pack --dry-run --json
npm view opencode-notify-tool version --json
```

预期：`npm test` 通过；runtime dependency 只有 `@opencode-ai/plugin`；pack 文件白名单精确匹配任务 3 步骤 5 的后置 allowlist；`npm view` 在首发前返回 E404。如果 `npm view` 返回已有版本，停止并把返回的版本交给主代理。

- [ ] **步骤 2：驱动 named factory 表面**

运行：

```powershell
node --input-type=module -e "
const calls = [];
const mod = await import('./dist/index.js');
const hooks = await mod.createNotifyPlugin({ client: { tui: { showToast: async (options) => calls.push(options) } } })({});
const result = await hooks.tool.notify.execute({ message: 'driver progress', variant: 'success' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(JSON.stringify({ result, calls, hasDefault: typeof mod.default === 'function' }, null, 2));
"
```

预期：输出 JSON 中 `result` 为 `ok`，`calls[0].body.message` 为 `driver progress`，`calls[0].body.variant` 为 `success`，`hasDefault` 为 `true`。

- [ ] **步骤 3：驱动 default export 与 runtime client 表面**

运行：

```powershell
node --input-type=module -e "
const calls = [];
const mod = await import('./dist/index.js');
const hooks = await mod.default({ client: { tui: { showToast: async (options) => calls.push(options) } } });
const result = await hooks.tool.notify.execute({ message: 'default export progress' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(JSON.stringify({ result, calls }, null, 2));
"
```

预期：输出 JSON 中 `result` 为 `ok`，`calls[0].body.message` 为 `default export progress`，`calls[0].body.variant` 为 `info`。

- [ ] **步骤 4：驱动 toast 失败表面**

运行：

```powershell
node --input-type=module -e "
const mod = await import('./dist/index.js');
const hooks = await mod.createNotifyPlugin({ client: { tui: { showToast: async () => { throw new Error('toast failed') } } } })({});
const result = await hooks.tool.notify.execute({ message: 'still ok' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(result);
"
```

预期：命令退出码为 0，输出包含 `ok`，stdout 或 stderr 中可见 `[notify-tool] failed to show toast`。

### 任务 5：完成新仓库 GitHub、npm、Trusted Publisher 和 Release 链路

**文件：**
- 操作：`C:\Users\34404\Documents\GitHub\opencode-notify-tool\.git`
- 操作：GitHub repo `jiwangyihao/opencode-notify-tool`
- 操作：npm package `opencode-notify-tool@0.1.0`

- [ ] **步骤 1：初始化 Git 并创建远端**

运行：

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-notify-tool"
gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated; run gh auth login in an interactive PTY, then rerun this step." }
$env:GIT_MASTER = "1"
git init
git branch -M master
git add .
git commit -m "feat(notify): 初始化独立通知插件"
gh repo create jiwangyihao/opencode-notify-tool --public --source . --remote origin --push
git ls-remote --heads origin master
```

如果 `gh auth status` 返回非零退出码，使用交互式 PTY 运行：

```powershell
gh auth login
```

用户完成浏览器登录和 2FA 后，重新运行 `gh auth status`。验证通过后继续同一条 GitHub 远端创建链路；不要因为需要 GitHub 登录或 2FA 就停止整个 release chain。

预期：远端 `master` 能查到刚创建的提交。如果 `gh repo create` 已创建远端但 push 失败，运行：

```powershell
git remote -v
$env:GIT_MASTER = "1"
git push -u origin master
git ls-remote --heads origin master
```

- [ ] **步骤 2：手动 npm 首发并验证**

运行：

```powershell
npm whoami
npm publish --access public
npm view opencode-notify-tool version --json
npm view opencode-notify-tool dist-tags --json
npm view opencode-notify-tool repository.url --json
```

预期：`npm whoami` 返回 `jiwangyihao`；publish 成功；version 返回 `"0.1.0"`；dist-tags 的 `latest` 为 `0.1.0`；repository.url 为 `git+https://github.com/jiwangyihao/opencode-notify-tool.git`。

如果 `npm whoami` 返回 `E401`、`ENEEDAUTH` 或非零退出码，用 PTY 运行 `npm login`，等待用户完成浏览器登录和 2FA，再重新运行 `npm whoami`。如果 `npm publish` 生成 2FA/web auth 链接，继续使用同一个 PTY 等待，不停止发布链路。

- [ ] **步骤 3：配置并验证 npm Trusted Publisher**

运行：

```powershell
npx --yes npm@latest trust github opencode-notify-tool --file release.yml --repo jiwangyihao/opencode-notify-tool --yes
npx --yes npm@latest trust list opencode-notify-tool --json
```

预期：配置输出包含 `type: github`、`repository: jiwangyihao/opencode-notify-tool`、`file: release.yml`；`trust list` 输出对应到 GitHub provider、`jiwangyihao/opencode-notify-tool` 和 `release.yml`。

如果 CLI 返回 `EOTP`，用 PTY 交互重跑同一命令并等待 2FA。如果当前 npm CLI 不支持 `trust list`，在 npmjs.com 包设置页确认 Provider 为 GitHub Actions、Organization/user 为 `jiwangyihao`、Repository 为 `opencode-notify-tool`、Workflow filename 为 `release.yml`、Environment name 留空，并把确认方式写入发布证据。

- [ ] **步骤 4：创建 GitHub Release 并等待 workflow**

运行：

```powershell
gh release create v0.1.0 --repo jiwangyihao/opencode-notify-tool --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md --latest
gh release view v0.1.0 --repo jiwangyihao/opencode-notify-tool --json tagName,publishedAt,isDraft,isPrerelease,body
gh run list --repo jiwangyihao/opencode-notify-tool --workflow Release --limit 5 --json databaseId,status,conclusion,event,headSha,displayTitle
$runId = gh run list --repo jiwangyihao/opencode-notify-tool --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --repo jiwangyihao/opencode-notify-tool --exit-status
gh run view $runId --repo jiwangyihao/opencode-notify-tool --json conclusion,jobs
```

预期：Release 已发布、非 draft、非 prerelease；body 包含 `## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`；升级方式使用 `opencode-notify-tool@0.1.0`；workflow event 对应本次 release，`headSha` 与 release 目标提交一致，conclusion 为 `success`。因为 `0.1.0` 已手动发布，workflow 中 `Publish` step skipped 是预期结果；Build、Test、Check if version already published 必须成功。

### 任务 6：在当前 Copilot 包 worktree 先写回迁失败测试

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\plugin.test.js`

- [ ] **步骤 1：创建项目内 worktree 并验证基线**

运行：

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher"
git check-ignore -q .worktrees
$env:GIT_MASTER = "1"
git worktree add ".worktrees/opencode-notify-tool-copilot-migration" -b "split/opencode-notify-tool-copilot-migration"
Set-Location ".worktrees/opencode-notify-tool-copilot-migration"
npm install
npm test
```

预期：`.worktrees` 已被忽略；worktree 创建成功；基线 `npm test` 通过。如果基线测试失败，记录失败测试名和错误，停止让主代理判断是否继续。

- [ ] **步骤 2：把工具注册测试改成不再拥有 `notify`**

在 `test/plugin.test.js` 中把现有 `tool registry keeps wait outside the Copilot package` 测试改名并改断言：

```js
test("tool registry keeps notify and wait outside the Copilot package", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  assert.deepEqual(Object.keys(plugin.tool ?? {}).sort(), [])
})
```

- [ ] **步骤 3：把 notify definition 测试改成外部工具不被改写**

删除旧测试 `tool.definition rewrites notify description as non-blocking progress channel`，替换为：

```js
test("tool.definition leaves external notify tools untouched", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
  })

  const output = { description: "external notify", parameters: { type: "object" }, extra: "keep" }
  await plugin["tool.definition"]?.({ toolID: "notify" }, output)

  assert.deepEqual(output, { description: "external notify", parameters: { type: "object" }, extra: "keep" })
})
```

- [ ] **步骤 4：删除旧 Copilot notify 行为测试**

从 `test/plugin.test.js` 删除这些测试块：

```text
plugin exposes notify tool for model progress updates
notify tool defaults variant to info
notify tool maps message and variant to tui.showToast
notify tool fails open when showToast is unavailable
notify tool swallows toast failures and warns once
```

这些行为已经由 `C:\Users\34404\Documents\GitHub\opencode-notify-tool\test\notify-tool.test.js` 覆盖。

- [ ] **步骤 5：新增 stale artifact 和 pack 防回归测试**

在 `test/plugin.test.js` 顶部新增 import：

```js
import { execFile } from "node:child_process"
import { promisify } from "node:util"
```

在 helper 区新增：

```js
const execFileAsync = promisify(execFile)
```

在靠近 package export 测试的位置新增：

```js
test("copilot package has no stale notify-tool artifacts after build", () => {
  assert.equal(existsSync(new URL("../src/notify-tool.ts", import.meta.url)), false)
  assert.equal(existsSync(new URL("../dist/notify-tool.js", import.meta.url)), false)
  assert.equal(existsSync(new URL("../dist/notify-tool.d.ts", import.meta.url)), false)
})

test("npm pack dry run excludes notify-tool artifacts", async () => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  const { stdout } = await execFileAsync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    windowsHide: true,
  })
  const pack = JSON.parse(stdout)
  const files = pack[0].files.map((entry) => entry.path)

  assert.equal(files.some((filePath) => filePath.includes("notify-tool")), false)
})
```

- [ ] **步骤 6：运行回迁测试确认失败**

运行：

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npm run build
node --test --test-concurrency=1 --test-name-pattern "tool registry keeps notify and wait outside|tool.definition leaves external notify|stale notify-tool|npm pack dry run excludes notify-tool" test/plugin.test.js
```

预期：测试失败，原因是当前 Copilot 包仍注册 `tool.notify`、仍改写 `notify` definition，或 `src/notify-tool.ts` 仍存在。

### 任务 7：回迁清理 Copilot 包实现和 README

**文件：**
- 删除：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\notify-tool.ts`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\plugin-hooks.ts`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\README.md`

- [ ] **步骤 1：删除 Copilot 本地 notify 实现**

删除文件：

```powershell
Remove-Item "src\notify-tool.ts"
```

- [ ] **步骤 2：删除 `plugin-hooks.ts` 的 notify import 和工具注册**

从 `src/plugin-hooks.ts` 删除：

```ts
import { createNotifyTool } from "./notify-tool.js"
```

删除 hooks 返回对象中的整个 `tool` 块：

```ts
tool: {
  notify: createNotifyTool({
    client: input.client,
  }),
},
```

如果删除后没有其它工具注册，返回对象中不保留空 `tool: {}`。

- [ ] **步骤 3：只保留 question definition 改写**

把 `tool.definition` 保持为只处理 `question`：

```ts
"tool.definition": async (hookInput, output) => {
  if (hookInput.toolID === "question") {
    output.description = "Use for required user response, user confirmation, final handoff, no-safe-work-left states, or uncertain routing cases. Do not use for unattended/background waits that can resume automatically; use a dedicated wait tool when available."
  }
},
```

不要为 `notify`、`wait` 或其它外部工具改写 description。

- [ ] **步骤 4：更新中文 README 的 Guided Loop Safety 口径**

在中文 “与 `opencode-wait` 配合” 段落后新增：

````markdown
## 与 `opencode-notify-tool` 配合

如果你的工作流需要非阻塞进度 toast，请单独安装 `opencode-notify-tool`：

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

安装后，Guided Loop Safety 的纯进度语义会自然落到这个专用工具；Copilot 插件继续聚焦账号、配额和 Copilot 请求增强。
````

同时把中文功能一览和 Guided Loop Safety 长段落中的 “`notify` 负责纯进度” 改成 “已安装的外部 `notify` 工具负责纯进度；未安装时纯进度静默继续”。

- [ ] **步骤 5：更新英文 README 的组合口径**

在英文 “Using with `opencode-wait`” 段落后新增：

````markdown
## Using with `opencode-notify-tool`

If your workflow needs non-blocking progress toasts, install `opencode-notify-tool` separately:

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

After installation, Guided Loop Safety can route pure progress updates to that dedicated tool while this Copilot plugin stays focused on accounts, quota, and Copilot request enhancements.
````

同时把英文功能一览和 Guided Loop Safety 长段落中的 built-in `notify` 口径改成 external dedicated `notify` tool 口径。

- [ ] **步骤 6：运行回迁定向测试转绿**

运行：

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npm run build
node --test --test-concurrency=1 --test-name-pattern "tool registry keeps notify and wait outside|tool.definition leaves external notify|LOOP_SAFETY_POLICY|Guided Loop Safety|stale notify-tool|npm pack dry run excludes notify-tool" test/plugin.test.js test/loop-safety-plugin.test.js
```

预期：命令退出码为 0；`src/notify-tool.ts`、`dist/notify-tool.js`、`dist/notify-tool.d.ts` 都不存在。

### 任务 8：当前 Copilot 包 fresh 验证与表面 QA

**文件：**
- 验证：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\dist\internal.js`
- 验证：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\README.md`

- [ ] **步骤 1：运行 pack 和 README 搜索验证**

运行：

```powershell
npm pack --dry-run --json
rg -n "opencode plugin opencode-notify-tool@0.1.0 --force -g" README.md
rg -n "opencode-notify-tool@latest|opencode plugin opencode-notify-tool --force -g" README.md
```

预期：pack 输出不包含 `notify-tool`；第一条 `rg` 命中文中和英文安装段；第二条 `rg` 无输出。

- [ ] **步骤 2：驱动当前 Copilot 插件表面确认不再拥有 notify**

运行：

```powershell
node --input-type=module -e "
const mod = await import('./dist/internal.js');
const hooks = mod.buildPluginHooks({ auth: { provider: 'github-copilot', methods: [] }, loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }) });
const notifyOutput = { description: 'external notify' };
await hooks['tool.definition']?.({ toolID: 'notify' }, notifyOutput);
console.log(JSON.stringify({ toolKeys: Object.keys(hooks.tool ?? {}), notifyDescription: notifyOutput.description }, null, 2));
"
```

预期：输出 JSON 中 `toolKeys` 为 `[]`，`notifyDescription` 保持 `external notify`。

- [ ] **步骤 3：运行当前 Copilot 包 fresh test**

运行：

```powershell
npm test
```

预期：退出码为 0。如果因为既有微信真实宿主 gate 或外部环境失败，记录失败测试名、命令输出中的具体错误，以及它与本次拆分无关的原因；不能引用旧测试结果。

- [ ] **步骤 4：汇总阶段证据**

记录以下证据到执行日志或最终交付说明：

```text
opencode-notify-tool:
- npm test: <exit code and pass count>
- npm pack --dry-run --json: <exact file list>
- manual driver factory/default/failure: <observed output>
- npm view version/dist-tags/repository: <observed output>
- Trusted Publisher verification: <CLI JSON or npmjs.com confirmation>
- GitHub Release/workflow: <release JSON and run conclusion>

copilot-account-switcher:
- targeted tests: <exit code>
- npm pack --dry-run --json: <notify-tool absent>
- npm test: <exit code or unrelated failure record>
- surface driver: <toolKeys [], notifyDescription external notify>
```

预期：所有成功标准都有 fresh 证据；任何外部失败都有具体命令和错误，不用旧输出替代。

## 自检清单

- [ ] 规格中的目标、非目标、工具契约、包结构、迁移边界、测试策略、手工 QA、发布流程、README、阶段边界、成功标准、风险缓解都能映射到至少一个任务。
- [ ] 独立包阶段、首发链路阶段、Copilot 回迁阶段没有互相穿插。
- [ ] 计划中没有把微信、Copilot retry、quota、Loop Safety 主体、`question` 或 `wait` 放进 `opencode-notify-tool`。
- [ ] 计划中所有安装命令都使用 `opencode-notify-tool@0.1.0`，没有使用 npm `latest` 或裸包名安装。
- [ ] 当前 Copilot 包回迁有测试先失败、实现后转绿、pack 检查和真实 driver 表面验证。
