# WeChat 通知状态同步与文案修订 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把微信通知的可复制文案、question 选项说明、电脑端终结后的入口回收/原因提示、Agent 自然中止可回复、以及 retry 错误摘要一次收口到同一套状态同步合同里。

**Architecture:** 保持现有 `broker-entry -> request-store / notification-store / notification-dispatcher` 作为真相链路，不重做整套通知系统。question / permission 旧入口的终结原因通过 request 侧 terminal metadata 持久化并驱动 terminal result 通知与 slash 拒绝；session 侧则在现有 `sessionError` 采集链路上拆分出 `ordinary retry/error` 和 `natural-stop` 两类通知语义，其中只有 `natural-stop` 进入 replyable 分支并使用独立 `s*` handle。

**Tech Stack:** TypeScript, Node.js test runner, existing WeChat request/notification stores, broker slash handlers, bridge candidate collection, status/runtime diagnostics

---

## 文件结构预分解

- `src/wechat/request-store.ts`
  - 为终结后的 question / permission 保留可按旧 `qid / handle` 查询的 terminal metadata。
- `src/wechat/notification-types.ts`
  - 扩展 notification kind 与 session 类通知字段，区分 terminal result / ordinary retry-error / natural-stop。
- `src/wechat/notification-store.ts`
  - 持久化新增 notification kind 所需字段，支持 terminal result 的单次发送语义。
- `src/wechat/notification-format.ts`
  - 收口 question 选项标题 + 说明、示例逐行、terminal result 文案、natural-stop 文案、retry/error 摘要。
- `src/wechat/question-interaction.ts`
  - 把 question option `description` 纳入 `QuestionPromptSummary` 与 `extractQuestionPromptSummary()`，不新增第二套 question prompt 解析。
- `src/wechat/protocol.ts`
  - 扩展 `WechatNotificationCandidate` 的最小字段集合，支持 `requestTerminal` / `naturalStop` / richer session error payload。
- `src/wechat/handle.ts`
  - 为 `s*` handle 补专用前缀与 allocator，避免和现有 `q*` / `p*` 命名空间冲突。
- `src/wechat/bridge.ts`
  - 生成 session 类 notification candidates，区分 ordinary retry-error 与 natural-stop，并在 candidate 里带上最小 reply target identity。
- `src/wechat/broker-server.ts`
  - 以现有 `syncWechatNotifications` 对比链路作为 canonical 入口，发现旧 replyable 入口离开集合时写 terminal metadata 并创建 terminal result notification。
- `src/wechat/notification-dispatcher.ts`
  - 保持 ordinary retry-error 信息型、natural-stop replyable、terminal result 单次通知与 suppress 语义。
- `src/wechat/broker-entry.ts`
  - slash `/reply` / `/allow` 对已终结入口返回稳定“已结束”提示；`/reply` 新增 `natural-stop` 查找分支。
- `test/wechat-request-store.test.js`
  - 覆盖 terminal metadata 的持久化、优先级和可查询性。
- `test/wechat-notification-store.test.js`
  - 覆盖新增 notification kind 的持久化字段与 terminal result 单次语义。
- `test/wechat-notification-flow.test.js`
  - 覆盖 formatter、dispatch、ordinary retry-error / natural-stop 差异、terminal result 发送与 suppress。
- `test/wechat-status-flow.test.js`
  - 覆盖 slash 拒绝文案、natural-stop `/reply` 路由、question/permission 旧入口回收后行为。

### Task 1: 收口 formatter 文案与 question 选项说明

**Files:**
- Modify: `src/wechat/notification-format.ts`
- Modify: `src/wechat/question-interaction.ts`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写 formatter 失败测试，锁住“标题 + 说明”和示例逐行合同**

在 `test/wechat-notification-flow.test.js` 增加至少这些回归：

```js
test("通知文案格式化：question 选项会输出标题与说明两行", async () => {
  const text = formatWechatNotificationText({
    kind: "question",
    handle: "q12",
    prompt: {
      title: "请选择部署方式",
      mode: "single",
      options: [
        { index: 1, label: "灰度发布", value: "canary", description: "先给少量用户验证" },
      ],
    },
  })

  assert.match(text, /1\. 灰度发布/)
  assert.match(text, /先给少量用户验证/)
})

test("通知文案格式化：question 说明会穿过 prompt 摘要链路保留下来", async () => {
  const prompt = extractQuestionPromptSummary({
    questions: [{
      header: "请选择部署方式",
      question: "部署方式",
      multiple: false,
      options: [{ label: "灰度发布", description: "先给少量用户验证" }],
    }],
  })

  const text = formatWechatNotificationText({ kind: "question", handle: "q12", prompt })
  assert.match(text, /1\. 灰度发布/)
  assert.match(text, /先给少量用户验证/)
})

test("通知文案格式化：所有可复制示例都单独占一行", async () => {
  const questionText = formatWechatNotificationText(questionRecord)
  const permissionText = formatWechatNotificationText(permissionRecord)

  assert.match(questionText, /\n\/reply q12 1\n/)
  assert.match(questionText, /\n\/reply q12 你的自定义回复\n/)
  assert.match(permissionText, /\n\/allow p5 once\n/)
  assert.match(permissionText, /\n\/allow p5 always\n/)
  assert.match(permissionText, /\n\/allow p5 reject\n/)
})

```

- [ ] **Step 2: 跑 formatter 定向测试确认当前行为先变红**

Run: `npm run build && node --test test/wechat-notification-flow.test.js --test-name-pattern="通知文案格式化"`
Expected: 新增 question 说明链路 / 示例逐行 / permission 示例逐行 相关回归至少有一部分先失败。

- [ ] **Step 3: 在 `notification-format.ts` 内收口 question/permission/session 文案**

把格式化逻辑保持在现有文件内，按最小方式补 helper，不拆新模板系统：

```ts
function formatStandaloneExample(command: string) {
  return command
}

function formatQuestionOptions(
  options: Array<{ index: number; label: string; description?: string }> = [],
) {
  return options.flatMap((option) => [
    `${option.index}. ${option.label}`,
    ...(option.description ? [option.description] : []),
  ])
}

```

同时把 `question-interaction.ts` 的 prompt 摘要补齐到真实链路：

```ts
type QuestionPromptSummary = {
  // existing fields...
  options?: Array<{
    index: number
    label: string
    value: string
    description?: string
  }>
}

const options = Array.isArray(first.options)
  ? first.options
      .filter((option) => isNonEmptyString(option?.label))
      .map((option, index) => ({
        index: index + 1,
        label: option.label.trim(),
        value: option.label.trim(),
        ...(isNonEmptyString(option.description) ? { description: option.description.trim() } : {}),
      }))
  : undefined
```

实现检查点：

- question / permission 的可复制示例都必须是独立字符串项，最终由 `lines.join("\n")` 保证逐行输出。
- question 选项说明不能变成额外的 formatter 尾注，必须紧跟对应选项输出。
- question 说明的通过标准必须走真实 `extractQuestionPromptSummary() -> formatter` 链路，不能只靠手写带 `description` 的 prompt 夹具假绿。

- [ ] **Step 4: 重新跑 formatter 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notification-flow.test.js --test-name-pattern="通知文案格式化"`
Expected: PASS，且上一轮 question / permission 文案回归继续通过。

### Task 2: 为旧 qid / handle 引入 terminal metadata 与 terminal result 通知

**Files:**
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/notification-types.ts`
- Modify: `src/wechat/notification-store.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/notification-format.ts`
- Modify: `src/wechat/notification-dispatcher.ts`
- Modify: `src/wechat/broker-entry.ts`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-notification-store.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁住 terminal metadata 与“只发一次”的合同**

在 `test/wechat-request-store.test.js` 和 `test/wechat-status-flow.test.js` 增加回归：

```js
test("request store: 旧 question 终结后仍可按 handle 查到 terminal metadata", async () => {
  await requestStore.upsertRequest({ kind: "question", handle: "q12", requestID: "req-1", routeKey: "route-1", ... })
  await requestStore.markRequestAnswered({ kind: "question", routeKey: "route-1", answeredAt: 1700000000000, terminalReason: "answered" })

  const terminal = await requestStore.findTerminalRequestByHandle({ kind: "question", handle: "q12" })
  assert.equal(terminal?.terminalReason, "answered")
  assert.equal(terminal?.terminalResultSent, false)
})

test("request store: cleanup 不覆盖更早的用户可见终结原因", async () => {
  await requestStore.markRequestAnswered({ ..., terminalReason: "answered" })
  await requestStore.markCleaned({ ..., cleanedAt: 1700000001000 })
  const terminal = await requestStore.findTerminalRequestByHandle({ kind: "question", handle: "q12" })
  assert.equal(terminal?.terminalReason, "answered")
})

test("request store: terminalResultSent 写回后不会回退，且 replacement 只有在存在新 handle 时才允许", async () => {
  await requestStore.markRequestExpired({ ..., terminalReason: "expired" })
  await requestStore.markTerminalResultSent({ kind: "question", routeKey: "route-1", sentAt: 1700000002000 })
  await requestStore.markTerminalMetadata({ kind: "question", routeKey: "route-1", terminalReason: "replaced", replacementHandle: undefined })

  const terminal = await requestStore.findTerminalRequestByHandle({ kind: "question", handle: "q12" })
  assert.equal(terminal?.terminalResultSent, true)
  assert.equal(terminal?.terminalReason, "expired")
})

test("broker-entry slash handler: 电脑端已回复后的旧 qid 会返回稳定已结束提示", async () => {
  const result = await handler({ type: "reply", handle: "q12", text: "再回一次" })
  assert.match(result, /q12/)
  assert.match(result, /已在电脑端回复/)
  assert.match(result, /不再接受回复/)
})

test("notification dispatcher: 同一个旧入口的 terminal result 只发送一次", async () => {
  await dispatcher.drainOutboundMessages()
  await dispatcher.drainOutboundMessages()
  assert.equal(sendCalls.filter((item) => /q12/.test(item.text)).length, 1)
})

test("通知文案格式化：terminal result 同时展示入口标识、终结原因与拒绝说明", async () => {
  const text = formatWechatNotificationText(terminalResultRecord)
  assert.match(text, /q12|p5/)
  assert.match(text, /已在电脑端回复|已在电脑端拒绝|已过期|已被新入口替代/)
  assert.match(text, /不再接受回复|不再接受权限处理/)
})
```

- [ ] **Step 2: 跑 request/notification/slash 定向测试，确认当前行为先被锁住**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-status-flow.test.js --test-name-pattern="terminal|已结束|只发送一次"`
Expected: 新增 terminal metadata / terminal result / 已结束拒绝提示相关测试先失败。

- [ ] **Step 3: 在 request / broker-server / notification 真相链路里补 terminal metadata 与 terminal result kind**

优先在现有 request 持久化记录上增量增加 terminal metadata，不另开一套 tombstone store：

```ts
type RequestTerminalReason = "answered" | "rejected" | "expired" | "replaced"

type RequestRecord = {
  // existing fields...
  terminalReason?: RequestTerminalReason
  replacementHandle?: string
  terminalResultSent?: boolean
}

findTerminalRequestByHandle({ kind, handle })
markTerminalResultSent({ kind, routeKey, sentAt })
```

同时在 `notification-types.ts` / `notification-store.ts` 新增 terminal result notification kind，例如：

```ts
type NotificationKind = "question" | "permission" | "sessionError" | "requestTerminal" | "naturalStop"
```

并把 terminal result 的 canonical 产出点固定在当前 `broker-server` 的同步入口：

```ts
async function syncWechatNotifications(...) {
  // 1. 先用本轮 candidate + 已持久化 open request 对比，找出“第一次离开 replyable 集合”的旧入口
  // 2. 在 request-store 里固化 terminal metadata（含 terminalReason / replacementHandle / terminalResultSent）
  // 3. 再 upsert 对应 requestTerminal notification
}
```

实现检查点：

- terminal result 只能从一个 canonical helper / call site 产出，不能在 dispatcher 和 slash handler 各自再补一遍。
- terminal result 通知只在旧入口第一次离开 replyable 集合时产生。
- `terminalResultSent` 的写回必须落在 request 侧 metadata 上，后续去重只能复用这份 metadata。
- `cleanup` / `purge` 只能清内部状态，不得再补第二条 terminal result。
- 终结原因优先级固定为 `replaced > answered > rejected > expired`，但“replaced”只有在 replacement handle 存在时才允许使用。
- `broker-entry` 对已终结入口的 slash 拒绝，必须优先查 terminal metadata，不得退化成“未找到 handle”。
- terminal result formatter 必须输出 `入口标识 + 终结原因 + 不再接受回复/处理说明`，不能只测发送次数。

- [ ] **Step 4: 重新跑 terminal 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-status-flow.test.js --test-name-pattern="terminal|已结束|只发送一次"`
Expected: PASS，且既有 question / permission slash 回归继续通过。

### Task 3: 拆分 ordinary retry-error 与 natural-stop 通知语义

**Files:**
- Modify: `src/wechat/notification-types.ts`
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/handle.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/notification-format.ts`
- Modify: `src/wechat/notification-store.ts`
- Modify: `src/wechat/notification-dispatcher.ts`
- Modify: `src/wechat/broker-entry.ts`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁住 natural-stop replyable 与 ordinary retry-error info-only 的矩阵**

在 `test/wechat-notification-flow.test.js` / `test/wechat-status-flow.test.js` 增加：

```js
test("通知候选：ordinary retry/error 不分配 handle，只带动作/摘要/严重度", async () => {
  const candidates = await bridge.collectNotificationCandidates()
  const retry = candidates.find((item) => item.kind === "sessionError")
  assert.equal(retry.handle, undefined)
  assert.equal(typeof retry.action, "string")
  assert.equal(typeof retry.redactedSummary, "string")
  assert.equal(typeof retry.severityAdvice, "string")
})

test("通知候选：natural-stop 分配 s* handle 并带 reply target identity", async () => {
  const stop = candidates.find((item) => item.kind === "naturalStop")
  assert.match(stop.handle, /^s\d+$/)
  assert.equal(typeof stop.replyTarget.sessionID, "string")
})

test("通知文案格式化：natural-stop 给出逐行可复制的 /reply s* 示例", async () => {
  const text = formatWechatNotificationText(naturalStopRecord)
  assert.match(text, /\n\/reply s3 你的补充内容\n/)
})

test("broker-entry slash handler: /reply s3 会路由到 natural-stop reply 分支", async () => {
  const result = await handler({ type: "reply", handle: "s3", text: "请继续检查超时链路" })
  assert.equal(result, "已回复中止通知：s3")
  assert.deepEqual(naturalStopReplyCalls, [{ handle: "s3", text: "请继续检查超时链路" }])
})

test("broker-entry slash handler: natural-stop 回复后再次 /reply s3 返回固定终结原因", async () => {
  await handler({ type: "reply", handle: "s3", text: "请继续检查超时链路" })
  const result = await handler({ type: "reply", handle: "s3", text: "再补一句" })
  assert.match(result, /s3/)
  assert.match(result, /已在微信端补充回复|已在电脑端继续处理|已过期/)
  assert.match(result, /不再接受回复/)
})

test("通知文案格式化：ordinary retry/error 带三段式摘要但不带 reply 示例", async () => {
  const text = formatWechatNotificationText(retryErrorRecord)
  assert.match(text, /动作|阶段/)
  assert.match(text, /原因摘要/)
  assert.match(text, /建议尽快人工查看|可等待自动重试/)
  assert.doesNotMatch(text, /\/reply s\d+/)
  assert.doesNotMatch(text, /等待你的回复/)
})
```

- [ ] **Step 2: 跑 session 通知定向测试，确认当前行为先变红**

Run: `npm run build && node --test test/wechat-notification-flow.test.js test/wechat-status-flow.test.js --test-name-pattern="natural-stop|retry|sessionError|已回复中止通知"`
Expected: 当前 sessionError 还是单一语义、无 `s*` handle、slash `/reply` 也还没有 natural-stop 分支，因此新增用例会先失败。

- [ ] **Step 3: 在 `protocol.ts` / `handle.ts` / `bridge.ts` / `broker-server.ts` / `notification-store.ts` / `broker-entry.ts` 里补 session 通知的分型与路由**

先把最小载体写死：

```ts
type WechatNotificationCandidate =
  | { kind: "sessionError"; sessionID: string; action: string; redactedSummary: string; severityAdvice: string; ... }
  | { kind: "naturalStop"; sessionID: string; handle: string; replyTarget: { instanceID: string; sessionID: string }; redactedSummary: string; severityAdvice: "已停止并等待你的回复"; ... }
```

同时在 `handle.ts` 增加专用 `s*` allocator，例如：

```ts
createSessionReplyHandle(existingHandles)
```

再在 `bridge.collectNotificationCandidates()` 里，把当前 `session.status()` 返回结构中的 session 信号拆成两类：

```ts
if (status.type === "retry") {
  candidates.push({
    kind: "sessionError",
    sessionID,
    action: deriveRetryAction(status),
    redactedSummary: deriveRetrySummary(status),
    severityAdvice: deriveRetrySeverity(status),
  })
}

if (status.type === "natural-stop") {
  candidates.push({
    kind: "naturalStop",
    handle: createSessionReplyHandle(existingHandles),
    replyTarget: { instanceID: input.instanceID, sessionID },
    redactedSummary: deriveNaturalStopSummary(status),
    severityAdvice: "已停止并等待你的回复",
  })
}
```

同时：

- `broker-server.ts` 必须接受扩展后的 candidate union，并把 `naturalStop` / richer `sessionError` 正常入库，而不是在 `syncWechatNotifications` 校验处丢掉。
- `notification-store.ts` 必须支持 active `naturalStop` lookup 与终结后固定原因持久化，供 `/reply s*` 二次拒绝复用。
- `broker-entry.ts` 的 `/reply` 必须新增一个只处理 `natural-stop` 的窄查找与 transport 接缝，例如 `sendReplyNaturalStopRpc`（名字可等价），不得复用 question request 查找或靠计划内虚构数组 `naturalStopReplyCalls` 假绿。

实现检查点：

- `ordinary retry/error` 永远不分配 handle，也不出 `/reply` 示例。
- `ordinary retry/error` 的最小字段固定为 `sessionID + action + redactedSummary + severityAdvice`。
- `natural-stop` 一定有 `s*` handle 和 reply target identity。
- `natural-stop` 的 reply handle allocator 必须和 `q*` / `p*` 命名空间隔离，避免碰撞。
- `natural-stop` 回复一次后，该 `s*` handle 必须失效并走固定拒绝提示。
- 如果当前 `session.status()` 结果里还没有 `natural-stop`，Task 3 只能在这条现有 status 链路上扩展，不得再引入新的 out-of-band 通知源。

- [ ] **Step 4: 重新跑 session 通知定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notification-flow.test.js test/wechat-status-flow.test.js --test-name-pattern="natural-stop|retry|sessionError|已回复中止通知"`
Expected: PASS，且既有 retry/sessionError 去重回归继续通过。

### Task 4: 全量回归与 spec 对照验收

**Files:**
- Verify only: `docs/superpowers/specs/2026-04-18-wechat-notification-state-sync-and-copy-design.md`
- Verify only: `docs/superpowers/plans/2026-04-18-wechat-notification-state-sync-and-copy-implementation.md`
- Verify only: changed source/test files from Task 1-3

- [ ] **Step 1: 跑这轮相关定向套件**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-status-flow.test.js`
Expected: PASS。

- [ ] **Step 2: 跑完整 `npm test` 做 fresh release-level 证据**

Run: `npm test`
Expected: PASS，且不沿用旧测试结果。

- [ ] **Step 3: 按 spec 做人工验收对照**

逐条对照以下清单：

```md
- [ ] 所有 `/reply ...` / `/allow ...` / natural-stop 示例都独占一行
- [ ] question 选项标题 + 说明都能在微信文案里看到
- [ ] 电脑端终结 question / permission 后，旧 qid / handle 会回收
- [ ] 微信会收到 terminal result 通知，且同一旧入口最多一条
- [ ] 微信再回复旧入口只会得到稳定“已结束”提示
- [ ] terminal result 与 slash 拒绝提示复用同一终结原因标签
- [ ] natural-stop 会生成 `s*` handle 和可复制 `/reply <handle> 你的补充内容` 示例
- [ ] natural-stop 回复后再次 `/reply <s*>` 返回固定终结原因
- [ ] ordinary retry/error 只给三段式摘要，不带 handle / reply 示例
- [ ] retry/error 不泄漏堆栈与敏感字段
```

- [ ] **Step 4: 如果验收需要扩范围，立即停下，不擅自改 spec 外设计**

如果实现过程中发现需要改 spec、扩到其它子系统，或触碰这份计划之外的架构重做，停止执行并回到 review / 澄清流程；不要在实现阶段临时发明新规则。
