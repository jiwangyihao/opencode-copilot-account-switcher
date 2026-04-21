# WeChat Broker-Bridge WebSocket 全双工重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用带序号的 WebSocket 双向命令/事件总线重做 broker↔bridge 连接层，移除当前 `heartbeat + single pending + full sync 常态路径`，同时保持现有微信用户能力不缩水。

**Architecture:** 保留中心 broker，但把它升级成权威事件总线 + 权威状态机 + 恢复协调器。bridge 通过 WS 持续推送带 `eventSeq` 的业务事件，broker 维护权威视图与命令账本；`/status` 正常读 broker 视图，`reply/allow/natural-stop` 走 `commandAccepted -> commandResult` 生命周期；replay 为主，full sync 仅兜底。

**Tech Stack:** TypeScript、Node.js test runner、现有 WeChat broker/bridge 插件架构、WebSocket（Node 内置或轻量实现）、新的 broker 权威状态持久化。

---

## 文件结构预分解

- `src/wechat/protocol.ts`
  - 重写为新的 WS 帧定义：sequenced event / command / control / ack / fullSyncCompleted。
- `src/wechat/broker-state-store.ts`
  - 新建。承载 broker 权威状态视图与最小持久化格式：连接状态、实例状态、可交互对象、命令账本、水位。
- `src/wechat/broker-server.ts`
  - 改为 WS server，负责 register、ack、replay/fullSync 协调、命令派发、权威状态应用。
- `src/wechat/broker-client.ts`
  - 改为 bridge 侧 WS client，不再有单 pending request 模式。
- `src/wechat/broker-launcher.ts`
  - 改为新的 WS broker 启动、探活与连接入口，不再依赖旧 socket ping。
- `src/wechat/broker-endpoint.ts`
  - 扩展为支持 WS endpoint 的解析与规范化。
- `src/wechat/state-paths.ts`
  - 为新的 broker 权威状态文件与 schema marker 提供独立路径，避免和现有 `broker.json` 启动元数据撞路径。
- `src/wechat/bridge.ts`
  - 改为事件生产者 + 命令消费者：主动推送 session/question/permission/natural-stop/retry-error 事件，并回 `commandAccepted` / `commandResult`。
- `src/plugin-hooks.ts`
  - 接入新的 WS lifecycle，移除旧 heartbeat/reconnect 假设。
- `src/wechat/broker-entry.ts`
  - slash handler 从 broker 权威状态与命令账本读取 `/status` / `/reply` / `/allow` / `natural-stop` 结果。
- `test/wechat-ws-protocol.test.js`
  - 新建。锁定帧模型、序号、control vs command 分类。
- `test/wechat-broker-state-store.test.js`
  - 新建。锁定权威视图、命令账本、full sync 替换语义、retained 域不被清掉。
- `test/wechat-broker-ws-lifecycle.test.js`
  - 新建。锁定 register / replay / fullSync / command lifecycle / reconnect。
- `test/wechat-plugin-hooks-status.test.js`
  - 验证 plugin-hooks 接入新 lifecycle 后仍正确初始化/切换/清理。
- `test/wechat-status-flow.test.js`
  - 保留用户面回归：`/status`、`/reply`、`/allow`、`natural-stop`、terminal reason、`s*` 保留期等。

### Task 1: 定义 WS 帧模型与 broker 权威状态持久化

**Files:**
- Create: `src/wechat/broker-state-store.ts`
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/state-paths.ts`
- Test: `test/wechat-ws-protocol.test.js`
- Test: `test/wechat-broker-state-store.test.js`

- [ ] **Step 1: 先写失败测试，锁定新的帧类型总表与最小权威状态字段**

在 `test/wechat-ws-protocol.test.js` 与 `test/wechat-broker-state-store.test.js` 先写至少 6 条红灯测试：

```js
test("ws protocol: commandAccepted 与 commandResult 都属于 sequenced event", async () => {
  const protocol = await import("../dist/wechat/protocol.js?reload=ws-protocol-command-events")

  const accepted = protocol.createBridgeEventEnvelope({
    type: "commandAccepted",
    eventSeq: 11,
    instanceIncarnation: "inc-1",
    payload: { commandId: "cmd-1" },
  })

  assert.equal(accepted.eventSeq, 11)
  assert.equal(accepted.type, "commandAccepted")
})

test("ws protocol: requestReplay 与 requestFullSync 是 control frame，不属于 command", async () => {
  const protocol = await import("../dist/wechat/protocol.js?reload=ws-protocol-control-frames")

  const replay = protocol.createBrokerControlEnvelope({
    type: "requestReplay",
    brokerSeq: 21,
    controlId: "ctl-1",
    payload: { fromEventSeq: 9, toEventSeq: 12 },
  })

  assert.equal(replay.controlId, "ctl-1")
  assert.equal("commandId" in replay, false)
})

test("broker state store: full sync 只替换活状态域，不清 terminal metadata 与 s* occupancy", async () => {
  const store = await import("../dist/wechat/broker-state-store.js?reload=ws-broker-state-store-full-sync")
  const state = store.createEmptyBrokerState()

  // 先放一个 retained terminal 与一个 active natural-stop
  // 再应用 full sync，断言活对象被整域替换、retained 域保留
})

test("broker state store: command ledger 保存 queued/delivered/accepted/completed/failed", async () => {
  const store = await import("../dist/wechat/broker-state-store.js?reload=ws-broker-state-store-command-ledger")
  // 断言 command ledger 最小字段存在且状态推进受控
})

test("ws protocol: hello/register 与 registerAck 带 protocolVersion/stateGeneration/instanceIncarnation", async () => {
  const protocol = await import("../dist/wechat/protocol.js?reload=ws-protocol-register")
  // 断言 register / registerAck 最小 payload 结构存在
})

test("state paths: broker-state-store 与 broker.json 启动元数据分路径", async () => {
  const statePaths = await import("../dist/wechat/state-paths.js?reload=ws-state-paths")
  // 断言 brokerStateStorePath()/brokerStateSchemaPath() 与 brokerStatePath() 不同
})

test("ws protocol: ack frame 会推进 lastAckedEventSeq", async () => {
  const protocol = await import("../dist/wechat/protocol.js?reload=ws-protocol-ack")
  const store = await import("../dist/wechat/broker-state-store.js?reload=ws-broker-state-store-ack")
  // 断言 createBrokerAckEnvelope()/等价工厂存在，并能推进连接的 lastAckedEventSeq
})
```

- [ ] **Step 2: 跑定向测试，确认当前代码还不具备这些类型与状态模型**

Run: `npm run build && node --test test/wechat-ws-protocol.test.js test/wechat-broker-state-store.test.js`

Expected:
- `protocol.ts` 里还没有新的帧工厂 / union
- `broker-state-store.ts` 文件尚不存在
- `state-paths.ts` 里还没有新的 broker-state-store/schema 路径
- 新测试明确红灯，而不是被旧结构假绿

- [ ] **Step 3: 最小实现新的协议与权威状态 store**

在 `src/wechat/protocol.ts` 与 `src/wechat/broker-state-store.ts` 落最小实现，至少把以下硬约束变成代码：

```ts
export type BrokerToBridgeCommand = {
  brokerSeq: number
  commandId: string
  type: "replyQuestion" | "replyPermission" | "replyNaturalStop"
  payload: unknown
}

export type BrokerToBridgeControl = {
  brokerSeq: number
  controlId: string
  type: "requestReplay" | "requestFullSync"
  payload: unknown
}

export type BridgeToBrokerEvent = {
  eventSeq: number
  instanceIncarnation: string
  type:
    | "instanceOnline"
    | "instanceOffline"
    | "sessionSnapshotChanged"
    | "questionOpened"
    | "questionUpdated"
    | "questionClosed"
    | "permissionOpened"
    | "permissionUpdated"
    | "permissionClosed"
    | "naturalStopOpened"
    | "naturalStopClosed"
    | "retryErrorUpdated"
    | "commandAccepted"
    | "commandResult"
    | "fullSyncCompleted"
  payload: unknown
}

export type BrokerCommandStatus = "queued" | "delivered" | "accepted" | "completed" | "failed"
```

`broker-state-store.ts` 至少提供：

```ts
export function createEmptyBrokerState() { /* ... */ }
export function applyBridgeEvent(state, event) { /* ... */ }
export function applyFullSyncSnapshot(state, snapshot) { /* ... */ }
export function upsertBrokerCommand(state, command) { /* ... */ }
export function markBrokerCommandAccepted(state, input) { /* ... */ }
export function markBrokerCommandResult(state, input) { /* ... */ }
export function markConnectionAckedEventSeq(state, input) { /* ... */ }
```

同时把协议闭包一并落地：

```ts
export type HelloRegisterPayload = {
  protocolVersion: number
  stateGeneration: string
  instanceID: string
  instanceIncarnation: string
  lastSeenBrokerSeq?: number
  lastSentEventSeq?: number
}

export type RegisterAckPayload = {
  protocolVersion: number
  stateGeneration: string
  brokerSeq: number
  needReplay: boolean
  needFullSync: boolean
}

export type BrokerAckPayload = {
  ackedEventSeq: number
  instanceIncarnation: string
}
```

- [ ] **Step 4: 重新跑定向测试，确认新模型独立成立**

Run: `npm run build && node --test test/wechat-ws-protocol.test.js test/wechat-broker-state-store.test.js`

Expected: PASS，且输出里没有用旧 TCP/NDJSON 结构硬凑出来的兼容假绿。

### Task 2: 重做 broker↔bridge WS 连接、register/replay/full sync 与命令账本

**Files:**
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-launcher.ts`
- Modify: `src/wechat/broker-endpoint.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-state-store.ts`
- Test: `test/wechat-broker-ws-lifecycle.test.js`
- Test: `test/wechat-broker-state-store.test.js`

- [ ] **Step 1: 先写失败测试，锁定 WS 连接生命周期与命令状态机**

在 `test/wechat-broker-ws-lifecycle.test.js` 先写红灯测试，至少覆盖：

```js
test("ws lifecycle: bridge register 后 broker 只要求 replay 缺失事件，不无脑 full sync", async () => {
  // 给 broker 一个已知 lastAckedEventSeq，bridge 带 lastSentEventSeq 重连
  // 断言 broker 发 requestReplay 而不是 requestFullSync
})

test("ws lifecycle: commandAccepted 之后 broker 不再重投同一 commandId", async () => {
  // 先 delivered -> accepted，模拟断线重连
  // 断言 broker 保持 accepted 并等待 commandResult，而不是重发
})

test("ws lifecycle: delivered 但未 accepted 的命令可按同一 commandId 重投", async () => {
  // 断言 bridge 需按 commandId 去重
})

test("ws lifecycle: fullSyncCompleted 之前不切换到新的活状态视图", async () => {
  // 断言 snapshot events 与 completed 信号共同决定 full sync 完成
})

test("ws lifecycle: hello/register 与 registerAck 会按 protocolVersion/stateGeneration 协商", async () => {
  // 断言不兼容代际不会模糊接入
})
```

- [ ] **Step 2: 跑定向测试，确认当前连接模型还是旧的 heartbeat/single-pending**

Run: `npm run build && node --test test/wechat-broker-ws-lifecycle.test.js`

Expected:
- 当前 `broker-client.ts` 仍是单 pending
- 当前 `bridge.ts` 仍在 heartbeat 成功后 sync
- 新测试红灯

- [ ] **Step 3: 最小实现 WS lifecycle 与命令账本推进**

实现约束：

- 删除 `brokerClient.send()` 的单 pending 限制，不再让 heartbeat 与业务命令共用一个 pending 槽。
- `createWechatBridgeLifecycle()` 不再按当前 heartbeat tick 成功后做 full sync。
- register 之后由 broker 基于水位决定 `requestReplay` 或 `requestFullSync`。
- broker 端命令账本状态推进严格受控：
  - `queued -> delivered`
  - `delivered -> accepted`
  - `accepted -> completed|failed`
- `requestReplay / requestFullSync` 作为 control frame 处理，不进入命令账本
- `fullSyncCompleted` 到达之前不得切换活状态视图

核心代码方向：

```ts
// broker-client.ts
export async function connectWs(input) { /* 持久 WS + sendEvent + handleCommand */ }

// bridge.ts
export async function createWechatBridgeLifecycle(input) {
  // register -> replay/fullSync -> steady event stream
}

// broker-server.ts
function handleBridgeEvent(event) { /* apply + ack */ }
function dispatchCommand(command) { /* ledger + send */ }
```

- [ ] **Step 4: 重新跑 lifecycle 测试，确认回复链可区分 accepted 与 result**

Run: `npm run build && node --test test/wechat-broker-ws-lifecycle.test.js test/wechat-broker-state-store.test.js`

Expected: PASS，且不再存在“单 pending + overlap 直接自判失败”的结构。

### Task 3: 把 `/status`、replyability 与现有微信用户合同接到 broker 权威视图上

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/notification-store.ts`
- Modify: `src/wechat/notification-dispatcher.ts`
- Modify: `src/wechat/notification-format.ts`
- Modify: `src/wechat/status-format.ts`
- Test: `test/wechat-plugin-hooks-status.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁定“用户面不缩水”与 `/status` 权威视图化**

新增或改写定向回归，至少覆盖：

```js
test("status flow: /status 正常直接读 broker 权威视图，不再 fan-out live collect", async () => {
  // 模拟 broker state 已有 11 个实例视图
  // 断言不需要逐实例 collect 仍可聚合出 reply
})

test("status flow: /reply 在 commandAccepted 后可见处理中语义，而不是直接 timeout", async () => {
  // 断言 slash 回复能区分 accepted / completed / failed
})

test("notification flow: question/permission/terminal result/natural-stop/retry-error 的既有用户合同继续成立", async () => {
  // 显式保留或迁移上一轮回归：
  // - terminal reason 与旧 qid/handle 的稳定关闭提示
  // - s* handle 唯一性与保留期
  // - ordinary retry-error informational only
  // - natural-stop 仍 replyable
})

test("status flow: question/permission 的 terminal reason 与旧 qid/handle 稳定关闭提示继续成立", async () => {
  // old qid/handle 的 terminal reason 与关闭文案不能缩水
})

test("status flow: s* handle 唯一性与保留期继续成立", async () => {
  // old terminal s* 不复用，continued/replied/expired 后仍固定拒绝
})

test("status flow: /reply <qid> /allow <handle> /reply <s*> 在 accepted/completed/failed 下有稳定用户文案", async () => {
  // 三类 slash 动作都要覆盖命令账本状态对应的用户语义
})

test("notification flow: ordinary retry-error 仍 informational-only，natural-stop 仍 replyable", async () => {
  // 防止用户面语义被新的 WS 连接层顺手冲掉
})

test("plugin-hooks: 接入 WS lifecycle 后不会再建立旧 heartbeat churn 假设", async () => {
  // 断言初始化/切 key/close 仍正确
})

test("broker-entry: 同一 slash 动作在 accepted 未终态时返回稳定已有处理中命令", async () => {
  // 按 action identity 复用旧命令，而不是并发创建第二个命令
})
```

- [ ] **Step 2: 跑定向测试，确认旧模型仍在依赖 live collect 与即时 RPC 等待**

Run: `npm run build && node --test test/wechat-plugin-hooks-status.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`

Expected: 新增“权威视图直读”“accepted 处理中语义”“旧用户合同不缩水”相关断言先失败。

- [ ] **Step 3: 最小接线到 broker 权威视图**

实现要点：

- `plugin-hooks.ts` 接入新的 WS lifecycle，不再建立旧 heartbeat/reconnect 语义假设。
- `broker-entry.ts` 的 `/status` 直接读 broker 权威视图；`/reply` / `/allow` / `natural-stop` 读取命令账本状态，生成更准确的“未送达 / 处理中 / 完成 / 失败”用户文案。
- `notification-store.ts` / `notification-dispatcher.ts` / `notification-format.ts` 继续保持上一轮 question / permission / terminal result / natural-stop / retry-error 用户合同。

“同一动作”的最小判等规则必须先写死：至少由 `command type + target identity + normalized user payload`（或等价字段）组成，用来支持“已有处理中命令”语义。

最小代码骨架：

```ts
// broker-entry.ts
const commandState = await readBrokerCommandStateByAction(actionKey)
if (commandState?.status === "accepted") {
  return "命令已被实例接受，正在处理中"
}

// /status
const brokerView = await readBrokerAuthoritativeView()
return formatAggregatedStatusReplyFromBrokerView(brokerView)
```

这些 API 归属必须固定为：

- `readBrokerAuthoritativeView()`：`src/wechat/broker-state-store.ts`
- `readBrokerCommandStateByAction()`：`src/wechat/broker-state-store.ts`
- `formatAggregatedStatusReplyFromBrokerView()`：`src/wechat/status-format.ts`

- [ ] **Step 4: 重新跑用户面回归，确认新连接层不缩水**

Run: `npm run build && node --test test/wechat-plugin-hooks-status.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`

Expected: PASS，且 `/status` 不再依赖 live collect、旧 question/permission/terminal/natural-stop/retry-error 合同仍成立。

### Task 4: 升级恢复与整套验证

**Files:**
- Modify: `package.json`
- Modify: `src/wechat/broker-launcher.ts`
- Modify: `src/wechat/broker-endpoint.ts`
- Modify: `src/wechat/state-paths.ts`
- Modify: `src/wechat/broker-state-store.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/wechat/broker-entry.ts`
- Test: `test/wechat-ws-protocol.test.js`
- Test: `test/wechat-broker-state-store.test.js`
- Test: `test/wechat-broker-ws-lifecycle.test.js`
- Test: `test/wechat-plugin-hooks-status.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁定升级恢复与默认测试入口**

至少新增：

```js
test("upgrade: broker 遇到旧状态代际时不会卡死，并能通过 reconnect + full sync 自恢复", async () => {
  // 放旧格式状态目录，断言新 broker 能忽略并恢复
})

test("upgrade: 旧代际 qid/handle/s* 不会退化成 not found", async () => {
  // 要么命中迁移后的 retained state
  // 要么返回稳定升级关闭原因
})

test("default npm test: 新 WS 模型下完整测试集可以自然结束", async () => {
  // 若 runner 需要分片，这里锁 runner 本身的覆盖与自然退出
})
```

- [ ] **Step 2: 跑相关定向验证，确认升级边界先红**

Run: `npm run build && node --test test/wechat-ws-protocol.test.js test/wechat-broker-state-store.test.js test/wechat-broker-ws-lifecycle.test.js test/wechat-status-flow.test.js`

Expected: 旧状态代际、fullSync fallback、默认 runner 收尾等回归先失败或明确未实现。

- [ ] **Step 3: 最小实现升级边界与测试入口收尾**

实现要求：

- `protocolVersion/stateGeneration` 与 broker schema marker 真正接入启动路径。
- 旧状态不可迁移时，broker 能安全忽略并通过 WS 重连恢复。
- 旧代际 handle 的策略二选一必须明确落地：迁移 retained state，或返回稳定升级关闭原因。
- 如果默认 `npm test` 需要新的 runner/shard 才能稳定覆盖，应把它固化在 `package.json` 与脚本中，而不是靠手工命令。

- [ ] **Step 4: 跑完整 fresh 验证并按 spec checklist 做人工验收**

Run: `npm test`

Expected:
- 命令自然结束
- 无失败
- 新 WS 模型下 `/status`、`/reply`、`/allow`、`natural-stop` 的用户合同不缩水

人工验收 checklist：

- [ ] 正常情况下 broker↔bridge 日常同步以事件流推进，full sync 只在兜底时出现
- [ ] `/status` 正常不再 fan-out live collect
- [ ] `/reply` / `/allow` / `natural-stop` 至少能区分未送达 / 已接受处理中 / 已完成 / 已失败
- [ ] 当前 question/permission/terminal result/natural-stop/retry-error 用户合同继续成立
- [ ] 升级后不需要用户手工清状态目录才能恢复
- [ ] 旧代际 `qid/handle/s*` 不会退化成 `not found`
