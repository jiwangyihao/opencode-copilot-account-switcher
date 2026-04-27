# WeChat `/status` 排版与 `/todo` 待处理事项设计

## 背景

当前 WeChat slash 入口已经通过 broker authoritative view 驱动 `/status`，并通过 `handle` 路由 `/reply`、`/allow`、natural-stop 回复。现有 `/status` 输出可以展示会话、todo、question/permission 数量、运行工具和不可用状态，但实例与会话之间缺少清晰分隔，用户在多个实例同时在线时难以定位信息。

另外，待回复 question 当前只显示问题摘要，不稳定暴露可直接回复的用户可操作 ID。微信通知通道不稳定时，用户可能错过 question、permission 或 natural-stop 通知，之后不知道该用哪个 ID 回复或处理。

## 目标

- 改善 `/status` 输出排版，让不同实例、不同会话之间有明确分隔和标题。
- 在 `/status` 中，只要存在待回复 question，就显示可操作 `QID`，这里的 `QID` 指用户可用于 `/reply` 的 handle，例如 `q1`，不是内部 `requestID`。
- 新增 `/todo` 命令，统一展示当前待用户回复或处理的事项。
- `/todo` 覆盖 active question、active permission、active natural-stop，并给出可直接复制的命令示例。
- 继续避免泄露内部 `instanceID`、`sessionID`、`requestID`、`routeKey` 等实现细节。

## 非目标

- 不改变 question、permission、natural-stop 的现有回复协议。
- 不改通知发送、重试、dead-letter 或 recovery 语义。
- 不把 `/todo` 做成完整任务管理器；它只展示当前 broker 视图里仍需用户处理的事项。

## 方案选择

采用方案 A：增强 `/status` 并新增 `/todo`。

`/status` 保持“运行状态总览”的职责，重点展示实例、会话和当前运行状态；新增分隔与标题，并在待回复 question 旁显示 `QID`。

`/todo` 专注“我现在需要回复什么/处理什么”，从同一份 broker authoritative view 读取 active question、active permission、active natural-stop，按类型分组展示可操作 ID 和命令示例。

## `/status` 输出设计

输出结构：

```text
wechat status

## 实例：Broker 权威实例
---
### 会话：发布主线
`#busy` `#todo:4` `#question:1` `#permission:0`
[ ] 发布 release 草稿
问题：是否继续处理当前 slash 请求

待回复问题
QID：q1
回复：/reply q1 你的回复
running tool: bash
```

规则：

- 顶部保留 `wechat status`。
- 每个实例使用标题和分隔线，避免多个实例混在一起。
- 每个会话使用标题和 tag 行。
- `/status` 必须保证 `view.active.questions` 中每个非空 question `handle` 至少出现一次 `QID`。
- question 的 `QID` 来自 active question record 的 `handle`，不得用 `requestID`、`routeKey`、`sessionID` 或其它内部字段兜底。
- active question record 当前不保证携带 `sessionID`。如果后续 record 有可用 `sessionID`，可以把 `QID` 贴到对应会话；否则在对应实例段内增加“待回复问题”小节展示 `QID`、摘要和 `/reply` 示例。
- `/status` 的 top sessions 裁剪策略可以保留，但不能决定 `QID` 是否展示；即使某个待回复 question 不属于已展示会话，也必须在实例段中展示。
- 如果只有 bridge live snapshot 的问题摘要、没有 authoritative active question handle，则继续显示摘要，但不伪造 `QID`。
- permission 和 natural-stop 的完整可操作清单放在 `/todo`，避免 `/status` 过长。
- 当存在待处理 permission 或 natural-stop 时，`/status` 可以提示“完整待处理清单见 /todo”。
- timeout/unreachable 实例也作为独立实例段展示。

## `/todo` 输出设计

新增 slash 命令：`/todo`。

空状态：

```text
当前没有待回复或待处理事项
```

有待处理事项时：

```text
待处理事项

【问题】
- QID：q1
  摘要：是否继续处理当前 slash 请求
  回复：/reply q1 你的回复

【权限】
- PID：p1
  摘要：bash: npm test
  允许一次：/allow p1 once
  始终允许：/allow p1 always
  拒绝：/allow p1 reject

【自然结束】
- SID：s1
  摘要：需要补充自然中止说明
  建议：已停止并等待你的回复
  回复：/reply s1 继续处理
```

规则：

- question 使用 `QID`，permission 使用 `PID`，natural-stop 使用 `SID`，三者都映射到现有 handle。
- `QID`、`PID`、`SID` 只是展示标签，值均为现有用户可操作 handle；`SID` 不是内部 `sessionID`。
- `/todo` 不展示 `/status` 里的普通 session `todoItems`，只展示需要用户回复或处理的 question、permission、natural-stop。
- `/todo` 只展示 `brokerView.active.naturalStops` 中的 active natural-stop，明确排除 `legacyHandleClosures`、`retainedOccupancy`、`terminalMetadata` 中的已结束记录。
- question 摘要：如果 `prompt.title` 非空，优先展示 `prompt.title`；其次展示非空 `prompt.body`；否则显示“待回复问题”。
- permission 摘要：如果 `prompt.title` 非空，优先展示 `prompt.title`；如果 `prompt.description` 非空，有 title 时展示为 `${title}：${description}`，无 title 时直接展示 description；否则显示“待处理权限请求”。`prompt.type` 只作为可读补充，不作为内部 ID 暴露。
- natural-stop 摘要：优先展示 `redactedSummary`，缺失时显示“需要补充自然中止说明”；`severityAdvice` 非空时固定追加一行 `建议：${severityAdvice}`。
- 同类型内按 `createdAt` 升序排序；缺少 `createdAt` 时按 handle 字典序排序，保证输出可预测。

## 数据流

- `command-parser.ts` 新增 `/todo` 命令类型。
- `broker-entry.ts` 的 slash handler 对 `/todo` 读取 `readBrokerAuthoritativeView()`。
- `status-format.ts` 继续负责 `/status` 格式化，并新增 `formatTodoReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string` 供 `/todo` 调用。
- `status-format.ts` 的 `/status` broker-view 入口必须先从 `view.active.questions` 派生用户可操作 question 列表，字段只读取非空 `handle`、`prompt`、`createdAt`、`scopeKey/instanceID`；不得使用 `routeKey`、`requestID` 作为用户可见 fallback。
- `/status` 的 question handle 补充只来自 broker authoritative view 的 `active.questions`，避免依赖通知是否已成功送达微信。
- `/todo` 也只读 broker authoritative view，不读取微信通知发送状态；这样即使通知丢失，也能恢复当前可操作 ID。
- `createBrokerWechatSlashCommandHandler()` 必须在 `/allow` 处理前显式处理 `command.type === "todo"`；同时把权限分支改成显式 `command.type === "allow"`，避免未来新增命令误入权限处理逻辑。
- `startBrokerServer()` 返回的旧 `handleWechatSlashCommand()` 也要显式处理 `/todo`，避免 `{ type: "todo" }` 落入旧的 `/allow` 未实现文案。

## 测试计划

- 更新 command parser 测试，测试名覆盖 `/status /todo /reply /allow /recover`，断言 `/todo` 可识别，同时 `/todox` 和 `/todo extra` 不被误识别。
- 更新 `/status` formatter 测试，断言 `wechat status`、实例标题、会话标题、分隔线数量、实例顺序、会话顺序稳定。
- 更新 `/status` QID 测试，断言待回复 question 同时出现 `QID：q1` 和 `回复：/reply q1 你的回复`。
- 增加 `/status` 负例测试：只有 bridge live snapshot 问题摘要、没有 broker active handle 时，保留问题摘要，但不出现 `QID：` 或 `/reply q`。
- 增加 `/status` 截断保护测试：active question 不在 top sessions 中或没有 `sessionID` 时，`/status` 仍显示该 question 的 `QID`。
- 更新 broker-entry slash handler 测试，确认 `/todo` 能从 active question、permission、natural-stop 输出完整用户可操作清单。
- 增加 `/todo` 三类事项测试，断言 `QID：q1`、`PID：p1`、`SID：s1`，以及 `/reply q1 ...`、`/allow p1 once`、`/allow p1 always`、`/allow p1 reject`、`/reply s1 ...`。
- 增加 `/todo` 空状态测试，确认无待处理事项时返回精确文案 `当前没有待回复或待处理事项`。
- 增加排序稳定测试：同类型事项用乱序 `createdAt` 和同时间 handle，断言输出顺序可预测。
- 保留“不泄露内部 ID”的断言，继续禁止 `requestID`、`sessionID`、`instanceID`、`routeKey` 及其具体内部值出现在输出中；同时允许显示用户可操作 handle，例如 `q1`、`p1`、`s1`。

## 自检

- 无未定义占位符或未完成章节。
- 范围限定在 `/status` 文案、`/todo` 命令解析与格式化，不触碰通知投递和回复协议。
- `QID` 明确定义为用户可操作 handle，避免与内部 `requestID` 混淆。
- `/todo` 的存在理由是通知通道不稳定时恢复可操作 ID，和 `/status` 的运行总览职责不冲突。
