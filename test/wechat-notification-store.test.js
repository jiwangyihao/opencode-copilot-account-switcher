import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-store-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const notificationStore = await import("../dist/wechat/notification-store.js")
const statePaths = await import("../dist/wechat/state-paths.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("question / permission / sessionError 支持并遵循 pending -> sent -> resolved|failed|suppressed", async () => {
  const question = await notificationStore.upsertNotification({
    idempotencyKey: "notif-q-1",
    kind: "question",
    wechatAccountId: "wx-1",
    userId: "u-1",
    routeKey: "question-route-1",
    handle: "q1",
    createdAt: 1_700_200_000_000,
  })
  assert.equal(question.status, "pending")
  assert.equal(question.routeKey, "question-route-1")
  assert.equal(question.handle, "q1")

  const questionSent = await notificationStore.markNotificationSent({
    idempotencyKey: question.idempotencyKey,
    sentAt: 1_700_200_001_000,
  })
  assert.equal(questionSent.status, "sent")

  const questionResolved = await notificationStore.markNotificationResolved({
    idempotencyKey: question.idempotencyKey,
    resolvedAt: 1_700_200_002_000,
  })
  assert.equal(questionResolved.status, "resolved")

  const permission = await notificationStore.upsertNotification({
    idempotencyKey: "notif-p-1",
    kind: "permission",
    wechatAccountId: "wx-1",
    userId: "u-1",
    routeKey: "permission-route-1",
    handle: "p1",
    createdAt: 1_700_200_010_000,
  })
  const permissionFailed = await notificationStore.markNotificationFailed({
    idempotencyKey: permission.idempotencyKey,
    failedAt: 1_700_200_012_000,
    reason: "deliver-timeout",
  })
  assert.equal(permissionFailed.status, "failed")

  const sessionError = await notificationStore.upsertNotification({
    idempotencyKey: "notif-s-1",
    kind: "sessionError",
    wechatAccountId: "wx-2",
    userId: "u-2",
    createdAt: 1_700_200_020_000,
  })
  assert.equal(sessionError.status, "pending")
  assert.equal(sessionError.routeKey, undefined)
  assert.equal(sessionError.handle, undefined)

  await notificationStore.markNotificationSent({
    idempotencyKey: sessionError.idempotencyKey,
    sentAt: 1_700_200_021_000,
  })
  const suppressed = await notificationStore.markNotificationResolved({
    idempotencyKey: sessionError.idempotencyKey,
    resolvedAt: 1_700_200_022_000,
    suppressed: true,
  })
  assert.equal(suppressed.status, "suppressed")
})

test("requestTerminal 支持持久化终结字段与常规状态流转", async () => {
  const terminal = await notificationStore.upsertNotification({
    idempotencyKey: "notif-request-terminal-1",
    kind: "requestTerminal",
    requestKind: "question",
    terminalReason: "replaced",
    replacementHandle: "q13",
    wechatAccountId: "wx-terminal",
    userId: "u-terminal",
    routeKey: "question-terminal-route-1",
    handle: "q12",
    createdAt: 1_700_200_030_000,
  })

  assert.equal(terminal.status, "pending")
  assert.equal(terminal.requestKind, "question")
  assert.equal(terminal.terminalReason, "replaced")
  assert.equal(terminal.replacementHandle, "q13")

  const sent = await notificationStore.markNotificationSent({
    idempotencyKey: terminal.idempotencyKey,
    sentAt: 1_700_200_031_000,
  })
  assert.equal(sent.status, "sent")

  const resolved = await notificationStore.markNotificationResolved({
    idempotencyKey: terminal.idempotencyKey,
    resolvedAt: 1_700_200_032_000,
  })
  assert.equal(resolved.status, "resolved")
})

test("相同 idempotencyKey 的 upsert 不重复造记录", async () => {
  const first = await notificationStore.upsertNotification({
    idempotencyKey: "notif-dedupe-1",
    kind: "question",
    wechatAccountId: "wx-dedupe",
    userId: "u-dedupe",
    routeKey: "question-dedupe-route-1",
    handle: "q9",
    createdAt: 1_700_210_000_000,
  })

  const second = await notificationStore.upsertNotification({
    idempotencyKey: "notif-dedupe-1",
    kind: "question",
    wechatAccountId: "wx-dedupe",
    userId: "u-dedupe",
    routeKey: "question-dedupe-route-1",
    handle: "q9",
    createdAt: 1_700_210_100_000,
  })

  assert.deepEqual(second, first)

  const files = await readdir(statePaths.notificationsDir())
  assert.equal(files.filter((name) => name === "notif-dedupe-1.json").length, 1)
})

test("listPendingNotifications() 仅返回 pending 项", async () => {
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-pending-1",
    kind: "sessionError",
    wechatAccountId: "wx-list",
    userId: "u-list",
    createdAt: 1_700_220_000_000,
  })

  const sentOnly = await notificationStore.upsertNotification({
    idempotencyKey: "notif-sent-1",
    kind: "permission",
    wechatAccountId: "wx-list",
    userId: "u-list",
    routeKey: "permission-list-route-1",
    handle: "p2",
    createdAt: 1_700_220_010_000,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sentOnly.idempotencyKey,
    sentAt: 1_700_220_011_000,
  })

  const pendingList = await notificationStore.listPendingNotifications()
  assert.equal(pendingList.some((item) => item.idempotencyKey === pending.idempotencyKey), true)
  assert.equal(pendingList.some((item) => item.idempotencyKey === sentOnly.idempotencyKey), false)
})

test("终态记录保留，且 purgeTerminalNotificationsBefore() 可清理", async () => {
  const oldResolved = await notificationStore.upsertNotification({
    idempotencyKey: "notif-terminal-old",
    kind: "question",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    routeKey: "question-purge-route-old",
    handle: "q5",
    createdAt: 1_700_230_000_000,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: oldResolved.idempotencyKey,
    sentAt: 1_700_230_001_000,
  })
  await notificationStore.markNotificationResolved({
    idempotencyKey: oldResolved.idempotencyKey,
    resolvedAt: 1_700_230_002_000,
  })

  const freshFailed = await notificationStore.upsertNotification({
    idempotencyKey: "notif-terminal-fresh",
    kind: "permission",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    routeKey: "permission-purge-route-fresh",
    handle: "p5",
    createdAt: 1_700_230_010_000,
  })
  await notificationStore.markNotificationFailed({
    idempotencyKey: freshFailed.idempotencyKey,
    failedAt: 1_700_230_012_000,
    reason: "network",
  })

  const oldFailed = await notificationStore.upsertNotification({
    idempotencyKey: "notif-terminal-failed-old",
    kind: "permission",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    routeKey: "permission-purge-route-old-failed",
    handle: "p6",
    createdAt: 1_700_230_000_050,
  })
  await notificationStore.markNotificationFailed({
    idempotencyKey: oldFailed.idempotencyKey,
    failedAt: 1_700_230_000_070,
    reason: "old-network",
  })

  const oldSuppressed = await notificationStore.upsertNotification({
    idempotencyKey: "notif-terminal-suppressed-old",
    kind: "sessionError",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: 1_700_230_000_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: oldSuppressed.idempotencyKey,
    sentAt: 1_700_230_000_200,
  })
  await notificationStore.markNotificationResolved({
    idempotencyKey: oldSuppressed.idempotencyKey,
    resolvedAt: 1_700_230_000_300,
    suppressed: true,
  })

  const freshSuppressed = await notificationStore.upsertNotification({
    idempotencyKey: "notif-terminal-suppressed-fresh",
    kind: "sessionError",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: 1_700_230_010_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: freshSuppressed.idempotencyKey,
    sentAt: 1_700_230_010_200,
  })
  await notificationStore.markNotificationResolved({
    idempotencyKey: freshSuppressed.idempotencyKey,
    resolvedAt: 1_700_230_010_700,
    suppressed: true,
  })

  const beforePurge = await readdir(statePaths.notificationsDir())
  assert.equal(beforePurge.includes("notif-terminal-old.json"), true)
  assert.equal(beforePurge.includes("notif-terminal-fresh.json"), true)
  assert.equal(beforePurge.includes("notif-terminal-failed-old.json"), true)
  assert.equal(beforePurge.includes("notif-terminal-suppressed-old.json"), true)
  assert.equal(beforePurge.includes("notif-terminal-suppressed-fresh.json"), true)

  const purged = await notificationStore.purgeTerminalNotificationsBefore({
    cutoffAt: 1_700_230_010_500,
  })
  assert.equal(purged, 3)

  const afterPurge = await readdir(statePaths.notificationsDir())
  assert.equal(afterPurge.includes("notif-terminal-old.json"), false)
  assert.equal(afterPurge.includes("notif-terminal-fresh.json"), true)
  assert.equal(afterPurge.includes("notif-terminal-failed-old.json"), false)
  assert.equal(afterPurge.includes("notif-terminal-suppressed-old.json"), false)
  assert.equal(afterPurge.includes("notif-terminal-suppressed-fresh.json"), true)
})

test("markNotification* 拒绝非法 idempotencyKey，避免路径穿越", async () => {
  await assert.rejects(
    () =>
      notificationStore.markNotificationSent({
        idempotencyKey: "../escape",
        sentAt: 1_700_240_000_000,
      }),
    /invalid notification record format/i,
  )

  await assert.rejects(
    () =>
      notificationStore.markNotificationResolved({
        idempotencyKey: "../escape",
        resolvedAt: 1_700_240_001_000,
      }),
    /invalid notification record format/i,
  )

  await assert.rejects(
    () =>
      notificationStore.markNotificationFailed({
        idempotencyKey: "../escape",
        failedAt: 1_700_240_002_000,
        reason: "any",
      }),
    /invalid notification record format/i,
  )
})

test("question / permission upsert 必须提供 routeKey 与 handle", async () => {
  await assert.rejects(
    () =>
      notificationStore.upsertNotification({
        idempotencyKey: "notif-missing-route",
        kind: "question",
        wechatAccountId: "wx-a",
        userId: "u-a",
        handle: "q1",
        createdAt: 1_700_250_000_000,
      }),
    /invalid notification record format/i,
  )

  await assert.rejects(
    () =>
      notificationStore.upsertNotification({
        idempotencyKey: "notif-missing-handle",
        kind: "permission",
        wechatAccountId: "wx-a",
        userId: "u-a",
        routeKey: "permission-route-a",
        createdAt: 1_700_250_001_000,
    }),
    /invalid notification record format/i,
  )

  await assert.rejects(
    () =>
      notificationStore.upsertNotification({
        idempotencyKey: "notif-terminal-missing-reason",
        kind: "requestTerminal",
        requestKind: "question",
        wechatAccountId: "wx-a",
        userId: "u-a",
        routeKey: "question-route-terminal-a",
        handle: "q12",
        createdAt: 1_700_250_001_100,
      }),
    /invalid notification record format/i,
  )
})

test("反序列化要求 status 与时间戳/失败原因一致", async () => {
  await mkdir(statePaths.notificationsDir(), { recursive: true })

  const fixtures = [
    {
      idempotencyKey: "notif-bad-sent",
      status: "sent",
      extra: {},
    },
    {
      idempotencyKey: "notif-bad-resolved",
      status: "resolved",
      extra: {},
    },
    {
      idempotencyKey: "notif-bad-failed",
      status: "failed",
      extra: { failedAt: 1_700_260_000_100 },
    },
    {
      idempotencyKey: "notif-bad-suppressed",
      status: "suppressed",
      extra: {},
    },
  ]

  for (const item of fixtures) {
    await writeFile(
      statePaths.notificationStatePath(item.idempotencyKey),
      JSON.stringify({
        idempotencyKey: item.idempotencyKey,
        kind: "sessionError",
        wechatAccountId: "wx-bad",
        userId: "u-bad",
        createdAt: 1_700_260_000_000,
        status: item.status,
        ...item.extra,
      }),
    )
  }

  await assert.rejects(
    () => notificationStore.purgeTerminalNotificationsBefore({ cutoffAt: 1_700_260_010_000 }),
    /invalid notification record format/i,
  )
})

test("markNotificationFailed 仅允许 pending -> failed，sent 不可回写失败", async () => {
  const record = await notificationStore.upsertNotification({
    idempotencyKey: "notif-failed-only-from-pending",
    kind: "question",
    wechatAccountId: "wx-failed-guard",
    userId: "u-failed-guard",
    routeKey: "question-failed-guard-route",
    handle: "q7",
    createdAt: 1_700_270_000_000,
  })

  await notificationStore.markNotificationSent({
    idempotencyKey: record.idempotencyKey,
    sentAt: 1_700_270_000_100,
  })

  await assert.rejects(
    () =>
      notificationStore.markNotificationFailed({
        idempotencyKey: record.idempotencyKey,
        failedAt: 1_700_270_000_200,
        reason: "should-not-downgrade-sent",
      }),
    /notification is not pending/i,
  )
})

test("markNotificationResolved 在 suppressed=true 时允许 pending -> suppressed", async () => {
  const record = await notificationStore.upsertNotification({
    idempotencyKey: "notif-suppress-from-pending",
    kind: "question",
    wechatAccountId: "wx-suppress",
    userId: "u-suppress",
    routeKey: "route-suppress-from-pending",
    handle: "q3",
    createdAt: 1_700_280_000_000,
  })

  const suppressed = await notificationStore.markNotificationResolved({
    idempotencyKey: record.idempotencyKey,
    resolvedAt: 1_700_280_000_100,
    suppressed: true,
  })

  assert.equal(suppressed.status, "suppressed")
  assert.equal(suppressed.suppressedAt, 1_700_280_000_100)
})

test("markNotificationResolved 在 suppressed=false 时仍要求 sent 状态", async () => {
  const record = await notificationStore.upsertNotification({
    idempotencyKey: "notif-resolve-requires-sent",
    kind: "permission",
    wechatAccountId: "wx-resolve",
    userId: "u-resolve",
    routeKey: "route-resolve-requires-sent",
    handle: "p3",
    createdAt: 1_700_280_001_000,
  })

  await assert.rejects(
    () =>
      notificationStore.markNotificationResolved({
        idempotencyKey: record.idempotencyKey,
        resolvedAt: 1_700_280_001_100,
      }),
    /notification is not sent/i,
  )
})
