import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

function importServer(label) {
  return import(`../dist/wechat/broker-server.js?reload=${Date.now()}-${label}`)
}

function importClient(label) {
  return import(`../dist/wechat/broker-client.js?reload=${Date.now()}-${label}`)
}

function importProtocol(label) {
  return import(`../dist/wechat/protocol.js?reload=${Date.now()}-${label}`)
}

function importStore(label) {
  return import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-${label}`)
}

function importStatePaths(label) {
  return import(`../dist/wechat/state-paths.js?reload=${Date.now()}-${label}`)
}

function importBridge(label) {
  return import(`../dist/wechat/bridge.js?reload=${Date.now()}-${label}`)
}

function listenTcpServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server.address())
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForAsync(predicate, timeoutMs = 4000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return
      }
    } catch {
      // keep polling
    }
    await delay(intervalMs)
  }
  if (!await predicate()) {
    throw new Error("waitForAsync timeout")
  }
}

test("ws lifecycle: broker client 不再让并发 request 共用单 pending 槽", async () => {
  const protocol = await importProtocol("client-multi-pending")
  const brokerClient = await importClient("client-multi-pending")

  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buffer = ""

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = buffer.slice(0, newlineIndex + 1)
        buffer = buffer.slice(newlineIndex + 1)
        const envelope = protocol.parseEnvelopeLine(line)

        if (envelope.type === "ping") {
          setTimeout(() => {
            socket.write(protocol.serializeEnvelope({
              id: `pong-${envelope.id}`,
              type: "pong",
              payload: { message: "pong" },
            }))
          }, 40)
          continue
        }

        if (envelope.type === "registerInstance") {
          socket.write(protocol.serializeEnvelope({
            id: `registerAck-${envelope.id}`,
            type: "registerAck",
            instanceID: envelope.instanceID,
            payload: {
              sessionToken: "session-token-1",
              registeredAt: 1_700_000_100_000,
              registrationEpoch: "epoch-1",
              brokerPid: 4242,
            },
          }))
        }
      }
    })
  })

  const address = await listenTcpServer(server)
  const endpoint = `tcp://127.0.0.1:${address.port}`
  const client = await brokerClient.connect(endpoint)

  try {
    const [pong, register] = await Promise.all([
      client.ping(),
      client.registerInstance({
        instanceID: "inst-1",
        pid: 4242,
      }),
    ])

    assert.equal(pong.type, "pong")
    assert.equal(register.sessionToken, "session-token-1")
    assert.equal(register.registrationEpoch, "epoch-1")
  } finally {
    await client.close().catch(() => {})
    for (const socket of sockets) {
      socket.destroy()
    }
    await closeServer(server)
  }
})

test("ws lifecycle: bridge register 后 broker 只要求 replay 缺失事件，不无脑 full sync", async () => {
  const server = await importServer("register-replay")
  const store = await importStore("register-replay")
  const state = store.createEmptyBrokerState()

  store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    ackedEventSeq: 8,
  })

  const broker = server.createBrokerWsCoordinator({ state })
  const registerResult = broker.registerBridge({
    protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
    stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 0,
    lastSentEventSeq: 12,
  })

  assert.equal(registerResult.accepted, true)
  assert.equal(registerResult.ack.payload.needReplay, true)
  assert.equal(registerResult.ack.payload.needFullSync, false)
  assert.equal(registerResult.control?.type, "requestReplay")
  assert.equal(registerResult.control?.payload.fromEventSeq, 9)
  assert.equal(registerResult.control?.payload.toEventSeq, 12)
})

test("ws lifecycle: commandAccepted 之后 broker 不再重投同一 commandId", async () => {
  const server = await importServer("accepted-no-redelivery")
  const broker = server.createBrokerWsCoordinator()

  broker.dispatchCommand({
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    commandId: "cmd-accepted-1",
    type: "replyQuestion",
    payload: {
      requestID: "q-1",
      answers: [{ text: "hello" }],
    },
    target: {
      instanceID: "inst-1",
      requestID: "q-1",
    },
  })

  broker.handleBridgeEvent(
    {
      type: "commandAccepted",
      eventSeq: 1,
      instanceIncarnation: "inc-1",
      payload: {
        commandId: "cmd-accepted-1",
        acceptedAt: 1_700_000_100_000,
      },
    },
    {
      instanceID: "inst-1",
    },
  )

  const reconnect = broker.registerBridge({
    protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
    stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 0,
    lastSentEventSeq: 1,
  })

  assert.equal(reconnect.pendingCommands.length, 0)
  assert.equal(broker.getState().commandLedger["cmd-accepted-1"].status, "accepted")
})

test("ws lifecycle: delivered 但未 accepted 的命令可按同一 commandId 重投", async () => {
  const server = await importServer("delivered-redelivery")
  const broker = server.createBrokerWsCoordinator()

  const firstDelivery = broker.dispatchCommand({
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    commandId: "cmd-delivered-1",
    type: "replyPermission",
    payload: {
      requestID: "perm-1",
      reply: "once",
    },
    target: {
      instanceID: "inst-1",
      requestID: "perm-1",
    },
  })

  const reconnect = broker.registerBridge({
    protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
    stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 0,
    lastSentEventSeq: 0,
  })

  assert.equal(reconnect.pendingCommands.length, 1)
  assert.equal(reconnect.pendingCommands[0].commandId, "cmd-delivered-1")
  assert.equal(reconnect.pendingCommands[0].brokerSeq, firstDelivery?.brokerSeq)
  assert.equal(broker.getState().commandLedger["cmd-delivered-1"].status, "delivered")
})

test("ws lifecycle: fullSyncCompleted 之前不切换到新的活状态视图", async () => {
  const server = await importServer("full-sync-staging")
  const broker = server.createBrokerWsCoordinator()

  broker.getState().active.questions["route-old"] = {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    routeKey: "route-old",
    handle: "q-old",
  }

  const registerResult = broker.registerBridge({
    protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
    stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 0,
    lastSentEventSeq: 0,
  })

  assert.equal(registerResult.control?.type, "requestFullSync")

  broker.handleBridgeEvent(
    {
      type: "questionOpened",
      eventSeq: 10,
      instanceIncarnation: "inc-1",
      payload: {
        routeKey: "route-new",
        requestID: "q-2",
        handle: "q-new",
      },
    },
    {
      instanceID: "inst-1",
      controlId: registerResult.control?.controlId,
    },
  )

  assert.equal(broker.getState().active.questions["route-new"], undefined)
  assert.equal(broker.getState().active.questions["route-old"].handle, "q-old")

  broker.handleBridgeEvent(
    {
      type: "fullSyncCompleted",
      eventSeq: 11,
      instanceIncarnation: "inc-1",
      controlId: registerResult.control?.controlId,
      payload: {
        controlId: registerResult.control?.controlId,
      },
    },
    {
      instanceID: "inst-1",
      controlId: registerResult.control?.controlId,
    },
  )

  assert.equal(broker.getState().active.questions["route-old"], undefined)
  assert.equal(broker.getState().active.questions["route-new"].handle, "q-new")
})

test("ws lifecycle: hello/register 与 registerAck 会按 protocolVersion/stateGeneration 协商", async () => {
  const server = await importServer("register-negotiation")
  const broker = server.createBrokerWsCoordinator({
    protocolVersion: 7,
    stateGeneration: "wechat-ws-v7",
  })

  const registerResult = broker.registerBridge({
    protocolVersion: 6,
    stateGeneration: "wechat-ws-v6",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 0,
    lastSentEventSeq: 0,
  })

  assert.equal(registerResult.accepted, false)
  assert.equal(registerResult.ack.payload.protocolVersion, 7)
  assert.equal(registerResult.ack.payload.stateGeneration, "wechat-ws-v7")
  assert.equal(registerResult.ack.payload.needReplay, false)
  assert.equal(registerResult.ack.payload.needFullSync, true)
  assert.equal(registerResult.control?.type, "requestFullSync")
})

test("ws lifecycle live path: startBrokerServer + broker-client registerHello 会按真实水位返回 fullSync 再 replay", async () => {
  const serverModule = await importServer("live-register-watermark")
  const brokerClient = await importClient("live-register-watermark")

  const server = await serverModule.startBrokerServer("tcp://127.0.0.1:0")
  const client = await brokerClient.connect(server.endpoint)

  try {
    const firstRegister = await client.registerHello({
      protocolVersion: serverModule.WECHAT_BROKER_WS_PROTOCOL_VERSION,
      stateGeneration: serverModule.WECHAT_BROKER_WS_STATE_GENERATION,
      instanceID: "inst-live-1",
      instanceIncarnation: "inc-live-1",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })

    assert.equal(firstRegister.control?.type, "requestFullSync")

    await client.sendBridgeEvent({
      type: "questionOpened",
      eventSeq: 1,
      instanceIncarnation: "inc-live-1",
      payload: {
        instanceID: "inst-live-1",
        requestID: "q-live-1",
        routeKey: "route-live-1",
        handle: "q-live-1",
      },
    }, {
      instanceID: "inst-live-1",
      controlId: firstRegister.control?.controlId,
    })
    await client.sendBridgeEvent({
      type: "fullSyncCompleted",
      eventSeq: 2,
      instanceIncarnation: "inc-live-1",
      controlId: firstRegister.control?.controlId,
      payload: {
        controlId: firstRegister.control?.controlId,
      },
    }, {
      instanceID: "inst-live-1",
      controlId: firstRegister.control?.controlId,
    })

    const replayRegister = await client.registerHello({
      protocolVersion: serverModule.WECHAT_BROKER_WS_PROTOCOL_VERSION,
      stateGeneration: serverModule.WECHAT_BROKER_WS_STATE_GENERATION,
      instanceID: "inst-live-1",
      instanceIncarnation: "inc-live-1",
      lastSeenBrokerSeq: firstRegister.ack.brokerSeq,
      lastSentEventSeq: 4,
    })

    assert.equal(replayRegister.control?.type, "requestReplay")
    assert.equal(replayRegister.control?.payload.fromEventSeq, 3)
    assert.equal(replayRegister.control?.payload.toEventSeq, 4)
  } finally {
    await client.close().catch(() => {})
    await server.close()
  }
})

test("ws lifecycle live path: live register 与 bridge event 会持久化 broker 权威状态快照", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-persist-state-")
  const serverModule = await importServer("live-persist-state")
  const brokerClient = await importClient("live-persist-state")
  const statePaths = await importStatePaths("live-persist-state")

  const server = await serverModule.startBrokerServer("tcp://127.0.0.1:0")
  const client = await brokerClient.connect(server.endpoint)

  try {
    const registerResult = await client.registerHello({
      protocolVersion: serverModule.WECHAT_BROKER_WS_PROTOCOL_VERSION,
      stateGeneration: serverModule.WECHAT_BROKER_WS_STATE_GENERATION,
      instanceID: "inst-persist-1",
      instanceIncarnation: "inc-persist-1",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })

    assert.equal(registerResult.control?.type, "requestFullSync")

    await client.sendBridgeEvent({
      type: "instanceOnline",
      eventSeq: 1,
      instanceIncarnation: "inc-persist-1",
      payload: {
        instanceID: "inst-persist-1",
        connectedAt: 1_700_001_000_000,
      },
    }, {
      instanceID: "inst-persist-1",
      controlId: registerResult.control?.controlId,
    })

    await client.sendBridgeEvent({
      type: "questionOpened",
      eventSeq: 2,
      instanceIncarnation: "inc-persist-1",
      payload: {
        instanceID: "inst-persist-1",
        requestID: "q-persist-1",
        routeKey: "route-persist-1",
        handle: "q-persist-1",
        updatedAt: 1_700_001_000_100,
      },
    }, {
      instanceID: "inst-persist-1",
      controlId: registerResult.control?.controlId,
    })

    await client.sendBridgeEvent({
      type: "fullSyncCompleted",
      eventSeq: 3,
      instanceIncarnation: "inc-persist-1",
      controlId: registerResult.control?.controlId,
      payload: {
        controlId: registerResult.control?.controlId,
      },
    }, {
      instanceID: "inst-persist-1",
      controlId: registerResult.control?.controlId,
    })

    await waitForAsync(async () => {
      const raw = JSON.parse(await readFile(statePaths.brokerStateStorePath(), "utf8"))
      return raw.connections?.["inst-persist-1"]?.["inc-persist-1"]?.lastAckedEventSeq === 3
        && raw.active?.instances?.["inst-persist-1"]?.instanceIncarnation === "inc-persist-1"
        && raw.active?.questions?.["route-persist-1"]?.handle === "q-persist-1"
    })
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedStateRoot.restore()
  }
})

test("ws lifecycle live path: createWechatBridgeLifecycle 在 registerHello 后补齐 compat registerInstance", async () => {
  const bridgeModule = await importBridge("live-compat-register")
  const callOrder = []
  let liveHandlers = null

  const lifecycle = await bridgeModule.createWechatBridgeLifecycle(
    {
      statusCollectionEnabled: true,
      directory: "/workspace/live-compat-register",
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: { list: async () => [] },
        permission: { list: async () => [] },
      },
    },
    {
      connectOrSpawnBrokerImpl: async () => ({ endpoint: "tcp://127.0.0.1:0" }),
      connectImpl: async () => ({
        setLiveHandlers: (handlers) => {
          liveHandlers = handlers
        },
        registerHello: async (payload) => {
          callOrder.push({ type: "hello", payload })
          return {
            ack: {
              protocolVersion: 2,
              stateGeneration: "wechat-ws-v1",
              instanceIncarnation: payload.instanceIncarnation,
              brokerSeq: 1,
              needReplay: false,
              needFullSync: false,
            },
            pendingCommands: [],
          }
        },
        registerInstance: async (meta) => {
          callOrder.push({ type: "compat", meta })
          return {
            sessionToken: "session-live-compat",
            registeredAt: 1_700_000_100_000,
            registrationEpoch: "epoch-live-compat",
            brokerPid: 4242,
          }
        },
        ping: async () => ({ type: "pong", payload: {} }),
        close: async () => {},
      }),
      setIntervalImpl: () => ({ id: Symbol("timer") }),
      clearIntervalImpl: () => {},
    },
  )

  try {
    assert.equal(typeof liveHandlers?.onBrokerControl, "function")
    assert.equal(typeof liveHandlers?.onBrokerCommand, "function")
    assert.deepEqual(callOrder.map((item) => item.type), ["hello", "compat"])
    assert.equal(callOrder[1]?.meta.instanceID, callOrder[0]?.payload.instanceID)
  } finally {
    await lifecycle.close().catch(() => {})
  }
})

test("ws lifecycle live path: createWechatBridgeLifecycle steady keepalive 不再重复走旧 candidate full sync", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-live-lifecycle-")
  const serverModule = await importServer("live-bridge-lifecycle")
  const bridgeModule = await import(`../dist/wechat/bridge.js?reload=${Date.now()}-live-bridge-lifecycle`)
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}-live-bridge-lifecycle`)

  const server = await serverModule.startBrokerServer("tcp://127.0.0.1:0")
  let sessionListCalls = 0
  let sessionStatusCalls = 0
  let questionListCalls = 0
  let permissionListCalls = 0

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-live-lifecycle",
    userId: "u-live-lifecycle",
    boundAt: Date.now(),
  })

  const lifecycle = await bridgeModule.createWechatBridgeLifecycle(
    {
      statusCollectionEnabled: true,
      heartbeatIntervalMs: 20,
      initialBrokerPromise: Promise.resolve({ endpoint: server.endpoint }),
      client: {
        session: {
          list: async () => {
            sessionListCalls += 1
            return []
          },
          status: async () => {
            sessionStatusCalls += 1
            return {}
          },
          todo: async () => [],
          messages: async () => [],
        },
        question: {
          list: async () => {
            questionListCalls += 1
            return []
          },
        },
        permission: {
          list: async () => {
            permissionListCalls += 1
            return []
          },
        },
      },
    },
    {
      setIntervalImpl: (handler) => setInterval(handler, 10),
      clearIntervalImpl: (timer) => clearInterval(timer),
    },
  )

  try {
    await delay(40)
    const initialCalls = {
      sessionListCalls,
      sessionStatusCalls,
      questionListCalls,
      permissionListCalls,
    }

    await delay(80)

    assert.equal(sessionListCalls, initialCalls.sessionListCalls)
    assert.equal(sessionStatusCalls, initialCalls.sessionStatusCalls)
    assert.equal(questionListCalls, initialCalls.questionListCalls)
    assert.equal(permissionListCalls, initialCalls.permissionListCalls)
  } finally {
    await lifecycle.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedStateRoot.restore()
  }
})

test("ws lifecycle live path: requestFullSync 会把 session 与 question 写进 broker 权威视图", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-fullsync-active-view-")
  const serverModule = await importServer("live-fullsync-active-view")
  const bridgeModule = await importBridge("live-fullsync-active-view")
  const operatorStore = await import(`../dist/wechat/operator-store.js?reload=${Date.now()}-live-fullsync-active-view`)
  const statePaths = await importStatePaths("live-fullsync-active-view")

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-live-fullsync-view",
    userId: "u-live-fullsync-view",
    boundAt: Date.now(),
  })

  const server = await serverModule.startBrokerServer("tcp://127.0.0.1:0")

  const lifecycle = await bridgeModule.createWechatBridgeLifecycle(
    {
      statusCollectionEnabled: true,
      initialBrokerPromise: Promise.resolve({ endpoint: server.endpoint }),
      directory: "/workspace/live-fullsync-active-view",
      client: {
        session: {
          list: async () => [{
            id: "session-live-1",
            title: "Live Session 1",
            directory: "/workspace/live-fullsync-active-view",
            time: { updated: 1_700_001_200_000 },
          }],
          status: async () => ({
            "session-live-1": { type: "idle" },
          }),
          todo: async () => [],
          messages: async () => [],
        },
        question: {
          list: async () => [{
            id: "question-live-1",
            sessionID: "session-live-1",
            questions: [{
              header: "Question header",
              question: "Question body",
            }],
          }],
        },
        permission: {
          list: async () => [],
        },
      },
    },
    {
      heartbeatIntervalMs: 60_000,
    },
  )

  try {
    await waitForAsync(async () => {
      const raw = JSON.parse(await readFile(statePaths.brokerStateStorePath(), "utf8"))
      return raw.active?.instances?.["wechat-status-runtime"] !== undefined
        || raw.active?.instances?.[Object.keys(raw.active?.instances ?? {})[0]] !== undefined
    }, 10_000)

    await waitForAsync(async () => {
      const raw = JSON.parse(await readFile(statePaths.brokerStateStorePath(), "utf8"))
      return raw.active?.sessions?.["session-live-1"]?.title === "Live Session 1"
        && Object.keys(raw.active?.questions ?? {}).length >= 1
    }, 10_000)
  } finally {
    await lifecycle.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedStateRoot.restore()
  }
})

test("ws lifecycle: broker ack 后 bridge replay buffer 会裁剪已确认事件", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-ack-trim-")
  const bridgeModule = await import(`../dist/wechat/bridge.js?reload=${Date.now()}-ack-trim`)

  let liveHandlers
  const sentEventSeqs = []
  const fakeClient = {
    async registerHello() {
      return {
        ack: {
          protocolVersion: 2,
          stateGeneration: "wechat-ws-v1",
          instanceIncarnation: "inc-test",
          brokerSeq: 1,
          needReplay: false,
          needFullSync: true,
        },
        control: {
          brokerSeq: 1,
          controlId: "ctl-full-sync-1",
          type: "requestFullSync",
          payload: {
            instanceID: "inst-trim",
            instanceIncarnation: "inc-test",
            reason: "state-missing",
          },
        },
        pendingCommands: [],
      }
    },
    async registerInstance() {
      return {
        sessionToken: "session-trim",
        registeredAt: 1_700_000_100_000,
        registrationEpoch: "epoch-trim",
        brokerPid: 4242,
      }
    },
    async sendBridgeEvent(event) {
      sentEventSeqs.push(event.eventSeq)
      return {
        ackedEventSeq: event.eventSeq,
        instanceIncarnation: event.instanceIncarnation,
      }
    },
    setLiveHandlers(handlers) {
      liveHandlers = handlers
    },
    async ping() {
      return { type: "pong" }
    },
    async close() {},
  }

  const lifecycle = await bridgeModule.createWechatBridgeLifecycle(
    {
      statusCollectionEnabled: true,
      initialBrokerPromise: Promise.resolve({ endpoint: "tcp://127.0.0.1:0" }),
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: { list: async () => [] },
        permission: { list: async () => [] },
      },
    },
    {
      connectImpl: async () => fakeClient,
      setIntervalImpl: () => ({}) ,
      clearIntervalImpl: () => {},
    },
  )

  try {
    assert.deepEqual(sentEventSeqs, [1, 2])

    await liveHandlers.onBrokerControl({
      brokerSeq: 2,
      controlId: "ctl-replay-1",
      type: "requestReplay",
      payload: {
        instanceID: "inst-trim",
        instanceIncarnation: "inc-test",
        fromEventSeq: 1,
        toEventSeq: 1,
      },
    })

    assert.deepEqual(sentEventSeqs, [1, 2])
  } finally {
    await lifecycle.close().catch(() => {})
    await isolatedStateRoot.restore()
  }
})

test("ws lifecycle: 同连接上的 control 与 command push 按到达顺序串行处理", async () => {
  const protocol = await importProtocol("client-serial-push")
  const brokerClient = await importClient("client-serial-push")

  const server = net.createServer((socket) => {
    let buffer = ""

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = buffer.slice(0, newlineIndex + 1)
        buffer = buffer.slice(newlineIndex + 1)
        const envelope = protocol.parseEnvelopeLine(line)
        if (envelope.type !== "ping") {
          continue
        }

        socket.write(protocol.serializeEnvelope({
          id: "push-control-1",
          type: "requestFullSync",
          payload: {
            brokerSeq: 11,
            controlId: "ctl-serial-1",
            type: "requestFullSync",
            payload: {
              instanceID: "inst-serial",
              instanceIncarnation: "inc-serial",
              reason: "state-missing",
            },
          },
        }))
        socket.write(protocol.serializeEnvelope({
          id: "push-command-1",
          type: "replyQuestion",
          payload: {
            brokerSeq: 12,
            commandId: "cmd-serial-1",
            type: "replyQuestion",
            payload: {
              requestID: "q-serial-1",
              answers: [{ text: "serial" }],
            },
          },
        }))
        socket.write(protocol.serializeEnvelope({
          id: `pong-${envelope.id}`,
          type: "pong",
          payload: { message: "pong" },
        }))
      }
    })
  })

  const address = await listenTcpServer(server)
  const endpoint = `tcp://127.0.0.1:${address.port}`
  const client = await brokerClient.connect(endpoint)
  const order = []

  client.setLiveHandlers({
    onBrokerControl: async (control) => {
      order.push(`control:start:${control.controlId}`)
      await delay(30)
      order.push(`control:end:${control.controlId}`)
    },
    onBrokerCommand: async (command) => {
      order.push(`command:${command.commandId}`)
    },
  })

  try {
    const pong = await client.ping()
    assert.equal(pong.type, "pong")
    await delay(80)
    assert.deepEqual(order, [
      "control:start:ctl-serial-1",
      "control:end:ctl-serial-1",
      "command:cmd-serial-1",
    ])
  } finally {
    await client.close().catch(() => {})
    await closeServer(server)
  }
})

test("ws lifecycle: 旧兼容 replyNaturalStop 路径仍可达", async () => {
  const protocol = await importProtocol("compat-reply-natural-stop")
  const brokerClient = await importClient("compat-reply-natural-stop")

  let compatResultReceived = false
  const server = net.createServer((socket) => {
    let buffer = ""

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = buffer.slice(0, newlineIndex + 1)
        buffer = buffer.slice(newlineIndex + 1)
        const envelope = protocol.parseEnvelopeLine(line)

        if (envelope.type === "registerInstance") {
          socket.write(protocol.serializeEnvelope({
            id: `registerAck-${envelope.id}`,
            type: "registerAck",
            instanceID: envelope.instanceID,
            payload: {
              sessionToken: "compat-session-1",
              registeredAt: 1_700_000_100_000,
              registrationEpoch: "compat-epoch-1",
              brokerPid: 4242,
            },
          }))
          setTimeout(() => {
            socket.write(protocol.serializeEnvelope({
              id: "reply-natural-stop-1",
              type: "replyNaturalStop",
              payload: {
                mutationId: "mutation-natural-stop-1",
                sessionID: "session-natural-stop-1",
                text: "stop now",
              },
            }))
          }, 10)
          continue
        }

        if (envelope.type === "replyNaturalStopResult") {
          compatResultReceived = true
        }
      }
    })
  })

  const address = await listenTcpServer(server)
  const endpoint = `tcp://127.0.0.1:${address.port}`
  const client = await brokerClient.connect(endpoint, {
    bridge: {
      collectStatusSnapshot: async () => ({ instanceID: "inst-compat" }),
      collectNotificationCandidates: async () => [],
      handleBrokerEnvelope: async (envelope) => {
        assert.equal(envelope.type, "replyNaturalStop")
        return {
          id: envelope.id,
          type: "replyNaturalStopResult",
          payload: {
            mutationId: "mutation-natural-stop-1",
            ok: true,
          },
        }
      },
    },
  })

  try {
    await client.registerInstance({
      instanceID: "inst-compat",
      pid: 4242,
    })
    await delay(80)
    assert.equal(compatResultReceived, true)
  } finally {
    await client.close().catch(() => {})
    await closeServer(server)
  }
})

test("upgrade: broker 遇到旧状态代际时不会卡死，并能通过 reconnect + full sync 自恢复", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-upgrade-recovery-")

  try {
    const server = await importServer("upgrade-recovery")
    const store = await importStore("upgrade-recovery")
    const statePaths = await importStatePaths("upgrade-recovery")

    await statePaths.ensureWechatStateLayout()
    await writeFile(statePaths.brokerStateSchemaPath(), JSON.stringify({
      protocolVersion: 1,
      stateGeneration: "wechat-ws-v0",
      updatedAt: 1_700_000_000_000,
    }, null, 2), "utf8")
    await writeFile(statePaths.brokerStateStorePath(), JSON.stringify({
      legacy: true,
      active: { questions: { stuck: true } },
    }, null, 2), "utf8")

    const prepared = await store.prepareBrokerStateStoreForStartup({
      protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
      stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
      now: () => 1_700_000_123_456,
    })
    const broker = server.createBrokerWsCoordinator({ state: prepared.state })

    const registerResult = broker.registerBridge({
      protocolVersion: server.WECHAT_BROKER_WS_PROTOCOL_VERSION,
      stateGeneration: server.WECHAT_BROKER_WS_STATE_GENERATION,
      instanceID: "inst-upgrade-1",
      instanceIncarnation: "inc-upgrade-1",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })

    assert.equal(prepared.recoveredFromLegacyState, true)
    assert.equal(registerResult.accepted, true)
    assert.equal(registerResult.control?.type, "requestFullSync")
    assert.equal(registerResult.ack.payload.needFullSync, true)

    broker.handleBridgeEvent(
      {
        type: "questionOpened",
        eventSeq: 1,
        instanceIncarnation: "inc-upgrade-1",
        payload: {
          instanceID: "inst-upgrade-1",
          requestID: "q-upgrade-1",
          routeKey: "route-upgrade-1",
          handle: "qupgrade1",
        },
      },
      {
        instanceID: "inst-upgrade-1",
        controlId: registerResult.control?.controlId,
      },
    )

    assert.equal(broker.getState().active.questions["route-upgrade-1"], undefined)

    broker.handleBridgeEvent(
      {
        type: "fullSyncCompleted",
        eventSeq: 2,
        instanceIncarnation: "inc-upgrade-1",
        controlId: registerResult.control?.controlId,
        payload: {
          controlId: registerResult.control?.controlId,
        },
      },
      {
        instanceID: "inst-upgrade-1",
        controlId: registerResult.control?.controlId,
      },
    )

    assert.equal(broker.getState().active.questions["route-upgrade-1"].handle, "qupgrade1")
  } finally {
    await isolatedStateRoot.restore()
  }
})
