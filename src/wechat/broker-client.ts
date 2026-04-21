import { createBrokerSocket } from "./broker-endpoint.js"
import {
  createBridgeEventEnvelope,
  createHelloRegisterEnvelope,
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerAckPayload,
  type BrokerToBridgeCommand,
  type BrokerToBridgeControl,
  type BrokerEnvelope,
  type BrokerMessageType,
  type BridgeToBrokerEvent,
  type CollectStatusPayload,
  type HelloRegisterPayload,
  type RegisterAckPayload,
  SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
  type ShowFallbackToastPayload,
  type SyncWechatNotificationsPayload,
} from "./protocol.js"
import type { WechatBridge } from "./bridge.js"

type RegisterMeta = {
  instanceID: string
  pid: number
}

type RegisterInstanceOptions = {
  notificationCandidates?: SyncWechatNotificationsPayload["candidates"]
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
  registerInstance: (meta: RegisterMeta, options?: RegisterInstanceOptions) => Promise<RegisterAck>
  registerHello: (payload: HelloRegisterPayload) => Promise<LiveRegisterResult>
  heartbeat: () => Promise<BrokerEnvelope>
  sendBridgeEvent: (event: BridgeToBrokerEvent, options: SendBridgeEventOptions) => Promise<BrokerAckPayload>
  getSessionSnapshot: () => SessionSnapshot | null
  setLiveHandlers: (handlers: BrokerClientLiveHandlers) => void
  close: () => Promise<void>
}

type PendingRequest = {
  resolve: (value: BrokerEnvelope) => void
  reject: (reason?: unknown) => void
  requestType: BrokerMessageType
  requestInstanceID: string | null
}

export type CollectStatusInput = {
  requestId: string
}

export type BrokerClientOptions = {
  onCollectStatus?: (input: CollectStatusInput) => Promise<unknown> | unknown
  bridge?: WechatBridge
  onBrokerControl?: (control: BrokerToBridgeControl) => Promise<void> | void
  onBrokerCommand?: (command: BrokerToBridgeCommand) => Promise<void> | void
}

export type LiveRegisterResult = {
  ack: RegisterAckPayload
  control?: BrokerToBridgeControl
  pendingCommands: BrokerToBridgeCommand[]
}

export type SendBridgeEventOptions = {
  instanceID: string
  controlId?: string
}

export type BrokerClientLiveHandlers = {
  onBrokerControl?: BrokerClientOptions["onBrokerControl"]
  onBrokerCommand?: BrokerClientOptions["onBrokerCommand"]
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLiveBrokerCommandPayload(value: unknown): value is BrokerToBridgeCommand {
  if (!isObject(value)) {
    return false
  }
  return isNonEmptyString(value.commandId)
    && isFiniteNumber(value.brokerSeq)
    && isNonEmptyString(value.type)
    && "payload" in value
}

function isLiveBrokerControlPayload(value: unknown): value is BrokerToBridgeControl {
  if (!isObject(value)) {
    return false
  }
  return isNonEmptyString(value.controlId)
    && isFiniteNumber(value.brokerSeq)
    && isNonEmptyString(value.type)
    && "payload" in value
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
  const pendingRequests = new Map<string, PendingRequest>()
  let buffer = ""
  let connected = false
  let closed = false
  let session: SessionSnapshot | null = null
  let liveRegistrationInstanceID: string | null = null
  let serverPushChain: Promise<void> = Promise.resolve()
  let liveHandlers: BrokerClientLiveHandlers = {
    onBrokerControl: options.onBrokerControl,
    onBrokerCommand: options.onBrokerCommand,
  }

  function enqueueServerPush(task: () => Promise<void> | void): void {
    serverPushChain = serverPushChain
      .then(() => task())
      .catch(() => {
        // swallow push handler failures to keep connection alive
      })
  }

  function deletePendingRequest(requestId: string): PendingRequest | undefined {
    const pending = pendingRequests.get(requestId)
    if (!pending) {
      return undefined
    }
    pendingRequests.delete(requestId)
    return pending
  }

  function rejectPendingRequest(requestId: string, reason: unknown) {
    deletePendingRequest(requestId)?.reject(reason)
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

  function findPendingRequest(response: BrokerEnvelope): [string, PendingRequest] | null {
    if (response.type === "error") {
      const requestId = (response.payload as { requestId?: unknown }).requestId
      if (isNonEmptyString(requestId)) {
        const pending = pendingRequests.get(requestId)
        if (pending) {
          return [requestId, pending]
        }
      }
    }

    const direct = pendingRequests.get(response.id)
    if (direct) {
      return [response.id, direct]
    }

    for (const [requestId, pending] of pendingRequests.entries()) {
      if (isResponseForRequest(response, requestId)) {
        return [requestId, pending]
      }
    }

    return null
  }

  function stageRegisterAckSession(requestId: string, pending: PendingRequest, response: BrokerEnvelope) {
    if (pending.requestType !== "registerInstance" || !isNonEmptyString(pending.requestInstanceID)) {
      return
    }
    if (!isResponseForRequest(response, requestId) || response.type !== "registerAck") {
      return
    }

    session = toSessionSnapshot(pending.requestInstanceID, response.payload as Partial<RegisterAck>)
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
        for (const requestId of [...pendingRequests.keys()]) {
          rejectPendingRequest(requestId, error)
        }
      }
    }

    if (parsedFrames.length === 0) {
      return
    }

    for (const parsed of parsedFrames) {
      if (handleServerPush(parsed)) {
        continue
      }

      const matched = findPendingRequest(parsed)
      if (!matched) {
        continue
      }

      const [requestId, pending] = matched
      try {
        stageRegisterAckSession(requestId, pending, parsed)
      } catch (error) {
        rejectPendingRequest(requestId, error)
        continue
      }

      deletePendingRequest(requestId)?.resolve(parsed)
    }
  })

  socket.on("error", (error) => {
    for (const requestId of [...pendingRequests.keys()]) {
      rejectPendingRequest(requestId, error)
    }
  })

  socket.on("close", () => {
    connected = false
    closed = true
    session = null
    for (const requestId of [...pendingRequests.keys()]) {
      rejectPendingRequest(requestId, new Error("broker connection closed"))
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

  function handleBrokerControlPush(envelope: BrokerEnvelope): boolean {
    if (envelope.type !== "requestReplay" && envelope.type !== "requestFullSync") {
      return false
    }
    if (!liveHandlers.onBrokerControl || !isLiveBrokerControlPayload(envelope.payload)) {
      return false
    }

    const control = envelope.payload
    enqueueServerPush(() => liveHandlers.onBrokerControl?.(control))
    return true
  }

  function handleBrokerCommandPush(envelope: BrokerEnvelope): boolean {
    if (
      envelope.type !== "replyQuestion"
      && envelope.type !== "replyPermission"
      && envelope.type !== "replyNaturalStop"
    ) {
      return false
    }
    if (!liveHandlers.onBrokerCommand || !isLiveBrokerCommandPayload(envelope.payload)) {
      return false
    }

    const command = envelope.payload
    enqueueServerPush(() => liveHandlers.onBrokerCommand?.(command))
    return true
  }

  function handleReplyEnvelope(envelope: BrokerEnvelope): boolean {
    if (!options.bridge?.handleBrokerEnvelope) {
      return false
    }
    if (
      envelope.type !== "replyQuestion"
      && envelope.type !== "replyPermission"
      && envelope.type !== "replyNaturalStop"
    ) {
      return false
    }

    enqueueServerPush(async () => {
      const response = await options.bridge?.handleBrokerEnvelope?.(envelope)
        if (!response || !session) {
          return
        }
        socket.write(serializeEnvelope({
          ...response,
          instanceID: session.instanceID,
          sessionToken: session.sessionToken,
        }))
      })
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
    if (handleBrokerControlPush(envelope)) {
      return true
    }
    if (handleBrokerCommandPush(envelope)) {
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

    return new Promise((resolve, reject) => {
      pendingRequests.set(envelope.id, {
        resolve,
        reject,
        requestType: envelope.type,
        requestInstanceID: envelope.instanceID ?? null,
      })
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
    async registerInstance(meta, registerOptions = {}) {
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

      if (Array.isArray(registerOptions.notificationCandidates)) {
        sendSyncWechatNotifications(registerOptions.notificationCandidates)
      } else if (options.bridge?.collectNotificationCandidates && liveRegistrationInstanceID !== instanceID) {
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
    async registerHello(payload) {
      const hello = createHelloRegisterEnvelope(payload)
      const response = await send({
        id: nextRequestId("hello-register"),
        type: "hello/register",
        instanceID: hello.payload.instanceID,
        payload: hello.payload,
      })

      if (response.type !== "registerAck" || !isObject(response.payload)) {
        throw new Error("hello/register failed")
      }

      const ackPayload = response.payload as RegisterAckPayload & {
        control?: BrokerToBridgeControl
        pendingCommands?: BrokerToBridgeCommand[]
      }
      liveRegistrationInstanceID = hello.payload.instanceID

      return {
        ack: {
          protocolVersion: ackPayload.protocolVersion,
          stateGeneration: ackPayload.stateGeneration,
          instanceIncarnation: ackPayload.instanceIncarnation,
          brokerSeq: ackPayload.brokerSeq,
          needReplay: ackPayload.needReplay,
          needFullSync: ackPayload.needFullSync,
        },
        ...(isLiveBrokerControlPayload(ackPayload.control) ? { control: ackPayload.control } : {}),
        pendingCommands: Array.isArray(ackPayload.pendingCommands)
          ? ackPayload.pendingCommands.filter((command): command is BrokerToBridgeCommand => isLiveBrokerCommandPayload(command))
          : [],
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
    async sendBridgeEvent(event, options) {
      const bridgeEvent = createBridgeEventEnvelope(
        options.controlId ? { ...event, controlId: options.controlId } : event,
      )
      const response = await send({
        id: nextRequestId(bridgeEvent.type),
        type: bridgeEvent.type,
        instanceID: options.instanceID,
        payload: bridgeEvent,
      })

      if (response.type !== "ack" || !isObject(response.payload)) {
        throw new Error(`bridge event ack failed: ${bridgeEvent.type}`)
      }

      return response.payload as BrokerAckPayload
    },
    getSessionSnapshot() {
      if (!session) {
        return null
      }
      return { ...session }
    },
    setLiveHandlers(handlers) {
      liveHandlers = {
        ...liveHandlers,
        ...handlers,
      }
    },
    async close() {
      if (closed) {
        return
      }
      if (socket.destroyed) {
        closed = true
        connected = false
        session = null
        liveRegistrationInstanceID = null
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
      liveRegistrationInstanceID = null
    },
  }
}
