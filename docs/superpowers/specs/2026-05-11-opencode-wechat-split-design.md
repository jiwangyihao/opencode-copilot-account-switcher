# opencode-wechat 全量复制拆分设计

## 背景

`opencode-copilot-account-switcher` 已经完成 `wait`、`notify`、Loop Safety 与 OpenAI / Codex 账号切换能力的独立化。当前 root 包仍保留一整套微信远程交互能力：broker / bridge、微信绑定、`/status`、`/todo`、`/reply`、`/allow`、`/recover`、question / permission / natural-stop 通知、terminal result、debug bundle 以及 OpenClaw compat / smoke。

这些能力已经不属于 GitHub Copilot 账号切换领域。继续留在 Copilot 包中会带来 4 个问题：

1. Copilot 包继续携带微信依赖、OpenClaw smoke 脚本和大量 `test/wechat-*`，导致 root 验证、发布和包体都被微信链路牵制。
2. 微信 broker / bridge 本质上是通用远程通知与交互通道，不应该依赖 Copilot 菜单或 Copilot auth provider 才能被用户发现。
3. 后续 Codex、Loop Safety 或其它 OpenCode 插件如果要接入微信，只能通过公开协议或显式 adapter，而不能穿透 Copilot 包内部实现。
4. 目前微信代码量大、测试复杂，继续从 root 中按文件挑拣容易遗漏运行时边界和发布任务。

用户已确认采用不同路径：**新 `opencode-wechat` 仓库先直接全量复制当前 root 仓库，再在新仓库中剥离 Copilot 相关代码；同时在 Copilot 仓库中剥离微信相关代码，最终形成双向拆分。**

## 已确认决策

1. 新包名使用 `opencode-wechat`，首发版本为 `0.1.0`。
2. 新仓库路径使用 `C:\Users\34404\Documents\GitHub\opencode-wechat`。
3. 新仓库初始内容先从当前 `opencode-copilot-account-switcher` 主工作区全量复制，不从零挑文件拼装。
4. 在 `opencode-wechat` 中剥离 Copilot 账号、routing、quota、retry、status、model-account、upstream snapshot 与 Copilot auth menu。
5. 在 root `opencode-copilot-account-switcher` 中剥离微信 broker / bridge、绑定、通知、slash、debug bundle、OpenClaw compat、微信 settings、微信菜单和微信测试。
6. `opencode-wechat` 首发必须包含完整发布任务：fresh 验证、pack / tarball smoke、真实 surface driver、初始 commit、GitHub repo、npm publish、Trusted Publisher、tag、GitHub Release 和远端状态验证。
7. Root Copilot 包本轮只做回迁提交，不随 `opencode-wechat@0.1.0` 首发发布，除非后续另有明确授权。
8. 不推送非主分支；root 回迁在主工作区 `master` 上执行。
9. 发布外部动作（GitHub repo、npm publish、tag push、GitHub Release）执行前必须再次确认授权。

## 目标

1. 创建可独立安装、构建、测试、打包和发布的 `opencode-wechat@0.1.0`。
2. 新包保留当前微信用户能力：绑定、通知、`/status`、`/todo`、`/reply`、`/allow`、`/recover`、natural-stop、terminal result、retry-error、debug bundle 和 OpenClaw smoke。
3. 新包提供独立 OpenCode 插件入口，不依赖 Copilot auth provider 或 Copilot 账号菜单。
4. 新包从全量复制基线中删除 Copilot-only 源码、测试、README、依赖和发布语义。
5. Root Copilot 包删除所有微信运行时代码、菜单、settings、依赖、脚本、测试和 pack 产物。
6. 两个包都增加边界测试，防止拆分后旧产物进入 `dist/` 或 `npm pack` 清单。
7. 迁移用户已有微信配置和状态，不要求用户手工清理状态目录。

## 非目标

1. 不重新设计微信 broker / bridge 协议或用户文案合同；本轮目标是拆分归属，不是再次改 WS 模型。
2. 不把 Copilot 账号、quota、routing、Copilot Network Retry、Synthetic Agent Initiator 或 Copilot status 移入 `opencode-wechat`。
3. 不把 Codex / OpenAI 账号切换能力移入 `opencode-wechat`。
4. 不在本轮创建共享库。
5. 不让 `opencode-wechat` 依赖 root Copilot 包。
6. 不让 root Copilot 包依赖 `opencode-wechat` 才能完成 Copilot 账号切换。
7. 不在 `opencode-wechat@0.1.0` 中承诺非微信远程通道，例如 Telegram、飞书或邮件。

## 用户可见行为

### `opencode-wechat`

安装 `opencode-wechat@0.1.0` 后，用户获得独立微信远程交互插件：

1. 插件启动后负责连接或拉起用户级微信 broker，并在 bridge-capable OpenCode 会话中启动 bridge lifecycle。
2. 微信侧保留 `/status`、`/todo`、`/reply <qid>`、`/allow <handle> once|always|reject`、`/reply <s*>` 和 `/recover` 等现有 slash 语义；`/recover` 属于本轮必保留合同。
3. 通知继续覆盖 question、permission、terminal result、natural-stop、retry-error 这 5 类用户可见场景；文档、测试和 UI 文案统一使用 `retry-error`，不再混用 `retry / error`。
4. 绑定、重绑、通知开关和 debug bundle 不再藏在 Copilot 账号菜单里，而由新插件的独立入口承载。
5. README 与 GitHub Release 给出明确版本号安装命令：

   ```bash
   opencode plugin opencode-wechat@0.1.0 --force -g
   ```

6. OpenClaw compat / smoke 仍作为微信插件自己的验证工具保留，包括 dry-run、guided smoke 和真实宿主 gate。

### Root `opencode-copilot-account-switcher`

回迁后的 Copilot 包表现为 Copilot 专属插件：

1. 继续提供 Copilot 多账号、quota、模型账号组、routing、Copilot Network Retry、Copilot status、compact、stop-tool 和 Synthetic Agent Initiator。
2. 不再启动 WeChat broker，不再注册微信 bridge lifecycle。
3. Copilot 菜单不再显示微信通知、绑定、重绑或 debug bundle。
4. `package.json` 不再包含 `wechat:*`、`test:serial:wechat-*`、`test:wechat-real-host-gate` 或 OpenClaw 依赖。
5. README 中微信功能章节改为独立插件安装说明，不再宣称 Copilot 包内置微信能力。

## 全量复制拆分策略

### 阶段 1：复制 root 为新仓库基线

实施阶段先确认 root 工作区 clean，再把当前 root 工作区复制到：

```text
C:\Users\34404\Documents\GitHub\opencode-wechat
```

复制时必须排除：

```text
.git/
node_modules/
dist/
.worktrees/
*.tgz
tmp/
```

复制完成后，新目录暂时不是当前 root 的 worktree。它会独立 `git init`，独立创建 `jiwangyihao/opencode-wechat` 远端。

采用全量复制的原因是：当前微信链路跨越 `plugin.ts`、`plugin-hooks.ts`、settings、menu、测试、OpenClaw compat 和 README。先复制再剥离，可以让新包保留完整微信上下文，再通过负向测试删除 Copilot 残留。

### 阶段 2：在 `opencode-wechat` 中剥离 Copilot

新仓库删除或重写 Copilot-only 内容：

1. 删除 Copilot 账号 store、quota、model routing、Copilot retry、Copilot status、session-control command、upstream Copilot snapshot 与 provider registry。
2. 删除 `src/providers/copilot-menu-adapter.ts`，替换为微信设置入口。
3. 删除或重写 `src/providers/descriptor.ts` 与 `src/providers/registry.ts`，新包不得保留 `COPILOT_PROVIDER_DESCRIPTOR` 或 GitHub Copilot provider registry。
4. 删除或重写 `src/menu-runtime.ts` 和 `src/plugin-actions.ts`；如果保留任一共享文件，必须在实现计划中说明它只承载 WeChat-only action，并用 source / dist / pack 负向测试锁住边界。
5. 重写 `src/plugin.ts`，只导出独立微信插件入口。
6. 重写 `src/plugin-hooks.ts`，只保留微信 broker / bridge lifecycle、TUI command、settings 和必要 OpenCode client seam。
7. 删除所有非微信测试，只保留 `test/wechat-*`、`test/ui-menu-wechat.test.js` 以及新包边界测试。
8. 删除 README 中 Copilot 账号、quota、routing、retry 与模型相关内容。
9. `package.json` 改名为 `opencode-wechat`，只保留微信需要的 dependencies。
10. 重新生成 `package-lock.json`，确保锁文件顶层 `name`、`version` 和依赖图与 `opencode-wechat@0.1.0` 一致，不保留 root 包名或 Copilot-only 依赖。
11. 保留 `prebuild` 清理 `dist/`，并让 pack 验证在清理后的构建产物上执行，防止全量复制遗留旧 `dist`。

### 阶段 3：在 root 中剥离微信

Root 包执行相反方向的剥离：

1. 删除 `src/wechat/**`。
2. 从 `src/plugin.ts` 删除 `connectOrSpawnBroker()`、broker startup diagnostics、微信 broker promise、微信 provider actions 和 debug bundle 输出处理。
3. 从 `src/plugin-hooks.ts` 删除 `createWechatBridgeLifecycle()`、bridge global state、bridge-capable detection、TUI event/session tracking 和所有微信 bridge lifecycle 接线。
4. 从 `src/ui/menu.ts` 删除微信 submenu、微信 action、微信 copy、`readOperatorBinding()` import 和 `wechatNotificationsMenu` capability。
5. 从 `src/menu-runtime.ts` 删除 `wechat-*` provider action 的 non-persistent 特例和其它微信 action 语义。
6. 从 `src/common-settings-store.ts` 与 `src/common-settings-actions.ts` 删除微信 settings、binding、通知开关和 legacy flat 字段。
7. 从 `src/store-paths.ts` 删除 `wechatConfigDir()`；如 root 已无 Codex 引用，也不借本轮顺手改 Codex 路径。
8. 从 `src/providers/copilot-menu-adapter.ts` 删除微信 bind / rebind / debug bundle action 分支。
9. 从 `package.json` 删除 `wechat:*`、`test:serial:wechat-*`、`test:wechat-real-host-gate`、OpenClaw 依赖和所有 `test/wechat-*` 分片，并重写 `test` / `test:parallel:shard` 为 Copilot-only 测试入口。
10. 重新生成 root `package-lock.json`，确保 OpenClaw / WeChat 依赖不再出现在锁文件依赖图中。
11. 删除 `test/wechat-*` 与 `test/ui-menu-wechat.test.js`；保留并改写混合测试中的 Copilot 覆盖，新增 root 微信缺席断言。

## 新包结构

`opencode-wechat` 首发目标结构如下：

```text
opencode-wechat/
  .github/workflows/release.yml
  docs/publishing.md
  docs/release-notes-template.md
  docs/release-notes-v0.1.0.md
  scripts/clean-dist.mjs
  src/index.ts
  src/plugin.ts
  src/plugin-hooks.ts
  src/wechat/**
  src/settings-store.ts
  src/settings-actions.ts
  src/store-paths.ts
  src/ui/ansi.ts
  src/ui/confirm.ts
  src/ui/select.ts
  src/ui/wechat-menu.ts
  test/wechat-*.test.js
  test/wechat-plugin-entry.test.js
  test/package-boundary.test.js
  test/ui-menu-wechat.test.js
  LICENSE
  README.md
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
```

`src/settings-store.ts`、`src/settings-actions.ts` 和 `src/ui/wechat-menu.ts` 可以由全量复制后的 `common-settings-*` 与 `ui/menu.ts` 重命名或重写而来。实现计划必须显式选择其中一种路径，不能同时保留两套设置入口。

### `package.json`

新包元数据固定为：

```json
{
  "name": "opencode-wechat",
  "version": "0.1.0",
  "description": "WeChat remote interaction plugin for OpenCode",
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
    "url": "git+https://github.com/jiwangyihao/opencode-wechat.git"
  },
  "homepage": "https://github.com/jiwangyihao/opencode-wechat#readme",
  "bugs": {
    "url": "https://github.com/jiwangyihao/opencode-wechat/issues"
  },
  "keywords": ["opencode", "plugin", "wechat", "openclaw", "remote-control"],
  "engines": { "node": ">=24.0.0" },
  "files": ["dist/", "README.md", "LICENSE"],
  "scripts": {
    "prebuild": "node scripts/clean-dist.mjs",
    "build": "tsc -p tsconfig.build.json",
    "wechat:smoke:self-test": "npm run build && node --input-type=module -e \"import('./dist/wechat/compat/openclaw-smoke.js').then(async (m) => { const results = await m.runOpenClawSmoke('self-test'); console.log(JSON.stringify(results, null, 2)); })\"",
    "wechat:smoke:real-account": "npm run build && node --input-type=module -e \"import('./dist/wechat/compat/openclaw-smoke.js').then(async (m) => { const dryRun = process.argv.includes('--dry-run'); const results = await m.runOpenClawSmoke('real-account', { dryRun }); console.log(JSON.stringify(results, null, 2)); })\" --",
    "wechat:smoke:guided": "npm run build && node dist/wechat/compat/openclaw-guided-smoke.js",
    "test:wechat-real-host-gate": "npm run build && node --test test/wechat-opencode-real-host-gate.test.js",
    "test": "npm run build && node --test --test-concurrency=1 test/*.test.js",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.26",
    "@opencode-ai/sdk": "^1.2.26",
    "@tencent-weixin/openclaw-weixin": "2.0.1",
    "fflate": "^0.8.2",
    "openclaw": "2026.3.22",
    "xdg-basedir": "^5.1.0"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "^5.0.0"
  }
}
```

实现阶段可以把 `test` 拆成多个串行脚本以避免长命令，但首发前 `npm test` 必须是完整 fresh 验证入口。`test/*.test.js` 不得把复制残留的 Copilot 测试误纳入新包；实现计划必须列出保留的微信测试文件和新增边界测试文件。

### Public entry

`src/index.ts` 只导出微信插件：

```ts
export { OpenCodeWechat } from "./plugin.js"
export { OpenCodeWechat as default } from "./plugin.js"
```

`OpenCodeWechat` 是 `@opencode-ai/plugin` 的 `Plugin`。它不导出 `CopilotAccountSwitcher`、`OpenAICodexAccountSwitcher` 或任何 Copilot provider descriptor。

### 插件入口与菜单

新插件不再依赖 `opencode auth login --provider github-copilot` 的账号菜单。它注册独立入口：

- `title`: `OpenCode WeChat`
- `value`: `opencode-wechat.settings`
- `category`: `OpenCode`
- `/wechat` 不作为 `opencode-wechat@0.1.0` 的 OpenCode 侧必做命令；首发只承诺 Ctrl+P 设置入口和微信侧 slash。若实现阶段确认当前插件 API 已稳定支持 slash metadata，可以把 `/wechat` 作为增量任务写入 plan，但不得影响首发验收。

该入口至少提供：

1. 当前绑定状态。
2. 绑定 / 重绑微信。
3. 通知总开关。
4. question 通知开关。
5. permission 通知开关。
6. session error / retry-error 通知开关。
7. 导出脱敏 debug bundle。
8. 导出完整 debug bundle。
9. 显示 OpenClaw smoke / dry-run 验证命令。

## 数据与迁移

### 新 canonical 路径

新插件使用自己的配置与状态目录：

```text
~/.config/opencode/opencode-wechat/
```

该目录下至少包含：

```text
settings.json
broker-state-store.json
broker-state-store.schema.json
broker.json
operator.json
tokens/
latest-account.json
requests/
notifications/
debug-bundles/
dead-letter/
instances/
wechat-bridge.diagnostics.jsonl
wechat-status-runtime.diagnostics.jsonl
```

`XDG_CONFIG_HOME` 存在时继续遵循 XDG 规则。

### Legacy 读取

为了不破坏已有用户，新包第一次启动时读取 legacy 路径作为迁移来源：

```text
~/.config/opencode/account-switcher/settings.json
~/.config/opencode/account-switcher/wechat/
```

迁移规则：

1. 新路径存在时，新路径优先。
2. 新路径缺失、legacy 路径存在时，把 legacy 微信 settings、operator binding、token、broker retained state、request / notification / terminal state、dead-letter state、instance state 和 latest account state 导入新路径。
3. 写入只写新路径，不回写 legacy。
4. 如果某些旧 retained state 无法安全迁移，必须写入稳定升级关闭原因，避免旧 `qid` / `handle` / `s*` 退化成 `not found`。
5. `/recover` 必须能读取迁移后的 question、permission 与 natural-stop 状态；无法恢复时返回稳定升级关闭原因。
6. Root Copilot 包回迁后不再读取或写入 legacy 微信路径。

实现计划必须把迁移边界写成逐项映射，而不是只写目录级复制：

| Legacy 来源 | 新路径 / 处理方式 | 说明 |
| --- | --- | --- |
| `account-switcher/settings.json` 中的微信设置 | `opencode-wechat/settings.json` | 只迁移微信绑定、通知开关和微信相关 legacy flat 字段。 |
| `account-switcher/wechat/operator.json` | `opencode-wechat/operator.json` | 保留 operator binding 与重绑所需状态。 |
| `account-switcher/wechat/tokens/**` | `opencode-wechat/tokens/**` | 保留现有 token store；无法识别的 token 文件不迁移并记录原因。 |
| `account-switcher/wechat/broker-state-store.json` | `opencode-wechat/broker-state-store.json` | 使用当前真实文件名；不得写成 `broker-state.json`。 |
| `account-switcher/wechat/latest-account.json` | `opencode-wechat/latest-account.json` | 使用当前真实文件名；不得写成 `latest-account-state.json`。 |
| `account-switcher/wechat/requests/**` | `opencode-wechat/requests/**` | 保留 replyable question / permission / terminal result 的请求状态。 |
| `account-switcher/wechat/notifications/**` | `opencode-wechat/notifications/**` | 保留通知调度和 `/recover` 所需的 notification state。 |
| `account-switcher/wechat/dead-letter/**` | `opencode-wechat/dead-letter/**` | 保留无法投递通知的诊断材料。 |
| `account-switcher/wechat/instances/**` | `opencode-wechat/instances/**` | 保留或迁移 bridge instance 状态；无法安全恢复时写稳定升级关闭原因。 |
| `account-switcher/wechat/wechat-bridge.diagnostics.jsonl` | `opencode-wechat/wechat-bridge.diagnostics.jsonl` | 诊断日志可迁移；若格式不稳定，可保留为历史诊断文件，不参与运行时读取。 |
| `account-switcher/wechat/wechat-status-runtime.diagnostics.jsonl` | `opencode-wechat/wechat-status-runtime.diagnostics.jsonl` | 同上，只作为诊断材料迁移。 |
| 运行时可重建的 broker socket、lock、pid 或临时文件 | 不迁移，首次启动重建 | 不允许把旧宿主进程状态复制成新插件运行状态。 |

## 新包剥离清单

`opencode-wechat` 从全量复制基线中必须删除这些 Copilot-only 文件或语义：

```text
src/active-account-quota.ts
src/copilot-api-helpers.ts
src/copilot-network-retry.ts
src/copilot-retry-notifier.ts
src/copilot-retry-policy.ts
src/model-account-map.ts
src/routing-state.ts
src/session-control-command.ts
src/status-command.ts
src/store.ts
src/providers/copilot-menu-adapter.ts
src/providers/descriptor.ts
src/providers/registry.ts
src/menu-runtime.ts
src/plugin-actions.ts
src/upstream/copilot-loader-adapter.ts
src/upstream/copilot-plugin.snapshot.ts
scripts/sync-copilot-upstream.mjs
test/active-account-quota.test.js
test/copilot-network-retry.test.js
test/copilot-sync.test.js
test/model-account-map.test.js
test/routing-state.test.js
test/session-control-command.test.js
test/status-command.test.js
test/store.test.js
```

`src/plugin-hooks.ts` 必须重写为 WeChat-only，而不是保留 Copilot fetch / chat headers / routing 再用条件关闭。新包源码和 `dist/` 中不得出现以下运行时关键词：

```text
CopilotAccountSwitcher
github-copilot
COPILOT_PROVIDER_DESCRIPTOR
createCopilotRetryingFetch
modelAccountAssignments
sync-copilot-upstream
copilot-plugin.snapshot
```

README 可以在边界说明中提到 Copilot 包名，但 pack 运行时代码和 public export 不得包含 Copilot 能力。

## Root 回迁清单

Root 包必须删除这些微信文件或语义：

```text
src/wechat/**
test/wechat-*.test.js
test/ui-menu-wechat.test.js
```

并修改以下文件：

1. `src/plugin.ts`：删除 broker startup、微信 action mapping、debug bundle output、`ensureWechatBrokerStarted` 与 `createWechatBridgeLifecycleImpl` 传参。
2. `src/plugin-hooks.ts`：删除所有 WeChat bridge global state、bridge-capable detection、session tracking、TUI event tracking 和 `createWechatBridgeLifecycle()` 调用。
3. `src/providers/copilot-menu-adapter.ts`：删除 `wechat-bind`、`wechat-rebind`、`wechat-export-debug-bundle` 和 `toggle-wechat-*`。
4. `src/ui/menu.ts`：删除微信 submenu 与 copy。
5. `src/menu-runtime.ts`：删除 `wechat-*` provider action 的 non-persistent 特例和其它微信 action 语义。
6. `src/common-settings-store.ts`：删除 `WechatMenuSettings`、`WechatNotificationDispatchSettings`、legacy flat 微信字段和 `readWechatNotificationDispatchSettings()`。
7. `src/common-settings-actions.ts`：删除微信 action。
8. `src/store-paths.ts`：删除 `wechatConfigDir()`。
9. `README.md`：删除内置微信功能说明，改为独立 `opencode-wechat@0.1.0` 安装说明。
10. `package.json`：删除 OpenClaw / WeChat dependencies、scripts 与测试分片，重写 `npm test` 组合，不再引用已删除的 WeChat 文件。
11. `package-lock.json`：重新生成，移除 OpenClaw / WeChat 依赖图和旧脚本残留。
12. `test:wechat-real-host-gate`：从 root 删除或迁入 `opencode-wechat`，root 不保留该脚本。
13. `test/plugin.test.js`、`test/menu.test.js`、`test/common-settings-store.test.js`、`test/common-settings-actions.test.js`：保留 Copilot 行为覆盖，删除或反转其中的微信断言。
14. `scripts/clean-dist.mjs` 和 `prebuild`：root 必须继续在 build 前清理 `dist/`，确保 `dist/wechat/**` 不会因历史产物残留进入 pack。

Root 包源码、`dist/` 和 pack 清单不得出现：

```text
src/wechat
dist/wechat
wechat:smoke
test/wechat-
@tencent-weixin/openclaw-weixin
openclaw
wechat-bind
wechat-export-debug-bundle
toggle-wechat
```

README 允许出现 `opencode-wechat@0.1.0` 的独立安装说明。

## 测试策略

### `opencode-wechat` 自动化测试

新包保留并迁入当前微信测试：

1. broker / bridge / WS lifecycle：`wechat-ws-protocol`、`wechat-broker-state-store`、`wechat-broker-ws-lifecycle`、`wechat-broker-lifecycle`。
2. 通知与请求状态：`wechat-notification-flow`、`wechat-notification-store`、`wechat-request-store`、`wechat-dead-letter-store`。
3. 交互合同：`wechat-status-flow`、`wechat-plugin-hooks-status`、`wechat-session-digest`。
4. 绑定与菜单：`wechat-bind-flow`、`ui-menu-wechat`、`wechat-operator-store`。
5. OpenClaw compat：`wechat-openclaw-*`、`wechat-qrcode-terminal-loader`、`wechat-jiti-loader`。
6. Debug bundle：`wechat-debug-bundle`。
7. 状态路径和 token：`wechat-state-paths`、`wechat-state-root`、`wechat-token-store*`。

新增边界测试：

1. `wechat package exports only OpenCodeWechat`。
2. `wechat package source and dist exclude Copilot runtime`。
3. `wechat package pack list contains wechat runtime and excludes Copilot runtime`。
4. `wechat plugin registers OpenCode WeChat command`。
5. `legacy account-switcher wechat settings migrate into opencode-wechat settings`。
6. `old handle returns stable upgrade closure when retained state cannot migrate`。
7. `/recover restores replyable question / permission / natural-stop handles from migrated state`。
8. `package-lock top-level metadata and dependency graph match opencode-wechat@0.1.0`。

### Root 自动化测试

Root 包新增或更新负向测试：

1. `root package does not expose WeChat menu actions`。
2. `common settings no longer persists WeChat fields`。
3. `plugin hooks do not create WeChat bridge lifecycle`。
4. `source and dist contain no src/wechat or dist/wechat artifacts`。
5. `npm pack --dry-run --json excludes WeChat runtime and OpenClaw dependencies`。
6. `README points WeChat users to opencode-wechat instead of built-in behavior`。
7. `root npm test no longer references deleted test/wechat-* files or test:wechat-real-host-gate`。
8. `root package-lock excludes OpenClaw and WeChat-only dependencies`。

Root 现有 Copilot 测试继续通过：账号、quota、routing、retry、status、compact、stop-tool、menu 和 package boundary。实施时必须先重写 root 测试脚本，再删除 WeChat 文件，最后以新的 `npm test` 作为 fresh gate。混合测试文件的保留白名单至少包含 `test/plugin.test.js`、`test/menu.test.js`、`test/common-settings-store.test.js`、`test/common-settings-actions.test.js` 和 package boundary 相关测试；这些文件只能留下 Copilot 正向断言和 WeChat 缺席断言。

Root 脚本最终形态必须满足：`npm test` 和 `test:parallel:shard` 只运行 Copilot、common settings、package boundary 与 root 缺席断言；`test:wechat-real-host-gate` 不存在；任何脚本都不得引用 `test/wechat-*`、`test/ui-menu-wechat.test.js` 或 WeChat smoke。

## Fresh 验证门槛

### 新 `opencode-wechat`

发布前必须运行：

```powershell
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
```

并额外执行：

1. 实际 `npm pack --json` 生成 tarball。
2. 在临时目录安装 tarball。
3. 从包名 `opencode-wechat` import，断言 `OpenCodeWechat` 存在且 Copilot export 不存在。
4. 执行最小 plugin driver，确认可以加载 hooks，并能通过测试 seam 注册或发现 `OpenCode WeChat` 设置入口。
5. 执行微信 slash surface driver：基于临时 broker state 调用 `/status`、`/todo`、`/reply`、`/allow`、`/recover` 的 handler，确认输出仍符合用户合同。
6. 将 `package-lock.json` 纳入验证，断言顶层元数据和依赖图不包含 Copilot-only 包名或依赖。
7. 执行 OpenClaw dry-run：`npm run wechat:smoke:real-account -- --dry-run`。
8. 三段式 pack smoke：解析 pack JSON 文件列表、解包 tarball 后读取 `package/package.json`、import tarball 安装后的包入口并只验白名单导出。

Release-blocking gate 包含 build、typecheck、`npm test`、pack dry-run、真实 tarball install / import、plugin load driver、TUI command driver、slash handler driver、`/recover` driver 和 OpenClaw dry-run。Optional observational gate 只包含 live real-account smoke 与 Windows PTY / 真实宿主 gate；它们失败时必须记录 fresh 输出和是否影响用户风险判断，但除非错误暴露本包代码缺陷，否则不自动阻塞 `opencode-wechat@0.1.0` 首发。不能复用旧结果。

### Root Copilot 包

回迁提交前必须运行：

```powershell
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
```

还必须执行真实 tarball smoke 和 public entry smoke。Root 的 tarball smoke 不能只导入 `dist/`，必须和新包一样执行可审计的三段式流程：

1. 运行 `npm pack --json` 生成真实 tarball，并解析 pack JSON 文件列表；清单只能包含 Copilot public entry、Copilot runtime、通用文档和必要元数据，不得包含任何 `dist/wechat/**`、OpenClaw 依赖或 WeChat-only script。
2. 在临时目录解包该 tarball，读取 `package/package.json`；断言 `name`、`exports`、`files`、`bin`、`dependencies` 与 root Copilot 包一致，且不包含 WeChat export、OpenClaw 或 WeChat-only 依赖。
3. 在临时目录安装该 tarball，从安装后的包入口 import；只允许 `CopilotAccountSwitcher` 和 root 既有 public export 白名单，不允许出现 `OpenCodeWechat`、WeChat handler、WeChat provider descriptor 或任何微信运行时 export。

额外 build sanity check 可以导入本地构建产物，但不能替代 tarball smoke：

```powershell
node --input-type=module -e "const mod = await import('./dist/index.js'); console.log(Object.keys(mod).sort())"
```

预期：pack JSON 文件列表、临时目录解包后的 `package/package.json`、以及临时安装后的包入口 import 都只包含 Copilot public export 和 Copilot dependencies，不包含任何 WeChat export、`dist/wechat/**`、OpenClaw 或 WeChat-only scripts。

## Manual QA Gate

### `opencode-wechat`

真实 surface 至少包含 4 类 driver：

1. **Plugin load driver**：import 构建产物，调用 `OpenCodeWechat({ client, serverUrl, directory })`，确认 hooks 可加载且不会要求 Copilot provider。
2. **TUI command driver**：通过 command registration seam 或实际 OpenCode TUI 确认 `OpenCode WeChat` 可见。
3. **Slash handler driver**：在临时 broker authoritative view 下调用 `/status`、`/todo`、`/reply q1 ...`、`/allow p1 once`、`/recover`，确认用户文案、命令状态和恢复语义正确。
4. **OpenClaw driver**：运行 dry-run smoke，确认 compat 入口仍能导入构建产物并输出准备检查结果。

### Root Copilot 包

真实 surface 至少包含 3 类 driver：

1. Import root `dist/index.js`，确认只导出 `CopilotAccountSwitcher`。
2. 用菜单 driver 构造 Copilot 菜单，确认无微信入口。
3. 用 hooks driver 加载 Copilot plugin，确认不会触发 WeChat broker / bridge seam。

## 发布任务

`opencode-wechat@0.1.0` 首发是一条完整链路，不允许只发布 npm 或只创建 tag。

### 新仓库准备

1. 复制 root 到 `C:\Users\34404\Documents\GitHub\opencode-wechat`。
2. 剥离 Copilot 代码并完成新包验证。
3. 写入 `docs/release-notes-template.md`，模板必须包含一句价值导语、`## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`；模板中的示例升级命令必须使用 `opencode-wechat@x.y.z` 或 `opencode-wechat@0.1.0`，不得残留 `opencode-copilot-account-switcher`。
4. 写入 `docs/release-notes-v0.1.0.md`，升级命令必须是：

   ```bash
   opencode plugin opencode-wechat@0.1.0 --force -g
   ```

5. 写入 `docs/publishing.md`，必须包含 `手动首发`、`发布前 fresh 验证`、`npm Trusted Publisher 设置与验证`、`后续 GitHub Actions 发布`、`GitHub Release 创建与验证`、`部分失败恢复` 这些小节。
6. 写入 `.github/workflows/release.yml`，GitHub Release published 后执行 install、build、test、version check、`npm publish --access public`；workflow 必须使用 npm Trusted Publisher + GitHub OIDC，显式配置 `permissions: id-token: write`，不得依赖 `NODE_AUTH_TOKEN` 或 npm token secrets。如果版本已发布，只能跳过 publish step，build / test / version check 必须成功。

### 首发执行

执行外部发布动作前再次询问用户。授权后按顺序执行：

1. `npm run build`。
2. `npm run typecheck`。
3. `npm test`。
4. `npm pack --dry-run --json` 并解析 pack 清单。
5. `npm pack --json` + tarball install / import smoke。
6. plugin load、TUI command、slash handler 和 OpenClaw dry-run drivers。
7. `git init`、`git branch -M master`、初始 commit。
8. `gh repo create jiwangyihao/opencode-wechat --public --source . --remote origin --push`。
9. `npm publish --access public`。
10. 在 npm 网站或 CLI 配置 Trusted Publisher，绑定 `jiwangyihao/opencode-wechat` 的 release workflow；首发执行顺序固定为手动 `npm publish` 后配置 Trusted Publisher，使后续 GitHub Release workflow 只通过 OIDC 发布或在版本已存在时跳过 publish。
11. 创建并推送 `v0.1.0` tag。
12. 使用 `docs/release-notes-v0.1.0.md` 创建 GitHub Release。
13. 回读远端状态：`npm view opencode-wechat@0.1.0 version`、`gh release view v0.1.0 --json body,url`、GitHub Actions workflow 状态。
14. 如 release workflow 因版本已手动发布而跳过 publish，仍必须确认 Build / Test / Check version 成功。
15. 如果 `npm publish` 已成功但 GitHub Release 创建失败，不得重复发布同版本；只补齐 `gh release create v0.1.0 --notes-file docs/release-notes-v0.1.0.md ...` 和远端验证。
16. 如果 GitHub Release 已创建但 workflow / OIDC 发布失败，先修复 Trusted Publisher 或 workflow，再重新触发同一版本 release workflow；只有 `npm view opencode-wechat@0.1.0 version` 返回 `0.1.0` 时，publish skipped 才算正常。

### Root 回迁提交

Root 回迁与新包首发分开处理：

1. 删除微信代码和测试。
2. 更新 README 为独立插件说明。
3. 运行 root fresh build / typecheck / test / pack。
4. 创建 root 回迁提交并推送 `master`。
5. 不创建 root release，不发布 root npm，除非用户另行授权。

## Release Notes 要求

`opencode-wechat` GitHub Release 正文必须以 `docs/release-notes-template.md` 为唯一模板来源，并包含：

1. 一句价值导语。
2. `## 适合谁升级`。
3. `## 你会看到的变化`。
4. `## 升级方式`。
5. 明确版本号命令：`opencode plugin opencode-wechat@0.1.0 --force -g`。

不得写成单行 `Summary + Test Plan`，不得只罗列文件移动或实现过程。

## 风险与缓解

### 风险 1：全量复制带来 Copilot 残留

缓解：新包必须有源码、`dist/` 和 pack 清单负向测试；`plugin-hooks.ts` 必须重写为 WeChat-only，而不是保留 Copilot 分支。

### 风险 2：Root 删除微信后误删 Copilot 公共设置

缓解：Root 只删除微信 settings 字段，保留 Copilot 的 `networkRetryEnabled`、`experimentalSlashCommandsEnabled` 等仍在使用的字段。

### 风险 3：状态路径迁移导致旧 handle 失效

缓解：新包 first-run migration 必须处理 legacy retained state；无法迁移时返回稳定升级关闭原因，不允许退化成 `not found`。

### 风险 4：真实账号 smoke 依赖外部环境

缓解：发布 gate 以 automated tests、pack smoke、driver 和 dry-run 为必需；live real-account smoke 与 Windows PTY / 真实宿主 gate 是 optional observational gate。它们失败时必须记录具体环境错误和用户风险判断，但除非错误暴露本包代码缺陷，否则不自动阻塞首发。

### 风险 5：发布链路再次断裂

缓解：spec 和后续 plan 必须把 npm publish、Trusted Publisher、tag、GitHub Release、workflow 和远端状态验证列为同一链路；任何一步失败都不算 release 完成。`npm publish` 成功后不得重复发布同版本，后续只补 GitHub Release、workflow 或远端验证缺口；GitHub Release 已创建但 OIDC 失败时必须修复 Trusted Publisher / workflow 并重跑同一版本 release workflow。

## 验收标准

1. `opencode-wechat@0.1.0` 可独立安装，并提供 `OpenCodeWechat` 插件入口。
2. `opencode-wechat` 保留当前微信用户合同：通知、`/status`、`/todo`、`/reply`、`/allow`、`/recover`、natural-stop、terminal result、retry-error、debug bundle 和 OpenClaw dry-run。
3. `opencode-wechat` 源码、`dist/` 和 pack 清单不包含 Copilot 运行时。
4. Root Copilot 包源码、`dist/` 和 pack 清单不包含微信运行时或 OpenClaw 依赖。
5. Root Copilot 包 Copilot 行为测试继续通过。
6. 新包和 root 都有 fresh build、typecheck、test、pack、tarball install / import smoke 和 manual QA 证据。
7. 两个包的 `package-lock.json` 都与各自 `package.json` 一致，不保留对方包名或已剥离依赖。
8. 新包和 root 的 `npm test` 都不引用已删除文件，且 release-blocking gate 与 optional observational gate 边界清楚。
9. 新包 release notes、publishing 文档和 release workflow 随首发提交。
10. `opencode-wechat@0.1.0` 的 npm publish、tag push、GitHub Release 和远端状态验证全部完成，或在缺少发布授权时停在可审查的本地待发布状态。
11. Root Copilot 包本轮未发布 root npm，也未创建 root release。
12. 文档无占位符、无互相矛盾的范围描述，且明确包含完整新插件发布任务。

## 自检

1. 本规格采用用户确认的全量复制路径，而不是从零挑文件拼装。
2. `opencode-wechat` 与 root Copilot 包的双向剥离边界分别列出。
3. 新插件发布任务覆盖 fresh 验证、npm、Trusted Publisher、tag、GitHub Release 和远端状态验证。
4. Root 回迁明确不随新插件首发发布。
5. 没有未完成章节或占位符；后续 implementation plan 可以直接按本规格拆成执行任务。
