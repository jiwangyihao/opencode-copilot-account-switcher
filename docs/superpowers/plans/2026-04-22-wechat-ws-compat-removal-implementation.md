# WeChat WS Compat 清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不缩水现有微信用户合同的前提下，删除 broker↔bridge 运行时主路径里的 compat / sidecar 代码，并把 `broker-state-store` 收成唯一真相源。

**Architecture:** 先把所有用户面判定、fallback toast、terminal reason、命令账本状态都明确落到 `broker-state-store`，再切断 live 主路径对 `registerInstance / heartbeat / statusSnapshot / syncWechatNotifications / 旧 reply envelope / 旧 store` 的依赖，最后删除 compat transport 与旧 diagnostics 主语义。升级时只允许“导入 retained state”或“生成稳定升级关闭原因”两种承接，不允许旧 `qid/handle/s*` 退化成 `not found`。

**Tech Stack:** TypeScript、Node.js test runner、现有 sharded `npm test`、broker-state-store 权威视图、WS command/event 协议。

---

## 文件结构预分解

- `src/wechat/broker-state-store.ts`
  - 唯一权威真相源；补 fallback toast / retained state / 升级关闭原因 / diagnostics 索引。
- `src/wechat/broker-entry.ts`
  - `/status`、`/reply`、`/allow`、`/reply <s*>` 只从 `broker-state-store` 读用户面语义，不再回查旧 store 补洞。
- `src/wechat/status-format.ts`
  - 继续承担权威视图到用户文案的纯格式化，不回退 live collect 或旧 store。
- `src/wechat/notification-format.ts`
  - 接住 fallback toast / retry / terminal 的新统一语义，不再为 compat sidecar 单独保留分支。
- `src/wechat/protocol.ts`
  - 删除旧 compat envelope 类型，只保留 WS command / control / sequenced event 所需模型。
- `src/wechat/broker-client.ts`
  - 删除 `registerInstance / heartbeat / statusSnapshot / syncWechatNotifications / 旧 reply envelope fallback` 主实现，仅保留 WS live path。
- `src/wechat/broker-server.ts`
  - 删除 compat `registerInstance / heartbeat / statusSnapshot / syncWechatNotifications / showFallbackToast` 主路径，保留单一 WS live coordinator。
- `src/wechat/bridge.ts`
  - 删除 `registerHello` 后补 compat `registerInstance` 的 sidecar，以及 steady keepalive 下的旧补偿逻辑。
- `src/wechat/request-store.ts`
  - 从运行时主路径退出；只保留升级导入 / 稳定关闭原因所需最小承接，避免继续参与 broker↔bridge 判定。
- `src/wechat/notification-store.ts`
  - 同上；只保留 retained occupancy / 导入承接 / 必要历史闭环，不再作为 broker↔bridge 主真相源。
- `src/wechat/token-store.ts`
  - 从 broker↔bridge 运行时判定中退出；若仍保留，只能承担导入材料或离线历史数据用途。
- `src/wechat/state-paths.ts`
  - 明确 `broker-state-store`、升级导入、旧 retained state 承接文件的路径边界。
- `package.json`
  - 默认 `npm test` 继续完整覆盖，但删除只为 compat 残影服务的 runner 例外或旧命令入口。
- `test/wechat-broker-state-store.test.js`
  - 锁唯一真相源、升级关闭原因、retained state 导入与不回查旧 store。
- `test/wechat-broker-ws-lifecycle.test.js`
  - 锁单一 WS live path、无 compat transport fallback、fallback toast 新归属。
- `test/wechat-status-flow.test.js`
  - 锁 `/status`、`/reply`、`/allow`、`/reply <s*>` 用户合同继续成立且只读新真相源。
- `test/wechat-notification-flow.test.js`
  - 锁 terminal result、retry / natural-stop / fallback 文案与 retained handle 语义不缩水。
- `test/wechat-plugin-hooks-status.test.js`
  - 锁 plugin-hooks 不再给旧 compat lifecycle 背书，只接当前 WS 主路径。

### Task 1: 把剩余用户合同完整收进 broker-state-store

**Files:**
- Modify: `src/wechat/broker-state-store.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/status-format.ts`
- Modify: `src/wechat/notification-format.ts`
- Test: `test/wechat-broker-state-store.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁“只读 broker-state-store 也不缩水”**

在 `test/wechat-broker-state-store.test.js` 和 `test/wechat-status-flow.test.js` 增加至少这些回归：

```js
test("broker-state-store: retained terminal metadata 与 s* occupancy 可独立承接旧入口关闭原因", async () => {
  const store = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}`)
  const state = store.createEmptyBrokerState()

  store.writeLegacyHandleClosure(state, {
    kind: "question",
    handle: "q99",
    reason: "upgraded",
    message: "此入口已在升级后关闭，请查看新入口或重新获取通知",
  })

  assert.equal(store.readLegacyHandleClosure(state, { kind: "question", handle: "q99" })?.reason, "upgraded")
})

test("broker-entry slash handler: /status 只读 broker-state-store，不回查旧 request/notification store", async () => {
  const result = await handler({ type: "status" })
  assert.match(result, /Active Sessions|当前会话/i)
  assert.doesNotMatch(result, /collectStatus|statusSnapshot|timeout\/unreachable/i)
})

test("broker-entry slash handler: 旧 qid/handle/s* 不退化成 not found，而是稳定升级关闭原因", async () => {
  assert.match(await replyHandler({ type: "reply", handle: "q99", text: "hello" }), /升级后已关闭|已结束/)
  assert.match(await allowHandler({ type: "allow", handle: "p99", reply: "once" }), /升级后已关闭|已结束/)
  assert.match(await naturalStopHandler({ type: "reply", handle: "s99", text: "hello" }), /升级后已关闭|已结束/)
})
```

- [ ] **Step 2: 跑定向测试确认当前行为先被锁住**

Run: `npm run build && node --test test/wechat-broker-state-store.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: 新增“只读 broker-state-store / 升级关闭原因 / retained occupancy”回归先失败，证明现状仍依赖旧 store 或缺承接索引。

- [ ] **Step 3: 最小实现，把用户面读路径全部收进 broker-state-store**

实现时明确写死这几条：

```ts
// broker-state-store.ts
export function readBrokerAuthoritativeView(state) {
  return {
    instances: state.active.instances,
    sessions: state.active.sessions,
    questions: state.active.questions,
    permissions: state.active.permissions,
    naturalStops: state.active.naturalStops,
    retryErrors: state.active.retryErrors,
    terminalMetadata: state.terminalMetadata,
    retainedOccupancy: state.retainedOccupancy,
    commandLedger: state.commandLedger,
    legacyHandleClosures: state.legacyHandleClosures,
  }
}

// broker-entry.ts
const authoritativeView = readBrokerAuthoritativeView(currentBrokerState)
const legacyClosure = readLegacyHandleClosure(currentBrokerState, { kind, handle })
// 所有 slash fallback 先查权威视图 / legacy close reason，不再回查旧 store
```

实现检查点：
- `/status`、`/reply`、`/allow`、`/reply <s*>` 的用户合同在这一步就全部改为只读 `broker-state-store`
- fallback toast / retry / terminal 文案如需读状态，也只能从新真相源拿
- 不允许为了“先过测试”继续从 `request-store / notification-store / instances` 回查运行时状态

- [ ] **Step 4: 再跑测试确认 broker-state-store 已经足够承接用户合同**

Run: `npm run build && node --test test/wechat-broker-state-store.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: 相关回归转绿；旧入口不会退化成 `not found`，`/status` 不再依赖旧 live collect 语义。

### Task 2: 删除 compat transport 与 sidecar 主路径

**Files:**
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-state-store.ts`
- Modify: `src/wechat/state-paths.ts`
- Modify: `src/wechat/notification-format.ts`
- Modify: `src/wechat/status-format.ts`
- Test: `test/wechat-broker-ws-lifecycle.test.js`
- Test: `test/wechat-plugin-hooks-status.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁“主路径里已经不再走 compat transport”**

新增至少这些回归：

```js
// 在 test/wechat-broker-ws-lifecycle.test.js 内新增本地 helper：
// - sendCompatFrameToLiveServer(endpoint, line): Promise<Envelope>
// - renderBrokerAuthoritativeFailureView(state): string

test("ws lifecycle live path: runtime 主路径不再调用 registerInstance/heartbeat/statusSnapshot/syncWechatNotifications", async () => {
  const lifecycleModule = await import(`../dist/wechat/bridge.js?reload=${Date.now()}`)
  const calls = []
  const client = {
    setLiveHandlers: () => {},
    registerHello: async () => {
      calls.push("registerHello")
      return {
        ack: {
          protocolVersion: 2,
          stateGeneration: "wechat-ws-v1",
          instanceIncarnation: "inc-a",
          brokerSeq: 1,
          needReplay: false,
          needFullSync: false,
        },
        control: undefined,
      }
    },
    registerInstance: async () => { calls.push("registerInstance") },
    heartbeat: async () => { calls.push("heartbeat") },
    sendStatusSnapshot: async () => { calls.push("statusSnapshot") },
    sendSyncWechatNotifications: async () => { calls.push("syncWechatNotifications") },
    ping: async () => {},
    close: async () => {},
  }

  const lifecycle = await lifecycleModule.createWechatBridgeLifecycle({
    directory: "/workspace/ws-compat-removal",
    client: {
      session: { list: async () => [], status: async () => ({}), todo: async () => [], messages: async () => [] },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  }, {
    connectImpl: async () => client,
    setIntervalImpl: () => ({ id: Symbol("timer") }),
    clearIntervalImpl: () => {},
  })
  await lifecycle.close()
  assert.deepEqual(calls.filter((name) => name !== "registerHello"), [])
})

test("broker-server live path: 只接受 hello/register、sequenced event、command/control，不再把 compat message 当主路径", async () => {
  const serverModule = await import(`../dist/wechat/broker-server.js?reload=${Date.now()}`)
  const protocol = await import(`../dist/wechat/protocol.js?reload=${Date.now()}`)
  const endpoint = "tcp://127.0.0.1:0"
  const server = await serverModule.startBrokerServer(endpoint)
  const response = await sendCompatFrameToLiveServer(
    server.endpoint,
    `${JSON.stringify({ id: "legacy-heartbeat-1", type: "heartbeat", payload: {} })}\n`,
  )
  await server.close()
  assert.match(String(response.errorMessage ?? response), /unsupported|legacy path removed/i)
})

test("compat fallback toast sidecar 已退出主路径，delivery failure 改为权威 retry/command 语义", async () => {
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}`)
  const state = brokerStateStore.createEmptyBrokerState()
  brokerStateStore.upsertRetryErrorSummary(state, {
    instanceID: "inst-a",
    sessionID: "session-a",
    action: "sendMessageWeixin",
    redactedSummary: "delivery failed",
    severityAdvice: "建议尽快人工查看",
  })
  const formatter = await import(`../dist/wechat/notification-format.js?reload=${Date.now()}`)
  const text = formatter.formatWechatNotificationText({
    kind: "sessionError",
    action: "sendMessageWeixin",
    redactedSummary: "delivery failed",
    severityAdvice: "建议尽快人工查看",
  })
  assert.doesNotMatch(text, /showFallbackToast|fallbackToastDropped/)
  assert.match(text, /retry|error|处理失败|需要人工处理/i)
})
```

- [ ] **Step 2: 跑定向测试确认当前仍有 compat 残留**

Run: `npm run build && node --test test/wechat-broker-ws-lifecycle.test.js test/wechat-plugin-hooks-status.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: 新增“compat 已移除”回归先失败，暴露当前仍调用 `registerInstance/heartbeat` 或仍接收 compat message。

- [ ] **Step 3: 最小实现，只保留单一 WS 主路径**

实现时写死：

```ts
// broker-client.ts
export type BrokerClient = {
  registerHello(...): Promise<RegisterAck>
  sendBridgeEvent(...): Promise<BrokerAckPayload>
  setLiveHandlers(...): void
  ping(...): Promise<void>
  close(): Promise<void>
}

// 删除默认主路径中的 compat registerInstance/heartbeat/statusSnapshot/syncWechatNotifications

// bridge.ts
await brokerClient.registerHello(...)
// steady keepalive 只走 ping
// 不再在 registerHello 后补 compat registerInstance
// 不再在 keepalive 后跑旧 candidate/full-sync 补偿

// fallback toast 的唯一新归属
// 删除 showFallbackToast envelope
// delivery failure 统一落成 broker-state-store 中的 retryErrorUpdated / command failure state
// 由 notification-format.ts / status-format.ts 读取并生成最终用户文案
```

实现检查点：
- `showFallbackToast` 不能再依赖 compat sidecar；这轮明确并入 `retryErrorUpdated / command ledger` 语义，不新增新的 fallback toast 专用 sidecar。唯一写入入口固定为 `broker-server.handleNotificationDeliveryFailure()`：
  - 它必须推进 `markBrokerCommandResult(..., failed)`
  - 同时调用 `upsertRetryErrorSummary(...)`
  - `notification-format.ts / status-format.ts` 只读这两份权威状态生成最终用户文案
- `protocol.ts` 删除 compat message 类型后，server/client/test 不应再引用它们作为主路径
- `plugin-hooks` 侧只对当前 live API 形状背书
- `notification-format.ts` / `status-format.ts` / `test/wechat-status-flow.test.js` / `test/wechat-notification-flow.test.js` 必须补上新文案 owner，证明用户仍能看到稳定失败摘要，而不是丢失提示

- [ ] **Step 4: 再跑定向测试确认 compat transport 真退出主路径**

Run: `npm run build && node --test test/wechat-broker-ws-lifecycle.test.js test/wechat-plugin-hooks-status.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: live path 只走 `registerHello + event + ack + ping`，compat transport 相关回归转绿。

### Task 3: 让旧 store 退出运行时主路径，只保留迁移/关闭承接

**Files:**
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/notification-store.ts`
- Modify: `src/wechat/token-store.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/broker-state-store.ts`
- Modify: `src/wechat/state-paths.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-notification-store.test.js`
- Test: `test/wechat-token-store.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁“旧 store 不能再参与运行时判定”**

```js
// 在 test/wechat-status-flow.test.js 内新增本地 helper：
// - seedLegacyRuntimeConflict({ requestStore, notificationStore, tokenStore, statePaths })
// - createSlashHandlersFromBrokerState({ brokerStateStore, brokerEntry })
// - buildAuthoritativeStatusState()
// 它们都只落在该测试文件内，不新增跨文件共享测试支架

test("runtime slash/status 不再从旧 request/notification/instances 目录回查主状态", async () => {
  const stateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}`)
  const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)
  await seedLegacyRuntimeConflict({ requestStore, notificationStore, tokenStore })
  await stateStore.writeBrokerStateStoreSnapshot(buildAuthoritativeStatusState())
  const statusReply = await createSlashHandlersFromBrokerState({ brokerStateStore: stateStore }).handleStatus()
  assert.match(statusReply, /authoritative-session-title/)
  assert.doesNotMatch(statusReply, /legacy-conflicting-session-title/)
})

test("升级后无法迁移的旧 qid/handle/s* 返回稳定升级关闭原因，而不是 not found", async () => {
  const handlers = await createSlashHandlersFromBrokerState({ brokerStateStore: stateStore })
  assert.match(await handlers.replyQuestion("q99", "hello"), /升级后已关闭|已结束/)
  assert.match(await handlers.allowPermission("p99", "once"), /升级后已关闭|已结束/)
  assert.match(await handlers.replyNaturalStop("s99", "hello"), /升级后已关闭|已结束/)
})
```

- [ ] **Step 2: 跑定向测试确认旧 store 仍在被主路径依赖**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-store.test.js test/wechat-token-store.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: 新增“旧 store 已退出主路径”回归先失败，证明现在仍存在回查或旁路依赖。

- [ ] **Step 3: 最小实现，降级旧 store 角色**

实现时写死：

```ts
// request-store / notification-store
// 仅保留一次性导入 retained state / 生成升级关闭原因所需最小入口

// broker-entry.ts
// slash/status 只读 broker-state-store；旧 store 只允许用来生成 legacy close reason 或导入材料
```

实现检查点：
- 旧 `instances/requests/notifications/tokens` 不再承担 runtime truth
- `token-store.ts` 若仍保留，只能承担导入材料或离线历史用途；不得继续参与 broker↔bridge live 判定
- `instances` 退役的 owner 固定为 `broker-server.ts + state-paths.ts + broker-state-store.ts`，而不是留到实现阶段再决定：
  - `broker-server.ts` 不再把 `instances/` 当 live truth
  - `state-paths.ts` 只保留导入/关闭承接路径
  - `broker-state-store.ts` 负责吸收必要 retained state 或生成升级关闭原因
- 如果某类 retained state 无法迁移，必须在 `broker-state-store` 写稳定升级关闭原因
- 不允许以“临时回查旧 store”继续补用户合同
- 必须补一条验证：即使 seed 冲突 `tokens/instances` 数据，`/status`、slash、fallback 语义仍只受 `broker-state-store` 驱动

- [ ] **Step 4: 再跑测试确认旧 store 已退出主路径**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-store.test.js test/wechat-token-store.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js`
Expected: 旧 store 不再影响运行时判定；旧入口继续返回稳定升级关闭原因。

### Task 4: 删除旧 diagnostics 主语义并做整套验证

**Files:**
- Modify: `package.json`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/broker-state-store.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/state-paths.ts`
- Test: `test/wechat-broker-ws-lifecycle.test.js`
- Test: `test/wechat-broker-state-store.test.js`
- Test: `test/wechat-plugin-hooks-status.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-token-store.test.js`

- [ ] **Step 1: 先写失败测试，锁旧 diagnostics/compat 语义退出主路径**

```js
// 在 test/wechat-broker-ws-lifecycle.test.js 内新增本地 helper：
// - readBrokerAndBridgeDiagnosticsAfterBoot(): Promise<Array<Record<string, unknown>>>
// 在 test/wechat-status-flow.test.js 内新增本地 helper：
// - replyOldHandleAfterUpgrade(kind, handle): Promise<string>

test("runtime diagnostics 不再以 bridgeResyncStarted/Completed 与 compat collectStatusStage 作为主语义", async () => {
  const diagnostics = await readBrokerAndBridgeDiagnosticsAfterBoot()
  assert.equal(diagnostics.some((event) => event.type === "bridgeResyncStarted"), false)
  assert.equal(diagnostics.some((event) => event.type === "collectStatusStage"), false)
  assert.equal(diagnostics.some((event) => event.type === "wsReplayRequested"), true)
})

test("default npm test 入口仍完整覆盖 serial phases 与 parallel shard", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.match(pkg.scripts.test, /test:serial:wechat-ws-core/)
  assert.match(pkg.scripts.test, /test:serial:wechat-broker-lifecycle/)
  assert.match(pkg.scripts.test, /test:serial:wechat-notification-flow/)
  assert.match(pkg.scripts.test, /test:serial:wechat-status-flow:early/)
  assert.match(pkg.scripts.test, /test:serial:wechat-status-flow:late/)
  assert.match(pkg.scripts.test, /test:serial:plugin/)
  assert.match(pkg.scripts.test, /test:parallel:shard/)
})

test("升级后旧代际 qid/handle/s* 不退化成 not found", async () => {
  for (const [kind, handle] of [["question", "q99"], ["permission", "p99"], ["naturalStop", "s99"]]) {
    const result = await replyOldHandleAfterUpgrade(kind, handle)
    assert.doesNotMatch(String(result), /not found|未找到/)
    assert.match(String(result), /升级后已关闭|已结束/)
  }
})
```

- [ ] **Step 2: 跑定向测试确认旧 diagnostics 语义仍在主路径上**

Run: `npm run build && node --test test/wechat-broker-ws-lifecycle.test.js test/wechat-broker-state-store.test.js test/wechat-plugin-hooks-status.test.js test/wechat-status-flow.test.js test/wechat-notification-flow.test.js test/wechat-token-store.test.js`
Expected: 新增 diagnostics / runner 回归先失败。

- [ ] **Step 3: 最小实现，删除旧 diagnostics 主语义并固化默认验证入口**

实现检查点：
- diagnostics 以 WS 连接、event ack、水位、command ledger 为主
- compat `bridgeResyncStarted/Completed`、compat `collectStatusStage` 不再作为默认主语义
- 默认 `npm test` 仍完整覆盖，并且不靠 compat 分支才自然结束
- 默认 `npm test` 必须显式串起 `wechat-ws-core`、`wechat-broker-lifecycle`、`wechat-notification-flow`、`wechat-status-flow:early`、`plugin`、`wechat-status-flow:late` 与 `parallel:shard`，不能通过少跑关键 phase 换绿
- 旧代际 `qid/handle/s*` 的升级承接必须二选一写死：迁移 retained state，或返回稳定升级关闭原因；两条都不能退化成 `not found`
- `package.json` 的默认入口必须显式覆盖 serial phases + parallel shard；不能通过删 runner / 少跑文件换绿
- 升级策略必须二选一写死：迁移 retained state，或返回稳定升级关闭原因；两条都不能退化成 `not found`

- [ ] **Step 4: 运行最终 fresh 验证并按 checklist 验收**

Run: `npm test`
Expected: 自然结束并成功。

最终人工 checklist：
- 代码里不再有 live 主路径对 compat transport 的运行时依赖
- 旧 store 已退出运行时真相源角色
- `broker-state-store` 是唯一运行时真相源
- fallback toast / retry / terminal / slash 用户合同不缩水
- 旧 `qid/handle/s*` 不退化成 `not found`
- diagnostics 已切到新主语义
