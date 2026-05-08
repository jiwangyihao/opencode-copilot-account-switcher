# OpenCode Notify Tool 独立插件拆分设计

## 背景

`opencode-copilot-account-switcher` 当前仍拥有一个通用 `notify` 工具实现：

- `src/notify-tool.ts` 通过 `@opencode-ai/plugin` 的 `tool(...)` 暴露 `notify`。
- `src/plugin-hooks.ts` 在 hooks 中注册 `tool.notify`，并改写 `tool.definition` 里的 `notify` 描述。
- `test/plugin.test.js` 覆盖 `notify` 的参数面、默认 `variant`、toast 映射、缺失 `showToast` 的 fail-open 以及 toast 抛错 warning。

这套能力已经不属于 Copilot 账号切换领域。它服务的是 OpenCode 模型与用户之间的通用非阻塞进度通道：纯进度、阶段切换和后台状态应该通过 `notify` 告知用户，但不要求用户立即回复。

`opencode-wait` 已经完成第一轮完整拆分：新仓库建立、独立 npm 包首发、npm Trusted Publisher、GitHub Release 与 release workflow 验证都已跑通。`opencode-notify-tool` 必须复用这次完整流程，而不是只把代码复制成一个包。

## 目标

1. 创建独立仓库 `jiwangyihao/opencode-notify-tool`，本地路径为 `C:\Users\34404\Documents\GitHub\opencode-notify-tool`。
2. 发布独立 npm 包 `opencode-notify-tool@0.1.0`。
3. `opencode-notify-tool` 独立提供 OpenCode `notify` tool，行为与当前 Copilot 包内实现保持一致。
4. 当前 Copilot 包停止拥有 `notify` 工具实现与 `notify` definition 改写；后续需要非阻塞进度通道的用户单独安装 `opencode-notify-tool`。
5. 手动完成 npm 首发后，为 `opencode-notify-tool` 配置 npm Trusted Publishing，使后续版本由 GitHub Release 触发 GitHub Actions OIDC 发布。
6. 把发布流程文档、release notes 模板和验证要求放进 `opencode-notify-tool` 仓库，避免重复 `opencode-wait` 首发中“仓库没有 release notes 模板”的缺口。

## 非目标

1. 不在这一轮拆出 `opencode-loop-safety`。Loop Safety 仍留在 Copilot 包内，后续单独拆分。
2. 不把微信通知传输、微信 broker、request 状态或 slash 回复能力放入 `opencode-notify-tool`。
3. 不把 Copilot retry toast、Copilot quota toast 或微信通知设置迁移到 `opencode-notify-tool`。这些仍属于各自领域插件。
4. 不新增可靠消息队列、通知历史、去重、限流或多通道通知中心。
5. 不创建共享库。`notify` 的实现足够小，应直接放在独立包内；当前 Copilot 包删除本地实现，而不是通过共享库复用。

## 用户可见契约

`opencode-notify-tool` 的用户可见能力只有一个：提供 `notify` tool。

### 工具名

工具名固定为 `notify`。

### 工具描述

工具描述必须表达：

- 用于非阻塞进度更新和阶段切换。
- 不要求立即用户响应。
- 不用于需要确认、选择、授权、最终交接或无安全工作可继续的强交互场景。

推荐描述：

```text
Use for non-blocking progress and phase updates only; do not require immediate user response.
```

### 参数面

v1 参数面保持当前实现，不扩张：

```typescript
type NotifyArgs = {
  message: string
  variant?: "info" | "success" | "warning" | "error"
}
```

要求：

1. `message` 必填，最小长度为 1。
2. `variant` 可选，缺省为 `info`。
3. 不暴露 `title`、`duration`、`channel`、`dedupeKey` 或其它展示细节。

### 执行行为

1. 如果当前 OpenCode runtime 提供 `client.tui.showToast`，调用：

   ```typescript
   await client.tui.showToast({
     body: {
       message: args.message,
       variant: args.variant ?? "info",
     },
   })
   ```

2. 如果 `client`、`tui` 或 `showToast` 缺失，工具 fail open，返回 `"ok"`。
3. 如果 `showToast` 抛错，工具吞掉错误，记录一次 `console.warn("[notify-tool] failed to show toast", error)`，并返回 `"ok"`。
4. `notify` 调用不能阻塞主工作流，也不能把失败升级成 `question`。

## 独立包结构

新仓库最小结构如下：

```text
opencode-notify-tool/
  .github/workflows/release.yml
  docs/publishing.md
  docs/release-notes-template.md
  src/index.ts
  src/notify-tool.ts
  test/notify-tool.test.js
  test/plugin-entry.test.js
  LICENSE
  README.md
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
```

### `package.json`

初始元数据：

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

### `tsconfig.json` 与 `tsconfig.build.json`

新仓库沿用当前包已验证的 ESM 构建形态，避免实施者在 `NodeNext` 与 `Bundler` 之间重新选择。最小配置如下。

`tsconfig.json`：

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

`tsconfig.build.json`：

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

构建产物只能包含 `.js` 与 `.d.ts`，不生成 sourcemap 或 declaration map；这与后续 `npm pack --dry-run --json` 的发布文件白名单一致。

### `src/notify-tool.ts`

从当前 Copilot 包迁移核心实现，但公开测试 seam 类型：

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

### `src/index.ts`

独立 OpenCode 插件入口必须真实存在，不能只导出 helper：

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

## 当前 Copilot 包迁移边界

`opencode-notify-tool` 发布并验证后，当前仓库应做一次迁移清理。

### 删除 Copilot 包拥有的 notify 工具

1. 删除 `src/notify-tool.ts`。
2. 删除 `src/plugin-hooks.ts` 中的 `createNotifyTool` import。
3. 删除 hooks 返回值里的：

   ```typescript
   tool: {
     notify: createNotifyTool({ client: input.client }),
   }
   ```

4. 删除 `tool.definition` 中 `hookInput.toolID === "notify"` 的 description 改写，让外部 `opencode-notify-tool` 自己拥有工具定义。
5. 保留 `question` definition 改写，因为 Loop Safety 尚未拆出；但它只能表达强交互、等待态与专用 `wait` 工具边界，不得继续承载 `notify` 的降级语义。`notify` 缺失时“纯进度静默继续、不升级为 `question`”这条规则只保留在 `src/loop-safety-plugin.ts` 的 `LOOP_SAFETY_POLICY` 中，直到后续 `opencode-loop-safety` 拆出。

### 更新 Copilot 包测试

当前 `test/plugin.test.js` 中这组测试要迁移或删除：

- `plugin exposes notify tool for model progress updates`
- `notify tool defaults variant to info`
- `notify tool maps message and variant to tui.showToast`
- `notify tool fails open when showToast is unavailable`
- `notify tool swallows toast failures and warns once`
- `tool.definition rewrites notify description as non-blocking progress channel`

这些行为测试应迁入 `opencode-notify-tool` 仓库。

当前 Copilot 包应新增或更新以下边界测试：

1. `tool registry keeps notify outside the Copilot package`：断言 Copilot package 不再暴露 `notify` tool。
2. `tool.definition leaves external notify tools untouched`：断言对 `toolID: "notify"` 不改写外部工具描述。
3. Loop Safety policy 测试继续保留 `notify` 相关文本，确保策略能说明外部 `notify` 的语义和缺失时降级。
4. `copilot package has no stale notify-tool artifacts after build`：先删除 `dist/` 再构建，断言 `src/notify-tool.ts`、`dist/notify-tool.js`、`dist/notify-tool.d.ts` 都不存在。
5. `npm pack --dry-run --json` 不能包含 `notify-tool`，防止当前包因发布整个 `dist/` 而带出旧构建残留。

### 更新 Copilot README

Copilot README 不应继续暗示内置 `notify`。应在 Guided Loop Safety 附近补一段“与 `opencode-notify-tool` 配合”：

````markdown
如果你的工作流需要非阻塞进度 toast，请单独安装 `opencode-notify-tool`：

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

安装后，Guided Loop Safety 的纯进度语义会自然落到这个专用工具；Copilot 插件继续聚焦账号、配额和 Copilot 请求增强。
````

英文部分同步添加对应说明。

## 新仓库建立流程

以 `opencode-wait` 首发流程为基准，`opencode-notify-tool` 新仓库建立必须包含以下步骤。

### 1. 创建本地仓库

所有新仓库命令都必须在 `C:\Users\34404\Documents\GitHub\opencode-notify-tool` 内执行，避免误操作当前 Copilot 仓库：

```powershell
mkdir "C:\Users\34404\Documents\GitHub\opencode-notify-tool"
Set-Location "C:\Users\34404\Documents\GitHub\opencode-notify-tool"
```

先创建本 spec 列出的 `package.json`、`tsconfig.json`、`tsconfig.build.json`、`src/`、`test/`、`README.md`、`LICENSE`、`docs/` 和 `.github/workflows/` 文件，再安装依赖并生成 lockfile：

```powershell
npm install
npm run build
npm test
```

### 2. 初始化 Git 与 GitHub 远端

在创建远端前先确认 GitHub CLI 已登录：

```powershell
gh auth status
```

然后创建初始提交并推送。没有初始提交时不得执行 `gh repo create --push` 或创建 release。

```powershell
$env:GIT_MASTER = "1"
git init
git branch -M master
git add .
git commit -m "feat(notify): 初始化独立通知插件"
gh repo create jiwangyihao/opencode-notify-tool --public --source . --remote origin --push
```

如果 `gh repo create` 已创建远端但 push 失败，应先用 `git remote -v` 验证远端，再执行普通推送：

```powershell
$env:GIT_MASTER = "1"
git push -u origin master
git ls-remote --heads origin master
```

远端 `master` 可查询到提交后，才能进入 npm 发布。不得只创建本地仓库或空远端就进入 npm 发布。

### 3. 新仓库 README

README 应只介绍 `opencode-notify-tool` 自身：

- 它提供什么：OpenCode `notify` tool。
- 适合谁安装：需要非阻塞进度 toast 的用户或 Loop Safety 组合用户。
- 如何安装：使用明确版本号 `opencode plugin opencode-notify-tool@0.1.0 --force -g`。
- 如何启用：作为 OpenCode 插件安装即可。
- 如何在自定义插件里注入测试 seam：`createNotifyPlugin({ client })`。
- 它与 `opencode-wait`、`opencode-loop-safety` 的组合关系。

README 不应大段罗列“不包含 Copilot / 不包含微信 / 不包含 Codex”。最多用一小段边界说明：`opencode-notify-tool` 只负责非阻塞通知；远程传输和领域状态由其它插件提供。

## 测试策略

### 单包行为测试

`test/notify-tool.test.js` 至少覆盖：

1. `notify tool exposes message and optional variant only`：断言参数 keys 精确为 `message`、`variant`，并排除 `title`、`duration`、`channel`、`dedupeKey`。
2. `notify tool defaults variant to info`，并断言返回值为 `"ok"`。
3. `notify tool maps message and variant to tui.showToast`，并断言返回值为 `"ok"`。
4. `notify tool fails open when showToast is unavailable`：分别覆盖 `client` 缺失、`tui` 缺失、`showToast` 缺失三种形态，全部返回 `"ok"` 且不抛错。
5. `notify tool swallows toast failures and warns once`：断言 warning 包含 `[notify-tool] failed to show toast`，同时返回 `"ok"`。
6. `notify tool validates schema boundaries`：使用 `@opencode-ai/plugin` 暴露的 schema 能力或等价测试 seam 验证空 `message` 拒绝、四个合法 `variant` 通过、非法 `variant` 拒绝。

### 插件入口测试

`test/plugin-entry.test.js` 至少覆盖：

1. 默认导出是可调用 OpenCode plugin。
2. `createNotifyPlugin()` 返回 hooks，且 `tool.notify.execute` 可调用。
3. 插件入口会使用 OpenCode runtime 注入的 `input.client`。
4. 显式传入 `createNotifyPlugin({ client })` 时，测试 seam client 优先于 runtime client。
5. `tool.definition` 只改写 `notify`，不触碰 `question`、`wait` 或任意其它工具。`notify` 的 description 必须匹配推荐文案：`Use for non-blocking progress and phase updates only; do not require immediate user response.`

### 当前 Copilot 包兼容测试

迁移清理后，当前仓库至少运行：

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npm run build
node --test --test-name-pattern "tool registry keeps notify outside the Copilot package|tool.definition leaves external notify tools untouched|LOOP_SAFETY_POLICY|Guided Loop Safety" test/plugin.test.js test/loop-safety-plugin.test.js
npm pack --dry-run --json
npm test
```

`npm pack --dry-run --json` 的输出必须额外确认当前 Copilot 包不包含 `dist/notify-tool.js` 或 `dist/notify-tool.d.ts`。如果 full `npm test` 因既有微信真实宿主 gate 或外部环境失败，必须记录失败测试名、命令输出中的具体错误和它与本次拆分的关系；不能把旧结果当 fresh 证据。

## 手工驱动 QA

发布前必须通过最小 driver 真实 import 构建产物并执行工具表面：

```powershell
npm run build
node --input-type=module -e "
const calls = [];
const mod = await import('./dist/index.js');
const hooks = await mod.createNotifyPlugin({ client: { tui: { showToast: async (options) => calls.push(options) } } })({});
const result = await hooks.tool.notify.execute({ message: 'driver progress', variant: 'success' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(JSON.stringify({ result, calls, hasDefault: typeof mod.default === 'function' }, null, 2));
"
```

预期：

- `result` 为 `"ok"`。
- `calls[0].body.message` 为 `"driver progress"`。
- `calls[0].body.variant` 为 `"success"`。
- `hasDefault` 为 `true`。

还必须驱动一次默认导出与 runtime-injected client 表面，避免只测 named factory：

```powershell
node --input-type=module -e "
const calls = [];
const mod = await import('./dist/index.js');
const hooks = await mod.default({ client: { tui: { showToast: async (options) => calls.push(options) } } });
const result = await hooks.tool.notify.execute({ message: 'default export progress' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(JSON.stringify({ result, calls }, null, 2));
"
```

预期：`result` 为 `"ok"`，`calls[0].body.message` 为 `"default export progress"`，`calls[0].body.variant` 为 `"info"`。

还必须驱动一次失败表面：

```powershell
node --input-type=module -e "
const mod = await import('./dist/index.js');
const hooks = await mod.createNotifyPlugin({ client: { tui: { showToast: async () => { throw new Error('toast failed') } } } })({});
const result = await hooks.tool.notify.execute({ message: 'still ok' }, { abort: new AbortController().signal, metadata() {}, async ask() {} });
console.log(result);
"
```

预期：命令退出码为 0，输出包含 `ok`，stderr 或 stdout 中可见 `[notify-tool] failed to show toast` warning。

## 发布流程

`opencode-notify-tool` 必须把发布流程写入新仓库 `docs/publishing.md`，并按该流程执行。该文件至少包含以下小节：`手动首发`、`发布前 fresh 验证`、`npm Trusted Publisher 设置与验证`、`后续 GitHub Actions 发布`、`GitHub Release 创建与验证`、`部分失败恢复`。其中必须写清楚：手动首发不能替代 GitHub Release，Trusted Publisher 配置后要独立验证，Release workflow 即使跳过已发布版本的 `Publish` step，Build/Test/Check version 也必须成功。

### 发布前 fresh 验证

手动首发前必须运行：

```powershell
npm test
npm pack --dry-run --json
npm view opencode-notify-tool version --json
```

预期：

- `npm test` 全部通过。
- `npm ls --omit=dev --depth=0 --json` 显示直接 runtime dependency 只有 `@opencode-ai/plugin`；不能直接依赖当前 Copilot 包、WeChat/OpenClaw、`fflate` 或 `@opencode-ai/sdk`。
- `npm pack --dry-run --json` 只包含 `LICENSE`、`README.md`、`dist/index.d.ts`、`dist/index.js`、`dist/notify-tool.d.ts`、`dist/notify-tool.js`、`package.json`。
- 首发前 `npm view opencode-notify-tool version --json` 返回 E404；如果已经存在，必须停止并确认版本策略。

### 手动 npm 首发

如果 `npm whoami` 出现任意认证失败或非零退出码（例如 `E401`、`ENEEDAUTH`），使用交互式 PTY 运行：

```powershell
npm login
```

用户完成浏览器登录和 2FA 后，验证：

```powershell
npm whoami
```

预期返回 `jiwangyihao`。

然后执行：

```powershell
npm publish --access public
```

如果 npm CLI 生成 2FA / web auth 链接，继续使用同一个 PTY 等待用户完成验证，不要因为需要 2FA 就停止整条发布链路。

发布后验证：

```powershell
npm view opencode-notify-tool version --json
npm view opencode-notify-tool dist-tags --json
npm view opencode-notify-tool repository.url --json
```

预期：

- version 返回 `"0.1.0"`。
- dist-tags 的 `latest` 为 `0.1.0`。
- repository.url 为 `git+https://github.com/jiwangyihao/opencode-notify-tool.git`。

### npm Trusted Publisher

手动首发后配置 Trusted Publisher。优先尝试 CLI：

```powershell
npx --yes npm@latest trust github opencode-notify-tool --file release.yml --repo jiwangyihao/opencode-notify-tool --yes
```

如果返回 `EOTP`，用 PTY 交互重跑同一命令，等待用户完成 2FA。配置成功后输出必须包含：

- `type: github`
- `repository: jiwangyihao/opencode-notify-tool`
- `file: release.yml`

随后独立验证远端 Trusted Publisher 状态：

```powershell
npx --yes npm@latest trust list opencode-notify-tool --json
```

预期输出中必须能对应到 GitHub provider、`jiwangyihao/opencode-notify-tool` 和 `release.yml`。如果当前 npm CLI 不支持 `trust list`，必须在 npmjs.com 包设置页确认同一组字段，并把确认方式记录在发布证据里。

如果 CLI 不可用，则在 npmjs.com 包设置中添加：

- Provider: GitHub Actions
- Organization or user: `jiwangyihao`
- Repository: `opencode-notify-tool`
- Workflow filename: `release.yml`
- Environment name: 留空

### GitHub Actions release workflow

新仓库 `.github/workflows/release.yml` 应采用与 `opencode-wait` 一致的结构：

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

如果后续 OIDC 认证失败，第一排查项是 npm Trusted Publisher 配置是否精确匹配 `release.yml`；第二排查项是 `NODE_AUTH_TOKEN: ""` 是否干扰 npm auth。如果证明确实干扰，应删除该 env 并重新触发 future release workflow。

### GitHub Release

新仓库必须包含 `docs/release-notes-template.md`。模板不使用 `latest` 或裸包名，结构固定为：

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

首发 release `v0.1.0` 正文必须使用明确版本号：

```bash
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

创建 release 前，把首发正文写入 `docs/release-notes-v0.1.0.md`，并随初始 release commit 推送到 `master`。随后运行：

```powershell
gh release create v0.1.0 --repo jiwangyihao/opencode-notify-tool --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md --latest
```

这里的 `--latest` 是 GitHub Release 的展示标记，不是安装命令里的 npm `latest` 版本引用；release 正文和 README 仍然必须使用 `opencode-notify-tool@0.1.0`。如果 GitHub API 出现 EOF 或 timeout，应等待后重试；不能只推 tag 就认为 release 完成。

Release 创建后验证：

```powershell
gh release view v0.1.0 --repo jiwangyihao/opencode-notify-tool --json tagName,publishedAt,isDraft,isPrerelease,body
gh run list --repo jiwangyihao/opencode-notify-tool --workflow Release --limit 5 --json databaseId,status,conclusion,event,headSha,displayTitle
$runId = gh run list --repo jiwangyihao/opencode-notify-tool --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --repo jiwangyihao/opencode-notify-tool --exit-status
gh run view $runId --repo jiwangyihao/opencode-notify-tool --json conclusion,jobs
```

预期：

- Release 已发布，非 draft，非 prerelease。
- Release body 包含 `## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`。
- `## 升级方式` 使用 `opencode-notify-tool@0.1.0`，不能使用 `latest`。
- Release workflow 对应本次 `v0.1.0` release event，`headSha` 与 release 目标提交一致，conclusion 为 `success`。
- 如果 `0.1.0` 已手动发布，workflow 中 `Publish` step skipped 是预期结果；Build/Test/Check version 必须成功。

## 迁移与组合文档

### `opencode-notify-tool` README

README 应采用中英双语，中文在前、英文镜像，内容包括：

1. `opencode-notify-tool` 提供 OpenCode `notify` tool。
2. 安装命令：`opencode plugin opencode-notify-tool@0.1.0 --force -g`。
3. 工具参数示例：

   ```json
   {
     "message": "Running verification",
     "variant": "info"
   }
   ```

4. `notify` 与 `question` 的边界：`notify` 是非阻塞进度，`question` 是需要用户响应的强交互。
5. 与 `opencode-wait` 的组合建议：等待交给 `opencode-wait`，进度交给 `opencode-notify-tool`。
6. 与未来 `opencode-loop-safety` 的组合建议：Loop Safety 可通过外部工具获得完整通道。

发布前必须用搜索验证 README 包含 `opencode plugin opencode-notify-tool@0.1.0 --force -g`，且不包含 `opencode-notify-tool@latest` 或裸包名安装命令。

### Copilot README

Copilot README 应把 `notify` 从“内置能力”改成“推荐组合插件”。中文和英文段落都要同步更新。

### 总体拆分文档

`docs/superpowers/specs/2026-05-04-opencode-j-super-suite-split-design.md` 已经把 `opencode-notify-tool` 列为第三阶段；本 spec 完成后，不需要修改总体文档的阶段顺序，除非实现中发现阶段边界需要变化。

## 实现计划阶段边界

后续实现计划应拆成 3 个阶段，而不是把所有工作塞进一个连续任务：

1. **独立包阶段：** 在 `C:\Users\34404\Documents\GitHub\opencode-notify-tool` 创建新仓库脚手架，按 TDD 迁移 `notify` 行为测试，实现 `src/notify-tool.ts` 与 `src/index.ts`，完成 README、发布文档、release workflow、`npm test`、`npm pack --dry-run --json` 和手工 driver。
2. **首发链路阶段：** 在独立仓库完成初始 commit、推送 GitHub、npm 手动首发、Trusted Publisher 配置与验证、GitHub Release `v0.1.0` 创建和 workflow run 验证。
3. **Copilot 回迁阶段：** 回到当前 Copilot 仓库删除内置 `notify`、更新 Loop Safety / README 边界口径，清理 `dist/` 后重建，运行 targeted tests、`npm pack --dry-run --json` 和 fresh `npm test`。

每个阶段都必须有独立验证证据；只有上一阶段完成后才能进入下一阶段。

## 成功标准

本拆分完成时必须同时满足以下条件：

1. `opencode-notify-tool` 新仓库存在并推送到 `jiwangyihao/opencode-notify-tool`。
2. `opencode-notify-tool@0.1.0` 已发布到 npm，`latest` 指向 `0.1.0`。
3. npm Trusted Publisher 已配置到 `jiwangyihao/opencode-notify-tool` + `release.yml`。
4. GitHub Release `v0.1.0` 已创建，并触发 Release workflow 成功。
5. `opencode-notify-tool` 的 `npm test`、`npm pack --dry-run --json` 和手工 driver 都有 fresh 证据。
6. 当前 Copilot 包不再注册 `notify` tool，也不再改写外部 `notify` definition。
7. 当前 Copilot 包的相关 targeted tests 与 fresh `npm test` 通过，或明确记录与本次拆分无关的既有失败。
8. README 与发布文档不再暗示 Copilot 包内置 `notify`。
9. release notes 使用明确版本号安装命令，且符合 `docs/release-notes-template.md` 结构。

## 风险与缓解

### 风险 1：Loop Safety 仍在 Copilot 包中，但 notify 被拆出

缓解：Loop Safety policy 明确把 `notify` 当作可选外部工具；缺失时纯进度静默继续，不自动升级成 `question`。Copilot README 明确建议需要完整双通道体验时安装 `opencode-notify-tool`。

### 风险 2：两个插件同时注册 `notify`

缓解：Copilot 包在迁移提交中删除本地 `tool.notify` 注册和 `notify` definition 改写。组合安装时只有 `opencode-notify-tool` 拥有 `notify`。

### 风险 3：发布链路只做了 npm publish，漏掉 GitHub Release 或 OIDC

缓解：把手动首发、Trusted Publisher、GitHub Release 和 workflow run 验证写入 `docs/publishing.md`，并把这四项列为成功标准。不能只用 npm publish 成功作为 release 完成证据。

### 风险 4：README 继续让用户以为 notify 属于 Copilot

缓解：Copilot README 中所有 `notify` 说明都要改成外部组合口径；`opencode-notify-tool` README 只讲自身，不把 Copilot 当成前置条件。

### 风险 5：过早扩张 notify 能力

缓解：v1 只保留 `message` 和 `variant`。任何 title、duration、通知历史、远程传输、微信通道都不进入首发。


