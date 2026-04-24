import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-token-store-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const tokenStore = await import("../dist/wechat/token-store.js")
const statePaths = await import("../dist/wechat/state-paths.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("最近一次入站 token 覆盖旧记录", async () => {
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-a",
    userId: "user-1",
    contextToken: "token-old",
    updatedAt: 1_700_000_100_000,
    source: "question",
    sourceRef: "q-1",
  })

  const latest = await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-a",
    userId: "user-1",
    contextToken: "token-new",
    updatedAt: 1_700_000_200_000,
    source: "permission",
    sourceRef: "p-2",
  })

  assert.equal(latest.contextToken, "token-new")
  assert.equal(latest.source, "permission")
  assert.equal(latest.sourceRef, "p-2")

  const stored = await tokenStore.readTokenState("wx-a", "user-1")
  assert.equal(stored?.contextToken, "token-new")
})

test("staleReason 只打标，不删除文件", async () => {
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-b",
    userId: "user-2",
    contextToken: "token-live",
    updatedAt: 1_700_000_300_000,
    source: "question",
  })

  const stale = await tokenStore.markTokenStale({
    wechatAccountId: "wx-b",
    userId: "user-2",
    staleReason: "operator-reset",
  })

  assert.equal(stale.staleReason, "operator-reset")
  const fromDisk = await tokenStore.readTokenState("wx-b", "user-2")
  assert.equal(fromDisk?.staleReason, "operator-reset")
})

test("live token 不再反向重激活 failed notification", async () => {
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-token-no-reactivate-failed-notification`)

  await notificationStore.upsertNotification({
    idempotencyKey: "token-reactivation-should-not-happen",
    kind: "question",
    routeKey: "route-token-reactivation-should-not-happen",
    handle: "qtoken1",
    wechatAccountId: "wx-token-reactivation",
    userId: "u-token-reactivation",
    createdAt: 1_700_000_310_000,
  })
  await notificationStore.markNotificationFailed({
    idempotencyKey: "token-reactivation-should-not-happen",
    failedAt: 1_700_000_310_100,
    reason: "wechat send failed",
  })
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-token-reactivation",
    userId: "u-token-reactivation",
    contextToken: "token-still-live",
    updatedAt: 1_700_000_310_200,
    source: "question",
    sourceRef: "qtoken1",
  })

  const current = await notificationStore.upsertNotification({
    idempotencyKey: "token-reactivation-should-not-happen",
    kind: "question",
    routeKey: "route-token-reactivation-should-not-happen",
    handle: "qtoken1",
    wechatAccountId: "wx-token-reactivation",
    userId: "u-token-reactivation",
    createdAt: 1_700_000_310_300,
  })

  assert.equal(current.status, "failed")
  const fromDisk = JSON.parse(await readFile(statePaths.notificationStatePath("token-reactivation-should-not-happen"), "utf8"))
  assert.equal(fromDisk.status, "failed")
  assert.equal(fromDisk.failureReason, "wechat send failed")
})

test("readTokenState() 优先 broker-state-store authoritative deliveryTokens，而不是旧 token 文件", async () => {
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-token-authoritative-read-store`)
  const filePath = statePaths.tokenStatePath("wx-authoritative-read", "u-authoritative-read")
  await mkdir(path.dirname(filePath), { recursive: true })

  await writeFile(
    filePath,
    JSON.stringify({
      contextToken: "legacy-stale-token",
      updatedAt: 1_700_000_311_000,
      source: "message",
      sourceRef: "/status",
      staleReason: "notification-delivery-failed",
    }),
  )

  const state = brokerStateStore.createEmptyBrokerState()
  state.deliveryTokens = {
    "wx-authoritative-read:u-authoritative-read": {
      wechatAccountId: "wx-authoritative-read",
      userId: "u-authoritative-read",
      contextToken: "authoritative-live-token",
      updatedAt: 1_700_000_311_100,
      source: "message",
      sourceRef: "/status",
    },
  }
  await brokerStateStore.persistBrokerStateStoreSnapshot(state)

  const read = await tokenStore.readTokenState("wx-authoritative-read", "u-authoritative-read")
  assert.equal(read?.contextToken, "authoritative-live-token")
  assert.equal(read?.staleReason, undefined)
})

test("readTokenState() 在缺少 authoritative deliveryToken 时不会回退读取旧 live token 文件", async () => {
  const filePath = statePaths.tokenStatePath("wx-legacy-token-only", "u-legacy-token-only")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify({
      contextToken: "legacy-live-token",
      updatedAt: 1_700_000_311_200,
      source: "message",
      sourceRef: "/status",
    }),
  )

  const read = await tokenStore.readTokenState("wx-legacy-token-only", "u-legacy-token-only")
  assert.equal(read, undefined)
})

test("不存在固定 TTL 自动失效", async () => {
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-c",
    userId: "user-3",
    contextToken: "token-very-old",
    updatedAt: 946_684_800_000,
    source: "question",
  })

  const stored = await tokenStore.readTokenState("wx-c", "user-3")
  assert.equal(stored?.contextToken, "token-very-old")
  assert.equal(stored?.updatedAt, 946_684_800_000)
})

test("tokens/<wechatAccountId>/<userId>.json 字段固定", async () => {
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-d",
    userId: "user-4",
    contextToken: "token-only-fields",
    updatedAt: 1_700_000_400_000,
    source: "permission",
    sourceRef: "perm-4",
  })
  await tokenStore.markTokenStale({
    wechatAccountId: "wx-d",
    userId: "user-4",
    staleReason: "request-expired",
  })

  const raw = await readFile(statePaths.tokenStatePath("wx-d", "user-4"), "utf8")
  const parsed = JSON.parse(raw)

  assert.deepEqual(Object.keys(parsed).sort(), [
    "contextToken",
    "source",
    "sourceRef",
    "staleReason",
    "updatedAt",
  ])
  assert.equal(parsed.contextToken, "token-only-fields")
  assert.equal(parsed.source, "permission")
  assert.equal(parsed.sourceRef, "perm-4")
  assert.equal(parsed.staleReason, "request-expired")
})

test("损坏或缺字段 token JSON 会抛明确格式错误", async () => {
  const brokenPath = statePaths.tokenStatePath("wx-broken", "u-broken")
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{bad-json")

  await assert.rejects(
    () => tokenStore.readTokenState("wx-broken", "u-broken"),
    /invalid token state format/i,
  )

  const missingFieldPath = statePaths.tokenStatePath("wx-missing", "u-missing")
  await mkdir(path.dirname(missingFieldPath), { recursive: true })
  await writeFile(
    missingFieldPath,
    JSON.stringify({
      contextToken: "token",
      source: "question",
    }),
  )

  await assert.rejects(
    () => tokenStore.readTokenState("wx-missing", "u-missing"),
    /invalid token state format/i,
  )
})

test("upsertInboundToken() 拒绝非法 source", async () => {
  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "wx-invalid-source",
        userId: "u-invalid-source",
        contextToken: "token",
        updatedAt: 1_700_080_000_000,
        source: "bad-source",
      }),
    /invalid token state format/i,
  )
})

test("upsertInboundToken() 拒绝 updatedAt: NaN 或非法 contextToken", async () => {
  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "wx-invalid-updated-at",
        userId: "u-invalid-updated-at",
        contextToken: "token",
        updatedAt: Number.NaN,
        source: "question",
      }),
    /invalid token state format/i,
  )

  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "wx-invalid-token",
        userId: "u-invalid-token",
        contextToken: "",
        updatedAt: 1_700_080_100_000,
        source: "permission",
      }),
    /invalid token state format/i,
  )
})

test("upsertInboundToken() 失败路径不会写出脏 token 文件", async () => {
  const filePath = statePaths.tokenStatePath("wx-no-dirty", "u-no-dirty")

  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "wx-no-dirty",
        userId: "u-no-dirty",
        contextToken: "",
        updatedAt: 1_700_080_200_000,
        source: "question",
      }),
    /invalid token state format/i,
  )

  await assert.rejects(
    () => readFile(filePath, "utf8"),
    (error) => error?.code === "ENOENT",
  )
})

test("非法 wechatAccountId 不会写出越界 token 文件", async () => {
  const escapedPath = statePaths.tokenStatePath("../wx-escape", "u-safe")

  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "../wx-escape",
        userId: "u-safe",
        contextToken: "token",
        updatedAt: 1_700_080_300_000,
        source: "question",
      }),
    /invalid token state format/i,
  )

  await assert.rejects(
    () => readFile(escapedPath, "utf8"),
    (error) => error?.code === "ENOENT",
  )
})

test("非法 userId 不会写出越界 token 文件", async () => {
  const escapedPath = statePaths.tokenStatePath("wx-safe", "../u-escape")

  await assert.rejects(
    () =>
      tokenStore.upsertInboundToken({
        wechatAccountId: "wx-safe",
        userId: "../u-escape",
        contextToken: "token",
        updatedAt: 1_700_080_400_000,
        source: "permission",
      }),
    /invalid token state format/i,
  )

  await assert.rejects(
    () => readFile(escapedPath, "utf8"),
    (error) => error?.code === "ENOENT",
  )
})

test("markTokenStale() 拒绝空 staleReason 且不改写原文件", async () => {
  await tokenStore.upsertInboundToken({
    wechatAccountId: "wx-stale-empty",
    userId: "u-stale-empty",
    contextToken: "token-stale",
    updatedAt: 1_700_090_100_000,
    source: "question",
  })

  const before = await readFile(statePaths.tokenStatePath("wx-stale-empty", "u-stale-empty"), "utf8")

  await assert.rejects(
    () =>
      tokenStore.markTokenStale({
        wechatAccountId: "wx-stale-empty",
        userId: "u-stale-empty",
        staleReason: "",
      }),
    /invalid token state format/i,
  )

  const after = await readFile(statePaths.tokenStatePath("wx-stale-empty", "u-stale-empty"), "utf8")
  assert.equal(after, before)
})

test("markTokenStale() 在缺失 token 文件时仍会写出 stale state", async () => {
  const stale = await tokenStore.markTokenStale({
    wechatAccountId: "wx-stale-missing",
    userId: "u-stale-missing",
    staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
  })

  assert.equal(stale.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
  assert.equal(typeof stale.contextToken, "string")
  assert.equal(stale.contextToken.length > 0, true)

  const fromDisk = await tokenStore.readTokenState("wx-stale-missing", "u-stale-missing")
  assert.equal(fromDisk?.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
})

test("markTokenStale() 在损坏 token 文件时仍会覆盖写出 stale state", async () => {
  const brokenPath = statePaths.tokenStatePath("wx-stale-corrupt", "u-stale-corrupt")
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{bad-json")

  const stale = await tokenStore.markTokenStale({
    wechatAccountId: "wx-stale-corrupt",
    userId: "u-stale-corrupt",
    staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
  })

  assert.equal(stale.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
  assert.equal(typeof stale.contextToken, "string")
  assert.equal(stale.contextToken.length > 0, true)

  const fromDisk = await tokenStore.readTokenState("wx-stale-corrupt", "u-stale-corrupt")
  assert.equal(fromDisk?.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
})
