import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

function importProtocol(label) {
  return import(`../dist/wechat/protocol.js?reload=${Date.now()}-${label}`)
}

function importStore(label) {
  return import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-${label}`)
}

function importStatePaths(label) {
  return import(`../dist/wechat/state-paths.js?reload=${Date.now()}-${label}`)
}

function importBrokerEntry(label) {
  return import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-${label}`)
}

function readConnection(state, instanceID, instanceIncarnation) {
  return state.connections[instanceID]?.[instanceIncarnation]
}

test("broker state store: full sync 只替换活状态域，不清 terminal metadata 与 s* occupancy", async () => {
  const store = await importStore("full-sync")
  const state = store.createEmptyBrokerState()

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 1,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_100_000,
    },
  })
  store.applyBridgeEvent(state, {
    type: "questionOpened",
    eventSeq: 2,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      requestID: "q-1",
      routeKey: "route-q-1",
      handle: "q100",
      updatedAt: 1_700_000_100_100,
    },
  })
  store.applyBridgeEvent(state, {
    type: "naturalStopOpened",
    eventSeq: 3,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      handle: "s123",
      replyTarget: {
        instanceID: "inst-1",
        sessionID: "session-1",
      },
      redactedSummary: "stop summary",
      severityAdvice: "reply now",
      updatedAt: 1_700_000_100_200,
    },
  })

  state.terminalMetadata["route-q-terminal"] = {
    reason: "answered",
    terminalResultSent: true,
    retainedUntil: 1_700_000_999_000,
  }
  state.retainedOccupancy.s123 = {
    handle: "s123",
    retainedUntil: 1_700_000_999_999,
  }
  state.active.questions["route-q-2"] = {
    instanceID: "inst-2",
    instanceIncarnation: "inc-9",
    routeKey: "route-q-2",
    handle: "q200",
  }
  state.active.permissions["route-p-2"] = {
    instanceID: "inst-2",
    instanceIncarnation: "inc-9",
    routeKey: "route-p-2",
    handle: "p200",
  }
  state.active.naturalStops.s999 = {
    instanceID: "inst-2",
    instanceIncarnation: "inc-9",
    handle: "s999",
  }
  state.active.retryErrors["retry-inst-2"] = {
    instanceID: "inst-2",
    instanceIncarnation: "inc-9",
    sessionID: "session-inst-2",
  }

  store.applyFullSyncSnapshot(
    state,
    {
      instanceID: "inst-1",
      instanceIncarnation: "inc-1",
    },
    {
      active: {
        instances: {
          "inst-1": {
            instanceID: "inst-1",
            instanceIncarnation: "inc-1",
            online: true,
            connectedAt: 1_700_000_200_000,
          },
        },
        sessions: {
          "session-2": {
            instanceID: "inst-1",
            sessionID: "session-2",
            updatedAt: 1_700_000_200_100,
          },
        },
        questions: {},
        permissions: {},
        naturalStops: {},
        retryErrors: {},
      },
    },
  )

  assert.equal(state.active.questions["route-q-1"], undefined)
  assert.equal(state.active.naturalStops.s123, undefined)
  assert.equal(state.active.questions["route-q-2"].instanceID, "inst-2")
  assert.equal(state.active.permissions["route-p-2"].instanceID, "inst-2")
  assert.equal(state.active.naturalStops.s999.instanceID, "inst-2")
  assert.equal(state.active.retryErrors["retry-inst-2"].instanceID, "inst-2")
  assert.deepEqual(state.terminalMetadata["route-q-terminal"], {
    reason: "answered",
    terminalResultSent: true,
    retainedUntil: 1_700_000_999_000,
  })
  assert.deepEqual(state.retainedOccupancy.s123, {
    handle: "s123",
    retainedUntil: 1_700_000_999_999,
  })
  assert.equal(state.active.sessions["session-2"].sessionID, "session-2")
})

test("broker state store: full sync handle 去重不抢占非目标 scope 的既有 handle", async () => {
  const store = await importStore("full-sync-handle-preserve")
  const state = store.createEmptyBrokerState()

  state.active.questions["route-existing"] = {
    instanceID: "inst-existing",
    instanceIncarnation: "inc-existing",
    routeKey: "route-existing",
    requestID: "request-existing",
    handle: "q1",
    createdAt: 1_700_000_200_000,
  }

  store.applyFullSyncSnapshot(
    state,
    {
      instanceID: "inst-incoming",
      instanceIncarnation: "inc-incoming",
    },
    {
      active: {
        instances: {},
        sessions: {},
        questions: {
          "route-incoming": {
            routeKey: "route-incoming",
            requestID: "request-incoming",
            handle: "q1",
            createdAt: 1_700_000_100_000,
          },
        },
        permissions: {},
        naturalStops: {},
        retryErrors: {},
      },
    },
  )

  assert.equal(state.active.questions["route-existing"].handle, "q1")
  assert.equal(state.active.questions["route-incoming"].handle, "q2")
})

test("broker state store: close event 保留 canonical handle 与已发送终态标记", async () => {
  const store = await importStore("close-preserve-terminal-sent")
  const state = store.createEmptyBrokerState()
  const routeKey = "permission-close-preserve"

  state.active.permissions[routeKey] = {
    instanceID: "inst-close-preserve",
    instanceIncarnation: "inc-close-preserve",
    routeKey,
    requestID: "permission-close-preserve-request",
    handle: "p2",
    scopeKey: "inst-close-preserve",
    createdAt: 1_700_000_300_000,
  }
  state.terminalMetadata[routeKey] = {
    reason: "answered",
    handle: "p2",
    scopeKey: "inst-close-preserve",
    terminalResultSent: true,
  }

  store.applyBridgeEvent(state, {
    type: "permissionClosed",
    eventSeq: 10,
    instanceIncarnation: "inc-close-preserve",
    payload: {
      routeKey,
      handle: "p1",
      reason: "handled",
      updatedAt: 1_700_000_300_500,
    },
  })

  assert.equal(state.terminalMetadata[routeKey].handle, "p2")
  assert.equal(state.terminalMetadata[routeKey].terminalResultSent, true)
  assert.equal(state.legacyHandleClosures.p2?.reason, "handled")
  assert.equal(state.legacyHandleClosures.p1, undefined)
})

test("broker state store: command ledger 保存 queued/delivered/accepted/completed/failed", async () => {
  const store = await importStore("command-ledger")
  const state = store.createEmptyBrokerState()

  const queued = store.upsertBrokerCommand(state, {
    commandId: "cmd-1",
    brokerSeq: 10,
    type: "replyQuestion",
    status: "queued",
    target: {
      instanceID: "inst-1",
      requestID: "q-1",
    },
  })

  assert.equal(queued.status, "queued")

  const delivered = store.upsertBrokerCommand(state, {
    commandId: "cmd-1",
    brokerSeq: 10,
    type: "replyQuestion",
    status: "delivered",
    target: {
      instanceID: "inst-1",
      requestID: "q-1",
    },
  })

  assert.equal(delivered.status, "delivered")
  assert.throws(() => {
    store.markBrokerCommandResult(state, {
      commandId: "cmd-1",
      instanceID: "inst-1",
      instanceIncarnation: "inc-1",
      eventSeq: 13,
      status: "completed",
      completedAt: 1_700_000_299_999,
    })
  }, /accepted/i)

  const accepted = store.markBrokerCommandAccepted(state, {
    commandId: "cmd-1",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    eventSeq: 14,
    acceptedAt: 1_700_000_300_000,
  })

  assert.equal(accepted.status, "accepted")
  assert.equal(accepted.acceptedAt, 1_700_000_300_000)

  const completed = store.markBrokerCommandResult(state, {
    commandId: "cmd-1",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    eventSeq: 15,
    status: "completed",
    completedAt: 1_700_000_300_500,
  })

  assert.equal(completed.status, "completed")
  assert.equal(completed.completedAt, 1_700_000_300_500)

  store.upsertBrokerCommand(state, {
    commandId: "cmd-2",
    brokerSeq: 11,
    type: "replyPermission",
    status: "queued",
    target: {
      instanceID: "inst-1",
      requestID: "perm-1",
    },
  })
  store.markBrokerCommandAccepted(state, {
    commandId: "cmd-2",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    eventSeq: 16,
    acceptedAt: 1_700_000_301_000,
  })
  const failed = store.markBrokerCommandResult(state, {
    commandId: "cmd-2",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    eventSeq: 17,
    status: "failed",
    completedAt: 1_700_000_301_500,
    failure: {
      message: "permission denied",
    },
  })

  assert.equal(failed.status, "failed")
  assert.equal(failed.failure.message, "permission denied")
})

test("ws protocol: ack frame 会推进 lastAckedEventSeq", async () => {
  const protocol = await importProtocol("ack")
  const store = await importStore("ack")
  const state = store.createEmptyBrokerState()

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 1,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_100_000,
    },
  })

  const ack = protocol.createBrokerAckEnvelope({
    ackedEventSeq: 33,
    instanceIncarnation: "inc-1",
  })

  const connection = store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    ...ack.payload,
  })

  assert.equal(connection.lastAckedEventSeq, 33)
  assert.equal(readConnection(state, "inst-1", "inc-1")?.lastAckedEventSeq, 33)

  const staleAck = protocol.createBrokerAckEnvelope({
    ackedEventSeq: 30,
    instanceIncarnation: "inc-1",
  })

  store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    ...staleAck.payload,
  })

  assert.equal(readConnection(state, "inst-1", "inc-1")?.lastAckedEventSeq, 33)
})

test("broker state store: 新 incarnation 建立后旧 incarnation 的迟到 ack 不会回写当前连接状态", async () => {
  const protocol = await importProtocol("late-ack-incarnation")
  const store = await importStore("late-ack-incarnation")
  const state = store.createEmptyBrokerState()

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 1,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_100_000,
    },
  })
  store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    ackedEventSeq: 12,
    instanceIncarnation: "inc-1",
  })

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 2,
    instanceIncarnation: "inc-2",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_200_000,
    },
  })
  store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    ackedEventSeq: 20,
    instanceIncarnation: "inc-2",
  })

  const lateAck = protocol.createBrokerAckEnvelope({
    ackedEventSeq: 99,
    instanceIncarnation: "inc-1",
  })
  store.markConnectionAckedEventSeq(state, {
    instanceID: "inst-1",
    ...lateAck.payload,
  })

  assert.equal(readConnection(state, "inst-1", "inc-2")?.lastAckedEventSeq, 20)
  assert.equal(readConnection(state, "inst-1", "inc-1")?.lastAckedEventSeq, 99)
})

test("broker state store: broker 发送 command/control frame 后推进 lastSentBrokerSeq", async () => {
  const store = await importStore("sent-broker-seq")
  const state = store.createEmptyBrokerState()

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 1,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_100_000,
    },
  })

  const first = store.markConnectionSentBrokerSeq(state, {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    brokerSeq: 41,
  })
  assert.equal(first.lastSentBrokerSeq, 41)

  store.markConnectionSentBrokerSeq(state, {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    brokerSeq: 45,
  })
  store.markConnectionSentBrokerSeq(state, {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    brokerSeq: 44,
  })

  assert.equal(readConnection(state, "inst-1", "inc-1")?.lastSentBrokerSeq, 45)
})

test("broker state store: commandAccepted 与 commandResult 可通过显式上下文归属而不依赖 payload.instanceID", async () => {
  const store = await importStore("command-context")
  const state = store.createEmptyBrokerState()

  store.applyBridgeEvent(state, {
    type: "instanceOnline",
    eventSeq: 1,
    instanceIncarnation: "inc-1",
    payload: {
      instanceID: "inst-1",
      connectedAt: 1_700_000_100_000,
    },
  })
  store.upsertBrokerCommand(state, {
    commandId: "cmd-context-1",
    brokerSeq: 10,
    type: "replyQuestion",
    status: "delivered",
    target: {
      instanceID: "inst-1",
      requestID: "q-ctx-1",
    },
  })

  store.applyBridgeEvent(
    state,
    {
      type: "commandAccepted",
      eventSeq: 2,
      instanceIncarnation: "inc-1",
      payload: {
        commandId: "cmd-context-1",
        acceptedAt: 1_700_000_100_200,
      },
    },
    {
      instanceID: "inst-1",
    },
  )

  assert.equal(state.commandLedger["cmd-context-1"].status, "accepted")
  assert.equal(state.commandLedger["cmd-context-1"].instanceID, "inst-1")

  store.applyBridgeEvent(
    state,
    {
      type: "commandResult",
      eventSeq: 3,
      instanceIncarnation: "inc-1",
      payload: {
        commandId: "cmd-context-1",
        status: "completed",
        completedAt: 1_700_000_100_500,
      },
    },
    {
      instanceID: "inst-1",
    },
  )

  assert.equal(state.commandLedger["cmd-context-1"].status, "completed")
  assert.equal(state.commandLedger["cmd-context-1"].completedAt, 1_700_000_100_500)
})

test("broker state store: requestReplay 记录 in-flight 与 completion 状态", async () => {
  const store = await importStore("request-replay")
  const state = store.createEmptyBrokerState()

  const replay = store.requestBrokerReplay(state, {
    controlId: "ctl-replay-1",
    brokerSeq: 21,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    fromEventSeq: 9,
    toEventSeq: 12,
  })

  assert.equal(replay.status, "inFlight")
  assert.equal(replay.type, "requestReplay")
  assert.equal(store.readBrokerControlRecord(state, "ctl-replay-1")?.toEventSeq, 12)

  const completed = store.markBrokerReplayCompleted(state, {
    controlId: "ctl-replay-1",
    completedEventSeq: 12,
  })

  assert.equal(completed.status, "completed")
  assert.equal(completed.completedEventSeq, 12)
})

test("broker state store: requestFullSync 到 fullSyncCompleted 之前只写 staging，不切换活状态视图", async () => {
  const store = await importStore("request-full-sync")
  const state = store.createEmptyBrokerState()

  state.active.questions["route-old"] = {
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    routeKey: "route-old",
    handle: "q-old",
  }

  const fullSync = store.requestBrokerFullSync(state, {
    controlId: "ctl-full-sync-1",
    brokerSeq: 31,
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    reason: "state-missing",
  })

  assert.equal(fullSync.status, "inFlight")
  assert.equal(fullSync.type, "requestFullSync")

  store.stageBrokerFullSyncEvent(state, {
    controlId: "ctl-full-sync-1",
    event: {
      type: "questionOpened",
      eventSeq: 10,
      instanceIncarnation: "inc-1",
      payload: {
        routeKey: "route-new",
        requestID: "q-new",
        handle: "q-new",
      },
    },
    context: {
      instanceID: "inst-1",
    },
  })

  assert.equal(state.active.questions["route-new"], undefined)
  assert.equal(state.active.questions["route-old"].handle, "q-old")
  assert.equal(
    store.readBrokerFullSyncStage(state, "ctl-full-sync-1")?.active.questions["route-new"].handle,
    "q-new",
  )

  const committed = store.markBrokerFullSyncCompleted(state, {
    controlId: "ctl-full-sync-1",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    eventSeq: 11,
  })

  assert.equal(committed.status, "completed")
  assert.equal(state.active.questions["route-old"], undefined)
  assert.equal(state.active.questions["route-new"].handle, "q-new")
})

test("broker state store: 启动时遇到旧状态代际会忽略旧 store 并写入稳定升级关闭索引", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-state-upgrade-")

  try {
    const store = await importStore("startup-upgrade-reset")
    const statePaths = await importStatePaths("startup-upgrade-reset")

    await mkdir(statePaths.requestKindDir("question"), { recursive: true })
    await mkdir(statePaths.requestKindDir("permission"), { recursive: true })
    await mkdir(statePaths.notificationsDir(), { recursive: true })
    await writeFile(statePaths.brokerStateSchemaPath(), JSON.stringify({
      protocolVersion: 1,
      stateGeneration: "wechat-ws-v0",
      updatedAt: 1_700_000_000_000,
    }, null, 2), "utf8")
    await writeFile(statePaths.brokerStateStorePath(), JSON.stringify({
      legacy: true,
      active: { questions: { broken: true } },
    }, null, 2), "utf8")
    await writeFile(statePaths.requestStatePath("question", "route-legacy-q"), JSON.stringify({
      handle: "qlegacy1",
    }, null, 2), "utf8")
    await writeFile(statePaths.requestStatePath("permission", "route-legacy-p"), JSON.stringify({
      handle: "plegacy1",
    }, null, 2), "utf8")
    await writeFile(statePaths.notificationStatePath("legacy-stop"), JSON.stringify({
      kind: "naturalStop",
      handle: "slegacy1",
    }, null, 2), "utf8")

    const prepared = await store.prepareBrokerStateStoreForStartup({
      protocolVersion: 2,
      stateGeneration: "wechat-ws-v1",
      now: () => 1_700_000_123_456,
    })

    assert.equal(prepared.recoveredFromLegacyState, true)
    assert.deepEqual(prepared.legacyHandleClosures, ["plegacy1", "qlegacy1", "slegacy1"])
    assert.deepEqual(prepared.state.active.questions, {})
    assert.deepEqual(prepared.state.active.permissions, {})
    assert.deepEqual(prepared.state.active.naturalStops, {})

    const persistedSchema = JSON.parse(await readFile(statePaths.brokerStateSchemaPath(), "utf8"))
    assert.equal(persistedSchema.protocolVersion, 2)
    assert.equal(persistedSchema.stateGeneration, "wechat-ws-v1")
    assert.equal(persistedSchema.upgradeCloseReason, "legacy-state-reset-awaiting-full-sync")
    assert.deepEqual(persistedSchema.legacyHandleClosures, ["plegacy1", "qlegacy1", "slegacy1"])
  } finally {
    await isolatedStateRoot.restore()
  }
})

test("upgrade: 旧代际 qid/handle/s* 不会退化成 not found", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-state-upgrade-close-")

  try {
    const brokerEntry = await importBrokerEntry("legacy-handle-close-reason")
    const store = await importStore("legacy-handle-close-reason")

    await store.writeBrokerStateSchemaMarker({
      protocolVersion: 2,
      stateGeneration: "wechat-ws-v1",
      updatedAt: 1_700_000_123_456,
      upgradeCloseReason: "legacy-state-reset-awaiting-full-sync",
      legacyHandleClosures: ["plegacy1", "qlegacy1", "slegacy1"],
    })

    const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
      handleStatusCommand: async () => "status reply",
    })

    const questionResult = await handler({ type: "reply", handle: "qlegacy1", text: "done" })
    const permissionResult = await handler({ type: "allow", handle: "plegacy1", reply: "once", message: "ok" })
    const naturalStopResult = await handler({ type: "reply", handle: "slegacy1", text: "继续处理" })

    assert.match(questionResult, /旧状态代际|升级恢复|full sync/i)
    assert.doesNotMatch(questionResult, /未找到待回复问题/)
    assert.match(permissionResult, /旧状态代际|升级恢复|full sync/i)
    assert.doesNotMatch(permissionResult, /未找到待处理权限请求/)
    assert.match(naturalStopResult, /旧状态代际|升级恢复|full sync/i)
    assert.doesNotMatch(naturalStopResult, /未找到待回复问题/)
  } finally {
    await isolatedStateRoot.restore()
  }
})

test("broker state store: mutation loader 只复用显式注册的 live state，避免磁盘快照覆盖 requestIndex 与 deliveryTokens", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-state-mutation-loader-")

  try {
    const store = await importStore("mutation-loader-live-state")
    const statePaths = await importStatePaths("mutation-loader-live-state")
    const liveState = store.createEmptyBrokerState()
    store.setBrokerStateMutationTarget(liveState)

    store.upsertBrokerIndexedRequest(liveState, {
      kind: "question",
      requestID: "req-live-1",
      routeKey: "route-live-1",
      handle: "qlive1",
      scopeKey: "inst-live-1",
      wechatAccountId: "wx-live-1",
      userId: "user-live-1",
      status: "open",
      createdAt: 1_700_000_500_000,
    })
    store.upsertBrokerDeliveryToken(liveState, {
      wechatAccountId: "wx-live-1",
      userId: "user-live-1",
      contextToken: "ctx-live-1",
      updatedAt: 1_700_000_500_100,
      source: "question",
      sourceRef: "qlive1",
      staleReason: "notification-delivery-failed",
    })

    await mkdir(path.dirname(statePaths.brokerStateStorePath()), { recursive: true })
    await writeFile(statePaths.brokerStateStorePath(), JSON.stringify({
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
      legacyHandleClosures: {},
      requestIndex: {},
      deliveryTokens: {},
      commandLedger: {},
      controlLedger: {},
      fullSync: {
        stagedByControlId: {},
      },
    }, null, 2), "utf8")

    const persistedSnapshot = await store.loadBrokerStateStoreSnapshot()
    assert.equal(persistedSnapshot?.requestIndex["question:route-live-1"], undefined)
    assert.equal(persistedSnapshot?.deliveryTokens["wx-live-1:user-live-1"], undefined)

    const mutableState = await store.loadBrokerStateStoreForMutation()

    assert.equal(mutableState.requestIndex["question:route-live-1"]?.requestID, "req-live-1")
    assert.equal(mutableState.deliveryTokens["wx-live-1:user-live-1"]?.contextToken, "ctx-live-1")
    assert.equal(mutableState.active.questions["route-live-1"]?.handle, "qlive1")
  } finally {
    const store = await importStore("mutation-loader-live-state-cleanup")
    store.setBrokerStateMutationTarget(undefined)
    await isolatedStateRoot.restore()
  }
})

test("broker state store: 快照写入不会让并发读取看到半截 JSON", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-state-atomic-write-")
  const store = await importStore("atomic-write")
  const statePaths = await importStatePaths("atomic-write")

  function createLargeState(label) {
    const state = store.createEmptyBrokerState()
    for (let index = 0; index < 8_000; index += 1) {
      state.active.sessions[`${label}-session-${index}`] = {
        instanceID: `inst-${label}`,
        sessionID: `${label}-session-${index}`,
        title: `${label}-${"x".repeat(256)}`,
        updatedAt: 1_700_010_000_000 + index,
      }
    }
    return state
  }

  try {
    await store.persistBrokerStateStoreSnapshot(store.createEmptyBrokerState())

    let writesFinished = false
    const writes = Promise.all([
      store.persistBrokerStateStoreSnapshot(createLargeState("a")),
      store.persistBrokerStateStoreSnapshot(createLargeState("b")),
      store.persistBrokerStateStoreSnapshot(createLargeState("c")),
    ]).finally(() => {
      writesFinished = true
    })

    const parseErrors = []
    while (!writesFinished) {
      try {
        JSON.parse(await readFile(statePaths.brokerStateStorePath(), "utf8"))
      } catch (error) {
        parseErrors.push(error instanceof Error ? error.message : String(error))
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    await writes

    assert.deepEqual(parseErrors, [])
    JSON.parse(await readFile(statePaths.brokerStateStorePath(), "utf8"))
  } finally {
    await isolatedStateRoot.restore()
  }
})

test("broker state store: retained terminal metadata / s* occupancy / legacy close reason 可由权威视图独立承接", async () => {
  const store = await importStore("authoritative-handle-closures")
  const state = store.createEmptyBrokerState()

  state.terminalMetadata["route-question-terminal"] = {
    reason: "answered",
    terminalResultSent: true,
    retainedUntil: 1_700_001_000_000,
  }
  state.retainedOccupancy.s88 = {
    handle: "s88",
    retainedUntil: 1_700_001_000_100,
  }
  store.writeLegacyHandleClosure(state, {
    kind: "question",
    handle: "q88",
    reason: "upgraded",
    message: "问题入口 q88 已在升级后关闭，请查看新入口或重新获取通知",
  })
  store.writeLegacyHandleClosure(state, {
    kind: "naturalStop",
    handle: "s88",
    reason: "continued",
    message: "中止通知 s88 已结束\n原因：已在电脑端继续处理\n说明：该入口不再接受回复。",
    retainedUntil: 1_700_001_000_100,
  })

  const view = store.readBrokerAuthoritativeView(state)

  assert.deepEqual(view.terminalMetadata["route-question-terminal"], {
    reason: "answered",
    terminalResultSent: true,
    retainedUntil: 1_700_001_000_000,
  })
  assert.deepEqual(view.retainedOccupancy.s88, {
    handle: "s88",
    retainedUntil: 1_700_001_000_100,
  })
  assert.equal(view.legacyHandleClosures.q88?.reason, "upgraded")
  assert.equal(view.legacyHandleClosures.s88?.reason, "continued")
  assert.match(store.readLegacyHandleClosure(state, { kind: "question", handle: "q88" })?.message ?? "", /升级后关闭/)
  assert.match(store.readLegacyHandleClosure(state, { kind: "naturalStop", handle: "s88" })?.message ?? "", /不再接受回复/)
})
