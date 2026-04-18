# WeChat Permission 路由与文案修订 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `/allow` 在同 session 多 permission request 下的目标回写风险，并把 question / permission / `/status` 的微信文案与结构化合同一次收口到 spec 要求。

**Architecture:** 继续沿用现有 `broker-entry -> request-store / notification-store` 的 request 真相源，不引入新的 broker 中间层；`/allow` 只允许终结命中的单条 request 与其 sent notification。question 的 mixed reply 语义在 `question-interaction.ts` 内收口，question/permission 的用户可见文案在 `notification-format.ts` 收紧，`/status` 则通过 `session-digest.ts` 提供结构化 todo 数据，再由 `status-format.ts` 统一渲染成微信可读文本。

**Tech Stack:** TypeScript, Node.js test runner, existing WeChat broker/request/notification stores, current session digest + status formatter pipeline

---

## 文件结构预分解

- `src/wechat/broker-entry.ts`
  - 锁 `/allow <handle>` 只终结目标 permission request，并只 resolve 对应 notification。
- `src/wechat/question-interaction.ts`
  - 增加 `multiple + custom=true` 的 mixed reply 解析合同与稳定中文错误。
- `src/wechat/notification-format.ts`
  - 收口 question / permission 的微信文案，明确 handle、可执行命令、动作语义和 mixed reply 示例。
- `src/wechat/session-digest.ts`
  - 把 todo 从纯文本切片升级为“状态 + 内容”的结构化列表，供 `/status` formatter 使用。
- `src/wechat/status-format.ts`
  - 把 tag 改成行内 code 样式，并把 todo 渲染成固定 checklist 映射。
- `test/wechat-status-flow.test.js`
  - 补 `/allow` 定向回归、question mixed reply、`/status` 展示合同。
- `test/wechat-notification-flow.test.js`
  - 补 question / permission 文案示例与语义测试。
- `test/wechat-session-digest.test.js`
  - 补结构化 todo 数据合同测试。

### Task 1: 锁 `/allow` 只终结目标 permission request 与 notification

**Files:**
- Modify: `src/wechat/broker-entry.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁定同 session 多 permission request 时只处理目标 handle**

在 `test/wechat-status-flow.test.js` 增加至少三条回归：

```js
test("broker-entry slash handler: /allow 只终结目标 handle 对应 permission 与 notification", async () => {
  // 同一 session 下创建 p1 / p2 两条 open permission request 和各自 sent notification
  const result = await handler({ type: "allow", handle: "p1", reply: "always", message: "safe" })

  assert.equal(result, "已处理权限请求：p1 (always)")
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey1 }))?.status, "answered")
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey2 }))?.status, "open")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p1"), "utf8")).status, "resolved")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p2"), "utf8")).status, "sent")
})

test("broker-entry slash handler: /allow 失败时目标与非目标 permission 都保持原样", async () => {
  // 同一 session 下创建 p1 / p2，令 sendReplyPermissionRpc 返回 ok:false 或抛错
  const result = await handler({ type: "allow", handle: "p1", reply: "reject", message: "no" })

  assert.match(result, /处理权限请求失败/)
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey1 }))?.status, "open")
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey2 }))?.status, "open")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p1"), "utf8")).status, "sent")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p2"), "utf8")).status, "sent")
})

test("broker-entry slash handler: /allow 在远端成功但本地 finalize 失败时不 resolve 任何 notification", async () => {
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => ({ mutationId: input.mutationId, ok: true }),
    permissionMutationTestHooks: {
      beforeFinalizePermission: async () => {
        throw new Error("forced permission finalize failure")
      },
    },
  })

  await assert.rejects(
    () => handler({ type: "allow", handle: "p1", reply: "always", message: "safe" }),
    /forced permission finalize failure/,
  )
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey1 }))?.status, "open")
  assert.equal((await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: routeKey2 }))?.status, "open")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p1"), "utf8")).status, "sent")
  assert.equal(JSON.parse(await readFile(statePaths.notificationStatePath("notif-p2"), "utf8")).status, "sent")
})
```

- [ ] **Step 2: 跑定向测试确认当前行为先被锁住**

Run: `npm run build && node --test test/wechat-status-flow.test.js --test-name-pattern="/allow"`
Expected: 先看到新加的多 permission regression 失败，或者至少能证明当前实现尚未被测试锁定。

- [ ] **Step 3: 在 `broker-entry.ts` 里把 permission 终结路径继续收窄到“目标 request -> 目标 notification”**

保持实现最小化，不引入新的 store。落点是当前 `/allow` 分支里已经拿到的 `openPermission` 记录：

```ts
const openPermission = await findOpenRequestSafely({
  kind: "permission",
  handle: command.handle,
})

if (result.ok !== true) {
  return `处理权限请求失败：${result.errorMessage ?? "unknown"}`
}

const finalizedAt = Date.now()
if (command.reply === "reject") {
  await markRequestRejected({
    kind: "permission",
    routeKey: openPermission.routeKey,
    rejectedAt: finalizedAt,
  })
} else {
  await markRequestAnswered({
    kind: "permission",
    routeKey: openPermission.routeKey,
    answeredAt: finalizedAt,
  })
}

await resolveNotificationForOpenRequest({
  kind: "permission",
  routeKey: openPermission.routeKey,
  handle: openPermission.handle,
})
```

实现检查点：

- 不允许引入按 session 清理 notification 的分支。
- 失败路径必须在 `result.ok !== true` 前返回，不能先写 request 终态再报错。
- 对“远端已成功，但本地 finalize 失败”的场景，必须让目标 request 保持 `open`、目标 notification 保持 `sent/pending`，且不影响非目标 request / notification。
- 新测试只允许目标 `routeKey + handle` 这对 identity 发生变化。

为稳定覆盖“远端 reply 已成功、本地 finalize 失败”分支，在 `createBrokerWechatSlashCommandHandler()` 上增加一个仅测试使用的窄注入点：

```ts
permissionMutationTestHooks?: {
  beforeFinalizePermission?: (request: { routeKey: string; handle: string }) => Promise<void> | void
}

await input.permissionMutationTestHooks?.beforeFinalizePermission?.({
  routeKey: openPermission.routeKey,
  handle: openPermission.handle,
})
```

注入点只能放在“远端 reply 已成功、本地 request 终态尚未写入”这个接缝上，不要把整个 request-store 改成可替换实现。

- [ ] **Step 4: 重新跑 `/allow` 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js --test-name-pattern="/allow"`
Expected: PASS，且既有 `/allow` 成功/失败用例继续通过。

### Task 2: 收口 question mixed reply 合同与 question/permission 通知文案

**Files:**
- Modify: `src/wechat/question-interaction.ts`
- Modify: `src/wechat/notification-format.ts`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁定 mixed reply 解析边界与 question 文案**

在 `test/wechat-status-flow.test.js` 和 `test/wechat-notification-flow.test.js` 各补一组回归：

```js
test("broker-entry slash handler: multiple + custom=true 支持 1,3; 其他：... mixed reply", async () => {
  const result = await handler({ type: "reply", handle: "qmulti3", text: "1,3; 其他：先灰度再全量" })
  assert.equal(result, "已回复问题：qmulti3")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-mixed-1", answers: [["staging", "preview", "先灰度再全量"]] }])
})

test("broker-entry slash handler: mixed reply 只认第一个分号，其余分号保留在自定义文本里", async () => {
  const result = await handler({ type: "reply", handle: "qmulti3", text: "1,3; 其他：先灰度; 再全量" })
  assert.equal(result, "已回复问题：qmulti3")
  assert.deepEqual(replyCalls.at(-1), { requestID: "q-reply-mixed-1", answers: [["staging", "preview", "先灰度; 再全量"]] })
})

test("broker-entry slash handler: 非 multiple + custom=true 题型遇到 mixed 形态输入时返回稳定中文提示", async () => {
  const result = await handler({ type: "reply", handle: "qsinglecustom1", text: "1; 其他：补充说明" })
  assert.match(result, /当前题型不支持.*编号 \+ 自定义补充/)
})

test("broker-entry slash handler: 允许纯自定义的题目收到非 mixed 形态分号文本时仍按纯自定义处理", async () => {
  const result = await handler({ type: "reply", handle: "qmulticustom3", text: "先灰度; 再全量" })
  assert.equal(result, "已回复问题：qmulticustom3")
  assert.deepEqual(replyCalls.at(-1), { requestID: "q-reply-mixed-2", answers: [["先灰度; 再全量"]] })
})

test("broker-entry slash handler: mixed reply 去掉可选前缀后若为空则返回稳定中文提示", async () => {
  const result = await handler({ type: "reply", handle: "qmulti3", text: "1,3; 其他：" })
  assert.match(result, /混合回复格式无效/)
})

test("broker-entry slash handler: mixed reply 左半段复用多选编号校验", async () => {
  const result = await handler({ type: "reply", handle: "qmulti3", text: "1,1; 其他：重复编号" })
  assert.match(result, /选项编号不能重复/)
})

test("通知文案格式化：multiple + custom=true 同时展示编号、自定义、mixed reply 示例", async () => {
  assert.match(questionText, /\/reply qmulti2 1,2/)
  assert.match(questionText, /\/reply qmulti2 你的自定义回答/)
  assert.match(questionText, /\/reply qmulti2 1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：single + custom=true 展示编号与自定义，但不展示 mixed reply 示例", async () => {
  assert.match(questionText, /\/reply qsingle2 1/)
  assert.match(questionText, /\/reply qsingle2 你的自定义回答/)
  assert.doesNotMatch(questionText, /1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：permission 同时展示批准对象、handle、命令用法与动作语义", async () => {
  assert.match(permissionText, /允许一次：\/allow p3 once/)
  assert.match(permissionText, /始终允许：\/allow p3 always/)
  assert.match(permissionText, /拒绝：\/allow p3 reject/)
  assert.match(permissionText, /once：仅处理这一次/)
  assert.match(permissionText, /always：后续同类请求自动允许/)
  assert.match(permissionText, /reject：拒绝当前请求/)
})
```

- [ ] **Step 2: 跑 question / notification 定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-notification-flow.test.js --test-name-pattern="reply|通知文案格式化"`
Expected: FAIL，因为当前 `buildQuestionAnswersFromReply()` 还不支持 mixed reply 的完整边界，通知文案也还没有 mixed reply 示例、single + custom 的负向约束，以及 permission 动作语义说明。

- [ ] **Step 3: 在 `question-interaction.ts` 内补 mixed reply 解析，不额外拆文件**

优先保持在现有 `buildQuestionAnswersFromReply()` 内最小补齐，新增局部 helper 即可：

```ts
const separatorIndex = text.indexOf(";")
const left = separatorIndex >= 0 ? text.slice(0, separatorIndex).trim() : ""
const right = separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() : ""
const looksLikeMixed = separatorIndex >= 0 && /^\d+(,\d+)*$/.test(left)

function parseMultipleChoiceValues(raw: string, options: NonNullable<QuestionPromptSummary["options"]>) {
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean)
  const seen = new Set<string>()
  return tokens.map((token) => {
    if (seen.has(token)) {
      throw new Error(`选项编号不能重复：${token}`)
    }
    seen.add(token)
    return findOptionValue(options, token)
  })
}

if (prompt.mode === "multiple" && prompt.custom === true && looksLikeMixed) {
  const customText = right.replace(/^其他：\s*/u, "").trim()
  if (!customText) {
    throw new Error("混合回复格式无效，请使用“编号; 自定义补充”")
  }
  return [[...parseMultipleChoiceValues(left, options), customText]]
}

if (looksLikeMixed) {
  throw new Error("当前题型不支持“编号 + 自定义补充”，请按题目提示回复")
}
```

同时保留现有“允许纯自定义时，非编号形态整段按文本处理”的路径，保证 `先灰度; 再全量` 这类文本不会被误判为 mixed；并明确“只认第一个 `;`，后续分号全部保留在自定义文本里”。

- [ ] **Step 4: 在 `notification-format.ts` 里把示例文案分成“编号 / 自定义 / mixed / permission 语义”四类**

做法保持直接，在现有 formatter 里扩充辅助函数即可：

```ts
function formatQuestionReplyExamples(handle: string, mode: string | undefined, allowCustom: boolean) {
  const examples: string[] = []
  if (mode === "single") examples.push(`编号回复：/reply ${handle} 1`)
  if (mode === "multiple") examples.push(`编号回复：/reply ${handle} 1,2`)
  if (mode === "text" || allowCustom) examples.push(`自定义回复：/reply ${handle} 你的自定义回答`)
  if (mode === "multiple" && allowCustom) {
    examples.push(`混合回复：/reply ${handle} 1,3; 其他：先灰度再全量`)
  }
  return examples
}
```

permission 文案在原有三条命令下面追加三条语义说明，不删除 handle 和可执行命令。

- [ ] **Step 5: 重新跑 question / notification 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-notification-flow.test.js --test-name-pattern="reply|通知文案格式化"`
Expected: PASS，且既有 question/permission 通知文案测试继续通过。

### Task 3: 把 `/status` 的 todo 数据改成“状态 + 内容”并渲染成 checklist

**Files:**
- Modify: `src/wechat/session-digest.ts`
- Modify: `src/wechat/status-format.ts`
- Test: `test/wechat-session-digest.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 先写失败测试，锁定结构化 todo 合同、inline code tag 与四种状态映射**

补两层测试：

```js
test("buildSessionDigest: todoItems 保留 status + content，而不是只保留纯文本", () => {
  assert.deepEqual(digest.todoItems, [
    { status: "pending", content: "发布 release 草稿" },
    { status: "in_progress", content: "等待 npm 发布" },
    { status: "completed", content: "更新 README" },
    { status: "cancelled", content: "已取消的迁移任务" },
  ])
})

test("/status 文案边界：inline code tag + checklist todo + 内部 ID 继续隐藏", async () => {
  assert.match(reply, /`#busy` `#todo:4` `#question:1` `#permission:3`/)
  assert.match(reply, /\[ \] 发布 release 草稿/)
  assert.match(reply, /\[-\] 等待 npm 发布/)
  assert.match(reply, /\[x\] 更新 README/)
  assert.match(reply, /\[~\] 已取消的迁移任务/)
  assert.equal(reply.indexOf("[ ] 发布 release 草稿") < reply.indexOf("问题：是否先发 staging 再发 production"), true)
  assert.doesNotMatch(reply, /instanceID|sessionID|createdAt/)
})
```

这里的 `/status` 原始 snapshot 夹具也要同步改成结构化 todo：

```js
todoItems: [
  { status: "pending", content: "发布 release 草稿" },
  { status: "in_progress", content: "等待 npm 发布" },
  { status: "completed", content: "更新 README" },
  { status: "cancelled", content: "已取消的迁移任务" },
]
```

- [ ] **Step 2: 跑 digest / status 定向测试确认先失败**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js --test-name-pattern="buildSessionDigest|/status 文案边界|status formatter"`
Expected: FAIL，因为当前 digest 只输出 `string[]` todoItems，formatter 也还没有 inline code tag 与 checklist 映射。

- [ ] **Step 3: 在 `session-digest.ts` 把 todoItems 升级为结构化数组，并保留现有 summary 统计**

不要新增第二份 todo 状态系统，直接复用 SDK todo.status：

```ts
export type SessionDigestTodoItem = {
  status: "pending" | "in_progress" | "completed" | "cancelled"
  content: string
}

const todoItems = todos
  .map((todo) => ({
    status: normalizeTodoStatus(todo.status),
    content: typeof todo.content === "string" ? todo.content.trim() : "",
  }))
  .filter((item) => item.content.length > 0)
```

要求：

- `todoSummary.total`、`inProgress`、`completed` 继续保留，避免影响 tag 计数。
- `todoItems` 改成结构化后，同步更新 `SessionDigest` 类型与现有测试夹具。
- 不把 status 文案提前拼成字符串，保持 formatter 拿到原始状态值再渲染。

- [ ] **Step 4: 在 `status-format.ts` 里统一渲染 inline code tag 与 checklist todo**

建议只加两个小 helper：

```ts
function normalizeTodoItem(value: unknown): SessionDigestTodoItem | null {
  const record = asObject(value)
  if (!isTodoStatus(record.status) || !isNonEmptyString(record.content)) {
    return null
  }
  return { status: record.status, content: record.content.trim() }
}

function formatSessionTags(session: SessionDigest): string {
  return [
    session.status === "busy" ? "#busy" : session.status === "idle" ? "#idle" : `#${session.status}`,
    `#todo:${session.todoSummary.total}`,
    `#question:${session.pendingQuestionCount}`,
    `#permission:${session.pendingPermissionCount}`,
  ].map((tag) => `\`${tag}\``).join(" ")
}

function formatTodoItem(todo: SessionDigestTodoItem): string {
  const prefix = todo.status === "completed"
    ? "[x]"
    : todo.status === "in_progress"
      ? "[-]"
      : todo.status === "cancelled"
        ? "[~]"
        : "[ ]"
  return `${prefix} ${todo.content}`
}
```

然后同步修改 `normalizeSessionDigest()` 对 `todoItems` 的解析，把原来的 `string[]` 读取改成结构化 `Array<{ status, content }>`，在那里统一丢弃非法 `status` 或空 `content`；最后再把 `for (const todo of session.todoItems ?? [])` 的输出从 `todo: ${todo}` 改成 `formatTodoItem(todo)`。

- [ ] **Step 5: 重新跑 digest / status 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js --test-name-pattern="buildSessionDigest|/status 文案边界|status formatter"`
Expected: PASS，且现有“最近 3 个 session / internal ID 不前置 / malformed snapshot 过滤”测试继续通过。

### Task 4: 跑整组微信回归并对照 spec 做收尾验收

**Files:**
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-session-digest.test.js`

- [ ] **Step 1: 跑本轮相关定向测试集合**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-notification-flow.test.js test/wechat-session-digest.test.js`
Expected: PASS。

- [ ] **Step 2: 跑仓库全量测试，拿 fresh 证据**

Run: `npm test`
Expected: PASS。

- [ ] **Step 3: 对照 spec 做人工验收核对**

核对清单：

- `/allow p1` 只终结目标 request 与目标 notification，非目标保持 open / sent。
- `multiple + custom=true` 支持 `/reply q4 1,3; 其他：先灰度再全量`，其它题型 mixed 形态输入返回稳定中文提示。
- question 通知明确区分编号回复、自定义回复、mixed reply（当适用）。
- permission 通知同时展示批准对象、handle、三条可执行命令与 `once/always/reject` 语义。
- `/status` 使用 `` `#busy` `` 这类 inline code tag，todo 以 `[ ]/[x]/[-]/[~] + 内容` 渲染，内部 ID 不进入主展示区。

- [ ] **Step 4: 保持 release/commit 链路暂停，直到签名问题被显式解决**

当前已知约束：本地 GPG / keyboxd 仍未恢复，因此这一轮实现完成后不要自动提交或发版；只有在用户明确要求且签名链路恢复后，再进入 commit / release 流程。如果实现过程中发现必须改 spec 或必须触碰范围外文件，停止执行并回到 review / 澄清流程，不在本计划内自行改 spec。
