import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-dead-letter-store-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const statePaths = await import("../dist/wechat/state-paths.js")
const deadLetterStore = await import("../dist/wechat/dead-letter-store.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("dead-letter store 可写入并列举记录", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-dead-1",
    requestID: "q-dead-1",
    handle: "qdead1",
    scopeKey: "instance-dead-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_100_001_000,
    wechatAccountId: "wx-dead",
    userId: "u-dead",
    instanceID: "instance-dead-a",
    sessionID: "session-dead-a",
  })

  const listed = await deadLetterStore.listDeadLetters("question")
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.routeKey, "question-dead-1")
  assert.equal(listed[0]?.reason, "instanceStale")

  const readBack = await deadLetterStore.readDeadLetter("question", "question-dead-1")
  assert.equal(readBack?.handle, "qdead1")
  assert.equal(readBack?.finalStatus, "expired")
})

test("dead-letter store 可列出明确可恢复的记录", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recoverable-1",
    requestID: "q-recoverable-1",
    handle: "qrecover1",
    scopeKey: "instance-recover-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_100_000,
    finalizedAt: 1_700_100_101_000,
    wechatAccountId: "wx-recover-a",
    userId: "u-recover-a",
    instanceID: "instance-recover-a",
  })
  await deadLetterStore.writeDeadLetter({
    kind: "permission",
    routeKey: "permission-non-recoverable-1",
    requestID: "p-non-recoverable-1",
    handle: "precover0",
    finalStatus: "cleaned",
    reason: "runtimeCleanup",
    createdAt: 1_700_100_110_000,
    finalizedAt: 1_700_100_111_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovered-1",
    requestID: "q-recovered-1",
    handle: "qrecover2",
    scopeKey: "instance-recover-b",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_120_000,
    finalizedAt: 1_700_100_121_000,
    wechatAccountId: "wx-recover-b",
    userId: "u-recover-b",
    instanceID: "instance-recover-b",
  })
  await deadLetterStore.markDeadLetterRecovered({
    kind: "question",
    routeKey: "question-recovered-1",
    recoveredAt: 1_700_100_122_000,
  })

  const recoverable = await deadLetterStore.listRecoverableDeadLetters()

  assert.deepEqual(
    recoverable.map((record) => ({ routeKey: record.routeKey, handle: record.handle, reason: record.reason })),
    [{ routeKey: "question-recoverable-1", handle: "qrecover1", reason: "instanceStale" }],
  )
})

test("dead-letter store 可按 handle 提供真正可恢复候选并列出同恢复链历史 handle", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovery-chain-active-1",
    requestID: "q-recovery-chain-1",
    handle: "qchain1",
    scopeKey: "instance-recovery-chain-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_125_000,
    finalizedAt: 1_700_100_126_000,
    wechatAccountId: "wx-recovery-chain",
    userId: "u-recovery-chain",
    instanceID: "instance-recovery-chain-a",
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovery-chain-recovered-1",
    requestID: "q-recovery-chain-1",
    handle: "qchain2",
    scopeKey: "instance-recovery-chain-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_126_000,
    finalizedAt: 1_700_100_127_000,
    wechatAccountId: "wx-recovery-chain",
    userId: "u-recovery-chain",
    instanceID: "instance-recovery-chain-a",
  })
  await deadLetterStore.markDeadLetterRecovered({
    kind: "question",
    routeKey: "question-recovery-chain-recovered-1",
    recoveredAt: 1_700_100_128_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovery-chain-orphan-1",
    requestID: "q-recovery-chain-orphan-1",
    handle: "qchain1",
    scopeKey: "instance-recovery-chain-b",
    finalStatus: "cleaned",
    reason: "runtimeCleanup",
    createdAt: 1_700_100_129_000,
    finalizedAt: 1_700_100_130_000,
    wechatAccountId: "wx-recovery-chain",
    userId: "u-recovery-chain",
    instanceID: "instance-recovery-chain-b",
  })

  assert.equal(typeof deadLetterStore.listRecoverableDeadLettersByHandle, "function")
  const recoverable = await deadLetterStore.listRecoverableDeadLettersByHandle("QCHAIN1")
  assert.deepEqual(
    recoverable.map((record) => ({ routeKey: record.routeKey, requestID: record.requestID, handle: record.handle })),
    [{
      routeKey: "question-recovery-chain-active-1",
      requestID: "q-recovery-chain-1",
      handle: "qchain1",
    }],
  )

  assert.equal(typeof deadLetterStore.listRecoveryChainHandles, "function")
  const historyHandles = await deadLetterStore.listRecoveryChainHandles({
    kind: "question",
    requestID: "q-recovery-chain-1",
    wechatAccountId: "wx-recovery-chain",
    userId: "u-recovery-chain",
  })
  assert.deepEqual(historyHandles, ["qchain1", "qchain2"])
})

test("dead-letter store 可持久化 recovery failed 元数据", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovery-failed-1",
    requestID: "q-recovery-failed-1",
    handle: "qrecoveryfailed1",
    scopeKey: "instance-recovery-failed-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_130_000,
    finalizedAt: 1_700_100_131_000,
    wechatAccountId: "wx-recovery-failed-a",
    userId: "u-recovery-failed-a",
    instanceID: "instance-recovery-failed-a",
  })

  await deadLetterStore.markDeadLetterRecoveryFailed({
    kind: "question",
    routeKey: "question-recovery-failed-1",
    recoveryErrorCode: "requestMissing",
    recoveryErrorMessage: "无法恢复请求，原始记录不存在：qrecoveryfailed1",
  })

  const readBack = await deadLetterStore.readDeadLetter("question", "question-recovery-failed-1")
  assert.equal(readBack?.recoveryStatus, "failed")
  assert.equal(readBack?.recoveryErrorCode, "requestMissing")
  assert.equal(readBack?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecoveryfailed1")
  assert.equal(readBack?.recoveredAt, undefined)
})

test("dead-letter store 不会把已 recovered 记录降级回 failed", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recovered-guard-1",
    requestID: "q-recovered-guard-1",
    handle: "qrecoveredguard1",
    scopeKey: "instance-recovered-guard-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_132_000,
    finalizedAt: 1_700_100_133_000,
    wechatAccountId: "wx-recovered-guard-a",
    userId: "u-recovered-guard-a",
    instanceID: "instance-recovered-guard-a",
  })

  await deadLetterStore.markDeadLetterRecovered({
    kind: "question",
    routeKey: "question-recovered-guard-1",
    recoveredAt: 1_700_100_134_000,
  })

  const result = await deadLetterStore.markDeadLetterRecoveryFailed({
    kind: "question",
    routeKey: "question-recovered-guard-1",
    recoveryErrorCode: "ambiguousHandle",
    recoveryErrorMessage: "找到多个可恢复的请求：qrecoveredguard1",
  })

  assert.equal(result.recoveryStatus, "recovered")
  assert.equal(result.recoveryErrorCode, undefined)
  assert.equal(result.recoveryErrorMessage, undefined)
  assert.equal(result.recoveredAt, 1_700_100_134_000)

  const reloaded = await deadLetterStore.readDeadLetter("question", "question-recovered-guard-1")
  assert.equal(reloaded?.recoveryStatus, "recovered")
  assert.equal(reloaded?.recoveryErrorCode, undefined)
  assert.equal(reloaded?.recoveryErrorMessage, undefined)
  assert.equal(reloaded?.recoveredAt, 1_700_100_134_000)
})

test("purgeDeadLettersBefore() 返回被删除记录并保留窗口内记录", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-dead-old",
    requestID: "q-dead-old",
    handle: "qdeadold",
    finalStatus: "expired",
    reason: "startupCleanup",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_100_010_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "permission",
    routeKey: "permission-dead-fresh",
    requestID: "p-dead-fresh",
    handle: "pdeadfresh",
    finalStatus: "cleaned",
    reason: "runtimeCleanup",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_200_000_000,
  })

  const purged = await deadLetterStore.purgeDeadLettersBefore(1_700_150_000_000)
  assert.equal(purged.length, 1)
  assert.equal(purged[0]?.routeKey, "question-dead-old")

  const remaining = await deadLetterStore.listDeadLetters()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.routeKey, "permission-dead-fresh")
})
