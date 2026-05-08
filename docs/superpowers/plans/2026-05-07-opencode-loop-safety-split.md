# OpenCode Loop Safety 独立插件拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按方案 C / Full extraction 将 Copilot 包内的 Guided Loop Safety 完整拆成独立插件 `opencode-loop-safety@0.1.0`，提供 server policy hook、真实 Ctrl+P 命令、独立 settings 与完整发布链路，并回迁清理 Copilot 包内的运行时残留。

**架构：** `opencode-loop-safety` 分为 server 入口与 TUI 入口：server 入口拥有固定 policy、system transform、compaction bypass、`question` definition 改写与 settings 读取；TUI 入口通过 `@opencode-ai/plugin/tui` 注册 `OpenCode J: Loop Safety` 和 `/loop-safety`。Copilot 包只删除 Loop Safety 归属，不抽共享库，不迁移 wait、notify、微信、账号或 retry 能力。

**技术栈：** TypeScript、Node.js 24、`@opencode-ai/plugin@^1.14.39`、`@opencode-ai/plugin/tui`、Node test runner、npm pack/install smoke、GitHub CLI、GitHub Actions OIDC。

---

## 文件结构预分解

- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\package.json`：新包元数据、`./tui` export、构建/测试脚本、发布白名单。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\policy.ts`：固定 policy、provider scope 判断、policy 追加纯函数。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\settings.ts`：新 settings 文件读写、legacy partial 合并、默认值规范化。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\compaction.ts`：当前 session 的 compaction bypass。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\hooks.ts`：system transform、compaction hook、`question` definition hook。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\tui-command.ts`：`OpenCode J: Loop Safety` command item 和设置菜单。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\index.ts`：server plugin default export 和 named exports。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\src\tui.ts`：TUI plugin 入口。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\test\*.test.js`：policy、settings、hooks、TUI command、文档、packaged import smoke。
- `C:\Users\34404\Documents\GitHub\opencode-loop-safety\README.md`、`docs\release-notes-template.md`、`docs\release-notes-v0.1.0.md`、`docs\publishing.md`、`.github\workflows\release.yml`：独立包文档与发布链路。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\loop-safety-plugin.ts`：回迁时删除。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\plugin-hooks.ts`：删除 Loop Safety imports、hooks、slash commands、forced inject marker、`question` definition 改写。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\common-settings-store.ts`、`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\common-settings-actions.ts`、`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\plugin.ts`、`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\providers\descriptor.ts`、`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\store.ts`、`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\src\ui\menu.ts`：移除 Loop Safety 字段、菜单和 capability，保留 network retry、slash commands、WeChat、status、compact、stop-tool、Synthetic Agent Initiator。
- `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\README.md`：删除 Copilot 内置 Loop Safety 文案，只保留独立插件安装建议。

## 全局执行约束

- 执行顺序固定为：独立包实现 → 独立包发布链路 → Copilot 回迁 → Copilot 回迁发布链路。
- 新包目录固定为 `C:\Users\34404\Documents\GitHub\opencode-loop-safety`；如果目录已存在且非空，先停止并审阅内容。
- Copilot 代码只在 worktree `C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration` 中修改。
- `0.1.0` 明确不实现 `/loop-safety-inject`，也不保留任何 inject marker。测试必须断言新包和 Copilot README 中都没有 `COPILOT_INJECT` 与 `OPENCODE_LOOP_SAFETY_INJECT`。
- `0.1.0` 使用 `@opencode-ai/plugin@^1.14.39`，因为该版本公开 `@opencode-ai/plugin/tui`、`TuiCommand.slash` 和 `api.command.register`。
- TUI slash 路径使用 command item 的 `slash: { name: "loop-safety" }`，不注册 server fallback `config.command["loop-safety"]`，避免双注册。
- 文档和 Release 正文里的插件安装命令必须逐字使用 `opencode plugin opencode-loop-safety@0.1.0 --force -g`。
- 所有新行为先写失败测试，再写最小实现。每个阶段完成后运行对应 fresh 验证。

## 任务 1：创建独立包骨架并写失败测试

**文件：**
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\package.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\tsconfig.json`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\test\policy.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\test\settings.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\test\plugin-entry.test.js`
- 创建：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\test\tui-command.test.js`

- [ ] **步骤 1：创建安全目标目录**

```powershell
$target = "C:\Users\34404\Documents\GitHub\opencode-loop-safety"
if (Test-Path -LiteralPath $target) {
  $items = Get-ChildItem -LiteralPath $target -Force
  if ($items.Count -gt 0) { throw "Target directory is not empty: $target" }
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}
New-Item -ItemType Directory -Force -Path "$target\src", "$target\test", "$target\docs", "$target\.github\workflows" | Out-Null
Set-Content -Path "$target\.gitignore" -Value "node_modules/`ndist/`n*.tgz`n" -NoNewline
```

预期：目录存在且为空；`.gitignore` 已忽略依赖、构建产物和 pack tarball。

- [ ] **步骤 2：写入 package 与 TypeScript 配置**

`package.json` 要点：`name` 为 `opencode-loop-safety`，`version` 为 `0.1.0`，`engines.node` 为 `>=24.0.0`，`dependencies` 只有 `@opencode-ai/plugin: ^1.14.39`，`files` 为 `dist/`、`README.md`、`LICENSE`，`exports` 必须包含：

```json
{
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./tui": {
    "types": "./dist/tui.d.ts",
    "import": "./dist/tui.js",
    "config": { "type": "tui" }
  }
}
```

`tsconfig.json` 使用 `target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`outDir: dist`、`rootDir: src`、`skipLibCheck: true`。`tsconfig.build.json` 继承它并关闭 sourcemap、declaration map。

- [ ] **步骤 3：写入 policy 与 plugin 失败测试**

`test/policy.test.js` 覆盖这些断言：

```js
import test from "node:test"
import assert from "node:assert/strict"
import { LOOP_SAFETY_POLICY, applyLoopSafetyPolicy, isCopilotProvider, shouldApplyLoopSafetyPolicy } from "../dist/index.js"

test("policy is fixed, generic, and has no inject markers", () => {
  assert.match(LOOP_SAFETY_POLICY, /^Guided Loop Safety Policy\n/)
  assert.match(LOOP_SAFETY_POLICY, /Final completion handoff remains a question event/)
  assert.equal(LOOP_SAFETY_POLICY.includes("COPILOT_INJECT"), false)
  assert.equal(LOOP_SAFETY_POLICY.includes("OPENCODE_LOOP_SAFETY_INJECT"), false)
})

test("policy appends once and default scope covers all models", () => {
  const once = applyLoopSafetyPolicy("base")
  assert.equal(applyLoopSafetyPolicy(once), once)
  assert.equal(shouldApplyLoopSafetyPolicy({ providerID: "openai" }, { loopSafetyEnabled: true, loopSafetyProviderScope: "all-models" }), true)
  assert.equal(shouldApplyLoopSafetyPolicy({ providerID: "openai" }, { loopSafetyEnabled: true, loopSafetyProviderScope: "copilot-only" }), false)
  assert.equal(isCopilotProvider("github-copilot-enterprise"), true)
})
```

`test/plugin-entry.test.js` 覆盖 default export、non-Copilot 默认注入、disabled 跳过、settings read fail-open、只改写 `question` definition。核心断言：

```js
const hooks = await createLoopSafetyPlugin({ readSettings: async () => ({ loopSafetyEnabled: true, loopSafetyProviderScope: "all-models" }) })({})
const output = { system: ["base"] }
await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1", model: { providerID: "openai", modelID: "gpt" } }, output)
assert.deepEqual(output.system, ["base", LOOP_SAFETY_POLICY])
```

- [ ] **步骤 4：写入 settings 与 TUI command 失败测试**

`test/settings.test.js` 覆盖新默认值、legacy partial 合并、写入只写新文件：

```js
assert.deepEqual(normalizeLoopSafetySettings({}), { loopSafetyEnabled: true, loopSafetyProviderScope: "all-models" })
```

Legacy 合并测试必须构造 4 个路径：`settingsPath`、`accountSwitcherSettingsPath`、`accountSwitcherCopilotPath`、`legacyCopilotPath`。当 common settings 写入 `{ loopSafetyEnabled: false }`、account-switcher Copilot store 写入 `{ loopSafetyProviderScope: "copilot-only" }` 时，最终结果必须是 `{ loopSafetyEnabled: false, loopSafetyProviderScope: "copilot-only" }`。

`test/tui-command.test.js` 覆盖：

```js
const command = createLoopSafetyCommand({ onSelect() {} })
assert.equal(command.title, "OpenCode J: Loop Safety")
assert.equal(command.value, "opencode-j.loop-safety.settings")
assert.equal(command.category, "OpenCode J")
assert.deepEqual(command.slash, { name: "loop-safety" })
```

- [ ] **步骤 5：确认测试先失败**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-loop-safety"
npm install
npm test
```

预期：`npm install` 成功；`npm test` 失败，原因是 `src/*.ts` 尚未实现或 `dist/` 缺少导出，而不是测试语法错误。

## 任务 2：实现 policy、settings、compaction 和 server hooks

**文件：**
- 创建：`src\policy.ts`
- 创建：`src\settings.ts`
- 创建：`src\compaction.ts`
- 创建：`src\hooks.ts`
- 创建：`src\index.ts`

- [ ] **步骤 1：写入固定 policy 与 scope 纯函数**

`src/policy.ts` 必须导出 `LoopSafetyProviderScope`、`LoopSafetySettings`、`LOOP_SAFETY_POLICY`、`isCopilotProvider()`、`shouldApplyLoopSafetyPolicy()`、`applyLoopSafetyPolicy()`。固定 policy 不包含任何 marker，并以这段开头和结尾：

```ts
export const LOOP_SAFETY_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- User-facing interactions must use only question or notify tools; never emit ordinary assistant plain text.
- Pure progress, phase switches, and non-blocking background status updates belong to notify.
- Required user responses, user decisions or confirmations, final handoff, and no-safe-work-left states belong to question.
- All waiting that does not require user confirmation, including background waits for long-running tools, external jobs, cooldowns, or expected notifications, belongs to a dedicated wait tool when available.
- If uncertain whether user input is required, default to question; if the only need is time passing or waiting for an expected non-user event, default to a wait tool when available.
- If notify is unavailable, denied, absent, or fails, pure progress stays silent and work continues; do not automatically escalate that progress into question.
- If question is unavailable, denied, or absent, only strong-interaction content may fall back to direct assistant text.
- Tool availability does not change the interaction class of the content itself.
- If the user says the reporting behavior was wrong, first check whether content was assigned to the wrong interaction class or sent through the wrong channel.
- Final completion handoff remains a question event, while unattended waits remain wait events.`
```

`applyLoopSafetyPolicy(system)` 在字符串已包含完整 policy 时返回原值，否则追加一个空行和完整 policy。`shouldApplyLoopSafetyPolicy()` 在 disabled 时返回 `false`，在 `all-models` 时返回 `true`，在 `copilot-only` 时只识别 `github-copilot` 与 `github-copilot-enterprise`。

- [ ] **步骤 2：实现 settings partial 合并**

`src/settings.ts` 必须导出：

```ts
export type PartialLoopSafetySettings = {
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
}

export function normalizeLoopSafetySettings(partial: PartialLoopSafetySettings): LoopSafetySettings {
  return {
    loopSafetyEnabled: partial.loopSafetyEnabled ?? true,
    loopSafetyProviderScope: partial.loopSafetyProviderScope ?? "all-models",
  }
}
```

`readLoopSafetySettings()` 按新文件、account-switcher common settings、account-switcher Copilot store、根 legacy Copilot store 的顺序合并。每个字段只有缺失时才读下一层；读取 legacy 文件时先解析 partial 字段，不复用任何会提前默认化缺失字段的 parser。`writeLoopSafetySettings()` 只写新 settings 文件，并先创建父目录。

- [ ] **步骤 3：实现 compaction bypass 与 server hooks**

`src/compaction.ts` 创建 `Set<string>` 记录正在 compaction 的 session；`hook(input)` 记录 `input.sessionID`；`isBypassed(sessionID)` 只在当前 session 命中时返回 `true`。

`src/hooks.ts` 创建 `createLoopSafetySystemTransform(readSettings, isBypassed)`：settings 读取失败时用 `{ loopSafetyEnabled: true, loopSafetyProviderScope: "all-models" }` fail-open；bypass 命中时不追加；否则对 `output.system` 的最后一个或独立数组项追加 policy。`QUESTION_TOOL_DESCRIPTION` 固定说明 `question` 只负责强交互、最终交接、无安全工作可继续或不确定路由。

`src/index.ts` 用 `createLoopSafetyPlugin()` 组合 server hooks，default export 是 callable OpenCode plugin。

- [ ] **步骤 4：运行 server 相关测试转绿**

```powershell
npm run build
node --test test/policy.test.js test/settings.test.js test/plugin-entry.test.js
npm run typecheck
```

预期：三类测试和 typecheck 退出码为 0；policy 字符串不包含 inject marker。

## 任务 3：实现真实 TUI command 与 `/loop-safety`

**文件：**
- 创建：`src\tui-command.ts`
- 创建：`src\tui.ts`
- 修改：`test\tui-command.test.js`

- [ ] **步骤 1：确认 TUI command 测试仍为红灯**

```powershell
npm run build
node --test test/tui-command.test.js
```

预期：失败原因是 `dist/tui-command.js` 或 `dist/tui.js` 尚未实现。

- [ ] **步骤 2：写入 TUI command 工厂**

`src/tui-command.ts` 导出 `LOOP_SAFETY_COMMAND_TITLE = "OpenCode J: Loop Safety"`、`LOOP_SAFETY_COMMAND_VALUE = "opencode-j.loop-safety.settings"`、`LOOP_SAFETY_COMMAND_CATEGORY = "OpenCode J"`，并实现：

```ts
export function createLoopSafetyCommand(input: { onSelect: () => void }): TuiCommand {
  return {
    title: LOOP_SAFETY_COMMAND_TITLE,
    value: LOOP_SAFETY_COMMAND_VALUE,
    category: LOOP_SAFETY_COMMAND_CATEGORY,
    slash: { name: "loop-safety" },
    onSelect: input.onSelect,
  }
}
```

`showLoopSafetySettings(api)` 用 `api.ui.dialog.replace` 包裹 `api.ui.DialogSelect` 展示三类选项：开关状态、provider scope、推荐安装 `opencode-wait@0.1.0` 与 `opencode-notify-tool@0.1.0`。切换后调用 `writeLoopSafetySettings()` 并用 `api.ui.toast()` 回报成功。

- [ ] **步骤 3：写入 TUI plugin 入口**

`src/tui.ts`：

```ts
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createLoopSafetyCommand, showLoopSafetySettings } from "./tui-command.js"

export const LoopSafetyTuiPlugin: TuiPlugin = async (api) => {
  api.command.register(() => [
    createLoopSafetyCommand({ onSelect: () => { void showLoopSafetySettings(api) } }),
  ])
}

export default LoopSafetyTuiPlugin
```

- [ ] **步骤 4：运行 TUI tests 转绿**

```powershell
npm run build
node --test test/tui-command.test.js
npm run typecheck
```

预期：命令注册测试通过；`./tui` build 产物存在；typecheck 退出码为 0。

## 任务 4：补齐独立包文档、发布模板和 packaged smoke

**文件：**
- 创建：`README.md`
- 创建：`docs\release-notes-template.md`
- 创建：`docs\release-notes-v0.1.0.md`
- 创建：`docs\publishing.md`
- 创建：`.github\workflows\release.yml`
- 创建：`LICENSE`
- 创建：`test\docs.test.js`
- 创建：`test\package-smoke.test.js`

- [ ] **步骤 1：先写文档与 pack 失败测试**

`test/docs.test.js` 检查 `README.md`、`docs/release-notes-template.md`、`docs/release-notes-v0.1.0.md`：都包含 `opencode plugin opencode-loop-safety@0.1.0 --force -g`，都不包含裸包安装命令、`COPILOT_INJECT`、`OPENCODE_LOOP_SAFETY_INJECT`；release notes 文件必须包含 `## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`。

`test/package-smoke.test.js` 执行 `npm pack --json`，在临时项目中 `npm install <tarball>`，然后运行：

```js
const server = await import("opencode-loop-safety")
const tui = await import("opencode-loop-safety/tui")
console.log(JSON.stringify({ server: typeof server.default, tui: typeof tui.default }))
```

预期后续转绿时输出 `{ "server": "function", "tui": "function" }`。

- [ ] **步骤 2：写入 README 和 release notes**

README 中文在前、英文镜像。中文段落必须包含：独立插件用途、安装命令、Ctrl+P 入口 `OpenCode J: Loop Safety`、slash 入口 `/loop-safety`、默认开启、默认 `all-models`、不提供 `wait` / `notify`、推荐组合：

```bash
opencode plugin opencode-wait@0.1.0 --force -g
opencode plugin opencode-notify-tool@0.1.0 --force -g
opencode plugin opencode-loop-safety@0.1.0 --force -g
```

Release notes 模板和 `v0.1.0` 正文必须包含一句价值导语、`## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`，并使用同一条安装命令。

- [ ] **步骤 3：写入 publishing 文档与 workflow**

`docs/publishing.md` 必须包含 fresh 验证、npm publish、Trusted Publisher、GitHub Release、远端状态确认。关键命令：

```powershell
npm test
npm pack --dry-run --json
npm view opencode-loop-safety@0.1.0 version --json
npm publish --access public
npm exec --package npm@11 -- npm trust github opencode-loop-safety --file release.yml --repo jiwangyihao/opencode-loop-safety --yes
npm exec --package npm@11 -- npm trust list opencode-loop-safety --json
gh release create v0.1.0 --repo jiwangyihao/opencode-loop-safety --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
```

`.github/workflows/release.yml` 使用 `release.published` 触发、Node 24、`npm ci`、`npm run build`、`npm run test:built`、检查当前 package version 是否已发布，未发布时执行 `npm publish --access public`。

- [ ] **步骤 4：运行文档与 pack smoke 转绿**

```powershell
npm test
npm pack --dry-run --json
```

预期：全部测试通过；pack 文件只包含 `LICENSE`、`README.md`、`dist/*.js`、`dist/*.d.ts` 和 `package.json`；pack smoke 能从包根 import server 与 TUI surface。

## 任务 5：独立包 fresh 验证、手工驱动和发布链路

**文件：**
- 验证：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\dist\index.js`
- 验证：`C:\Users\34404\Documents\GitHub\opencode-loop-safety\dist\tui.js`
- 操作：GitHub repo `jiwangyihao/opencode-loop-safety`
- 操作：npm package `opencode-loop-safety@0.1.0`

- [ ] **步骤 1：运行 fresh 验证**

```powershell
npm test
npm run typecheck
npm pack --dry-run --json
npm view opencode-loop-safety@0.1.0 version --json
```

预期：测试和 typecheck 退出码为 0；pack 文件清单符合白名单；`npm view` 首发前找不到 `0.1.0`。如果版本已存在，停止并交给主代理判断版本策略。

- [ ] **步骤 2：驱动 server hook surface**

```powershell
node --input-type=module -e "
const mod = await import('./dist/index.js');
const hooks = await mod.createLoopSafetyPlugin({ readSettings: async () => ({ loopSafetyEnabled: true, loopSafetyProviderScope: 'all-models' }) })({});
const output = { system: ['base'] };
await hooks['experimental.chat.system.transform']({ sessionID: 's1', model: { providerID: 'openai', modelID: 'gpt' } }, output);
const question = { description: 'old', parameters: {} };
await hooks['tool.definition']({ toolID: 'question' }, question);
console.log(JSON.stringify({ appended: output.system.at(-1).includes('Guided Loop Safety Policy'), question: /required user response/.test(question.description) }, null, 2));
"
```

预期：输出 JSON 中 `appended` 与 `question` 都为 `true`。

- [ ] **步骤 3：驱动 TUI command surface**

```powershell
node --input-type=module -e "
const mod = await import('./dist/tui.js');
const registrations = [];
await mod.default({ command: { register: (cb) => { registrations.push(cb); return () => {} } }, ui: { dialog: { replace() {} }, DialogSelect: (props) => props, toast() {} } }, undefined, { id: 'opencode-loop-safety' });
const items = registrations.flatMap((cb) => cb());
console.log(JSON.stringify(items.map((item) => ({ title: item.title, value: item.value, category: item.category, slash: item.slash })), null, 2));
"
```

预期：输出唯一 command，`title` 为 `OpenCode J: Loop Safety`，`value` 为 `opencode-j.loop-safety.settings`，`category` 为 `OpenCode J`，`slash.name` 为 `loop-safety`。

- [ ] **步骤 4：完成新仓库、npm、Trusted Publisher 和 GitHub Release**

```powershell
$env:GIT_MASTER = "1"
git init
git branch -M master
git add .
git commit -m "feat(loop-safety): 初始化独立交互策略插件"
gh repo create jiwangyihao/opencode-loop-safety --public --source . --remote origin --push
npm whoami
npm publish --access public
npm view opencode-loop-safety@0.1.0 version --json
npm exec --package npm@11 -- npm trust github opencode-loop-safety --file release.yml --repo jiwangyihao/opencode-loop-safety --yes
npm exec --package npm@11 -- npm trust list opencode-loop-safety --json
gh release create v0.1.0 --repo jiwangyihao/opencode-loop-safety --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
gh release view v0.1.0 --repo jiwangyihao/opencode-loop-safety --json tagName,publishedAt,isDraft,isPrerelease,body
```

预期：npm 远端 version 返回 `"0.1.0"`；Trusted Publisher 列表指向 `jiwangyihao/opencode-loop-safety` 和 `release.yml`；GitHub Release 已发布、非 draft、非 prerelease，正文包含三个必需章节和明确版本号安装命令。

## 任务 6：在 Copilot worktree 先写回迁失败测试

**文件：**
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\plugin.test.js`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\menu.test.js`
- 修改：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\test\common-settings-store.test.js`

- [ ] **步骤 1：新增 hook 归属边界测试**

在 `test/plugin.test.js` 新增：

```js
test("copilot package no longer owns Loop Safety hooks", async () => {
  const plugin = buildPluginHooks({ auth: { provider: "github-copilot", methods: [] }, loadStore: async () => ({ accounts: {} }), client: {} })
  assert.equal(Object.hasOwn(plugin, "experimental.chat.system.transform"), false)
  assert.equal(Object.hasOwn(plugin, "experimental.session.compacting"), false)
})

test("copilot package leaves question definition untouched", async () => {
  const plugin = buildPluginHooks({ auth: { provider: "github-copilot", methods: [] }, loadStore: async () => ({ accounts: {} }), client: {} })
  const output = { description: "original question", parameters: {}, extra: "keep" }
  await plugin["tool.definition"]?.({ toolID: "question" }, output)
  assert.deepEqual(output, { description: "original question", parameters: {}, extra: "keep" })
})

test("copilot slash commands exclude old Loop Safety commands", async () => {
  const config = { command: {} }
  const plugin = buildPluginHooks({ auth: { provider: "github-copilot", methods: [] }, loadStore: async () => ({ accounts: {} }) })
  await plugin.config?.(config)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-status"), true)
  assert.equal(Object.hasOwn(config.command, "copilot-compact"), true)
  assert.equal(Object.hasOwn(config.command, "copilot-stop-tool"), true)
})
```

- [ ] **步骤 2：新增 menu、settings、descriptor 边界测试**

`test/menu.test.js` 把旧 Loop Safety 菜单测试替换为：

```js
test("buildMenuItems no longer renders Loop Safety rows", () => {
  const items = buildMenuItems({ locale: "en", capabilities: { loopSafety: false, policyScope: false, networkRetry: true }, networkRetryEnabled: true })
  const labels = items.map((item) => item.label).join("\n")
  assert.equal(/Guided Loop Safety|Policy Scope|copilot-inject|copilot-policy-all-models/.test(labels), false)
})
```

`test/common-settings-store.test.js` 新增或改写为：

```js
test("common settings preserve retry and WeChat fields without Loop Safety fields", async () => {
  const settings = normalizeCommonSettings({
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
    wechat: { notifications: { enabled: true, question: true, permission: false, sessionError: true } },
  })
  assert.equal(Object.hasOwn(settings, "loopSafetyEnabled"), false)
  assert.equal(Object.hasOwn(settings, "loopSafetyProviderScope"), false)
  assert.equal(settings.networkRetryEnabled, true)
  assert.equal(settings.experimentalSlashCommandsEnabled, true)
  assert.equal(settings.wechat.notifications.permission, false)
})
```

`test/plugin.test.js` provider descriptor 断言改为：Copilot commands 不含 `copilot-inject`、`copilot-policy-all-models`，menu entries 不含 `toggle-loop-safety`，capabilities 不含 `loop-safety`，但仍包含 auth、chat-headers、model-routing、network-retry、slash-commands。

- [ ] **步骤 3：运行回迁红灯验证**

```powershell
Set-Location "C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration"
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npm run build
node --test --test-concurrency=1 --test-name-pattern "no longer owns Loop Safety|leaves question definition|exclude old Loop Safety|no longer renders Loop Safety|without Loop Safety fields|provider descriptor" test/plugin.test.js test/menu.test.js test/common-settings-store.test.js
```

预期：测试失败，原因是 Copilot 包仍有 Loop Safety hooks、commands、menu rows、common settings 字段或 provider capability。

## 任务 7：清理 Copilot 包实现与文档残留

**文件：**
- 删除：`src\loop-safety-plugin.ts`
- 修改：`src\plugin-hooks.ts`
- 修改：`src\common-settings-actions.ts`
- 修改：`src\common-settings-store.ts`
- 修改：`src\plugin.ts`
- 修改：`src\providers\descriptor.ts`
- 修改：`src\store.ts`
- 修改：`src\ui\menu.ts`
- 修改：`README.md`
- 修改：`test\*.test.js`

- [ ] **步骤 1：删除 runtime ownership**

```powershell
Remove-Item "src\loop-safety-plugin.ts"
```

从 `src/plugin-hooks.ts` 删除这些内容：`createCompactionLoopSafetyBypass`、`createLoopSafetySystemTransform`、`getLoopSafetyProviderScope`、`policyScopeOverride`、`injectArmed`、`copilot-inject`、`copilot-policy-all-models`、`COPILOT_INJECT_V1_BEGIN`、`COPILOT_INJECT_V1_END`。返回 hooks 时不再包含 `experimental.chat.system.transform`、`experimental.session.compacting`，`tool.definition` 不再处理 `question`。

- [ ] **步骤 2：删除 settings 和 menu 归属**

从 `src/common-settings-actions.ts` 删除 `toggle-loop-safety`、`toggle-loop-safety-provider-scope` 和对应分支。`toggle-experimental-slash-commands`、`toggle-network-retry` 和所有 WeChat action 保留。

从 `src/common-settings-store.ts`、`src/store.ts` 删除 `loopSafetyEnabled` 与 `loopSafetyProviderScope` 类型、默认化、snapshot 输出和写入字段。读取旧文件时可以忽略这两个字段，但不得把它们写回 Copilot-owned store。

从 `src/ui/menu.ts` 删除 `loopSafety`、`policyScope` capabilities、Loop Safety 文案、policy scope row 和旧 experimental slash hint 中的 `/copilot-inject`、`/copilot-policy-all-models`。

- [ ] **步骤 3：删除 descriptor 和 plugin menu 接线**

从 `src/providers/descriptor.ts` 删除 `loop-safety` capability，删除 `copilot-inject`、`copilot-policy-all-models`、`toggle-loop-safety`。从 `src/plugin.ts` 删除传给 Copilot / Codex menu 的 `loopSafetyEnabled`、`loopSafetyProviderScope` props，只保留账号、network retry、slash command、WeChat 相关 props。

- [ ] **步骤 4：更新 README 为独立插件安装建议**

删除 README 中把 Guided Loop Safety 描述为 Copilot 内置能力的段落、`/copilot-inject` 小节和旧 marker 示例。新增中文与英文安装建议：

````markdown
## 与 `opencode-loop-safety` 配合

Guided Loop Safety 已拆为独立插件。如果你需要通用交互路由策略，请单独安装：

```bash
opencode plugin opencode-loop-safety@0.1.0 --force -g
```

Copilot 插件继续聚焦账号、配额、模型路由、network retry、status、compact 与 stop-tool。
````

- [ ] **步骤 5：运行定向测试转绿**

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npm run build
node --test --test-concurrency=1 --test-name-pattern "no longer owns Loop Safety|leaves question definition|exclude old Loop Safety|no longer renders Loop Safety|without Loop Safety fields|provider descriptor" test/plugin.test.js test/menu.test.js test/common-settings-store.test.js
```

预期：定向测试退出码为 0；Copilot status、compact、stop-tool 仍注册；network retry、slash command 和 WeChat settings 测试仍通过。

## 任务 8：Copilot 回迁 fresh 验证、表面 QA 和发布链路

**文件：**
- 验证：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\dist\internal.js`
- 验证：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\.worktrees\opencode-notify-tool-copilot-migration\README.md`

- [ ] **步骤 1：搜索残留**

```powershell
rg -n "COPILOT_INJECT|OPENCODE_LOOP_SAFETY_INJECT|/copilot-inject|/copilot-policy-all-models|Guided Loop Safety 开关|Guided Loop Safety toggle" README.md src test
rg -n "opencode plugin opencode-loop-safety@0.1.0 --force -g" README.md
```

预期：第一条命令无输出；第二条命中中文和英文独立插件安装建议。

- [ ] **步骤 2：驱动 Copilot hook surface**

```powershell
node --input-type=module -e "
const mod = await import('./dist/internal.js');
const hooks = mod.buildPluginHooks({ auth: { provider: 'github-copilot', methods: [] }, loadStore: async () => ({ accounts: {} }), client: {} });
const question = { description: 'original question', parameters: {} };
await hooks['tool.definition']?.({ toolID: 'question' }, question);
console.log(JSON.stringify({ hasSystem: Object.hasOwn(hooks, 'experimental.chat.system.transform'), hasCompacting: Object.hasOwn(hooks, 'experimental.session.compacting'), question: question.description }, null, 2));
"
```

预期：`hasSystem` 和 `hasCompacting` 为 `false`；`question` 保持 `original question`。

- [ ] **步骤 3：运行 fresh 自动化验证**

```powershell
npm test
npm run typecheck
npm pack --dry-run --json
```

预期：`npm test` 和 typecheck 退出码为 0；pack 文件不包含 `loop-safety-plugin`。如果 Windows real-host PTY smoke 继续因 `@lydell/node-pty-win32-x64` / `AttachConsole failed` 失败，记录为既有 Windows 宿主环境问题，并保留这次 fresh 输出。

- [ ] **步骤 4：Copilot 回迁 release 链路**

若用户要求发布 Copilot 回迁版本，按仓库 release 护栏执行：版本 bump、release commit、tag、push、`npm publish`、GitHub Release 是同一条链路。Release 正文必须来自 `docs/release-notes-template.md`，并包含明确版本号安装命令。

远端确认命令：

```powershell
npm view opencode-copilot-account-switcher version --json
gh release view <version-tag> --repo jiwangyihao/opencode-copilot-account-switcher --json tagName,publishedAt,isDraft,isPrerelease,body
```

预期：npm 远端 version 与发布版本一致；GitHub Release 已发布、非 draft、非 prerelease；正文包含 `## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`。

## 自检清单

- [ ] 每个 spec 目标都映射到一个任务：独立包、policy、settings、TUI command、legacy merge、Copilot cleanup、README、Release、pack smoke、manual QA。
- [ ] 计划明确决定不实现 `/loop-safety-inject`，且新包与 Copilot 回迁都有 marker 残留测试。
- [ ] TUI 使用 `@opencode-ai/plugin/tui` 的 `api.command.register` 和 `slash: { name: "loop-safety" }`，没有 server fallback 双注册。
- [ ] Legacy 读取顺序是新 settings、account-switcher common settings、account-switcher Copilot store、根 legacy Copilot store。
- [ ] Copilot 回迁只删除 Loop Safety 字段，保留 network retry、slash command、WeChat、status、compact、stop-tool、Synthetic Agent Initiator。
- [ ] 所有插件安装命令都带 `opencode-loop-safety@0.1.0` 明确版本。
- [ ] 独立包和 Copilot 包都有 fresh `npm test`、typecheck、pack/driver 表面验证。

## 执行选项

计划已完成并保存到 `docs/superpowers/plans/2026-05-07-opencode-loop-safety-split.md`。两种执行方式：

1. 子代理驱动（推荐）：每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行：在当前会话中使用 superpowers:executing-plans 执行任务，批量执行并设有检查点。
