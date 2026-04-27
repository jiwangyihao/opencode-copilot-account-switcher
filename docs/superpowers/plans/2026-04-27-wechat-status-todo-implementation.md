# WeChat `/status` 排版与 `/todo` 待处理事项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改善 WeChat `/status` 的实例/会话分隔与 QID 可见性，并新增 `/todo` 统一列出当前待回复或待处理事项。

**Architecture:** 以 `broker-state-store` 的 authoritative view 为唯一数据来源，`status-format.ts` 负责纯格式化和摘要提取，slash handler 只做命令分发。`/status` 继续是运行状态总览，但必须从 `view.active.questions` 补全所有可操作 QID；`/todo` 是独立的待处理清单，只展示 active question、active permission、active natural-stop。

**Tech Stack:** TypeScript、Node.js test runner、现有 `dist` 构建产物测试、WeChat broker authoritative view、现有 slash command parser 与 broker slash handler。

---

## 文件结构预分解

- `src/wechat/command-parser.ts`
  - 新增 `{ type: "todo" }` union 分支；只识别精确 `/todo`，不接受 `/todo extra` 或 `/todox`。
- `src/wechat/status-format.ts`
  - 保留已有 snapshot normalization 与 session 摘要职责。
  - 新增 active 待处理项读取、摘要提取、排序、`/todo` formatter。
  - 调整 `/status` 输出为实例标题、分隔线、会话标题；从 broker view 补全 QID，但不泄露内部 ID。
- `src/wechat/broker-entry.ts`
  - slash handler 显式处理 `command.type === "todo"`，并把 permission 分支改成显式 `command.type === "allow"`。
- `src/wechat/broker-server.ts`
  - legacy/test-facing `handleWechatSlashCommand()` 显式处理 `/todo`，避免落入旧 `/allow` 未实现文案。
- `test/wechat-status-flow.test.js`
  - 继续集中覆盖 parser、formatter、broker-server、broker-entry slash handler；测试导入 `dist`，每轮相关测试前必须先运行 `npm run build`。

## 输出合同

`/status` 的目标形态：

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
摘要：是否继续处理当前 slash 请求
回复：/reply q1 你的回复
running tool: bash
```

`/todo` 的目标形态：

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

空 `/todo` 精确输出：

```text
当前没有待回复或待处理事项
```

## 实现约束

- 所有用户可见 `QID/PID/SID` 都取 active record 的 `handle`；不得用 `requestID`、`routeKey`、`sessionID`、`instanceID` 兜底。
- `SID` 是 natural-stop handle，不是 `sessionID`。
- `/todo` 只读取 `brokerView.active.questions`、`brokerView.active.permissions`、`brokerView.active.naturalStops`。
- `/todo` 不展示普通 session `todoItems`，不展示 `legacyHandleClosures`、`retainedOccupancy`、`terminalMetadata` 中的历史记录。
- `/status` 可以保留 top sessions 裁剪，但不能因此隐藏任何 active question handle。
- 没有 authoritative active question handle 时，`/status` 不能根据 bridge snapshot 的 question 摘要伪造 QID。
- 不创建 git commit；本仓库约束要求只有用户明确要求时才提交。

### Task 1: 命令解析与 slash handler 骨架

**Files:**
- Modify: `src/wechat/command-parser.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写 parser 失败测试**

修改 `test/wechat-status-flow.test.js` 中现有 `command parser: 识别 /status /reply /allow /recover` 测试。测试名改为：

```js
test("command parser: 识别 /status /todo /reply /allow /recover", async () => {
```

在 `/status` 断言后追加：

```js
assert.deepEqual(parser.parseWechatSlashCommand("/todo"), { type: "todo" })
```

在负例断言区追加：

```js
assert.equal(parser.parseWechatSlashCommand("/todox"), null)
assert.equal(parser.parseWechatSlashCommand("/todo extra"), null)
```

- [ ] **Step 2: 跑 parser 定向测试确认先失败**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "command parser" test/wechat-status-flow.test.js`

Expected: build 或测试失败，原因是 `parseWechatSlashCommand("/todo")` 还返回 `null`，或者 TypeScript union 还没有 `todo` 分支。

- [ ] **Step 3: 实现 parser 最小变更**

在 `src/wechat/command-parser.ts` 中把 union 改成包含 `todo`：

```ts
export type WechatSlashCommand = {
  type: "status"
} | {
  type: "todo"
} | {
  type: "reply"
  handle: string
  text: string
} | {
  type: "recover"
  handle: string
} | {
  type: "allow"
  handle: string
  reply: "once" | "always" | "reject"
  message?: string
}
```

在 `/status` 精确匹配后追加 `/todo` 精确匹配，必须放在 `parts` 拆分之前：

```ts
if (normalized === "/todo") {
  return { type: "todo" }
}
```

- [ ] **Step 4: 先写 handler 空状态失败测试，锁 `/todo` 不落入旧分支**

在 broker-entry slash handler 测试区新增独立空状态测试。这个测试只要求 `/todo` 空状态，不要求 active QID，因此 Task 1 的临时 formatter 可以在本任务内让它转绿：

```js
test("broker-entry slash handler: /todo 无 active 事项时返回精确空状态", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-todo-empty-entry`)
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-todo-empty-store`)
  const state = brokerStateStore.createEmptyBrokerState()
  state.active.sessions["session-normal-todo-only"] = {
    instanceID: "instance-normal-todo-only",
    sessionID: "session-normal-todo-only",
    title: "只有普通 todo 的会话",
    directory: "/repo",
    updatedAt: 1,
    status: "busy",
    pendingQuestionCount: 0,
    pendingPermissionCount: 0,
    todoSummary: { total: 1, inProgress: 0, completed: 0 },
    todoItems: [{ status: "pending", content: "普通 session todo" }],
    highlights: [],
  }

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    readBrokerAuthoritativeView: () => brokerStateStore.readBrokerAuthoritativeView(state),
  })

  assert.equal(await handler({ type: "todo" }), "当前没有待回复或待处理事项")
})
```

在 `broker slash handler: /status 走 collectStatus formatter，其它 slash 透传结构化命令` 测试中，`/status` 断言后、`/reply` placeholder 前追加：

```js
assert.equal(
  await server.handleWechatSlashCommand({ type: "todo" }),
  "当前没有待回复或待处理事项",
)
```

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(/todo|broker slash handler: /status 走 collectStatus|broker-entry slash handler: 只读 broker-state-store)" test/wechat-status-flow.test.js`

Expected: 当前实现没有 `todo` handler 或 `/todo` formatter，测试先失败；这一步建立 handler 空状态集成的红灯。

- [ ] **Step 5: 先给 handler 加临时可编译分支**

在 `src/wechat/status-format.ts` 先导出占位的最终签名，后续 Task 3 Step 5 会替换实现。这只是临时可编译状态，不是可交付状态，不要提交：

```ts
export function formatTodoReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string {
  void view
  return "当前没有待回复或待处理事项"
}
```

在 `src/wechat/broker-entry.ts` 导入改成：

```ts
import { formatAggregatedStatusReplyFromBrokerView, formatTodoReplyFromBrokerView } from "./status-format.js"
```

在 `createBrokerWechatSlashCommandHandler()` 的 returned async handler 中，`status` 分支后、`reply` 分支前追加：

```ts
if (command.type === "todo") {
  const brokerView = await readBrokerAuthoritativeView()
  return formatTodoReplyFromBrokerView(brokerView)
}
```

在同一个 handler 中，`recover` 分支结束后、permission 逻辑开始前追加显式 allow guard：

```ts
if (command.type !== "allow") {
  return "未知命令"
}
```

这条 guard 的目的不是改变已知命令行为，而是防止未来新增命令默认落入 permission 处理。当前 union 中所有非 allow 类型都已在前面返回。

在 `src/wechat/broker-server.ts` 导入改成：

```ts
import {
  buildAggregatedStatusInstancesFromBrokerView,
  formatAggregatedStatusReplyFromBrokerView,
  formatTodoReplyFromBrokerView,
} from "./status-format.js"
```

在 `startBrokerServer()` 的 `handleWechatSlashCommand` 中，`status` 分支后、`reply` 分支前追加：

```ts
if (command.type === "todo") {
  const view = readBrokerAuthoritativeView(liveWsCoordinator.getState())
  return formatTodoReplyFromBrokerView(view)
}
```

把最后的默认返回改成只给 allow：

```ts
if (command.type === "allow") {
  return "命令暂未实现：/allow"
}

return "未知命令"
```

- [ ] **Step 6: 跑 parser 与 type build 确认骨架通过**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(command parser|/todo 无 active 事项|broker slash handler: /status 走 collectStatus)" test/wechat-status-flow.test.js`

Expected: parser、broker-entry `/todo` 空状态、broker-server `/todo` 空状态测试 PASS；build 不再因为 `todo` union 或 handler exhaustiveness 失败。

### Task 2: `/status` 排版与 QID 补全测试

**Files:**
- Modify: `test/wechat-status-flow.test.js`
- Modify: `src/wechat/status-format.ts`

- [ ] **Step 1: 更新 formatter 文案边界测试，先锁新排版**

在现有 `/status 文案边界：标题分段...` 测试里追加第二个在线实例，避免只覆盖单实例。把 `instances` 数组中的 timeout 实例前加入：

```js
{
  instanceID: "internal-instance-second-789",
  status: "ok",
  snapshot: {
    instanceID: "internal-instance-second-789",
    instanceName: "Second runtime label",
    pid: 202,
    directory: "/repo-second",
    collectedAt: 456,
    sessions: [
      {
        sessionID: "second-session-hidden-1",
        title: "第二实例会话",
        directory: "/repo-second",
        updatedAt: 500,
        status: "idle",
        pendingQuestionCount: 0,
        pendingPermissionCount: 0,
        todoSummary: { total: 0, inProgress: 0, completed: 0 },
        highlights: [{ kind: "status", text: "status: idle" }],
      },
    ],
  },
},
```

在现有断言区追加：

```js
assert.match(reply, /^wechat status\n/)
assert.match(reply, /## 实例：Rich hidden runtime label/)
assert.match(reply, /## 实例：Second runtime label/)
assert.match(reply, /### 会话：发布主线/)
assert.match(reply, /### 会话：new-2/)
assert.match(reply, /### 会话：new-3/)
assert.match(reply, /### 会话：第二实例会话/)
assert.equal((reply.match(/^---$/gm) ?? []).length, 3)

const firstInstanceIndex = reply.indexOf("## 实例：Rich hidden runtime label")
const secondInstanceIndex = reply.indexOf("## 实例：Second runtime label")
const timeoutIndex = reply.indexOf("## 实例：timeout/unreachable")
assert.equal(firstInstanceIndex >= 0, true)
assert.equal(secondInstanceIndex > firstInstanceIndex, true)
assert.equal(timeoutIndex > secondInstanceIndex, true)

const mainSessionIndex = reply.indexOf("### 会话：发布主线")
const new2Index = reply.indexOf("### 会话：new-2")
const new3Index = reply.indexOf("### 会话：new-3")
const secondInstanceSessionIndex = reply.indexOf("### 会话：第二实例会话")
assert.equal(mainSessionIndex > firstInstanceIndex, true)
assert.equal(new2Index > mainSessionIndex, true)
assert.equal(new3Index > new2Index, true)
assert.equal(new3Index < secondInstanceIndex, true)
assert.equal(secondInstanceSessionIndex > secondInstanceIndex, true)
assert.equal(secondInstanceSessionIndex < timeoutIndex, true)

assert.doesNotMatch(reply, /internal-instance-second-789|second-session-hidden-1/)
```

同步把原负断言扩展为允许用户 handle 但禁止内部字段：

```js
assert.doesNotMatch(reply, /internal-instance-rich-123|session-hidden-123|internal-timeout-456|internal-instance-second-789|second-session-hidden-1|instanceID|sessionID|createdAt/)
```

- [ ] **Step 2: 新增 `/status` authoritative QID 正例测试**

在 `broker-entry slash handler: /status 直接读 broker 权威视图，不再依赖 live collect` 测试里，`state.active.sessions[...]` 后追加 active question：

```js
state.active.questions["route-status-authoritative-q1"] = {
  routeKey: "route-status-authoritative-q1",
  handle: "qstatus1",
  requestID: "request-status-authoritative-q1",
  scopeKey: "instance-status-authoritative",
  instanceID: "instance-status-authoritative",
  createdAt: 1_701_100_000_120,
  prompt: {
    title: "是否直接读取 broker 视图",
    body: "请确认是否继续",
    mode: "text",
  },
}
```

在断言区追加：

```js
assert.match(result, /待回复问题/)
assert.match(result, /QID：qstatus1/)
assert.match(result, /摘要：是否直接读取 broker 视图/)
assert.match(result, /回复：\/reply qstatus1 你的回复/)
assert.doesNotMatch(result, /request-status-authoritative-q1|route-status-authoritative-q1/)
```

- [ ] **Step 3: 新增 `/status` 不伪造 QID 负例测试**

在 formatter 测试附近新增测试：

```js
test("/status formatter: bridge 摘要没有 authoritative handle 时不伪造 QID", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}-status-no-qid`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-no-active-qid",
    instances: [{
      instanceID: "internal-no-active-qid",
      status: "ok",
      snapshot: {
        instanceID: "internal-no-active-qid",
        instanceName: "无 active handle 实例",
        pid: 101,
        directory: "/repo",
        collectedAt: 123,
        sessions: [{
          sessionID: "session-no-active-qid",
          title: "只有摘要的会话",
          directory: "/repo",
          updatedAt: 400,
          status: "busy",
          pendingQuestionCount: 1,
          pendingPermissionCount: 0,
          todoSummary: { total: 0, inProgress: 0, completed: 0 },
          questionHighlights: ["问题：这只是 bridge 摘要"],
          highlights: [{ kind: "question", text: "pending question: 1" }],
        }],
      },
    }],
  })

  assert.match(reply, /问题：这只是 bridge 摘要/)
  assert.doesNotMatch(reply, /QID：/)
  assert.doesNotMatch(reply, /\/reply q/)
})
```

- [ ] **Step 4: 新增 `/status` top sessions 裁剪保护测试**

在 broker-entry authoritative view 测试附近新增：

```js
test("broker-entry slash handler: /status 即使 active question 不在 top sessions 中也显示 QID", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-status-qid-truncation`)
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-status-qid-truncation-store`)
  const state = brokerStateStore.createEmptyBrokerState()

  state.connections["instance-qid-truncation"] = {
    "inc-qid-truncation": {
      instanceID: "instance-qid-truncation",
      instanceIncarnation: "inc-qid-truncation",
      online: true,
      lastEventSeq: 1,
      lastAckedEventSeq: 1,
      lastSentBrokerSeq: 1,
      connectedAt: 1,
    },
  }
  state.active.instances["instance-qid-truncation"] = {
    instanceID: "instance-qid-truncation",
    instanceIncarnation: "inc-qid-truncation",
    displayName: "QID 裁剪实例",
    online: true,
  }
  for (let index = 1; index <= 4; index += 1) {
    state.active.sessions[`session-qid-truncation-${index}`] = {
      instanceID: "instance-qid-truncation",
      sessionID: `session-qid-truncation-${index}`,
      title: `裁剪会话 ${index}`,
      directory: "/repo",
      updatedAt: 1_701_100_000_000 + index,
      status: "idle",
      pendingQuestionCount: index === 1 ? 1 : 0,
      pendingPermissionCount: 0,
      todoSummary: { total: 0, inProgress: 0, completed: 0 },
      questionHighlights: index === 1 ? ["问题：低更新时间会话里的问题"] : [],
      highlights: [],
    }
  }
  state.active.questions["route-qid-truncation-hidden"] = {
    routeKey: "route-qid-truncation-hidden",
    handle: "qhidden1",
    requestID: "request-qid-truncation-hidden",
    scopeKey: "instance-qid-truncation",
    instanceID: "instance-qid-truncation",
    createdAt: 1_701_100_000_010,
    prompt: { title: "低更新时间会话里的问题", mode: "text" },
  }

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    readBrokerAuthoritativeView: () => brokerStateStore.readBrokerAuthoritativeView(state),
  })
  const reply = await handler({ type: "status" })

  assert.match(reply, /QID：qhidden1/)
  assert.match(reply, /回复：\/reply qhidden1 你的回复/)
  assert.doesNotMatch(reply, /request-qid-truncation-hidden|route-qid-truncation-hidden|instance-qid-truncation|session-qid-truncation/)
})
```

- [ ] **Step 5: 新增 `/status` orphan active question 保护测试**

在 broker-entry authoritative view 测试附近新增。这个用例不 seed connections、instances 或 sessions，只 seed active question，用来防止 `instances.length === 0` 早退隐藏 QID：

```js
test("broker-entry slash handler: /status 只有 active question 且无实例时仍显示 QID", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-status-orphan-qid`)
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-status-orphan-qid-store`)
  const state = brokerStateStore.createEmptyBrokerState()

  state.active.questions["route-orphan-qid"] = {
    routeKey: "route-orphan-qid",
    handle: "qorphan1",
    requestID: "request-orphan-qid",
    createdAt: 1_701_100_000_010,
    prompt: { title: "无实例问题", mode: "text" },
  }

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    readBrokerAuthoritativeView: () => brokerStateStore.readBrokerAuthoritativeView(state),
  })
  const reply = await handler({ type: "status" })

  assert.match(reply, /^wechat status\n/)
  assert.match(reply, /## 实例：未知实例/)
  assert.match(reply, /QID：qorphan1/)
  assert.match(reply, /摘要：无实例问题/)
  assert.match(reply, /回复：\/reply qorphan1 你的回复/)
  assert.doesNotMatch(reply, /request-orphan-qid|route-orphan-qid|instanceID|sessionID|requestID|routeKey/)
})
```

- [ ] **Step 6: 跑 `/status` 定向测试确认失败**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(/status 文案边界|/status formatter: bridge|broker-entry slash handler: /status)" test/wechat-status-flow.test.js`

Expected: 新增排版断言和 QID 断言失败；现有实现仍输出旧的 `实例状态`/裸会话标题，不会从 active questions 补 `QID`，且 orphan active question 会被 no-instances 早退隐藏。

- [ ] **Step 7: 实现 `/status` 排版函数与实例标题**

在 `src/wechat/status-format.ts` 中新增标题 helper：

```ts
function formatInstanceTitle(snapshot: Pick<WechatInstanceStatusSnapshot, "instanceName" | "instanceID">, fallback: string): string {
  const name = isNonEmptyString(snapshot.instanceName) ? snapshot.instanceName.trim() : fallback
  return `## 实例：${name || "未命名实例"}`
}

function formatSessionTitle(session: SessionDigest): string {
  const title = isNonEmptyString(session.title) ? session.title.trim() : "未命名会话"
  return `### 会话：${title}`
}
```

把 `formatAggregatedStatusReply()` 内每个 instance 的输出调整为 section 化：

```ts
for (const instance of input.instances) {
  if (instance.status === "timeout/unreachable") {
    sections.push("## 实例：timeout/unreachable")
    sections.push("---")
    sections.push("timeout/unreachable")
    continue
  }

  const snapshot = normalizeSnapshot(instance.snapshot)
  sections.push(formatInstanceTitle(snapshot, "未命名实例"))
  sections.push("---")

  const sessions = pickTopSessions(snapshot.sessions)
  if (sessions.length === 0) {
    sections.push("- no active sessions")
  } else {
    for (const session of sessions) {
      sections.push(formatSessionTitle(session))
      sections.push(formatSessionTags(session))
      // 保留原 todo、questionHighlights、unavailable、highlights 输出顺序
    }
  }

  const instanceUnavailable = toInstanceUnavailable(snapshot.unavailable)
  if (instanceUnavailable.length > 0) {
    sections.push(`instance unavailable: ${instanceUnavailable.join(", ")}`)
  }
}
```

保留原 session 内部输出顺序：tag -> checklist todo -> question summary -> session unavailable -> non-todo/non-question highlights。

- [ ] **Step 8: 实现 active question 派生与 `/status` QID 补全**

在 `src/wechat/status-format.ts` 增加类型与 helper：

```ts
type ActiveQuestionTodoItem = {
  handle: string
  summary: string
  instanceID?: string
  createdAt?: number
}

function formatQuestionSummary(prompt: unknown): string {
  const record = asObject(prompt)
  if (isNonEmptyString(record.title)) {
    return record.title.trim()
  }
  if (isNonEmptyString(record.body)) {
    return record.body.trim()
  }
  return "待回复问题"
}

function sortActionItems<T extends { handle: string; createdAt?: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftHasCreatedAt = typeof left.createdAt === "number" && Number.isFinite(left.createdAt)
    const rightHasCreatedAt = typeof right.createdAt === "number" && Number.isFinite(right.createdAt)
    if (leftHasCreatedAt && rightHasCreatedAt && left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt
    }
    if (leftHasCreatedAt !== rightHasCreatedAt) {
      return leftHasCreatedAt ? -1 : 1
    }
    return left.handle.localeCompare(right.handle)
  })
}

function listActiveQuestionTodoItems(view: BrokerAuthoritativeView | undefined): ActiveQuestionTodoItem[] {
  if (!view) {
    return []
  }
  const items = Object.values(view.active.questions)
    .map((value) => asObject(value))
    .map((record) => {
      const handle = isNonEmptyString(record.handle) ? record.handle.trim() : ""
      if (!handle) {
        return null
      }
      const instanceID = isNonEmptyString(record.scopeKey)
        ? record.scopeKey.trim()
        : isNonEmptyString(record.instanceID)
          ? record.instanceID.trim()
          : undefined
      return {
        handle,
        summary: formatQuestionSummary(record.prompt),
        ...(instanceID ? { instanceID } : {}),
        ...(typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? { createdAt: record.createdAt } : {}),
      }
    })
    .filter((item): item is ActiveQuestionTodoItem => item !== null)
  return sortActionItems(items)
}

function formatStatusQuestionItem(item: ActiveQuestionTodoItem): string[] {
  return [
    "待回复问题",
    `QID：${item.handle}`,
    `摘要：${item.summary}`,
    `回复：/reply ${item.handle} 你的回复`,
  ]
}
```

排序规则是：两边都有有效 `createdAt` 时按时间升序；只有一边有 `createdAt` 时，有时间的排在前面；两边时间相同或都缺失时按 handle 字典序排序。

把 broker-view `/status` 入口改成先派生 questions，再传给聚合 formatter。推荐最小签名变更：

```ts
export type AggregatedStatusReplyInput = {
  requestId: string
  instances: AggregatedStatusInstance[]
  activeQuestions?: ActiveQuestionTodoItem[]
}
```

在 `formatAggregatedStatusReply()` 内，对每个 online instance 输出完 session 后追加本实例相关 active questions：

```ts
const activeQuestions = input.activeQuestions ?? []
if ((!Array.isArray(input.instances) || input.instances.length === 0) && activeQuestions.length === 0) {
  return "wechat status: no online instances"
}

const questionsByInstance = new Map<string, ActiveQuestionTodoItem[]>()
for (const item of activeQuestions) {
  if (item.instanceID) {
    const existing = questionsByInstance.get(item.instanceID) ?? []
    existing.push(item)
    questionsByInstance.set(item.instanceID, existing)
  }
}
const renderedQuestionHandles = new Set<string>()
```

在每个 online instance section 里、`instance unavailable` 前追加：

```ts
for (const question of questionsByInstance.get(instance.instanceID) ?? []) {
  if (renderedQuestionHandles.has(question.handle)) {
    continue
  }
  sections.push(...formatStatusQuestionItem(question))
  renderedQuestionHandles.add(question.handle)
}
```

这里必须使用 `AggregatedStatusInstance.instanceID` 作为归属 key，不要用 `snapshot.instanceID`；`normalizeSnapshot()` 在输入缺失时会 fallback 到 `unknown-instance`，用它归类会把本该属于实例的问题错误放进未知实例段。

在 timeout/unreachable instance section 里也追加同样的 question 渲染逻辑，标题仍保持 `## 实例：timeout/unreachable`，不要输出内部 `instanceID`。

在所有 instances 循环结束后追加未归属或未渲染的问题：

```ts
const remainingQuestions = activeQuestions
  .filter((item) => !renderedQuestionHandles.has(item.handle))
  .filter((item, index, array) => array.findIndex((candidate) => candidate.handle === item.handle) === index)

if (remainingQuestions.length > 0) {
  sections.push("## 实例：未知实例")
  sections.push("---")
  for (const question of remainingQuestions) {
    sections.push(...formatStatusQuestionItem(question))
  }
}
```

无实例归属的问题不进入 `questionsByInstance`，会在 `remainingQuestions` 中统一进入未知实例段；不要把已渲染的同 handle 再次推入未知实例段。

同时修正 `buildBrokerViewSnapshot()` 中 retry synthetic session 的标题：有 `sessionID` 时也不要把 raw `sessionID` 当 title，统一使用安全标题 `通知投递异常`，避免新 `### 会话：...` 标题暴露内部 sessionID。

最后把 `formatAggregatedStatusReplyFromBrokerView()` 改成：

```ts
export function formatAggregatedStatusReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string {
  return formatAggregatedStatusReply({
    requestId: "broker-authoritative-view",
    instances: buildAggregatedStatusInstancesFromBrokerView(view),
    activeQuestions: listActiveQuestionTodoItems(view),
  })
}
```

- [ ] **Step 9: 跑 `/status` 定向测试确认通过**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(/status 文案边界|/status formatter: bridge|broker-entry slash handler: /status)" test/wechat-status-flow.test.js`

Expected: 相关 `/status` 测试 PASS；输出含实例标题、会话标题、分隔线和 active QID；内部 ID 负断言仍 PASS。

### Task 3: `/todo` formatter 测试与实现

**Files:**
- Modify: `src/wechat/status-format.ts`
- Modify: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 新增 `/todo` formatter 空状态测试**

在 formatter 测试区新增：

```js
test("/todo formatter: 无 active 待处理事项时返回精确空状态", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}-todo-empty`)

  assert.equal(statusFormat.formatTodoReplyFromBrokerView(undefined), "当前没有待回复或待处理事项")
  assert.equal(statusFormat.formatTodoReplyFromBrokerView({
    connections: {},
    active: {
      instances: {},
      sessions: {},
      questions: {},
      permissions: {},
      naturalStops: {},
      retryErrors: {},
    },
    terminalMetadata: {},
    retainedOccupancy: {},
    commandLedger: {},
    legacyHandleClosures: {},
  }), "当前没有待回复或待处理事项")
})
```

- [ ] **Step 2: 新增 `/todo` 三类事项、排序、内部 ID 负断言测试**

在 formatter 测试区新增：

```js
test("/todo formatter: 三类 active 事项按类型分组、稳定排序且不泄露内部 ID", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}-todo-full`)
  const view = {
    connections: {},
    active: {
      instances: {},
      sessions: {
        "session-normal-todo": {
          instanceID: "instance-normal-todo",
          sessionID: "session-normal-todo",
          title: "普通 todo 会话",
          todoItems: [{ status: "pending", content: "普通 session todo 不应进入 /todo" }],
        },
      },
      questions: {
        "route-question-late": {
          routeKey: "route-question-late",
          handle: "q2",
          requestID: "request-question-late",
          scopeKey: "instance-question-late",
          instanceID: "instance-question-late",
          createdAt: 10,
          prompt: { body: "第二个问题正文", mode: "text" },
        },
        "route-question-early": {
          routeKey: "route-question-early",
          handle: "q1",
          requestID: "request-question-early",
          scopeKey: "instance-question-early",
          instanceID: "instance-question-early",
          createdAt: 10,
          prompt: { title: "第一个问题标题", body: "第一个问题正文", mode: "text" },
        },
        "route-question-newer": {
          routeKey: "route-question-newer",
          handle: "q3",
          requestID: "request-question-newer",
          scopeKey: "instance-question-newer",
          instanceID: "instance-question-newer",
          createdAt: 20,
          prompt: { title: "第三个问题标题", mode: "text" },
        },
      },
      permissions: {
        "route-permission-b": {
          routeKey: "route-permission-b",
          handle: "p2",
          requestID: "request-permission-b",
          scopeKey: "instance-permission-b",
          instanceID: "instance-permission-b",
          prompt: { title: "权限 B", type: "tool", description: "npm test" },
        },
        "route-permission-a": {
          routeKey: "route-permission-a",
          handle: "p1",
          requestID: "request-permission-a",
          scopeKey: "instance-permission-a",
          instanceID: "instance-permission-a",
          createdAt: 5,
          prompt: { description: "bash: npm run build" },
        },
      },
      naturalStops: {
        s2: {
          handle: "s2",
          scopeKey: "instance-natural-b",
          instanceID: "instance-natural-b",
          sessionID: "session-natural-b",
          replyTarget: { instanceID: "instance-natural-b", sessionID: "session-natural-b" },
          redactedSummary: "第二个自然结束",
        },
        s0: {
          handle: "s0",
          scopeKey: "instance-natural-zero",
          instanceID: "instance-natural-zero",
          sessionID: "session-natural-zero",
          replyTarget: { instanceID: "instance-natural-zero", sessionID: "session-natural-zero" },
          redactedSummary: "无时间自然结束",
        },
        s1: {
          handle: "s1",
          scopeKey: "instance-natural-a",
          instanceID: "instance-natural-a",
          sessionID: "session-natural-a",
          replyTarget: { instanceID: "instance-natural-a", sessionID: "session-natural-a" },
          createdAt: 1,
          redactedSummary: "需要补充自然中止说明",
          severityAdvice: "已停止并等待你的回复",
        },
      },
      retryErrors: {},
    },
    terminalMetadata: {
      "route-terminal-old": { handle: "sold", reason: "continued" },
    },
    retainedOccupancy: {
      "old-natural": { handle: "sretained" },
    },
    commandLedger: {},
    legacyHandleClosures: {
      slegacy: { kind: "naturalStop", handle: "slegacy", reason: "continued" },
    },
  }

  const reply = statusFormat.formatTodoReplyFromBrokerView(view)

  assert.match(reply, /^待处理事项\n/)
  assert.match(reply, /【问题】/)
  assert.match(reply, /【权限】/)
  assert.match(reply, /【自然结束】/)
  assert.match(reply, /QID：q1/)
  assert.match(reply, /摘要：第一个问题标题/)
  assert.match(reply, /回复：\/reply q1 你的回复/)
  assert.match(reply, /QID：q2/)
  assert.match(reply, /摘要：第二个问题正文/)
  assert.match(reply, /QID：q3/)
  assert.match(reply, /摘要：第三个问题标题/)
  assert.match(reply, /PID：p1/)
  assert.match(reply, /摘要：bash: npm run build/)
  assert.match(reply, /允许一次：\/allow p1 once/)
  assert.match(reply, /始终允许：\/allow p1 always/)
  assert.match(reply, /拒绝：\/allow p1 reject/)
  assert.match(reply, /PID：p2/)
  assert.match(reply, /摘要：权限 B：npm test/)
  assert.match(reply, /SID：s1/)
  assert.match(reply, /建议：已停止并等待你的回复/)
  assert.match(reply, /回复：\/reply s1 继续处理/)
  assert.match(reply, /SID：s0/)
  assert.match(reply, /SID：s2/)

  assert.equal(reply.indexOf("QID：q1") < reply.indexOf("QID：q2"), true)
  assert.equal(reply.indexOf("QID：q2") < reply.indexOf("QID：q3"), true)
  assert.equal(reply.indexOf("PID：p1") < reply.indexOf("PID：p2"), true)
  assert.equal(reply.indexOf("SID：s1") < reply.indexOf("SID：s0"), true)
  assert.equal(reply.indexOf("SID：s0") < reply.indexOf("SID：s2"), true)
  assert.equal(reply.indexOf("SID：s1") < reply.indexOf("SID：s2"), true)
  assert.equal(reply.indexOf("【问题】") < reply.indexOf("【权限】"), true)
  assert.equal(reply.indexOf("【权限】") < reply.indexOf("【自然结束】"), true)

  assert.doesNotMatch(reply, /普通 session todo 不应进入 \/todo/)
  assert.doesNotMatch(reply, /slegacy|sretained|sold/)
  assert.doesNotMatch(reply, /legacyHandleClosures|retainedOccupancy|terminalMetadata|todoItems/)
  assert.doesNotMatch(reply, /request-question|route-question|request-permission|route-permission|instance-question|instance-permission|instance-natural|session-natural|instanceID|sessionID|requestID|routeKey/)
})
```

- [ ] **Step 3: 跑 `/todo` formatter 测试确认失败**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "/todo formatter" test/wechat-status-flow.test.js`

Expected: 空状态测试可能已因临时占位通过，但三类事项测试失败，因为 formatter 尚未读取 active records。

- [ ] **Step 4: 实现 `/todo` 数据结构与摘要 helper**

在 `src/wechat/status-format.ts` 扩展类型：

```ts
type ActivePermissionTodoItem = {
  handle: string
  summary: string
  createdAt?: number
}

type ActiveNaturalStopTodoItem = {
  handle: string
  summary: string
  severityAdvice?: string
  createdAt?: number
}
```

新增 permission 与 natural-stop 摘要 helper：

```ts
function formatPermissionSummary(prompt: unknown): string {
  const record = asObject(prompt)
  const title = isNonEmptyString(record.title) ? record.title.trim() : ""
  const description = isNonEmptyString(record.description) ? record.description.trim() : ""
  if (title && description) {
    return `${title}：${description}`
  }
  if (title) {
    return title
  }
  if (description) {
    return description
  }
  return "待处理权限请求"
}

function formatNaturalStopSummary(record: Record<string, unknown>): string {
  return isNonEmptyString(record.redactedSummary)
    ? record.redactedSummary.trim()
    : "需要补充自然中止说明"
}
```

新增 list helpers：

```ts
function listActivePermissionTodoItems(view: BrokerAuthoritativeView | undefined): ActivePermissionTodoItem[] {
  if (!view) {
    return []
  }
  const items = Object.values(view.active.permissions)
    .map((value) => asObject(value))
    .map((record) => {
      const handle = isNonEmptyString(record.handle) ? record.handle.trim() : ""
      if (!handle) {
        return null
      }
      return {
        handle,
        summary: formatPermissionSummary(record.prompt),
        ...(typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? { createdAt: record.createdAt } : {}),
      }
    })
    .filter((item): item is ActivePermissionTodoItem => item !== null)
  return sortActionItems(items)
}

function listActiveNaturalStopTodoItems(view: BrokerAuthoritativeView | undefined): ActiveNaturalStopTodoItem[] {
  if (!view) {
    return []
  }
  const items = Object.values(view.active.naturalStops)
    .map((value) => asObject(value))
    .map((record) => {
      const handle = isNonEmptyString(record.handle) ? record.handle.trim() : ""
      if (!handle) {
        return null
      }
      return {
        handle,
        summary: formatNaturalStopSummary(record),
        ...(isNonEmptyString(record.severityAdvice) ? { severityAdvice: record.severityAdvice.trim() } : {}),
        ...(typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? { createdAt: record.createdAt } : {}),
      }
    })
    .filter((item): item is ActiveNaturalStopTodoItem => item !== null)
  return sortActionItems(items)
}
```

- [ ] **Step 5: 实现 `formatTodoReplyFromBrokerView()`**

替换 Task 1 中的临时实现：

```ts
export function formatTodoReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string {
  const questions = listActiveQuestionTodoItems(view)
  const permissions = listActivePermissionTodoItems(view)
  const naturalStops = listActiveNaturalStopTodoItems(view)

  if (questions.length === 0 && permissions.length === 0 && naturalStops.length === 0) {
    return "当前没有待回复或待处理事项"
  }

  const lines: string[] = ["待处理事项"]

  if (questions.length > 0) {
    lines.push("", "【问题】")
    for (const item of questions) {
      lines.push(`- QID：${item.handle}`)
      lines.push(`  摘要：${item.summary}`)
      lines.push(`  回复：/reply ${item.handle} 你的回复`)
    }
  }

  if (permissions.length > 0) {
    lines.push("", "【权限】")
    for (const item of permissions) {
      lines.push(`- PID：${item.handle}`)
      lines.push(`  摘要：${item.summary}`)
      lines.push(`  允许一次：/allow ${item.handle} once`)
      lines.push(`  始终允许：/allow ${item.handle} always`)
      lines.push(`  拒绝：/allow ${item.handle} reject`)
    }
  }

  if (naturalStops.length > 0) {
    lines.push("", "【自然结束】")
    for (const item of naturalStops) {
      lines.push(`- SID：${item.handle}`)
      lines.push(`  摘要：${item.summary}`)
      if (item.severityAdvice) {
        lines.push(`  建议：${item.severityAdvice}`)
      }
      lines.push(`  回复：/reply ${item.handle} 继续处理`)
    }
  }

  return lines.join("\n")
}
```

- [ ] **Step 6: 跑 `/todo` formatter 测试确认通过**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "/todo formatter" test/wechat-status-flow.test.js`

Expected: `/todo` formatter 空状态、三类事项、排序、内部 ID 负断言全部 PASS。

### Task 4: `/todo` slash handler 集成回归与实现收口

**Files:**
- Modify: `test/wechat-status-flow.test.js`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/status-format.ts`

- [ ] **Step 1: 扩展 `broker-entry` active 三类事项回归测试**

在 `broker-entry slash handler: 只读 broker-state-store 的 active question/permission/natural-stop 也能返回完整用户面` 测试中，现有三个 reply/allow 断言后追加：

```js
const todoReply = await handler({ type: "todo" })
assert.match(todoReply, /^待处理事项\n/)
assert.match(todoReply, /【问题】/)
assert.match(todoReply, /QID：qbroker1/)
assert.match(todoReply, /摘要：补充说明/)
assert.match(todoReply, /回复：\/reply qbroker1 你的回复/)
assert.match(todoReply, /【权限】/)
assert.match(todoReply, /PID：pbroker1/)
assert.match(todoReply, /允许一次：\/allow pbroker1 once/)
assert.match(todoReply, /始终允许：\/allow pbroker1 always/)
assert.match(todoReply, /拒绝：\/allow pbroker1 reject/)
assert.match(todoReply, /【自然结束】/)
assert.match(todoReply, /SID：sbroker1/)
assert.match(todoReply, /摘要：需要补充自然中止说明/)
assert.match(todoReply, /建议：已停止并等待你的回复/)
assert.match(todoReply, /回复：\/reply sbroker1 继续处理/)
assert.doesNotMatch(todoReply, /route-broker-only|q-broker-only|p-broker-only|instance-broker-only|session-broker-only|requestID|routeKey|instanceID|sessionID/)
```

- [ ] **Step 2: 确认 broker-entry `/todo` 空状态测试未被覆盖掉**

确认 Task 1 Step 4 中新增的独立测试 `broker-entry slash handler: /todo 无 active 事项时返回精确空状态` 仍存在，且没有被 active 三类事项测试替代。该测试必须继续包含这个精确断言：

```js
assert.equal(await handler({ type: "todo" }), "当前没有待回复或待处理事项")
```

不要在 Task 4 再次新增同名测试；这一步只是防止后续编辑误删 Task 1 的空状态覆盖。

- [ ] **Step 3: 确认 broker-server legacy slash handler `/todo` 空状态断言未被覆盖掉**

确认 Task 1 Step 4 已经在 `broker slash handler: /status 走 collectStatus formatter，其它 slash 透传结构化命令` 测试中加入以下断言：

```js
assert.equal(
  await server.handleWechatSlashCommand({ type: "todo" }),
  "当前没有待回复或待处理事项",
)
```

不要重复插入同一断言；这条测试锁定 `{ type: "todo" }` 不再落入旧 `/allow` placeholder。

- [ ] **Step 4: 跑 slash handler 定向测试确认回归覆盖**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(/todo|broker slash handler: /status 走 collectStatus|broker-entry slash handler: 只读 broker-state-store)" test/wechat-status-flow.test.js`

Expected: PASS。Task 1 已建立 handler 红灯，Task 3 已实现 formatter；这里是补充更完整的集成回归覆盖。若失败，通常是 handler 分支遗漏、formatter 输出不完整，或内部 ID 负断言被破坏。

- [ ] **Step 5: 收口 handler 显式分支与 `/status` 提示**

确认 `src/wechat/broker-entry.ts` returned handler 的顺序是：

```ts
if (command.type === "status") {
  return handleStatusCommand()
}

if (command.type === "todo") {
  const brokerView = await readBrokerAuthoritativeView()
  return formatTodoReplyFromBrokerView(brokerView)
}

if (command.type === "reply") {
  // existing reply question / natural-stop logic
}

if (command.type === "recover") {
  // existing recover logic
}

if (command.type !== "allow") {
  return "未知命令"
}

// existing permission allow logic
```

确认 `src/wechat/broker-server.ts` legacy handler 的顺序是：

```ts
if (command.type === "status") {
  const result = await collectStatus()
  return result.reply
}

if (command.type === "todo") {
  const view = readBrokerAuthoritativeView(liveWsCoordinator.getState())
  return formatTodoReplyFromBrokerView(view)
}

if (command.type === "reply") {
  return "命令暂未实现：/reply"
}

if (command.type === "allow") {
  return "命令暂未实现：/allow"
}

return "未知命令"
```

如果实现了 spec 中“存在 permission 或 natural-stop 时 `/status` 可提示 `/todo`”，只从 broker view 派生，追加一行：

```ts
if (hasActivePermissionOrNaturalStop(view)) {
  sections.push("完整待处理清单见 /todo")
}
```

这条是可选增强；如果加入，必须增加测试断言，避免未测代码。

- [ ] **Step 6: 跑 slash handler 定向测试确认通过**

Run: `npm run build && node --test --test-concurrency=1 --test-name-pattern "(/todo|broker slash handler: /status 走 collectStatus|broker-entry slash handler: 只读 broker-state-store)" test/wechat-status-flow.test.js`

Expected: `/todo` broker-entry 和 broker-server handler 全部 PASS；`/todo` 不落入 `/allow` placeholder。

### Task 5: 相关分片验证与回归修复

**Files:**
- Modify as needed: `src/wechat/status-format.ts`
- Modify as needed: `src/wechat/command-parser.ts`
- Modify as needed: `src/wechat/broker-entry.ts`
- Modify as needed: `src/wechat/broker-server.ts`
- Modify as needed: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 运行完整 WeChat status flow early 分片**

Run: `npm run build && npm run test:serial:wechat-status-flow:early`

Expected: PASS。若失败，优先检查新增测试是否落在 early 分片、是否需要调整 test-name-pattern，或 formatter 文案变更是否破坏旧断言。

- [ ] **Step 2: 运行完整 WeChat status flow late 分片**

Run: `npm run test:serial:wechat-status-flow:late`

Expected: PASS。late 分片不应因为 union 新增 `todo` 或 handler guard 影响 `/reply`、`/allow`、`/recover` 既有行为。

- [ ] **Step 3: 运行 broker 相关分片**

Run: `npm run test:serial:wechat-ws-core && npm run test:serial:wechat-broker-lifecycle && npm run test:serial:wechat-notification-flow`

Expected: PASS。若出现 `status-format.ts` 类型或 authoritative view 结构假设问题，在 formatter helper 中收窄 `unknown` 读取，不要改 broker-state-store schema。

- [ ] **Step 4: 运行完整测试或按基线方式拆分**

首选：

Run: `npm test`

Expected: PASS。

如果工具超时但没有失败，按 baseline 的拆分方式继续 fresh 验证：

```bash
npm run build
npm run test:serial:wechat-status-flow:early
npm run test:serial:wechat-ws-core
npm run test:serial:wechat-broker-lifecycle
npm run test:serial:wechat-notification-flow
npm run test:serial:plugin
npm run test:serial:wechat-openclaw-guided-smoke
npm run test:serial:wechat-opencode-real-host-gate
npm run test:serial:wechat-status-flow:late
npm run test:parallel:shard
```

Expected: 所有分片 PASS；若个别长分片因工具超时，需要继续从未完成分片开始跑完，并保存 fresh 输出。

- [ ] **Step 5: 检查 worktree 差异，不提交**

Run: `git status --short && git diff -- src/wechat/command-parser.ts src/wechat/status-format.ts src/wechat/broker-entry.ts src/wechat/broker-server.ts test/wechat-status-flow.test.js docs/superpowers/plans/2026-04-27-wechat-status-todo-implementation.md`

Expected: 只包含本计划相关文件。不要运行 `git commit`，除非用户明确要求提交。

## 自检

- Spec 覆盖：parser、`/status` 排版、QID 正负例、top sessions 裁剪保护、`/todo` 三类事项、空状态、排序、内部 ID 负断言、broker-entry 与 broker-server handler 均有任务覆盖。
- 占位扫描：本文没有使用未定义的占位实现；`/todo` 是命令名，不是待补事项标记。
- 类型一致性：新增公开 formatter 签名固定为 `formatTodoReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string`；`WechatSlashCommand` 新增分支为 `{ type: "todo" }`。
- 提交策略：计划明确不创建 commit，遵守当前会话和仓库的 git 操作约束。
