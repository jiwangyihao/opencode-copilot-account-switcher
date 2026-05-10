# opencode-codex-account-switcher 拆分设计

## 背景

`opencode-copilot-account-switcher` 已经完成 `opencode-wait`、`opencode-notify-tool` 与 `opencode-loop-safety` 的独立化。当前包内仍混合 Copilot、Codex 与微信相关能力，其中 Codex 账号管理已经形成独立领域：它管理 `openai` provider、Codex OAuth / upstream snapshot loader、Codex status、Codex retry、Codex 多账号 store 与 Codex 菜单。

继续把 Codex 放在 Copilot 包中，会带来 4 个问题：

1. Copilot 包继续导出 `OpenAICodexAccountSwitcher`，用户无法只安装 Codex 账号切换能力。
2. Copilot 包继续拥有 Codex upstream snapshot、`/codex-status`、Codex retry 与 `sync:codex-snapshot`，包边界与名称不一致。
3. `plugin.ts`、`plugin-hooks.ts`、provider registry 和菜单 adapter 持续混合 Copilot / Codex / WeChat 逻辑，后续维护需要过多全局上下文。
4. Codex 与 Copilot 的运行时语义不同。Codex 不应继承 Copilot header rewrite、`x-initiator`、模型账号映射或 Copilot session repair。

本设计采用用户批准的“边界优先”方案：先划清 Codex 与 Copilot 包的所有权，再迁移文件、测试与包产物边界。本轮不发布 release，不推送非主分支。

## 已确认决策

1. 独立包名使用 `opencode-codex-account-switcher`。
2. 新包第一版只承接 Codex / OpenAI 账号切换能力。
3. Codex 插件入口继续命名为 `OpenAICodexAccountSwitcher`。
4. Root `opencode-copilot-account-switcher` 回迁为 Copilot-only，只导出 `CopilotAccountSwitcher`。
5. 本轮不创建 `shared-core`、`toolkit` 或其他共享库。
6. 必要共享代码首轮允许少量复制到 Codex 包，优先避免新包反向依赖 Copilot 包。
7. Codex 包第一版直接移除当前 Codex 菜单里的微信绑定、重绑和 debug bundle 动作。
8. 微信集成留到后续 `opencode-wechat` 拆分，通过公开协议或显式 adapter 重新设计。
9. Codex 数据路径保持兼容，继续使用 `~/.config/opencode/account-switcher/codex-accounts.json`。
10. 继续兼容 legacy `~/.config/opencode/codex-store.json` 读取。
11. 本轮不发布 GitHub Release、不发布 npm、不创建 tag。
12. 本轮不推送 `split/opencode-codex-account-switcher` 或任何其他非主分支。
13. 规格审查通过后，后续计划与实现必须迁回主分支工作区执行，不继续在 `.worktrees/opencode-codex-account-switcher-split` 中开发。

## 目标

1. 新建可独立构建、测试和打包的 `opencode-codex-account-switcher` 包。
2. 迁移 Codex 运行时：账号 store、auth source、status fetcher、status command、invalid account recovery、network retry、retry policy、menu adapter、upstream loader adapter 与 upstream snapshot。
3. 迁移 Codex snapshot 同步脚本：`sync:codex-snapshot` 与 `check:codex-sync`。
4. 迁移 `test/codex-*.test.js`，让 Codex 行为在新包内独立验证。
5. 回迁 `opencode-copilot-account-switcher`，删除 Codex export、provider descriptor、registry wiring、hook branch、menu branch、sync scripts、tests 和打包产物。
6. 增加 Copilot 包负向边界测试，确保源码、`dist/` 和 `npm pack --dry-run --json` 不再包含 Codex 家族产物。
7. 保持 Codex 现有用户数据兼容，不迁移、不重命名、不清空既有 `codex-accounts.json`。

## 非目标

1. 不在本轮发布任何 release。
2. 不推送非主分支。
3. 不把 Copilot 功能拆成多个用户可见插件。
4. 不抽取新的共享库。
5. 不迁移微信插件或微信 broker。
6. 不在 Codex 包内保留微信绑定、重绑、调试包导出或微信通知入口。
7. 不改变 Copilot routing、header rewrite、模型账号映射、quota 查询或 Copilot status 行为。
8. 不重新实现 Codex OAuth；继续使用 upstream snapshot loader。
9. 不把 Codex retry 改造成 Copilot retry 的变体。

## 用户可见行为

### Codex 包

安装并启用 `opencode-codex-account-switcher` 后，用户获得独立 Codex 账号切换插件：

1. 插件导出 `OpenAICodexAccountSwitcher`。
2. 账号 provider 仍是 `openai`。
3. Codex 菜单仍支持账号导入、账号切换、新增账号、删除账号与刷新 snapshot。
4. 首次启动仍从 OpenCode `auth.json` 的 `openai` OAuth 信息导入一次。
5. `/codex-status` 在实验性 slash commands 启用时注册，仍查询 Codex usage 并展示账号、Workspace、5h 与 week 信息。
6. Codex retry 只处理 `chatgpt.com/backend-api/codex/*` 请求。
7. Browser、headless 与 API auth methods 继续来自 upstream snapshot。
8. 菜单中不再出现微信绑定、重绑、调试 bundle 或微信设置动作。

### Copilot 包

回迁后的 `opencode-copilot-account-switcher` 对用户表现为 Copilot 专属插件：

1. 只导出 `CopilotAccountSwitcher`。
2. 继续提供 Copilot 多账号、quota、routing、model-account assignments、network retry、status 与 Copilot 菜单。
3. 不再导出 `OpenAICodexAccountSwitcher`。
4. 不再注册 `openai` provider 或 `codex-status`。
5. 不再携带 Codex upstream snapshot、Codex sync script 或 Codex dist artifacts。

## 运行时边界

### `opencode-codex-account-switcher` 拥有

1. `OpenAICodexAccountSwitcher` 插件入口。
2. `openai` provider descriptor，逻辑 key 为 `codex`。
3. Codex 菜单 adapter。
4. Codex store 与 legacy store reader。
5. Codex auth source parser。
6. Codex status fetcher 与 status command。
7. Codex invalid account recovery。
8. Codex network retry 与 retry policy。
9. Codex upstream loader adapter 与 committed upstream snapshot。
10. Codex snapshot sync / check script。
11. Codex tests、README 与未来 release notes。

### `opencode-codex-account-switcher` 不拥有

1. Copilot auth loader。
2. Copilot header rewrite、`x-initiator` 或 session repair。
3. Copilot model routing 与 model-account assignments。
4. Copilot quota/status 文案。
5. 微信 broker、bridge、binding flow、debug bundle 或通知分发。
6. `wait`、`notify` 或 Loop Safety tool / policy。

### `opencode-copilot-account-switcher` 回迁后保留

1. `CopilotAccountSwitcher`。
2. Copilot provider descriptors：`github-copilot` 与 `github-copilot-enterprise`。
3. Copilot menu adapter。
4. Copilot upstream loader adapter 与 snapshot。
5. Copilot retry policy、network retry 与 retry notifier。
6. Copilot API helpers、quota、status、compact、stop-tool 等 Copilot 领域能力。
7. Copilot routing、model checks 与 model-account assignments。
8. 当前尚未拆出的微信相关能力，直到后续 `opencode-wechat` 阶段。

### `opencode-copilot-account-switcher` 回迁后删除

1. `OpenAICodexAccountSwitcher` export。
2. `src/codex-*.ts`。
3. `src/retry/codex-policy.ts`。
4. `src/providers/codex-menu-adapter.ts`。
5. `src/upstream/codex-loader-adapter.ts`。
6. `src/upstream/codex-plugin.snapshot.ts`。
7. `scripts/sync-codex-upstream.mjs`。
8. `package.json` 中的 `sync:codex-snapshot` 与 `check:codex-sync`。
9. `test/codex-*.test.js`。
10. `plugin-hooks.ts` 中 Codex loader、Codex retry、`codex-status` command 和 `chat.headers` Codex 分支。
11. provider registry 中的 `CODEX_PROVIDER_DESCRIPTOR` 与 `openai` provider wiring。
12. Codex menu 文案，例如 `Manage OpenAI Codex accounts` 与 `OpenAI Codex accounts`。

## 包结构设计

## 执行工作区约束

当前规格草案位于临时 split worktree：

```text
.worktrees/opencode-codex-account-switcher-split
```

该 worktree 只作为规格探索与审查来源。审查通过后，必须先把规格和后续计划落到主分支工作区，再开始实现。后续实现阶段遵循用户最新约束：

1. 直接在 `master` 主工作区开发。
2. 不使用新的或现有的 split worktree 执行实现。
3. 开始实现前确认主工作区 clean，且 `master` 与 `origin/master` 状态明确。
4. 开始实现前确认远端只保留主分支。
5. 不推送任何非主分支。
6. 当前临时 split worktree / branch 在规格和计划迁回主分支、且不再需要后，应按用户确认的清理节奏删除；如存在对应远端非主分支，也必须删除。

这些约束不构成发布授权。进入 `writing-plans` 或实现阶段仍不得创建 tag、不得发布 npm、不得创建 GitHub Release。

## 命名约定

为避免实现阶段混淆，本设计使用以下固定含义：

1. `opencode-codex-account-switcher`：新的 Codex 独立 npm 包。
2. `OpenAICodexAccountSwitcher`：Codex 包对外导出的 OpenCode 插件入口。
3. `openai`：OpenCode auth 中的 provider ID，Codex 包只写这个 provider。
4. `codex`：Codex 包内部逻辑 key、store namespace 与 menu/provider descriptor key。
5. `opencode-copilot-account-switcher`：回迁后的 Copilot 专属 root 包，只导出 `CopilotAccountSwitcher`。

### Codex 包源码

目标源码结构：

```text
opencode-codex-account-switcher/
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts
    plugin.ts
    plugin-hooks.ts
    codex-auth-source.ts
    codex-store.ts
    codex-status-fetcher.ts
    codex-status-command.ts
    codex-invalid-account.ts
    codex-network-retry.ts
    retry/
      codex-policy.ts
    providers/
      descriptor.ts
      registry.ts
      codex-menu-adapter.ts
    upstream/
      codex-loader-adapter.ts
      codex-plugin.snapshot.ts
  scripts/
    clean-dist.mjs
    sync-codex-upstream.mjs
  test/
    codex-*.test.js
```

`src/index.ts` 只导出：

```ts
export { OpenAICodexAccountSwitcher } from "./plugin.js"
```

`src/plugin.ts` 只负责 Codex provider assembly，不再有 Copilot 分支，也不导入 `src/wechat/**`。

### Copilot 包源码

Root 包继续保留现有仓库结构，但删除 Codex 文件和 wiring。`src/index.ts` 只导出：

```ts
export { CopilotAccountSwitcher } from "./plugin.js"
```

`src/plugin.ts` 回到 Copilot-only assembly。`src/plugin-hooks.ts` 删除 Codex-specific hook 分支后，仍可保留 Copilot、WeChat 和当前尚未拆出的其他能力。

## Provider 与 hook 设计

### Codex provider descriptor

Codex 包保留独立 descriptor：

```ts
const CODEX_PROVIDER_DESCRIPTOR = {
  key: "codex",
  providerIDs: ["openai"],
  storeNamespace: "codex",
  commands: ["codex-status"],
  menuEntries: ["switch-account", "add-account", "refresh-snapshot"],
  capabilities: ["auth", "chat-headers", "network-retry", "slash-commands"],
}
```

该 descriptor 不声明 `model-routing`，也不接入 Copilot model-account assignment。

### Codex hook builder

Codex 包的 hook builder 只处理 `openai`：

1. `auth.provider === "openai"` 时启用 upstream Codex auth loader。
2. `chat.headers` 走 upstream Codex `chat.headers`，返回后不进入 Copilot synthetic initiator 或 routing 分支。
3. `fetch` 只对 Codex backend URL 应用 `createCodexRetryingFetch()`。
4. `config` hook 只在实验性 slash commands 启用时注册 `codex-status`。
5. `command` hook 只处理 `codex-status`，并委派给 `handleCodexStatusCommand()`。

### Copilot hook builder

Copilot 包删除所有 `authLoaderMode === "codex"` 或 `provider === "openai"` 的特殊分支。Copilot retry、header rewrite、routing、status 与 synthetic initiator 继续保持原行为。

## 数据与兼容性

Codex 包继续使用现有 Codex 数据路径：

```text
~/.config/opencode/account-switcher/codex-accounts.json
```

Legacy fallback 继续读取：

```text
~/.config/opencode/codex-store.json
```

兼容规则：

1. 新 store 优先于 legacy store。
2. legacy single-snapshot shape 继续 normalize 为 multi-account shape。
3. 写入只写新 store，不回写 legacy store。
4. 文件权限继续使用 `0o600`。
5. `bootstrapAuthImportTried` 与 `bootstrapAuthImportAt` 继续防止重复导入。
6. Codex 包只写 OpenCode auth 的 `openai` provider。
7. Codex 包不得读写 `copilot-accounts.json`、Copilot routing 或 model-account assignment。

## 微信边界

当前 `src/providers/codex-menu-adapter.ts` 直接动态导入微信 bind flow 与 debug bundle。拆分时这些动作不进入 Codex 包：

1. Codex 菜单删除微信绑定、重绑、debug bundle 和微信通知相关 action。
2. Codex 包不依赖 `src/wechat/**`。
3. Codex tests 中与微信 action 相关的断言删除或迁到未来 WeChat spec。
4. 未来 `opencode-wechat` 如需接入 Codex 状态，只能通过公开协议或显式 adapter，不直接穿透 Codex 内部文件。

## 测试策略

### Codex 包迁入测试

以下测试迁入新 Codex 包，并保持行为覆盖：

1. `test/codex-auth-source.test.js`。
2. `test/codex-invalid-account.test.js`。
3. `test/codex-loader-adapter.test.js`。
4. `test/codex-menu-adapter.test.js`。
5. `test/codex-network-retry.test.js`。
6. `test/codex-plugin-config.test.js`。
7. `test/codex-status-command.test.js`。
8. `test/codex-status-fetcher.test.js`。
9. `test/codex-store.test.js`。
10. `test/codex-sync.test.js`。

迁入后需要调整的测试点：

1. Codex plugin config 测试改为新包只注册 `codex-status`。
2. Codex menu adapter 测试删除微信 action 期望。
3. Codex sync 测试验证新包 `package.json` 暴露 `sync:codex-snapshot` 与 `check:codex-sync`。
4. 新增 tarball import smoke，验证从打包产物导入 `OpenAICodexAccountSwitcher`。
5. 新增 pack 清单测试，解析 `npm pack --dry-run --json` 返回的首个结果，并检查 `files[].path` 中包含 Codex runtime、upstream snapshot 与 `sync-codex-upstream`。

### Copilot 包回迁测试

Root 包测试需要翻转边界断言：

1. `test/index-exports.test.js` 不再期待 `OpenAICodexAccountSwitcher`。
2. `test/plugin.test.js` 保留 `src/codex-oauth.ts` 缺席断言，并扩展为 Codex 家族缺席断言。
3. provider registry 测试改为只暴露 Copilot provider。
4. `test/menu.test.js` 中 Codex 专属菜单 case 迁出或删除。
5. `npm pack --dry-run --json` 断言 root 包不包含 `codex`、`codex-plugin.snapshot`、`sync-codex-upstream`。
6. `dist/` 负向断言确保 `dist/codex-*`、`dist/providers/codex-menu-adapter.*`、`dist/upstream/codex-*` 不存在。
7. 新增 negative import smoke：从 root 包构建后的 public entry 动态导入，断言 `OpenAICodexAccountSwitcher` 不存在；如果测试使用临时 packed tarball 或安装目录，也必须从 public export 层确认无法导入 Codex 插件入口。
8. pack 清单测试必须解析 `npm pack --dry-run --json` 返回的首个结果，并对 `files[].path` 做负向匹配，至少覆盖 `codex`、`codex-plugin.snapshot`、`sync-codex-upstream`、`dist/providers/codex-menu-adapter` 与 `dist/upstream/codex-`。

### 已知环境 caveat

Windows real-host WeChat gate 可能因 `@lydell/node-pty-win32-x64` / `AttachConsole failed` 出现环境性抖动。该问题已在 Loop Safety split 文档中记录为既有宿主问题。本轮 Codex 验证不依赖 WeChat real-host gate；如完整 root `npm test` 遇到同类失败，需保留 fresh 输出并按既有 caveat 说明。

## 验证门槛

### Codex 包

Codex 包完成拆分后必须通过：

```bash
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
```

额外 smoke：

1. 从实际 tarball 或临时安装目录验证 public entry 导出 `OpenAICodexAccountSwitcher`；仅 `npm pack --dry-run --json` 不足以证明 import surface。
2. 解析 `npm pack --dry-run --json` 的首个结果，检查 `files[].path` 包含 Codex 必需 runtime、upstream snapshot 与 sync script。
3. 验证 pack 清单不包含 Copilot-only、WeChat-only、Loop Safety、wait 或 notify artifacts。

### Copilot 包

Root Copilot 包完成回迁后必须通过：

```bash
npm run build
npm run typecheck
npm test
npm pack --dry-run --json
```

额外 negative smoke：

1. `dist/index.js` 不导出 `OpenAICodexAccountSwitcher`。
2. `dist/plugin.js` 不包含 Codex provider、Codex status command 或 Codex upstream loader。
3. 从构建后的 root 包 public entry 动态导入，断言 `OpenAICodexAccountSwitcher` 不存在。
4. 解析 `npm pack --dry-run --json` 的首个结果，检查 `files[].path` 不包含 `codex`、`codex-plugin.snapshot`、`sync-codex-upstream`、`dist/providers/codex-menu-adapter` 或 `dist/upstream/codex-`。

## Release 与发布约束

本轮只完成拆分设计与后续实现计划，不发布 release。审查通过后进入 `writing-plans` 或实现阶段，也不构成 release、tag、npm publish 或 GitHub Release 授权。

未来如果进入发布阶段，必须遵循仓库级 release 护栏：

1. GitHub Release 正文以 `docs/release-notes-template.md` 为唯一模板来源。
2. Release 正文必须包含一句价值导语、`## 适合谁升级`、`## 你会看到的变化`、`## 升级方式`。
3. `## 升级方式` 必须给出带明确版本号的命令，不能只写 `latest` 或裸包名。
4. 发版前必须有 fresh 验证证据。
5. 版本 bump、release commit、tag、push、npm publish 与 GitHub Release 是同一条完整链路。

## 风险与缓解

### `plugin-hooks.ts` 耦合过深

风险：Codex loader、retry、slash command 与 Copilot routing 目前共处一个 hook builder。

缓解：拆出 provider-specific shell。Copilot 包删除 Codex 分支；Codex 包保留只服务 `openai` 的 hook builder。避免为拆分先抽 shared core。

### 必要共享代码复制导致漂移

风险：菜单 runtime、store path、settings normalization 等代码可能在两个包中出现少量重复。

缓解：只复制稳定且必要的最小集合；在实现计划中列出复制清单；未来只有真实复用稳定后才考虑 shared core。

### Codex 与微信行为变化

风险：Codex 菜单移除微信动作，属于用户可见变化。

缓解：规格明确该变化；Codex 包第一版只承接 Codex 能力；微信集成在 `opencode-wechat` 阶段以公开协议重建。

### Pack 边界残留旧产物

风险：`tsc` 不自动清理 `dist/`，旧 `dist/codex-*` 可能被 root 包打包。

缓解：root Copilot 包与新 Codex 包都必须配置 `prebuild: node scripts/clean-dist.mjs` 或等价 clean-dist；增加 root 包 Codex stale artifact 负向测试；每次验证必须先执行 fresh `npm run build` 触发清理，再执行 `npm pack --dry-run --json` 并解析 `files[].path`。不得只手动运行 `tsc` 或复用旧 pack 输出作为边界证据。

### Windows real-host PTY 抖动干扰判断

风险：完整 root `npm test` 可能因 WeChat real-host PTY 环境问题失败。

缓解：Codex 自测不依赖该 gate；如果完整 root 测试触发 `AttachConsole failed`，按既有文档记录为 pre-existing 环境问题，并用 targeted rerun 保留证据。

## 验收标准

拆分完成时必须满足：

1. `opencode-codex-account-switcher` 可独立构建、typecheck、测试和 pack。
2. `OpenAICodexAccountSwitcher` 只从 Codex 包导出。
3. Codex 包保留账号、status、retry、upstream snapshot、store compatibility 和 sync script 行为。
4. Codex 包不包含 Copilot routing/header rewrite/model-account 语义。
5. Codex 包不包含微信绑定、重绑、debug bundle 或 `src/wechat/**` 依赖。
6. `opencode-copilot-account-switcher` 只导出 `CopilotAccountSwitcher`。
7. Root Copilot 包源码、`dist/` 与 pack 清单不包含 Codex 家族 artifacts。
8. Root Copilot 包现有 Copilot 行为测试继续通过。
9. 实现前已确认主工作区位于 `master`，工作区 clean，且远端只保留主分支。
10. 未发布 release，未创建 tag，未发布 npm，未创建 GitHub Release，未推送非主分支。
11. 临时 split worktree / branch 已按用户确认的清理节奏处理，且没有遗留远端非主分支。
12. 所有新增或变更文档无占位符、无互相矛盾的范围描述。
