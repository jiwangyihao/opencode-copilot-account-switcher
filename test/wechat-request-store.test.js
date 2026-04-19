import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-request-store-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const handle = await import("../dist/wechat/handle.js")
const requestStore = await import("../dist/wechat/request-store.js")
const statePaths = await import("../dist/wechat/state-paths.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("routeKey 与 handle 生成稳定，handle 大小写不敏感", () => {
  const routeKeyA = handle.createRouteKey({ kind: "question", requestID: "REQ-001" })
  const routeKeyB = handle.createRouteKey({ kind: "question", requestID: "req-001" })

  assert.equal(routeKeyA, routeKeyB)

  const existing = new Set(["q1"])
  const next = handle.createHandle("question", existing)
  assert.equal(next, "q2")

  assert.equal(handle.normalizeHandle("Q2"), "q2")
  assert.equal(handle.normalizeHandle("q2"), "q2")
})

test("open request 可通过 handle 查询", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-open-lookup-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-open-lookup-1" }),
    handle: "q1",
    wechatAccountId: "wx-lookup",
    userId: "u-lookup",
    createdAt: 1_700_000_111_000,
  })

  const found = await requestStore.findOpenRequestByHandle({
    kind: "question",
    handle: "Q1",
  })

  assert.equal(found?.routeKey, created.routeKey)
  assert.equal(found?.handle, "q1")
})

test("open request 在未提供 scopeKey 时仍可通过 request identity 查询且保持原 handle", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "identity-permission-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "identity-permission-1" }),
    handle: "p1",
    scopeKey: "instance-identity",
    wechatAccountId: "wx-identity",
    userId: "u-identity",
    createdAt: 1_700_000_222_000,
  })

  const found = await requestStore.findOpenRequestByIdentity({
    kind: "permission",
    requestID: "identity-permission-1",
    wechatAccountId: "wx-identity",
    userId: "u-identity",
  })

  assert.equal(found?.routeKey, created.routeKey)
  assert.equal(found?.handle, "p1")
})

test("open request 在提供 scopeKey 时仍要求 request identity 精确匹配该 scopeKey", async () => {
  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "identity-permission-2",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "identity-permission-2", scopeKey: "instance-identity-a" }),
    handle: "p2",
    scopeKey: "instance-identity-a",
    wechatAccountId: "wx-identity",
    userId: "u-identity",
    createdAt: 1_700_000_222_100,
  })

  const found = await requestStore.findOpenRequestByIdentity({
    kind: "permission",
    requestID: "identity-permission-2",
    wechatAccountId: "wx-identity",
    userId: "u-identity",
    scopeKey: "instance-identity-b",
  })

  assert.equal(found, undefined)
})

test("open request 在未提供 scopeKey 且跨多个 scope 命中同一 identity 时不会返回歧义结果", async () => {
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "identity-ambiguous-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "identity-ambiguous-1", scopeKey: "instance-a" }),
    handle: "q21",
    scopeKey: "instance-a",
    wechatAccountId: "wx-ambiguous",
    userId: "u-ambiguous",
    createdAt: 1_700_000_222_200,
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "identity-ambiguous-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "identity-ambiguous-1", scopeKey: "instance-b" }),
    handle: "q22",
    scopeKey: "instance-b",
    wechatAccountId: "wx-ambiguous",
    userId: "u-ambiguous",
    createdAt: 1_700_000_222_300,
  })

  const found = await requestStore.findOpenRequestByIdentity({
    kind: "question",
    requestID: "identity-ambiguous-1",
    wechatAccountId: "wx-ambiguous",
    userId: "u-ambiguous",
  })

  assert.equal(found, undefined)
})

test("scopeKey 会持久化到 request 记录，并支持按 scope 批量 expire open 请求", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-scope-expire-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-scope-expire-1", scopeKey: "instance-a" }),
    handle: "q12",
    scopeKey: "instance-a",
    wechatAccountId: "wx-scope",
    userId: "u-scope",
    createdAt: 1_700_000_222_500,
  })

  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-scope-expire-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-scope-expire-1", scopeKey: "instance-b" }),
    handle: "p12",
    scopeKey: "instance-b",
    wechatAccountId: "wx-scope",
    userId: "u-scope",
    createdAt: 1_700_000_222_600,
  })

  const stored = await requestStore.findRequestByRouteKey({
    kind: "question",
    routeKey: created.routeKey,
  })
  assert.equal(stored?.scopeKey, "instance-a")

  const expired = await requestStore.expireOpenRequestsForScope({
    scopeKey: "instance-a",
    expiredAt: 1_700_000_223_000,
  })
  assert.equal(expired.length, 1)
  assert.equal(expired[0]?.routeKey, created.routeKey)
  assert.equal(expired[0]?.status, "expired")

  const untouched = await requestStore.findOpenRequestByHandle({
    kind: "permission",
    handle: "p12",
  })
  assert.equal(untouched?.status, "open")
})

test("question request 会持久化题面摘要与选项元数据", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-structured-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-structured-1" }),
    handle: "q31",
    wechatAccountId: "wx-structured",
    userId: "u-structured",
    createdAt: 1_700_600_000_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const stored = await requestStore.findRequestByRouteKey({
    kind: "question",
    routeKey: created.routeKey,
  })

  assert.equal(stored?.prompt?.mode, "single")
  assert.equal(stored?.prompt?.options?.[1]?.value, "production")
})

test("request identity 查询对大小写与首尾空白归一化后仍命中同一 open 记录", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "Req-Normalized-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "Req-Normalized-1" }),
    handle: "q5",
    wechatAccountId: "wx-normalized",
    userId: "u-normalized",
    createdAt: 1_700_000_223_000,
  })

  const found = await requestStore.findOpenRequestByIdentity({
    kind: "question",
    requestID: "  req-normalized-1  ",
    wechatAccountId: "wx-normalized",
    userId: "u-normalized",
  })

  assert.equal(found?.routeKey, created.routeKey)
  assert.equal(found?.handle, "q5")
})

test("同一 routeKey 若 identity 不同，upsertRequest 必须拒绝覆盖", async () => {
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "req-collision-1" })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "req-collision-1",
    routeKey,
    handle: "q10",
    wechatAccountId: "wx-collision",
    userId: "u-collision",
    createdAt: 1_700_000_224_000,
  })

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "req-collision-2",
        routeKey,
        handle: "q11",
        wechatAccountId: "wx-collision",
        userId: "u-collision",
        createdAt: 1_700_000_225_000,
      }),
    /identity|routekey|different/i,
  )

  const current = await requestStore.findOpenRequestByIdentity({
    kind: "question",
    requestID: "req-collision-1",
    wechatAccountId: "wx-collision",
    userId: "u-collision",
  })
  assert.equal(current?.requestID, "req-collision-1")
  assert.equal(current?.handle, "q10")
})

test("terminal request 不会被 open lookup helper 返回", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-lookup-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-lookup-1" }),
    handle: "q7",
    wechatAccountId: "wx-terminal-lookup",
    userId: "u-terminal-lookup",
    createdAt: 1_700_000_333_000,
  })

  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: created.routeKey,
    answeredAt: 1_700_000_334_000,
  })

  const byHandle = await requestStore.findOpenRequestByHandle({
    kind: "question",
    handle: "q7",
  })
  const byIdentity = await requestStore.findOpenRequestByIdentity({
    kind: "question",
    requestID: "q-terminal-lookup-1",
    wechatAccountId: "wx-terminal-lookup",
    userId: "u-terminal-lookup",
  })

  assert.equal(byHandle, undefined)
  assert.equal(byIdentity, undefined)
})

test("request store: 旧 question / permission 终结后仍可按 handle 查到 terminal metadata", async () => {
  const question = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-metadata-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-metadata-1" }),
    handle: "q12",
    wechatAccountId: "wx-terminal-metadata",
    userId: "u-terminal-metadata",
    createdAt: 1_700_000_334_000,
  })
  const permission = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-terminal-metadata-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-terminal-metadata-1" }),
    handle: "p12",
    wechatAccountId: "wx-terminal-metadata",
    userId: "u-terminal-metadata",
    createdAt: 1_700_000_334_100,
  })

  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: question.routeKey,
    answeredAt: 1_700_000_334_200,
  })
  await requestStore.markRequestRejected({
    kind: "permission",
    routeKey: permission.routeKey,
    rejectedAt: 1_700_000_334_300,
  })

  const terminalQuestion = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q12",
  })
  const terminalPermission = await requestStore.findTerminalRequestByHandle({
    kind: "permission",
    handle: "p12",
  })

  assert.equal(terminalQuestion?.terminalReason, "answered")
  assert.equal(terminalQuestion?.terminalResultSent, false)
  assert.equal(terminalPermission?.terminalReason, "rejected")
  assert.equal(terminalPermission?.terminalResultSent, false)
})

test("request store: cleanup 不覆盖更早的用户可见 terminal 原因", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-cleanup-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-cleanup-1" }),
    handle: "q13",
    wechatAccountId: "wx-terminal-cleanup",
    userId: "u-terminal-cleanup",
    createdAt: 1_700_000_334_400,
  })

  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: created.routeKey,
    answeredAt: 1_700_000_334_500,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: created.routeKey,
    cleanedAt: 1_700_000_334_600,
  })

  const terminal = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q13",
  })

  assert.equal(terminal?.status, "cleaned")
  assert.equal(terminal?.terminalReason, "answered")
})

test("request store: terminalResultSent 写回后不会回退，且 replacement 只有在存在新 handle 时才允许", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-sent-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-sent-1" }),
    handle: "q14",
    wechatAccountId: "wx-terminal-sent",
    userId: "u-terminal-sent",
    createdAt: 1_700_000_334_700,
  })

  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: created.routeKey,
    expiredAt: 1_700_000_334_800,
  })
  await requestStore.markTerminalResultSent({
    kind: "question",
    routeKey: created.routeKey,
    sentAt: 1_700_000_334_900,
  })
  await requestStore.markTerminalMetadata({
    kind: "question",
    routeKey: created.routeKey,
    terminalReason: "replaced",
  })

  const terminal = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q14",
  })

  assert.equal(terminal?.terminalResultSent, true)
  assert.equal(terminal?.terminalReason, "expired")
  assert.equal(terminal?.replacementHandle, undefined)
})

test("request store: recovery commit 会保留旧 handle 的 terminal metadata 并指向新 handle", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-recovery-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-recovery-1" }),
    handle: "q15",
    wechatAccountId: "wx-terminal-recovery",
    userId: "u-terminal-recovery",
    createdAt: 1_700_000_335_000,
  })

  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: created.routeKey,
    expiredAt: 1_700_000_335_100,
  })

  const prepared = await requestStore.prepareRecoveryRequestReopen({
    kind: "question",
    routeKey: created.routeKey,
    recoveredAt: 1_700_000_335_200,
  })
  const reopened = await requestStore.commitPreparedRecoveryRequestReopen(prepared)

  const oldTerminal = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q15",
  })
  const newOpen = await requestStore.findOpenRequestByHandle({
    kind: "question",
    handle: reopened.handle,
  })

  assert.equal(oldTerminal?.routeKey, created.routeKey)
  assert.equal(oldTerminal?.terminalReason, "replaced")
  assert.equal(oldTerminal?.replacementHandle, reopened.handle)
  assert.equal(newOpen?.routeKey, reopened.routeKey)
  assert.equal(newOpen?.requestID, created.requestID)
})

test("request store: recovery commit 后 rollback 会恢复旧 request 的 terminal metadata，不保留失效 replacementHandle", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-recovery-rollback-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-recovery-rollback-1" }),
    handle: "q16",
    wechatAccountId: "wx-terminal-recovery-rollback",
    userId: "u-terminal-recovery-rollback",
    createdAt: 1_700_000_335_300,
  })

  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: created.routeKey,
    expiredAt: 1_700_000_335_400,
  })

  const prepared = await requestStore.prepareRecoveryRequestReopen({
    kind: "question",
    routeKey: created.routeKey,
    recoveredAt: 1_700_000_335_500,
  })
  const reopened = await requestStore.commitPreparedRecoveryRequestReopen(prepared)
  await requestStore.rollbackPreparedRecoveryRequestReopen(prepared)

  const restoredOld = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q16",
  })
  const removedNew = await requestStore.findOpenRequestByHandle({
    kind: "question",
    handle: reopened.handle,
  })

  assert.equal(restoredOld?.routeKey, created.routeKey)
  assert.equal(restoredOld?.terminalReason, "expired")
  assert.equal(restoredOld?.replacementHandle, undefined)
  assert.equal(removedNew, undefined)
})

test("request store: 已有 terminal result 的 recovery commit 不再把旧 metadata 升级成 replaced", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-recovery-sent-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-recovery-sent-1" }),
    handle: "q17",
    wechatAccountId: "wx-terminal-recovery-sent",
    userId: "u-terminal-recovery-sent",
    createdAt: 1_700_000_335_600,
  })

  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: created.routeKey,
    expiredAt: 1_700_000_335_700,
  })
  await requestStore.markTerminalResultSent({
    kind: "question",
    routeKey: created.routeKey,
    sentAt: 1_700_000_335_800,
  })

  const prepared = await requestStore.prepareRecoveryRequestReopen({
    kind: "question",
    routeKey: created.routeKey,
    recoveredAt: 1_700_000_335_900,
  })
  await requestStore.commitPreparedRecoveryRequestReopen(prepared)

  const oldTerminal = await requestStore.findTerminalRequestByHandle({
    kind: "question",
    handle: "q17",
  })

  assert.equal(oldTerminal?.terminalReason, "expired")
  assert.equal(oldTerminal?.replacementHandle, undefined)
})

test("permission 被 rejected 后不再可被 handle 命中", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-terminal-rejected-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-terminal-rejected-1" }),
    handle: "p7",
    wechatAccountId: "wx-terminal-rejected",
    userId: "u-terminal-rejected",
    createdAt: 1_700_000_335_000,
  })

  await requestStore.markRequestRejected({
    kind: "permission",
    routeKey: created.routeKey,
    rejectedAt: 1_700_000_336_000,
  })

  const byHandle = await requestStore.findOpenRequestByHandle({
    kind: "permission",
    handle: "p7",
  })

  assert.equal(byHandle, undefined)
})

test("原始 requestID 不能直接被接受为 handle", () => {
  assert.throws(() => handle.assertValidHandleInput("req-raw-001"), /requestid|raw/i)
})

test("request 状态机支持 open -> answered|rejected|expired -> cleaned", async () => {
  const questionOpen = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-open-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-open-1" }),
    handle: "q1",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_000_000,
  })
  assert.equal(questionOpen.status, "open")

  const questionAnswered = await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: questionOpen.routeKey,
    answeredAt: 1_700_001_010_000,
  })
  assert.equal(questionAnswered.status, "answered")

  const questionCleaned = await requestStore.markCleaned({
    kind: "question",
    routeKey: questionOpen.routeKey,
    cleanedAt: 1_700_001_020_000,
  })
  assert.equal(questionCleaned.status, "cleaned")

  const permissionOpen = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-open-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-open-1" }),
    handle: "p1",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_100_000,
  })
  const permissionRejected = await requestStore.markRequestRejected({
    kind: "permission",
    routeKey: permissionOpen.routeKey,
    rejectedAt: 1_700_001_110_000,
  })
  assert.equal(permissionRejected.status, "rejected")

  const questionOpen2 = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-open-2",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-open-2" }),
    handle: "q3",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_200_000,
  })
  const questionExpired = await requestStore.markRequestExpired({
    kind: "question",
    routeKey: questionOpen2.routeKey,
    expiredAt: 1_700_001_210_000,
  })
  assert.equal(questionExpired.status, "expired")

  const questionExpiredCleaned = await requestStore.markCleaned({
    kind: "question",
    routeKey: questionOpen2.routeKey,
    cleanedAt: 1_700_001_220_000,
  })
  assert.equal(questionExpiredCleaned.status, "cleaned")
})

test("markCleaned() 进入保留态", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-retain-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-retain-1" }),
    handle: "p9",
    wechatAccountId: "wx-retain",
    userId: "u-retain",
    createdAt: 1_700_002_000_000,
  })

  await requestStore.markRequestAnswered({
    kind: "permission",
    routeKey: created.routeKey,
    answeredAt: 1_700_002_001_000,
  })

  await requestStore.markCleaned({
    kind: "permission",
    routeKey: created.routeKey,
    cleanedAt: 1_700_002_002_000,
  })

  const all = await requestStore.listActiveRequests()
  assert.equal(all.some((item) => item.routeKey === created.routeKey), false)

  const files = await readdir(statePaths.requestKindDir("permission"))
  assert.equal(files.includes(`${created.routeKey}.json`), true)
})

test("purgeCleanedBefore() 会物理删除超过 7 天窗口的 cleaned 文件", async () => {
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const now = 1_700_010_000_000

  const oldOne = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-old-cleaned",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-old-cleaned" }),
    handle: "q8",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: now - weekMs - 10_000,
  })
  await requestStore.markRequestRejected({
    kind: "question",
    routeKey: oldOne.routeKey,
    rejectedAt: now - weekMs - 9_000,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: oldOne.routeKey,
    cleanedAt: now - weekMs - 8_000,
  })

  const freshOne = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-fresh-cleaned",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-fresh-cleaned" }),
    handle: "q9",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: now - 5_000,
  })
  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: freshOne.routeKey,
    answeredAt: now - 4_000,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: freshOne.routeKey,
    cleanedAt: now - 3_000,
  })

  const purged = await requestStore.purgeCleanedBefore({ cutoffAt: now - weekMs })
  assert.equal(purged, 1)

  const files = await readdir(statePaths.requestKindDir("question"))
  assert.equal(files.includes(`${oldOne.routeKey}.json`), false)
  assert.equal(files.includes(`${freshOne.routeKey}.json`), true)
})

test("purgeCleanedRequestsBefore() 返回被删除的 cleaned 记录详情", async () => {
  const now = 1_700_010_500_000
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-cleaned-detail-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-cleaned-detail-1" }),
    handle: "q13",
    wechatAccountId: "wx-cleaned-detail",
    userId: "u-cleaned-detail",
    createdAt: now - 10_000,
  })
  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: created.routeKey,
    answeredAt: now - 9_000,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: created.routeKey,
    cleanedAt: now - 8_000,
  })

  const purged = await requestStore.purgeCleanedRequestsBefore({
    cutoffAt: now - 1_000,
  })

  assert.equal(purged.length, 1)
  assert.equal(purged[0]?.routeKey, created.routeKey)
  assert.equal(purged[0]?.status, "cleaned")
})

test("活动索引忽略 cleaned 记录", async () => {
  const openReq = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-active-open",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-active-open" }),
    handle: "q11",
    wechatAccountId: "wx-active",
    userId: "u-active",
    createdAt: 1_700_020_000_000,
  })

  const doneReq = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-active-cleaned",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-active-cleaned" }),
    handle: "p11",
    wechatAccountId: "wx-active",
    userId: "u-active",
    createdAt: 1_700_020_100_000,
  })
  await requestStore.markRequestExpired({
    kind: "permission",
    routeKey: doneReq.routeKey,
    expiredAt: 1_700_020_101_000,
  })
  await requestStore.markCleaned({
    kind: "permission",
    routeKey: doneReq.routeKey,
    cleanedAt: 1_700_020_102_000,
  })

  const active = await requestStore.listActiveRequests()

  assert.equal(active.some((item) => item.routeKey === openReq.routeKey), true)
  assert.equal(active.some((item) => item.routeKey === doneReq.routeKey), false)
})

test("终态 request 不允许被 upsert 复活", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-1" }),
    handle: "q21",
    wechatAccountId: "wx-terminal",
    userId: "u-terminal",
    createdAt: 1_700_030_000_000,
  })

  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: created.routeKey,
    answeredAt: 1_700_030_001_000,
  })

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-terminal-1",
        routeKey: created.routeKey,
        handle: "q21",
        wechatAccountId: "wx-terminal",
        userId: "u-terminal",
        createdAt: 1_700_030_002_000,
      }),
    /terminal|cannot upsert|not open/i,
  )
})

test("损坏或缺字段 request JSON 会抛明确格式错误", async () => {
  const brokenRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-broken-json" })
  const brokenPath = statePaths.requestStatePath("question", brokenRouteKey)
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{not-json")

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )

  const missingFieldRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-missing-field" })
  const missingFieldPath = statePaths.requestStatePath("question", missingFieldRouteKey)
  await mkdir(path.dirname(missingFieldPath), { recursive: true })
  await writeFile(
    missingFieldPath,
    JSON.stringify({
      kind: "question",
      requestID: "q-missing-field",
      routeKey: missingFieldRouteKey,
      handle: "q22",
      wechatAccountId: "wx-1",
      userId: "u-1",
      status: "open",
    }),
  )

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )
})

test("磁盘 request kind 非法值时读取与状态迁移抛格式错误", async () => {
  const badRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-bad-kind" })
  const badPath = statePaths.requestStatePath("question", badRouteKey)
  await mkdir(path.dirname(badPath), { recursive: true })
  await writeFile(
    badPath,
    JSON.stringify({
      kind: "bad-kind",
      requestID: "q-bad-kind",
      routeKey: badRouteKey,
      handle: "q31",
      wechatAccountId: "wx-bad",
      userId: "u-bad",
      status: "open",
      createdAt: 1_700_040_000_000,
    }),
  )

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey: badRouteKey,
        answeredAt: 1_700_040_010_000,
      }),
    /invalid request.*format/i,
  )
})

test("upsertRequest() 拒绝非法 routeKey", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-route",
        routeKey: "../escape",
        handle: "q41",
        wechatAccountId: "wx-route",
        userId: "u-route",
        createdAt: 1_700_050_000_000,
      }),
    /invalid routekey/i,
  )

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-route-2",
        routeKey: "question/evil",
        handle: "q42",
        wechatAccountId: "wx-route",
        userId: "u-route",
        createdAt: 1_700_050_100_000,
      }),
    /invalid routekey/i,
  )
})

test("upsertRequest() 拒绝非法 handle", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "permission",
        requestID: "p-invalid-handle",
        routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-invalid-handle" }),
        handle: "REQ-RAW-777",
        wechatAccountId: "wx-handle",
        userId: "u-handle",
        createdAt: 1_700_060_000_000,
      }),
    /handle|requestid|raw/i,
  )
})

test("upsertRequest() 拒绝非法 kind，且不会写出非法 kind 目录", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "evil",
        requestID: "q-invalid-kind",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-kind" }),
        handle: "q51",
        wechatAccountId: "wx-kind",
        userId: "u-kind",
        createdAt: 1_700_070_000_000,
      }),
    /invalid request record format/i,
  )

  await assert.rejects(
    () => readdir(path.join(statePaths.wechatStateRoot(), "requests", "evil")),
    (error) => error?.code === "ENOENT",
  )
})

test("upsertRequest() 拒绝非法 createdAt", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-created-at",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-created-at" }),
        handle: "q52",
        wechatAccountId: "wx-created-at",
        userId: "u-created-at",
        createdAt: Number.NaN,
      }),
    /invalid request record format/i,
  )
})

test("upsertRequest() 拒绝空 requestID 或空 userId", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-empty-requestid" }),
        handle: "q53",
        wechatAccountId: "wx-empty",
        userId: "u-empty",
        createdAt: 1_700_070_100_000,
      }),
    /invalid request record format/i,
  )

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "permission",
        requestID: "p-empty-user",
        routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-empty-user" }),
        handle: "p53",
        wechatAccountId: "wx-empty",
        userId: "",
        createdAt: 1_700_070_200_000,
      }),
    /invalid request record format/i,
  )
})

test("磁盘文件 kind 与目录不一致时，状态迁移被拒绝", async () => {
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-kind-drift" })
  const filePath = statePaths.requestStatePath("question", routeKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify({
      kind: "permission",
      requestID: "q-kind-drift",
      routeKey,
      handle: "q61",
      wechatAccountId: "wx-kind-drift",
      userId: "u-kind-drift",
      status: "open",
      createdAt: 1_700_090_000_000,
    }),
  )

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey,
        answeredAt: 1_700_090_010_000,
      }),
    /invalid request record format/i,
  )
})

test("markRequestAnswered() 拒绝 NaN 时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-invalid-answered-at",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-answered-at" }),
    handle: "q71",
    wechatAccountId: "wx-answer",
    userId: "u-answer",
    createdAt: 1_700_100_000_000,
  })

  const filePath = statePaths.requestStatePath("question", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey: created.routeKey,
        answeredAt: Number.NaN,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})

test("markRequestRejected() 拒绝 Infinity 时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-invalid-rejected-at",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-invalid-rejected-at" }),
    handle: "p71",
    wechatAccountId: "wx-reject",
    userId: "u-reject",
    createdAt: 1_700_100_100_000,
  })

  const filePath = statePaths.requestStatePath("permission", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestRejected({
        kind: "permission",
        routeKey: created.routeKey,
        rejectedAt: Number.POSITIVE_INFINITY,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})

test("markRequestExpired() 拒绝非法时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-invalid-expired-at",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-expired-at" }),
    handle: "q72",
    wechatAccountId: "wx-expire",
    userId: "u-expire",
    createdAt: 1_700_100_200_000,
  })

  const filePath = statePaths.requestStatePath("question", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestExpired({
        kind: "question",
        routeKey: created.routeKey,
        expiredAt: Number.NEGATIVE_INFINITY,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})
