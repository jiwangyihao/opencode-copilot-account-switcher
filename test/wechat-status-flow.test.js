import test, { after } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const DIST_BROKER_SERVER_MODULE = "../dist/wechat/broker-server.js"
const DIST_BROKER_CLIENT_MODULE = "../dist/wechat/broker-client.js"
const DIST_BRIDGE_MODULE = "../dist/wechat/bridge.js"
const DIST_BROKER_MUTATION_QUEUE_MODULE = "../dist/wechat/broker-mutation-queue.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-status-flow-config-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

function createBrokerEndpoint(tempDir) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\wechat-broker-status-${process.pid}-${suffix}`
  }
  return path.join(tempDir, `wechat-broker-status-${suffix}.sock`)
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error("waitFor timeout")
}

async function waitForAsync(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error("waitForAsync timeout")
}

async function readJsonLines(filePath) {
  try {
    const raw = await readFile(filePath, "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

function toIdempotencyPart(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return normalized.length > 0 ? normalized : "na"
}

function createFallbackQuestion(requestID) {
  return [
    {
      id: requestID,
      questions: [
        {
          header: "Fallback Question",
          question: "Need fallback delivery",
        },
      ],
    },
  ]
}

async function createBridgeLifecycleForFallbackTest({
  bridgeModule,
  brokerClient,
  endpoint,
  directory,
  onFallbackToast,
  questionList,
}) {
  let bridgeInstanceID = ""
  let registerAck = null
  const bridgeLifecycle = await bridgeModule.createWechatBridgeLifecycle(
    {
      statusCollectionEnabled: true,
      heartbeatIntervalMs: 60_000,
      directory,
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: {
          list: questionList,
        },
        permission: {
          list: async () => [],
        },
      },
      onFallbackToast,
    },
    {
      connectOrSpawnBrokerImpl: async () => ({ endpoint }),
      connectImpl: async (brokerEndpoint, options) => {
        const client = await brokerClient.connect(brokerEndpoint, options)
        return {
          ...client,
          registerInstance: async (meta) => {
            bridgeInstanceID = meta.instanceID
            registerAck = await client.registerInstance(meta)
            return registerAck
          },
        }
      },
    },
  )

  assert.equal(bridgeInstanceID.length > 0, true)
  return {
    bridgeLifecycle,
    bridgeInstanceID,
    registerAck,
  }
}

function createFailingNotificationRuntimeLifecycle({ brokerEntry, brokerServerHandle, errorMessage = "mock delivery failed" }) {
  let sendAttempts = 0
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    handleNotificationDeliveryFailure: brokerServerHandle.handleNotificationDeliveryFailure,
    createStatusRuntime: ({ drainOutboundMessages }) => ({
      start: async () => {
        await drainOutboundMessages({
          sendMessage: async () => {
            sendAttempts += 1
            throw new Error(errorMessage)
          },
        })
      },
      close: async () => {},
    }),
  })

  return {
    lifecycle,
    getSendAttempts: () => sendAttempts,
  }
}

async function markOpenQuestionAnsweredIfPresent(requestStore, requestID) {
  const openRequest = await requestStore.listActiveRequests()
    .then((records) => records.find((record) => record.kind === "question" && record.requestID === requestID))
    .catch(() => undefined)
  if (!openRequest) {
    return
  }
  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: openRequest.routeKey,
    answeredAt: Date.now(),
  }).catch(() => {})
}

test("collectStatus/statusSnapshot 往返：broker 广播，bridge 回包，broker 仅聚合 snapshot", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-roundtrip-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const snapshots = []
  const receivedRequestIds = []
  const server = await brokerServer.startBrokerServer(endpoint)
  let bridge = null

  try {
    bridge = await brokerClient.connect(endpoint, {
      onCollectStatus: async ({ requestId }) => {
        receivedRequestIds.push(requestId)
        return {
          instanceID: "status-instance-a",
          digest: {
            source: "bridge",
            value: "digest-from-bridge",
          },
        }
      },
    })

    await bridge.registerInstance({
      instanceID: "status-instance-a",
      pid: process.pid,
    })

    const result = await server.collectStatus()
    snapshots.push(...result.instances)

    assert.equal(receivedRequestIds.length, 1)
    assert.equal(typeof receivedRequestIds[0], "string")
    assert.equal(receivedRequestIds[0].length > 0, true)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].instanceID, "status-instance-a")
    assert.equal(snapshots[0].status, "ok")
    assert.deepEqual(snapshots[0].snapshot, {
      instanceID: "status-instance-a",
      digest: {
        source: "bridge",
        value: "digest-from-bridge",
      },
    })

  } finally {
    if (bridge) {
      await bridge.close().catch(() => {})
    }
    await server.close()
  }
})

test("collectStatus 可通过环境变量收紧聚合窗口，未回包实例标记 timeout/unreachable", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-timeout-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({ healthy: true }),
    })
    await responsive.registerInstance({ instanceID: "status-responsive", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "status-unresponsive", pid: process.pid })

    const startedAt = Date.now()
    const result = await server.collectStatus()
    const elapsedMs = Date.now() - startedAt

    assert.equal(brokerServer.DEFAULT_STATUS_COLLECT_WINDOW_MS, 5000)
    assert.equal(elapsedMs >= 1400, true)

    const responsiveItem = result.instances.find((item) => item.instanceID === "status-responsive")
    const unresponsiveItem = result.instances.find((item) => item.instanceID === "status-unresponsive")

    assert.equal(responsiveItem.status, "ok")
    assert.deepEqual(responsiveItem.snapshot, { healthy: true })
    assert.equal(unresponsiveItem.status, "timeout/unreachable")
    assert.equal("snapshot" in unresponsiveItem, false)

  } finally {
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("collectStatus 不应把 1.6s 内返回的 snapshot 误判为 timeout", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-slow-success-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let slow = null

  try {
    slow = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600))
        return { healthy: true }
      },
    })
    await slow.registerInstance({ instanceID: "status-slow-success", pid: process.pid })

    const result = await server.collectStatus()
    const item = result.instances.find((entry) => entry.instanceID === "status-slow-success")

    assert.equal(item?.status, "ok")
    assert.deepEqual(item?.snapshot, { healthy: true })

  } finally {
    if (slow) {
      await slow.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker-client.send 仅消费匹配 requestId 的响应，忽略串包帧", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-mismatch-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = net.createServer((socket) => {
    let buffer = ""
    const onData = (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      socket.off("data", onData)
      const line = buffer.slice(0, newlineIndex)
      const request = JSON.parse(line)
      const expectedResponseId = `pong-${request.id}`
      socket.write('{"id":"pong-not-the-request","type":"pong","payload":{"message":"wrong"}}\n')
      socket.write(
        `${JSON.stringify({ id: expectedResponseId, type: "pong", payload: { message: "pong" } })}\n`,
      )
    }

    socket.on("data", onData)
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  let client = null
  try {
    client = await brokerClient.connect(endpoint)
    const pong = await client.ping()
    assert.equal(pong.id.startsWith("pong-ping-"), true)
    assert.equal(pong.payload.message, "pong")
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("broker-server.close 会主动断开客户端连接，避免 close 卡住", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-close-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let client = null
  try {
    client = await brokerClient.connect(endpoint)
    await client.registerInstance({ instanceID: "status-close-a", pid: process.pid })

    const closePromise = server.close()
    await assert.doesNotReject(() =>
      Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("broker close timeout")), 3000)),
      ]),
    )
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
  }
})

test("broker 通知发送失败会标记 token stale 并发送 showFallbackToast", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}`)
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}`)
  const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-fallback-toast-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const wechatAccountId = `wx-fallback-${Date.now()}`
  const userId = `u-fallback-${Math.random().toString(16).slice(2)}`
  const requestID = `req-fallback-${Math.random().toString(16).slice(2)}`

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: wechatAccountId, userId },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
  await operatorStore.rebindOperator({
    wechatAccountId,
    userId,
    boundAt: Date.now(),
  })

  const server = await brokerServer.startBrokerServer(endpoint)
  let bridgeLifecycle = null
  let lifecycle = null
  const toastCalls = []
  let questionListCalls = 0

  try {
    const bridge = await createBridgeLifecycleForFallbackTest({
      bridgeModule,
      brokerClient,
      endpoint,
      directory: "/workspace/wechat-fallback-toast",
      onFallbackToast: async (payload) => {
        toastCalls.push(payload)
      },
      questionList: async () => {
        questionListCalls += 1
        return questionListCalls > 1 ? [] : createFallbackQuestion(requestID)
      },
    })
    bridgeLifecycle = bridge.bridgeLifecycle
    const expectedNotificationKey = `question-${toIdempotencyPart(bridge.bridgeInstanceID)}-${toIdempotencyPart(requestID)}`

    await waitForAsync(async () => {
      const pending = await notificationStore.listPendingNotifications()
      return pending.some((record) => record.idempotencyKey === expectedNotificationKey)
    })

    const failingRuntime = createFailingNotificationRuntimeLifecycle({
      brokerEntry,
      brokerServerHandle: server,
    })
    lifecycle = failingRuntime.lifecycle
    await lifecycle.start()

    await waitForAsync(async () => {
      try {
        const record = JSON.parse(await readFile(statePaths.notificationStatePath(expectedNotificationKey), "utf8"))
        return record.status === "failed"
      } catch {
        return false
      }
    })
    const failedRecord = JSON.parse(await readFile(statePaths.notificationStatePath(expectedNotificationKey), "utf8"))
    assert.equal(failingRuntime.getSendAttempts(), 1)
    assert.equal(failedRecord.status, "failed")
    assert.match(String(failedRecord.failureReason), /mock delivery failed/i)

    await waitFor(() => toastCalls.length === 1)

    const toast = toastCalls[0]
    assert.equal(toast?.wechatAccountId, wechatAccountId)
    assert.equal(toast?.userId, userId)
    assert.equal(toast?.reason, "deliveryFailed")
    assert.equal(typeof toast?.registrationEpoch, "string")
    assert.equal((toast?.registrationEpoch ?? "").length > 0, true)
    assert.equal(toast?.message, "微信会话可能已失效，请在微信发送 /status 重新激活")

    const tokenState = await tokenStore.readTokenState(wechatAccountId, userId)
    assert.equal(Boolean(tokenState), true)
    assert.equal(tokenState?.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
    assert.equal(typeof tokenState?.contextToken, "string")
    assert.equal((tokenState?.contextToken ?? "").length > 0, true)

    const diagnosticsRaw = await readFile(statePaths.wechatBrokerDiagnosticsPath(), "utf8")
    const diagnostics = diagnosticsRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const fallbackEvent = diagnostics.find(
      (event) =>
        event.instanceID === bridge.bridgeInstanceID
        &&
        event.type === "showFallbackToast"
        && event.code === "showFallbackToast"
        && event.reason === "deliveryFailed",
    )
    assert.equal(Boolean(fallbackEvent), true)
  } finally {
    await markOpenQuestionAnsweredIfPresent(requestStore, requestID)
    await lifecycle?.close?.().catch(() => {})
    await bridgeLifecycle?.close?.().catch(() => {})
    await server.close()
  }
})

test("fallbackToastMutation 在 registrationEpoch 不匹配时写入 fallbackToastDropped 且不误投递新连接", async () => {
  const brokerMutationQueue = await import(`${DIST_BROKER_MUTATION_QUEUE_MODULE}?reload=${Date.now()}`)

  const diagnostics = []
  const deliveredPayloads = []
  const blocker = {}
  blocker.promise = new Promise((resolve) => {
    blocker.resolve = resolve
  })

  let liveRegistration = {
    socket: {
      destroyed: false,
    },
    sessionToken: "session-old",
    registrationEpoch: "epoch-old",
  }

  const queue = brokerMutationQueue.createBrokerMutationQueue()
  const holdMutation = queue.enqueue("holdMutation", async () => {
    await blocker.promise
  })
  const fallbackMutation = queue.enqueue("fallbackToastMutation", async () => {
    await brokerMutationQueue.executeFallbackToastMutation(
      {
        type: "fallbackToastMutation",
        instanceID: "bridge-instance-reconnect",
        wechatAccountId: "wx-stale-reconnect",
        userId: "u-stale-reconnect",
        message: "微信会话可能已失效，请在微信发送 /status 重新激活",
        reason: "deliveryFailed",
        registrationEpoch: "epoch-old",
      },
      {
        markTokenStale: async () => undefined,
        appendDiagnostic: async (event) => {
          diagnostics.push(event)
        },
        getLiveRegistration: () => liveRegistration,
        deliverFallbackToast: async ({ payload }) => {
          deliveredPayloads.push(payload)
        },
      },
    )
  })

  liveRegistration = {
    socket: {
      destroyed: false,
    },
    sessionToken: "session-new",
    registrationEpoch: "epoch-new",
  }
  blocker.resolve()

  await holdMutation
  await fallbackMutation

  assert.deepEqual(deliveredPayloads, [])
  assert.equal(diagnostics.some((event) => event.type === "showFallbackToast"), false)
  assert.equal(
    diagnostics.some(
      (event) =>
        event.type === "fallbackToastDropped"
        && event.code === "fallbackToastDropped"
        && event.reason === "deliveryFailed"
        && event.registrationEpoch === "epoch-old"
        && event.liveRegistrationEpoch === "epoch-new",
    ),
    true,
  )
})

test("broker 通知发送失败在 bridge 重连后使用旧 registrationEpoch 并写入 fallbackToastDropped", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}`)
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-fallback-reconnect-integrated-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const wechatAccountId = `wx-stale-reconnect-${Date.now()}`
  const userId = `u-stale-reconnect-${Math.random().toString(16).slice(2)}`
  const requestID = `req-stale-reconnect-${Math.random().toString(16).slice(2)}`

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: wechatAccountId, userId },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
  await operatorStore.rebindOperator({
    wechatAccountId,
    userId,
    boundAt: Date.now(),
  })

  const server = await brokerServer.startBrokerServer(endpoint)
  let firstBridgeLifecycle = null
  let secondBridgeLifecycle = null
  let runtimeLifecycle = null
  const secondBridgeToastCalls = []

  try {
    const diagnosticsBefore = await readJsonLines(statePaths.wechatBrokerDiagnosticsPath())

    const firstBridge = await createBridgeLifecycleForFallbackTest({
      bridgeModule,
      brokerClient,
      endpoint,
      directory: "/workspace/wechat-fallback-reconnect-a",
      onFallbackToast: async () => {},
      questionList: async () => createFallbackQuestion(requestID),
    })
    firstBridgeLifecycle = firstBridge.bridgeLifecycle
    const expectedNotificationKey = `question-${toIdempotencyPart(firstBridge.bridgeInstanceID)}-${toIdempotencyPart(requestID)}`

    await waitForAsync(async () => {
      const pending = await notificationStore.listPendingNotifications()
      return pending.some((record) => record.idempotencyKey === expectedNotificationKey)
    })

    await firstBridgeLifecycle.close()
    firstBridgeLifecycle = null

    const secondBridge = await createBridgeLifecycleForFallbackTest({
      bridgeModule,
      brokerClient,
      endpoint,
      directory: "/workspace/wechat-fallback-reconnect-b",
      onFallbackToast: async (payload) => {
        secondBridgeToastCalls.push(payload)
      },
      questionList: async () => [],
    })
    secondBridgeLifecycle = secondBridge.bridgeLifecycle

    const failingRuntime = createFailingNotificationRuntimeLifecycle({
      brokerEntry,
      brokerServerHandle: server,
      errorMessage: "reconnect-send-failed",
    })
    runtimeLifecycle = failingRuntime.lifecycle
    await runtimeLifecycle.start()

    await waitForAsync(async () => {
      try {
        const record = JSON.parse(await readFile(statePaths.notificationStatePath(expectedNotificationKey), "utf8"))
        return record.status === "failed"
      } catch {
        return false
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(secondBridgeToastCalls.length, 0)

    const diagnosticsAfter = await readJsonLines(statePaths.wechatBrokerDiagnosticsPath())
    const droppedEvent = diagnosticsAfter
      .slice(diagnosticsBefore.length)
      .find(
        (event) =>
          event.instanceID === firstBridge.bridgeInstanceID
          && event.type === "fallbackToastDropped"
          && event.code === "fallbackToastDropped"
          && event.reason === "deliveryFailed",
      )

    assert.equal(Boolean(droppedEvent), true)
    assert.equal(droppedEvent?.registrationEpoch, firstBridge.registerAck?.registrationEpoch)
    assert.equal(droppedEvent?.liveRegistrationEpoch, secondBridge.registerAck?.registrationEpoch)
  } finally {
    await markOpenQuestionAnsweredIfPresent(requestStore, requestID)
    await runtimeLifecycle?.close?.().catch(() => {})
    await firstBridgeLifecycle?.close?.().catch(() => {})
    await secondBridgeLifecycle?.close?.().catch(() => {})
    await server.close()
  }
})

test("broker 同 socket registerInstance 重注册会刷新 sessionToken/registrationEpoch，并丢弃首轮失败 toast", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}`)
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-same-socket-reregister-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const instanceID = `same-socket-instance-${Math.random().toString(16).slice(2)}`
  const wechatAccountId = `wx-same-socket-${Date.now()}`
  const userId = `u-same-socket-${Math.random().toString(16).slice(2)}`
  const requestID = `req-same-socket-${Math.random().toString(16).slice(2)}`
  const expectedNotificationKey = `question-${toIdempotencyPart(instanceID)}-${toIdempotencyPart(requestID)}`

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: wechatAccountId, userId },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
  await operatorStore.rebindOperator({
    wechatAccountId,
    userId,
    boundAt: Date.now(),
  })

  const server = await brokerServer.startBrokerServer(endpoint)
  let runtimeLifecycle = null
  let client = null
  let notificationCollectionCalls = 0
  const toastCalls = []

  try {
    client = await brokerClient.connect(endpoint, {
      bridge: {
        collectStatusSnapshot: async () => ({ ok: true }),
        collectNotificationCandidates: async () => {
          notificationCollectionCalls += 1
          if (notificationCollectionCalls > 1) {
            return []
          }
          return [
            {
              idempotencyKey: expectedNotificationKey,
              kind: "question",
              requestID,
              createdAt: Date.now(),
              routeKey: `question-${requestID}`,
              handle: "q1",
            },
          ]
        },
        showFallbackToast: async (payload) => {
          toastCalls.push(payload)
        },
      },
    })

    const firstAck = await client.registerInstance({ instanceID, pid: process.pid })
    await waitForAsync(async () => {
      const pending = await notificationStore.listPendingNotifications()
      return pending.some((record) => record.idempotencyKey === expectedNotificationKey)
    })

    const secondAck = await client.registerInstance({ instanceID, pid: process.pid })
    assert.notEqual(firstAck.sessionToken, secondAck.sessionToken)
    assert.notEqual(firstAck.registrationEpoch, secondAck.registrationEpoch)

    const failingRuntime = createFailingNotificationRuntimeLifecycle({
      brokerEntry,
      brokerServerHandle: server,
      errorMessage: "same-socket-send-failed",
    })
    runtimeLifecycle = failingRuntime.lifecycle
    await runtimeLifecycle.start()

    await waitForAsync(async () => {
      try {
        const record = JSON.parse(await readFile(statePaths.notificationStatePath(expectedNotificationKey), "utf8"))
        return record.status === "failed"
      } catch {
        return false
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(toastCalls.length, 0)

    const diagnostics = await readJsonLines(statePaths.wechatBrokerDiagnosticsPath())
    const droppedEvent = diagnostics.find(
      (event) =>
        event.instanceID === instanceID
        && event.type === "fallbackToastDropped"
        && event.code === "fallbackToastDropped"
        && event.reason === "deliveryFailed"
        && event.registrationEpoch === firstAck.registrationEpoch
        && event.liveRegistrationEpoch === secondAck.registrationEpoch,
    )
    assert.equal(Boolean(droppedEvent), true)
  } finally {
    await markOpenQuestionAnsweredIfPresent(requestStore, requestID)
    await runtimeLifecycle?.close?.().catch(() => {})
    await client?.close().catch(() => {})
    await server.close()
  }
})

test("broker-client showFallbackToast 仅透传匹配当前 sessionToken 与 registrationEpoch 的 push", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-client-toast-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const toastCalls = []
  let registerCount = 0

  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const request = JSON.parse(line)
        if (request.type !== "registerInstance") {
          continue
        }

        registerCount += 1
        if (registerCount === 1) {
          socket.write(`${JSON.stringify({
            id: `registerAck-${request.id}`,
            type: "registerAck",
            instanceID: request.instanceID,
            payload: {
              sessionToken: "token-old",
              registeredAt: 1,
              registrationEpoch: "epoch-old",
              brokerPid: process.pid,
            },
          })}\n`)
          continue
        }

        socket.write(`${JSON.stringify({
          id: `registerAck-${request.id}`,
          type: "registerAck",
          instanceID: request.instanceID,
          payload: {
            sessionToken: "token-new",
            registeredAt: 1,
            registrationEpoch: "epoch-new",
            brokerPid: process.pid,
          },
        })}\n`)
        setTimeout(() => {
          socket.write(`${JSON.stringify({
            id: "showFallbackToast-stale",
            type: "showFallbackToast",
            instanceID: request.instanceID,
            sessionToken: "token-old",
            payload: {
              wechatAccountId: "wx-fallback",
              userId: "u-fallback",
              message: "微信会话可能已失效，请在微信发送 /status 重新激活",
              reason: "deliveryFailed",
              registrationEpoch: "epoch-old",
            },
          })}\n`)
          socket.write(`${JSON.stringify({
            id: "showFallbackToast-current",
            type: "showFallbackToast",
            instanceID: request.instanceID,
            sessionToken: "token-new",
            payload: {
              wechatAccountId: "wx-fallback",
              userId: "u-fallback",
              message: "微信会话可能已失效，请在微信发送 /status 重新激活",
              reason: "deliveryFailed",
              registrationEpoch: "epoch-new",
            },
          })}\n`)
        }, 0)
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  let client = null
  try {
    client = await brokerClient.connect(endpoint, {
      bridge: {
        collectStatusSnapshot: async () => ({}),
        collectNotificationCandidates: async () => [],
        showFallbackToast: async (payload) => {
          toastCalls.push(payload)
        },
      },
    })

    await client.registerInstance({ instanceID: "client-toast-instance", pid: process.pid })
    await client.registerInstance({ instanceID: "client-toast-instance", pid: process.pid })

    await waitFor(() => toastCalls.length === 1)
    assert.equal(toastCalls.length, 1)
    assert.equal(toastCalls[0]?.registrationEpoch, "epoch-new")
  } finally {
    await client?.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("broker-client 在同 chunk 收到 registerAck 与匹配的 showFallbackToast 时仍透传当前 toast", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-client-toast-same-chunk-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const toastCalls = []

  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const request = JSON.parse(line)
        if (request.type !== "registerInstance") {
          continue
        }

        socket.write([
          JSON.stringify({
            id: `registerAck-${request.id}`,
            type: "registerAck",
            instanceID: request.instanceID,
            payload: {
              sessionToken: "token-co-delivered",
              registeredAt: 1,
              registrationEpoch: "epoch-co-delivered",
              brokerPid: process.pid,
            },
          }),
          JSON.stringify({
            id: "showFallbackToast-co-delivered",
            type: "showFallbackToast",
            instanceID: request.instanceID,
            sessionToken: "token-co-delivered",
            payload: {
              wechatAccountId: "wx-fallback",
              userId: "u-fallback",
              message: "微信会话可能已失效，请在微信发送 /status 重新激活",
              reason: "deliveryFailed",
              registrationEpoch: "epoch-co-delivered",
            },
          }),
        ].join("\n") + "\n")
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  let client = null
  try {
    client = await brokerClient.connect(endpoint, {
      bridge: {
        collectStatusSnapshot: async () => ({}),
        collectNotificationCandidates: async () => [],
        showFallbackToast: async (payload) => {
          toastCalls.push(payload)
        },
      },
    })

    const ack = await client.registerInstance({ instanceID: "client-toast-same-chunk", pid: process.pid })

    await waitFor(() => toastCalls.length === 1)
    assert.equal(ack.sessionToken, "token-co-delivered")
    assert.equal(ack.registrationEpoch, "epoch-co-delivered")
    assert.equal(toastCalls.length, 1)
    assert.equal(toastCalls[0]?.registrationEpoch, "epoch-co-delivered")
  } finally {
    await client?.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("broker registerInstance 在同一毫秒重连时仍生成不同 registrationEpoch", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-registration-epoch-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)
  const originalDateNow = Date.now
  let firstClient = null
  let secondClient = null

  try {
    Date.now = () => 1_717_171_717_171
    firstClient = await brokerClient.connect(endpoint)
    const firstAck = await firstClient.registerInstance({ instanceID: "same-ms-registration", pid: process.pid })
    await firstClient.close()
    firstClient = null

    secondClient = await brokerClient.connect(endpoint)
    const secondAck = await secondClient.registerInstance({ instanceID: "same-ms-registration", pid: process.pid })

    assert.equal(firstAck.registeredAt, secondAck.registeredAt)
    assert.equal(typeof firstAck.registrationEpoch, "string")
    assert.equal(typeof secondAck.registrationEpoch, "string")
    assert.equal(firstAck.registrationEpoch.length > 0, true)
    assert.equal(secondAck.registrationEpoch.length > 0, true)
    assert.notEqual(firstAck.registrationEpoch, secondAck.registrationEpoch)
  } finally {
    Date.now = originalDateNow
    await firstClient?.close().catch(() => {})
    await secondClient?.close().catch(() => {})
    await server.close()
  }
})

test("broker 通知发送失败在 stale token 文件损坏时仍发送 showFallbackToast", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}`)
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}`)
  const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-fallback-corrupt-token-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const wechatAccountId = `wx-stale-corrupt-${Date.now()}`
  const userId = `u-stale-corrupt-${Math.random().toString(16).slice(2)}`
  const requestID = `req-stale-corrupt-${Math.random().toString(16).slice(2)}`

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: wechatAccountId, userId },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
  await operatorStore.rebindOperator({
    wechatAccountId,
    userId,
    boundAt: Date.now(),
  })
  await mkdir(path.dirname(statePaths.tokenStatePath(wechatAccountId, userId)), { recursive: true })
  await writeFile(statePaths.tokenStatePath(wechatAccountId, userId), "{not-json", "utf8")

  const server = await brokerServer.startBrokerServer(endpoint)
  let bridgeLifecycle = null
  let runtimeLifecycle = null
  const toastCalls = []
  let questionListCalls = 0

  try {
    const bridge = await createBridgeLifecycleForFallbackTest({
      bridgeModule,
      brokerClient,
      endpoint,
      directory: "/workspace/wechat-fallback-corrupt-token",
      onFallbackToast: async (payload) => {
        toastCalls.push(payload)
      },
      questionList: async () => {
        questionListCalls += 1
        return questionListCalls > 1 ? [] : createFallbackQuestion(requestID)
      },
    })
    bridgeLifecycle = bridge.bridgeLifecycle
    const expectedNotificationKey = `question-${toIdempotencyPart(bridge.bridgeInstanceID)}-${toIdempotencyPart(requestID)}`

    await waitForAsync(async () => {
      const pending = await notificationStore.listPendingNotifications()
      return pending.some((record) => record.idempotencyKey === expectedNotificationKey)
    })

    const failingRuntime = createFailingNotificationRuntimeLifecycle({
      brokerEntry,
      brokerServerHandle: server,
      errorMessage: "corrupt-token-send-failed",
    })
    runtimeLifecycle = failingRuntime.lifecycle
    await runtimeLifecycle.start()

    await waitFor(() => toastCalls.length === 1)
    assert.equal(toastCalls[0]?.wechatAccountId, wechatAccountId)
    assert.equal(toastCalls[0]?.userId, userId)
    assert.equal(toastCalls[0]?.reason, "deliveryFailed")
    assert.equal(toastCalls[0]?.message, "微信会话可能已失效，请在微信发送 /status 重新激活")

    const tokenState = await tokenStore.readTokenState(wechatAccountId, userId)
    assert.equal(Boolean(tokenState), true)
    assert.equal(tokenState?.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
    assert.equal(typeof tokenState?.contextToken, "string")
    assert.equal((tokenState?.contextToken ?? "").length > 0, true)
  } finally {
    await markOpenQuestionAnsweredIfPresent(requestStore, requestID)
    await runtimeLifecycle?.close?.().catch(() => {})
    await bridgeLifecycle?.close?.().catch(() => {})
    await server.close()
  }
})

test("fallback toast 文案固定提示用户在微信发送 /status 重新激活", async () => {
  const notificationFormat = await import(`../dist/wechat/notification-format.js?reload=${Date.now()}`)

  assert.equal(
    notificationFormat.WECHAT_FALLBACK_TOAST_MESSAGE,
    "微信会话可能已失效，请在微信发送 /status 重新激活",
  )
})

test("bridge live snapshot: 读取 session/status/question/permission/todo/messages 并只保留最近 3 个 session", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const calls = []

  const sessions = [
    { id: "s-older", title: "older", directory: "/repo", time: { updated: 10 } },
    { id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } },
    { id: "s-2", title: "s2", directory: "/repo", time: { updated: 300 } },
    { id: "s-3", title: "s3", directory: "/repo", time: { updated: 200 } },
  ]

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-a",
    instanceName: "Bridge A",
    projectName: "project-a",
    directory: "/repo",
    pid: 12345,
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return sessions
        },
        status: async () => {
          calls.push("session.status")
          return {
            "s-1": { type: "busy" },
            "s-2": { type: "idle" },
            "s-3": { type: "retry" },
            "s-older": { type: "busy" },
          }
        },
        todo: async (input) => {
          const sessionID = typeof input === "string" ? input : input.sessionID
          calls.push(`session.todo:${sessionID}`)
          return [{ id: `${sessionID}-todo-1`, status: "in_progress" }]
        },
        messages: async (input) => {
          const sessionID = typeof input === "string" ? input : input.sessionID
          calls.push(`session.messages:${sessionID}`)
          return [{ info: { id: `${sessionID}-m1` }, parts: [] }]
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return [
            { id: "q-1", sessionID: "s-2", text: "Q1" },
            { id: "q-2", sessionID: "s-older", text: "Q-older" },
          ]
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return [
            { id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" },
            { id: "p-2", sessionID: "s-3", tool: "edit", command: "write" },
          ]
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const sessionIDs = snapshot.sessions.map((item) => item.sessionID)

  assert.deepEqual(sessionIDs, ["s-2", "s-3", "s-1"])
  assert.equal(calls.includes("session.list"), true)
  assert.equal(calls.includes("session.status"), true)
  assert.equal(calls.includes("question.list"), true)
  assert.equal(calls.includes("permission.list"), true)
  assert.equal(calls.includes("session.todo:s-2"), true)
  assert.equal(calls.includes("session.todo:s-3"), true)
  assert.equal(calls.includes("session.todo:s-1"), true)
  assert.equal(calls.includes("session.todo:s-older"), false)
  assert.equal(calls.includes("session.messages:s-2"), true)
  assert.equal(calls.includes("session.messages:s-3"), true)
  assert.equal(calls.includes("session.messages:s-1"), true)
  assert.equal(calls.includes("session.messages:s-older"), false)
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-2")?.status, "idle")
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-1")?.pendingPermissionCount, 1)
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-2")?.pendingQuestionCount, 1)
})

test("bridge live snapshot: messages() 失败仅 session 级降级，permission.list() 失败仅实例级 unavailable", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-b",
    instanceName: "Bridge B",
    projectName: "project-b",
    directory: "/repo",
    pid: 12346,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => {
          throw new Error("messages unavailable")
        },
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => {
          throw new Error("permission unavailable")
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(Array.isArray(snapshot.unavailable), true)
  assert.equal(snapshot.unavailable.includes("permissionList"), true)
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(digest.sessionID, "s-1")
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 0)
  assert.equal(Array.isArray(digest.unavailable), true)
  assert.equal(digest.unavailable.includes("messages"), true)
})

test("bridge live snapshot: 兼容 SDK 默认的 fields-style 返回结构", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const todoArgs = []
  const messageArgs = []
  const wrap = (data) => ({
    data,
    error: null,
    request: new Request("http://localhost"),
    response: new Response("{}", { status: 200 }),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-fields-style",
    instanceName: "Bridge Fields Style",
    projectName: "project-fields-style",
    directory: "/repo",
    pid: 42346,
    client: {
      session: {
        list: async () => wrap([{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]),
        status: async () => wrap({ "s-1": { type: "busy" } }),
        todo: async (input) => {
          todoArgs.push(input)
          return wrap([{ id: "todo-1", status: "in_progress" }])
        },
        messages: async (input) => {
          messageArgs.push(input)
          return wrap([{ info: { id: "m-1" }, parts: [] }])
        },
      },
      question: {
        list: async () => wrap([{ id: "q-1", sessionID: "s-1", text: "Q1" }]),
      },
      permission: {
        list: async () => wrap([{ id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" }]),
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(snapshot.sessions.length, 1)
  assert.equal(digest.sessionID, "s-1")
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 1)
  assert.deepEqual(todoArgs, [{ sessionID: "s-1" }])
  assert.deepEqual(messageArgs, [{ sessionID: "s-1", limit: 1 }])
})

test("bridge live snapshot: permission.list() hang 触发实例级 timeout unavailable，不阻塞整体返回", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-timeout-instance",
    instanceName: "Bridge Timeout Instance",
    projectName: "project-timeout-instance",
    directory: "/repo",
    pid: 22346,
    liveReadTimeoutMs: 20,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => [{ info: { id: "m-1" }, parts: [] }],
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => new Promise(() => {}),
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()

  assert.equal(Array.isArray(snapshot.unavailable), true)
  assert.equal(snapshot.unavailable.includes("permissionList"), true)
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].status, "busy")
  assert.equal(snapshot.sessions[0].pendingQuestionCount, 1)
})

test("bridge live snapshot: session.messages() hang 触发 session 级 timeout unavailable，不阻塞实例返回", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-timeout-session",
    instanceName: "Bridge Timeout Session",
    projectName: "project-timeout-session",
    directory: "/repo",
    pid: 32346,
    liveReadTimeoutMs: 20,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => new Promise(() => {}),
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => [{ id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" }],
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(snapshot.sessions.length, 1)
  assert.equal(Array.isArray(snapshot.unavailable), false)
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 1)
  assert.equal(Array.isArray(digest.unavailable), true)
  assert.equal(digest.unavailable.includes("messages"), true)
})

test("bridge live snapshot diagnostics: 记录超时阶段与总耗时", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-diagnostics",
    instanceName: "Bridge Diagnostics",
    projectName: "project-diagnostics",
    directory: "/repo",
    pid: 42347,
    liveReadTimeoutMs: 20,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => new Promise(() => {}),
      },
      question: {
        list: async () => [],
      },
      permission: {
        list: async () => [],
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(snapshot.sessions.length, 1)

  const stageEvent = events.find((event) => event.type === "collectStatusStage" && event.stage === "session.messages:s-1")
  assert.equal(stageEvent?.status, "rejected")
  assert.equal(stageEvent?.timeout, true)
  assert.equal(typeof stageEvent?.durationMs, "number")

  const completedEvent = events.find((event) => event.type === "collectStatusCompleted")
  assert.equal(completedEvent?.instanceID, "bridge-instance-diagnostics")
  assert.equal(completedEvent?.sessionCount, 1)
  assert.equal(typeof completedEvent?.durationMs, "number")
})

test("bridge recovery diagnostics: resync 会记录 started/completed", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []
  const calls = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-resync",
    instanceName: "Bridge Resync",
    projectName: "project-resync",
    directory: "/repo",
    pid: 52347,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]
        },
        status: async () => {
          calls.push("session.status")
          return { "s-1": { type: "busy" } }
        },
        todo: async () => {
          calls.push("session.todo")
          return []
        },
        messages: async () => {
          calls.push("session.messages")
          return []
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return []
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return []
        },
      },
    },
  })

  const snapshot = await bridge.resyncBrokerState({ reason: "brokerReconnect" })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(snapshot.sessions.length, 1)
  assert.deepEqual(calls, ["session.list", "session.status", "question.list", "permission.list", "session.todo", "session.messages"])

  const startedEvent = events.find((event) => event.type === "bridgeResyncStarted")
  assert.equal(startedEvent?.instanceID, "bridge-instance-resync")
  assert.equal(startedEvent?.reason, "brokerReconnect")

  const completedEvent = events.find((event) => event.type === "bridgeResyncCompleted")
  assert.equal(completedEvent?.instanceID, "bridge-instance-resync")
  assert.equal(completedEvent?.sessionCount, 1)
  assert.equal(typeof completedEvent?.durationMs, "number")
})

test("bridge recovery diagnostics: resync 失败时会记录稳定 failed code", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-resync-failed",
    instanceName: "Bridge Resync Failed",
    projectName: "project-resync-failed",
    directory: "/repo",
    pid: 52348,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => ({ data: 123 }),
        status: async () => ({ data: {} }),
        todo: async () => [],
        messages: async () => [],
      },
      question: {
        list: async () => [],
      },
      permission: {
        list: async () => [],
      },
    },
  })

  await assert.rejects(() => bridge.resyncBrokerState({ reason: "manual" }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const failedEvent = events.find((event) => event.type === "bridgeResyncFailed")
  assert.equal(failedEvent?.instanceID, "bridge-instance-resync-failed")
  assert.equal(failedEvent?.reason, "manual")
  assert.equal(failedEvent?.code, "bridgeResyncFailed")
  assert.equal(typeof failedEvent?.durationMs, "number")
  assert.match(failedEvent?.error ?? "", /not iterable|sessions is not iterable|spread/i)
})

test("bridge live snapshot: 未知当前前台 session 时显式返回 no active sessions", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)
  const calls = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-no-known-session",
    instanceName: "Bridge No Known Session",
    projectName: "project-no-known-session",
    directory: "/repo",
    pid: 42348,
    getActiveSessionID: () => undefined,
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]
        },
        status: async () => {
          calls.push("session.status")
          return { "s-1": { type: "busy" } }
        },
        todo: async () => {
          calls.push("session.todo")
          return []
        },
        messages: async () => {
          calls.push("session.messages")
          return []
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return []
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return []
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const reply = statusFormat.formatInstanceStatusSnapshot(snapshot)

  assert.equal(snapshot.sessions.length, 0)
  assert.deepEqual(calls, [])
  assert.match(reply, /no active sessions/i)
})

test("broker-client collectStatus handler: 仅在请求时触发 bridge live 读取，且同一 bridge 可重复响应", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-bridge-handler-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let bridgeClient = null
  let collectCalls = 0

  try {
    const bridge = {
      collectStatusSnapshot: async () => {
        collectCalls += 1
        return { instanceID: "status-bridge-handler", call: collectCalls }
      },
    }

    bridgeClient = await brokerClient.connect(endpoint, { bridge })
    await bridgeClient.registerInstance({ instanceID: "status-bridge-handler", pid: process.pid })

    assert.equal(collectCalls, 0)

    const first = await server.collectStatus()
    const second = await server.collectStatus()

    assert.equal(collectCalls, 2)
    const firstItem = first.instances.find((item) => item.instanceID === "status-bridge-handler")
    const secondItem = second.instances.find((item) => item.instanceID === "status-bridge-handler")
    assert.equal(firstItem.status, "ok")
    assert.equal(secondItem.status, "ok")
    assert.deepEqual(firstItem.snapshot, { instanceID: "status-bridge-handler", call: 1 })
    assert.deepEqual(secondItem.snapshot, { instanceID: "status-bridge-handler", call: 2 })

  } finally {
    if (bridgeClient) {
      await bridgeClient.close().catch(() => {})
    }
    await server.close()
  }
})

test("bridge 收到 replyQuestion 后在本进程里调用真实 client.question.reply 并回 replyQuestionResult envelope", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-bridge-reply-question`)

  const replyCalls = []
  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-reply-question",
    instanceName: "Bridge Reply Question",
    projectName: "project-reply",
    directory: "/repo",
    pid: 123,
    client: {
      session: {
        list: async () => [],
        status: async () => ({}),
        todo: async () => [],
        messages: async () => [],
      },
      question: {
        list: async () => [],
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {
        list: async () => [],
      },
    },
  })

  const result = await bridge.handleBrokerEnvelope({
    id: "env-reply-question-1",
    type: "replyQuestion",
    payload: {
      mutationId: "mutation-reply-question-1",
      requestID: "q-runtime-1",
      answers: [["done"]],
    },
  })

  assert.deepEqual(replyCalls, [{ requestID: "q-runtime-1", answers: [["done"]] }])
  assert.deepEqual(result, {
    id: "env-reply-question-1",
    type: "replyQuestionResult",
    payload: {
      mutationId: "mutation-reply-question-1",
      ok: true,
    },
  })
})

test("broker-server dispatchReplyQuestionToInstance 通过 broker<->bridge 长连接往返并等待结果", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-reply-dispatch-server`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}-reply-dispatch-client`)
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-reply-dispatch-bridge`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-reply-dispatch-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let client = null
  const replyCalls = []
  try {
    const bridge = bridgeModule.createWechatBridge({
      instanceID: "instance-rpc-question-1",
      instanceName: "Reply Bridge",
      projectName: "project-rpc",
      directory: "/repo",
      pid: process.pid,
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: {
          list: async () => [],
          reply: async (input) => {
            replyCalls.push(input)
            return { data: true }
          },
        },
        permission: {
          list: async () => [],
        },
      },
    })

    client = await brokerClient.connect(endpoint, { bridge })
    await client.registerInstance({ instanceID: "instance-rpc-question-1", pid: process.pid })

    const result = await server.dispatchReplyQuestionToInstance({
      instanceID: "instance-rpc-question-1",
      mutationId: "mutation-rpc-question-1",
      requestID: "q-runtime-2",
      answers: [["done"]],
    })

    assert.deepEqual(replyCalls, [{ requestID: "q-runtime-2", answers: [["done"]] }])
    assert.deepEqual(result, { mutationId: "mutation-rpc-question-1", ok: true })
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker-server dispatchReplyPermissionToInstance 在 bridge 返回 error 时得到 ok:false 结果", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-permission-dispatch-server`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}-permission-dispatch-client`)
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-permission-dispatch-bridge`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-permission-dispatch-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let client = null
  try {
    const bridge = bridgeModule.createWechatBridge({
      instanceID: "instance-rpc-permission-1",
      instanceName: "Permission Bridge",
      projectName: "project-rpc",
      directory: "/repo",
      pid: process.pid,
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: {
          list: async () => [],
        },
        permission: {
          list: async () => [],
          reply: async () => ({ error: new Error("permission-denied") }),
        },
      },
    })

    client = await brokerClient.connect(endpoint, { bridge })
    await client.registerInstance({ instanceID: "instance-rpc-permission-1", pid: process.pid })

    const result = await server.dispatchReplyPermissionToInstance({
      instanceID: "instance-rpc-permission-1",
      mutationId: "mutation-rpc-permission-1",
      requestID: "p-runtime-1",
      reply: "reject",
      message: "no",
    })

    assert.deepEqual(result, {
      mutationId: "mutation-rpc-permission-1",
      ok: false,
      errorMessage: "permission-denied",
    })
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker-client connect: 同时传入 bridge 和 onCollectStatus 会显式报错", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-ambiguous-options-"))
  const endpoint = createBrokerEndpoint(tempDir)

  await assert.rejects(
    () =>
      brokerClient.connect(endpoint, {
        bridge: {
          collectStatusSnapshot: async () => ({ ok: true }),
        },
        onCollectStatus: async () => ({ ok: true }),
      }),
    /ambiguous/i,
  )
})

test("/status 文案边界：标题分段、inline code tag、checklist todo 优先，且不前置内部 ID", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-format-1",
    instances: [
      {
        instanceID: "internal-instance-rich-123",
        status: "ok",
        snapshot: {
          instanceID: "internal-instance-rich-123",
          instanceName: "Rich hidden runtime label",
          pid: 101,
          directory: "/repo",
          collectedAt: 123,
          unavailable: ["permissionList"],
          sessions: [
            {
              sessionID: "session-hidden-123",
              title: "发布主线",
              directory: "/repo",
              updatedAt: 400,
              status: "busy",
              pendingQuestionCount: 1,
              pendingPermissionCount: 3,
              todoSummary: { total: 4, inProgress: 1, completed: 1 },
              todoItems: [
                { status: "pending", content: "发布 release 草稿" },
                { status: "in_progress", content: "等待 npm 发布" },
                { status: "completed", content: "更新 README" },
                { status: "cancelled", content: "已取消的迁移任务" },
              ],
              questionHighlights: ["问题：是否先发 staging 再发 production"],
              highlights: [
                { kind: "permission", text: "pending permission: 3" },
                { kind: "question", text: "pending question: 1" },
                { kind: "running-tool", text: "running tool: bash" },
                { kind: "completed-tool", text: "completed tool: edit" },
                { kind: "todo", text: "todo: 1 in progress, 1 completed, 4 total" },
                { kind: "status", text: "status: busy" },
              ],
            },
            {
              sessionID: "s-new-2",
              title: "new-2",
              directory: "/repo",
              updatedAt: 300,
              status: "idle",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              unavailable: ["messages"],
              highlights: [
                { kind: "question", text: "pending question: 0" },
                { kind: "status", text: "status: idle" },
              ],
            },
            {
              sessionID: "s-new-3",
              title: "new-3",
              directory: "/repo",
              updatedAt: 200,
              status: "retry",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              highlights: [{ kind: "status", text: "status: retry" }],
            },
            {
              sessionID: "s-old-should-hide",
              title: "old-hide",
              directory: "/repo",
              updatedAt: 100,
              status: "idle",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              highlights: [{ kind: "status", text: "status: idle" }],
            },
          ],
        },
      },
      {
        instanceID: "internal-timeout-456",
        status: "timeout/unreachable",
      },
    ],
  })

  assert.match(reply, /发布主线/)
  assert.match(reply, /`#busy` `#todo:4` `#question:1` `#permission:3`/)
  assert.match(reply, /\[ \] 发布 release 草稿/)
  assert.match(reply, /\[-\] 等待 npm 发布/)
  assert.match(reply, /\[x\] 更新 README/)
  assert.match(reply, /\[~\] 已取消的迁移任务/)
  assert.match(reply, /问题：是否先发 staging 再发 production/i)
  assert.match(reply, /running tool: bash/i)
  assert.match(reply, /completed tool: edit/i)
  assert.match(reply, /session unavailable: messages/i)
  assert.match(reply, /instance unavailable: permissionList/i)
  assert.match(reply, /timeout\/unreachable/i)

  assert.match(reply, /new-2/)
  assert.match(reply, /new-3/)
  assert.doesNotMatch(reply, /old-hide|s-old-should-hide/)
  assert.doesNotMatch(reply, /internal-instance-rich-123|session-hidden-123|internal-timeout-456|instanceID|sessionID|createdAt/)
  assert.doesNotMatch(reply, /\/status|slash command|recent command/i)

  const titleIndex = reply.indexOf("发布主线")
  const tagsIndex = reply.indexOf("`#busy`")
  const todoIndex = reply.indexOf("[ ] 发布 release 草稿")
  const questionIndex = reply.indexOf("问题：是否先发 staging 再发 production")
  const runningIndex = reply.indexOf("running tool: bash")
  assert.equal(titleIndex >= 0, true)
  assert.equal(tagsIndex > titleIndex, true)
  assert.equal(todoIndex > tagsIndex, true)
  assert.equal(questionIndex > todoIndex, true)
  assert.equal(runningIndex > questionIndex, true)
})

test("command parser: 识别 /status /reply /allow /recover", async () => {
  const parser = await import(`../dist/wechat/command-parser.js?reload=${Date.now()}`)

  assert.deepEqual(parser.parseWechatSlashCommand("/status"), { type: "status" })
  assert.deepEqual(parser.parseWechatSlashCommand("/reply q1 done"), { type: "reply", handle: "q1", text: "done" })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 once approved"), {
    type: "allow",
    handle: "p1",
    reply: "once",
    message: "approved",
  })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 always approved"), {
    type: "allow",
    handle: "p1",
    reply: "always",
    message: "approved",
  })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 reject no"), {
    type: "allow",
    handle: "p1",
    reply: "reject",
    message: "no",
  })
  assert.deepEqual(parser.parseWechatSlashCommand("/recover q1"), {
    type: "recover",
    handle: "q1",
  })
  assert.equal(parser.parseWechatSlashCommand("/replyq1 done"), null)
  assert.equal(parser.parseWechatSlashCommand("/allowp1 once ok"), null)
  assert.equal(parser.parseWechatSlashCommand("/recoverq1"), null)
  assert.equal(parser.parseWechatSlashCommand("status"), null)
})

test("broker slash handler: /status 走 collectStatus formatter，其它 slash 透传结构化命令", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-slash-handler-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({
        instanceID: "slash-instance-hidden-1",
        instanceName: "Slash OK hidden",
        pid: 111,
        directory: "/repo",
        collectedAt: Date.now(),
        sessions: [
          {
            sessionID: "slash-session-hidden-1",
            title: "Slash 主会话",
            directory: "/repo",
            updatedAt: 100,
            status: "busy",
            pendingQuestionCount: 1,
            pendingPermissionCount: 0,
            todoSummary: { total: 0, inProgress: 0, completed: 0 },
            questionHighlights: ["问题：是否继续处理当前 slash 请求"],
            highlights: [
              { kind: "question", text: "pending question: 1" },
              { kind: "status", text: "status: busy" },
            ],
          },
        ],
      }),
    })
    await responsive.registerInstance({ instanceID: "slash-instance-ok", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "slash-instance-timeout", pid: process.pid })

    const statusReply = await server.handleWechatSlashCommand({ type: "status" })
    assert.match(statusReply, /Slash 主会话/)
    assert.match(statusReply, /#busy/)
    assert.match(statusReply, /#question:1/)
    assert.match(statusReply, /问题：是否继续处理当前 slash 请求/)
    assert.match(statusReply, /timeout\/unreachable/i)
    assert.doesNotMatch(statusReply, /slash-instance-hidden-1|slash-session-hidden-1|instanceID|sessionID|createdAt/)

    assert.equal(
      await server.handleWechatSlashCommand({ type: "reply", handle: "q1", text: "hi" }),
      "命令暂未实现：/reply",
    )
    assert.equal(
      await server.handleWechatSlashCommand({ type: "allow", handle: "p1", reply: "once" }),
      "命令暂未实现：/allow",
    )
  } finally {
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker 聚合输出：collectStatus 返回格式化 /status reply", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-reply-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({
        instanceID: "internal-reply-instance-ok",
        instanceName: "Reply OK hidden",
        pid: 111,
        directory: "/repo",
        collectedAt: Date.now(),
        sessions: [
          {
            sessionID: "reply-session-hidden-1",
            title: "回复主流程",
            directory: "/repo",
            updatedAt: 100,
            status: "busy",
            pendingQuestionCount: 1,
            pendingPermissionCount: 0,
            todoSummary: { total: 0, inProgress: 0, completed: 0 },
            questionHighlights: ["问题：是否继续执行发布"],
            highlights: [
              { kind: "question", text: "pending question: 1" },
              { kind: "status", text: "status: busy" },
            ],
          },
        ],
      }),
    })
    await responsive.registerInstance({ instanceID: "reply-instance-ok", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "reply-instance-timeout", pid: process.pid })

    const result = await server.collectStatus()

    assert.equal(typeof result.reply, "string")
    assert.match(result.reply, /回复主流程/)
    assert.match(result.reply, /#busy/)
    assert.match(result.reply, /#question:1/)
    assert.match(result.reply, /问题：是否继续执行发布/)
    assert.match(result.reply, /timeout\/unreachable/i)
    assert.doesNotMatch(result.reply, /internal-reply-instance-ok|reply-session-hidden-1|instanceID|sessionID|createdAt/)
    assert.doesNotMatch(result.reply, /\/status|slash command|recent command/i)
  } finally {
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("status formatter: 过滤畸形 snapshot，避免输出 undefined 文案", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-malformed-1",
    instances: [
      {
        instanceID: "malformed-instance",
        status: "ok",
        snapshot: {
          instanceID: "malformed-instance",
          instanceName: "Malformed",
          sessions: [
            null,
            undefined,
            {},
            {
              sessionID: "ok-session",
              title: "ok",
              updatedAt: 1,
              todoSummary: { total: 1, inProgress: 0, completed: 0 },
              todoItems: [
                { status: "pending", content: " 保留的事项 " },
                { status: "blocked", content: "非法状态" },
                { status: "completed", content: "   " },
                { status: "cancelled" },
                "legacy string todo",
              ],
              unavailable: ["messages", "messages", "todo"],
              highlights: [
                { kind: "status", text: "status: idle" },
                { kind: "status" },
                { kind: "unknown-kind", text: "bad" },
                { kind: "question", text: "pending question: 1" },
              ],
            },
          ],
        },
      },
    ],
  })

  assert.match(reply, /^wechat status\nok$/m)
  assert.match(reply, /`#unknown` `#todo:1` `#question:0` `#permission:0`/)
  assert.match(reply, /\[ \] 保留的事项/)
  assert.match(reply, /session unavailable: messages, todo/)
  assert.doesNotMatch(reply, /undefined|null|malformed-instance|ok-session|status: idle|pending question: 1|非法状态|legacy string todo/)
})

test("status formatter: 同分 session 与 unavailable 列表输出稳定（排序+去重）", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-stable-1",
    instances: [
      {
        instanceID: "stable-instance",
        status: "ok",
        snapshot: {
          instanceID: "stable-instance",
          instanceName: "Stable",
          unavailable: ["questionList", "permissionList", "questionList"],
          sessions: [
            {
              sessionID: "s-b",
              title: "beta",
              updatedAt: 100,
              unavailable: ["todo", "messages", "todo"],
              highlights: [{ kind: "status", text: "status: idle" }],
            },
            {
              sessionID: "s-a",
              title: "alpha",
              updatedAt: 100,
              highlights: [{ kind: "status", text: "status: busy" }],
            },
          ],
        },
      },
    ],
  })

  assert.match(reply, /instance unavailable: permissionList, questionList/)
  assert.match(reply, /session unavailable: messages, todo/)

  const saIndex = reply.indexOf("alpha")
  const sbIndex = reply.indexOf("beta")
  assert.equal(saIndex >= 0, true)
  assert.equal(sbIndex > saIndex, true)
})

test("wechat status runtime: 收到响应即推进 get_updates_buf，失败重试不回滚，slash 与非 slash 分别回复", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const getUpdatesCalls = []
  const sendCalls = []
  const slashCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    longPollTimeoutMs: 1234,
    loadPublicHelpers: async () => ({
      entry: {
        packageJsonPath: "/tmp/pkg.json",
        packageRoot: "/tmp",
        extensions: ["./index.js"],
        entryRelativePath: "./index.js",
        entryAbsolutePath: "/tmp/index.js",
      },
      pluginId: "test-plugin",
      qrGateway: {
        loginWithQrStart: () => ({}),
        loginWithQrWait: () => ({}),
      },
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-from-state",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-slash",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: " /status " } }],
              },
              {
                from_user_id: "user-text",
                context_token: "ctx-2",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        if (pollCount === 2) {
          throw new Error("temporary getUpdates error")
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          get_updates_buf: "buf-after-poll-3",
          msgs: [],
        }
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async ({ command, text }) => {
      slashCalls.push({ command, text })
      return "status reply text"
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 2 && getUpdatesCalls.length >= 3)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-from-state")
  assert.equal(getUpdatesCalls[0].timeoutMs, 1234)
  assert.equal(getUpdatesCalls[2].get_updates_buf, "buf-after-poll-1")

  assert.equal(slashCalls.length, 1)
  assert.deepEqual(slashCalls[0].command, { type: "status" })
  assert.equal(slashCalls[0].text.trim(), "/status")

  assert.equal(sendCalls.length, 2)
  assert.equal(sendCalls[0].to, "user-slash")
  assert.equal(sendCalls[0].text, "status reply text")
  assert.equal(sendCalls[0].opts.contextToken, "ctx-1")
  assert.equal(sendCalls[1].to, "user-text")
  assert.equal(sendCalls[1].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
  assert.equal(sendCalls[1].opts.contextToken, "ctx-2")
})

test("wechat status runtime: 仅 accepted slash 会持久化 context_token 并清理 stale，non-slash 不会", async () => {
  const sandboxWechatStateRoot = isolatedWechatStateRoot.stateRoot

  assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, sandboxWechatStateRoot)

  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)
  const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)

  const accountId = `wx-runtime-token-${Date.now()}`
  const sendCalls = []
  let pollCount = 0
  try {
    await tokenStore.upsertInboundToken({
      wechatAccountId: accountId,
      userId: "user-slash",
      contextToken: "ctx-old",
      updatedAt: 1_700_300_000_000,
      source: "question",
      sourceRef: "legacy-request",
    })
    await tokenStore.markTokenStale({
      wechatAccountId: accountId,
      userId: "user-slash",
      staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
    })
    await tokenStore.upsertInboundToken({
      wechatAccountId: accountId,
      userId: "user-text",
      contextToken: "ctx-text-old",
      updatedAt: 1_700_300_000_010,
      source: "message",
      sourceRef: "hello-before",
    })
    await tokenStore.markTokenStale({
      wechatAccountId: accountId,
      userId: "user-text",
      staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
    })

    const runtime = runtimeModule.createWechatStatusRuntime({
      retryDelayMs: 0,
      loadPublicHelpers: async () => ({
        latestAccountState: {
          accountId,
          token: "token-runtime-live",
          baseUrl: "https://wx.example.com",
          getUpdatesBuf: "buf-runtime-token",
        },
        getUpdates: async () => {
          pollCount += 1
          if (pollCount === 1) {
            return {
              get_updates_buf: "buf-runtime-token-1",
              msgs: [
                {
                  from_user_id: "user-slash",
                  context_token: "ctx-status-refresh",
                  item_list: [{ type: 1, text_item: { text: " /status " } }],
                },
                {
                  from_user_id: "user-text",
                  context_token: "ctx-text-refresh",
                  item_list: [{ type: 1, text_item: { text: "hello runtime" } }],
                },
              ],
            }
          }
          return new Promise(() => {})
        },
        sendMessageWeixin: async (input) => {
          sendCalls.push(input)
          return { messageId: `m-${sendCalls.length}` }
        },
      }),
      onSlashCommand: async () => "runtime token refreshed",
    })

    await runtime.start()
    try {
      await waitForAsync(async () => {
        const slashState = await tokenStore.readTokenState(accountId, "user-slash")
        const textState = await tokenStore.readTokenState(accountId, "user-text")
        return sendCalls.length === 2
          && slashState?.contextToken === "ctx-status-refresh"
          && slashState?.staleReason === undefined
          && textState?.contextToken === "ctx-text-old"
          && textState?.staleReason === tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON
      })
    } finally {
      await runtime.close()
    }

    const slashState = await tokenStore.readTokenState(accountId, "user-slash")
    const textState = await tokenStore.readTokenState(accountId, "user-text")

    assert.equal(slashState?.contextToken, "ctx-status-refresh")
    assert.equal(slashState?.staleReason, undefined)
    assert.equal(textState?.contextToken, "ctx-text-old")
    assert.equal(textState?.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)
    assert.equal(sendCalls[0]?.opts?.contextToken, "ctx-status-refresh")
    assert.equal(sendCalls[1]?.opts?.contextToken, "ctx-text-refresh")
  } finally {
    assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, sandboxWechatStateRoot)
  }
})

test("wechat status runtime: get_updates_buf 推进后会持久化回写，重启可从最新 buf 继续", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const persistedBufWrites = []
  const getUpdatesCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-persist",
        token: "token-persist",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-initial",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-new-1",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
      persistGetUpdatesBuf: async ({ accountId, getUpdatesBuf }) => {
        persistedBufWrites.push({ accountId, getUpdatesBuf })
      },
    }),
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 2 && persistedBufWrites.length >= 1)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-initial")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new-1")
  assert.deepEqual(persistedBufWrites, [{ accountId: "acc-persist", getUpdatesBuf: "buf-new-1" }])
})

test("wechat status runtime: get_updates_buf 回写失败仅记录错误，不拖死后续轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const runtimeErrors = []
  const persistedBufWrites = []
  const getUpdatesCalls = []
  const sendCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onRuntimeError: (error) => {
      runtimeErrors.push(error)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-persist-error",
        token: "token-persist-error",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-initial",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-new-1",
            msgs: [
              {
                from_user_id: "user-a",
                context_token: "ctx-a",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        if (pollCount === 2) {
          return {
            get_updates_buf: "buf-new-2",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
      persistGetUpdatesBuf: async ({ accountId, getUpdatesBuf }) => {
        persistedBufWrites.push({ accountId, getUpdatesBuf })
        if (getUpdatesBuf === "buf-new-1") {
          throw new Error("persist failed once")
        }
      },
    }),
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 3 && sendCalls.length >= 1 && runtimeErrors.length >= 1)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-initial")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new-1")
  assert.equal(getUpdatesCalls[2].get_updates_buf, "buf-new-2")
  assert.equal(sendCalls[0].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
  assert.equal(runtimeErrors.length >= 1, true)
  assert.match(String(runtimeErrors[0]), /persist failed once/i)
  assert.deepEqual(persistedBufWrites, [
    { accountId: "acc-persist-error", getUpdatesBuf: "buf-new-1" },
    { accountId: "acc-persist-error", getUpdatesBuf: "buf-new-2" },
  ])
})

test("wechat status runtime: /status /reply /allow 走各自 slash handler，非 slash 不触发 collectStatus", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  const slashCalls = []
  let statusCollectCalls = 0
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-from-state",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
              {
                from_user_id: "user-reply",
                context_token: "ctx-reply",
                item_list: [{ type: 1, text_item: { text: "/reply q1 hi" } }],
              },
              {
                from_user_id: "user-allow",
                context_token: "ctx-allow",
                item_list: [{ type: 1, text_item: { text: "/allow p1 once" } }],
              },
              {
                from_user_id: "user-text",
                context_token: "ctx-text",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async ({ command }) => {
      slashCalls.push(command)
      if (command.type === "status") {
        statusCollectCalls += 1
        return "formatted status reply from collectStatus"
      }
      if (command.type === "reply") {
        return "reply result"
      }
      return "allow result"
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 4)
  } finally {
    await runtime.close()
  }

  assert.equal(statusCollectCalls, 1)
  assert.deepEqual(slashCalls, [
    { type: "status" },
    { type: "reply", handle: "q1", text: "hi" },
    { type: "allow", handle: "p1", reply: "once" },
  ])
  assert.equal(sendCalls[0].text, "formatted status reply from collectStatus")
  assert.equal(sendCalls[1].text, "reply result")
  assert.equal(sendCalls[2].text, "allow result")
  assert.equal(sendCalls[3].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
})

test("wechat status runtime diagnostics: 记录 skipped/slash/send-failed 三类断点事件", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const diagnostics = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-diag",
        token: "token-diag",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-diag",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-diag-next",
            msgs: [
              {
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
              {
                from_user_id: "user-empty",
                item_list: [{ type: 1, text_item: { text: "   " } }],
              },
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: " /status " } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => {
        throw new Error("send failed for diagnostics")
      },
    }),
    onSlashCommand: async () => "status diagnostics reply",
  })

  await runtime.start()
  try {
    await waitFor(() => diagnostics.length >= 4)
  } finally {
    await runtime.close()
  }

  const skippedMissingFromUserId = diagnostics.find(
    (event) => event?.type === "messageSkipped" && event?.reason === "missingFromUserId",
  )
  const skippedMissingText = diagnostics.find(
    (event) => event?.type === "messageSkipped" && event?.reason === "missingText",
  )
  const recognizedStatus = diagnostics.find(
    (event) => event?.type === "slashCommandRecognized" && event?.command?.type === "status",
  )
  const sendFailed = diagnostics.find(
    (event) => event?.type === "replySendFailed" && event?.to === "user-status",
  )

  assert.ok(skippedMissingFromUserId)
  assert.ok(skippedMissingText)
  assert.ok(recognizedStatus)
  assert.ok(sendFailed)
})

test("wechat status runtime diagnostics: loadPublicHelpers 失败时写 runtimeError", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-load-public-helpers`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("helpers unavailable")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.deepEqual(runtimeError, {
    type: "runtimeError",
    stage: "loadPublicHelpers",
    error: "helpers unavailable",
    consecutiveFailures: 1,
    backoffMs: 10,
    retryState: "backing-off",
    reachedGetUpdates: false,
  })
})

test("wechat status runtime: loadPublicHelpers 持续失败时进入受控退避而不是固定 1s 热重试", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-helper-failure-backoff`
  )

  let now = 0
  let helperCalls = 0
  const sleeps = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    now: () => now,
    sleepImpl: async (ms) => {
      sleeps.push(ms)
      now += ms
      await new Promise((resolve) => setImmediate(resolve))
    },
    loadPublicHelpers: async () => {
      helperCalls += 1
      throw new Error("missing delayed-stream")
    },
  })

  await runtime.start()
  try {
    await waitFor(() => helperCalls >= 6, 1000)
  } finally {
    await runtime.close()
  }

  assert.equal(sleeps.length >= 5, true)
  assert.equal(new Set(sleeps).size > 1, true)
  assert.equal(sleeps.some((ms) => ms > 10), true)
})

test("wechat status runtime: 持续 helper 失败时写出结构化退避状态", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-helper-failure-structured-state`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    sleepImpl: async () => {
      await new Promise((resolve) => setImmediate(resolve))
    },
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("missing delayed-stream")
    },
  })

  await runtime.start()
  try {
    await waitFor(
      () => diagnostics.some(
        (event) =>
          event?.type === "runtimeError"
          && event?.stage === "loadPublicHelpers"
          && event?.consecutiveFailures >= 3,
      ),
      1000,
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.filter(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  ).at(-1)

  assert.equal(runtimeError?.consecutiveFailures >= 3, true)
  assert.equal(typeof runtimeError?.backoffMs, "number")
  assert.equal(runtimeError?.backoffMs > 10, true)
  assert.equal(runtimeError?.retryState, "backing-off")
})

test("wechat status runtime: helper 持续失败时明确记录 getUpdates 未触达", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-helper-failure-get-updates-not-reached`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    sleepImpl: async () => {
      await new Promise((resolve) => setImmediate(resolve))
    },
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("missing delayed-stream")
    },
  })

  await runtime.start()
  try {
    await waitFor(
      () => diagnostics.some(
        (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
      ),
      1000,
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.reachedGetUpdates, false)
})

test("wechat status runtime: helper 持续失败时进入 plateau / bounded steady state", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-helper-failure-plateau`
  )

  let now = 0
  let helperCalls = 0
  const sleeps = []
  const failureStates = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    now: () => now,
    sleepImpl: async (ms) => {
      sleeps.push(ms)
      now += ms
      await new Promise((resolve) => setImmediate(resolve))
    },
    onFailureStateChange: (state) => {
      if (state) {
        failureStates.push(state)
      }
    },
    loadPublicHelpers: async () => {
      helperCalls += 1
      throw new Error("missing delayed-stream")
    },
  })

  await runtime.start()
  let debugState
  try {
    await waitFor(() => helperCalls >= 15, 1000)
    debugState = runtime.getDebugFailureStateForTest()
  } finally {
    await runtime.close()
  }

  assert.equal(failureStates.length >= 10, true)
  assert.equal(sleeps.length >= 14, true)
  assert.equal(new Set(sleeps.slice(-3)).size, 1)
  assert.equal(sleeps.at(-1) > sleeps[0], true)
  assert.equal(debugState?.helperFailureState?.retryState, "backing-off")
  assert.equal(debugState?.helperFailureState?.currentBackoffMs, sleeps.at(-1))
  assert.equal(debugState?.retainedFailureObjectCount, 1)
})

test("wechat status runtime: close 后重新 start 不继承旧 failure state", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-helper-failure-reset-after-close`
  )

  const diagnostics = []
  let now = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    now: () => now,
    sleepImpl: async (ms) => {
      now += ms
      await new Promise((resolve) => setImmediate(resolve))
    },
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("missing delayed-stream")
    },
  })

  await runtime.start()
  await waitFor(
    () => diagnostics.filter((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers").length >= 3,
    1000,
  )
  await runtime.close()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(runtime.getDebugFailureStateForTest(), {
    helperFailureState: null,
    retainedFailureObjectCount: 0,
  })

  const diagnosticsCountBeforeRestart = diagnostics.length

  await runtime.start()
  await waitFor(
    () => diagnostics.length > diagnosticsCountBeforeRestart,
    1000,
  )
  const firstFailureAfterRestart = diagnostics.slice(diagnosticsCountBeforeRestart).find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )
  await runtime.close()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(firstFailureAfterRestart, {
    type: "runtimeError",
    stage: "loadPublicHelpers",
    error: "missing delayed-stream",
    consecutiveFailures: 1,
    backoffMs: 10,
    retryState: "backing-off",
    reachedGetUpdates: false,
  })
  assert.deepEqual(runtime.getDebugFailureStateForTest(), {
    helperFailureState: null,
    retainedFailureObjectCount: 0,
  })
})

test("wechat status runtime diagnostics: runtimeError.error 在落盘前已做源头脱敏", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-source-redaction`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization: Bearer token-secret for user-secret")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(typeof runtimeError?.error, "string")
  assert.doesNotMatch(runtimeError?.error ?? "", /token-secret|user-secret/)
  assert.match(runtimeError?.error ?? "", /REDACTED/i)
})

test("wechat status runtime diagnostics: runtimeError.error 源头脱敏后仍保留非敏感上下文", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-source-context`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization: Bearer token-secret userId=user-secret requestId=req-123 upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(typeof runtimeError?.error, "string")
  assert.doesNotMatch(runtimeError?.error ?? "", /token-secret|user-secret/)
  assert.match(runtimeError?.error ?? "", /requestId=req-123/)
  assert.match(runtimeError?.error ?? "", /upstream=502/)
})

test("wechat status runtime diagnostics: runtimeError.error 源头脱敏不会因 free-form messageBody 尾部 key-like 文本泄漏", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-free-form-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("messageBody=top secret reason: token-raw")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "messageBody=[REDACTED_MESSAGE_TEXT]")
  assert.doesNotMatch(runtimeError?.error ?? "", /top secret|token-raw|reason:/)
})

test("wechat status runtime diagnostics: messageBody=https query-style 尾巴也必须整体脱敏", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-message-body-url-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("messageBody=https://x/?conversation=private-chat&id=42")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "messageBody=[REDACTED_MESSAGE_TEXT]")
  assert.doesNotMatch(runtimeError?.error ?? "", /private-chat|id=42|conversation=/)
})

test("wechat status runtime diagnostics: messageBody=hello requestId=req-123 upstream=502 保留安全上下文", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-message-body-safe-context`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("messageBody=hello requestId=req-123 upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "messageBody=[REDACTED_MESSAGE_TEXT] requestId=req-123 upstream=502")
  assert.doesNotMatch(runtimeError?.error ?? "", /messageBody=hello/)
})

test("wechat status runtime diagnostics: messageBody=https://x/?requestId=req-123&upstream=502 不保留 query-style 尾巴", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-message-body-query-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("messageBody=https://x/?requestId=req-123&upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "messageBody=[REDACTED_MESSAGE_TEXT]")
  assert.doesNotMatch(runtimeError?.error ?? "", /requestId=req-123|upstream=502/)
})

test("wechat status runtime diagnostics: messageBody=hello code=E42 more text 不保留松散 code 尾巴", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-message-body-loose-code-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("messageBody=hello code=E42 more text")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "messageBody=[REDACTED_MESSAGE_TEXT]")
  assert.doesNotMatch(runtimeError?.error ?? "", /code=E42|more text/)
})

test("wechat status runtime diagnostics: contextToken=https://x/?requestId=req-123&upstream=502 不保留 query-style 尾巴", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-context-token-query-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("contextToken=https://x/?requestId=req-123&upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "contextToken=[REDACTED_CONTEXT_TOKEN]")
  assert.doesNotMatch(runtimeError?.error ?? "", /requestId=req-123|upstream=502/)
})

test("wechat status runtime diagnostics: runtimeError.error 在 & 分隔 diagnostics 中保留后续非敏感上下文", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-query-style-context`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization=Bearer secret-token&requestId=req-123&upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization=[REDACTED_TOKEN]&requestId=req-123&upstream=502")
  assert.doesNotMatch(runtimeError?.error ?? "", /secret-token/)
})

test("wechat status runtime diagnostics: Authorization: Bearer 后仍保留 key: value 形式的后续上下文", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-bearer-colon-context`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization: Bearer token-secret requestId: req-123 upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization: [REDACTED_TOKEN] requestId: req-123 upstream=502")
  assert.doesNotMatch(runtimeError?.error ?? "", /token-secret/)
})

test("wechat status runtime diagnostics: Authorization: Bearer token-secret code=oauth-live requestId=req-123 不保留 code", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-bearer-code-space`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization: Bearer token-secret code=oauth-live requestId=req-123")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization: [REDACTED_TOKEN] requestId=req-123")
  assert.doesNotMatch(runtimeError?.error ?? "", /token-secret|code=oauth-live/)
})

test("wechat status runtime diagnostics: Authorization: Bearer token-secret,requestId=req-123,upstream=502 保留逗号后的安全上下文", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-bearer-comma-context`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization: Bearer token-secret,requestId=req-123,upstream=502")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization: [REDACTED_TOKEN],requestId=req-123,upstream=502")
  assert.doesNotMatch(runtimeError?.error ?? "", /token-secret/)
})

test("wechat status runtime diagnostics: Authorization=Bearer secret-token&code=oauth-live&requestId=req-123 不保留 code", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-bearer-code-ampersand`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization=Bearer secret-token&code=oauth-live&requestId=req-123")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization=[REDACTED_TOKEN]&requestId=req-123")
  assert.doesNotMatch(runtimeError?.error ?? "", /secret-token|code=oauth-live/)
})

test("wechat status runtime diagnostics: Authorization=https://x/?requestId=req-123&code=oauth-live 不保留 query-style token 尾巴", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-authorization-query-tail`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => {
      throw new Error("Authorization=https://x/?requestId=req-123&code=oauth-live")
    },
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "loadPublicHelpers",
  )

  assert.equal(runtimeError?.error, "Authorization=[REDACTED_TOKEN]")
  assert.doesNotMatch(runtimeError?.error ?? "", /requestId=req-123|code=oauth-live/)
})

test("wechat status runtime diagnostics: getUpdates 失败时写 runtimeError", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-get-updates`
  )

  const diagnostics = []
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-get-updates",
        token: "token-get-updates",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-get-updates",
      },
      getUpdates: async () => {
        throw new Error("getUpdates failed")
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
  })

  await runtime.start()
  try {
    await waitFor(() => diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "getUpdates"))
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "getUpdates",
  )

  assert.deepEqual(runtimeError, {
    type: "runtimeError",
    stage: "getUpdates",
    error: "getUpdates failed",
    reachedGetUpdates: true,
  })
})

test("wechat status runtime diagnostics: persistGetUpdatesBuf 失败时写 runtimeError", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-persist-get-updates-buf`
  )

  const diagnostics = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-persist-error",
        token: "token-persist-error",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-initial",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-next",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      persistGetUpdatesBuf: async () => {
        throw new Error("persist failed")
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "persistGetUpdatesBuf"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "persistGetUpdatesBuf",
  )

  assert.deepEqual(runtimeError, {
    type: "runtimeError",
    stage: "persistGetUpdatesBuf",
    error: "persist failed",
    reachedGetUpdates: true,
  })
})

test("wechat status runtime diagnostics: drainOutboundMessages 失败时写 runtimeError", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-drain-outbound-messages`
  )

  const diagnostics = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    drainOutboundMessages: async () => {
      throw new Error("drain failed")
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-drain-error",
        token: "token-drain-error",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-drain",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-drain-next",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "drainOutboundMessages"),
    )
  } finally {
    await runtime.close()
  }

  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "drainOutboundMessages",
  )

  assert.deepEqual(runtimeError, {
    type: "runtimeError",
    stage: "drainOutboundMessages",
    error: "drain failed",
    reachedGetUpdates: true,
  })
})

test("wechat status runtime diagnostics: sendReplyMessage 失败时同时保留 replySendFailed 与 runtimeError", async () => {
  const runtimeModule = await import(
    `../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}-runtime-error-send-reply-message`
  )

  const diagnostics = []
  let pollCount = 0
  const rawSendFailureMessage = "Authorization: Bearer token-send-error userId=user-send-error"
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-send-error",
        token: "token-send-error",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-send-error",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-send-error-next",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => {
        throw new Error(rawSendFailureMessage)
      },
    }),
    onSlashCommand: async () => "status reply",
  })

  await runtime.start()
  try {
    await waitFor(() =>
      diagnostics.some((event) => event?.type === "runtimeError" && event?.stage === "sendReplyMessage"),
    )
  } finally {
    await runtime.close()
  }

  const replySendFailed = diagnostics.find((event) => event?.type === "replySendFailed" && event?.to === "user-status")
  const runtimeError = diagnostics.find(
    (event) => event?.type === "runtimeError" && event?.stage === "sendReplyMessage",
  )

  assert.ok(replySendFailed)
  assert.deepEqual(replySendFailed, {
    type: "replySendFailed",
    to: "user-status",
    error: rawSendFailureMessage,
    commandType: "status",
  })
  assert.ok(runtimeError)
  assert.equal(runtimeError.type, "runtimeError")
  assert.equal(runtimeError.stage, "sendReplyMessage")
  assert.match(runtimeError.error, /\[REDACTED_TOKEN\]/)
  assert.doesNotMatch(runtimeError.error, /token-send-error|user-send-error/)
  assert.notEqual(runtimeError.error, replySendFailed.error)
})

test("wechat status runtime diagnostics: 诊断写入挂起不阻塞 slash 回复发送", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onDiagnosticEvent: async () => new Promise(() => {}),
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-diag-hang",
        token: "token-diag-hang",
        baseUrl: "https://wx.example.com",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: "m-1" }
      },
    }),
    onSlashCommand: async () => "status reply unaffected by diagnostics",
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 1, 300)
  } finally {
    await runtime.close()
  }

  assert.equal(sendCalls[0].to, "user-status")
  assert.equal(sendCalls[0].text, "status reply unaffected by diagnostics")
})

test("wechat status runtime: slash handler 抛错时返回稳定错误提示，不透出内部堆栈", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async () => {
      throw new Error("collectStatus internal stack: foo")
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 1)
  } finally {
    await runtime.close()
  }

  assert.equal(sendCalls[0].text, runtimeModule.DEFAULT_SLASH_HANDLER_ERROR_REPLY_TEXT)
  assert.doesNotMatch(sendCalls[0].text, /collectStatus|stack|foo/i)
})

test("wechat status runtime: close 可中断进行中的 getUpdates 长轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let getUpdatesStarted = false
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 60_000,
    loadPublicHelpers: async () => ({
      entry: {
        packageJsonPath: "/tmp/pkg.json",
        packageRoot: "/tmp",
        extensions: ["./index.js"],
        entryRelativePath: "./index.js",
        entryAbsolutePath: "/tmp/index.js",
      },
      pluginId: "test-plugin",
      qrGateway: {
        loginWithQrStart: () => ({}),
        loginWithQrWait: () => ({}),
      },
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
      },
      getUpdates: async () => {
        getUpdatesStarted = true
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
  })

  await runtime.start()
  await waitFor(() => getUpdatesStarted)
  await assert.doesNotReject(() =>
    Promise.race([
      runtime.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout while getUpdates pending")), 200)),
    ]),
  )
})

test("wechat status runtime: 初始化阶段失败会持续重试并在成功后继续轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let loadCalls = 0
  const errors = []
  const sendCalls = []
  let getUpdatesCalls = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onRuntimeError: (error) => {
      errors.push(error)
    },
    loadPublicHelpers: async () => {
      loadCalls += 1
      if (loadCalls < 3) {
        throw new Error(`init failed ${loadCalls}`)
      }
      return {
        entry: {
          packageJsonPath: "/tmp/pkg.json",
          packageRoot: "/tmp",
          extensions: ["./index.js"],
          entryRelativePath: "./index.js",
          entryAbsolutePath: "/tmp/index.js",
        },
        pluginId: "test-plugin",
        qrGateway: {
          loginWithQrStart: () => ({}),
          loginWithQrWait: () => ({}),
        },
        latestAccountState: {
          accountId: "acc-1",
          token: "token-1",
          baseUrl: "https://wx.example.com",
        },
        getUpdates: async () => {
          getUpdatesCalls += 1
          if (getUpdatesCalls === 1) {
            return {
              get_updates_buf: "buf-1",
              msgs: [
                {
                  from_user_id: "user-a",
                  context_token: "ctx-a",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }
          }
          return new Promise(() => {})
        },
        sendMessageWeixin: async (input) => {
          sendCalls.push(input)
          return { messageId: "m-1" }
        },
      }
    },
  })

  await runtime.start()
  try {
    await waitFor(() => loadCalls >= 3 && sendCalls.length >= 1, 2000)
    assert.equal(errors.length >= 2, true)
  } finally {
    await assert.doesNotReject(() =>
      Promise.race([
        runtime.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout after init retry success")), 200)),
      ]),
    )
  }
})

test("wechat status runtime: 初始化失败后的重试 sleep 可被 close 立刻中断", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let loadCalls = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 60_000,
    loadPublicHelpers: async () => {
      loadCalls += 1
      throw new Error("init failed always")
    },
  })

  await runtime.start()
  await waitFor(() => loadCalls >= 1)
  await assert.doesNotReject(() =>
    Promise.race([
      runtime.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout while retry sleep pending")), 200)),
    ]),
  )
})

test("wechat status runtime: 后续轮询会重新加载最新账号状态而不是一直复用初始化快照", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const getUpdatesCalls = []
  let loadCount = 0
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => {
      loadCount += 1
      const accountId = loadCount === 1 ? "acc-old" : "acc-new"
      const token = loadCount === 1 ? "token-old" : "token-new"
      const baseUrl = loadCount === 1 ? "https://wx-old.example.com" : "https://wx-new.example.com"
      return {
        latestAccountState: {
          accountId,
          token,
          baseUrl,
          getUpdatesBuf: loadCount === 1 ? "buf-old" : "buf-new",
        },
        getUpdates: async (input) => {
          pollCount += 1
          getUpdatesCalls.push(input)
          if (pollCount === 1) {
            return {
              get_updates_buf: "buf-old-next",
              msgs: [],
            }
          }
          return new Promise(() => {})
        },
        sendMessageWeixin: async () => ({ messageId: "m-1" }),
      }
    },
    shouldReloadState: () => loadCount === 1,
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 2)
  } finally {
    await runtime.close()
  }

  assert.equal(loadCount >= 2, true)
  assert.equal(getUpdatesCalls[0].baseUrl, "https://wx-old.example.com")
  assert.equal(getUpdatesCalls[0].token, "token-old")
  assert.equal(getUpdatesCalls[1].baseUrl, "https://wx-new.example.com")
  assert.equal(getUpdatesCalls[1].token, "token-new")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new")
})

test("broker-entry runtime lifecycle: start/close 绑定且启动失败不抛出", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const normalCalls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        normalCalls.push("start")
      },
      close: async () => {
        normalCalls.push("close")
      },
    }),
  })

  await assert.doesNotReject(() => lifecycle.start())
  await assert.doesNotReject(() => lifecycle.close())
  assert.deepEqual(normalCalls, ["start", "close"])

  let errorCalls = 0
  const failedLifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        throw new Error("runtime startup failed")
      },
      close: async () => {},
    }),
    onRuntimeError: () => {
      errorCalls += 1
    },
  })

  await assert.doesNotReject(() => failedLifecycle.start())
  await assert.doesNotReject(() => failedLifecycle.close())
  assert.equal(errorCalls, 1)
})

test("broker-entry runtime lifecycle: start 部分失败后 close 仍会清理 runtime", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const calls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        calls.push("start")
        throw new Error("partial startup failed")
      },
      close: async () => {
        calls.push("close")
      },
    }),
    onRuntimeError: () => {},
  })

  await assert.doesNotReject(() => lifecycle.start())
  await assert.doesNotReject(() => lifecycle.close())
  assert.deepEqual(calls, ["start", "close"])
})

test("broker-entry runtime lifecycle: 注入 broker slash handler，/status 复用 server.handleWechatSlashCommand", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const slashInputCalls = []
  const brokerSlashCalls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: ({ onSlashCommand }) => {
      return {
        start: async () => {
          slashInputCalls.push(
            await onSlashCommand({
              command: { type: "status" },
              text: "/status",
              message: { from_user_id: "u-1" },
            }),
          )
          slashInputCalls.push(
            await onSlashCommand({
              command: { type: "reply", handle: "q1", text: "hi" },
              text: "/reply q1 hi",
              message: { from_user_id: "u-2" },
            }),
          )
        },
        close: async () => {},
      }
    },
    handleWechatSlashCommand: async (command) => {
      brokerSlashCalls.push(command)
      if (command.type === "status") {
        return "from broker collectStatus"
      }
      if (command.type === "reply") {
        return "from broker reply"
      }
      return "from broker allow"
    },
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.deepEqual(brokerSlashCalls, [
    { type: "status" },
    { type: "reply", handle: "q1", text: "hi" },
  ])
  assert.deepEqual(slashInputCalls, ["from broker collectStatus", "from broker reply"])
})

test("broker-entry runtime lifecycle: 默认 slash handler 不再返回 /status 处理中 占位文案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const slashReplies = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: ({ onSlashCommand }) => ({
      start: async () => {
        slashReplies.push(
          await onSlashCommand({
            command: { type: "status" },
            text: "/status",
            message: { from_user_id: "u-default" },
          }),
        )
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.equal(slashReplies.length, 1)
  assert.notEqual(slashReplies[0], "/status 处理中")
  assert.equal(slashReplies[0], "命令暂未实现：/status")
})

test("broker-entry slash handler: /reply q1 done 命中 open question 并回写 request 与 notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-handle-1" })
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-handle-1",
    routeKey,
    handle: "q1",
    wechatAccountId: "wx-reply",
    userId: "u-reply",
    createdAt: 1_700_300_000_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-q1",
    kind: "question",
    routeKey,
    handle: "q1",
    wechatAccountId: "wx-reply",
    userId: "u-reply",
    createdAt: 1_700_300_000_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_000_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "q1", text: "done" })

  assert.equal(result, "已回复问题：q1")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, answers: [["done"]] }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "q1" })
  assert.equal(openAfterReply, undefined)

  const replyAgain = await handler({ type: "reply", handle: "q1", text: "done again" })
  assert.equal(replyAgain, "未找到待回复问题：q1")

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: /reply 只有 bridge RPC 返回 ok:true 才写 answered + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-rpc-success`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-rpc-success-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-rpc-success-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-rpc-success-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-rpc-success-state-paths`)

  const sentCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-rpc-success-1", scopeKey: "instance-rpc-q1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-rpc-success-1",
    routeKey,
    handle: "qrpc1",
    scopeKey: "instance-rpc-q1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_000,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-rpc-success-1",
    kind: "question",
    routeKey,
    handle: "qrpc1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_010,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_020,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyQuestionRpc: async (input) => {
      sentCalls.push(input)
      return { mutationId: input.mutationId, ok: true }
    },
  })

  const result = await handler({ type: "reply", handle: "qrpc1", text: "done" })
  assert.equal(result, "已回复问题：qrpc1")
  assert.equal(sentCalls.length, 1)
  assert.equal(sentCalls[0].instanceID, "instance-rpc-q1")
  assert.equal(sentCalls[0].requestID, "q-reply-rpc-success-1")
  assert.deepEqual(sentCalls[0].answers, [["done"]])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrpc1" })
  assert.equal(openAfterReply, undefined)
  const stored = await requestStore.findRequestByRouteKey({ kind: "question", routeKey })
  assert.equal(stored?.status, "answered")
  const resolvedRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
})

test("broker-entry slash handler: /reply 在 bridge RPC 返回 ok:false 时保持 open + pending", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-rpc-failed`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-rpc-failed-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-rpc-failed-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-rpc-failed-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-rpc-failed-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-rpc-failed-1", scopeKey: "instance-rpc-q2" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-rpc-failed-1",
    routeKey,
    handle: "qrpcfail1",
    scopeKey: "instance-rpc-q2",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_100,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-rpc-failed-1",
    kind: "question",
    routeKey,
    handle: "qrpcfail1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_110,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_120,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyQuestionRpc: async (input) => ({ mutationId: input.mutationId, ok: false, errorMessage: "bridge-rpc-failed" }),
  })

  const result = await handler({ type: "reply", handle: "qrpcfail1", text: "done" })
  assert.equal(result, "回复问题失败：bridge-rpc-failed")
  const stillOpen = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrpcfail1" })
  assert.equal(stillOpen?.status, "open")
  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingAfterFailure = JSON.parse(pendingRaw)
  assert.equal(pendingAfterFailure.status, "sent")
})

test("broker-entry slash handler: /reply 在 bridge RPC timeout 时保持 open + sent notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-rpc-timeout`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-rpc-timeout-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-rpc-timeout-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-rpc-timeout-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-rpc-timeout-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-rpc-timeout-1", scopeKey: "instance-rpc-q3" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-rpc-timeout-1",
    routeKey,
    handle: "qrpctimeout1",
    scopeKey: "instance-rpc-q3",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_200,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-rpc-timeout-1",
    kind: "question",
    routeKey,
    handle: "qrpctimeout1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_210,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_220,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyQuestionRpc: async () => {
      throw new Error("replyQuestion timeout: m-timeout")
    },
  })

  const result = await handler({ type: "reply", handle: "qrpctimeout1", text: "done" })
  assert.match(result, /回复问题失败/)
  const stillOpen = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrpctimeout1" })
  assert.equal(stillOpen?.status, "open")
  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingAfterTimeout = JSON.parse(pendingRaw)
  assert.equal(pendingAfterTimeout.status, "sent")
})

test("broker-entry slash handler: /reply 文本题保持兼容并回写自由文本 answers", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-text-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-text-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-text-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-text-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-text-1",
    routeKey,
    handle: "qtext1",
    wechatAccountId: "wx-reply-text",
    userId: "u-reply-text",
    createdAt: 1_700_600_200_000,
    prompt: {
      title: "补充说明",
      mode: "text",
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qtext1", text: "hello world" })
  assert.equal(result, "已回复问题：qtext1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-text-1", answers: [["hello world"]] }])
})

test("broker-entry slash handler: /reply 单选题把编号转成结构化答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-single-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-single-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-single-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-single-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-single-1",
    routeKey,
    handle: "qsingle1",
    wechatAccountId: "wx-reply-single",
    userId: "u-reply-single",
    createdAt: 1_700_600_210_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qsingle1", text: "2" })
  assert.equal(result, "已回复问题：qsingle1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-single-1", answers: [["production"]] }])
})

test("broker-entry slash handler: /reply 多选题把逗号编号转成结构化答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-multiple-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-multiple-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-multiple-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-multiple-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-multiple-1",
    routeKey,
    handle: "qmulti1",
    wechatAccountId: "wx-reply-multi",
    userId: "u-reply-multi",
    createdAt: 1_700_600_220_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti1", text: "1,3" })
  assert.equal(result, "已回复问题：qmulti1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-1", answers: [["staging", "preview"]] }])
})

test("broker-entry slash handler: /reply 非法编号会返回稳定中文提示", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-invalid-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-invalid-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-invalid-mode-request-store`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-invalid-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-invalid-1",
    routeKey,
    handle: "qinvalid1",
    wechatAccountId: "wx-reply-invalid",
    userId: "u-reply-invalid",
    createdAt: 1_700_600_230_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qinvalid1", text: "3" })
  assert.match(result, /选项编号超出范围|无效选项|编号/)
})

test("broker-entry slash handler: /reply 单选题且允许自定义时，自由文本走最终 answers 语义", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-single-custom-text`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-single-custom-text-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-single-custom-text-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-single-custom-text-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-single-custom-text-1",
    routeKey,
    handle: "qsinglecustom1",
    wechatAccountId: "wx-reply-single-custom",
    userId: "u-reply-single-custom",
    createdAt: 1_700_600_240_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qsinglecustom1", text: "请直接发到 preview 环境" })
  assert.equal(result, "已回复问题：qsinglecustom1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-single-custom-text-1", answers: [["请直接发到 preview 环境"]] }])
})

test("broker-entry slash handler: /reply 单选题且允许自定义时，编号输入仍走结构化选项答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-single-custom-number`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-single-custom-number-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-single-custom-number-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-single-custom-number-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-single-custom-number-1",
    routeKey,
    handle: "qsinglecustom2",
    wechatAccountId: "wx-reply-single-custom",
    userId: "u-reply-single-custom",
    createdAt: 1_700_600_250_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qsinglecustom2", text: "2" })
  assert.equal(result, "已回复问题：qsinglecustom2")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-single-custom-number-1", answers: [["production"]] }])
})

test("broker-entry slash handler: /reply 多选题且允许自定义时，自由文本走最终 answers 语义", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-multiple-custom-text`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-multiple-custom-text-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-multiple-custom-text-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-multiple-custom-text-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-multiple-custom-text-1",
    routeKey,
    handle: "qmulticustom1",
    wechatAccountId: "wx-reply-multi-custom",
    userId: "u-reply-multi-custom",
    createdAt: 1_700_600_260_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qmulticustom1", text: "请额外通知 canary 环境" })
  assert.equal(result, "已回复问题：qmulticustom1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-custom-text-1", answers: [["请额外通知 canary 环境"]] }])
})

test("broker-entry slash handler: /reply 多选题且允许自定义时，编号输入仍走结构化多值答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-multiple-custom-number`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-multiple-custom-number-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-multiple-custom-number-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-multiple-custom-number-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-multiple-custom-number-1",
    routeKey,
    handle: "qmulticustom2",
    wechatAccountId: "wx-reply-multi-custom",
    userId: "u-reply-multi-custom",
    createdAt: 1_700_600_270_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qmulticustom2", text: "1,3" })
  assert.equal(result, "已回复问题：qmulticustom2")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-custom-number-1", answers: [["staging", "preview"]] }])
})

test("broker-entry slash handler: /reply 多选题且允许自定义时，带空格编号输入仍走结构化多值答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-multiple-custom-number-spaced`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-multiple-custom-number-spaced-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-multiple-custom-number-spaced-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-multiple-custom-number-spaced-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-multiple-custom-number-spaced-1",
    routeKey,
    handle: "qmulticustom2space",
    wechatAccountId: "wx-reply-multi-custom-space",
    userId: "u-reply-multi-custom-space",
    createdAt: 1_700_600_271_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qmulticustom2space", text: "1, 3" })
  assert.equal(result, "已回复问题：qmulticustom2space")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-custom-number-spaced-1", answers: [["staging", "preview"]] }])
})

async function createQuestionReplyFixture({
  reloadTag,
  requestID,
  handle: requestHandle,
  createdAt,
  prompt,
}) {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-${reloadTag}`)
  const handleModule = await import(`../dist/wechat/handle.js?reload=${Date.now()}-${reloadTag}-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-${reloadTag}-request-store`)

  const replyCalls = []
  const routeKey = handleModule.createRouteKey({ kind: "question", requestID })
  await requestStore.upsertRequest({
    kind: "question",
    requestID,
    routeKey,
    handle: requestHandle,
    wechatAccountId: `wx-${reloadTag}`,
    userId: `u-${reloadTag}`,
    createdAt,
    prompt,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  return { handler, replyCalls }
}

test("broker-entry slash handler: multiple + custom=true 支持 1,3; 其他：... mixed reply", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-mixed-mode",
    requestID: "q-reply-mixed-1",
    handle: "qmulti3",
    createdAt: 1_700_600_280_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti3", text: "1,3; 其他：先灰度再全量" })

  assert.equal(result, "已回复问题：qmulti3")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-mixed-1", answers: [["staging", "preview", "先灰度再全量"]] }])
})

test("broker-entry slash handler: multiple + custom=true 支持带空格的编号列表 mixed reply", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-mixed-mode-spaced-list",
    requestID: "q-reply-mixed-spaced-1",
    handle: "qmulti7",
    createdAt: 1_700_600_280_500,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti7", text: "1, 3; 其他：先灰度" })

  assert.equal(result, "已回复问题：qmulti7")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-mixed-spaced-1", answers: [["staging", "preview", "先灰度"]] }])
})

test("broker-entry slash handler: mixed reply 只认第一个分号，其余分号保留在自定义文本里", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-mixed-first-separator",
    requestID: "q-reply-mixed-2",
    handle: "qmulti4",
    createdAt: 1_700_600_281_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti4", text: "1,3; 其他：先灰度; 再全量" })

  assert.equal(result, "已回复问题：qmulti4")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-mixed-2", answers: [["staging", "preview", "先灰度; 再全量"]] }])
})

test("broker-entry slash handler: 非 multiple + custom=true 题型遇到 mixed 形态输入时返回稳定中文提示", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-single-custom-mixed-invalid",
    requestID: "q-reply-single-custom-mixed-invalid-1",
    handle: "qsinglecustom3",
    createdAt: 1_700_600_282_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qsinglecustom3", text: "1; 其他：补充说明" })

  assert.match(result, /当前题型不支持.*编号 \+ 自定义补充/)
  assert.deepEqual(replyCalls, [])
})

test("broker-entry slash handler: 非 multiple + custom=true 题型遇到带空格 mixed 形态输入时返回稳定中文提示", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-single-custom-mixed-invalid-spaced-list",
    requestID: "q-reply-single-custom-mixed-invalid-2",
    handle: "qsinglecustom4",
    createdAt: 1_700_600_282_500,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qsinglecustom4", text: "1, 3; 其他：先灰度" })

  assert.match(result, /当前题型不支持.*编号 \+ 自定义补充/)
  assert.deepEqual(replyCalls, [])
})

test("broker-entry slash handler: 允许纯自定义的题目收到非 mixed 形态分号文本时仍按纯自定义处理", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-multiple-custom-semicolon-text",
    requestID: "q-reply-multiple-custom-text-2",
    handle: "qmulticustom3",
    createdAt: 1_700_600_283_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulticustom3", text: "先灰度; 再全量" })

  assert.equal(result, "已回复问题：qmulticustom3")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-custom-text-2", answers: [["先灰度; 再全量"]] }])
})

test("broker-entry slash handler: mixed reply 去掉可选前缀后若为空则返回稳定中文提示", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-mixed-empty-custom",
    requestID: "q-reply-mixed-empty-custom-1",
    handle: "qmulti5",
    createdAt: 1_700_600_284_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti5", text: "1,3; 其他：" })

  assert.match(result, /混合回复格式无效/)
  assert.deepEqual(replyCalls, [])
})

test("broker-entry slash handler: mixed reply 左半段复用多选编号校验", async () => {
  const { handler, replyCalls } = await createQuestionReplyFixture({
    reloadTag: "reply-mixed-duplicate-option",
    requestID: "q-reply-mixed-duplicate-option-1",
    handle: "qmulti6",
    createdAt: 1_700_600_285_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti6", text: "1,1; 其他：重复编号" })

  assert.match(result, /选项编号不能重复/)
  assert.deepEqual(replyCalls, [])
})

test("broker-entry slash handler: /allow p1 always safe 命中 open permission 并回写 answered + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-allow-handle-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-allow-handle-1",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow",
    userId: "u-allow",
    createdAt: 1_700_300_100_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-p1",
    kind: "permission",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow",
    userId: "u-allow",
    createdAt: 1_700_300_100_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_100_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "p1", reply: "always", message: "safe" })

  assert.equal(result, "已处理权限请求：p1 (always)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "always", message: "safe" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
  assert.equal(openAfterReply, undefined)

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: /allow p1 reject no 会回写 rejected + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-reject-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-reject-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-reject-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-reject-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-reject-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-allow-reject-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-allow-reject-1",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow-reject",
    userId: "u-allow-reject",
    createdAt: 1_700_300_200_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-reject-p1",
    kind: "permission",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow-reject",
    userId: "u-allow-reject",
    createdAt: 1_700_300_200_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_200_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "p1", reply: "reject", message: "no" })

  assert.equal(result, "已处理权限请求：p1 (reject)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "reject", message: "no" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
  assert.equal(openAfterReply, undefined)

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: /allow 只有 bridge RPC 返回 ok:true 时才写 answered + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-rpc-success`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-rpc-success-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-rpc-success-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-rpc-success-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-rpc-success-state-paths`)

  const sentCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-rpc-success-1", scopeKey: "instance-rpc-p1" })
  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-rpc-success-1",
    routeKey,
    handle: "prpc1",
    scopeKey: "instance-rpc-p1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_300,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-rpc-success-1",
    kind: "permission",
    routeKey,
    handle: "prpc1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_310,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_320,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => {
      sentCalls.push(input)
      return { mutationId: input.mutationId, ok: true }
    },
  })

  const result = await handler({ type: "allow", handle: "prpc1", reply: "always", message: "safe" })
  assert.equal(result, "已处理权限请求：prpc1 (always)")
  assert.equal(sentCalls.length, 1)
  assert.equal(sentCalls[0].instanceID, "instance-rpc-p1")
  assert.equal(sentCalls[0].requestID, "p-rpc-success-1")
  const stored = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey })
  assert.equal(stored?.status, "answered")
  const resolvedRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
})

test("broker-entry slash handler: /allow 在 reject 成功时写 rejected + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-rpc-reject-success`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-rpc-reject-success-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-rpc-reject-success-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-rpc-reject-success-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-rpc-reject-success-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-rpc-reject-1", scopeKey: "instance-rpc-p2" })
  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-rpc-reject-1",
    routeKey,
    handle: "preject1",
    scopeKey: "instance-rpc-p2",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_400,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-rpc-reject-1",
    kind: "permission",
    routeKey,
    handle: "preject1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_410,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_420,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => ({ mutationId: input.mutationId, ok: true }),
  })

  const result = await handler({ type: "allow", handle: "preject1", reply: "reject", message: "no" })
  assert.equal(result, "已处理权限请求：preject1 (reject)")
  const stored = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey })
  assert.equal(stored?.status, "rejected")
  const resolvedRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
})

test("broker-entry slash handler: /allow 在 bridge RPC 返回 ok:false 时保持 open + sent notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-rpc-failed`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-rpc-failed-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-rpc-failed-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-rpc-failed-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-rpc-failed-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-rpc-failed-1", scopeKey: "instance-rpc-p3" })
  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-rpc-failed-1",
    routeKey,
    handle: "prpcfail1",
    scopeKey: "instance-rpc-p3",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_500,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-rpc-failed-1",
    kind: "permission",
    routeKey,
    handle: "prpcfail1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_510,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_520,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => ({ mutationId: input.mutationId, ok: false, errorMessage: "permission-rpc-failed" }),
  })

  const result = await handler({ type: "allow", handle: "prpcfail1", reply: "reject", message: "no" })
  assert.equal(result, "处理权限请求失败：permission-rpc-failed")
  const stillOpen = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "prpcfail1" })
  assert.equal(stillOpen?.status, "open")
  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingAfterFailure = JSON.parse(pendingRaw)
  assert.equal(pendingAfterFailure.status, "sent")
})

test("broker-entry slash handler: /allow 在 bridge RPC timeout 时保持 open + sent notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-rpc-timeout`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-rpc-timeout-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-rpc-timeout-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-rpc-timeout-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-rpc-timeout-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-rpc-timeout-1", scopeKey: "instance-rpc-p4" })
  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-rpc-timeout-1",
    routeKey,
    handle: "prpctimeout1",
    scopeKey: "instance-rpc-p4",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_600,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-rpc-timeout-1",
    kind: "permission",
    routeKey,
    handle: "prpctimeout1",
    wechatAccountId: "wx-rpc",
    userId: "u-rpc",
    createdAt: 1_700_950_000_610,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: pending.idempotencyKey,
    sentAt: 1_700_950_000_620,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async () => {
      throw new Error("replyPermission timeout: m-timeout")
    },
  })

  const result = await handler({ type: "allow", handle: "prpctimeout1", reply: "always", message: "safe" })
  assert.match(result, /处理权限请求失败/)
  const stillOpen = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "prpctimeout1" })
  assert.equal(stillOpen?.status, "open")
  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingAfterTimeout = JSON.parse(pendingRaw)
  assert.equal(pendingAfterTimeout.status, "sent")
})

async function createSentPermissionFixture({
  handleModule,
  requestStore,
  notificationStore,
  requestID,
  handle,
  scopeKey,
  wechatAccountId,
  userId,
  createdAt,
  idempotencyKey,
}) {
  const routeKey = handleModule.createRouteKey({ kind: "permission", requestID, scopeKey })
  const request = await requestStore.upsertRequest({
    kind: "permission",
    requestID,
    routeKey,
    handle,
    scopeKey,
    wechatAccountId,
    userId,
    createdAt,
  })
  const notification = await notificationStore.upsertNotification({
    idempotencyKey,
    kind: "permission",
    routeKey,
    handle,
    wechatAccountId,
    userId,
    createdAt: createdAt + 10,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: notification.idempotencyKey,
    sentAt: createdAt + 20,
  })
  return { request, notification, routeKey }
}

async function readStoredNotificationRecord(statePaths, idempotencyKey) {
  return JSON.parse(await readFile(statePaths.notificationStatePath(idempotencyKey), "utf8"))
}

test("broker-entry slash handler: 同 session 多个 open permission 时 /allow 只终结目标 handle 的 request 与 notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-multi-target-only`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-multi-target-only-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-multi-target-only-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-multi-target-only-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-multi-target-only-state-paths`)

  const scopeKey = "instance-allow-multi-target-only"
  const target = await createSentPermissionFixture({
    handleModule: handle,
    requestStore,
    notificationStore,
    requestID: "p-allow-multi-target-only-1",
    handle: "pmultitarget1",
    scopeKey,
    wechatAccountId: "wx-allow-multi-target-only",
    userId: "u-allow-multi-target-only",
    createdAt: 1_700_960_000_100,
    idempotencyKey: "notif-allow-multi-target-only-1",
  })
  const other = await createSentPermissionFixture({
    handleModule: handle,
    requestStore,
    notificationStore,
    requestID: "p-allow-multi-target-only-2",
    handle: "pmultitarget2",
    scopeKey,
    wechatAccountId: "wx-allow-multi-target-only",
    userId: "u-allow-multi-target-only",
    createdAt: 1_700_960_000_200,
    idempotencyKey: "notif-allow-multi-target-only-2",
  })

  const rpcCalls = []
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => {
      rpcCalls.push(input)
      return { mutationId: input.mutationId, ok: true }
    },
  })

  const result = await handler({ type: "allow", handle: "pmultitarget1", reply: "once", message: "approved" })

  assert.equal(result, "已处理权限请求：pmultitarget1 (once)")
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].requestID, target.request.requestID)
  assert.equal(rpcCalls[0].instanceID, scopeKey)

  const targetRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: target.routeKey })
  const otherRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: other.routeKey })
  assert.equal(targetRequest?.status, "answered")
  assert.equal(otherRequest?.status, "open")

  const targetNotification = await readStoredNotificationRecord(statePaths, target.notification.idempotencyKey)
  const otherNotification = await readStoredNotificationRecord(statePaths, other.notification.idempotencyKey)
  assert.equal(targetNotification.status, "resolved")
  assert.equal(typeof targetNotification.resolvedAt, "number")
  assert.equal(otherNotification.status, "sent")
  assert.equal(otherNotification.resolvedAt, undefined)
})

test("broker-entry slash handler: /allow 在 bridge RPC ok:false 或抛错时，目标与非目标 request/notification 都保持原样", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-multi-failure-guard`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-multi-failure-guard-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-multi-failure-guard-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-multi-failure-guard-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-multi-failure-guard-state-paths`)

  const scenarios = [
    {
      name: "rpc-ok-false",
      expectedMessage: /^处理权限请求失败：permission-rpc-failed$/,
      sendReplyPermissionRpc: async (input) => ({ mutationId: input.mutationId, ok: false, errorMessage: "permission-rpc-failed" }),
    },
    {
      name: "rpc-throws",
      expectedMessage: /^处理权限请求失败：replyPermission timeout: m-timeout$/,
      sendReplyPermissionRpc: async () => {
        throw new Error("replyPermission timeout: m-timeout")
      },
    },
  ]

  for (const [index, scenario] of scenarios.entries()) {
    const scopeKey = `instance-allow-multi-failure-${scenario.name}`
    const targetHandle = `pmultifailtarget${index + 1}`
    const otherHandle = `pmultifailother${index + 1}`
    const target = await createSentPermissionFixture({
      handleModule: handle,
      requestStore,
      notificationStore,
      requestID: `p-allow-multi-failure-target-${scenario.name}`,
      handle: targetHandle,
      scopeKey,
      wechatAccountId: "wx-allow-multi-failure",
      userId: "u-allow-multi-failure",
      createdAt: 1_700_960_000_300 + index * 100,
      idempotencyKey: `notif-allow-multi-failure-target-${scenario.name}`,
    })
    const other = await createSentPermissionFixture({
      handleModule: handle,
      requestStore,
      notificationStore,
      requestID: `p-allow-multi-failure-other-${scenario.name}`,
      handle: otherHandle,
      scopeKey,
      wechatAccountId: "wx-allow-multi-failure",
      userId: "u-allow-multi-failure",
      createdAt: 1_700_960_000_350 + index * 100,
      idempotencyKey: `notif-allow-multi-failure-other-${scenario.name}`,
    })

    const rpcCalls = []
    const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
      handleStatusCommand: async () => "status reply",
      sendReplyPermissionRpc: async (input) => {
        rpcCalls.push(input)
        return scenario.sendReplyPermissionRpc(input)
      },
    })

    const result = await handler({ type: "allow", handle: targetHandle, reply: "reject", message: "deny" })

    assert.match(result, scenario.expectedMessage)
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].requestID, target.request.requestID)
    assert.equal(rpcCalls[0].instanceID, scopeKey)

    const targetRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: target.routeKey })
    const otherRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: other.routeKey })
    assert.equal(targetRequest?.status, "open")
    assert.equal(otherRequest?.status, "open")

    const targetNotification = await readStoredNotificationRecord(statePaths, target.notification.idempotencyKey)
    const otherNotification = await readStoredNotificationRecord(statePaths, other.notification.idempotencyKey)
    assert.equal(targetNotification.status, "sent")
    assert.equal(targetNotification.resolvedAt, undefined)
    assert.equal(otherNotification.status, "sent")
    assert.equal(otherNotification.resolvedAt, undefined)
  }
})

test("broker-entry slash handler: /allow 在远端 success 后、本地 finalize 前失败时不终结任何 request 或 notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-finalize-failure-gate`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-finalize-failure-gate-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-finalize-failure-gate-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-finalize-failure-gate-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-finalize-failure-gate-state-paths`)

  const scopeKey = "instance-allow-finalize-failure-gate"
  const target = await createSentPermissionFixture({
    handleModule: handle,
    requestStore,
    notificationStore,
    requestID: "p-allow-finalize-failure-gate-target",
    handle: "pfinalizefail1",
    scopeKey,
    wechatAccountId: "wx-allow-finalize-failure",
    userId: "u-allow-finalize-failure",
    createdAt: 1_700_960_000_500,
    idempotencyKey: "notif-allow-finalize-failure-gate-target",
  })
  const other = await createSentPermissionFixture({
    handleModule: handle,
    requestStore,
    notificationStore,
    requestID: "p-allow-finalize-failure-gate-other",
    handle: "pfinalizefail2",
    scopeKey,
    wechatAccountId: "wx-allow-finalize-failure",
    userId: "u-allow-finalize-failure",
    createdAt: 1_700_960_000_600,
    idempotencyKey: "notif-allow-finalize-failure-gate-other",
  })

  const rpcCalls = []
  const hookCalls = []
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    sendReplyPermissionRpc: async (input) => {
      rpcCalls.push(input)
      return { mutationId: input.mutationId, ok: true }
    },
    permissionMutationTestHooks: {
      beforeFinalizePermission: async (request) => {
        hookCalls.push(request)
        throw new Error("forced permission finalize failure")
      },
    },
  })

  await assert.rejects(
    () => handler({ type: "allow", handle: "pfinalizefail1", reply: "always", message: "safe" }),
    /forced permission finalize failure/,
  )

  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].requestID, target.request.requestID)
  assert.deepEqual(hookCalls, [{ handle: "pfinalizefail1", routeKey: target.routeKey }])

  const targetRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: target.routeKey })
  const otherRequest = await requestStore.findRequestByRouteKey({ kind: "permission", routeKey: other.routeKey })
  assert.equal(targetRequest?.status, "open")
  assert.equal(otherRequest?.status, "open")

  const targetNotification = await readStoredNotificationRecord(statePaths, target.notification.idempotencyKey)
  const otherNotification = await readStoredNotificationRecord(statePaths, other.notification.idempotencyKey)
  assert.equal(targetNotification.status, "sent")
  assert.equal(targetNotification.resolvedAt, undefined)
  assert.equal(otherNotification.status, "sent")
  assert.equal(otherNotification.resolvedAt, undefined)
})

test("broker-entry runtime wiring: 不再通过 localhost:4096 创建 reply client", async () => {
  const source = await readFile(new URL("../src/wechat/broker-entry.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /localhost:4096/)
})

test("broker-entry slash handler: handle 不存在或非法时返回稳定中文提示", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-not-found-handler`)

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    },
  })

  assert.equal(
    await handler({ type: "reply", handle: "q404", text: "done" }),
    "未找到待回复问题：q404",
  )
  assert.equal(
    await handler({ type: "reply", handle: "req-raw-001", text: "done" }),
    "未找到待回复问题：req-raw-001",
  )
  assert.equal(
    await handler({ type: "allow", handle: "p404", reply: "once", message: "ok" }),
    "未找到待处理权限请求：p404",
  )
  assert.equal(
    await handler({ type: "allow", handle: "request-raw-001", reply: "always", message: "ok" }),
    "未找到待处理权限请求：request-raw-001",
  )
})

test("broker-entry slash handler: /recover 即使旧 handle 空闲也会分配 fresh handle 与 fresh route", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-handler`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-handler-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-handler-request-store`)

  const recoverableRouteKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-handler-1",
    scopeKey: "instance-recover-handler-a",
  })
  const nonRecoverableRouteKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-handler-2",
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-handler-1",
    routeKey: recoverableRouteKey,
    handle: "q1",
    scopeKey: "instance-recover-handler-a",
    wechatAccountId: "wx-recover-handler-a",
    userId: "u-recover-handler-a",
    createdAt: 1_700_700_000_000,
    prompt: {
      title: "恢复问题标题",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: recoverableRouteKey,
    expiredAt: 1_700_700_001_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: recoverableRouteKey,
    requestID: "q-recover-handler-1",
    handle: "q1",
    scopeKey: "instance-recover-handler-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_000_000,
    finalizedAt: 1_700_700_001_000,
    wechatAccountId: "wx-recover-handler-a",
    userId: "u-recover-handler-a",
    instanceID: "instance-recover-handler-a",
  })

  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: nonRecoverableRouteKey,
    requestID: "q-recover-handler-2",
    handle: "qrecoverhandler2",
    finalStatus: "cleaned",
    reason: "runtimeCleanup",
    createdAt: 1_700_700_010_000,
    finalizedAt: 1_700_700_011_000,
    wechatAccountId: "wx-recover-handler-b",
    userId: "u-recover-handler-b",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    },
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverhandler2" }),
    "未找到可恢复的请求：qrecoverhandler2",
  )

  const recoveredResult = await handler({ type: "recover", handle: "q1" })
  assert.equal(recoveredResult, "已恢复请求：q2")

  const reopened = await requestStore.findOpenRequestByHandle({
    kind: "question",
    handle: "q2",
  })
  assert.equal(reopened?.requestID, "q-recover-handler-1")
  assert.equal(reopened?.handle, "q2")
  assert.notEqual(reopened?.handle, "q1")
  assert.equal(reopened?.routeKey !== recoverableRouteKey, true)
  assert.deepEqual(reopened?.prompt, {
    title: "恢复问题标题",
    mode: "text",
  })

  const original = await requestStore.findRequestByRouteKey({
    kind: "question",
    routeKey: recoverableRouteKey,
  })
  assert.equal(original, undefined)

  const recoveredDeadLetter = await deadLetterStore.readDeadLetter("question", recoverableRouteKey)
  assert.equal(recoveredDeadLetter?.recoveryStatus, "recovered")
  assert.equal(typeof recoveredDeadLetter?.recoveredAt, "number")
  assert.equal(recoveredDeadLetter?.recoveryErrorCode, undefined)
  assert.equal(recoveredDeadLetter?.recoveryErrorMessage, undefined)

  assert.equal(
    await handler({ type: "recover", handle: "q1" }),
    "未找到可恢复的请求：q1",
  )
})

test("broker-entry slash handler: /recover 会把恢复作为单一 recoveryMutation 提交", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-mutation-queue`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-mutation-queue-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-mutation-queue-handle`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-recover-mutation-queue-notification-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-mutation-queue-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-recover-mutation-queue-state-paths`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-mutation-queue-1",
    scopeKey: "instance-recover-mutation-queue-a",
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-mutation-queue-1",
    routeKey,
    handle: "q1",
    scopeKey: "instance-recover-mutation-queue-a",
    wechatAccountId: "wx-recover-mutation-queue",
    userId: "u-recover-mutation-queue",
    createdAt: 1_700_800_020_000,
    prompt: {
      title: "恢复经队列提交",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_800_020_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-mutation-queue-1",
    handle: "q1",
    scopeKey: "instance-recover-mutation-queue-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_020_000,
    finalizedAt: 1_700_800_020_100,
    wechatAccountId: "wx-recover-mutation-queue",
    userId: "u-recover-mutation-queue",
    instanceID: "instance-recover-mutation-queue-a",
  })
  await notificationStore.upsertNotification({
    idempotencyKey: "notif-recover-mutation-queue-old-pending",
    kind: "question",
    routeKey,
    handle: "q1",
    wechatAccountId: "wx-recover-mutation-queue",
    userId: "u-recover-mutation-queue",
    createdAt: 1_700_800_020_200,
  })

  const enqueuedMutationTypes = []
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    mutationQueue: {
      enqueue: async (mutationType, task) => {
        enqueuedMutationTypes.push(mutationType)
        return task()
      },
    },
  })

  const recoveredResult = await handler({ type: "recover", handle: "q1" })

  assert.match(recoveredResult, /^已恢复请求：q\d+$/)
  assert.deepEqual(enqueuedMutationTypes, ["recoveryMutation"])

  const notificationRaw = await readFile(statePaths.notificationStatePath("notif-recover-mutation-queue-old-pending"), "utf8")
  const notification = JSON.parse(notificationRaw)
  assert.equal(notification.status, "suppressed")
})

test("broker-entry slash handler: /recover 入队等待期间 fresh handle/route 被占用时会在队列内重新分配", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-refresh-freshness`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-refresh-freshness-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-refresh-freshness-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-refresh-freshness-request-store`)

  const fixedNow = 1_700_800_025_000
  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-refresh-freshness-1",
    scopeKey: "instance-recover-refresh-freshness-a",
  })
  const firstPreparedRouteKey = handle.createRouteKey({
    kind: "question",
    requestID: `q-recover-refresh-freshness-1-recover-${fixedNow}-1`,
    scopeKey: "instance-recover-refresh-freshness-a",
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-refresh-freshness-1",
    routeKey,
    handle: "q1",
    scopeKey: "instance-recover-refresh-freshness-a",
    wechatAccountId: "wx-recover-refresh-freshness",
    userId: "u-recover-refresh-freshness",
    createdAt: 1_700_800_024_000,
    prompt: {
      title: "恢复 freshness 竞争",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_800_024_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-refresh-freshness-1",
    handle: "q1",
    scopeKey: "instance-recover-refresh-freshness-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_024_000,
    finalizedAt: 1_700_800_024_100,
    wechatAccountId: "wx-recover-refresh-freshness",
    userId: "u-recover-refresh-freshness",
    instanceID: "instance-recover-refresh-freshness-a",
  })

  const originalDateNow = Date.now
  Date.now = () => fixedNow

  let enqueued = false
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    mutationQueue: {
      enqueue: async (_mutationType, task) => {
        if (!enqueued) {
          enqueued = true
          await requestStore.upsertRequest({
            kind: "question",
            requestID: "q-recover-refresh-freshness-racer",
            routeKey: firstPreparedRouteKey,
            handle: "qrefreshrouteoccupier1",
            scopeKey: "instance-recover-refresh-freshness-racer",
            wechatAccountId: "wx-recover-refresh-freshness",
            userId: "u-recover-refresh-freshness",
            createdAt: fixedNow,
            prompt: {
              title: "先占住预测 fresh 值",
              mode: "text",
            },
          })
        }
        return task()
      },
    },
  })

  try {
    const recoveredResult = await handler({ type: "recover", handle: "q1" })
    assert.match(recoveredResult, /^已恢复请求：q\d+$/)
    const recoveredHandle = recoveredResult.slice("已恢复请求：".length)

    const occupied = await requestStore.findRequestByRouteKey({
      kind: "question",
      routeKey: firstPreparedRouteKey,
    })
    assert.equal(occupied?.requestID, "q-recover-refresh-freshness-racer")

    const recovered = await requestStore.findOpenRequestByHandle({
      kind: "question",
      handle: recoveredHandle,
    })
    assert.notEqual(recovered?.routeKey, firstPreparedRouteKey)
  } finally {
    Date.now = originalDateNow
  }
})

test("recover mutation: commit 写入 fresh request 后失败时会清理 fresh route 并写 failed metadata", async () => {
  const brokerMutationQueue = await import(`../dist/wechat/broker-mutation-queue.js?reload=${Date.now()}-recover-partial-write-cleanup`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-partial-write-cleanup-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-partial-write-cleanup-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-partial-write-cleanup-request-store`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-partial-write-cleanup-1",
    scopeKey: "instance-recover-partial-write-cleanup-a",
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-partial-write-cleanup-1",
    routeKey,
    handle: "qrecoverpartialwrite1",
    scopeKey: "instance-recover-partial-write-cleanup-a",
    wechatAccountId: "wx-recover-partial-write-cleanup",
    userId: "u-recover-partial-write-cleanup",
    createdAt: 1_700_800_026_000,
    prompt: {
      title: "恢复部分写入清理",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_800_026_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-partial-write-cleanup-1",
    handle: "qrecoverpartialwrite1",
    scopeKey: "instance-recover-partial-write-cleanup-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_026_000,
    finalizedAt: 1_700_800_026_100,
    wechatAccountId: "wx-recover-partial-write-cleanup",
    userId: "u-recover-partial-write-cleanup",
    instanceID: "instance-recover-partial-write-cleanup-a",
  })

  const originalRequest = await requestStore.findRequestByRouteKey({ kind: "question", routeKey })
  assert.equal(originalRequest?.status, "expired")

  const mutation = {
    type: "recoveryMutation",
    requestedHandle: "qrecoverpartialwrite1",
    deadLetter: await deadLetterStore.readDeadLetter("question", routeKey),
    originalRequest,
    pendingNotifications: [],
    recoveryChainHandles: ["qrecoverpartialwrite1"],
  }

  const result = await brokerMutationQueue.executeRecoveryMutation(mutation, {
    revalidate: async () => undefined,
    prepareFreshRecovery: async (_mutation, recoveredAt) => requestStore.prepareRecoveryRequestReopen({
      kind: "question",
      routeKey,
      recoveredAt,
      bannedHandles: ["qrecoverpartialwrite1"],
    }),
    suppressPendingNotifications: async () => {},
    commitPreparedRecovery: async (preparedRecovery) => {
      await requestStore.upsertRequest({
        ...preparedRecovery.originalRequest,
        routeKey: preparedRecovery.nextRouteKey,
        handle: preparedRecovery.nextHandle,
        status: "open",
        answeredAt: undefined,
        rejectedAt: undefined,
        expiredAt: undefined,
        cleanedAt: undefined,
      })
      throw new Error("forced commit after write failure")
    },
    rollbackPreparedRecovery: async (preparedRecovery) => requestStore.rollbackPreparedRecoveryRequestReopen(preparedRecovery),
    markRecovered: async () => {},
    markFailed: async ({ kind, routeKey: failedRouteKey, failure }) => {
      await deadLetterStore.markDeadLetterRecoveryFailed({
        kind,
        routeKey: failedRouteKey,
        recoveryErrorCode: failure.recoveryErrorCode,
        recoveryErrorMessage: failure.recoveryErrorMessage,
      })
    },
    mapFailure: () => ({
      recoveryErrorCode: "recoveryFailed",
      recoveryErrorMessage: "无法恢复请求：qrecoverpartialwrite1",
    }),
  })

  assert.deepEqual(result, {
    ok: false,
    message: "无法恢复请求：qrecoverpartialwrite1",
  })

  const activeRequests = await requestStore.listActiveRequests()
  assert.equal(
    activeRequests.some((item) => item.requestID === "q-recover-partial-write-cleanup-1" && item.status === "open"),
    false,
  )

  const original = await requestStore.findRequestByRouteKey({ kind: "question", routeKey })
  assert.equal(original?.status, "expired")
  assert.equal(original?.handle, "qrecoverpartialwrite1")

  const recoveredDeadLetter = await deadLetterStore.readDeadLetter("question", routeKey)
  assert.equal(recoveredDeadLetter?.recoveryStatus, "failed")
  assert.equal(recoveredDeadLetter?.recoveryErrorCode, "recoveryFailed")
  assert.equal(recoveredDeadLetter?.recoveryErrorMessage, "无法恢复请求：qrecoverpartialwrite1")
})

test("recover mutation: rollback 失败时仍会尝试写 failed metadata 并暴露 rollback 错误", async () => {
  const brokerMutationQueue = await import(`../dist/wechat/broker-mutation-queue.js?reload=${Date.now()}-recover-rollback-error`)

  const mutation = {
    type: "recoveryMutation",
    requestedHandle: "q1",
    deadLetter: {
      kind: "question",
      routeKey: "question-recover-rollback-error",
      requestID: "q-recover-rollback-error",
      handle: "q1",
      finalStatus: "expired",
      reason: "instanceStale",
      createdAt: 1,
      finalizedAt: 2,
      wechatAccountId: "wx-recover-rollback-error",
      userId: "u-recover-rollback-error",
    },
    originalRequest: {
      kind: "question",
      requestID: "q-recover-rollback-error",
      routeKey: "question-recover-rollback-error",
      handle: "q1",
      wechatAccountId: "wx-recover-rollback-error",
      userId: "u-recover-rollback-error",
      status: "expired",
      createdAt: 1,
    },
    pendingNotifications: [],
    recoveryChainHandles: ["q1"],
  }

  const callOrder = []

  await assert.rejects(
    () => brokerMutationQueue.executeRecoveryMutation(mutation, {
      revalidate: async () => undefined,
      prepareFreshRecovery: async () => ({
        originalRequest: mutation.originalRequest,
        nextHandle: "q2",
        nextRouteKey: "question-recover-rollback-error-fresh",
      }),
      suppressPendingNotifications: async () => {},
      commitPreparedRecovery: async () => ({
        ...mutation.originalRequest,
        handle: "q2",
        routeKey: "question-recover-rollback-error-fresh",
        status: "open",
      }),
      rollbackPreparedRecovery: async () => {
        callOrder.push("rollback")
        throw new Error("rollback failed")
      },
      markRecovered: async () => {},
      markFailed: async () => {
        callOrder.push("markFailed")
      },
      mapFailure: () => ({
        recoveryErrorCode: "recoveryFailed",
        recoveryErrorMessage: "无法恢复请求：q1",
      }),
      testHooks: {
        afterReopenRequest: async () => {
          throw new Error("forced recover failure")
        },
      },
    }),
    /rollback failed/i,
  )

  assert.deepEqual(callOrder, ["rollback", "markFailed"])
})

test("recover mutation: failed metadata 落盘失败时会暴露错误", async () => {
  const brokerMutationQueue = await import(`../dist/wechat/broker-mutation-queue.js?reload=${Date.now()}-recover-failed-metadata-error`)

  const mutation = {
    type: "recoveryMutation",
    requestedHandle: "q1",
    deadLetter: {
      kind: "question",
      routeKey: "question-recover-failed-metadata-error",
      requestID: "q-recover-failed-metadata-error",
      handle: "q1",
      finalStatus: "expired",
      reason: "instanceStale",
      createdAt: 1,
      finalizedAt: 2,
      wechatAccountId: "wx-recover-failed-metadata-error",
      userId: "u-recover-failed-metadata-error",
    },
    originalRequest: {
      kind: "question",
      requestID: "q-recover-failed-metadata-error",
      routeKey: "question-recover-failed-metadata-error",
      handle: "q1",
      wechatAccountId: "wx-recover-failed-metadata-error",
      userId: "u-recover-failed-metadata-error",
      status: "expired",
      createdAt: 1,
    },
    pendingNotifications: [],
    recoveryChainHandles: ["q1"],
  }

  const callOrder = []

  await assert.rejects(
    () => brokerMutationQueue.executeRecoveryMutation(mutation, {
      revalidate: async () => undefined,
      prepareFreshRecovery: async () => ({
        originalRequest: mutation.originalRequest,
        nextHandle: "q2",
        nextRouteKey: "question-recover-failed-metadata-error-fresh",
      }),
      suppressPendingNotifications: async () => {},
      commitPreparedRecovery: async () => {
        throw new Error("forced commit failure")
      },
      rollbackPreparedRecovery: async () => {
        callOrder.push("rollback")
      },
      markRecovered: async () => {},
      markFailed: async () => {
        callOrder.push("markFailed")
        throw new Error("persist failed metadata failed")
      },
      mapFailure: () => ({
        recoveryErrorCode: "recoveryFailed",
        recoveryErrorMessage: "无法恢复请求：q1",
      }),
    }),
    /persist failed metadata failed/i,
  )

  assert.deepEqual(callOrder, ["rollback", "markFailed"])
})

test("broker-entry slash handler: /recover 在 mutation 中途失败时会回滚 fresh request 并持久化 failed 状态", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-mutation-rollback`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-mutation-rollback-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-mutation-rollback-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-mutation-rollback-request-store`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-mutation-rollback-1",
    scopeKey: "instance-recover-mutation-rollback-a",
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-mutation-rollback-1",
    routeKey,
    handle: "qrecoverrollback1",
    scopeKey: "instance-recover-mutation-rollback-a",
    wechatAccountId: "wx-recover-mutation-rollback",
    userId: "u-recover-mutation-rollback",
    createdAt: 1_700_800_030_000,
    prompt: {
      title: "恢复回滚问题",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_800_030_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-mutation-rollback-1",
    handle: "qrecoverrollback1",
    scopeKey: "instance-recover-mutation-rollback-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_030_000,
    finalizedAt: 1_700_800_030_100,
    wechatAccountId: "wx-recover-mutation-rollback",
    userId: "u-recover-mutation-rollback",
    instanceID: "instance-recover-mutation-rollback-a",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    mutationQueue: {
      enqueue: async (_mutationType, task) => task(),
    },
    recoveryTestHooks: {
      afterReopenRequest: async () => {
        throw new Error("forced recovery mutation failure")
      },
    },
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverrollback1" }),
    "无法恢复请求：qrecoverrollback1",
  )

  const activeRequests = await requestStore.listActiveRequests()
  assert.equal(
    activeRequests.some((item) => item.requestID === "q-recover-mutation-rollback-1" && item.status === "open"),
    false,
  )

  const original = await requestStore.findRequestByRouteKey({
    kind: "question",
    routeKey,
  })
  assert.equal(original?.status, "expired")
  assert.equal(original?.handle, "qrecoverrollback1")

  const recoveredDeadLetter = await deadLetterStore.readDeadLetter("question", routeKey)
  assert.equal(recoveredDeadLetter?.recoveryStatus, "failed")
  assert.equal(recoveredDeadLetter?.recoveryErrorCode, "recoveryFailed")
  assert.equal(recoveredDeadLetter?.recoveryErrorMessage, "无法恢复请求：qrecoverrollback1")
})

test("broker-entry slash handler: /recover 会 suppress 旧 routeKey 的 pending notification，后续 drain 不会发送旧 handle", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-suppress-pending`)
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}-recover-suppress-pending-settings`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-suppress-pending-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-suppress-pending-handle`)
  const notificationDispatcher = await import(`../dist/wechat/notification-dispatcher.js?reload=${Date.now()}-recover-suppress-pending-dispatcher`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-recover-suppress-pending-notification-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-suppress-pending-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-recover-suppress-pending-state-paths`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-suppress-pending-1",
    scopeKey: "instance-recover-suppress-pending-a",
  })

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-recover-suppress", userId: "u-recover-suppress" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-suppress-pending-1",
    routeKey,
    handle: "qrecoversuppressold1",
    scopeKey: "instance-recover-suppress-pending-a",
    wechatAccountId: "wx-recover-suppress",
    userId: "u-recover-suppress",
    createdAt: 1_700_800_000_000,
    prompt: {
      title: "恢复旧通知",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_800_000_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-suppress-pending-1",
    handle: "qrecoversuppressold1",
    scopeKey: "instance-recover-suppress-pending-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_000_000,
    finalizedAt: 1_700_800_000_100,
    wechatAccountId: "wx-recover-suppress",
    userId: "u-recover-suppress",
    instanceID: "instance-recover-suppress-pending-a",
  })
  await notificationStore.upsertNotification({
    idempotencyKey: "notif-recover-suppress-old-pending",
    kind: "question",
    routeKey,
    handle: "qrecoversuppressold1",
    wechatAccountId: "wx-recover-suppress",
    userId: "u-recover-suppress",
    createdAt: 1_700_800_000_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  const recoveredResult = await handler({ type: "recover", handle: "qrecoversuppressold1" })
  assert.match(recoveredResult, /^已恢复请求：q\d+$/)
  const recoveredHandle = recoveredResult.slice("已恢复请求：".length)
  assert.notEqual(recoveredHandle, "qrecoversuppressold1")

  const suppressedRaw = await readFile(statePaths.notificationStatePath("notif-recover-suppress-old-pending"), "utf8")
  const suppressed = JSON.parse(suppressedRaw)
  assert.equal(suppressed.status, "suppressed")
  assert.equal(typeof suppressed.suppressedAt, "number")

  const sendCalls = []
  const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
    sendMessage: async (input) => {
      sendCalls.push(input)
    },
  })

  await dispatcher.drainOutboundMessages()

  assert.equal(sendCalls.length, 0)
})

test("notification dispatcher: recover 并发窗口下旧 pending request 缺失时会 suppress，不发送旧 handle", async () => {
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}-recover-race-missing-request-settings`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-race-missing-request-handle`)
  const notificationDispatcher = await import(`../dist/wechat/notification-dispatcher.js?reload=${Date.now()}-recover-race-missing-request-dispatcher`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-recover-race-missing-request-notification-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-race-missing-request-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-recover-race-missing-request-state-paths`)

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-recover-race", userId: "u-recover-race" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const recoveredRouteKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-race-active-1-recovered",
    scopeKey: "instance-recover-race-a",
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-race-active-1",
    routeKey: recoveredRouteKey,
    handle: "qrecoverraceactive1",
    scopeKey: "instance-recover-race-a",
    wechatAccountId: "wx-recover-race",
    userId: "u-recover-race",
    createdAt: 1_700_810_000_000,
    prompt: {
      title: "恢复后的请求",
      mode: "text",
    },
  })

  await notificationStore.upsertNotification({
    idempotencyKey: "notif-recover-race-old-pending",
    kind: "question",
    routeKey: "question-recover-race-old",
    handle: "q1",
    wechatAccountId: "wx-recover-race",
    userId: "u-recover-race",
    createdAt: 1_700_810_000_100,
  })

  const sendCalls = []
  const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
    sendMessage: async (input) => {
      sendCalls.push(input)
    },
  })

  await dispatcher.drainOutboundMessages()

  assert.equal(sendCalls.length, 0)
  const notificationRaw = await readFile(statePaths.notificationStatePath("notif-recover-race-old-pending"), "utf8")
  const notification = JSON.parse(notificationRaw)
  assert.equal(notification.status, "suppressed")
  assert.equal(typeof notification.suppressedAt, "number")
})

test("notification dispatcher: 发送成功后 sent 持久化失败不会在后续 drain 重发", async () => {
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}-notification-sent-persist-failure-settings`)
  const notificationDispatcher = await import(`../dist/wechat/notification-dispatcher.js?reload=${Date.now()}-notification-sent-persist-failure-dispatcher`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-notification-sent-persist-failure-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-notification-sent-persist-failure-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-notification-sent-persist-failure-state-paths`)

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-notification-sent-persist-failure", userId: "u-notification-sent-persist-failure" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  await notificationStore.upsertNotification({
    idempotencyKey: "notif-sent-persist-failure",
    kind: "question",
    routeKey: "question-notif-sent-persist-failure",
    handle: "qnotifpersist1",
    scopeKey: "instance-notif-sent-persist-failure",
    wechatAccountId: "wx-notification-sent-persist-failure",
    userId: "u-notification-sent-persist-failure",
    createdAt: 1_700_840_000_000,
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-notification-sent-persist-failure",
    routeKey: "question-notif-sent-persist-failure",
    handle: "qnotifpersist1",
    scopeKey: "instance-notif-sent-persist-failure",
    wechatAccountId: "wx-notification-sent-persist-failure",
    userId: "u-notification-sent-persist-failure",
    createdAt: 1_700_840_000_000,
    prompt: {
      title: "sent persist failure",
      mode: "text",
    },
  })

  let sendCalls = 0
  let markSentOverrideCalls = 0
  const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
    sendMessage: async () => {
      sendCalls += 1
    },
    notificationStateOps: {
      markNotificationSent: async () => {
        markSentOverrideCalls += 1
        throw new Error("persist sent failed")
      },
    },
  })

  await assert.doesNotReject(() => dispatcher.drainOutboundMessages())
  await assert.doesNotReject(() => dispatcher.drainOutboundMessages())

  assert.equal(sendCalls, 1)
  assert.equal(markSentOverrideCalls, 1)
  const stored = JSON.parse(await readFile(statePaths.notificationStatePath("notif-sent-persist-failure"), "utf8"))
  assert.notEqual(stored.status, "pending")
})

test("notification dispatcher: 旧通知缺少 scopeKey 时 delivery failure callback 仍会回填 immutable scopeKey", async () => {
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}-notification-failure-scope-settings`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-notification-failure-scope-dead-letter-store`)
  const notificationDispatcher = await import(`../dist/wechat/notification-dispatcher.js?reload=${Date.now()}-notification-failure-scope-dispatcher`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-notification-failure-scope-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-notification-failure-scope-state-paths`)

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-notification-failure-scope", userId: "u-notification-failure-scope" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  await writeFile(statePaths.notificationStatePath("notif-failure-scope"), JSON.stringify({
    idempotencyKey: "notif-failure-scope",
    kind: "question",
    routeKey: "question-notif-failure-scope",
    handle: "qnotifscope1",
    wechatAccountId: "wx-notification-failure-scope",
    userId: "u-notification-failure-scope",
    createdAt: 1_700_840_000_100,
    status: "pending",
  }, null, 2))
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-notification-failure-scope",
    routeKey: "question-notif-failure-scope",
    handle: "qnotifscope1",
    scopeKey: "instance-notification-failure-scope",
    wechatAccountId: "wx-notification-failure-scope",
    userId: "u-notification-failure-scope",
    createdAt: 1_700_840_000_050,
    prompt: {
      title: "failure scope",
      mode: "text",
    },
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    requestID: "q-notification-failure-scope",
    routeKey: "question-notif-failure-scope",
    handle: "qnotifscope1",
    scopeKey: "instance-notification-failure-scope",
    wechatAccountId: "wx-notification-failure-scope",
    userId: "u-notification-failure-scope",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_840_000_100,
    finalizedAt: 1_700_840_000_200,
    instanceID: "instance-notification-failure-scope",
  })

  const failureCalls = []
  const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
    sendMessage: async () => {
      throw new Error("late delivery failed")
    },
    onDeliveryFailed: async (failure) => {
      failureCalls.push(failure)
    },
  })

  await dispatcher.drainOutboundMessages()

  assert.equal(failureCalls.length, 1)
  assert.equal(failureCalls[0]?.routeKey, "question-notif-failure-scope")
  assert.equal(failureCalls[0]?.scopeKey, "instance-notification-failure-scope")
})

test("notification store: backfill 旧通知 scopeKey 时不会回退并发更新到的 sent 状态", async () => {
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-notification-backfill-race-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-notification-backfill-race-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-notification-backfill-race-state-paths`)

  let releaseBackfill
  const backfillReached = new Promise((resolve) => {
    notificationStore.setNotificationStoreTestHooks({
      beforePersistBackfilledScopeKey: async () => {
        resolve(undefined)
        await new Promise((resume) => {
          releaseBackfill = resume
        })
      },
    })
  })

  try {
    await requestStore.upsertRequest({
      kind: "question",
      requestID: "q-notification-backfill-race",
      routeKey: "question-notification-backfill-race",
      handle: "qnotifbackfillrace1",
      scopeKey: "instance-notification-backfill-race",
      wechatAccountId: "wx-notification-backfill-race",
      userId: "u-notification-backfill-race",
      createdAt: 1_700_870_000_000,
      prompt: {
        title: "notification backfill race",
        mode: "text",
      },
    })
    await writeFile(statePaths.notificationStatePath("notif-backfill-race"), JSON.stringify({
      idempotencyKey: "notif-backfill-race",
      kind: "question",
      routeKey: "question-notification-backfill-race",
      handle: "qnotifbackfillrace1",
      wechatAccountId: "wx-notification-backfill-race",
      userId: "u-notification-backfill-race",
      createdAt: 1_700_870_000_100,
      status: "pending",
    }, null, 2))

    const readPromise = notificationStore.findSentNotificationByRequest({
      kind: "question",
      routeKey: "question-notification-backfill-race",
      handle: "qnotifbackfillrace1",
    })

    await backfillReached
    await writeFile(statePaths.notificationStatePath("notif-backfill-race"), JSON.stringify({
      idempotencyKey: "notif-backfill-race",
      kind: "question",
      routeKey: "question-notification-backfill-race",
      handle: "qnotifbackfillrace1",
      wechatAccountId: "wx-notification-backfill-race",
      userId: "u-notification-backfill-race",
      createdAt: 1_700_870_000_100,
      status: "sent",
      sentAt: 1_700_870_000_200,
    }, null, 2))
    releaseBackfill()

    const result = await readPromise
    assert.equal(result?.status, "sent")
    assert.equal(result?.scopeKey, "instance-notification-backfill-race")

    const stored = JSON.parse(await readFile(statePaths.notificationStatePath("notif-backfill-race"), "utf8"))
    assert.equal(stored.status, "sent")
  } finally {
    notificationStore.setNotificationStoreTestHooks(undefined)
  }
})

test("notification dispatcher: 晚到的 delivery failure 不会把 sent 或 suppressed 通知改写成 failed，也不会触发 fallback", async () => {
  const commonSettingsStore = await import(`../dist/common-settings-store.js?reload=${Date.now()}-notification-late-failure-terminal-settings`)
  const notificationDispatcher = await import(`../dist/wechat/notification-dispatcher.js?reload=${Date.now()}-notification-late-failure-terminal-dispatcher`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-notification-late-failure-terminal-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-notification-late-failure-terminal-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-notification-late-failure-terminal-state-paths`)

  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-notification-late-failure-terminal", userId: "u-notification-late-failure-terminal" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-notification-late-failure-terminal",
    routeKey: "question-notification-late-failure-terminal",
    handle: "qnotlaterm1",
    scopeKey: "instance-notification-late-failure-terminal",
    wechatAccountId: "wx-notification-late-failure-terminal",
    userId: "u-notification-late-failure-terminal",
    createdAt: 1_700_840_000_300,
    prompt: {
      title: "late failure terminal",
      mode: "text",
    },
  })
  await notificationStore.upsertNotification({
    idempotencyKey: "notif-late-failure-sent",
    kind: "question",
    routeKey: "question-notification-late-failure-terminal",
    handle: "qnotlaterm1",
    scopeKey: "instance-notification-late-failure-terminal",
    wechatAccountId: "wx-notification-late-failure-terminal",
    userId: "u-notification-late-failure-terminal",
    createdAt: Date.now(),
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: "notif-late-failure-sent",
    sentAt: Date.now(),
  })
  await notificationStore.upsertNotification({
    idempotencyKey: "notif-late-failure-suppressed",
    kind: "question",
    routeKey: "question-notification-late-failure-terminal",
    handle: "qnotlaterm1",
    scopeKey: "instance-notification-late-failure-terminal",
    wechatAccountId: "wx-notification-late-failure-terminal",
    userId: "u-notification-late-failure-terminal",
    createdAt: Date.now(),
  })
  await notificationStore.markNotificationResolved({
    idempotencyKey: "notif-late-failure-suppressed",
    resolvedAt: Date.now(),
    suppressed: true,
  })

  let pendingCallCount = 0
  const failureCalls = []
  const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
    sendMessage: async () => {
      throw new Error("late failure should not resend terminal notifications")
    },
    onDeliveryFailed: async (failure) => {
      failureCalls.push(failure)
    },
    notificationStateOps: {
      listPendingNotifications: async () => {
        pendingCallCount += 1
        const sent = JSON.parse(await readFile(statePaths.notificationStatePath("notif-late-failure-sent"), "utf8"))
        const suppressed = JSON.parse(await readFile(statePaths.notificationStatePath("notif-late-failure-suppressed"), "utf8"))
        return pendingCallCount === 1 ? [sent, suppressed] : []
      },
    },
  })

  await dispatcher.drainOutboundMessages()

  const sent = JSON.parse(await readFile(statePaths.notificationStatePath("notif-late-failure-sent"), "utf8"))
  const suppressed = JSON.parse(await readFile(statePaths.notificationStatePath("notif-late-failure-suppressed"), "utf8"))
  assert.equal(sent.status, "sent")
  assert.equal(suppressed.status, "suppressed")
  assert.deepEqual(failureCalls, [])
})

test("broker-entry runtime lifecycle: 旧 route 被 recovery 移除后 late delivery failure 仍会按 immutable scopeKey 处理", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-late-delivery-failure-after-recover`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-late-delivery-failure-after-recover-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-late-delivery-failure-after-recover-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-late-delivery-failure-after-recover-request-store`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-late-delivery-failure-after-recover-1",
    scopeKey: "instance-late-delivery-failure-after-recover-a",
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-late-delivery-failure-after-recover-1",
    routeKey,
    handle: "qlatedelivery1",
    scopeKey: "instance-late-delivery-failure-after-recover-a",
    wechatAccountId: "wx-late-delivery-failure-after-recover",
    userId: "u-late-delivery-failure-after-recover",
    createdAt: 1_700_840_000_200,
    prompt: {
      title: "late delivery failure after recover",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_840_000_300,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-late-delivery-failure-after-recover-1",
    handle: "qlatedelivery1",
    scopeKey: "instance-late-delivery-failure-after-recover-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_840_000_200,
    finalizedAt: 1_700_840_000_300,
    wechatAccountId: "wx-late-delivery-failure-after-recover",
    userId: "u-late-delivery-failure-after-recover",
    instanceID: "instance-late-delivery-failure-after-recover-a",
  })

  const slashHandler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })
  const recoveredResult = await slashHandler({ type: "recover", handle: "qlatedelivery1" })
  assert.match(recoveredResult, /^已恢复请求：q\d+$/)
  assert.equal(await requestStore.findRequestByRouteKey({ kind: "question", routeKey }), undefined)

  const failureCalls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    handleNotificationDeliveryFailure: async (input) => {
      failureCalls.push(input)
    },
    createNotificationDispatcher: ({ onDeliveryFailed }) => ({
      drainOutboundMessages: async () => {
        await onDeliveryFailed?.({
          kind: "question",
          routeKey,
          scopeKey: "instance-late-delivery-failure-after-recover-a",
          wechatAccountId: "wx-late-delivery-failure-after-recover",
          userId: "u-late-delivery-failure-after-recover",
          registrationEpoch: "epoch-late-delivery-failure-after-recover",
        })
      },
    }),
    createStatusRuntime: ({ drainOutboundMessages }) => ({
      start: async () => {
        await drainOutboundMessages()
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()

  assert.deepEqual(failureCalls, [{
    instanceID: "instance-late-delivery-failure-after-recover-a",
    wechatAccountId: "wx-late-delivery-failure-after-recover",
    userId: "u-late-delivery-failure-after-recover",
    registrationEpoch: "epoch-late-delivery-failure-after-recover",
  }])
})

test("broker-entry slash handler: /recover 队列重验发现候选已失效时仍会写 failed metadata", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-queue-invalid-persists-failure`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-queue-invalid-persists-failure-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-queue-invalid-persists-failure-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-queue-invalid-persists-failure-request-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-recover-queue-invalid-persists-failure-state-paths`)

  const routeKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-queue-invalid-persists-failure-1",
    scopeKey: "instance-recover-queue-invalid-persists-failure-a",
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-queue-invalid-persists-failure-1",
    routeKey,
    handle: "qrecoverqueueinvalid1",
    scopeKey: "instance-recover-queue-invalid-persists-failure-a",
    wechatAccountId: "wx-recover-queue-invalid-persists-failure",
    userId: "u-recover-queue-invalid-persists-failure",
    createdAt: 1_700_860_000_000,
    prompt: {
      title: "队列失效仍落 failed",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey,
    expiredAt: 1_700_860_000_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey,
    requestID: "q-recover-queue-invalid-persists-failure-1",
    handle: "qrecoverqueueinvalid1",
    scopeKey: "instance-recover-queue-invalid-persists-failure-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_860_000_000,
    finalizedAt: 1_700_860_000_100,
    wechatAccountId: "wx-recover-queue-invalid-persists-failure",
    userId: "u-recover-queue-invalid-persists-failure",
    instanceID: "instance-recover-queue-invalid-persists-failure-a",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    mutationQueue: {
      enqueue: async (_mutationType, task) => {
        await rm(statePaths.requestStatePath("question", routeKey), { force: true })
        return task()
      },
    },
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverqueueinvalid1" }),
    "无法恢复请求，原始记录不存在：qrecoverqueueinvalid1",
  )

  const deadLetter = await deadLetterStore.readDeadLetter("question", routeKey)
  assert.equal(deadLetter?.recoveryStatus, "failed")
  assert.equal(deadLetter?.recoveryErrorCode, "requestMissing")
  assert.equal(deadLetter?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecoverqueueinvalid1")
})

test("broker-entry slash handler: /recover 连续恢复不会复用同一请求链的历史 handle", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-historical-handles`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-historical-handles-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-historical-handles-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-historical-handles-request-store`)

  const firstRouteKey = handle.createRouteKey({
    kind: "permission",
    requestID: "p-recover-history-1",
    scopeKey: "instance-recover-history-a",
  })

  await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-recover-history-1",
    routeKey: firstRouteKey,
    handle: "p1",
    scopeKey: "instance-recover-history-a",
    wechatAccountId: "wx-recover-history",
    userId: "u-recover-history",
    createdAt: 1_700_800_010_000,
    prompt: {
      title: "连续恢复权限",
      type: "command",
    },
  })
  await requestStore.markRequestExpired({
    kind: "permission",
    routeKey: firstRouteKey,
    expiredAt: 1_700_800_010_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "permission",
    routeKey: firstRouteKey,
    requestID: "p-recover-history-1",
    handle: "p1",
    scopeKey: "instance-recover-history-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_800_010_000,
    finalizedAt: 1_700_800_010_100,
    wechatAccountId: "wx-recover-history",
    userId: "u-recover-history",
    instanceID: "instance-recover-history-a",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  const firstRecoveredResult = await handler({ type: "recover", handle: "p1" })
  assert.match(firstRecoveredResult, /^已恢复请求：p\d+$/)
  const firstRecoveredHandle = firstRecoveredResult.slice("已恢复请求：".length)
  assert.notEqual(firstRecoveredHandle, "p1")
  const firstRecovered = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: firstRecoveredHandle })
  assert.equal(firstRecovered?.requestID, "p-recover-history-1")

  await requestStore.markRequestExpired({
    kind: "permission",
    routeKey: firstRecovered.routeKey,
    expiredAt: 1_700_800_010_200,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "permission",
    routeKey: firstRecovered.routeKey,
    requestID: firstRecovered.requestID,
    handle: firstRecovered.handle,
    scopeKey: firstRecovered.scopeKey,
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: firstRecovered.createdAt,
    finalizedAt: 1_700_800_010_200,
    wechatAccountId: firstRecovered.wechatAccountId,
    userId: firstRecovered.userId,
    instanceID: "instance-recover-history-a",
  })

  const secondRecoveredResult = await handler({ type: "recover", handle: firstRecoveredHandle })
  assert.match(secondRecoveredResult, /^已恢复请求：p\d+$/)
  const secondRecoveredHandle = secondRecoveredResult.slice("已恢复请求：".length)

  const secondRecovered = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: secondRecoveredHandle })
  assert.equal(secondRecovered?.requestID, "p-recover-history-1")
  assert.equal(secondRecovered?.handle, secondRecoveredHandle)
  assert.notEqual(secondRecovered?.handle, "p1")
  assert.notEqual(secondRecovered?.handle, firstRecoveredHandle)
  assert.equal(await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" }), undefined)
  assert.equal(await requestStore.findOpenRequestByHandle({ kind: "permission", handle: firstRecoveredHandle }), undefined)
})

test("broker-entry slash handler: /recover 同 handle 下孤儿 dead-letter 不应制造歧义并阻塞有效恢复", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-ignore-orphan-ambiguity`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-ignore-orphan-ambiguity-dead-letter-store`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-recover-ignore-orphan-ambiguity-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-ignore-orphan-ambiguity-request-store`)

  const validRouteKey = handle.createRouteKey({
    kind: "question",
    requestID: "q-recover-ignore-orphan-valid-1",
    scopeKey: "instance-recover-ignore-orphan-a",
  })

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-ignore-orphan-valid-1",
    routeKey: validRouteKey,
    handle: "qrecovermix1",
    scopeKey: "instance-recover-ignore-orphan-a",
    wechatAccountId: "wx-recover-ignore-orphan",
    userId: "u-recover-ignore-orphan",
    createdAt: 1_700_820_000_000,
    prompt: {
      title: "可恢复请求",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: validRouteKey,
    expiredAt: 1_700_820_000_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: validRouteKey,
    requestID: "q-recover-ignore-orphan-valid-1",
    handle: "qrecovermix1",
    scopeKey: "instance-recover-ignore-orphan-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_820_000_000,
    finalizedAt: 1_700_820_000_100,
    wechatAccountId: "wx-recover-ignore-orphan",
    userId: "u-recover-ignore-orphan",
    instanceID: "instance-recover-ignore-orphan-a",
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-ignore-orphan-missing-1",
    requestID: "q-recover-ignore-orphan-missing-1",
    handle: "qrecovermix1",
    scopeKey: "instance-recover-ignore-orphan-b",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_820_000_200,
    finalizedAt: 1_700_820_000_300,
    wechatAccountId: "wx-recover-ignore-orphan",
    userId: "u-recover-ignore-orphan",
    instanceID: "instance-recover-ignore-orphan-b",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  const recoveredResult = await handler({ type: "recover", handle: "qrecovermix1" })
  assert.match(recoveredResult, /^已恢复请求：q\d+$/)

  const validDeadLetter = await deadLetterStore.readDeadLetter("question", validRouteKey)
  assert.equal(validDeadLetter?.recoveryStatus, "recovered")

  const orphanDeadLetter = await deadLetterStore.readDeadLetter("question", "question-recover-ignore-orphan-missing-1")
  assert.notEqual(orphanDeadLetter?.recoveryErrorCode, "ambiguousHandle")
})

test("broker-entry slash handler: /recover 批量 failed metadata 更新部分失败时不会回滚并发 newer failed 状态", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-batch-failure-explicit`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-batch-failure-explicit-dead-letter-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-batch-failure-explicit-request-store`)

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-batch-failure-a",
    routeKey: "question-recover-batch-failure-a",
    handle: "qrecoverbatchfailure1",
    scopeKey: "instance-recover-batch-failure-a",
    wechatAccountId: "wx-recover-batch-failure-a",
    userId: "u-recover-batch-failure-a",
    createdAt: 1_700_850_000_000,
    prompt: {
      title: "批量失败 A",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: "question-recover-batch-failure-a",
    expiredAt: 1_700_850_000_100,
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-batch-failure-b",
    routeKey: "question-recover-batch-failure-b",
    handle: "qrecoverbatchfailure1",
    scopeKey: "instance-recover-batch-failure-b",
    wechatAccountId: "wx-recover-batch-failure-b",
    userId: "u-recover-batch-failure-b",
    createdAt: 1_700_850_000_200,
    prompt: {
      title: "批量失败 B",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: "question-recover-batch-failure-b",
    expiredAt: 1_700_850_000_300,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-batch-failure-a",
    requestID: "q-recover-batch-failure-a",
    handle: "qrecoverbatchfailure1",
    scopeKey: "instance-recover-batch-failure-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_850_000_000,
    finalizedAt: 1_700_850_000_100,
    wechatAccountId: "wx-recover-batch-failure-a",
    userId: "u-recover-batch-failure-a",
    instanceID: "instance-recover-batch-failure-a",
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-batch-failure-b",
    requestID: "q-recover-batch-failure-b",
    handle: "qrecoverbatchfailure1",
    scopeKey: "instance-recover-batch-failure-b",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_850_000_200,
    finalizedAt: 1_700_850_000_300,
    wechatAccountId: "wx-recover-batch-failure-b",
    userId: "u-recover-batch-failure-b",
    instanceID: "instance-recover-batch-failure-b",
  })

  const markedRouteKeys = []
  const realMarkDeadLetterRecoveryFailed = deadLetterStore.markDeadLetterRecoveryFailed
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    markDeadLetterRecoveryFailedImpl: async (failureInput) => {
      markedRouteKeys.push(failureInput.routeKey)
      if (failureInput.routeKey === "question-recover-batch-failure-b") {
        await realMarkDeadLetterRecoveryFailed({
          kind: "question",
          routeKey: "question-recover-batch-failure-a",
          recoveryErrorCode: "requestMissing",
          recoveryErrorMessage: "无法恢复请求，原始记录不存在：qrecoverbatchfailure1",
        })
        throw new Error("forced batch failed metadata write")
      }
      return realMarkDeadLetterRecoveryFailed(failureInput)
    },
  })

  await assert.rejects(
    () => handler({ type: "recover", handle: "qrecoverbatchfailure1" }),
    /failed to persist recovery failure metadata/i,
  )

  assert.deepEqual(markedRouteKeys, ["question-recover-batch-failure-a", "question-recover-batch-failure-b"])
  const first = await deadLetterStore.readDeadLetter("question", "question-recover-batch-failure-a")
  const second = await deadLetterStore.readDeadLetter("question", "question-recover-batch-failure-b")
  assert.equal(first?.recoveryStatus, "failed")
  assert.equal(first?.recoveryErrorCode, "requestMissing")
  assert.equal(first?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecoverbatchfailure1")
  assert.equal(first?.recoveredAt, undefined)
  assert.equal(second?.recoveryStatus, undefined)
  assert.equal(second?.recoveryErrorCode, undefined)
  assert.equal(second?.recoveryErrorMessage, undefined)
})

test("broker-entry slash handler: /recover 遇到多个可恢复候选时拒绝歧义恢复", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-ambiguous`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-ambiguous-dead-letter-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-ambiguous-request-store`)

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-ambiguous-a",
    routeKey: "question-recover-ambiguous-a",
    handle: "qrecoverambiguous1",
    scopeKey: "instance-recover-ambiguous-a",
    wechatAccountId: "wx-recover-ambiguous-a",
    userId: "u-recover-ambiguous-a",
    createdAt: 1_700_700_020_000,
    prompt: {
      title: "歧义恢复 A",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: "question-recover-ambiguous-a",
    expiredAt: 1_700_700_021_000,
  })

  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-ambiguous-a",
    requestID: "q-recover-ambiguous-a",
    handle: "qrecoverambiguous1",
    scopeKey: "instance-recover-ambiguous-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_020_000,
    finalizedAt: 1_700_700_021_000,
    wechatAccountId: "wx-recover-ambiguous-a",
    userId: "u-recover-ambiguous-a",
    instanceID: "instance-recover-ambiguous-a",
  })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-ambiguous-b",
    routeKey: "question-recover-ambiguous-b",
    handle: "qrecoverambiguous1",
    scopeKey: "instance-recover-ambiguous-b",
    wechatAccountId: "wx-recover-ambiguous-b",
    userId: "u-recover-ambiguous-b",
    createdAt: 1_700_700_022_000,
    prompt: {
      title: "歧义恢复 B",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: "question-recover-ambiguous-b",
    expiredAt: 1_700_700_023_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-ambiguous-b",
    requestID: "q-recover-ambiguous-b",
    handle: "qrecoverambiguous1",
    scopeKey: "instance-recover-ambiguous-b",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_022_000,
    finalizedAt: 1_700_700_023_000,
    wechatAccountId: "wx-recover-ambiguous-b",
    userId: "u-recover-ambiguous-b",
    instanceID: "instance-recover-ambiguous-b",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverambiguous1" }),
    "找到多个可恢复的请求：qrecoverambiguous1",
  )

  const first = await deadLetterStore.readDeadLetter("question", "question-recover-ambiguous-a")
  const second = await deadLetterStore.readDeadLetter("question", "question-recover-ambiguous-b")
  assert.equal(first?.recoveryStatus, "failed")
  assert.equal(first?.recoveryErrorCode, "ambiguousHandle")
  assert.equal(first?.recoveryErrorMessage, "找到多个可恢复的请求：qrecoverambiguous1")
  assert.equal(second?.recoveryStatus, "failed")
  assert.equal(second?.recoveryErrorCode, "ambiguousHandle")
  assert.equal(second?.recoveryErrorMessage, "找到多个可恢复的请求：qrecoverambiguous1")
})

test("broker-entry slash handler: /recover 入队等待期间若出现新的可恢复候选会在队列内拒绝歧义恢复", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-queue-ambiguity`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-queue-ambiguity-dead-letter-store`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-recover-queue-ambiguity-request-store`)

  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-recover-queue-ambiguity-a",
    routeKey: "question-recover-queue-ambiguity-a",
    handle: "qrecoverqueueambiguous1",
    scopeKey: "instance-recover-queue-ambiguity-a",
    wechatAccountId: "wx-recover-queue-ambiguity-a",
    userId: "u-recover-queue-ambiguity-a",
    createdAt: 1_700_850_100_000,
    prompt: {
      title: "队列歧义 A",
      mode: "text",
    },
  })
  await requestStore.markRequestExpired({
    kind: "question",
    routeKey: "question-recover-queue-ambiguity-a",
    expiredAt: 1_700_850_100_100,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-queue-ambiguity-a",
    requestID: "q-recover-queue-ambiguity-a",
    handle: "qrecoverqueueambiguous1",
    scopeKey: "instance-recover-queue-ambiguity-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_850_100_000,
    finalizedAt: 1_700_850_100_100,
    wechatAccountId: "wx-recover-queue-ambiguity-a",
    userId: "u-recover-queue-ambiguity-a",
    instanceID: "instance-recover-queue-ambiguity-a",
  })

  let enqueued = false
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    mutationQueue: {
      enqueue: async (_mutationType, task) => {
        if (!enqueued) {
          enqueued = true
          await requestStore.upsertRequest({
            kind: "question",
            requestID: "q-recover-queue-ambiguity-b",
            routeKey: "question-recover-queue-ambiguity-b",
            handle: "qrecoverqueueambiguous1",
            scopeKey: "instance-recover-queue-ambiguity-b",
            wechatAccountId: "wx-recover-queue-ambiguity-b",
            userId: "u-recover-queue-ambiguity-b",
            createdAt: 1_700_850_100_200,
            prompt: {
              title: "队列歧义 B",
              mode: "text",
            },
          })
          await requestStore.markRequestExpired({
            kind: "question",
            routeKey: "question-recover-queue-ambiguity-b",
            expiredAt: 1_700_850_100_300,
          })
          await deadLetterStore.writeDeadLetter({
            kind: "question",
            routeKey: "question-recover-queue-ambiguity-b",
            requestID: "q-recover-queue-ambiguity-b",
            handle: "qrecoverqueueambiguous1",
            scopeKey: "instance-recover-queue-ambiguity-b",
            finalStatus: "expired",
            reason: "instanceStale",
            createdAt: 1_700_850_100_200,
            finalizedAt: 1_700_850_100_300,
            wechatAccountId: "wx-recover-queue-ambiguity-b",
            userId: "u-recover-queue-ambiguity-b",
            instanceID: "instance-recover-queue-ambiguity-b",
          })
        }
        return task()
      },
    },
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverqueueambiguous1" }),
    "找到多个可恢复的请求：qrecoverqueueambiguous1",
  )

  assert.equal(await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrecoverqueueambiguous1" }), undefined)
  const first = await deadLetterStore.readDeadLetter("question", "question-recover-queue-ambiguity-a")
  const second = await deadLetterStore.readDeadLetter("question", "question-recover-queue-ambiguity-b")
  assert.equal(first?.recoveryErrorCode, "ambiguousHandle")
  assert.equal(second?.recoveryErrorCode, "ambiguousHandle")
})

test("broker-entry slash handler: /recover 原始 request 缺失时拒绝并持久化 failed 状态", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-missing-request`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-missing-request-dead-letter-store`)

  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-missing-request-1",
    requestID: "q-recover-missing-request-1",
    handle: "qrecovermissing1",
    scopeKey: "instance-recover-missing-request-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_030_000,
    finalizedAt: 1_700_700_031_000,
    wechatAccountId: "wx-recover-missing-request-a",
    userId: "u-recover-missing-request-a",
    instanceID: "instance-recover-missing-request-a",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecovermissing1" }),
    "无法恢复请求，原始记录不存在：qrecovermissing1",
  )

  const recoveredDeadLetter = await deadLetterStore.readDeadLetter("question", "question-recover-missing-request-1")
  assert.equal(recoveredDeadLetter?.recoveryStatus, "failed")
  assert.equal(recoveredDeadLetter?.recoveryErrorCode, "requestMissing")
  assert.equal(recoveredDeadLetter?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecovermissing1")
})

test("broker-entry slash handler: /recover 仅命中不可恢复历史候选时也会持久化 failed 状态", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-recover-only-invalid-candidates`)
  const deadLetterStore = await import(`../dist/wechat/dead-letter-store.js?reload=${Date.now()}-recover-only-invalid-candidates-dead-letter-store`)

  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-only-invalid-a",
    requestID: "q-recover-only-invalid-a",
    handle: "qrecoverinvalid1",
    scopeKey: "instance-recover-only-invalid-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_040_000,
    finalizedAt: 1_700_700_041_000,
    wechatAccountId: "wx-recover-only-invalid",
    userId: "u-recover-only-invalid",
    instanceID: "instance-recover-only-invalid-a",
  })
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-recover-only-invalid-b",
    requestID: "q-recover-only-invalid-b",
    handle: "qrecoverinvalid1",
    scopeKey: "instance-recover-only-invalid-b",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_700_042_000,
    finalizedAt: 1_700_700_043_000,
    wechatAccountId: "wx-recover-only-invalid",
    userId: "u-recover-only-invalid",
    instanceID: "instance-recover-only-invalid-b",
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
  })

  assert.equal(
    await handler({ type: "recover", handle: "qrecoverinvalid1" }),
    "未找到可恢复的请求：qrecoverinvalid1",
  )

  const first = await deadLetterStore.readDeadLetter("question", "question-recover-only-invalid-a")
  const second = await deadLetterStore.readDeadLetter("question", "question-recover-only-invalid-b")
  assert.equal(first?.recoveryStatus, "failed")
  assert.equal(first?.recoveryErrorCode, "requestMissing")
  assert.equal(first?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecoverinvalid1")
  assert.equal(second?.recoveryStatus, "failed")
  assert.equal(second?.recoveryErrorCode, "requestMissing")
  assert.equal(second?.recoveryErrorMessage, "无法恢复请求，原始记录不存在：qrecoverinvalid1")
})

test("broker-entry slash handler: 仅有 pending notification 时 /allow 仍成功且静默跳过 resolve", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-pending-notification`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-pending-notification-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-pending-notification-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-pending-notification-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-pending-notification-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-no-sent-notification-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-no-sent-notification-1",
    routeKey,
    handle: "pnosent1",
    wechatAccountId: "wx-no-sent",
    userId: "u-no-sent",
    createdAt: 1_700_300_300_000,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-pending-only",
    kind: "permission",
    routeKey,
    handle: "pnosent1",
    wechatAccountId: "wx-no-sent",
    userId: "u-no-sent",
    createdAt: 1_700_300_300_100,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "pnosent1", reply: "always", message: "safe" })

  assert.equal(result, "已处理权限请求：pnosent1 (always)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "always", message: "safe" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "pnosent1" })
  assert.equal(openAfterReply, undefined)

  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingRecord = JSON.parse(pendingRaw)
  assert.equal(pendingRecord.status, "pending")
  assert.equal(pendingRecord.resolvedAt, undefined)
})

test("broker-entry slash handler: notification resolve 竞态失败时 /reply 仍返回成功", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-resolve-race`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-resolve-race-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-resolve-race-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-resolve-race-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-resolve-race-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-resolve-race-1" })
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-resolve-race-1",
    routeKey,
    handle: "qrace1",
    wechatAccountId: "wx-race",
    userId: "u-race",
    createdAt: 1_700_300_400_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-resolve-race",
    kind: "question",
    routeKey,
    handle: "qrace1",
    wechatAccountId: "wx-race",
    userId: "u-race",
    createdAt: 1_700_300_400_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_400_200,
  })

  const replyCalls = []
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          await notificationStore.markNotificationResolved({
            idempotencyKey: sent.idempotencyKey,
            resolvedAt: 1_700_300_400_300,
          })
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qrace1", text: "done" })

  assert.equal(result, "已回复问题：qrace1")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, answers: [["done"]] }])
  assert.equal(await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrace1" }), undefined)

  const notificationRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const notification = JSON.parse(notificationRaw)
  assert.equal(notification.status, "resolved")
})

test("broker-entry slash handler: request 查询存储异常不应被误报为 not-found", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-lookup-storage-error`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-lookup-storage-error-state-paths`)

  const brokenPath = statePaths.requestStatePath("question", "question-broken-json")
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{not-json")

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {},
    },
  })

  await assert.rejects(
    () => handler({ type: "reply", handle: "q1", text: "done" }),
    /invalid request record format/i,
  )
})

test("broker-entry runtime autostart gate: 默认始终开启，不再依赖环境变量", async () => {
  const envKey = "WECHAT_BROKER_ENABLE_STATUS_RUNTIME"
  const previous = process.env[envKey]

  delete process.env[envKey]
  const brokerEntryDefault = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-default`)
  assert.equal(brokerEntryDefault.shouldEnableBrokerWechatStatusRuntime(), true)

  process.env[envKey] = "0"
  const brokerEntryDisabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-disabled`)
  assert.equal(brokerEntryDisabled.shouldEnableBrokerWechatStatusRuntime(), true)

  process.env[envKey] = "1"
  const brokerEntryEnabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-enabled`)
  assert.equal(brokerEntryEnabled.shouldEnableBrokerWechatStatusRuntime(), true)

  if (typeof previous === "string") {
    process.env[envKey] = previous
  } else {
    delete process.env[envKey]
  }
})

test("broker-entry runtime lifecycle: 默认把诊断事件写入稳定文件路径", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-diag-file`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-diag-path`)
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wechat-status-runtime-diagnostics-"))

  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    stateRoot,
    createStatusRuntime: ({ onDiagnosticEvent }) => ({
      start: async () => {
        await onDiagnosticEvent?.({
          type: "slashCommandRecognized",
          command: { type: "status" },
          text: "/status",
          to: "u-diagnostic",
        })
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()
  await lifecycle.close()

  const diagnosticsPath = statePaths.wechatStatusRuntimeDiagnosticsPath(stateRoot)
  const raw = await readFile(diagnosticsPath, "utf8")
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  assert.equal(lines.length, 1)

  const event = JSON.parse(lines[0])
  assert.equal(event.type, "slashCommandRecognized")
  assert.equal(event.command.type, "status")
  assert.equal(event.to, "u-diagnostic")
})
