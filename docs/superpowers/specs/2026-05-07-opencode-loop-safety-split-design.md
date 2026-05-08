# opencode-loop-safety 拆分设计

## 背景

`opencode-copilot-account-switcher` 已完成 `opencode-wait` 与 `opencode-notify-tool` 的独立化。当前仍留在 Copilot 包内的 Guided Loop Safety 已经不再是 Copilot 账号能力，而是通用的交互策略：它约束 `question`、`notify`、专用等待工具、最终交接、无人值守等待、compaction 继续工作和强制介入 marker 的使用方式。

继续把这组策略放在 Copilot 包里，会造成 4 个问题：

1. 非 Copilot 用户无法单独安装这套策略。
2. Copilot 包继续拥有 `question` definition 改写、system transform 和 compaction bypass 这类跨 provider 交互规则。
3. Codex 与后续通用插件会继续从 Copilot 包的 common settings 中读取 Loop Safety 字段，形成错误归属。
4. 用户已经确认需要真实 Ctrl+P 菜单入口，而不是继续藏在 Copilot 账号登录菜单里。

本设计采用用户确认的方案 C：Full extraction。`opencode-loop-safety@0.1.0` 首发即成为独立 OpenCode 插件，拥有自己的 prompt 注入、设置存储、TUI 命令和发布链路。Copilot 包回迁后不再拥有 Loop Safety 运行时代码。

## 已确认决策

1. 独立包名使用 `opencode-loop-safety`，首发版本为 `0.1.0`。
2. 采用 Full extraction，不做半拆分。
3. 新插件首发就提供真实 Ctrl+P 命令入口。
4. 不为所有插件构造共享顶层菜单容器；各插件使用统一前缀与同一 category 来降低打扰。
5. 统一命名前缀为 `OpenCode J: ...`，Loop Safety 的命令标题为 `OpenCode J: Loop Safety`。
6. Ctrl+P 命令 category 使用 `OpenCode J`。
7. 新插件默认开启 `loopSafetyEnabled`。
8. 新插件默认 `loopSafetyProviderScope` 为 `all-models`。
9. `current-provider` scope 不进入 `0.1.0` 持久化 schema，除非实现阶段确认 OpenCode 运行时能稳定提供当前 provider 语义。
10. Copilot 包迁移完成后，不再拥有 Loop Safety policy 注入、compaction bypass 或 `question` definition 改写。

## 目标

1. 新建可独立发布的 `opencode-loop-safety@0.1.0` 包。
2. 迁移当前 `src/loop-safety-plugin.ts` 的核心能力：固定 policy、`experimental.chat.system.transform`、compaction bypass、provider scope、derived session 跳过、fail-open 行为。
3. 将 `question` tool definition 改写迁移到 `opencode-loop-safety`。
4. 提供真实 TUI command，使用户可以在 Ctrl+P 中看到 `OpenCode J: Loop Safety`。
5. 通过 `OpenCode J: Loop Safety` 管理开关与 provider scope，而不是依赖 Copilot / Codex auth menu。
6. 提供明确的 legacy settings 迁移读取路径，使现有用户升级后继承原来的 Loop Safety 开关。
7. 回迁 `opencode-copilot-account-switcher`，删除 Loop Safety 运行时、菜单项、settings 字段归属和相关 slash command 残留。
8. README、Release Notes、GitHub Release 与 npm publish 全链路遵循仓库 release 护栏。

## 非目标

1. 不在 `opencode-loop-safety@0.1.0` 中实现 `wait` 或 `notify` tool。
2. 不把微信、Copilot retry、Codex retry、账号管理或 quota 查询迁移进 Loop Safety 包。
3. 不创建共享库；少量代码复制优先于过早抽象。
4. 不提供跨插件共享菜单容器。
5. 不保留 Copilot 命名的兼容 shim，例如 `/copilot-policy-all-models` 或 `/copilot-inject`。
6. 不在 `0.1.0` 支持复杂 scope，例如 per-provider、per-model、per-project 或 current-provider。
7. 不改变 `opencode-wait` 与 `opencode-notify-tool` 的公开行为。

## 用户可见行为

### 安装方式

`opencode-loop-safety@0.1.0` 的 README 和 GitHub Release 必须给出明确版本号命令：

```bash
opencode plugin opencode-loop-safety@0.1.0 --force -g
```

不得写成裸包名或 `latest`。如果文档描述局部安装，必须明确说明不带 `-g` 只影响当前项目 `.opencode`。

### 默认行为

安装并启用后：

1. 默认注入 Guided Loop Safety policy。
2. 默认作用范围为所有 provider / model。
3. 如果系统提示里已经包含完整 policy，则不重复追加。
4. compaction 派生出来的继续会话不重复注入 policy。
5. `question` definition 会说明它只负责强交互、最终交接、无安全工作可继续和不确定路由；无人值守等待应交给专用等待工具。
6. `notify` 仍由 `opencode-notify-tool` 拥有定义；Loop Safety 只在 policy 中描述如何使用它。

### Ctrl+P 命令

新插件注册一个真实 TUI command：

- `title`: `OpenCode J: Loop Safety`
- `value`: `opencode-j.loop-safety.settings`
- `category`: `OpenCode J`
- `slash`: `/loop-safety`（若当前 TUI command API 支持 slash metadata；否则通过 config command 提供同名入口）

`onSelect` 打开一个轻量设置视图或选择菜单，至少包含：

1. 当前启用状态：`Guided Loop Safety: On / Off`。
2. 切换启用状态。
3. 当前默认注入范围：`All models` 或 `Copilot only`。
4. 切换默认注入范围。
5. 安装建议：未检测到 `opencode-wait` 或 `opencode-notify-tool` 时，展示带明确版本号的安装命令。

不共享菜单的落地方式是：后续所有插件都注册各自命令，例如 `OpenCode J: Wait`、`OpenCode J: Notify`、`OpenCode J: WeChat`，并统一使用 category `OpenCode J`。这样 Ctrl+P 中会自然聚类，但没有任何插件依赖一个共享菜单宿主。

### 旧命令迁移

Copilot 包里的以下命名属于历史残留，回迁后删除：

- `/copilot-policy-all-models`
- `/copilot-inject`

Loop Safety 包提供通用替代入口：

- Ctrl+P：`OpenCode J: Loop Safety`
- Slash：`/loop-safety`（打开同一设置入口）
- 可选实验入口：`/loop-safety-inject`，仅在实现阶段确认仍需要强制介入 marker 时加入

强制介入 marker 是可选能力。实现阶段如果不保留 `/loop-safety-inject`，必须同时删除 policy、命令注册、测试和文档里的 inject marker 条款，避免残留一个无法触发或仍带 Copilot 命名的规则。

如果继续保留强制介入 marker，必须改为通用命名，并且 policy 常量、命令处理器、tool-output 注入和测试都使用同一组 marker：

```text
[OPENCODE_LOOP_SAFETY_INJECT_V1_BEGIN]
立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。
[OPENCODE_LOOP_SAFETY_INJECT_V1_END]
```

不再新增 Copilot 命名的 marker。旧 `[COPILOT_INJECT_V1_BEGIN]` / `[COPILOT_INJECT_V1_END]` 不作为 `0.1.0` 的兼容契约，也不得继续写入新的 policy 文本。

## 运行时边界

### `opencode-loop-safety` 拥有

1. `LOOP_SAFETY_POLICY` 固定文本。
2. `applyLoopSafetyPolicy()` 纯函数。
3. `createLoopSafetySystemTransform()`。
4. `createCompactionLoopSafetyBypass()`。
5. `experimental.chat.system.transform` hook。
6. `experimental.session.compacting` hook。
7. `tool.definition` 中对 `question` 的说明改写。
8. TUI command：`OpenCode J: Loop Safety`。
9. settings store 与 legacy settings 读取。
10. README、测试、发布 workflow、release notes。

### `opencode-loop-safety` 不拥有

1. `wait` tool。
2. `notify` tool。
3. Copilot / Codex auth loader。
4. Copilot / Codex network retry。
5. Copilot / Codex status command。
6. 微信 broker、bridge 或通知分发。
7. 账号存储、quota 查询或模型路由。

### `opencode-copilot-account-switcher` 回迁后保留

1. Copilot 账号管理。
2. Copilot quota、模型检查、模型账号组和路由。
3. Copilot Network Retry。
4. Copilot status、compact、stop-tool 等仍明确属于 Copilot 的实验命令。
5. Synthetic Agent Initiator。
6. 与微信相关的现有能力，直到后续微信拆分阶段。

### `opencode-copilot-account-switcher` 回迁后删除

1. `src/loop-safety-plugin.ts`。
2. `test/loop-safety-plugin.test.js`，或改为迁移边界测试。
3. `plugin-hooks.ts` 中的 Loop Safety import、`createLoopSafetySystemTransform()`、`createCompactionLoopSafetyBypass()`、`getLoopSafetyProviderScope()` 和 `tool.definition` 中的 `question` 改写。
4. `common-settings-store.ts` 中 Loop Safety 字段的归属与持久化写入。
5. Copilot / Codex auth menu 里的 Loop Safety 开关与 policy scope 开关。
6. `/copilot-policy-all-models` 与 `/copilot-inject`。
7. README 中把 Loop Safety 描述为 Copilot 包内置能力的文案。

`common-settings-store.ts` 仍可保留其他共享设置，例如 `networkRetryEnabled`、`experimentalSlashCommandsEnabled` 与 WeChat 相关字段。回迁只能移除 `loopSafetyEnabled`、`loopSafetyProviderScope` 以及对应 action / menu row，不能顺手删除仍由 Copilot、Codex 或微信使用的 shared settings。

## Settings 设计

### 新存储路径

新插件使用自己的设置文件：

```text
~/.config/opencode/opencode-loop-safety/settings.json
```

`XDG_CONFIG_HOME` 存在时遵循 XDG 规则。测试必须允许传入临时路径。

### 持久化 schema

```ts
type LoopSafetySettings = {
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
}
```

规范化规则：

1. `loopSafetyEnabled` 缺失时视为 `true`。
2. `loopSafetyProviderScope` 缺失时视为 `all-models`。
3. 非法值忽略并落回默认值。
4. 写入时只写规范化后的字段。
5. 不写入 `current-provider`。

### Legacy 读取

为了让现有用户迁移后状态连续，新插件读取 settings 时按优先级合并：

1. 新文件：`~/.config/opencode/opencode-loop-safety/settings.json`。
2. 迁移期 common settings 的物理字段：`~/.config/opencode/account-switcher/settings.json`。
3. 当前 account-switcher Copilot store：`~/.config/opencode/account-switcher/copilot-accounts.json`。
4. 根目录旧 Copilot store：`~/.config/opencode/copilot-accounts.json`。

合并规则：新文件优先；只有更高优先级文件缺少某个字段时，才读取下一层 legacy 字段。写入只写新文件，不回写 legacy 路径。

Legacy reader 必须区分“字段不存在”和“字段存在但值为 `false` / `copilot-only`”。读取 legacy 文件时先解析 partial 字段，不得复用会把缺失字段提前规范化为默认值的 parser；只有所有 legacy 路径都检查完以后，才应用 `loopSafetyEnabled: true` 与 `loopSafetyProviderScope: "all-models"` 这两个新默认值。

## Policy 文本要求

迁移后的固定 policy 继续表达当前双通道规则：

1. 还有非阻塞工作可做时继续做，不因为“想暂停”而停止。
2. 用户可见交互只通过 `question` 或 `notify`，不直接发普通 assistant 文本。
3. 纯进度、阶段切换、非阻塞后台状态属于 `notify`。
4. 需要用户响应、决策、确认、最终交接、无安全工作可继续属于 `question`。
5. 无人值守等待属于专用等待工具；不要把可自动恢复的等待升级成 `question`。
6. 不确定是否需要用户输入时默认 `question`；只是等时间或等预期非用户事件时默认专用等待工具。
7. `notify` 不可用、被拒、缺失或失败时，纯进度静默继续，不升级成 `question`。
8. `question` 不可用、被拒或缺失时，强交互才允许 fallback 到直接文本。
9. 工具可用性不改变交互分类。
10. 用户指出汇报行为错误时，先检查 interaction class 与 channel 是否错配。
11. 最终交接仍属于 `question`，无人值守等待仍属于 wait。

实现可以沿用现有英文 policy 文本中的非 marker 条款；如果保留强制介入能力，必须把 marker 条款改成 `OPENCODE_LOOP_SAFETY_INJECT_V1` 通用命名；如果不保留强制介入能力，必须删除 marker 条款。无论哪种路径，最终 policy 都必须是固定字符串、可测试、幂等，并且不得继续包含 `COPILOT_INJECT_V1`。

## TUI command 设计

实现阶段先以当前 `@opencode-ai/plugin` 与 OpenCode TUI 插件 API 为准。已确认的上游模式是 `api.command.register(() => [commandItems])`，command item 至少支持 `title`、`value`、`category` 与 `onSelect`。

目标结构：

```ts
api.command.register(() => [
  {
    title: "OpenCode J: Loop Safety",
    value: "opencode-j.loop-safety.settings",
    category: "OpenCode J",
    onSelect: async () => {
      await showLoopSafetySettings(api)
    },
  },
])
```

如果当前发布版插件 API 还没有稳定的 TUI command 类型，`0.1.0` 允许在包内添加最小本地类型扩展，但不允许把类型扩展留在 Copilot 包中。

## README 与 Release Notes

README 必须说明：

1. 这个插件做什么：通用 Guided Loop Safety / interaction routing policy。
2. 它不做什么：不提供 `wait` / `notify` / 微信 / Copilot 账号管理。
3. 推荐组合：`opencode-wait@0.1.0` + `opencode-notify-tool@0.1.0` + `opencode-loop-safety@0.1.0`。
4. 明确安装命令：`opencode plugin opencode-loop-safety@0.1.0 --force -g`。
5. Ctrl+P 入口：`OpenCode J: Loop Safety`。
6. 默认行为：默认开启，默认作用于所有模型。
7. 迁移说明：从 Copilot 包内置 Loop Safety 迁移到独立插件。

GitHub Release 正文必须以 `docs/release-notes-template.md` 为唯一模板来源，并包含：

1. 一句价值导语。
2. `## 适合谁升级`。
3. `## 你会看到的变化`。
4. `## 升级方式`。
5. 带明确版本号的升级命令：`opencode plugin opencode-loop-safety@0.1.0 --force -g`。

## 测试策略

### 独立包自动化测试

1. `LOOP_SAFETY_POLICY` 精确匹配固定文本。
2. 开启状态追加 policy；关闭状态不追加。
3. 默认 scope 为 `all-models`，非 Copilot provider 也会注入。
4. `copilot-only` scope 下只对 `github-copilot` 与 `github-copilot-enterprise` 注入。
5. 已存在完整 policy 时不重复追加。
6. compaction bypass 只跳过当前 async context 和当前 session。
7. derived child session 不重复注入。
8. store 读取失败 fail-open，不中断请求。
9. settings 默认值与 legacy 合并规则正确，并验证缺失字段不会被 legacy parser 提前规范化成默认值。
10. 写入只写新 settings 文件。
11. `question` definition 被改写为强交互边界说明。
12. TUI command 注册项包含 `OpenCode J: Loop Safety`、`opencode-j.loop-safety.settings`、`OpenCode J`。
13. `/loop-safety` 入口与 Ctrl+P 入口指向同一设置动作。
14. 如果实现 `/loop-safety-inject`，测试必须覆盖通用 marker；如果不实现，测试必须断言 policy、命令注册和文档中没有 inject marker 残留。
15. `npm pack` 后在临时项目安装 tarball，再从包根 `import("opencode-loop-safety")` 并执行核心 hook driver，验证 `exports`、`main` 与 `files` 配置真实可用。

### Copilot 回迁自动化测试

1. `buildPluginHooks()` 不再暴露 `experimental.chat.system.transform`。
2. `buildPluginHooks()` 不再暴露 `experimental.session.compacting`。
3. `tool.definition` 不再改写 `question`。
4. config 不再注册 `/copilot-policy-all-models` 或 `/copilot-inject`。
5. Copilot menu 不再展示 Guided Loop Safety 开关或 policy scope 开关。
6. Copilot README 不再宣称内置 Loop Safety；只给出独立插件安装建议。
7. Copilot README 不再出现 Copilot 拥有的 `/copilot-inject`、`/copilot-policy-all-models` 或 Guided Loop Safety 菜单开关说明；任何剩余 Loop Safety 提及都必须指向 `opencode-loop-safety@0.1.0`。
8. 现有 Copilot 账号、quota、routing、retry、status、compact、stop-tool 测试继续通过。

### Fresh 验证

发版前必须运行独立包完整验证：

```bash
npm test
```

Copilot 回迁发版前也必须在当前仓库运行 fresh：

```bash
npm test
```

如果 Windows real-host PTY smoke 继续因 `@lydell/node-pty-win32-x64` / `AttachConsole failed` 失败，需要记录为 pre-existing 环境问题，并保留 root worktree 可复现证据。

## Manual QA Gate

### 独立包

1. 用最小 driver script import 新包，执行 system transform，确认 `all-models` 默认下非 Copilot provider 也追加 policy。
2. 用最小 driver script 执行 disabled settings，确认不追加 policy。
3. 用最小 TUI command driver 调用 plugin load，确认命令列表出现 `OpenCode J: Loop Safety`。
4. 对实际采用的 `/loop-safety` 实现路径做 driver：如果 runtime 支持 command item slash metadata，则验证 slash metadata；如果使用 `config.command["loop-safety"]` fallback，则验证 `command.execute.before` 打开同一设置动作。两条路径不得重复注册。
5. `npm pack` 后在临时项目安装 tarball，从包根 import 并执行核心 hook，确认 packaged surface 与源码 driver 一致。
6. 如果能启动真实 OpenCode TUI，则安装本地 pack 后按 Ctrl+P 查找 `OpenCode J: Loop Safety`，进入后切换开关并确认 settings 文件写入。

### Copilot 回迁

1. 构建 Copilot 包。
2. 用 plugin hook driver 确认不再注册 Loop Safety transform、compaction hook 和 `question` definition 改写。
3. 用菜单 driver 确认 Copilot / Codex auth menu 中没有 Loop Safety 项。
4. 用 README grep 或文档测试确认不再出现 Copilot 拥有的 `/copilot-inject`、`/copilot-policy-all-models` 或内置 Guided Loop Safety 菜单说明。
5. 运行现有 pack 或 smoke 流程，确认 Copilot 基础插件仍可加载。

## 发布链路

独立包发布链路必须完整：

1. 版本固定为 `0.1.0`。
2. README 与 package metadata 指向 `opencode-loop-safety` 仓库。
3. `npm test` fresh 通过。
4. `npm pack` tarball 安装 smoke 通过。
5. `npm publish` 成功。
6. Git tag 推送。
7. GitHub Release 使用模板创建成功。
8. 远端 npm 与 GitHub Release 状态均已确认。

Copilot 回迁链路单独执行：

1. 回迁代码与文档。
2. fresh `npm test` 或明确记录 pre-existing Windows PTY 失败。
3. 提交并推送回迁分支。
4. release commit、tag、push、`npm publish`、GitHub Release 作为同一条链路处理。
5. npm 远端版本与 GitHub Release 远端状态都确认后，才算 Copilot 回迁 release 完成。

## 风险与缓解

### 风险 1：Loop Safety 与 Copilot 残留耦合

缓解：Copilot 回迁测试必须断言没有 Loop Safety hooks、question definition 改写、policy scope 命令和 auth menu 项。

### 风险 2：默认 all-models 改变用户预期

缓解：README、Release Notes 与 Ctrl+P 设置页明确写出默认作用范围。用户可以切换为 `copilot-only`。

### 风险 3：缺少 wait / notify 时 policy 误导模型

缓解：policy 明确 fallback：`notify` 不可用时纯进度静默继续，等待工具不可用时不能把无人值守等待升级成 `question`。设置页提供明确安装命令。

### 风险 4：TUI command API 版本漂移

缓解：实现阶段以当前安装的 `@opencode-ai/plugin` 类型和 OpenCode TUI runtime 为准；若类型缺失，只在独立包内加最小本地扩展。Manual QA 必须实际读取 command 注册结果或在 TUI 中看到命令。

### 风险 5：release notes 再次偏离模板

缓解：发版前以 `docs/release-notes-template.md` 为唯一来源，检查 `## 适合谁升级`、`## 你会看到的变化`、`## 升级方式` 和明确版本号命令。

## 验收标准

1. `opencode-loop-safety@0.1.0` 可以独立安装。
2. `OpenCode J: Loop Safety` 出现在 Ctrl+P 命令中。
3. 新插件默认开启并默认作用于所有模型。
4. 新插件拥有 `question` definition 改写、system transform 与 compaction bypass。
5. 新插件不实现 `wait` / `notify`。
6. Copilot 包不再拥有 Loop Safety 运行时代码或菜单项。
7. README 与 Release Notes 都使用明确版本号安装命令。
8. 自动化测试、构建、pack/driver 和 manual QA 均有 fresh 证据。
9. npm publish 与 GitHub Release 远端状态均已确认。
