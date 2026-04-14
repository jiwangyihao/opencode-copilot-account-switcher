import { createBrokerSocket } from "./broker-endpoint.js"
import {
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerEnvelope,
  type BrokerMessageType,
  type CollectStatusPayload,
  SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
  type ShowFallbackToastPayload,
  type SyncWechatNotificationsPayload,
} from "./protocol.js"
import type { WechatBridge } from "./bridge.js"

type RegisterMeta = {
  instanceID: string
  pid: number
}

export type RegisterAck = {
  sessionToken: string
  registeredAt: number
  registrationEpoch: string
  brokerPid: number
}

type SessionSnapshot = {
  instanceID: string
  sessionToken: string
  registeredAt: number
  registrationEpoch: string
  brokerPid: number
}

type BrokerClient = {
  ping: () => Promise<BrokerEnvelope>
  registerInstance: (meta: RegisterMeta) => Promise<RegisterAck>
  heartbeat: () => Promise<BrokerEnvelope>
  getSessionSnapshot: () => SessionSnapshot | null
  close: () => Promise<void>
}

export type CollectStatusInput = {
  requestId: string
}

export type BrokerClientOptions = {
  onCollectStatus?: (input: CollectStatusInput) => Promise<unknown> | unknown
  bridge?: WechatBridge
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isShowFallbackToastPayload(value: unknown): value is ShowFallbackToastPayload {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const payload = value as Partial<ShowFallbackToastPayload>
  return isNonEmptyString(payload.wechatAccountId)
    && isNonEmptyString(payload.userId)
    && isNonEmptyString(payload.message)
    && isNonEmptyString(payload.registrationEpoch)
    && payload.reason === SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON
}

function isResponseForRequest(response: BrokerEnvelope, requestId: string): boolean {
  if (response.id === requestId) {
    return true
  }
  if (response.id.endsWith(`-${requestId}`)) {
    return true
  }
  if (response.type === "error") {
    const payload = response.payload as { requestId?: unknown }
    return payload.requestId === requestId
  }
  return false
}

export async function connect(endpoint: string, options: BrokerClientOptions = {}): Promise<BrokerClient> {
  if (options.bridge && options.onCollectStatus) {
    throw new Error("broker client options are ambiguous: provide either bridge or onCollectStatus")
  }

  const socket = createBrokerSocket(endpoint)
  let sequence = 0
  let pendingResolve: ((value: BrokerEnvelope) => void) | null = null
  let pendingReject: ((reason?: unknown) => void) | null = null
  let pendingRequestId: string | null = null
  let pendingRequestType: BrokerMessageType | null = null
  let pendingRequestInstanceID: string | null = null
  let buffer = ""
  let connected = false
  let closed = false
  let session: SessionSnapshot | null = null

  function clearPendingRequest() {
    pendingResolve = null
    pendingReject = null
    pendingRequestId = null
    pendingRequestType = null
    pendingRequestInstanceID = null
  }

  function rejectPendingRequest(reason: unknown) {
    const reject = pendingReject
    clearPendingRequest()
    reject?.(reason)
  }

  function toSessionSnapshot(instanceID: string, payload: Partial<RegisterAck>): SessionSnapshot {
    if (!isNonEmptyString(payload.sessionToken)) {
      throw new Error("registerAck missing sessionToken")
    }
    if (!isFiniteNumber(payload.registeredAt)) {
      throw new Error("registerAck missing registeredAt")
    }
    if (!isNonEmptyString(payload.registrationEpoch)) {
      throw new Error("registerAck missing registrationEpoch")
    }
    if (!isFiniteNumber(payload.brokerPid)) {
      throw new Error("registerAck missing brokerPid")
    }

    return {
      instanceID,
      sessionToken: payload.sessionToken,
      registeredAt: payload.registeredAt,
      registrationEpoch: payload.registrationEpoch,
      brokerPid: payload.brokerPid,
    }
  }

  function stageRegisterAckSession(frames: BrokerEnvelope[]) {
    if (
      !pendingResolve
      || pendingRequestId === null
      || pendingRequestType !== "registerInstance"
      || !isNonEmptyString(pendingRequestInstanceID)
    ) {
      return
    }

    const requestId = pendingRequestId

    const matchingRegisterAck = frames.find(
      (frame) => frame.type === "registerAck" && isResponseForRequest(frame, requestId),
    )
    if (!matchingRegisterAck) {
      return
    }

    session = toSessionSnapshot(pendingRequestInstanceID, matchingRegisterAck.payload as Partial<RegisterAck>)
  }

  const connectedReady = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      connected = true
      resolve()
    })
    socket.once("error", reject)
  })

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    const parsedFrames: BrokerEnvelope[] = []
    while (true) {
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        break
      }

      const frame = buffer.slice(0, newlineIndex + 1)
      buffer = buffer.slice(newlineIndex + 1)
      try {
        parsedFrames.push(parseEnvelopeLine(frame))
      } catch (error) {
        if (pendingReject) {
          rejectPendingRequest(error)
        }
      }
    }

    if (parsedFrames.length === 0) {
      return
    }

    try {
      stageRegisterAckSession(parsedFrames)
    } catch (error) {
      if (pendingReject) {
        rejectPendingRequest(error)
      }
      return
    }

    for (const parsed of parsedFrames) {
      if (pendingResolve) {
        if (handleServerPush(parsed)) {
          continue
        }

        if (pendingRequestId && !isResponseForRequest(parsed, pendingRequestId)) {
          continue
        }

        const resolve = pendingResolve
        clearPendingRequest()
        resolve?.(parsed)
        continue
      }

      handleServerPush(parsed)
    }
  })

  socket.on("error", (error) => {
    if (pendingReject) {
      rejectPendingRequest(error)
    }
  })

  socket.on("close", () => {
    connected = false
    closed = true
    session = null
    if (pendingReject) {
      rejectPendingRequest(new Error("broker connection closed"))
    }
  })

  await connectedReady

  function nextRequestId(prefix: string) {
    sequence += 1
    return `${prefix}-${Date.now()}-${sequence}`
  }

  function sendStatusSnapshot(requestId: string, snapshot: unknown) {
    if (!session) {
      return
    }

    const envelope: BrokerEnvelope = {
      id: nextRequestId("statusSnapshot"),
      type: "statusSnapshot",
      instanceID: session.instanceID,
      sessionToken: session.sessionToken,
      payload: {
        requestId,
        snapshot,
      },
    }
    socket.write(serializeEnvelope(envelope))
  }

  function sendSyncWechatNotifications(candidates: SyncWechatNotificationsPayload["candidates"]) {
    if (!session || candidates.length === 0) {
      return
    }

    const envelope: BrokerEnvelope<SyncWechatNotificationsPayload> = {
      id: nextRequestId("syncWechatNotifications"),
      type: "syncWechatNotifications",
      instanceID: session.instanceID,
      sessionToken: session.sessionToken,
      payload: {
        candidates,
      },
    }
    socket.write(serializeEnvelope(envelope))
  }

  function handleCollectStatus(envelope: BrokerEnvelope) {
    const payload = envelope.payload as Partial<CollectStatusPayload>
    if (!isNonEmptyString(payload.requestId)) {
      return
    }
    const hasBridge = options.bridge !== undefined
    const hasHook = options.onCollectStatus !== undefined
    if (!hasBridge && !hasHook) {
      return
    }

    const collectPromise = hasBridge
      ? options.bridge!.collectStatusSnapshot()
      : options.onCollectStatus!({ requestId: payload.requestId })

    void Promise.resolve(collectPromise)
      .then((snapshot) => {
        sendStatusSnapshot(payload.requestId as string, snapshot)
      })
      .catch(() => {
        // swallow collect handler errors to keep socket alive
      })
  }

  function handleShowFallbackToast(envelope: BrokerEnvelope) {
    const payload = envelope.payload
    if (!isShowFallbackToastPayload(payload)) {
      return
    }
    if (!session) {
      return
    }
    if (envelope.instanceID !== session.instanceID) {
      return
    }
    if (envelope.sessionToken !== session.sessionToken) {
      return
    }
    if (payload.registrationEpoch !== session.registrationEpoch) {
      return
    }

    void Promise.resolve(options.bridge?.showFallbackToast?.(payload)).catch(() => {})
  }

  function handleReplyEnvelope(envelope: BrokerEnvelope): boolean {
    if (!options.bridge?.handleBrokerEnvelope) {
      return false
    }
    if (envelope.type !== "replyQuestion" && envelope.type !== "replyPermission") {
      return false
    }

    void Promise.resolve(options.bridge.handleBrokerEnvelope(envelope))
      .then((response) => {
        if (!response || !session) {
          return
        }
        socket.write(serializeEnvelope({
          ...response,
          instanceID: session.instanceID,
          sessionToken: session.sessionToken,
        }))
      })
      .catch(() => {})
    return true
  }

  function handleServerPush(envelope: BrokerEnvelope): boolean {
    if (envelope.type === "collectStatus") {
      handleCollectStatus(envelope)
      return true
    }
    if (envelope.type === "showFallbackToast") {
      handleShowFallbackToast(envelope)
      return true
    }
    if (handleReplyEnvelope(envelope)) {
      return true
    }
    return false
  }

  async function send(envelope: BrokerEnvelope): Promise<BrokerEnvelope> {
    if (!connected || closed) {
      throw new Error("broker connection closed")
    }
    if (pendingResolve) {
      throw new Error("broker client has pending request")
    }

    return new Promise((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      pendingRequestId = envelope.id
      pendingRequestType = envelope.type
      pendingRequestInstanceID = envelope.instanceID ?? null
      socket.write(serializeEnvelope(envelope))
    })
  }

  return {
    async ping() {
      return send({
        id: nextRequestId("ping"),
        type: "ping",
        payload: {},
      })
    },
    async registerInstance(meta) {
      const instanceID = meta.instanceID
      if (!isNonEmptyString(instanceID)) {
        throw new Error("invalid instanceID")
      }
      if (!isFiniteNumber(meta.pid)) {
        throw new Error("invalid pid")
      }

      const response = await send({
        id: nextRequestId("register"),
        type: "registerInstance",
        instanceID,
        payload: { pid: meta.pid },
      })

      if (response.type !== "registerAck") {
        throw new Error("register failed")
      }

      session = toSessionSnapshot(instanceID, response.payload as Partial<RegisterAck>)

      if (options.bridge?.collectNotificationCandidates) {
        try {
          const candidates = await options.bridge.collectNotificationCandidates()
          sendSyncWechatNotifications(candidates)
        } catch {
          // swallow candidate collection errors to keep register path available
        }
      }

      return {
        sessionToken: session.sessionToken,
        registeredAt: session.registeredAt,
        registrationEpoch: session.registrationEpoch,
        brokerPid: session.brokerPid,
      }
    },
    async heartbeat() {
      if (!session) {
        throw new Error("missing broker session")
      }

      const response = await send({
        id: nextRequestId("heartbeat"),
        type: "heartbeat",
        instanceID: session.instanceID,
        sessionToken: session.sessionToken,
        payload: {},
      })

      if (options.bridge?.collectNotificationCandidates) {
        void Promise.resolve(options.bridge.collectNotificationCandidates())
          .then((candidates) => {
            sendSyncWechatNotifications(candidates)
          })
          .catch(() => {})
      }

      return response
    },
    getSessionSnapshot() {
      if (!session) {
        return null
      }
      return { ...session }
    },
    async close() {
      if (closed) {
        return
      }
      if (socket.destroyed) {
        closed = true
        connected = false
        session = null
        return
      }

      const closePromise = new Promise<void>((resolve) => {
        socket.once("close", () => resolve())
      })
      socket.end()
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.destroy()
            }
            resolve()
          }, 200)
        }),
      ])
    },
  }
}
