# WeChat Broker-Bridge WebSocket 全双工重设计

## 背景

当前 broker↔bridge 链路已经暴露出结构性性能与健康度问题，而不是简单的参数调优问题：

1. 现有连接模型仍然建立在“单 pending 请求 + 应用层 heartbeat + 常态 full sync”上。
2. `createWechatBridgeLifecycle()` 每 `10s` 发一次 heartbeat，而 `brokerClient.send()` 同一时刻只能有一个 pending 请求。
3. 只要上一轮 heartbeat 或其后续 `syncWechatNotifications` 还没完成，下一轮 heartbeat 就可能因为 `broker client has pending request` 被我们自己判成失败，再触发 reconnect。
4. 这会在高实例数下主动制造 `stale -> recovered` churn，进而把 `/status` 拖成 `timeout/unreachable`，也让 `/reply` / `/allow` 出现“broker 先报超时、bridge 后来又处理成功”的错位。

这说明问题根因不再是“当前 transport 是 TCP 还是别的”，而是：

- 连接层不是全双工事件流
- 上层状态同步依赖 full sync 常态路径
- 命令生命周期没有把“未送达 / 已接受处理中 / 已完成 / 已失败”明确拆开

用户已经明确希望直接砍掉当前设计，在 WebSocket 全双工连接上重新设计一条高性能且健康的 broker↔bridge 模型，并允许连协议与磁盘状态一起重做。

## 目标

1. 用 WebSocket 全双工长连接重做 broker↔bridge 连接层。
2. 移除当前 `heartbeat + single pending + full sync 常态路径` 这套组合。
3. 让 broker 维护权威状态视图，`/status` 正常情况下直接读 broker 视图，而不是逐实例 fan-out live collect。
4. 让 `/reply` / `/allow` / `natural-stop` 的命令链至少区分：
   - 未送达
   - 已被 bridge 接受处理中
   - 已完成
   - 已失败
5. 让 full sync 只作为重连后的兜底，而不是日常同步主路径。
6. 保留当前用户可见微信合同：question / permission / terminal result / natural-stop / retry-error 文案与 slash 语义继续成立，不因为连接层重做而缩水。

## 非目标

1. 这轮不重新发明 question / permission / terminal result / natural-stop / retry-error 的用户文案合同。
2. 不在这轮引入 broker 去中心化、bridge 互联或 bridge↔bridge 直连。
3. 不要求新旧 TCP/WS 模型长期共存。
4. 不把这轮升级做成“用户需要手工清状态目录才能恢复”的破坏式迁移。
5. 不先做完整事件溯源平台或长期无限日志保留。

## 方案选择

### 方案 A：事件流 + broker 权威状态机

做法：

1. 保留中心 broker。
2. broker↔bridge 改成一条长期 WS 连接。
3. bridge 主动推送业务事件，broker 落成权威状态。
4. full sync 只在重连/断档时兜底。

优点：

- 能直接砍掉当前 `single pending + heartbeat 后 full sync` 的常态路径。
- 结构上已经足够接近用户想要的“双方互相信任的事件驱动”。
- 实现代价明显低于完整事件日志总线。

缺点：

- 仍需要定义幂等、重放、ack、水位等协议细节。
- 如果后续想做更强的事件审计，还要再升级一层。

### 方案 B：带序号的命令/事件总线

做法：

1. 仍保留中心 broker。
2. 所有 bridge->broker 事件和 broker->bridge 命令都带序号。
3. broker 保存短期可回放事件日志与 ack 水位。
4. 重连优先 replay 缺失事件，只在无法 replay 时 full sync。

优点：

- 结构最健康，最符合“全双工 + 互相信任事件”的目标。
- 连接活性、事件积压、命令状态、重放/断档都能形成标准化诊断。
- 最利于根治当前 `/status`、`/reply`、`/allow` 的时序错位问题。

缺点：

- 一次性改动最大：连接层、协议层、持久化状态、测试模型都要一起重做。

### 方案 C：只换 WS transport

做法：

- 只把当前 TCP/NDJSON transport 换成 WebSocket，尽量保留现有 request/reply + sync 策略。

优点：

- 改动面最小。

缺点：

- 很可能只是把现有 churn 模型搬到新的 transport 上。
- 无法真正解决 full sync 常态化与命令状态错位。

### 结论

采用 **方案 B：带序号的命令/事件总线**。

原因：用户已经明确允许不兼容升级、允许重做协议与状态格式，并且希望从根上重做成高性能、健康、真正全双工的模型。在这个前提下，继续做“只换 transport”或“半升级事件流”都容易留下当前设计惯性。既然要砍，就应该一次把“序号、ack、水位、重放、权威状态”一并立起来。

## 总体架构

新架构仍保留 **broker 作为唯一中心节点**，但 broker 的职责升级为：

1. **权威事件总线**
   - 维护所有 broker↔bridge 双向帧的连接级序号、实例级事件序号、命令 ack 与执行结果。
2. **权威状态机**
   - 直接维护每个 bridge 的在线状态、session 概览、open question / permission / natural-stop、terminal metadata、retry-error 摘要。
3. **恢复协调器**
   - 在 bridge 重连时，根据双方水位决定是 replay 缺失事件还是要求 full sync。

bridge 的职责则收窄为：

1. 维护本地 OpenCode 侧事实来源。
2. 把这些事实变化持续推送成事件。
3. 接受 broker 下发的命令并回报 `commandAccepted` / `commandResult`。

正常路径下，broker 不再 fan-out live collect，也不再依赖 heartbeat 成功后 full sync。日常状态推进依赖 WS 上的连续事件流。

## 协议合同

### 1. 连接建立

bridge 与 broker 建立 WS 连接后，先发 `hello/register`：

- `protocolVersion`
- `stateGeneration`（或等价字段，用于区分这套新权威状态格式）
- `instanceID`
- `instanceIncarnation`（bridge 本次进程/实例重建代际；同一 `instanceID` 重启后必须变化）
- bridge 描述信息（实例名、目录、pid、project）
- `lastSeenBrokerSeq`
- `lastSentEventSeq`
- 可选的轻量当前状态摘要

broker 返回 `registerAck`：

- `protocolVersion`
- `stateGeneration`
- 当前连接 session / auth 信息
- broker 认定的最新 `brokerSeq`
- 是否连续
- 是否需要 `replay`
- 是否必须 `fullSync`

如果 broker 与 bridge 的 `protocolVersion/stateGeneration` 不兼容，broker 不能模糊接入；必须走以下固定行为之一：

1. 明确拒绝当前连接并要求 bridge 走新协议重新注册。
2. 忽略旧状态、要求 full sync 进入新的状态代际。

不允许出现“新 broker 混读旧状态、新 bridge 混写旧状态”的半兼容路径。

### 1.1 帧类型总表

这轮协议必须先把帧分类写死，避免 plan 阶段自行发明：

1. **bridge -> broker sequenced event**
   - 必带 `eventSeq`
   - 必须持久化后再 `ack`
   - 包括：
     - `instanceOnline`
     - `instanceOffline`
     - `sessionSnapshotChanged`
     - `questionOpened / questionUpdated / questionClosed`
     - `permissionOpened / permissionUpdated / permissionClosed`
     - `naturalStopOpened / naturalStopClosed`
     - `retryErrorUpdated`
     - `commandAccepted`
     - `commandResult`
2. **broker -> bridge command**
   - 必带 `brokerSeq + commandId`
   - 由 broker 权威命令账本跟踪生命周期
   - 包括：
     - `replyQuestion`
     - `replyPermission`
     - `replyNaturalStop`
3. **broker -> bridge control frame**
   - 必带 `brokerSeq + controlId`
   - 不进入权威命令账本，也不走 `commandAccepted / commandResult`
   - 只承载恢复控制语义
   - 包括：
     - `requestReplay`
     - `requestFullSync`
4. **broker -> bridge ack frame**
   - 用于确认 broker 已持久化并应用某个 `eventSeq`
   - 推进该连接的 `lastAckedEventSeq`
5. **bridge -> broker full-sync completion frame**
   - 属于 bridge -> broker sequenced event
   - 必带 `eventSeq + instanceIncarnation + controlId`
   - 包括：
     - `fullSyncCompleted`

也就是说：

- `requestReplay / requestFullSync` 只属于 control frame
- 它们不进入权威命令账本
- `fullSyncCompleted` 属于 bridge -> broker sequenced event，因此必须被 broker `ack`

### 2. bridge -> broker 事件

bridge 不再发送“请你来 collect / sync”的命令式请求，而是主动推事件：

- `instanceOnline`
- `instanceOffline`
- `sessionSnapshotChanged`
- `questionOpened`
- `questionUpdated`
- `questionClosed`
- `permissionOpened`
- `permissionUpdated`
- `permissionClosed`
- `naturalStopOpened`
- `naturalStopClosed`
- `retryErrorUpdated`
- `commandAccepted`
- `commandResult`

每条事件都必须带：

- `eventSeq`（实例内单调递增）
- `instanceIncarnation`
- 事件种类
- 业务 payload
- 必要的幂等键 / 版本戳 / 发生时间

broker 落盘并应用状态后回 `ack`，推进该连接的 `lastAckedEventSeq`。

`commandAccepted` 与 `commandResult` 都属于 bridge -> broker sequenced event，因此都必须带 `eventSeq`，也都必须被 broker `ack`。`commandResult` 不能脱离 `commandAccepted` 单独存在；如果 broker 没看到 `commandAccepted`，则该命令不能直接进入“已接受处理中”状态。

### 3. broker -> bridge 命令

broker 下发的命令至少包括：

- `replyQuestion`
- `replyPermission`
- `replyNaturalStop`

每条命令都带 `brokerSeq + commandId`。bridge 收到命令后：

1. 先回 `commandAccepted`
2. 执行业务
3. 最终回 `commandResult`

这样 broker 才能明确区分：

- 命令没送达
- 命令已被接受但执行中
- 命令最终成功
- 命令最终失败

这是当前 `/reply` / `/allow` / `natural-stop` “有些超时但实际回复了”的可观测性修复核心。

`requestReplay / requestFullSync` 不属于这组业务命令。它们只属于上一节定义的 broker -> bridge control frame，遵循 `brokerSeq + controlId + completion semantics`，不进入权威命令账本，也不适用 `commandAccepted / commandResult` 生命周期。

broker 必须维护一份**权威命令账本**，至少记录：

- `commandId`
- `brokerSeq`
- `target identity`
- 当前状态：`queued / delivered / accepted / completed / failed`
- `acceptedAt`
- `completedAt`
- `failure`

bridge 也必须按 `commandId` 去重；如果同一命令因重连/replay 被重复下发，bridge 不能重复执行用户动作。

### 4. 序号、重放与 full sync

broker 为每个连接维护：

- `lastAckedEventSeq`
- `lastSentBrokerSeq`
- 最近一段可回放 broker 命令日志
- 最近一段 bridge 事件窗口或其最低可恢复水位

重连恢复顺序固定为：

1. **优先 replay**：broker 要求 bridge 补 `[N, M]` 缺失事件。
2. **无法 replay 时才 full sync**：
   - 序号断档
   - 日志过期
   - broker 丢状态
   - bridge 无法确认从哪里恢复

`requestReplay` 必须至少带：

- `instanceID`
- `instanceIncarnation`
- `brokerSeq`
- `controlId`
- 缺失区间 `[fromEventSeq, toEventSeq]`

bridge 对 `requestReplay` 的完成条件是：把这段区间的 sequenced events 补齐并推进 `lastSentEventSeq`。broker 只有在缺失区间被补齐并 `ack` 后，才算 replay 完成。

`requestFullSync` 必须至少带：

- `instanceID`
- `instanceIncarnation`
- `brokerSeq`
- `controlId`
- 触发原因（断档/日志过期/状态丢失/无法确认恢复水位）

bridge 对 `requestFullSync` 的响应必须分成两步：

1. 发送一组明确边界的 full snapshot sequenced events
2. 发送 `fullSyncCompleted` 作为“快照补齐结束、后续重新回到增量事件流”的分界

`fullSyncCompleted` 必须带：

- `eventSeq`
- `instanceIncarnation`
- 对应的 `controlId`

broker 只有在整组 full snapshot events 被应用、并收到 `fullSyncCompleted` 且成功 `ack` 后，才算这轮 full sync 完成。

### 4.1 full sync 的替换语义

full sync 不是“把一堆快照 merge 进去就算完”，而必须写死替换规则。对每个 `instanceID + instanceIncarnation`，full sync 至少覆盖以下**活状态域**：

- 连接在线状态
- session 概览
- open question
- open permission
- active natural-stop
- retry-error 摘要

当 broker 收到 `fullSyncCompleted` 后，这些活状态域必须按**整域替换**处理：

1. full snapshot 中出现的对象，成为新的权威活状态。
2. full snapshot 中未出现、但旧权威视图里仍存在的活对象，必须被视为已离开活集合并按各自规则关闭/移除。

但以下**保留域**不能因为 snapshot omission 被静默清掉：

- terminal metadata
- terminal result 去重状态
- `s*` retained occupancy

这些保留域只能按各自 retention / terminal 规则清理，不能被 full sync 直接抹掉。

也就是说，full sync 必须从“常态同步策略”退化成“灾难恢复兜底”。

## broker 权威状态视图

broker 持久化的权威状态至少包括：

1. 连接状态
   - 连接是否在线
   - 最近 broker seq / event seq / ack 水位
   - 最近连接时间 / 断开时间 / 原因
2. 实例状态
   - 当前实例描述
   - session 概览
   - 最近 retry-error 摘要
   - 当前 `instanceIncarnation`
   - 最近连接/重连代际信息
3. 可交互对象
   - open question：至少含 `requestID / routeKey / handle / prompt summary / updatedAt`
   - open permission：至少含 `requestID / routeKey / handle / prompt summary / updatedAt`
   - active natural-stop：至少含 `handle / replyTarget / redactedSummary / severityAdvice / updatedAt / retainedUntil(or equivalent occupancy rule)`
   - terminal metadata：至少含 `reason / replacementHandle / terminalResultSent / retainedUntil(or equivalent occupancy rule)`
   - retry-error 摘要：至少含 `sessionID / action / redactedSummary / severityAdvice / updatedAt`
4. 权威命令账本
   - `commandId / brokerSeq / target identity / queued|delivered|accepted|completed|failed / acceptedAt / completedAt / failure`

`/status` 正常情况下直接从这份权威视图聚合，不再临时 fan-out 到每个实例去 live collect。

## 用户能力保持合同

虽然连接层与状态格式允许重做，但以下用户可见能力必须保持：

1. `question / permission / terminal result / natural-stop / retry-error` 的文案合同继续成立。
2. `/reply <qid>`、`/allow <handle>`、`/reply <s*>` 继续成立。
3. terminal reason、old qid/handle 的稳定关闭提示、`s*` handle 唯一性与保留期约束继续成立。
4. ordinary retry-error 仍是 informational only；natural-stop 仍是 replyable。

这轮重设计的目标是“换连接模型，不缩水用户能力”。

后续 plan 与实现必须明确把**上一轮已收口的微信用户合同回归**纳入验证范围，而不是只验证新 WS 协议本身。

## 状态迁移与升级策略

用户已允许这轮不兼容，所以：

1. 不要求新旧连接层长期共存。
2. 可以重做当前 broker / instance / notification / request 的磁盘状态格式。
3. 但升级后不能要求用户手工清状态目录才能恢复。

升级策略要求：

1. broker 启动时优先从自己的权威状态视图恢复。
2. bridge 连接后通过 `registerAck` 决定 replay 还是 full sync。
3. 如果旧格式状态无法直接迁移，broker 必须能安全忽略旧状态并通过 reconnect + replay/full sync 自恢复，而不是让系统卡死在半迁移状态。

因此必须引入显式的 `protocolVersion/stateGeneration` 与 broker 状态 schema marker。新 broker 启动时要先判断：

- 当前磁盘状态是否属于本代际
- bridge 报告的 `protocolVersion/stateGeneration` 是否属于本代际

如果不属于本代际，只允许：

1. 拒绝旧连接并要求新协议重连；或
2. 安全忽略旧状态并重建新状态

不允许混读混写。

此外，升级后仍必须保留最小用户可见 retained state 保障。允许两种实现路径，但必须二选一写死到 plan：

1. **迁移保留**：迁移并保留最小 retained state，至少包括：
   - terminal metadata
   - terminal result 去重状态
   - `s*` occupancy 约束
2. **稳定升级关闭**：如果旧 retained state 无法迁移，则 broker 必须为旧代际 handle 提供稳定的“升级关闭原因”拒绝层，至少不能退化成 `not found`。

无论选哪条，都不允许因为协议/状态代际切换，把旧 qid/handle 的用户面行为直接打回“未找到”。

## 实现边界

这轮明确允许重做：

- broker↔bridge transport
- protocol framing
- 连接状态模型
- broker 权威持久化视图
- replay / full sync 恢复策略

这轮不要求重做：

- 微信用户文案合同本身
- question / permission / natural-stop / terminal result 的用户级语义定义
- README / release / 其它无关子系统

## 测试策略

### 1. 协议与状态机

至少覆盖：

- `hello/register` 与 `registerAck`
- 连接级序号 / 实例级事件序号单调递增
- `ack` 推进逻辑
- replay 请求与缺失事件补齐
- full sync fallback 只在断档/日志过期/状态丢失时触发
- 重复事件 / 旧事件幂等

### 2. 命令链

至少覆盖：

- `commandAccepted` 与 `commandResult` 分离
- broker 能区分：
  - 未送达
  - 已接受处理中
  - 已完成
  - 已失败
- `/reply` / `/allow` / `natural-stop` 不再出现“broker 先超时、bridge 后来成功”的用户级错位

同时必须固定命令在断线前后的规则：

- `accepted` 之前：broker 可以按同一 `commandId` 重投，bridge 必须按 `commandId` 去重。
- `accepted` 之后：broker 不得再次执行该命令；只能等待 `commandResult`，或按固定执行超时/实例离线规则把它转成 `failed`。
- 如果用户再次触发同一动作，而旧命令仍处于 `accepted` 未终态，broker 必须返回稳定“已有处理中命令”语义，而不是再生成第二个并发命令。

### 3. `/status`

至少覆盖：

- 正常路径只读 broker 权威视图
- 不再逐实例 fan-out live collect 才能拿主视图
- 少量 bridge 抖动不会把整条 `/status` 拖成 5 秒
- 断档/缺视图时才触发 full sync

### 4. 性能与健康度

至少覆盖：

- 去掉当前 churn 根因：不再有“上一轮 heartbeat 没回，下一轮自己把自己打成失败重连”这条链
- broker diagnostics / bridge diagnostics 能直接看出：
  - 连接是否在线
  - 事件是否积压
  - 命令是否 accepted
  - 命令最终结果
  - replay 是否触发
  - full sync 是否触发

### 5. 现有微信用户合同回归

至少要求原有相关测试继续通过，或用等价新测试显式覆盖以下行为：

- question / permission / terminal result / natural-stop / retry-error 的用户文案合同不缩水
- `/reply <qid>`、`/allow <handle>`、`/reply <s*>` 的 slash 语义保持稳定
- terminal reason、old qid/handle 的稳定关闭提示继续成立
- `s*` handle 的唯一性与保留期不回退
- ordinary retry-error 仍是 informational only；natural-stop 仍是 replyable

### 6. 升级与恢复

至少覆盖：

- broker 带旧格式/不可迁移状态启动时不会卡死
- 可以安全忽略旧状态并通过 reconnect + replay/full sync 自恢复
- 用户不需要手工删除状态目录就能恢复到可用状态
- 旧代际 handle 不会退化成 `not found`；要么复用迁移后的 retained state，要么返回稳定升级关闭原因

## 成功判定

1. broker↔bridge 日常同步以事件流为主，full sync 只作为兜底而不是常态。
2. `/status` 不再依赖逐实例 live collect 才能拿主视图。
3. `/reply` / `/allow` / `natural-stop` 至少能稳定区分：
   - 未送达
   - 已接受处理中
   - 已完成
   - 已失败
4. 设计上彻底移除当前 `heartbeat + single pending + full sync 常态路径`，而不是继续保留一半旧模型。
5. 新模型不要求用户手工清状态目录才能升级恢复。
6. 当前微信用户面能力不缩水。
