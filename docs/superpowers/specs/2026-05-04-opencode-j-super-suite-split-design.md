# OpenCode J Super Suite 插件拆分总体设计

## 背景

当前 `opencode-copilot-account-switcher` 已经从 Copilot 账号切换扩展为一组混合能力：Copilot/Codex 账号、模型路由、网络重试、Guided Loop Safety、`wait`/`notify` 工具、slash commands、微信 broker 与通知等。

这些能力并不都属于 Copilot 领域。继续把它们放在同一个插件里，会带来 3 个问题：

1. 用户无法只安装通用工具，例如只需要 `wait` 或 `notify` 的用户也会被迫安装 Copilot 相关能力。
2. 通用策略与领域能力互相缠绕，例如 prompt 注入策略依赖 `wait` / `notify`，但它本身不应属于 Copilot 账号插件。
3. 新功能继续堆叠在 `plugin.ts`、`plugin-hooks.ts`、provider adapter、menu/settings 入口中，会让后续维护越来越依赖全局上下文。

本设计定义的是总体拆分精神：先划清独立插件边界，再从小到大迁移；最终形成可独立安装、可按需组合的 OpenCode 插件集合。

## 目标

1. 把当前混合插件拆成多个独立 npm 包，每个包都是用户可单独启用的 OpenCode 插件。
2. 保留 Copilot 领域能力的聚合体验：Copilot 相关功能继续集中在 `opencode-copilot-account-switcher` 中。
3. 把 `wait`、`notify`、Loop Safety、Codex、微信等非 Copilot 能力从 Copilot 包中分离出去。
4. 新建 `opencode-j-super-suite` 作为总览仓库，介绍插件矩阵、推荐组合、迁移路径和版本兼容关系。
5. 避免过早抽象共享库。只有真实复用被证明必要时，才抽取共享库。

## 非目标

1. 不把 Copilot 能力拆成多个用户可见插件。Copilot retry、Copilot status、模型路由、账号切换都属于 `opencode-copilot-account-switcher` 的内部模块。
2. 不为了拆分而预设 `toolkit`、`core`、`shared` 等公共库。
3. 不要求用户通过一个整合包使用所有能力。整合体验可以存在，但不能取代独立安装。
4. 不在第一阶段改变现有用户默认行为。迁移必须分阶段进行，并给出清晰升级说明。

## 最终插件边界

### `opencode-wait`

通用 `wait` 工具插件。

职责：

- 提供 `wait` tool。
- 支持固定秒数等待和等待新用户消息等现有行为。
- 独立测试工具定义、参数校验与实际等待行为。

边界：

- 不依赖 Copilot、Codex、微信或 Loop Safety。
- 不关心 prompt 注入策略，只提供工具能力。

### `opencode-notify`

通用 `notify` 工具插件。

职责：

- 提供 `notify` tool。
- 保留现有通知语义和参数约定。
- 为其他插件提供可依赖的通知能力名称与行为契约。

边界：

- 不依赖 Copilot、Codex、微信或 Loop Safety。
- 不内置微信传输；微信通知属于 `opencode-wechat`。

### `opencode-loop-safety`

通用 Guided Loop Safety / prompt 注入策略插件。

职责：

- 注入 Loop Safety 相关系统提示。
- 定义长任务、自然停止、`question` / `notify` / `wait` 使用策略。
- 在检测到 `opencode-wait` 与 `opencode-notify` 时启用完整工具协作说明。
- 在工具缺失时降级为不依赖缺失工具的策略，并给出可理解的安装建议或能力说明。

边界：

- 弱依赖 `opencode-wait` 与 `opencode-notify`。
- 不依赖 Copilot 账号、quota、路由或 retry。
- 不实现 `wait` / `notify`，只依赖它们的公开能力。

### `opencode-copilot-account-switcher`

现有包最终收敛为 Copilot 专属插件包。

职责：

- Copilot 多账号管理。
- 从 OpenCode auth 导入 Copilot 账号。
- Copilot quota 查询与展示。
- Copilot 模型账号映射与路由。
- Copilot 网络重试、错误识别与修复策略。
- Copilot slash commands、Copilot 状态命令、Copilot 菜单与设置。

边界：

- Copilot 相关功能在包内聚合，不拆成用户可见的 `copilot-retry`、`copilot-status`、`copilot-routing` 插件。
- 不拥有 `wait`、`notify`、Loop Safety、Codex 或微信。
- 可以弱集成 `opencode-notify`、`opencode-loop-safety` 或 `opencode-wechat`，但不能要求这些插件反向依赖 Copilot 包。

### `opencode-codex-account-switcher`

Codex 专属插件包。

职责：

- Codex 账号管理。
- Codex OAuth / snapshot loader。
- Codex status 与 Codex retry。
- Codex 菜单与设置。

边界：

- 不混入 Copilot 包。
- 不继承 Copilot 的 header rewrite、`x-initiator`、模型账号映射等专属语义。
- 与 Copilot 共享实现的前提是共享点被真实证明稳定且必要。

### `opencode-wechat`

通用微信通知与远程交互插件。

职责：

- 微信 broker、bridge、绑定流程、通知分发、请求状态与调试信息。
- 作为远程通知/交互通道接入 OpenCode。
- 通过公开协议弱集成 `opencode-notify`、`opencode-loop-safety`、Copilot/Codex 状态。

边界：

- 不属于 Copilot 插件。
- 不要求 Copilot/Codex 必须安装。
- 与 Copilot/Codex 的状态展示、debug bundle、菜单入口必须通过扩展协议或显式适配层接入，不能直接穿透对方内部实现。

## `opencode-j-super-suite` 总览仓库

`opencode-j-super-suite` 是这组插件的总览与推荐组合入口。

职责：

1. 介绍所有独立插件的能力、安装方式和适用场景。
2. 提供能力矩阵：哪些插件完全独立，哪些插件弱依赖其他插件，哪些组合能获得完整体验。
3. 提供迁移指南：现有 `opencode-copilot-account-switcher` 用户如何迁移到按需组合。
4. 维护版本兼容表：各插件版本之间的已验证组合。
5. 提供示例配置：只装 `wait`、只装 `notify`、`wait + notify + loop-safety`、Copilot 全功能组合、微信远程通知组合等。

`opencode-j-super-suite` 可以在成熟后增加整合包能力，但这不是第一阶段要求。即使提供整合包，也必须保留每个独立插件的手动安装路径。

## 共享库原则

默认不创建共享库。共享库只有同时满足以下条件时才允许出现：

1. 同一逻辑已经被至少两个独立插件真实复用。
2. 复用接口稳定，不依赖某个具体插件的内部状态。
3. 抽库不会把已拆开的插件重新耦合到一个中心包。
4. 复制维护成本已经高于抽库和版本管理成本。

在条件未满足前，共享候选代码应优先留在具体插件内部。少量重复可以接受，过早抽象不接受。

## 依赖规则

### 强依赖

只有当插件缺少某个依赖就无法正确运行时，才允许强依赖。

示例：如果某个包只是另一个包的适配入口，并且没有基础包就没有任何可用功能，可以使用强依赖。

### 弱依赖

当依赖只影响增强体验时，应使用弱依赖。

示例：

- `opencode-loop-safety` 弱依赖 `opencode-wait` 与 `opencode-notify`。
- `opencode-wechat` 弱集成 `opencode-notify` 的通知语义。
- `opencode-copilot-account-switcher` 可以弱集成 `opencode-wechat` 的远程状态展示。

弱依赖必须有明确降级行为：插件缺失时继续运行，并说明缺失的是增强能力，而不是静默失败。

### 禁止反向依赖

独立插件不能依赖 `opencode-j-super-suite`。总览仓库或整合包只能依赖独立插件，不能成为独立插件运行所需的中心。

## 分阶段迁移顺序

### 第一阶段：模块归属盘点

先创建模块归属表，把现有文件标记为以下类别之一：

- `wait`
- `notify`
- `loop-safety`
- `copilot`
- `codex`
- `wechat`
- `shared-candidate`
- `migration-glue`

归属表的目的不是立即移动文件，而是防止实现阶段继续凭感觉拆分。

### 第二阶段：拆出 `opencode-wait`

`wait` 是最小、最通用的能力，优先拆出。

验收要求：

- `opencode-wait` 可单独安装和启用。
- `wait` 工具行为与当前插件内行为一致。
- 当前仓库在迁移期仍能通过适配或依赖保持原有 `wait` 行为。

### 第三阶段：拆出 `opencode-notify`

`notify` 与 Copilot 无关，应成为第二个独立工具插件。

验收要求：

- `opencode-notify` 可单独安装和启用。
- `notify` 工具不拉入 Copilot、Codex 或微信依赖。
- `opencode-loop-safety` 后续可以通过弱依赖使用它。

### 第四阶段：拆出 `opencode-loop-safety`

Loop Safety 是通用策略插件，不属于 Copilot 包。

验收要求：

- prompt 注入策略从 Copilot 包中脱离。
- 缺失 `wait` 或 `notify` 时有明确降级行为。
- 安装 `wait + notify + loop-safety` 时，可以获得当前完整的工具协作策略。

### 第五阶段：收敛 Copilot 包

把现有 `opencode-copilot-account-switcher` 清理成 Copilot 专属包。

验收要求：

- Copilot 账号、quota、模型路由、retry、status、菜单与设置仍聚合在一个包内。
- Copilot 包不再拥有 `wait`、`notify`、Loop Safety、Codex、微信的实现。
- Copilot 用户只安装这个包时，可以获得完整 Copilot 相关能力。

### 第六阶段：拆出 Codex 与微信

Codex 作为独立领域插件，微信作为通用远程通知/交互插件。

验收要求：

- `opencode-codex-account-switcher` 不继承 Copilot 专属语义。
- `opencode-wechat` 不依赖 Copilot/Codex 的内部实现。
- 如果存在跨插件状态展示，必须通过公开协议或显式适配层实现。

### 第七阶段：建设 `opencode-j-super-suite`

在独立插件边界稳定后，建设总览仓库。

验收要求：

- 提供插件矩阵、推荐组合、迁移路径、版本兼容表和示例配置。
- 不强制用户使用整合包。
- 如提供整合包，它只是推荐组合入口，不是独立插件的运行中心。

## 测试策略

每个独立插件都需要 3 类验证：

1. **单插件验证：** 插件可独立安装、独立启用、独立执行核心行为。
2. **组合验证：** 典型组合能工作，例如 `wait + notify + loop-safety`、Copilot 包单独使用、Copilot + 微信、Codex + 微信。
3. **迁移验证：** 从当前单包体验迁移到多插件组合后，用户可见行为没有意外丢失。

当前仓库每一步迁移都应至少运行相关 targeted tests 与 `npm run build`。发版前必须按仓库护栏运行 fresh `npm test`，并按 release 模板写清楚版本和用户可见变化。

## 风险与缓解

### 风险 1：把 Copilot 继续拆得过碎

缓解：Copilot 相关能力对用户只暴露一个包。内部可以模块化，但不拆成多个用户可见 Copilot 子插件。

### 风险 2：过早创建共享库

缓解：共享库必须满足真实复用、接口稳定、不重新耦合、维护收益明确这 4 个条件。

### 风险 3：弱依赖行为不清晰

缓解：每个弱依赖都必须定义缺失时的运行行为、用户提示和测试用例。

### 风险 4：迁移过程中破坏现有用户体验

缓解：拆分顺序从最独立的 `wait` / `notify` 开始；现有包逐步收敛为 Copilot 包，并在 `opencode-j-super-suite` 中给出明确迁移组合。

### 风险 5：微信与 Copilot 状态继续隐式耦合

缓解：微信插件只通过公开协议或显式适配层读取状态，不直接导入 Copilot 内部模块。

## 预期结果

完成拆分后，应达到以下状态：

1. 用户可以只安装 `opencode-wait` 或 `opencode-notify`。
2. 用户可以组合 `opencode-wait + opencode-notify + opencode-loop-safety`，获得通用 Loop Safety 工作流。
3. Copilot 用户安装 `opencode-copilot-account-switcher` 即可获得完整 Copilot 相关能力。
4. Codex 与微信不再混在 Copilot 包中。
5. `opencode-j-super-suite` 作为总览仓库，帮助用户理解、选择和迁移这些插件。
6. 共享库只在确有必要时出现，不成为新的耦合中心。
