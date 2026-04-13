import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const DIST_BRIDGE_MODULE = "../dist/wechat/bridge.js"
const DIST_BROKER_CLIENT_MODULE = "../dist/wechat/broker-client.js"
const DIST_BROKER_SERVER_MODULE = "../dist/wechat/broker-server.js"
const DIST_NOTIFICATION_STORE_MODULE = "../dist/wechat/notification-store.js"
const DIST_OPERATOR_STORE_MODULE = "../dist/wechat/operator-store.js"
const DIST_PROTOCOL_MODULE = "../dist/wechat/protocol.js"
const DIST_REQUEST_STORE_MODULE = "../dist/wechat/request-store.js"
const DIST_STATE_PATHS_MODULE = "../dist/wechat/state-paths.js"
const DIST_COMMON_SETTINGS_STORE_MODULE = "../dist/common-settings-store.js"
const DIST_NOTIFICATION_DISPATCHER_MODULE = "../dist/wechat/notification-dispatcher.js"
const DIST_NOTIFICATION_FORMAT_MODULE = "../dist/wechat/notification-format.js"
const DIST_WECHAT_STATUS_RUNTIME_MODULE = "../dist/wechat/wechat-status-runtime.js"
const DIST_BROKER_ENTRY_MODULE = "../dist/wechat/broker-entry.js"
const DIST_TOKEN_STORE_MODULE = "../dist/wechat/token-store.js"

function createBrokerEndpoint(tempDir) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\wechat-broker-notification-${process.pid}-${suffix}`
  }
  return path.join(tempDir, `wechat-broker-notification-${suffix}.sock`)
}

async function waitFor(assertion, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await assertion()
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return assertion()
}

function createWechatClientWithFixedPending(input) {
  return {
    session: {
      list: async () => [{ id: input.sessionID, title: "session", directory: "/repo", time: { updated: 100 } }],
      status: async () => ({ [input.sessionID]: { type: "retry" } }),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [{ id: input.questionID, sessionID: input.sessionID, text: "question" }],
    },
    permission: {
      list: async () => [{ id: input.permissionID, sessionID: input.sessionID, tool: "bash", command: "ls" }],
    },
  }
}

async function createOpenRequest(requestStore, input) {
  return requestStore.upsertRequest({
    kind: input.kind,
    requestID: input.requestID,
    routeKey: input.routeKey,
    handle: input.handle,
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    createdAt: input.createdAt,
  })
}

test("两个实例出现相同 question/permission/session 标识时不会互相覆盖", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-cross-instance-")
  const sandboxStateRoot = isolatedStateRoot.stateRoot

  assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, sandboxStateRoot)

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-test",
    userId: "user-test",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  let clientA = null
  let clientB = null
  try {
    const sameIDs = {
      questionID: "q-same",
      permissionID: "p-same",
      sessionID: "s-same",
    }

    const bridgeA = bridgeModule.createWechatBridge({
      instanceID: "instance-a",
      instanceName: "A",
      pid: process.pid,
      directory: "/repo/a",
      client: createWechatClientWithFixedPending(sameIDs),
    })
    const bridgeB = bridgeModule.createWechatBridge({
      instanceID: "instance-b",
      instanceName: "B",
      pid: process.pid,
      directory: "/repo/b",
      client: createWechatClientWithFixedPending(sameIDs),
    })

    clientA = await brokerClient.connect(endpoint, { bridge: bridgeA })
    clientB = await brokerClient.connect(endpoint, { bridge: bridgeB })
    await clientA.registerInstance({ instanceID: "instance-a", pid: process.pid })
    await clientB.registerInstance({ instanceID: "instance-b", pid: process.pid })

    const pending = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      assert.equal(list.length, 6)
      return list
    })

    assert.equal(pending.filter((item) => item.kind === "question").length, 2)
    assert.equal(pending.filter((item) => item.kind === "permission").length, 2)
    assert.equal(pending.filter((item) => item.kind === "sessionError").length, 2)
  } finally {
    if (clientA) {
      await clientA.close().catch(() => {})
    }
    if (clientB) {
      await clientB.close().catch(() => {})
    }
    await server.close().catch(() => {})
    await isolatedStateRoot.restore()
  }
})

test("同一 retry 状态持续不重复新增，但新 retry 事件应生成新 sessionError 记录", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-retry-event-")

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-test",
    userId: "user-test",
    boundAt: Date.now(),
  })

  let retryNonce = "retry-event-1"
  const bridge = bridgeModule.createWechatBridge({
    instanceID: "instance-retry",
    instanceName: "Retry",
    pid: process.pid,
    directory: "/repo/retry",
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "retry", retryNonce } }),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  })

  try {
    const first = await bridge.collectNotificationCandidates()
    const second = await bridge.collectNotificationCandidates()
    retryNonce = "retry-event-2"
    const third = await bridge.collectNotificationCandidates()

    const firstKey = first.find((item) => item.kind === "sessionError")?.idempotencyKey
    const secondKey = second.find((item) => item.kind === "sessionError")?.idempotencyKey
    const thirdKey = third.find((item) => item.kind === "sessionError")?.idempotencyKey

    assert.equal(typeof firstKey, "string")
    assert.equal(secondKey, firstKey)
    assert.notEqual(thirdKey, secondKey)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("register 成功返回前应完成首轮通知同步，而不是依赖后续 heartbeat", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}`)

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-register-sync-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      const line = buffer.slice(0, newlineIndex + 1)
      const request = protocol.parseEnvelopeLine(line)
      if (request.type === "registerInstance") {
        socket.write(
          protocol.serializeEnvelope({
            id: `registerAck-${request.id}`,
            type: "registerAck",
            instanceID: request.instanceID,
            payload: {
              sessionToken: "session-token",
              registeredAt: Date.now(),
              registrationEpoch: "epoch-register-sync",
              brokerPid: process.pid,
            },
          }),
        )
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  const client = await brokerClient.connect(endpoint, {
    bridge: {
      collectStatusSnapshot: async () => ({ ok: true }),
      collectNotificationCandidates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 220))
        return []
      },
    },
  })

  try {
    const startedAt = Date.now()
    const ack = await client.registerInstance({ instanceID: "instance-register-sync", pid: process.pid })
    const elapsedMs = Date.now() - startedAt
    assert.equal(ack.registrationEpoch, "epoch-register-sync")
    assert.equal(elapsedMs >= 200, true)
  } finally {
    await client.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("register 时 collectNotificationCandidates 抛错不应拖垮主链路", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}`)

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-register-soft-fail-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const registeredAt = Date.now()

  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      const line = buffer.slice(0, newlineIndex + 1)
      const request = protocol.parseEnvelopeLine(line)
      if (request.type === "registerInstance") {
        socket.write(
          protocol.serializeEnvelope({
            id: `registerAck-${request.id}`,
            type: "registerAck",
            instanceID: request.instanceID,
            payload: {
              sessionToken: "session-token-soft-fail",
              registeredAt,
              registrationEpoch: "epoch-register-soft-fail",
              brokerPid: process.pid,
            },
          }),
        )
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  const client = await brokerClient.connect(endpoint, {
    bridge: {
      collectStatusSnapshot: async () => ({ ok: true }),
      collectNotificationCandidates: async () => {
        throw new Error("collect-notification-candidates-failed")
      },
    },
  })

  try {
    const ack = await client.registerInstance({ instanceID: "instance-register-soft-fail", pid: process.pid })
    assert.equal(ack.sessionToken, "session-token-soft-fail")
    assert.equal(ack.registeredAt, registeredAt)
    assert.equal(ack.registrationEpoch, "epoch-register-soft-fail")
    assert.equal(ack.brokerPid, process.pid)
  } finally {
    await client.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("重复同步同一请求复用 canonical request handle，且终态不视为 open/replyable", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-canonical-request-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-task3",
    userId: "u-task3",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-canonical-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  const makeSyncEnvelope = (requestID) => ({
    id: `sync-${requestID}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: "syncWechatNotifications",
    instanceID: "instance-task3",
    sessionToken: "token-task3",
    payload: {
      candidates: [
        {
          idempotencyKey: `question-instance-task3-${requestID}`,
          kind: "question",
          requestID,
          createdAt: 1_700_300_000_000,
          routeKey: `bridge-route-${requestID}`,
          handle: "q999",
        },
      ],
    },
  })

  const registerAndSync = (socket, requestID) =>
    new Promise((resolve, reject) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        while (true) {
          const newlineIndex = buffer.indexOf("\n")
          if (newlineIndex === -1) break
          const line = buffer.slice(0, newlineIndex + 1)
          buffer = buffer.slice(newlineIndex + 1)
          try {
            const envelope = protocol.parseEnvelopeLine(line)
            if (envelope.type === "registerAck") {
              const sessionToken = envelope.payload?.sessionToken
              const syncEnvelope = makeSyncEnvelope(requestID)
              if (typeof sessionToken !== "string" || sessionToken.length === 0) {
                reject(new Error("registerAck missing sessionToken"))
                return
              }
              syncEnvelope.sessionToken = sessionToken
              socket.write(protocol.serializeEnvelope(syncEnvelope))
              resolve()
            }
          } catch (error) {
            reject(error)
          }
        }
      })
      socket.on("error", reject)
      socket.write(
        protocol.serializeEnvelope({
          id: `register-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: "registerInstance",
          instanceID: "instance-task3",
          payload: { pid: process.pid },
        }),
      )
    })

  const socket = net.createConnection(endpoint)

  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })

    await registerAndSync(socket, "req-canonical-1")
    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.length, 1)
      return pending
    })

    const firstOpen = await requestStore.findOpenRequestByIdentity({
      kind: "question",
      requestID: "req-canonical-1",
      wechatAccountId: "wx-task3",
      userId: "u-task3",
      scopeKey: "instance-task3",
    })
    assert.equal(firstOpen?.handle, "q1")

    await registerAndSync(socket, "  REQ-CANONICAL-1  ")

    const secondOpen = await requestStore.findOpenRequestByIdentity({
      kind: "question",
      requestID: "req-canonical-1",
      wechatAccountId: "wx-task3",
      userId: "u-task3",
      scopeKey: "instance-task3",
    })
    assert.equal(secondOpen?.handle, "q1")
    assert.equal(secondOpen?.routeKey, firstOpen?.routeKey)

    const pending = await notificationStore.listPendingNotifications()
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.handle, secondOpen?.handle)
    assert.equal(pending[0]?.routeKey, secondOpen?.routeKey)

    await requestStore.markRequestAnswered({
      kind: "question",
      routeKey: secondOpen.routeKey,
      answeredAt: 1_700_300_001_000,
    })

    const openByHandleAfterTerminal = await requestStore.findOpenRequestByHandle({
      kind: "question",
      handle: "q1",
    })
    const openByIdentityAfterTerminal = await requestStore.findOpenRequestByIdentity({
      kind: "question",
      requestID: "req-canonical-1",
      wechatAccountId: "wx-task3",
      userId: "u-task3",
      scopeKey: "instance-task3",
    })

    assert.equal(openByHandleAfterTerminal, undefined)
    assert.equal(openByIdentityAfterTerminal, undefined)
  } finally {
    socket.destroy()
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("并发 sync 新请求时 broker 分配的 open handle 必须唯一", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-concurrent-handle-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-concurrent",
    userId: "u-concurrent",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-concurrent-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  async function connectAndRegister(instanceID) {
    const socket = net.createConnection(endpoint)
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })

    const sessionToken = await new Promise((resolve, reject) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        while (true) {
          const newlineIndex = buffer.indexOf("\n")
          if (newlineIndex === -1) break
          const line = buffer.slice(0, newlineIndex + 1)
          buffer = buffer.slice(newlineIndex + 1)
          try {
            const envelope = protocol.parseEnvelopeLine(line)
            if (envelope.type === "registerAck") {
              const token = envelope.payload?.sessionToken
              if (typeof token !== "string" || token.length === 0) {
                reject(new Error("registerAck missing sessionToken"))
                return
              }
              resolve(token)
            }
          } catch (error) {
            reject(error)
          }
        }
      })
      socket.once("error", reject)
      socket.write(
        protocol.serializeEnvelope({
          id: `register-${instanceID}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: "registerInstance",
          instanceID,
          payload: { pid: process.pid },
        }),
      )
    })

    return { socket, sessionToken }
  }

  const first = await connectAndRegister("instance-concurrent-a")
  const second = await connectAndRegister("instance-concurrent-b")

  try {
    const sendSync = (socket, sessionToken, requestID) => {
      socket.write(
        protocol.serializeEnvelope({
          id: `sync-${requestID}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: "syncWechatNotifications",
          instanceID: requestID.includes("-a") ? "instance-concurrent-a" : "instance-concurrent-b",
          sessionToken,
          payload: {
            candidates: [
              {
                idempotencyKey: `question-concurrent-${requestID}`,
                kind: "question",
                requestID,
                createdAt: 1_700_400_000_000,
                routeKey: `bridge-route-${requestID}`,
                handle: "q999",
              },
            ],
          },
        }),
      )
    }

    await Promise.all([
      Promise.resolve().then(() => sendSync(first.socket, first.sessionToken, "req-concurrent-a")),
      Promise.resolve().then(() => sendSync(second.socket, second.sessionToken, "req-concurrent-b")),
    ])

    const open = await waitFor(async () => {
      const all = await requestStore.listActiveRequests()
      const questions = all.filter((item) => item.kind === "question" && item.status === "open")
      assert.equal(questions.length, 2)
      return questions
    })

    const handles = open.map((item) => item.handle)
    assert.equal(new Set(handles).size, handles.length)
  } finally {
    first.socket.destroy()
    second.socket.destroy()
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：总开关关闭时不发送任何通知", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-global-off-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: false,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-global-off-question-1",
      routeKey: "task4-route-question-1",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_000_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-global-off-question-1",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-route-question-1",
      handle: "q1",
      createdAt: 1_700_500_000_001,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-global-off-question-1"), "utf8"))
    assert.equal(record.status, "pending")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：question/permission/sessionError 各自受子开关控制", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-kind-switch-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: false,
          permission: true,
          sessionError: false,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-kind-switch-question",
      routeKey: "task4-route-question",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_100_000,
    })
    await createOpenRequest(requestStore, {
      kind: "permission",
      requestID: "req-task4-kind-switch-permission",
      routeKey: "task4-route-permission",
      handle: "p1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_100_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-kind-switch-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-route-question",
      handle: "q1",
      createdAt: 1_700_500_100_001,
    })
    await notificationStore.upsertNotification({
      idempotencyKey: "task4-kind-switch-permission",
      kind: "permission",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-route-permission",
      handle: "p1",
      createdAt: 1_700_500_100_002,
    })
    await notificationStore.upsertNotification({
      idempotencyKey: "task4-kind-switch-session-error",
      kind: "sessionError",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_100_003,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    assert.match(String(sendCalls[0].text), /权限|allow|permission/i)

    const questionRecord = JSON.parse(await readFile(statePaths.notificationStatePath("task4-kind-switch-question"), "utf8"))
    const permissionRecord = JSON.parse(await readFile(statePaths.notificationStatePath("task4-kind-switch-permission"), "utf8"))
    const sessionErrorRecord = JSON.parse(await readFile(statePaths.notificationStatePath("task4-kind-switch-session-error"), "utf8"))
    assert.equal(questionRecord.status, "pending")
    assert.equal(permissionRecord.status, "sent")
    assert.equal(sessionErrorRecord.status, "pending")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：缺少 primaryBinding.userId 时不发送", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-missing-user-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-missing-user-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-route-missing-user-question",
      handle: "q1",
      createdAt: 1_700_500_200_001,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-missing-user-question"), "utf8"))
    assert.equal(record.status, "pending")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：发送成功后记录 sent", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-sent-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-sent-question",
      routeKey: "task4-route-sent-question",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_300_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-sent-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-route-sent-question",
      handle: "q1",
      createdAt: 1_700_500_300_001,
    })

    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {},
    })
    await dispatcher.drainOutboundMessages()

    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-sent-question"), "utf8"))
    assert.equal(record.status, "sent")
    assert.equal(typeof record.sentAt, "number")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：发送失败后记录 failed，且同一轮 drain 不会无限重试", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-failed-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-failed-session-error",
      kind: "sessionError",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_400_001,
    })

    let sendAttempts = 0
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        sendAttempts += 1
        throw new Error("mock-send-failed")
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendAttempts, 1)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-failed-session-error"), "utf8"))
    assert.equal(record.status, "failed")
    assert.equal(typeof record.failedAt, "number")
    assert.match(String(record.failureReason), /mock-send-failed/i)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：failed 记录只有在 token 已重新激活后才会回到 pending，并携带 live contextToken 发送", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-reactivate-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)
  const tokenStore = await import(`${DIST_TOKEN_STORE_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-reactivated-question",
      routeKey: "task4-reactivated-route",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_410_000,
    })

    await tokenStore.upsertInboundToken({
      wechatAccountId: "wx-main",
      userId: "u-main",
      contextToken: "ctx-before-fail",
      updatedAt: 1_700_500_410_001,
      source: "question",
      sourceRef: "req-task4-reactivated-question",
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-reactivated-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-reactivated-route",
      handle: "q1",
      createdAt: 1_700_500_410_002,
    })

    const failingDispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        throw new Error("mock-send-failed-once")
      },
    })
    await failingDispatcher.drainOutboundMessages()

    const failedRecord = JSON.parse(await readFile(statePaths.notificationStatePath("task4-reactivated-question"), "utf8"))
    assert.equal(failedRecord.status, "failed")
    assert.match(String(failedRecord.failureReason), /mock-send-failed-once/i)

    const stale = await tokenStore.markTokenStale({
      wechatAccountId: "wx-main",
      userId: "u-main",
      staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
    })
    assert.equal(stale.staleReason, tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON)

    const stillFailed = await notificationStore.upsertNotification({
      idempotencyKey: "task4-reactivated-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-reactivated-route",
      handle: "q1",
      createdAt: 1_700_500_410_050,
    })
    assert.equal(stillFailed.status, "failed")

    const pendingBeforeReactivation = await notificationStore.listPendingNotifications()
    assert.equal(pendingBeforeReactivation.some((record) => record.idempotencyKey === "task4-reactivated-question"), false)

    await tokenStore.upsertInboundToken({
      wechatAccountId: "wx-main",
      userId: "u-main",
      contextToken: "ctx-reactivated",
      updatedAt: 1_700_500_410_100,
      source: "message",
      sourceRef: "/status",
    })

    const reopened = await notificationStore.upsertNotification({
      idempotencyKey: "task4-reactivated-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-reactivated-route",
      handle: "q1",
      createdAt: 1_700_500_410_101,
    })
    assert.equal(reopened.status, "pending")
    assert.equal(reopened.failedAt, undefined)
    assert.equal(reopened.failureReason, undefined)

    const pending = await notificationStore.listPendingNotifications()
    assert.equal(pending.some((record) => record.idempotencyKey === "task4-reactivated-question"), true)

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0]?.contextToken, "ctx-reactivated")

    const sentRecord = JSON.parse(await readFile(statePaths.notificationStatePath("task4-reactivated-question"), "utf8"))
    assert.equal(sentRecord.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：token stale 时 pending 保持不可发送，token live 后才会使用持久化 contextToken 发送", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-stale-skip-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)
  const tokenStore = await import(`${DIST_TOKEN_STORE_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-stale-pending-question",
      routeKey: "task4-stale-pending-route",
      handle: "q2",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_420_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-stale-pending-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-stale-pending-route",
      handle: "q2",
      createdAt: 1_700_500_420_001,
    })
    await tokenStore.markTokenStale({
      wechatAccountId: "wx-main",
      userId: "u-main",
      staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const pendingWhileStale = JSON.parse(await readFile(statePaths.notificationStatePath("task4-stale-pending-question"), "utf8"))
    assert.equal(pendingWhileStale.status, "pending")

    await tokenStore.upsertInboundToken({
      wechatAccountId: "wx-main",
      userId: "u-main",
      contextToken: "ctx-live-after-status",
      updatedAt: 1_700_500_420_100,
      source: "message",
      sourceRef: "/status",
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0]?.contextToken, "ctx-live-after-status")
    const sentAfterReactivation = JSON.parse(await readFile(statePaths.notificationStatePath("task4-stale-pending-question"), "utf8"))
    assert.equal(sentAfterReactivation.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：stale 期间积压的 sessionError 在重新激活后不会被补发为陈旧告警", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-session-error-reactivation-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)
  const tokenStore = await import(`${DIST_TOKEN_STORE_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await tokenStore.markTokenStale({
      wechatAccountId: "wx-main",
      userId: "u-main",
      staleReason: tokenStore.NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-session-error-stale-replay",
      kind: "sessionError",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_430_001,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls.length, 0)

    const pendingWhileStale = JSON.parse(await readFile(statePaths.notificationStatePath("task4-session-error-stale-replay"), "utf8"))
    assert.equal(pendingWhileStale.status, "pending")

    await tokenStore.upsertInboundToken({
      wechatAccountId: "wx-main",
      userId: "u-main",
      contextToken: "ctx-status-reactivated",
      updatedAt: 1_700_500_430_100,
      source: "message",
      sourceRef: "/status",
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const suppressedAfterReactivation = JSON.parse(await readFile(statePaths.notificationStatePath("task4-session-error-stale-replay"), "utf8"))
    assert.equal(suppressedAfterReactivation.status, "suppressed")
    assert.equal(typeof suppressedAfterReactivation.suppressedAt, "number")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：并发 drain 竞争下，已 sent 记录不会被失败分支回写成 failed", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-concurrent-race-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task6-race-no-downgrade-question",
      routeKey: "task6-race-no-downgrade-route",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_500_450_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task6-race-no-downgrade-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task6-race-no-downgrade-route",
      handle: "q1",
      createdAt: 1_700_500_450_001,
    })

    let sendCalls = 0
    let releaseFirstSend
    const firstSendReleased = new Promise((resolve) => {
      releaseFirstSend = resolve
    })
    let markFirstSendStarted
    const firstSendStarted = new Promise((resolve) => {
      markFirstSendStarted = resolve
    })
    let listPendingCalls = 0
    let releaseSecondPendingList
    const secondPendingListReleased = new Promise((resolve) => {
      releaseSecondPendingList = resolve
    })
    let markSecondPendingListObserved
    const secondPendingListObserved = new Promise((resolve) => {
      markSecondPendingListObserved = resolve
    })

    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        sendCalls += 1
        if (sendCalls === 1) {
          markFirstSendStarted()
          await firstSendReleased
          return
        }

        throw new Error("duplicate-send-should-not-happen")
      },
      notificationStateOps: {
        listPendingNotifications: async () => {
          listPendingCalls += 1
          const pending = await notificationStore.listPendingNotifications()
          if (listPendingCalls === 2) {
            markSecondPendingListObserved()
            await secondPendingListReleased
          }
          return pending
        },
      },
    })

    const firstDrain = dispatcher.drainOutboundMessages()
    await firstSendStarted
    const secondDrain = dispatcher.drainOutboundMessages()
    await secondPendingListObserved
    releaseSecondPendingList()
    await assert.doesNotReject(() => secondDrain)
    releaseFirstSend()
    await assert.doesNotReject(() => firstDrain)

    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task6-race-no-downgrade-question"), "utf8"))
    assert.equal(sendCalls, 1)
    assert.equal(record.status, "sent")
    assert.equal(record.failureReason, undefined)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("status runtime: 支持注入 drainOutboundMessages，并复用 runtime 的 sendMessage helper", async () => {
  const runtimeModule = await import(`${DIST_WECHAT_STATUS_RUNTIME_MODULE}?reload=${Date.now()}`)

  const sendCalls = []
  let drainCalls = 0
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 1,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "wx-runtime",
        token: "token-runtime",
        baseUrl: "https://wx-runtime.example.com",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-runtime-1",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    drainOutboundMessages: async ({ sendMessage }) => {
      drainCalls += 1
      if (drainCalls === 1) {
        await sendMessage({ to: "u-runtime", text: "runtime-drain-message", contextToken: "ctx-runtime" })
      }
    },
  })

  await runtime.start()
  try {
    await waitFor(() => drainCalls >= 1 && sendCalls.length >= 1)
  } finally {
    await runtime.close()
  }

  assert.equal(drainCalls >= 1, true)
  assert.equal(sendCalls[0]?.to, "u-runtime")
  assert.equal(sendCalls[0]?.text, "runtime-drain-message")
  assert.equal(sendCalls[0]?.opts?.baseUrl, "https://wx-runtime.example.com")
  assert.equal(sendCalls[0]?.opts?.token, "token-runtime")
  assert.equal(sendCalls[0]?.opts?.contextToken, "ctx-runtime")
})

test("broker-entry lifecycle: 创建 dispatcher 并在 runtime 注入 drainOutboundMessages", async () => {
  const brokerEntry = await import(`${DIST_BROKER_ENTRY_MODULE}?reload=${Date.now()}`)

  let drainInjectedCount = 0
  let dispatcherCreatedCount = 0
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createNotificationDispatcher: () => {
      dispatcherCreatedCount += 1
      return {
        drainOutboundMessages: async () => {
          drainInjectedCount += 1
        },
      }
    },
    createStatusRuntime: ({ drainOutboundMessages }) => ({
      start: async () => {
        await drainOutboundMessages()
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.equal(dispatcherCreatedCount, 1)
  assert.equal(drainInjectedCount, 1)
})

test("通知文案格式化：question 输出题面 题型 选项 与回复格式", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-rich-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-rich-1",
    handle: "q8",
    createdAt: 1_700_600_100_000,
    status: "pending",
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  assert.match(questionText, /请选择发布环境/)
  assert.match(questionText, /类型：单选/)
  assert.match(questionText, /1\. staging/)
  assert.match(questionText, /\/reply q8 1/)
})

test("通知文案格式化：permission 输出标题 类型 与 allow 动作说明", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}`)

  const permissionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "permission-rich-1",
    kind: "permission",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-permission-rich-1",
    handle: "p3",
    createdAt: 1_700_600_100_001,
    status: "pending",
    prompt: {
      title: "允许执行 shell 命令",
      type: "command",
    },
  })

  assert.match(permissionText, /允许执行 shell 命令/)
  assert.match(permissionText, /类型：command/)
  assert.match(permissionText, /\/allow p3 once/)
  assert.match(permissionText, /\/allow p3 always/)
  assert.match(permissionText, /\/allow p3 reject/)
})

test("通知分发：发送成功后若 markNotificationSent 因竞争失败，不应降级写成 failed", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-race-sent-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-race-sent-question",
      routeKey: "task4-race-route-question",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_501_000_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-race-sent-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task4-race-route-question",
      handle: "q1",
      createdAt: 1_700_501_000_001,
    })

    let sendCalls = 0
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        sendCalls += 1
        await notificationStore.markNotificationSent({
          idempotencyKey: "task4-race-sent-question",
          sentAt: Date.now(),
        })
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls, 1)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-race-sent-question"), "utf8"))
    assert.equal(record.status, "sent")
    assert.equal(record.failureReason, undefined)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：rebind 后 binding 与记录不一致时，旧 pending 不应发送给新用户", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-rebind-filter-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await createOpenRequest(requestStore, {
      kind: "question",
      requestID: "req-task4-rebind-old-user-question",
      routeKey: "task4-rebind-route-question",
      handle: "q1",
      wechatAccountId: "wx-old",
      userId: "u-old",
      createdAt: 1_700_501_100_000,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task4-rebind-old-user-question",
      kind: "question",
      wechatAccountId: "wx-old",
      userId: "u-old",
      routeKey: "task4-rebind-route-question",
      handle: "q1",
      createdAt: 1_700_501_100_001,
    })

    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-new", userId: "u-new" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task4-rebind-old-user-question"), "utf8"))
    assert.equal(record.status, "pending")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：已终态 request 对应的 pending 通知会被 suppress，不会后续补发", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-terminal-suppress-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
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
      requestID: "req-terminal-question",
      routeKey: "route-terminal-question",
      handle: "q1",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_510_000_001,
    })
    await requestStore.markRequestAnswered({
      kind: "question",
      routeKey: "route-terminal-question",
      answeredAt: 1_700_510_000_002,
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task7-terminal-question-pending",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-terminal-question",
      handle: "q1",
      createdAt: 1_700_510_000_003,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task7-terminal-question-pending"), "utf8"))
    assert.equal(record.status, "suppressed")
    assert.equal(typeof record.suppressedAt, "number")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：同一 sessionError 在未恢复前跨多轮 drain 仅发送一次", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-session-error-no-spam-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "task6-session-error-no-spam",
      kind: "sessionError",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_600_000_001,
    })

    let sendCalls = 0
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        sendCalls += 1
      },
    })

    await dispatcher.drainOutboundMessages()
    await dispatcher.drainOutboundMessages()
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls, 1)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("task6-session-error-no-spam"), "utf8"))
    assert.equal(record.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：drain 会按保留窗口清理过期终态通知", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-dispatch-retention-cleanup-")
  const previousRetentionMs = process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS
  process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS = "500"

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  const originalDateNow = Date.now
  Date.now = () => 1_700_700_000_000

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-main", userId: "u-main" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    const oldResolved = await notificationStore.upsertNotification({
      idempotencyKey: "task6-retention-old-resolved",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task6-route-old-resolved",
      handle: "q1",
      createdAt: 1_700_699_999_000,
    })
    await notificationStore.markNotificationSent({
      idempotencyKey: oldResolved.idempotencyKey,
      sentAt: 1_700_699_999_100,
    })
    await notificationStore.markNotificationResolved({
      idempotencyKey: oldResolved.idempotencyKey,
      resolvedAt: 1_700_699_999_200,
    })

    const freshResolved = await notificationStore.upsertNotification({
      idempotencyKey: "task6-retention-fresh-resolved",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "task6-route-fresh-resolved",
      handle: "q2",
      createdAt: 1_700_699_999_700,
    })
    await notificationStore.markNotificationSent({
      idempotencyKey: freshResolved.idempotencyKey,
      sentAt: 1_700_699_999_800,
    })
    await notificationStore.markNotificationResolved({
      idempotencyKey: freshResolved.idempotencyKey,
      resolvedAt: 1_700_699_999_900,
    })

    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {},
    })
    await dispatcher.drainOutboundMessages()

    await assert.rejects(
      () => readFile(statePaths.notificationStatePath("task6-retention-old-resolved"), "utf8"),
      /enoent/i,
    )

    const freshRaw = await readFile(statePaths.notificationStatePath("task6-retention-fresh-resolved"), "utf8")
    const fresh = JSON.parse(freshRaw)
    assert.equal(fresh.status, "resolved")
  } finally {
    Date.now = originalDateNow
    if (previousRetentionMs === undefined) {
      delete process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS
    } else {
      process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS = previousRetentionMs
    }
    await isolatedWechatStateRoot.restore()
  }
})

test("broker 重启后重复同步同一 open request 不重发；出现新 open requestID 后可再次发送", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-restart-dedupe-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-task6",
    userId: "u-task6",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-task6", userId: "u-task6" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-restart-dedupe-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const registerAndSync = async ({ requestID, idempotencyKey }) => {
    const socket = net.createConnection(endpoint)
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })

    await new Promise((resolve, reject) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        while (true) {
          const newlineIndex = buffer.indexOf("\n")
          if (newlineIndex === -1) break
          const line = buffer.slice(0, newlineIndex + 1)
          buffer = buffer.slice(newlineIndex + 1)
          try {
            const envelope = protocol.parseEnvelopeLine(line)
            if (envelope.type === "registerAck") {
              const sessionToken = envelope.payload?.sessionToken
              if (typeof sessionToken !== "string" || sessionToken.length === 0) {
                reject(new Error("registerAck missing sessionToken"))
                return
              }
              socket.write(
                protocol.serializeEnvelope({
                  id: `sync-${requestID}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  type: "syncWechatNotifications",
                  instanceID: "instance-task6",
                  sessionToken,
                  payload: {
                    candidates: [
                      {
                        idempotencyKey,
                        kind: "question",
                        requestID,
                        createdAt: 1_700_800_000_000,
                        routeKey: `bridge-route-${requestID}`,
                        handle: "q999",
                      },
                    ],
                  },
                }),
              )
              resolve()
              return
            }
          } catch (error) {
            reject(error)
            return
          }
        }
      })
      socket.once("error", reject)
      socket.write(
        protocol.serializeEnvelope({
          id: `register-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: "registerInstance",
          instanceID: "instance-task6",
          payload: { pid: process.pid },
        }),
      )
    })

    socket.destroy()
  }

  let server = await brokerServer.startBrokerServer(endpoint)
  try {
    await registerAndSync({ requestID: "req-task6", idempotencyKey: "question-instance-task6-req-task6-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-open"), true)
    })

    let sendCalls = 0
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async () => {
        sendCalls += 1
      },
    })
    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls, 1)

    await server.close()
    server = await brokerServer.startBrokerServer(endpoint)
    await registerAndSync({ requestID: "req-task6", idempotencyKey: "question-instance-task6-req-task6-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-open"), false)
    })
    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls, 1)

    await server.close()
    server = await brokerServer.startBrokerServer(endpoint)
    await registerAndSync({ requestID: "req-task6-next", idempotencyKey: "question-instance-task6-req-task6-next-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-next-open"), true)
    })

    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls, 2)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})
