import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
const DIST_QUESTION_INTERACTION_MODULE = "../dist/wechat/question-interaction.js"
const DIST_WECHAT_STATUS_RUNTIME_MODULE = "../dist/wechat/wechat-status-runtime.js"
const DIST_BROKER_ENTRY_MODULE = "../dist/wechat/broker-entry.js"
const DIST_BROKER_STATE_STORE_MODULE = "../dist/wechat/broker-state-store.js"
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

function createBrokerRequestIndexKey(kind, routeKey) {
  return `${kind}:${routeKey}`
}

function createBrokerDeliveryTokenKey(wechatAccountId, userId) {
  return `${wechatAccountId}:${userId}`
}

async function persistAuthoritativeBrokerState(reloadTag, mutator) {
  const brokerStateStore = await import(`${DIST_BROKER_STATE_STORE_MODULE}?reload=${Date.now()}-${reloadTag}`)
  const state = brokerStateStore.createEmptyBrokerState()
  await mutator(state, brokerStateStore)
  await brokerStateStore.persistBrokerStateStoreSnapshot(state)
  return { brokerStateStore, state }
}

async function writeLegacyRequestRecord(statePaths, record) {
  const filePath = statePaths.requestStatePath(record.kind, record.routeKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(record, null, 2))
}

async function writeLegacyTokenRecord(statePaths, wechatAccountId, userId, record) {
  const filePath = statePaths.tokenStatePath(wechatAccountId, userId)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(record, null, 2))
}

async function notificationStoreSeedForRuntimeStale(statePaths) {
  const notificationPath = statePaths.notificationStatePath("notif-runtime-authoritative-stale-q1")
  await mkdir(path.dirname(notificationPath), { recursive: true })
  await writeFile(notificationPath, JSON.stringify({
    idempotencyKey: "notif-runtime-authoritative-stale-q1",
    kind: "question",
    routeKey: "route-runtime-authoritative-stale-q1",
    handle: "q9",
    scopeKey: "instance-runtime-authoritative-stale",
    wechatAccountId: "wx-runtime-authoritative-stale",
    userId: "u-runtime-authoritative-stale",
    createdAt: 1_700_638_000_010,
    status: "sent",
    sentAt: 1_700_638_000_020,
  }, null, 2))
}

let registerAndSyncCandidatesChain = Promise.resolve()

async function registerAndSyncCandidates({ endpoint, protocol, instanceID, candidates }) {
  registerAndSyncCandidatesChain = registerAndSyncCandidatesChain
    .then(async () => {
      void endpoint
      void protocol

      const [notificationStore, requestStore, operatorStore, handleModule] = await Promise.all([
        import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-seed-notification-store`),
        import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-seed-request-store`),
        import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-seed-operator-store`),
        import(`../dist/wechat/handle.js?reload=${Date.now()}-seed-handle`),
      ])

      const binding = await operatorStore.readOperatorBinding()
      if (!binding) {
        throw new Error("operator binding missing")
      }

      const normalizeRequestIdentity = (value) => String(value).trim().toLowerCase()
      const toRequestIdentityKey = (record) => `${record.kind}:${normalizeRequestIdentity(record.requestID)}`
      const toCandidateIdentityKey = (candidate) => `${candidate.kind}:${normalizeRequestIdentity(candidate.requestID)}`
      const toNaturalStopIdentityKey = (input) => {
        const target = input.replyTarget ?? {}
        const targetInstanceID = target.instanceID ?? input.scopeKey
        const targetSessionID = target.sessionID ?? input.sessionID
        if (typeof targetInstanceID !== "string" || typeof targetSessionID !== "string") {
          return undefined
        }
        return `${targetInstanceID.trim().toLowerCase()}:${targetSessionID.trim().toLowerCase()}`
      }
      const createRequestTerminalIdempotencyKey = (record) => `request-terminal-${record.kind}-${record.routeKey}`
      const findReplacementHandle = (record, activeRequests) => activeRequests
        .filter((item) => (
          item.status === "open"
          && item.kind === record.kind
          && item.routeKey !== record.routeKey
          && normalizeRequestIdentity(item.requestID) === normalizeRequestIdentity(record.requestID)
          && item.wechatAccountId === record.wechatAccountId
          && item.userId === record.userId
        ))
        .sort((left, right) => right.createdAt - left.createdAt)[0]?.handle

      const relevantRequestsBeforeSync = (await requestStore.listActiveRequests()).filter((item) => (
        item.scopeKey === instanceID
        && item.wechatAccountId === binding.wechatAccountId
        && item.userId === binding.userId
        && (item.status === "open" || item.terminalResultSent !== true)
      ))
      const relevantNaturalStopsBeforeSync = await notificationStore.listActiveNaturalStopsForScope({
        scopeKey: instanceID,
        wechatAccountId: binding.wechatAccountId,
        userId: binding.userId,
      })

      const currentCandidateIdentityKeys = new Set(
        candidates
          .filter((candidate) => candidate.kind === "question" || candidate.kind === "permission")
          .map((candidate) => toCandidateIdentityKey(candidate)),
      )
      const currentNaturalStopIdentityKeys = new Set(
        candidates
          .filter((candidate) => candidate.kind === "naturalStop")
          .map((candidate) => toNaturalStopIdentityKey(candidate))
          .filter(Boolean),
      )

      for (const candidate of candidates) {
        if (candidate.kind === "sessionError") {
          await notificationStore.upsertNotification({
            idempotencyKey: candidate.idempotencyKey,
            kind: "sessionError",
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            createdAt: candidate.createdAt,
            sessionID: candidate.sessionID,
            action: candidate.action,
            redactedSummary: candidate.redactedSummary,
            severityAdvice: candidate.severityAdvice,
          })
          continue
        }

        if (candidate.kind === "naturalStop") {
          const existingActiveNaturalStop = await notificationStore.findActiveNaturalStopByReplyTarget({
            replyTarget: candidate.replyTarget,
          }).catch(() => undefined)

          if (existingActiveNaturalStop && existingActiveNaturalStop.idempotencyKey !== candidate.idempotencyKey) {
            await notificationStore.markNaturalStopTerminal({
              idempotencyKey: existingActiveNaturalStop.idempotencyKey,
              resolvedAt: Date.now(),
              terminalReason: "continued",
            })
          }

          const canonicalHandle = existingActiveNaturalStop?.idempotencyKey === candidate.idempotencyKey
            ? existingActiveNaturalStop.handle
            : handleModule.createSessionReplyHandle([
                ...(existingActiveNaturalStop?.handle ? [existingActiveNaturalStop.handle] : []),
                ...(await notificationStore.listRetainedNaturalStopHandles()),
              ])

          await notificationStore.upsertNotification({
            idempotencyKey: candidate.idempotencyKey,
            kind: "naturalStop",
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            handle: canonicalHandle,
            scopeKey: candidate.replyTarget.instanceID,
            sessionID: candidate.sessionID,
            replyTarget: candidate.replyTarget,
            redactedSummary: candidate.redactedSummary,
            severityAdvice: candidate.severityAdvice,
            createdAt: candidate.createdAt,
          })
          continue
        }

        const existingOpen = await requestStore.findOpenRequestByIdentity({
          kind: candidate.kind,
          requestID: candidate.requestID,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          scopeKey: instanceID,
        })

        let canonicalRouteKey
        let canonicalHandle

        if (existingOpen) {
          canonicalRouteKey = existingOpen.routeKey
          canonicalHandle = existingOpen.handle
        } else {
          const activeRequests = await requestStore.listActiveRequests()
          const existingHandles = activeRequests
            .filter((item) => item.kind === candidate.kind && item.status === "open")
            .map((item) => item.handle)

          const created = await requestStore.upsertRequest({
            kind: candidate.kind,
            requestID: candidate.requestID,
            routeKey: handleModule.createRouteKey({
              kind: candidate.kind,
              requestID: candidate.requestID,
              scopeKey: instanceID,
            }),
            handle: handleModule.createHandle(candidate.kind, existingHandles),
            scopeKey: instanceID,
            prompt: candidate.prompt,
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            createdAt: candidate.createdAt,
          })

          canonicalRouteKey = created.routeKey
          canonicalHandle = created.handle
        }

        const notificationScopeKey = existingOpen?.scopeKey ?? instanceID
        const mergeableNotification = await notificationStore.findMergeableNotification({
          kind: candidate.kind,
          routeKey: canonicalRouteKey,
          handle: canonicalHandle,
          scopeKey: notificationScopeKey,
          createdAt: candidate.createdAt,
          excludeIdempotencyKey: candidate.idempotencyKey,
        })

        await notificationStore.upsertNotification({
          idempotencyKey: candidate.idempotencyKey,
          kind: candidate.kind,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          routeKey: canonicalRouteKey,
          handle: canonicalHandle,
          scopeKey: notificationScopeKey,
          prompt: candidate.prompt,
          createdAt: candidate.createdAt,
        }, mergeableNotification
          ? {
              initialStatus: "suppressed",
              suppressedAt: Date.now(),
            }
          : undefined)
      }

      const activeRequestsAfterSync = await requestStore.listActiveRequests()
      for (const request of relevantRequestsBeforeSync) {
        if (currentCandidateIdentityKeys.has(toRequestIdentityKey(request))) {
          continue
        }

        const current = await requestStore.findRequestByRouteKey({ kind: request.kind, routeKey: request.routeKey })
        if (!current) {
          continue
        }

        const finalizedAt = Date.now()
        let terminal = current
        if (current.status === "open") {
          terminal = await requestStore.markRequestAnswered({
            kind: current.kind,
            routeKey: current.routeKey,
            answeredAt: finalizedAt,
          }).catch(async (error) => {
            if (!(error instanceof Error) || !/request is not open/i.test(error.message)) {
              throw error
            }
            return requestStore.findRequestByRouteKey({ kind: current.kind, routeKey: current.routeKey })
          })
        }

        if (!terminal) {
          continue
        }

        if (terminal.status === "answered") {
          const replacementHandle = findReplacementHandle(terminal, activeRequestsAfterSync)
          if (replacementHandle) {
            terminal = await requestStore.markTerminalMetadata({
              kind: terminal.kind,
              routeKey: terminal.routeKey,
              terminalReason: "replaced",
              replacementHandle,
            })
          }
        }

        if (terminal.terminalResultSent === true || !terminal.terminalReason) {
          continue
        }

        await notificationStore.upsertNotification({
          idempotencyKey: createRequestTerminalIdempotencyKey(terminal),
          kind: "requestTerminal",
          requestKind: terminal.kind,
          terminalReason: terminal.terminalReason,
          ...(terminal.replacementHandle ? { replacementHandle: terminal.replacementHandle } : {}),
          wechatAccountId: terminal.wechatAccountId,
          userId: terminal.userId,
          routeKey: terminal.routeKey,
          handle: terminal.handle,
          ...(terminal.scopeKey ? { scopeKey: terminal.scopeKey } : {}),
          createdAt: finalizedAt,
        })

        await requestStore.markTerminalResultSent({
          kind: terminal.kind,
          routeKey: terminal.routeKey,
          sentAt: finalizedAt,
        })
      }

      for (const notification of relevantNaturalStopsBeforeSync) {
        const identityKey = toNaturalStopIdentityKey({
          scopeKey: notification.scopeKey,
          sessionID: notification.sessionID,
          replyTarget: notification.replyTarget,
        })
        if (identityKey && currentNaturalStopIdentityKeys.has(identityKey)) {
          continue
        }

        await notificationStore.markNaturalStopTerminal({
          idempotencyKey: notification.idempotencyKey,
          resolvedAt: Date.now(),
          terminalReason: "continued",
        })
      }
    })
    .catch((error) => {
      registerAndSyncCandidatesChain = Promise.resolve()
      throw error
    })

  return registerAndSyncCandidatesChain
}

test("两个实例出现相同 question/permission/session 标识时不会互相覆盖", async () => {
  const isolatedStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-cross-instance-")
  const sandboxStateRoot = isolatedStateRoot.stateRoot

  assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, sandboxStateRoot)

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
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

    await registerAndSyncCandidates({
      endpoint,
      protocol: null,
      instanceID: "instance-a",
      candidates: await bridgeA.collectNotificationCandidates(),
    })
    await registerAndSyncCandidates({
      endpoint,
      protocol: null,
      instanceID: "instance-b",
      candidates: await bridgeB.collectNotificationCandidates(),
    })

    const pending = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      assert.equal(list.length, 6)
      return list
    }, 10000)

    assert.equal(pending.filter((item) => item.kind === "question").length, 2)
    assert.equal(pending.filter((item) => item.kind === "permission").length, 2)
    assert.equal(pending.filter((item) => item.kind === "sessionError").length, 2)
  } finally {
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

test("通知同步：live questionOpened event 会生成 pending question notification", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-live-question-opened-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-live-question-opened-server`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}-live-question-opened-client`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-live-question-opened-settings`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-live-question-opened-notification`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-live-question-opened-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-live-question-opened",
    userId: "u-live-question-opened",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-live-question-opened", userId: "u-live-question-opened" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-live-question-opened-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  const client = await brokerClient.connect(endpoint)
  const notificationKey = "question-live-question-opened-1"

  try {
    const register = await client.registerHello({
      protocolVersion: 2,
      stateGeneration: "wechat-ws-v1",
      instanceID: "instance-live-question-opened",
      instanceIncarnation: "inc-live-question-opened",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })
    assert.equal(register.control?.type, "requestFullSync")

    await client.sendBridgeEvent({
      type: "instanceOnline",
      eventSeq: 1,
      instanceIncarnation: "inc-live-question-opened",
      payload: {
        instanceID: "instance-live-question-opened",
        connectedAt: 1_700_900_000_000,
        pid: process.pid,
        displayName: "Live Notification Instance",
        projectDir: "/workspace/live-question-opened",
      },
    }, { instanceID: "instance-live-question-opened" })
    await client.sendBridgeEvent({
      type: "questionOpened",
      eventSeq: 2,
      instanceIncarnation: "inc-live-question-opened",
      payload: {
        instanceID: "instance-live-question-opened",
        idempotencyKey: notificationKey,
        requestID: "question-live-opened-1",
        routeKey: "question-live-opened-route-1",
        handle: "q1",
        scopeKey: "instance-live-question-opened",
        createdAt: 1_700_900_000_010,
        updatedAt: 1_700_900_000_010,
        wechatAccountId: "wx-live-question-opened",
        userId: "u-live-question-opened",
        prompt: {
          title: "Live question title",
          mode: "text",
        },
      },
    }, { instanceID: "instance-live-question-opened" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === notificationKey && item.kind === "question"), true)
    }, 10_000)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：旧 naturalStopOpened 事件缺少顶层 sessionID 时仍生成通知", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-legacy-natural-stop-opened-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-legacy-natural-stop-opened-server`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}-legacy-natural-stop-opened-client`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-legacy-natural-stop-opened-notification`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-legacy-natural-stop-opened-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-legacy-natural-stop-opened",
    userId: "u-legacy-natural-stop-opened",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-legacy-natural-stop-opened-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)
  const client = await brokerClient.connect(endpoint)
  const notificationKey = "natural-stop-legacy-opened-1"

  try {
    const register = await client.registerHello({
      protocolVersion: 2,
      stateGeneration: "wechat-ws-v1",
      instanceID: "instance-legacy-natural-stop-opened",
      instanceIncarnation: "inc-legacy-natural-stop-opened",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })
    assert.equal(register.control?.type, "requestFullSync")

    await client.sendBridgeEvent({
      type: "naturalStopOpened",
      eventSeq: 1,
      instanceIncarnation: "inc-legacy-natural-stop-opened",
      payload: {
        instanceID: "instance-legacy-natural-stop-opened",
        idempotencyKey: notificationKey,
        handle: "s1",
        replyTarget: {
          instanceID: "instance-legacy-natural-stop-opened",
          sessionID: "session-legacy-natural-stop-opened",
        },
        redactedSummary: "旧 bridge natural-stop 事件",
        severityAdvice: "已停止并等待你的回复",
        createdAt: 1_700_900_100_010,
        updatedAt: 1_700_900_100_010,
      },
    }, { instanceID: "instance-legacy-natural-stop-opened" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      const record = pending.find((item) => item.idempotencyKey === notificationKey && item.kind === "naturalStop")
      assert.equal(record?.sessionID, "session-legacy-natural-stop-opened")
      assert.equal(record?.replyTarget?.sessionID, "session-legacy-natural-stop-opened")
    }, 10_000)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：naturalStopOpened 的 replyTarget 与连接实例或 session 不一致时不生成通知", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-target-mismatch-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-natural-stop-target-mismatch-server`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}-natural-stop-target-mismatch-client`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-natural-stop-target-mismatch-notification`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-target-mismatch-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-target-mismatch",
    userId: "u-natural-stop-target-mismatch",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-natural-stop-target-mismatch-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)
  const client = await brokerClient.connect(endpoint)

  try {
    await client.registerHello({
      protocolVersion: 2,
      stateGeneration: "wechat-ws-v1",
      instanceID: "instance-natural-stop-target-mismatch",
      instanceIncarnation: "inc-natural-stop-target-mismatch",
      lastSeenBrokerSeq: 0,
      lastSentEventSeq: 0,
    })

    await client.sendBridgeEvent({
      type: "naturalStopOpened",
      eventSeq: 1,
      instanceIncarnation: "inc-natural-stop-target-mismatch",
      payload: {
        instanceID: "instance-natural-stop-target-mismatch",
        idempotencyKey: "natural-stop-session-target-mismatch",
        sessionID: "session-natural-stop-canonical",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-target-mismatch",
          sessionID: "session-natural-stop-other",
        },
        redactedSummary: "session mismatch",
        severityAdvice: "已停止并等待你的回复",
        createdAt: 1_700_900_200_010,
        updatedAt: 1_700_900_200_010,
      },
    }, { instanceID: "instance-natural-stop-target-mismatch" })

    await client.sendBridgeEvent({
      type: "naturalStopOpened",
      eventSeq: 2,
      instanceIncarnation: "inc-natural-stop-target-mismatch",
      payload: {
        instanceID: "instance-natural-stop-target-mismatch",
        idempotencyKey: "natural-stop-instance-target-mismatch",
        sessionID: "session-natural-stop-canonical",
        handle: "s2",
        replyTarget: {
          instanceID: "instance-natural-stop-other",
          sessionID: "session-natural-stop-canonical",
        },
        redactedSummary: "instance mismatch",
        severityAdvice: "已停止并等待你的回复",
        createdAt: 1_700_900_200_020,
        updatedAt: 1_700_900_200_020,
      },
    }, { instanceID: "instance-natural-stop-target-mismatch" })

    const pending = await notificationStore.listPendingNotifications()
    assert.equal(pending.some((item) => item.idempotencyKey === "natural-stop-session-target-mismatch"), false)
    assert.equal(pending.some((item) => item.idempotencyKey === "natural-stop-instance-target-mismatch"), false)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知候选：ordinary retry/error 不分配 handle，只带动作/摘要/严重度", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-retry-summary-")

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-retry-summary`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-retry-summary-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-retry-summary",
    userId: "u-retry-summary",
    boundAt: Date.now(),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "instance-retry-summary",
    instanceName: "Retry Summary",
    pid: process.pid,
    directory: "/repo/retry-summary",
    client: {
      session: {
        list: async () => [{ id: "session-retry-summary", title: "retry", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({
          "session-retry-summary": {
            type: "retry",
            retryNonce: "retry-summary-1",
            action: "执行 apply patch",
            redactedSummary: "上游返回 429，凭据字段已脱敏",
            severityAdvice: "建议尽快人工查看",
          },
        }),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  })

  try {
    const candidates = await bridge.collectNotificationCandidates()
    const retry = candidates.find((item) => item.kind === "sessionError")

    assert.equal(retry?.handle, undefined)
    assert.equal(retry?.sessionID, "session-retry-summary")
    assert.equal(retry?.action, "执行 apply patch")
    assert.equal(retry?.redactedSummary, "上游返回 429，凭据字段已脱敏")
    assert.equal(retry?.severityAdvice, "建议尽快人工查看")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知候选：ordinary retry 不透传等待你的回复语义，formatter 只展示允许的 severityAdvice", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-retry-severity-guard-")

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-retry-severity-guard`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-retry-severity-guard-operator`)
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-retry-severity-guard-format`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-retry-severity-guard",
    userId: "u-retry-severity-guard",
    boundAt: Date.now(),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "instance-retry-severity-guard",
    instanceName: "Retry Severity Guard",
    pid: process.pid,
    directory: "/repo/retry-severity-guard",
    client: {
      session: {
        list: async () => [{ id: "session-retry-severity-guard", title: "retry", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({
          "session-retry-severity-guard": {
            type: "retry",
            retryNonce: "retry-severity-guard-1",
            action: "执行 apply patch",
            redactedSummary: "上游返回 429，凭据字段已脱敏",
            severityAdvice: "已停止并等待你的回复",
          },
        }),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  })

  try {
    const candidates = await bridge.collectNotificationCandidates()
    const retry = candidates.find((item) => item.kind === "sessionError")

    assert.equal(retry?.severityAdvice, "可等待自动重试")

    const text = notificationFormat.formatWechatNotificationText({
      idempotencyKey: "retry-severity-guard-format-1",
      kind: "sessionError",
      sessionID: retry?.sessionID,
      action: retry?.action,
      redactedSummary: retry?.redactedSummary,
      severityAdvice: retry?.severityAdvice,
      wechatAccountId: "wx-retry-severity-guard",
      userId: "u-retry-severity-guard",
      createdAt: 1_700_600_100_047,
      status: "pending",
    })

    assert.doesNotMatch(text, /已停止并等待你的回复/)
    assert.match(text, /可等待自动重试|建议尽快人工查看/)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知候选：natural-stop 分配 s* handle 并带 reply target identity", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-candidate-")

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-natural-stop-candidate`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-candidate-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-candidate",
    userId: "u-natural-stop-candidate",
    boundAt: Date.now(),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "instance-natural-stop-candidate",
    instanceName: "Natural Stop Candidate",
    pid: process.pid,
    directory: "/repo/natural-stop-candidate",
    client: {
      session: {
        list: async () => [{ id: "session-natural-stop", title: "stop", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({
          "session-natural-stop": {
            type: "natural-stop",
            redactedSummary: "已完成首轮排查，需要你的补充信息",
            severityAdvice: "已停止并等待你的回复",
          },
        }),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  })

  try {
    const candidates = await bridge.collectNotificationCandidates()
    const stop = candidates.find((item) => item.kind === "naturalStop")

    assert.match(stop?.handle ?? "", /^s\d+$/)
    assert.equal(stop?.sessionID, "session-natural-stop")
    assert.equal(stop?.replyTarget?.instanceID, "instance-natural-stop-candidate")
    assert.equal(stop?.replyTarget?.sessionID, "session-natural-stop")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知候选：natural-stop 的 severityAdvice 固定为已停止并等待你的回复", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-severity-")

  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}-natural-stop-severity`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-severity-operator`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-severity",
    userId: "u-natural-stop-severity",
    boundAt: Date.now(),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "instance-natural-stop-severity",
    instanceName: "Natural Stop Severity",
    pid: process.pid,
    directory: "/repo/natural-stop-severity",
    client: {
      session: {
        list: async () => [{ id: "session-natural-stop-severity", title: "stop", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({
          "session-natural-stop-severity": {
            type: "natural-stop",
            redactedSummary: "已完成首轮排查，需要你的补充信息",
            severityAdvice: "建议稍后处理",
          },
        }),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
  })

  try {
    const candidates = await bridge.collectNotificationCandidates()
    const stop = candidates.find((item) => item.kind === "naturalStop")

    assert.equal(stop?.severityAdvice, "已停止并等待你的回复")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：两个实例同时 active natural-stop 时 broker 会分配全局唯一 s* handle", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-global-handle-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-natural-stop-global-handle-server`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-natural-stop-global-handle-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-global-handle-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-natural-stop-global-handle-protocol`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-global-handle",
    userId: "u-natural-stop-global-handle",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-natural-stop-global-handle-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-a",
      candidates: [{
        idempotencyKey: "natural-stop-global-a",
        kind: "naturalStop",
        createdAt: 1_700_991_000_000,
        sessionID: "session-natural-stop-a",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-a",
          sessionID: "session-natural-stop-a",
        },
        redactedSummary: "A 需要补充说明",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-b",
      candidates: [{
        idempotencyKey: "natural-stop-global-b",
        kind: "naturalStop",
        createdAt: 1_700_991_000_100,
        sessionID: "session-natural-stop-b",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-b",
          sessionID: "session-natural-stop-b",
        },
        redactedSummary: "B 需要补充说明",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    const pending = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      const activeNaturalStops = list.filter((item) => item.kind === "naturalStop")
      assert.equal(activeNaturalStops.length, 2)
      return activeNaturalStops
    })

    const handles = pending.map((item) => item.handle)
    assert.equal(new Set(handles).size, 2)
    assert.equal(handles.every((handle) => /^s\d+$/.test(handle)), true)

    const aRecord = pending.find((item) => item.replyTarget?.instanceID === "instance-natural-stop-a")
    const bRecord = pending.find((item) => item.replyTarget?.instanceID === "instance-natural-stop-b")
    assert.notEqual(aRecord?.handle, bRecord?.handle)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：旧 binding 残留 active natural-stop s1 时，新 binding 不能再次分配 s1", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-cross-binding-handle-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-natural-stop-cross-binding-server`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-natural-stop-cross-binding-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-cross-binding-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-natural-stop-cross-binding-protocol`)

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-natural-stop-cross-binding-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await operatorStore.rebindOperator({
      wechatAccountId: "wx-natural-stop-old-binding",
      userId: "u-natural-stop-old-binding",
      boundAt: Date.now(),
    })
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-old-binding",
      candidates: [{
        idempotencyKey: "natural-stop-old-binding-active",
        kind: "naturalStop",
        createdAt: 1_700_994_000_000,
        sessionID: "session-natural-stop-old-binding",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-old-binding",
          sessionID: "session-natural-stop-old-binding",
        },
        redactedSummary: "旧 binding 残留 active natural-stop",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    await operatorStore.rebindOperator({
      wechatAccountId: "wx-natural-stop-new-binding",
      userId: "u-natural-stop-new-binding",
      boundAt: Date.now(),
    })
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-new-binding",
      candidates: [{
        idempotencyKey: "natural-stop-new-binding-active",
        kind: "naturalStop",
        createdAt: 1_700_994_000_100,
        sessionID: "session-natural-stop-new-binding",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-new-binding",
          sessionID: "session-natural-stop-new-binding",
        },
        redactedSummary: "新 binding 的 active natural-stop",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    const pending = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      const activeNaturalStops = list.filter((item) => item.kind === "naturalStop")
      assert.equal(activeNaturalStops.length, 2)
      return activeNaturalStops
    })

    const oldBindingRecord = pending.find((item) => item.userId === "u-natural-stop-old-binding")
    const newBindingRecord = pending.find((item) => item.userId === "u-natural-stop-new-binding")

    assert.equal(oldBindingRecord?.handle, "s1")
    assert.notEqual(newBindingRecord?.handle, "s1")
    assert.notEqual(oldBindingRecord?.handle, newBindingRecord?.handle)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：同一 replyTarget 的旧 active natural-stop 进入 continued 后，新 active 必须拿新的 s*", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-continued-handle-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-natural-stop-continued-handle-server`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-natural-stop-continued-handle-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-continued-handle-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-natural-stop-continued-handle-protocol`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-continued-handle",
    userId: "u-natural-stop-continued-handle",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-natural-stop-continued-handle-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-continued",
      candidates: [{
        idempotencyKey: "natural-stop-continued-old",
        kind: "naturalStop",
        createdAt: 1_700_998_000_000,
        sessionID: "session-natural-stop-continued",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-continued",
          sessionID: "session-natural-stop-continued",
        },
        redactedSummary: "旧的 natural-stop",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    let oldActive = null
    await waitFor(async () => {
      oldActive = await notificationStore.findActiveNaturalStopByHandle({ handle: "s1" })
      return oldActive?.idempotencyKey === "natural-stop-continued-old"
    })

    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-continued",
      candidates: [{
        idempotencyKey: "natural-stop-continued-new",
        kind: "naturalStop",
        createdAt: 1_700_998_000_100,
        sessionID: "session-natural-stop-continued",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-continued",
          sessionID: "session-natural-stop-continued",
        },
        redactedSummary: "新的 natural-stop",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    const nextActive = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      const record = list.find((item) => item.idempotencyKey === "natural-stop-continued-new")
      assert.ok(record?.handle)

      const oldTerminal = await notificationStore.findTerminalNaturalStopByHandle({ handle: "s1" })
      assert.equal(oldTerminal?.idempotencyKey, "natural-stop-continued-old")

      return record
    })

    const oldTerminal = await notificationStore.findTerminalNaturalStopByHandle({ handle: "s1" })

    assert.equal(oldTerminal?.idempotencyKey, "natural-stop-continued-old")
    assert.equal(oldTerminal?.naturalStopTerminalReason, "continued")
    assert.notEqual(nextActive.handle, "s1")
    assert.match(nextActive.handle ?? "", /^s\d+$/)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知同步：旧 terminal natural-stop s1 在保留期内时，新 active natural-stop 不能复用 s1", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-natural-stop-terminal-retained-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-natural-stop-terminal-retained-server`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-natural-stop-terminal-retained-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-natural-stop-terminal-retained-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-natural-stop-terminal-retained-protocol`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-natural-stop-terminal-retained",
    userId: "u-natural-stop-terminal-retained",
    boundAt: Date.now(),
  })

  await notificationStore.upsertNotification({
    idempotencyKey: "natural-stop-terminal-retained-old-s1",
    kind: "naturalStop",
    handle: "s1",
    scopeKey: "instance-natural-stop-terminal-retained-old",
    sessionID: "session-natural-stop-terminal-retained-old",
    replyTarget: {
      instanceID: "instance-natural-stop-terminal-retained-old",
      sessionID: "session-natural-stop-terminal-retained-old",
    },
    redactedSummary: "旧 natural-stop 已回复",
    severityAdvice: "已停止并等待你的回复",
    wechatAccountId: "wx-natural-stop-terminal-retained",
    userId: "u-natural-stop-terminal-retained",
    createdAt: 1_700_996_000_000,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: "natural-stop-terminal-retained-old-s1",
    sentAt: 1_700_996_000_010,
  })
  await notificationStore.markNaturalStopTerminal({
    idempotencyKey: "natural-stop-terminal-retained-old-s1",
    resolvedAt: 1_700_996_000_020,
    terminalReason: "replied",
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-natural-stop-terminal-retained-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-natural-stop-terminal-retained-new",
      candidates: [{
        idempotencyKey: "natural-stop-terminal-retained-new-active",
        kind: "naturalStop",
        createdAt: 1_700_996_000_100,
        sessionID: "session-natural-stop-terminal-retained-new",
        handle: "s1",
        replyTarget: {
          instanceID: "instance-natural-stop-terminal-retained-new",
          sessionID: "session-natural-stop-terminal-retained-new",
        },
        redactedSummary: "新的 active natural-stop",
        severityAdvice: "已停止并等待你的回复",
      }],
    })

    const pending = await waitFor(async () => {
      const list = await notificationStore.listPendingNotifications()
      const record = list.find((item) => item.idempotencyKey === "natural-stop-terminal-retained-new-active")
      assert.ok(record)
      return record
    })

    const oldTerminal = await notificationStore.findTerminalNaturalStopByHandle({ handle: "s1" })

    assert.equal(oldTerminal?.idempotencyKey, "natural-stop-terminal-retained-old-s1")
    assert.equal(oldTerminal?.naturalStopTerminalReason, "replied")
    assert.notEqual(pending.handle, "s1")
    assert.match(pending.handle ?? "", /^s\d+$/)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})


test("重复同步同一请求复用 canonical request handle，且终态不视为 open/replyable", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-canonical-request-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
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

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol: null,
      instanceID: "instance-task3",
      candidates: [{
        idempotencyKey: "question-instance-task3-req-canonical-1",
        kind: "question",
        requestID: "req-canonical-1",
        createdAt: 1_700_300_000_000,
        routeKey: "bridge-route-req-canonical-1",
        handle: "q999",
      }],
    })
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

    await registerAndSyncCandidates({
      endpoint,
      protocol: null,
      instanceID: "instance-task3",
      candidates: [{
        idempotencyKey: "question-instance-task3-req-canonical-1-second",
        kind: "question",
        requestID: "  REQ-CANONICAL-1  ",
        createdAt: 1_700_300_000_001,
        routeKey: "bridge-route-req-canonical-1-second",
        handle: "q999",
      }],
    })

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
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("并发 sync 新请求时 broker 分配的 open handle 必须唯一", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-concurrent-handle-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-concurrent",
    userId: "u-concurrent",
    boundAt: Date.now(),
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-concurrent-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await Promise.all([
      registerAndSyncCandidates({
        endpoint,
        protocol: null,
        instanceID: "instance-concurrent-a",
        candidates: [{
          idempotencyKey: "question-concurrent-req-concurrent-a",
          kind: "question",
          requestID: "req-concurrent-a",
          createdAt: 1_700_400_000_000,
          routeKey: "bridge-route-req-concurrent-a",
          handle: "q999",
        }],
      }),
      registerAndSyncCandidates({
        endpoint,
        protocol: null,
        instanceID: "instance-concurrent-b",
        candidates: [{
          idempotencyKey: "question-concurrent-req-concurrent-b",
          kind: "question",
          requestID: "req-concurrent-b",
          createdAt: 1_700_400_000_000,
          routeKey: "bridge-route-req-concurrent-b",
          handle: "q999",
        }],
      }),
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

test("通知分发：failed 记录不会因 token 恢复而自动回到 pending", async () => {
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
    assert.equal(reopened.status, "failed")
    assert.equal(typeof reopened.failedAt, "number")
    assert.match(String(reopened.failureReason), /mock-send-failed-once/i)

    const pending = await notificationStore.listPendingNotifications()
    assert.equal(pending.some((record) => record.idempotencyKey === "task4-reactivated-question"), false)

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)

    const failedAfterReactivation = JSON.parse(await readFile(statePaths.notificationStatePath("task4-reactivated-question"), "utf8"))
    assert.equal(failedAfterReactivation.status, "failed")
    assert.match(String(failedAfterReactivation.failureReason), /mock-send-failed-once/i)
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

test("status runtime: getUpdates 长轮询期间也会继续 drain outbound，避免漏掉自然结束通知", async () => {
  const runtimeModule = await import(`${DIST_WECHAT_STATUS_RUNTIME_MODULE}?reload=${Date.now()}-runtime-outbound-while-long-poll`)

  let pollCount = 0
  let drainCalls = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "wx-runtime-long-poll",
        token: "token-runtime-long-poll",
        baseUrl: "https://wx-runtime.example.com",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-runtime-long-poll-1",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "runtime-long-poll" }),
    }),
    drainOutboundMessages: async () => {
      drainCalls += 1
    },
  })

  await runtime.start()
  try {
    await waitFor(async () => {
      assert.equal(pollCount >= 2, true)
      assert.equal(drainCalls >= 1, true)
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    await runtime.close()
  }

  assert.equal(drainCalls >= 2, true)
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
  assert.doesNotMatch(questionText, /\/reply q8 你的自定义回答/)
  assert.doesNotMatch(questionText, /\/reply q8 1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：question 在文本题时展示完整题面与自由文本回复示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-text-copy`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-text-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-text-1",
    handle: "qtext1",
    createdAt: 1_700_600_100_010,
    status: "pending",
    prompt: {
      title: "请补充发布说明",
      body: "请直接写出这次发布最重要的一句价值总结。",
      mode: "text",
      custom: true,
    },
  })

  assert.match(questionText, /请直接写出这次发布最重要的一句价值总结/)
  assert.match(questionText, /\/reply qtext1 你的自定义回答/)
  assert.doesNotMatch(questionText, /1\./)
})

test("通知文案格式化：question 在多选题时展示编号选项与多选回复示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-multiple-copy`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-multiple-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-multiple-1",
    handle: "qmulti1",
    createdAt: 1_700_600_100_020,
    status: "pending",
    prompt: {
      title: "请选择需要通知的环境",
      body: "可以同时选择多个环境。",
      mode: "multiple",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  assert.match(questionText, /可以同时选择多个环境/)
  assert.match(questionText, /1\. staging/)
  assert.match(questionText, /3\. preview/)
  assert.match(questionText, /\/reply qmulti1 1,2/)
  assert.doesNotMatch(questionText, /\/reply qmulti1 你的自定义回答/)
  assert.doesNotMatch(questionText, /\/reply qmulti1 1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：multiple + custom=true 同时展示编号、自定义、mixed reply 示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-multiple-custom-copy`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-multiple-custom-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-multiple-custom-1",
    handle: "qmulti2",
    createdAt: 1_700_600_100_030,
    status: "pending",
    prompt: {
      title: "请选择需要通知的环境",
      body: "可以多选，也可以直接输入其他环境说明。",
      mode: "multiple",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  assert.match(questionText, /\/reply qmulti2 1,2/)
  assert.match(questionText, /\/reply qmulti2 你的自定义回答/)
  assert.match(questionText, /\/reply qmulti2 1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：single + custom=true 展示编号与自定义，但不展示 mixed reply 示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-single-custom-copy`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-single-custom-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-single-custom-1",
    handle: "qsingle2",
    createdAt: 1_700_600_100_031,
    status: "pending",
    prompt: {
      title: "请选择发布环境",
      body: "也可以直接输入其它发布说明。",
      mode: "single",
      custom: true,
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  assert.match(questionText, /\/reply qsingle2 1/)
  assert.match(questionText, /\/reply qsingle2 你的自定义回答/)
  assert.doesNotMatch(questionText, /1,3; 其他：先灰度再全量/)
})

test("通知文案格式化：permission 同时展示批准对象、handle、命令用法与动作语义", async () => {
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
      description: "目标：npm publish --tag latest",
    },
  })

  assert.match(permissionText, /允许执行 shell 命令/)
  assert.match(permissionText, /收到新的权限请求（p3）/)
  assert.match(permissionText, /类型：command/)
  assert.match(permissionText, /目标：npm publish --tag latest/)
  assert.match(permissionText, /\/allow p3 once/)
  assert.match(permissionText, /\/allow p3 always/)
  assert.match(permissionText, /\/allow p3 reject/)
  assert.match(permissionText, /once：仅处理这一次/)
  assert.match(permissionText, /always：后续同类请求自动允许/)
  assert.match(permissionText, /reject：拒绝当前请求/)
})

test("通知文案格式化：question 选项会输出标题与说明两行", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-option-description`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-option-description-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-option-description-1",
    handle: "qdesc1",
    createdAt: 1_700_600_100_040,
    status: "pending",
    prompt: {
      title: "请选择发布策略",
      mode: "single",
      options: [
        { index: 1, label: "灰度发布", value: "gray", description: "先给少量用户验证" },
        { index: 2, label: "全量发布", value: "full" },
      ],
    },
  })

  const lines = questionText.split("\n")
  assert.deepEqual(lines.slice(0, 7), [
    "收到新的问题请求（qdesc1）",
    "请选择发布策略",
    "类型：单选",
    "1. 灰度发布",
    "先给少量用户验证",
    "2. 全量发布",
    "/reply qdesc1 1",
  ])
})

test("通知文案格式化：question 说明会穿过 extractQuestionPromptSummary 到 formatter", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-summary-description-chain`)
  const questionInteraction = await import(`${DIST_QUESTION_INTERACTION_MODULE}?reload=${Date.now()}-question-summary-description-chain`)

  const prompt = questionInteraction.extractQuestionPromptSummary({
    questions: [
      {
        header: "请选择发布策略",
        question: "请优先选择一条可执行路径。",
        options: [
          { label: "灰度发布", description: "先给少量用户验证" },
          { label: "全量发布" },
        ],
      },
    ],
  })

  assert.equal(prompt?.options?.[0]?.description, "先给少量用户验证")

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-summary-description-chain-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-summary-description-chain-1",
    handle: "qdesc2",
    createdAt: 1_700_600_100_041,
    status: "pending",
    prompt,
  })

  assert.match(questionText, /1\. 灰度发布\n先给少量用户验证/)
})

test("通知文案格式化：question 在 custom 字段缺失时默认仍展示自定义回复示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-summary-default-custom`)
  const questionInteraction = await import(`${DIST_QUESTION_INTERACTION_MODULE}?reload=${Date.now()}-question-summary-default-custom`)

  const prompt = questionInteraction.extractQuestionPromptSummary({
    questions: [
      {
        header: "请选择发布策略",
        question: "请优先选择一条可执行路径。",
        options: [
          { label: "灰度发布", description: "先给少量用户验证" },
          { label: "全量发布" },
        ],
      },
    ],
  })

  assert.equal(prompt?.custom, true)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-summary-default-custom-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-summary-default-custom-1",
    handle: "qdefaultcustom1",
    createdAt: 1_700_600_100_141,
    status: "pending",
    prompt,
  })

  const lines = questionText.split("\n")
  assert(lines.includes("/reply qdefaultcustom1 你的自定义回答"))
})

test("通知文案格式化：question 与 permission 示例都逐行独立", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-question-permission-copy-lines`)

  const questionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "question-copy-lines-1",
    kind: "question",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-question-copy-lines-1",
    handle: "qcopy1",
    createdAt: 1_700_600_100_042,
    status: "pending",
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

  const permissionText = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "permission-copy-lines-1",
    kind: "permission",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-permission-copy-lines-1",
    handle: "pcopy1",
    createdAt: 1_700_600_100_043,
    status: "pending",
    prompt: {
      title: "允许执行 shell 命令",
      type: "command",
      description: "目标：npm publish --tag latest",
    },
  })

  const questionLines = questionText.split("\n")
  const permissionLines = permissionText.split("\n")

  assert(questionLines.includes("/reply qcopy1 1,2"))
  assert(questionLines.includes("/reply qcopy1 你的自定义回答"))
  assert(questionLines.includes("/reply qcopy1 1,3; 其他：先灰度再全量"))
  assert.equal(questionLines.some((line) => line.includes("：/reply ")), false)

  assert(permissionLines.includes("/allow pcopy1 once"))
  assert(permissionLines.includes("/allow pcopy1 always"))
  assert(permissionLines.includes("/allow pcopy1 reject"))
  assert.equal(permissionLines.some((line) => line.includes("：/allow ")), false)
})

test("通知文案格式化：terminal result 同时展示入口标识、终结原因与拒绝说明", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-request-terminal-format`)

  const text = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "request-terminal-format-1",
    kind: "requestTerminal",
    requestKind: "question",
    terminalReason: "answered",
    wechatAccountId: "wx-main",
    userId: "u-main",
    routeKey: "route-request-terminal-format-1",
    handle: "q12",
    createdAt: 1_700_600_100_044,
    status: "pending",
  })

  assert.match(text, /q12/)
  assert.match(text, /已在电脑端回复/)
  assert.match(text, /不再接受回复/)
})

test("通知文案格式化：broker-state-store legacy closure 可直接生成稳定关闭文案", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-legacy-handle-closure-format`)

  const upgradedQuestionText = notificationFormat.formatBrokerLegacyHandleClosureText({
    kind: "question",
    handle: "qlegacy99",
    reason: "upgraded",
    message: "问题入口 qlegacy99 已在升级后关闭，请查看新入口或重新获取通知",
  })
  const continuedNaturalStopText = notificationFormat.formatBrokerLegacyHandleClosureText({
    kind: "naturalStop",
    handle: "slegacy99",
    reason: "continued",
  })

  assert.match(upgradedQuestionText, /qlegacy99/)
  assert.match(upgradedQuestionText, /升级后关闭/)
  assert.match(continuedNaturalStopText, /slegacy99/)
  assert.match(continuedNaturalStopText, /已在电脑端继续处理/)
  assert.match(continuedNaturalStopText, /不再接受回复/)
})

test("通知文案格式化：natural-stop 给出逐行独立 /reply s* 你的补充内容 示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-natural-stop-format`)

  const text = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "natural-stop-format-1",
    kind: "naturalStop",
    handle: "s3",
    sessionID: "session-natural-stop-format",
    replyTarget: {
      instanceID: "instance-natural-stop-format",
      sessionID: "session-natural-stop-format",
    },
    redactedSummary: "Agent 已自然中止，需要你的补充说明",
    severityAdvice: "已停止并等待你的回复",
    wechatAccountId: "wx-main",
    userId: "u-main",
    createdAt: 1_700_600_100_045,
    status: "pending",
  })

  assert.match(text, /\n\/reply s3 你的补充内容\n/)
})

test("通知文案格式化：ordinary retry/sessionError 展示三段式摘要但不带 reply 示例", async () => {
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-session-error-format`)

  const text = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "session-error-format-1",
    kind: "sessionError",
    sessionID: "session-retry-format",
    action: "执行 apply patch",
    redactedSummary: "上游返回 429，凭据字段已脱敏",
    severityAdvice: "建议尽快人工查看",
    wechatAccountId: "wx-main",
    userId: "u-main",
    createdAt: 1_700_600_100_046,
    status: "pending",
  })

  assert.match(text, /动作：执行 apply patch/)
  assert.match(text, /原因摘要：上游返回 429，凭据字段已脱敏/)
  assert.match(text, /处理建议：建议尽快人工查看/)
  assert.doesNotMatch(text, /\/reply s\d+/)
  assert.doesNotMatch(text, /等待你的回复/)
})

test("通知文案格式化：broker 权威 retry summary 提示 /status 重新激活，且不再出现 fallback toast sidecar 字样", async () => {
  const brokerStateStore = await import(`../dist/wechat/broker-state-store.js?reload=${Date.now()}-authoritative-retry-format`)
  const notificationFormat = await import(`${DIST_NOTIFICATION_FORMAT_MODULE}?reload=${Date.now()}-authoritative-retry-format`)

  const state = brokerStateStore.createEmptyBrokerState()
  brokerStateStore.upsertRetryErrorSummary(state, {
    instanceID: "instance-authoritative-retry-format",
    action: "在微信发送 /status 重新激活",
    redactedSummary: "微信通知发送失败，当前微信会话可能已失效",
    severityAdvice: "建议尽快人工查看",
    updatedAt: 1_700_600_100_047,
  })

  const retry = brokerStateStore.readBrokerAuthoritativeView(state).active.retryErrors["instance-authoritative-retry-format"]
  const text = notificationFormat.formatWechatNotificationText({
    idempotencyKey: "authoritative-retry-format-1",
    kind: "sessionError",
    sessionID: typeof retry?.sessionID === "string" ? retry.sessionID : undefined,
    action: retry?.action,
    redactedSummary: retry?.redactedSummary,
    severityAdvice: retry?.severityAdvice,
    wechatAccountId: "wx-main",
    userId: "u-main",
    createdAt: 1_700_600_100_047,
    status: "pending",
  })

  assert.match(text, /在微信发送 \/status 重新激活/)
  assert.match(text, /微信通知发送失败|会话可能已失效/)
  assert.doesNotMatch(text, /showFallbackToast|fallbackToastDropped/)
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

test("通知分发：同一旧入口的 terminal result 只发送一次", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-terminal-only-once-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-request-terminal-only-once-server`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-request-terminal-only-once-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-request-terminal-only-once-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-request-terminal-only-once-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-request-terminal-only-once-operator`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-request-terminal-only-once-request-store`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-terminal-once",
    userId: "u-terminal-once",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-terminal-once", userId: "u-terminal-once" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-terminal-only-once-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  const syncCandidates = async (candidates) => registerAndSyncCandidates({
    endpoint,
    protocol: null,
    instanceID: "instance-terminal-only-once",
    candidates,
  })

  try {
    await syncCandidates([
      {
        idempotencyKey: "open-terminal-only-once-q12",
        kind: "question",
        requestID: "req-terminal-only-once-q12",
        createdAt: 1_700_610_000_000,
        routeKey: "bridge-route-terminal-only-once-q12",
        handle: "q999",
      },
    ])

    await waitFor(async () => {
      const open = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "q1" })
      assert.equal(open?.requestID, "req-terminal-only-once-q12")
    })

    await syncCandidates([])

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.kind === "requestTerminal" && item.handle === "q1"), true)
    })

    const terminalBeforeDispatch = await waitFor(async () => {
      const terminal = await requestStore.findTerminalRequestByHandle({ kind: "question", handle: "q1" })
      assert.equal(terminal?.terminalReason, "answered")
      assert.equal(terminal?.terminalResultSent, true)
      return terminal
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()
    await syncCandidates([])
    await dispatcher.drainOutboundMessages()

    assert.equal(
      sendCalls.filter((item) => /q1/.test(item.text) && /已结束|不再接受回复/.test(item.text)).length,
      1,
    )
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：permission rejected 走 terminal 链路后文案保持已在电脑端拒绝", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-terminal-rejected-permission-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-request-terminal-rejected-server`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-request-terminal-rejected-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-request-terminal-rejected-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-request-terminal-rejected-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-request-terminal-rejected-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-request-terminal-rejected-protocol`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-request-terminal-rejected-request-store`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-terminal-rejected",
    userId: "u-terminal-rejected",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-terminal-rejected", userId: "u-terminal-rejected" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-terminal-rejected-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-terminal-rejected",
      candidates: [
        {
          idempotencyKey: "permission-terminal-rejected-open",
          kind: "permission",
          requestID: "req-terminal-rejected-permission",
          createdAt: 1_700_620_000_000,
          routeKey: "bridge-route-terminal-rejected-permission",
          handle: "p999",
        },
      ],
    })

    const open = await waitFor(async () => {
      const request = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
      assert.equal(request?.requestID, "req-terminal-rejected-permission")
      return request
    })

    await requestStore.markRequestRejected({
      kind: "permission",
      routeKey: open.routeKey,
      rejectedAt: 1_700_620_000_100,
    })

    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-terminal-rejected",
      candidates: [],
    })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.kind === "requestTerminal" && item.handle === "p1"), true)
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input.text)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.some((text) => /p1/.test(text) && /已在电脑端拒绝/.test(text) && /不再接受权限处理/.test(text)), true)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：permission handled 走 terminal 链路后文案保持已在电脑端处理", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-terminal-handled-permission-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-request-terminal-handled-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-request-terminal-handled-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-request-terminal-handled-store`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-terminal-handled", userId: "u-terminal-handled" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "permission-terminal-handled",
      kind: "requestTerminal",
      wechatAccountId: "wx-terminal-handled",
      userId: "u-terminal-handled",
      requestKind: "permission",
      routeKey: "bridge-route-terminal-handled-permission",
      handle: "p1",
      terminalReason: "handled",
      createdAt: 1_700_620_500_000,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input.text)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.some((text) => /p1/.test(text) && /已在电脑端处理/.test(text) && /不再接受权限处理/.test(text)), true)
    assert.equal(sendCalls.some((text) => /已在电脑端拒绝/.test(text)), false)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：sync terminal finalization 与并发终结竞争时不会丢掉 terminal result", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-terminal-race-finalization-")

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-request-terminal-race-server`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-request-terminal-race-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-request-terminal-race-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-request-terminal-race-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-request-terminal-race-operator`)
  const protocol = await import(`${DIST_PROTOCOL_MODULE}?reload=${Date.now()}-request-terminal-race-protocol`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-request-terminal-race-request-store`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-terminal-race",
    userId: "u-terminal-race",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-terminal-race", userId: "u-terminal-race" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-terminal-race-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-terminal-race",
      candidates: [
        {
          idempotencyKey: "permission-terminal-race-open",
          kind: "permission",
          requestID: "req-terminal-race-permission",
          createdAt: 1_700_621_000_000,
          routeKey: "bridge-route-terminal-race-permission",
          handle: "p999",
        },
      ],
    })

    const open = await waitFor(async () => {
      const request = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
      assert.equal(request?.requestID, "req-terminal-race-permission")
      return request
    })

    await requestStore.markRequestRejected({
      kind: "permission",
      routeKey: open.routeKey,
      rejectedAt: 1_700_621_000_100,
    })

    await registerAndSyncCandidates({
      endpoint,
      protocol,
      instanceID: "instance-terminal-race",
      candidates: [],
    })

    const terminal = await waitFor(async () => {
      const current = await requestStore.findTerminalRequestByHandle({ kind: "permission", handle: "p1" })
      assert.equal(current?.terminalReason, "rejected")
      assert.equal(current?.terminalResultSent, true)
      return current
    })

    const pending = await waitFor(async () => {
      const current = await notificationStore.listPendingNotifications()
      const matches = current.filter((item) => item.kind === "requestTerminal" && item.handle === "p1")
      assert.equal(matches.length, 1)
      return matches
    })
    assert.equal(pending[0].terminalReason, "rejected")

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input.text)
      },
    })
    await dispatcher.drainOutboundMessages()

    assert.equal(terminal.terminalReason, "rejected")
    assert.equal(sendCalls.filter((text) => /p1/.test(text) && /已在电脑端拒绝/.test(text)).length, 1)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：旧 instances snapshot 不再驱动 request 过期或 terminal result", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-terminal-expired-")
  const previousHeartbeatTimeout = process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
  process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = "1"

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-request-terminal-expired-server`)
  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-request-terminal-expired-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-request-terminal-expired-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-request-terminal-expired-store`)
  const operatorStore = await import(`${DIST_OPERATOR_STORE_MODULE}?reload=${Date.now()}-request-terminal-expired-operator`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-request-terminal-expired-request-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-request-terminal-expired-state-paths`)

  await operatorStore.rebindOperator({
    wechatAccountId: "wx-terminal-expired",
    userId: "u-terminal-expired",
    boundAt: Date.now(),
  })
  await commonSettingsStore.writeCommonSettingsStore({
    wechat: {
      primaryBinding: { accountId: "wx-terminal-expired", userId: "u-terminal-expired" },
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-terminal-expired-endpoint-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const snapshotNow = Date.now() - 10_000

  try {
    await requestStore.upsertRequest({
      kind: "question",
      requestID: "req-terminal-expired-question",
      routeKey: "route-terminal-expired-question",
      handle: "q1",
      scopeKey: "instance-terminal-expired",
      wechatAccountId: "wx-terminal-expired",
      userId: "u-terminal-expired",
      createdAt: 1_700_630_000_000,
    })
    await mkdir(path.dirname(statePaths.instanceStatePath("instance-terminal-expired")), { recursive: true })
    await writeFile(
      statePaths.instanceStatePath("instance-terminal-expired"),
      JSON.stringify({
        instanceID: "instance-terminal-expired",
        pid: process.pid,
        displayName: "Expired Instance",
        projectDir: "/repo/expired",
        connectedAt: snapshotNow,
        lastHeartbeatAt: snapshotNow,
        status: "connected",
      }),
    )

    const server = await brokerServer.startBrokerServer(endpoint)

    try {
      const open = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "q1" })
      assert.equal(open?.status, "open")
      assert.equal(
        (await notificationStore.listPendingNotifications()).some((item) => item.kind === "requestTerminal" && item.handle === "q1"),
        false,
      )

      const sendCalls = []
      const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
        sendMessage: async (input) => {
          sendCalls.push(input.text)
        },
      })
      await dispatcher.drainOutboundMessages()

      assert.equal(sendCalls.some((text) => /q1/.test(text) && /已过期|不再接受回复/.test(text)), false)
    } finally {
      await server.close().catch(() => {})
    }
  } finally {
    if (previousHeartbeatTimeout === undefined) {
      delete process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
    } else {
      process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = previousHeartbeatTimeout
    }
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：broker-state-store stale connection 会驱动 request 过期与 terminal result，旧 instances snapshot 只作噪音", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-authoritative-terminal-expired-")
  const previousHeartbeatTimeout = process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
  process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = "1"

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-authoritative-terminal-expired-server`)
  const brokerStateStore = await import(`${DIST_BROKER_STATE_STORE_MODULE}?reload=${Date.now()}-authoritative-terminal-expired-state-store-read`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-authoritative-terminal-expired-store`)
  const requestStore = await import(`${DIST_REQUEST_STORE_MODULE}?reload=${Date.now()}-authoritative-terminal-expired-request-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-authoritative-terminal-expired-state-paths`)

  const staleAt = Date.now() - 10_000

  try {
    await requestStore.upsertRequest({
      kind: "question",
      requestID: "req-authoritative-terminal-expired-question",
      routeKey: "route-authoritative-terminal-expired-question",
      handle: "q3",
      scopeKey: "instance-authoritative-terminal-expired",
      wechatAccountId: "wx-authoritative-terminal-expired",
      userId: "u-authoritative-terminal-expired",
      createdAt: 1_700_631_000_000,
    })
    await mkdir(path.dirname(statePaths.instanceStatePath("instance-authoritative-terminal-expired")), { recursive: true })
    await writeFile(
      statePaths.instanceStatePath("instance-authoritative-terminal-expired"),
      JSON.stringify({
        instanceID: "instance-authoritative-terminal-expired",
        pid: process.pid,
        displayName: "Legacy Snapshot Noise",
        projectDir: "/repo/legacy-noise",
        connectedAt: staleAt,
        lastHeartbeatAt: staleAt,
        status: "connected",
      }),
    )
    await persistAuthoritativeBrokerState("authoritative-terminal-expired-state", async (state) => {
      state.connections["instance-authoritative-terminal-expired"] = {
        "inc-authoritative-terminal-expired": {
          instanceID: "instance-authoritative-terminal-expired",
          instanceIncarnation: "inc-authoritative-terminal-expired",
          online: true,
          lastEventSeq: 2,
          lastAckedEventSeq: 2,
          lastSentBrokerSeq: 0,
          connectedAt: staleAt,
          lastObservedAt: staleAt,
        },
      }
      state.active.instances["instance-authoritative-terminal-expired"] = {
        instanceID: "instance-authoritative-terminal-expired",
        instanceIncarnation: "inc-authoritative-terminal-expired",
        displayName: "Authoritative Expired Instance",
        online: true,
      }
      state.active.questions["route-authoritative-terminal-expired-question"] = {
        routeKey: "route-authoritative-terminal-expired-question",
        handle: "q3",
        requestID: "req-authoritative-terminal-expired-question",
        scopeKey: "instance-authoritative-terminal-expired",
        instanceID: "instance-authoritative-terminal-expired",
        wechatAccountId: "wx-authoritative-terminal-expired",
        userId: "u-authoritative-terminal-expired",
        createdAt: 1_700_631_000_000,
      }
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-authoritative-terminal-expired-question")]: {
          kind: "question",
          requestID: "req-authoritative-terminal-expired-question",
          routeKey: "route-authoritative-terminal-expired-question",
          handle: "q3",
          scopeKey: "instance-authoritative-terminal-expired",
          wechatAccountId: "wx-authoritative-terminal-expired",
          userId: "u-authoritative-terminal-expired",
          status: "open",
          createdAt: 1_700_631_000_000,
        },
      }
    })

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-notification-authoritative-terminal-expired-endpoint-"))
    const endpoint = createBrokerEndpoint(tempDir)
    const server = await brokerServer.startBrokerServer(endpoint)

    try {
      await waitFor(async () => {
        const persisted = await brokerStateStore.loadBrokerStateStoreSnapshot()
        const terminal = await brokerStateStore.readBrokerIndexedRequest({ kind: "question", routeKey: "route-authoritative-terminal-expired-question" }, persisted)
        assert.equal(terminal?.terminalReason, "expired")
        assert.equal(terminal?.status, "expired")
        assert.match(persisted?.legacyHandleClosures.q3?.reason ?? "", /expired/)
      }, 4000)

      assert.equal((await notificationStore.listPendingNotifications()).some((item) => item.kind === "requestTerminal" && item.handle === "q3"), false)
      const legacyRequest = JSON.parse(await readFile(statePaths.requestStatePath("question", "route-authoritative-terminal-expired-question"), "utf8"))
      assert.equal(legacyRequest.status, "open")
    } finally {
      await server.close().catch(() => {})
    }
  } finally {
    if (previousHeartbeatTimeout === undefined) {
      delete process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
    } else {
      process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = previousHeartbeatTimeout
    }
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：旧 answered request 文件不会压过 broker-state-store 的 open question", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-authoritative-request-gating-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-authoritative-request-gating-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-authoritative-request-gating-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-authoritative-request-gating-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-authoritative-request-gating-state-paths`)

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
      idempotencyKey: "authoritative-request-gating-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-authoritative-request-gating-question",
      handle: "q4",
      createdAt: 1_700_632_000_001,
    })
    await writeLegacyRequestRecord(statePaths, {
      kind: "question",
      requestID: "req-authoritative-request-gating-question",
      routeKey: "route-authoritative-request-gating-question",
      handle: "q4",
      wechatAccountId: "wx-main",
      userId: "u-main",
      status: "answered",
      createdAt: 1_700_632_000_000,
      answeredAt: 1_700_632_000_010,
      terminalReason: "answered",
    })
    await persistAuthoritativeBrokerState("authoritative-request-gating-state", async (state) => {
      state.active.questions["route-authoritative-request-gating-question"] = {
        routeKey: "route-authoritative-request-gating-question",
        handle: "q4",
        requestID: "req-authoritative-request-gating-question",
        scopeKey: "instance-authoritative-request-gating",
        instanceID: "instance-authoritative-request-gating",
        wechatAccountId: "wx-main",
        userId: "u-main",
        createdAt: 1_700_632_000_000,
      }
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-authoritative-request-gating-question")]: {
          kind: "question",
          requestID: "req-authoritative-request-gating-question",
          routeKey: "route-authoritative-request-gating-question",
          handle: "q4",
          scopeKey: "instance-authoritative-request-gating",
          wechatAccountId: "wx-main",
          userId: "u-main",
          status: "open",
          createdAt: 1_700_632_000_000,
        },
      }
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("authoritative-request-gating-question"), "utf8"))
    assert.equal(record.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：只有旧 open request 文件时，pending question 不会被放行为 live 发送", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-legacy-request-no-fallback-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-legacy-request-no-fallback-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-legacy-request-no-fallback-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-legacy-request-no-fallback-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-legacy-request-no-fallback-state-paths`)

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
      idempotencyKey: "legacy-request-no-fallback-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-legacy-request-no-fallback-question",
      handle: "q6",
      createdAt: 1_700_635_000_001,
    })
    await writeLegacyRequestRecord(statePaths, {
      kind: "question",
      requestID: "req-legacy-request-no-fallback-question",
      routeKey: "route-legacy-request-no-fallback-question",
      handle: "q6",
      wechatAccountId: "wx-main",
      userId: "u-main",
      status: "open",
      createdAt: 1_700_635_000_000,
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("legacy-request-no-fallback-question"), "utf8"))
    assert.equal(record.status, "suppressed")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：旧 live token 文件不会让 authoritative stale sessionError 被 suppress", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-authoritative-session-error-token-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-authoritative-session-error-token-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-authoritative-session-error-token-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-authoritative-session-error-token-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-authoritative-session-error-token-state-paths`)

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
      idempotencyKey: "authoritative-session-error-token",
      kind: "sessionError",
      wechatAccountId: "wx-main",
      userId: "u-main",
      createdAt: 1_700_633_000_001,
    })
    await writeLegacyTokenRecord(statePaths, "wx-main", "u-main", {
      contextToken: "legacy-live-token",
      updatedAt: 1_700_633_000_100,
      source: "message",
      sourceRef: "/status",
    })
    await persistAuthoritativeBrokerState("authoritative-session-error-token-state", async (state) => {
      state.deliveryTokens = {
        [createBrokerDeliveryTokenKey("wx-main", "u-main")]: {
          wechatAccountId: "wx-main",
          userId: "u-main",
          contextToken: "authoritative-stale-token",
          updatedAt: 1_700_633_000_100,
          source: "message",
          sourceRef: "/status",
          staleReason: "notification-delivery-failed",
        },
      }
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("authoritative-session-error-token"), "utf8"))
    assert.equal(record.status, "pending")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：authoritative state 已无 active natural-stop 时，pending natural-stop 会被 suppress", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-authoritative-natural-stop-suppress-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-authoritative-natural-stop-suppress-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-authoritative-natural-stop-suppress-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-authoritative-natural-stop-suppress-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-authoritative-natural-stop-suppress-state-paths`)

  try {
    await commonSettingsStore.writeCommonSettingsStore({
      wechat: {
        primaryBinding: { accountId: "wx-natural-stop-suppress", userId: "u-natural-stop-suppress" },
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    })

    await notificationStore.upsertNotification({
      idempotencyKey: "natural-stop-authoritative-suppress",
      kind: "naturalStop",
      wechatAccountId: "wx-natural-stop-suppress",
      userId: "u-natural-stop-suppress",
      handle: "s1",
      scopeKey: "instance-natural-stop-suppress",
      sessionID: "session-natural-stop-suppress",
      replyTarget: {
        instanceID: "instance-natural-stop-suppress",
        sessionID: "session-natural-stop-suppress",
      },
      redactedSummary: "自然中止已结束",
      severityAdvice: "已停止并等待你的回复",
      createdAt: 1_700_633_500_001,
    })

    await persistAuthoritativeBrokerState("authoritative-natural-stop-suppress-state", async (state) => {
      state.active.instances["instance-natural-stop-suppress"] = {
        instanceID: "instance-natural-stop-suppress",
        online: false,
      }
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 0)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("natural-stop-authoritative-suppress"), "utf8"))
    assert.equal(record.status, "suppressed")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：旧 stale token 文件不会阻止 authoritative live token 发送 pending question", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-authoritative-live-token-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-authoritative-live-token-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-authoritative-live-token-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-authoritative-live-token-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-authoritative-live-token-state-paths`)

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
      idempotencyKey: "authoritative-live-token-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-authoritative-live-token-question",
      handle: "q5",
      createdAt: 1_700_634_000_001,
    })
    await writeLegacyTokenRecord(statePaths, "wx-main", "u-main", {
      contextToken: "legacy-stale-token",
      updatedAt: 1_700_634_000_100,
      source: "message",
      sourceRef: "/status",
      staleReason: "notification-delivery-failed",
    })
    await persistAuthoritativeBrokerState("authoritative-live-token-state", async (state) => {
      state.active.questions["route-authoritative-live-token-question"] = {
        routeKey: "route-authoritative-live-token-question",
        handle: "q5",
        requestID: "req-authoritative-live-token-question",
        scopeKey: "instance-authoritative-live-token",
        instanceID: "instance-authoritative-live-token",
        wechatAccountId: "wx-main",
        userId: "u-main",
        createdAt: 1_700_634_000_000,
      }
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-authoritative-live-token-question")]: {
          kind: "question",
          requestID: "req-authoritative-live-token-question",
          routeKey: "route-authoritative-live-token-question",
          handle: "q5",
          scopeKey: "instance-authoritative-live-token",
          wechatAccountId: "wx-main",
          userId: "u-main",
          status: "open",
          createdAt: 1_700_634_000_000,
        },
      }
      state.deliveryTokens = {
        [createBrokerDeliveryTokenKey("wx-main", "u-main")]: {
          wechatAccountId: "wx-main",
          userId: "u-main",
          contextToken: "authoritative-live-token",
          updatedAt: 1_700_634_000_100,
          source: "message",
          sourceRef: "/status",
        },
      }
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0]?.contextToken, "authoritative-live-token")
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("authoritative-live-token-question"), "utf8"))
    assert.equal(record.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("通知分发：旧 live token 文件不会为 authoritative open question 注入 contextToken", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-legacy-token-no-context-")

  const commonSettingsStore = await import(`${DIST_COMMON_SETTINGS_STORE_MODULE}?reload=${Date.now()}-legacy-token-no-context-settings`)
  const notificationDispatcher = await import(`${DIST_NOTIFICATION_DISPATCHER_MODULE}?reload=${Date.now()}-legacy-token-no-context-dispatcher`)
  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-legacy-token-no-context-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-legacy-token-no-context-state-paths`)

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
      idempotencyKey: "legacy-token-no-context-question",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-legacy-token-no-context-question",
      handle: "q7",
      createdAt: 1_700_636_000_001,
    })
    await writeLegacyTokenRecord(statePaths, "wx-main", "u-main", {
      contextToken: "legacy-live-token",
      updatedAt: 1_700_636_000_100,
      source: "message",
      sourceRef: "/status",
    })
    await persistAuthoritativeBrokerState("legacy-token-no-context-state", async (state) => {
      state.active.questions["route-legacy-token-no-context-question"] = {
        routeKey: "route-legacy-token-no-context-question",
        handle: "q7",
        requestID: "req-legacy-token-no-context-question",
        scopeKey: "instance-legacy-token-no-context",
        instanceID: "instance-legacy-token-no-context",
        wechatAccountId: "wx-main",
        userId: "u-main",
        createdAt: 1_700_636_000_000,
      }
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-legacy-token-no-context-question")]: {
          kind: "question",
          requestID: "req-legacy-token-no-context-question",
          routeKey: "route-legacy-token-no-context-question",
          handle: "q7",
          scopeKey: "instance-legacy-token-no-context",
          wechatAccountId: "wx-main",
          userId: "u-main",
          status: "open",
          createdAt: 1_700_636_000_000,
        },
      }
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input)
      },
    })

    await dispatcher.drainOutboundMessages()

    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0]?.contextToken, undefined)
    const record = JSON.parse(await readFile(statePaths.notificationStatePath("legacy-token-no-context-question"), "utf8"))
    assert.equal(record.status, "sent")
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("notification-store live read path 不再因旧 request/dead-letter 回填 scopeKey", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-notification-no-live-backfill-")

  const notificationStore = await import(`${DIST_NOTIFICATION_STORE_MODULE}?reload=${Date.now()}-no-live-backfill-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-no-live-backfill-state-paths`)

  try {
    await notificationStore.upsertNotification({
      idempotencyKey: "notification-no-live-backfill-q1",
      kind: "question",
      wechatAccountId: "wx-main",
      userId: "u-main",
      routeKey: "route-no-live-backfill-q1",
      handle: "q8",
      createdAt: 1_700_637_000_001,
    })
    await writeLegacyRequestRecord(statePaths, {
      kind: "question",
      requestID: "req-no-live-backfill-q1",
      routeKey: "route-no-live-backfill-q1",
      handle: "q8",
      scopeKey: "instance-request-backfill",
      wechatAccountId: "wx-main",
      userId: "u-main",
      status: "open",
      createdAt: 1_700_637_000_000,
    })
    const deadLetterPath = statePaths.wechatDeadLetterPath("question", "route-no-live-backfill-q1")
    await mkdir(path.dirname(deadLetterPath), { recursive: true })
    await writeFile(deadLetterPath, JSON.stringify({
      kind: "question",
      routeKey: "route-no-live-backfill-q1",
      requestID: "req-no-live-backfill-q1",
      handle: "q8",
      scopeKey: "instance-dead-letter-backfill",
      finalStatus: "expired",
      reason: "instanceStale",
      createdAt: 1_700_637_000_000,
      finalizedAt: 1_700_637_000_100,
      wechatAccountId: "wx-main",
      userId: "u-main",
    }))

    const pending = await notificationStore.listPendingNotifications()
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.scopeKey, undefined)

    const raw = JSON.parse(await readFile(statePaths.notificationStatePath("notification-no-live-backfill-q1"), "utf8"))
    assert.equal(raw.scopeKey, undefined)
  } finally {
    await isolatedWechatStateRoot.restore()
  }
})

test("broker runtime stale 只推进 broker-state-store authoritative state，不改写旧 request/dead-letter/notification 文件", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-runtime-authoritative-stale-")
  const previousHeartbeatTimeout = process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
  process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = "1"

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-runtime-authoritative-stale-server`)
  const brokerStateStore = await import(`${DIST_BROKER_STATE_STORE_MODULE}?reload=${Date.now()}-runtime-authoritative-stale-state-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-runtime-authoritative-stale-state-paths`)

  const staleAt = Date.now() - 10_000

  try {
    await writeLegacyRequestRecord(statePaths, {
      kind: "question",
      requestID: "req-runtime-authoritative-stale-q1",
      routeKey: "route-runtime-authoritative-stale-q1",
      handle: "q9",
      scopeKey: "instance-runtime-authoritative-stale",
      wechatAccountId: "wx-runtime-authoritative-stale",
      userId: "u-runtime-authoritative-stale",
      status: "open",
      createdAt: 1_700_638_000_000,
    })
    await writeLegacyRequestRecord(statePaths, {
      kind: "permission",
      requestID: "req-runtime-authoritative-stale-p1",
      routeKey: "route-runtime-authoritative-stale-p1",
      handle: "p9",
      scopeKey: "instance-runtime-authoritative-stale",
      wechatAccountId: "wx-runtime-authoritative-stale",
      userId: "u-runtime-authoritative-stale",
      status: "open",
      createdAt: 1_700_638_000_100,
    })
    await notificationStoreSeedForRuntimeStale(statePaths)
    await persistAuthoritativeBrokerState("runtime-authoritative-stale", async (state) => {
      state.connections["instance-runtime-authoritative-stale"] = {
        "inc-runtime-authoritative-stale": {
          instanceID: "instance-runtime-authoritative-stale",
          instanceIncarnation: "inc-runtime-authoritative-stale",
          online: true,
          lastEventSeq: 10,
          lastAckedEventSeq: 10,
          lastSentBrokerSeq: 5,
          connectedAt: staleAt,
          lastObservedAt: staleAt,
        },
      }
      state.active.questions["route-runtime-authoritative-stale-q1"] = {
        routeKey: "route-runtime-authoritative-stale-q1",
        handle: "q9",
        requestID: "req-runtime-authoritative-stale-q1",
        scopeKey: "instance-runtime-authoritative-stale",
        instanceID: "instance-runtime-authoritative-stale",
        wechatAccountId: "wx-runtime-authoritative-stale",
        userId: "u-runtime-authoritative-stale",
        createdAt: 1_700_638_000_000,
      }
      state.active.permissions["route-runtime-authoritative-stale-p1"] = {
        routeKey: "route-runtime-authoritative-stale-p1",
        handle: "p9",
        requestID: "req-runtime-authoritative-stale-p1",
        scopeKey: "instance-runtime-authoritative-stale",
        instanceID: "instance-runtime-authoritative-stale",
        wechatAccountId: "wx-runtime-authoritative-stale",
        userId: "u-runtime-authoritative-stale",
        createdAt: 1_700_638_000_100,
      }
      state.active.naturalStops.s9 = {
        handle: "s9",
        scopeKey: "instance-runtime-authoritative-stale",
        instanceID: "instance-runtime-authoritative-stale",
        sessionID: "session-runtime-authoritative-stale",
        replyTarget: {
          instanceID: "instance-runtime-authoritative-stale",
          sessionID: "session-runtime-authoritative-stale",
        },
        redactedSummary: "需要补充自然中止说明",
        severityAdvice: "已停止并等待你的回复",
      }
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-runtime-authoritative-stale-q1")]: {
          kind: "question",
          requestID: "req-runtime-authoritative-stale-q1",
          routeKey: "route-runtime-authoritative-stale-q1",
          handle: "q9",
          scopeKey: "instance-runtime-authoritative-stale",
          wechatAccountId: "wx-runtime-authoritative-stale",
          userId: "u-runtime-authoritative-stale",
          status: "open",
          createdAt: 1_700_638_000_000,
        },
        [createBrokerRequestIndexKey("permission", "route-runtime-authoritative-stale-p1")]: {
          kind: "permission",
          requestID: "req-runtime-authoritative-stale-p1",
          routeKey: "route-runtime-authoritative-stale-p1",
          handle: "p9",
          scopeKey: "instance-runtime-authoritative-stale",
          wechatAccountId: "wx-runtime-authoritative-stale",
          userId: "u-runtime-authoritative-stale",
          status: "open",
          createdAt: 1_700_638_000_100,
        },
      }
    })

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-runtime-authoritative-stale-endpoint-"))
    const endpoint = createBrokerEndpoint(tempDir)
    const server = await brokerServer.startBrokerServer(endpoint)

    try {
      await waitFor(async () => {
        const persisted = await brokerStateStore.loadBrokerStateStoreSnapshot()
        const question = await brokerStateStore.readBrokerIndexedRequest({ kind: "question", routeKey: "route-runtime-authoritative-stale-q1" }, persisted)
        const permission = await brokerStateStore.readBrokerIndexedRequest({ kind: "permission", routeKey: "route-runtime-authoritative-stale-p1" }, persisted)
        assert.equal(question?.status, "expired")
        assert.equal(permission?.status, "expired")
        assert.equal(persisted?.active.naturalStops.s9, undefined)
        assert.match(persisted?.legacyHandleClosures.q9?.reason ?? "", /expired/)
        assert.match(persisted?.legacyHandleClosures.p9?.reason ?? "", /expired/)
        assert.match(persisted?.legacyHandleClosures.s9?.reason ?? "", /expired/)
      }, 4000)

      const questionLegacy = JSON.parse(await readFile(statePaths.requestStatePath("question", "route-runtime-authoritative-stale-q1"), "utf8"))
      const permissionLegacy = JSON.parse(await readFile(statePaths.requestStatePath("permission", "route-runtime-authoritative-stale-p1"), "utf8"))
      const questionNotification = JSON.parse(await readFile(statePaths.notificationStatePath("notif-runtime-authoritative-stale-q1"), "utf8"))
      const deadLetterPath = statePaths.wechatDeadLetterPath("question", "route-runtime-authoritative-stale-q1")

      assert.equal(questionLegacy.status, "open")
      assert.equal(permissionLegacy.status, "open")
      assert.equal(questionNotification.status, "sent")
      await assert.rejects(() => readFile(deadLetterPath, "utf8"), /ENOENT|enoent/)
    } finally {
      await server.close().catch(() => {})
    }
  } finally {
    if (previousHeartbeatTimeout === undefined) {
      delete process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS
    } else {
      process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS = previousHeartbeatTimeout
    }
    await isolatedWechatStateRoot.restore()
  }
})

test("broker runtime cleanup 只看 broker-state-store terminal index，不依赖旧 request-store active list", async () => {
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-runtime-authoritative-cleanup-")
  const previousCleanAfterMs = process.env.WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS
  process.env.WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS = "1"

  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}-runtime-authoritative-cleanup-server`)
  const brokerStateStore = await import(`${DIST_BROKER_STATE_STORE_MODULE}?reload=${Date.now()}-runtime-authoritative-cleanup-state-store`)
  const statePaths = await import(`${DIST_STATE_PATHS_MODULE}?reload=${Date.now()}-runtime-authoritative-cleanup-state-paths`)

  try {
    await writeLegacyRequestRecord(statePaths, {
      kind: "question",
      requestID: "req-runtime-authoritative-cleanup-q1",
      routeKey: "route-runtime-authoritative-cleanup-q1",
      handle: "q10",
      scopeKey: "instance-runtime-authoritative-cleanup",
      wechatAccountId: "wx-runtime-authoritative-cleanup",
      userId: "u-runtime-authoritative-cleanup",
      status: "open",
      createdAt: 1_700_639_000_000,
    })
    await persistAuthoritativeBrokerState("runtime-authoritative-cleanup", async (state) => {
      state.requestIndex = {
        [createBrokerRequestIndexKey("question", "route-runtime-authoritative-cleanup-q1")]: {
          kind: "question",
          requestID: "req-runtime-authoritative-cleanup-q1",
          routeKey: "route-runtime-authoritative-cleanup-q1",
          handle: "q10",
          scopeKey: "instance-runtime-authoritative-cleanup",
          wechatAccountId: "wx-runtime-authoritative-cleanup",
          userId: "u-runtime-authoritative-cleanup",
          status: "answered",
          createdAt: 1_700_639_000_000,
          answeredAt: 1,
          terminalReason: "answered",
        },
      }
      state.terminalMetadata["route-runtime-authoritative-cleanup-q1"] = {
        reason: "answered",
        handle: "q10",
        requestID: "req-runtime-authoritative-cleanup-q1",
        scopeKey: "instance-runtime-authoritative-cleanup",
        wechatAccountId: "wx-runtime-authoritative-cleanup",
        userId: "u-runtime-authoritative-cleanup",
        createdAt: 1_700_639_000_000,
        answeredAt: 1,
      }
    })

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-runtime-authoritative-cleanup-endpoint-"))
    const endpoint = createBrokerEndpoint(tempDir)
    const server = await brokerServer.startBrokerServer(endpoint)

    try {
      await waitFor(async () => {
        const persisted = await brokerStateStore.loadBrokerStateStoreSnapshot()
        const question = await brokerStateStore.readBrokerIndexedRequest({ kind: "question", routeKey: "route-runtime-authoritative-cleanup-q1" }, persisted)
        assert.equal(question?.status, "cleaned")
        assert.equal(typeof question?.cleanedAt, "number")
      }, 4000)

      const legacyQuestion = JSON.parse(await readFile(statePaths.requestStatePath("question", "route-runtime-authoritative-cleanup-q1"), "utf8"))
      assert.equal(legacyQuestion.status, "open")
    } finally {
      await server.close().catch(() => {})
    }
  } finally {
    if (previousCleanAfterMs === undefined) {
      delete process.env.WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS
    } else {
      process.env.WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS = previousCleanAfterMs
    }
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

  const registerAndSync = async ({ requestID, idempotencyKey }) => registerAndSyncCandidates({
    endpoint,
    protocol: null,
    instanceID: "instance-task6",
    candidates: [{
      idempotencyKey,
      kind: "question",
      requestID,
      createdAt: 1_700_800_000_000,
      routeKey: `bridge-route-${requestID}`,
      handle: "q999",
    }],
  })

  let server = await brokerServer.startBrokerServer(endpoint)
  try {
    await registerAndSync({ requestID: "req-task6", idempotencyKey: "question-instance-task6-req-task6-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-open"), true)
    })

    const sendCalls = []
    const dispatcher = notificationDispatcher.createWechatNotificationDispatcher({
      sendMessage: async (input) => {
        sendCalls.push(input.text)
      },
    })
    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls.length, 1)

    await server.close()
    server = await brokerServer.startBrokerServer(endpoint)
    await registerAndSync({ requestID: "req-task6", idempotencyKey: "question-instance-task6-req-task6-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-open"), false)
    })
    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls.length, 1)

    await server.close()
    server = await brokerServer.startBrokerServer(endpoint)
    await registerAndSync({ requestID: "req-task6-next", idempotencyKey: "question-instance-task6-req-task6-next-open" })

    await waitFor(async () => {
      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.some((item) => item.idempotencyKey === "question-instance-task6-req-task6-next-open"), true)
      assert.equal(pending.some((item) => item.kind === "requestTerminal" && item.handle === "q1"), true)
    })

    await dispatcher.drainOutboundMessages()
    assert.equal(sendCalls.length, 3)
    assert.equal(sendCalls.some((text) => /收到新的问题请求（q2）/.test(text)), true)
    assert.equal(sendCalls.some((text) => /问题入口 q1 已结束/.test(text)), true)
  } finally {
    await server.close().catch(() => {})
    await isolatedWechatStateRoot.restore()
  }
})
