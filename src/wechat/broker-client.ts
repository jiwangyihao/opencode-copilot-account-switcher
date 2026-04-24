import { createBrokerSocket } from "./broker-endpoint.js"
import {
  createBridgeEventEnvelope,
  createHelloRegisterEnvelope,
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerAckPayload,
  type BrokerEnvelope,
  type BrokerMessageType,
  type BrokerToBridgeCommand,
  type BrokerToBridgeControl,
  type BridgeToBrokerEvent,
  type HelloRegisterPayload,
  type RegisterAckPayload,
} from "./protocol.js"

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
  onBrokerControl?: (control: BrokerToBridgeControl) => Promise<void> | void
  onBrokerCommand?: (command: BrokerToBridgeCommand) => Promise<void> | void
}

export type BrokerClientOptions = BrokerClientLiveHandlers

export type BrokerClient = {
  ping: () => Promise<BrokerEnvelope>
  registerHello: (payload: HelloRegisterPayload) => Promise<LiveRegisterResult>
  sendBridgeEvent: (event: BridgeToBrokerEvent, options: SendBridgeEventOptions) => Promise<BrokerAckPayload>
  setLiveHandlers: (handlers: BrokerClientLiveHandlers) => void
  close: () => Promise<void>
}

type PendingRequest = {
  resolve: (value: BrokerEnvelope) => void
  reject: (reason?: unknown) => void
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
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
  const socket = createBrokerSocket(endpoint)
  let sequence = 0
  const pendingRequests = new Map<string, PendingRequest>()
  let buffer = ""
  let connected = false
  let closed = false
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

      const [requestId] = matched
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
    for (const requestId of [...pendingRequests.keys()]) {
      rejectPendingRequest(requestId, new Error("broker connection closed"))
    }
  })

  await connectedReady

  function nextRequestId(prefix: string) {
    sequence += 1
    return `${prefix}-${Date.now()}-${sequence}`
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

  function handleServerPush(envelope: BrokerEnvelope): boolean {
    if (handleBrokerControlPush(envelope)) {
      return true
    }
    if (handleBrokerCommandPush(envelope)) {
      return true
    }
    return false
  }

  async function send(envelope: BrokerEnvelope): Promise<BrokerEnvelope> {
    if (!connected || closed) {
      throw new Error("broker connection closed")
    }

    return new Promise((resolve, reject) => {
      pendingRequests.set(envelope.id, { resolve, reject })
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
