import net from "node:net"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, rm, stat } from "node:fs/promises"
import { createBrokerSocket, isTcpBrokerEndpoint, listenOnBrokerEndpoint } from "./broker-endpoint.js"
import {
  createBrokerAckEnvelope,
  createBrokerCommandEnvelope,
  createBrokerControlEnvelope,
  createBridgeEventEnvelope,
  createErrorEnvelope,
  createHelloRegisterEnvelope,
  createRegisterAckEnvelope,
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerAckEnvelope,
  type BrokerToBridgeCommand,
  type BrokerToBridgeCommandType,
  type BrokerToBridgeControl,
  type BrokerEnvelope,
  type BridgeToBrokerEvent,
  type BridgeToBrokerEventType,
  type HelloRegisterPayload,
  type RegisterAckEnvelope,
  type ReplyMutationResult,
} from "./protocol.js"
import {
  applyBridgeEvent as applyBrokerStateEvent,
  cleanupBrokerRuntimeTerminalRequests,
  closeBrokerNaturalStopsForScope,
  createEmptyBrokerState,
  expireBrokerIndexedRequestsForScope,
  listTimedOutBrokerConnectionScopes,
  loadBrokerStateStoreSnapshot,
  markBrokerFullSyncCompleted,
  markBrokerConnectionObserved,
  markBrokerConnectionOffline,
  markBrokerReplayCompleted,
  markConnectionAckedEventSeq as markBrokerStateAckedEventSeq,
  markConnectionSentBrokerSeq as markBrokerStateSentBrokerSeq,
  persistBrokerStateStoreSnapshot,
  readBrokerAuthoritativeView,
  readBrokerControlRecord,
  setBrokerStateMutationTarget,
  requestBrokerFullSync,
  requestBrokerReplay,
  stageBrokerFullSyncEvent,
  upsertRetryErrorSummary,
  upsertBrokerCommand as upsertBrokerStateCommand,
  type BrokerCommandRecord,
  type BrokerState,
} from "./broker-state-store.js"
import { createBrokerMutationQueue } from "./broker-mutation-queue.js"
import {
  WECHAT_DIR_MODE,
  WECHAT_FILE_MODE,
  wechatBrokerDiagnosticsPath,
} from "./state-paths.js"
import { buildAggregatedStatusInstancesFromBrokerView, formatAggregatedStatusReplyFromBrokerView } from "./status-format.js"
import type { WechatSlashCommand } from "./command-parser.js"
import {
  findActiveNaturalStopByReplyTarget,
  listRetainedNaturalStopHandles,
  findMergeableNotification,
  upsertNotification,
} from "./notification-store.js"
import { readOperatorBinding } from "./operator-store.js"
import { createHandle, createRouteKey, createSessionReplyHandle } from "./handle.js"
import {
  findOpenRequestByIdentity,
  upsertRequest,
  type RequestRecord,
} from "./request-store.js"
import { markTokenStale, NOTIFICATION_DELIVERY_FAILED_STALE_REASON } from "./token-store.js"
import { purgeDeadLettersBefore } from "./dead-letter-store.js"

const FUTURE_MESSAGE_TYPES = new Set<string>([
  "replyQuestion",
  "rejectQuestion",
  "replyPermission",
])

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS = 1_000
export const DEFAULT_STATUS_COLLECT_WINDOW_MS = 5_000
const DEFAULT_REQUEST_CLEAN_AFTER_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_PURGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_REQUEST_CLEANUP_SCAN_INTERVAL_MS = 60_000
const DEFAULT_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_DEAD_LETTER_SCAN_INTERVAL_MS = 60_000
const DELIVERY_FAILURE_ACTION = "在微信发送 /status 重新激活"
const DELIVERY_FAILURE_SUMMARY = "微信通知发送失败，当前微信会话可能已失效"
const DELIVERY_FAILURE_SEVERITY = "建议尽快人工查看"

type BrokerServerTestHooks = {
  beforeFinalizeOpenRequest?: (input: { request: RequestRecord }) => Promise<void> | void
}

export const WECHAT_BROKER_WS_PROTOCOL_VERSION = 2
export const WECHAT_BROKER_WS_STATE_GENERATION = "wechat-ws-v1"

export type BrokerWsRegisterResult = {
  accepted: boolean
  ack: RegisterAckEnvelope
  control?: BrokerToBridgeControl
  pendingCommands: BrokerToBridgeCommand[]
}

export type BrokerWsHandleBridgeEventResult = {
  ack: BrokerAckEnvelope
}

export type BrokerWsCommandDispatchInput = {
  instanceID: string
  instanceIncarnation: string
  commandId: string
  type: BrokerToBridgeCommandType
  payload?: unknown
  target: Record<string, unknown>
}

export type BrokerWsCoordinator = {
  getState: () => BrokerState
  registerBridge: (hello: HelloRegisterPayload) => BrokerWsRegisterResult
  handleBridgeEvent: (
    event: BridgeToBrokerEvent,
    context: { instanceID: string; controlId?: string },
  ) => BrokerWsHandleBridgeEventResult
  dispatchCommand: (input: BrokerWsCommandDispatchInput) => BrokerToBridgeCommand | null
}

let brokerServerTestHooks: BrokerServerTestHooks | undefined

type IncomingBrokerEnvelope = {
  id: string
  type: string
  payload: unknown
  instanceID?: string
  sessionToken?: string
}

const LEGACY_REMOVED_MESSAGE_TYPES = new Set([
  "registerInstance",
  "heartbeat",
  "statusSnapshot",
  "syncWechatNotifications",
  "replyQuestionResult",
  "replyPermissionResult",
  "replyNaturalStopResult",
  "showFallbackToast",
  "collectStatus",
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function cloneWsValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T
  }
  if (typeof value === "object" && value !== null) {
    return { ...(value as Record<string, unknown>) } as T
  }
  return value
}

function readRecordInstanceID(record: BrokerCommandRecord): string | undefined {
  if (isNonEmptyString(record.instanceID)) {
    return record.instanceID
  }

  const value = record.target.instanceID
  return isNonEmptyString(value) ? value : undefined
}

function getStateMaxBrokerSeq(state: BrokerState): number {
  let maxBrokerSeq = 0

  for (const incarnations of Object.values(state.connections)) {
    for (const connection of Object.values(incarnations)) {
      maxBrokerSeq = Math.max(maxBrokerSeq, connection.lastSentBrokerSeq)
    }
  }

  for (const command of Object.values(state.commandLedger)) {
    maxBrokerSeq = Math.max(maxBrokerSeq, command.brokerSeq)
  }

  for (const control of Object.values(state.controlLedger)) {
    maxBrokerSeq = Math.max(maxBrokerSeq, control.brokerSeq)
  }

  return maxBrokerSeq
}

function toBrokerWsCommand(record: BrokerCommandRecord): BrokerToBridgeCommand {
  return createBrokerCommandEnvelope({
    brokerSeq: record.brokerSeq,
    commandId: record.commandId,
    type: record.type,
    payload: cloneWsValue(record.payload ?? {}),
  })
}

export function createBrokerWsCoordinator(input: {
  protocolVersion?: number
  stateGeneration?: string
  state?: BrokerState
} = {}): BrokerWsCoordinator {
  const protocolVersion = input.protocolVersion ?? WECHAT_BROKER_WS_PROTOCOL_VERSION
  const stateGeneration = input.stateGeneration ?? WECHAT_BROKER_WS_STATE_GENERATION
  const state = input.state ?? createEmptyBrokerState()
  let nextBrokerSeq = getStateMaxBrokerSeq(state)

  function allocateBrokerSeq(): number {
    nextBrokerSeq += 1
    return nextBrokerSeq
  }

  function registerBridge(hello: HelloRegisterPayload): BrokerWsRegisterResult {
    const accepted = hello.protocolVersion === protocolVersion && hello.stateGeneration === stateGeneration
    const connection = state.connections[hello.instanceID]?.[hello.instanceIncarnation]
    const lastAckedEventSeq = connection?.lastAckedEventSeq ?? 0
    const lastSentEventSeq = hello.lastSentEventSeq ?? 0
    let control: BrokerToBridgeControl | undefined
    let needReplay = false
    let needFullSync = false

    if (!accepted || !connection) {
      needFullSync = true
      const brokerSeq = allocateBrokerSeq()
      const controlId = `ctl-full-sync-${brokerSeq}`
      requestBrokerFullSync(state, {
        controlId,
        brokerSeq,
        instanceID: hello.instanceID,
        instanceIncarnation: hello.instanceIncarnation,
        reason: accepted ? "state-missing" : "protocol-mismatch",
      })
      control = createBrokerControlEnvelope({
        brokerSeq,
        controlId,
        type: "requestFullSync",
        payload: {
          instanceID: hello.instanceID,
          instanceIncarnation: hello.instanceIncarnation,
          reason: accepted ? "state-missing" : "protocol-mismatch",
        },
      })
    } else if (lastSentEventSeq > lastAckedEventSeq) {
      needReplay = true
      const brokerSeq = allocateBrokerSeq()
      const controlId = `ctl-replay-${brokerSeq}`
      requestBrokerReplay(state, {
        controlId,
        brokerSeq,
        instanceID: hello.instanceID,
        instanceIncarnation: hello.instanceIncarnation,
        fromEventSeq: lastAckedEventSeq + 1,
        toEventSeq: lastSentEventSeq,
      })
      control = createBrokerControlEnvelope({
        brokerSeq,
        controlId,
        type: "requestReplay",
        payload: {
          instanceID: hello.instanceID,
          instanceIncarnation: hello.instanceIncarnation,
          fromEventSeq: lastAckedEventSeq + 1,
          toEventSeq: lastSentEventSeq,
        },
      })
    }

    const pendingCommands = accepted
      ? Object.values(state.commandLedger)
          .filter((record) => {
            const recordInstanceID = readRecordInstanceID(record)
            if (recordInstanceID !== hello.instanceID) {
              return false
            }
            if (record.instanceIncarnation && record.instanceIncarnation !== hello.instanceIncarnation) {
              return false
            }
            return record.status === "queued" || record.status === "delivered"
          })
          .sort((left, right) => left.brokerSeq - right.brokerSeq)
          .map(toBrokerWsCommand)
      : []

    return {
      accepted,
      ack: createRegisterAckEnvelope({
        protocolVersion,
        stateGeneration,
        instanceIncarnation: hello.instanceIncarnation,
        brokerSeq: nextBrokerSeq,
        needReplay,
        needFullSync,
      }),
      ...(control ? { control } : {}),
      pendingCommands,
    }
  }

  function handleBridgeEvent(
    event: BridgeToBrokerEvent,
    context: { instanceID: string; controlId?: string },
  ): BrokerWsHandleBridgeEventResult {
    const controlRecord = context.controlId ? readBrokerControlRecord(state, context.controlId) : undefined

    if (controlRecord?.type === "requestFullSync" && controlRecord.status === "inFlight") {
      if (event.type === "fullSyncCompleted") {
        markBrokerFullSyncCompleted(state, {
          controlId: controlRecord.controlId,
          instanceID: context.instanceID,
          instanceIncarnation: event.instanceIncarnation,
          eventSeq: event.eventSeq,
        })
      } else {
        stageBrokerFullSyncEvent(state, {
          controlId: controlRecord.controlId,
          event,
          context: {
            instanceID: context.instanceID,
          },
        })
      }
    } else {
      applyBrokerStateEvent(state, event, {
        instanceID: context.instanceID,
      })

      if (
        controlRecord?.type === "requestReplay"
        && controlRecord.status === "inFlight"
        && event.eventSeq >= (controlRecord.toEventSeq ?? event.eventSeq)
      ) {
        markBrokerReplayCompleted(state, {
          controlId: controlRecord.controlId,
          completedEventSeq: event.eventSeq,
        })
      }
    }

    const ack = createBrokerAckEnvelope({
      ackedEventSeq: event.eventSeq,
      instanceIncarnation: event.instanceIncarnation,
    })
    markBrokerStateAckedEventSeq(state, {
      instanceID: context.instanceID,
      ...ack.payload,
    })
    return { ack }
  }

  function dispatchCommand(input: BrokerWsCommandDispatchInput): BrokerToBridgeCommand | null {
    const current = state.commandLedger[input.commandId]
    if (current && current.status !== "queued" && current.status !== "delivered") {
      return null
    }

    const brokerSeq = current?.brokerSeq ?? allocateBrokerSeq()
    upsertBrokerStateCommand(state, {
      commandId: input.commandId,
      brokerSeq,
      type: input.type,
      status: "delivered",
      target: { ...input.target },
      payload: cloneWsValue(input.payload ?? {}),
      instanceID: input.instanceID,
      instanceIncarnation: input.instanceIncarnation,
    })
    markBrokerStateSentBrokerSeq(state, {
      instanceID: input.instanceID,
      instanceIncarnation: input.instanceIncarnation,
      brokerSeq,
    })

    return createBrokerCommandEnvelope({
      brokerSeq,
      commandId: input.commandId,
      type: input.type,
      payload: cloneWsValue(input.payload ?? {}),
    })
  }

  return {
    getState: () => state,
    registerBridge,
    handleBridgeEvent,
    dispatchCommand,
  }
}

function getRequestId(envelope: IncomingBrokerEnvelope): string {
  return envelope.id
}

function parseIncomingEnvelopeLine(line: string): IncomingBrokerEnvelope {
  try {
    return parseEnvelopeLine(line) as IncomingBrokerEnvelope
  } catch {
    if (typeof line !== "string" || line.length === 0 || !line.endsWith("\n")) {
      throw new Error("invalid message line")
    }

    const body = line.slice(0, -1)
    if (body.length === 0 || body.includes("\n") || body.includes("\r")) {
      throw new Error("invalid message line")
    }

    const parsed = JSON.parse(body) as Partial<IncomingBrokerEnvelope>
    if (!isNonEmptyString(parsed.id) || !isNonEmptyString(parsed.type) || !Object.hasOwn(parsed, "payload")) {
      throw new Error("invalid message line")
    }
    if (parsed.instanceID !== undefined && !isNonEmptyString(parsed.instanceID)) {
      throw new Error("invalid message line")
    }
    if (parsed.sessionToken !== undefined && !isNonEmptyString(parsed.sessionToken)) {
      throw new Error("invalid message line")
    }
    return parsed as IncomingBrokerEnvelope
  }
}

function writeEnvelope(socket: net.Socket, envelope: BrokerEnvelope) {
  socket.write(serializeEnvelope(envelope))
}

function writeError(
  socket: net.Socket,
  code: "unauthorized" | "invalidMessage" | "notImplemented" | "brokerUnavailable",
  message: string,
  requestId: string,
) {
  writeEnvelope(socket, createErrorEnvelope(code, message, requestId))
}

type AggregatedStatusInstance =
  | {
      instanceID: string
      status: "ok"
      snapshot: unknown
    }
  | {
      instanceID: string
      status: "timeout/unreachable"
    }

type CollectStatusResult = {
  requestId: string
  instances: AggregatedStatusInstance[]
  reply: string
}

type PendingReplyMutation = {
  mutationId: string
  resolve: (result: ReplyMutationResult) => void
  timer: NodeJS.Timeout
}

type LiveBridgeRegistration = {
  instanceID: string
  instanceIncarnation: string
  socket: net.Socket
}

const liveBridgeByInstanceID = new Map<string, LiveBridgeRegistration>()
const liveBridgeBySocket = new Map<net.Socket, LiveBridgeRegistration>()
const pendingWsReplyMutationsByCommandId = new Map<string, PendingReplyMutation>()
let brokerMutationQueue = createBrokerMutationQueue()
let liveWsCoordinator = createBrokerWsCoordinator()
setBrokerStateMutationTarget(liveWsCoordinator.getState())

const LIVE_BRIDGE_EVENT_TYPES = new Set<BridgeToBrokerEventType>([
  "instanceOnline",
  "instanceOffline",
  "sessionSnapshotChanged",
  "questionOpened",
  "questionUpdated",
  "questionClosed",
  "permissionOpened",
  "permissionUpdated",
  "permissionClosed",
  "naturalStopOpened",
  "naturalStopClosed",
  "retryErrorUpdated",
  "commandAccepted",
  "commandResult",
  "fullSyncCompleted",
])

function queueBrokerMutation<T>(mutationType: string, task: () => Promise<T>): Promise<T> {
  return brokerMutationQueue.enqueue(mutationType, task)
}

type WechatBrokerDiagnosticEvent = {
  type:
    | "instanceStale"
    | "instanceRecovered"
    | "requestExpired"
    | "requestCleaned"
    | "requestPurged"
    | "deadLetterWritten"
    | "deadLetterPurged"
    | "showFallbackToast"
    | "fallbackToastDropped"
  code:
    | "instanceStale"
    | "instanceRecovered"
    | "requestExpired"
    | "requestCleaned"
    | "requestPurged"
    | "deadLetterWritten"
    | "deadLetterPurged"
    | "showFallbackToast"
    | "fallbackToastDropped"
  instanceID: string
  kind?: "question" | "permission"
  routeKey?: string
  reason?: string
  registrationEpoch?: string
  liveRegistrationEpoch?: string
}

function createRegistrationEpoch(): string {
  return randomUUID()
}

async function appendBrokerDiagnostic(event: WechatBrokerDiagnosticEvent) {
  try {
    await mkdir(path.dirname(wechatBrokerDiagnosticsPath()), { recursive: true, mode: WECHAT_DIR_MODE })
    await appendFile(
      wechatBrokerDiagnosticsPath(),
      `${JSON.stringify({ at: Date.now(), ...event })}\n`,
      { encoding: "utf8", mode: WECHAT_FILE_MODE },
    )
  } catch {
  }
}

function clearRuntimeState() {
  liveBridgeByInstanceID.clear()
  liveBridgeBySocket.clear()
  for (const pending of pendingWsReplyMutationsByCommandId.values()) {
    clearTimeout(pending.timer)
  }
  pendingWsReplyMutationsByCommandId.clear()
  brokerMutationQueue = createBrokerMutationQueue()
  liveWsCoordinator = createBrokerWsCoordinator()
  setBrokerStateMutationTarget(liveWsCoordinator.getState())
}

async function markAuthoritativeStaleConnections(now: number, heartbeatTimeoutMs: number): Promise<void> {
  const timedOutScopes = listTimedOutBrokerConnectionScopes(liveWsCoordinator.getState(), {
    now,
    timeoutMs: heartbeatTimeoutMs,
  })

  for (const scope of timedOutScopes) {
    markBrokerConnectionOffline(liveWsCoordinator.getState(), {
      ...scope,
      disconnectedAt: now,
      reason: "instanceStale",
    })
    const expiredRequests = expireBrokerIndexedRequestsForScope(liveWsCoordinator.getState(), {
      scopeKey: scope.instanceID,
      expiredAt: now,
    })
    closeBrokerNaturalStopsForScope(liveWsCoordinator.getState(), {
      scopeKey: scope.instanceID,
      terminalReason: "expired",
    })
    await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
    await appendBrokerDiagnostic({
      type: "instanceStale",
      code: "instanceStale",
      instanceID: scope.instanceID,
    })

    for (const expired of expiredRequests) {
      await appendBrokerDiagnostic({
        type: "requestExpired",
        code: "requestExpired",
        instanceID: scope.instanceID,
        kind: expired.kind,
        routeKey: expired.routeKey,
      })
    }
  }
}

function toPositiveNumber(rawValue: string | undefined, fallback: number): number {
  if (!isNonEmptyString(rawValue)) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {}
  }
  return value as Record<string, unknown>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function setBrokerServerTestHooks(hooks: BrokerServerTestHooks | undefined): void {
  brokerServerTestHooks = hooks
}

function isSafeInstanceID(instanceID: string): boolean {
  if (!isNonEmptyString(instanceID)) {
    return false
  }
  if (instanceID.includes("/") || instanceID.includes("\\")) {
    return false
  }
  if (instanceID.includes("..")) {
    return false
  }
  return true
}

async function cleanupTerminalRequests(now: number, cleanAfterMs: number, purgeRetentionMs: number): Promise<void> {
  const cleanup = cleanupBrokerRuntimeTerminalRequests(liveWsCoordinator.getState(), {
    now,
    cleanAfterMs,
    purgeRetentionMs,
  })
  if (cleanup.cleanedRequests.length > 0 || cleanup.purgedRequests.length > 0) {
    await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
  }

  for (const cleaned of cleanup.cleanedRequests) {
    await appendBrokerDiagnostic({
      type: "requestCleaned",
      code: "requestCleaned",
      instanceID: cleaned.scopeKey ?? "unknown",
      kind: cleaned.kind,
      routeKey: cleaned.routeKey,
    })
  }

  for (const request of cleanup.purgedRequests) {
    await appendBrokerDiagnostic({
      type: "requestPurged",
      code: "requestPurged",
      instanceID: request.scopeKey ?? "unknown",
      kind: request.kind,
      routeKey: request.routeKey,
    })
  }
}

async function cleanupDeadLetters(now: number, retentionMs: number): Promise<void> {
  const purged = await purgeDeadLettersBefore(now - retentionMs)
  for (const record of purged) {
    await appendBrokerDiagnostic({
      type: "deadLetterPurged",
      code: "deadLetterPurged",
      instanceID: record.instanceID ?? record.scopeKey ?? "unknown",
      kind: record.kind,
      routeKey: record.routeKey,
    })
  }
}

async function cleanupSocketRegistrations(socket: net.Socket, reason: string) {
  const live = liveBridgeBySocket.get(socket)
  if (live?.socket === socket) {
    markBrokerConnectionOffline(liveWsCoordinator.getState(), {
      instanceID: live.instanceID,
      instanceIncarnation: live.instanceIncarnation,
      disconnectedAt: Date.now(),
      reason,
    })
    await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
    const current = liveBridgeByInstanceID.get(live.instanceID)
    if (current?.socket === socket) {
      liveBridgeByInstanceID.delete(live.instanceID)
    }
    liveBridgeBySocket.delete(socket)
  }
}

function hasLiveBridgeEventType(type: string): type is BridgeToBrokerEventType {
  return LIVE_BRIDGE_EVENT_TYPES.has(type as BridgeToBrokerEventType)
}

function isLiveBridgeCommandPayload(value: unknown): value is BrokerToBridgeCommand {
  const record = asObject(value)
  return isNonEmptyString(record.commandId)
    && isFiniteNumber(record.brokerSeq)
    && isNonEmptyString(record.type)
    && "payload" in record
}

function toReplyMutationResultFromEventPayload(payload: Record<string, unknown>, mutationId: string): ReplyMutationResult {
  const status = payload.status
  const failure = asObject(payload.failure)
  if (status === "completed") {
    return { mutationId, ok: true }
  }

  return {
    mutationId,
    ok: false,
    ...(isNonEmptyString(failure.message) ? { errorMessage: failure.message } : { errorMessage: "command failed" }),
  }
}

async function handleMessage(envelope: IncomingBrokerEnvelope, socket: net.Socket): Promise<void> {
  const requestId = getRequestId(envelope)

  if (envelope.type === "ping") {
    writeEnvelope(socket, {
      id: `pong-${requestId}`,
      type: "pong",
      payload: { message: "pong" },
    })
    return
  }

  if (envelope.type === "hello/register") {
    let hello: HelloRegisterPayload
    try {
      hello = createHelloRegisterEnvelope(envelope.payload as HelloRegisterPayload).payload
    } catch {
      writeError(socket, "invalidMessage", "hello/register payload is invalid", requestId)
      return
    }

    if (!isSafeInstanceID(hello.instanceID)) {
      writeError(socket, "invalidMessage", "instanceID is required", requestId)
      return
    }

    const registerResult = await queueBrokerMutation("hello/register", async () => {
      const observedAt = Date.now()
      const current = liveBridgeByInstanceID.get(hello.instanceID)
      const nextRegistration: LiveBridgeRegistration = {
        instanceID: hello.instanceID,
        instanceIncarnation: hello.instanceIncarnation,
        socket,
      }

      liveBridgeByInstanceID.set(hello.instanceID, nextRegistration)
      liveBridgeBySocket.set(socket, nextRegistration)
      if (current && current.socket !== socket) {
        liveBridgeBySocket.delete(current.socket)
      }

      const registerResult = liveWsCoordinator.registerBridge(hello)
      markBrokerConnectionObserved(liveWsCoordinator.getState(), {
        instanceID: hello.instanceID,
        instanceIncarnation: hello.instanceIncarnation,
        observedAt,
        connectedAt: observedAt,
      })
      await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
      return registerResult
    })

    writeEnvelope(socket, {
      id: `registerAck-${requestId}`,
      type: "registerAck",
      instanceID: hello.instanceID,
      payload: {
        ...registerResult.ack.payload,
        ...(registerResult.control ? { control: registerResult.control } : {}),
        pendingCommands: registerResult.pendingCommands,
      },
    })
    return
  }

  if (hasLiveBridgeEventType(envelope.type)) {
    const instanceID = envelope.instanceID
    const liveRegistration = liveBridgeBySocket.get(socket)
    if (!isNonEmptyString(instanceID) || !liveRegistration || liveRegistration.instanceID !== instanceID) {
      writeError(socket, "unauthorized", "live bridge is not registered", requestId)
      return
    }

    let event: BridgeToBrokerEvent
    try {
      event = createBridgeEventEnvelope(envelope.payload as BridgeToBrokerEvent)
    } catch {
      writeError(socket, "invalidMessage", `${envelope.type} payload is invalid`, requestId)
      return
    }

    if (event.type !== envelope.type) {
      writeError(socket, "invalidMessage", `${envelope.type} payload type mismatch`, requestId)
      return
    }

    const result = await queueBrokerMutation(`bridgeEvent:${event.type}`, async () => {
      const next = liveWsCoordinator.handleBridgeEvent(event, {
        instanceID,
        controlId: event.controlId,
      })
      const currentConnection = liveWsCoordinator.getState().connections[instanceID]?.[event.instanceIncarnation]
      if (currentConnection?.online !== false) {
        markBrokerConnectionObserved(liveWsCoordinator.getState(), {
          instanceID,
          instanceIncarnation: event.instanceIncarnation,
          observedAt: Date.now(),
        })
      }
      await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
      return next
    })

    if (event.type === "commandResult") {
      const payload = asObject(event.payload)
      const commandId = isNonEmptyString(payload.commandId) ? payload.commandId : undefined
      if (commandId) {
        const pending = pendingWsReplyMutationsByCommandId.get(commandId)
        if (pending) {
          pendingWsReplyMutationsByCommandId.delete(commandId)
          clearTimeout(pending.timer)
          pending.resolve(toReplyMutationResultFromEventPayload(payload, pending.mutationId))
        }
      }
    }

    writeEnvelope(socket, {
      id: `ack-${requestId}`,
      type: "ack",
      instanceID,
      payload: result.ack.payload,
    })
    return
  }

  if (envelope.type === "registerInstance") {
    writeError(socket, "notImplemented", "legacy path removed: registerInstance is unsupported", requestId)
    return
  }

  if (envelope.type === "heartbeat") {
    writeError(socket, "notImplemented", "legacy path removed: heartbeat is unsupported", requestId)
    return
  }

  if (envelope.type === "statusSnapshot") {
    writeError(socket, "notImplemented", "legacy path removed: statusSnapshot is unsupported", requestId)
    return
  }

  if (
    envelope.type === "replyQuestionResult"
    || envelope.type === "replyPermissionResult"
    || envelope.type === "replyNaturalStopResult"
  ) {
    writeError(socket, "notImplemented", `legacy path removed: ${envelope.type} is unsupported`, requestId)
    return
  }

  if (envelope.type === "syncWechatNotifications") {
    writeError(socket, "notImplemented", "legacy path removed: syncWechatNotifications is unsupported", requestId)
    return
  }

  if (LEGACY_REMOVED_MESSAGE_TYPES.has(envelope.type)) {
    writeError(socket, "notImplemented", `legacy path removed: ${envelope.type} is unsupported`, requestId)
    return
  }

  if (FUTURE_MESSAGE_TYPES.has(envelope.type)) {
    writeError(socket, "notImplemented", "future message is not implemented", requestId)
    return
  }

  writeError(socket, "notImplemented", `${envelope.type} is not implemented`, requestId)
}

async function tightenEndpointPermission(endpoint: string) {
  if (process.platform === "win32" || isTcpBrokerEndpoint(endpoint)) {
    return
  }

  await chmod(endpoint, WECHAT_FILE_MODE)
  const info = await stat(endpoint)
  if ((info.mode & 0o777) !== WECHAT_FILE_MODE) {
    throw new Error("failed to enforce broker endpoint permission")
  }
}

async function ensureCurrentUserCanAccess(endpoint: string) {
  await new Promise<void>((resolve, reject) => {
    const probe = createBrokerSocket(endpoint)
    probe.once("connect", () => {
      probe.end()
      resolve()
    })
    probe.once("error", reject)
  })
}

async function prepareEndpoint(endpoint: string) {
  if (process.platform === "win32" || isTcpBrokerEndpoint(endpoint)) {
    return
  }

  await mkdir(path.dirname(endpoint), { recursive: true, mode: WECHAT_DIR_MODE })
  await rm(endpoint, { force: true })
}

export type BrokerServerHandle = {
  endpoint: string
  startedAt: number
  collectStatus: () => Promise<CollectStatusResult>
  handleWechatSlashCommand: (command: WechatSlashCommand) => Promise<string>
  handleNotificationDeliveryFailure: (input: {
    instanceID: string
    wechatAccountId: string
    userId: string
    registrationEpoch?: string
  }) => Promise<void>
  dispatchReplyQuestionToInstance: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    answers: unknown[]
  }) => Promise<ReplyMutationResult>
  dispatchReplyPermissionToInstance: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
  }) => Promise<ReplyMutationResult>
  dispatchReplyNaturalStopToInstance: (input: {
    instanceID: string
    mutationId: string
    sessionID: string
    text: string
  }) => Promise<ReplyMutationResult>
  hasBlockingActivity: () => Promise<boolean>
  close: () => Promise<void>
}

export async function startBrokerServer(endpoint: string): Promise<BrokerServerHandle> {
  await prepareEndpoint(endpoint)
  const persistedBrokerState = await loadBrokerStateStoreSnapshot()
  liveWsCoordinator = createBrokerWsCoordinator({
    state: persistedBrokerState ?? createEmptyBrokerState(),
  })
  setBrokerStateMutationTarget(liveWsCoordinator.getState())

  const heartbeatTimeoutMs = toPositiveNumber(
    process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS,
    DEFAULT_HEARTBEAT_TIMEOUT_MS,
  )
  const heartbeatScanIntervalMs = toPositiveNumber(
    process.env.WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS,
    DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS,
  )
  const statusCollectWindowMs = toPositiveNumber(
    process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS,
    DEFAULT_STATUS_COLLECT_WINDOW_MS,
  )
  void statusCollectWindowMs
  const requestCleanAfterMs = toPositiveNumber(
    process.env.WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS,
    DEFAULT_REQUEST_CLEAN_AFTER_MS,
  )
  const requestPurgeRetentionMs = toPositiveNumber(
    process.env.WECHAT_BROKER_REQUEST_PURGE_RETENTION_MS,
    DEFAULT_REQUEST_PURGE_RETENTION_MS,
  )
  const requestCleanupScanIntervalMs = toPositiveNumber(
    process.env.WECHAT_BROKER_REQUEST_CLEANUP_SCAN_INTERVAL_MS,
    DEFAULT_REQUEST_CLEANUP_SCAN_INTERVAL_MS,
  )
  const deadLetterRetentionMs = toPositiveNumber(
    process.env.WECHAT_BROKER_DEAD_LETTER_RETENTION_MS,
    DEFAULT_DEAD_LETTER_RETENTION_MS,
  )
  const deadLetterScanIntervalMs = toPositiveNumber(
    process.env.WECHAT_BROKER_DEAD_LETTER_SCAN_INTERVAL_MS,
    DEFAULT_DEAD_LETTER_SCAN_INTERVAL_MS,
  )
  const server = net.createServer((socket) => {
    let buffer = ""
    let messageChain: Promise<void> = Promise.resolve()

    socket.on("close", () => {
      void queueBrokerMutation("cleanupSocketRegistrations", async () => {
        await cleanupSocketRegistrations(socket, "socketClosed")
      }).catch(() => {})
    })

    socket.on("error", () => {
      void queueBrokerMutation("cleanupSocketRegistrations", async () => {
        await cleanupSocketRegistrations(socket, "socketError")
      }).catch(() => {})
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")

      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)

        try {
          const envelope = parseIncomingEnvelopeLine(`${line}\n`)
          messageChain = messageChain.then(() => handleMessage(envelope, socket)).catch(() => {
            // errors are converted to response envelopes in handleMessage
          })
        } catch {
          writeError(socket, "invalidMessage", "invalid message line", "unknown")
        }
      }
    })
  })

  const boundEndpoint = await listenOnBrokerEndpoint(server, endpoint)

  try {
    await tightenEndpointPermission(boundEndpoint)
    await ensureCurrentUserCanAccess(boundEndpoint)
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    throw error
  }

  await markAuthoritativeStaleConnections(Date.now(), heartbeatTimeoutMs)
  await cleanupTerminalRequests(Date.now(), requestCleanAfterMs, requestPurgeRetentionMs)
  await cleanupDeadLetters(Date.now(), deadLetterRetentionMs)

  const staleConnectionTimer = setInterval(() => {
    void markAuthoritativeStaleConnections(Date.now(), heartbeatTimeoutMs).catch((error) => {
      console.error("[wechat-broker] failed to mark stale authoritative connections", error)
    })
  }, heartbeatScanIntervalMs)
  const requestCleanupTimer = setInterval(() => {
    void cleanupTerminalRequests(Date.now(), requestCleanAfterMs, requestPurgeRetentionMs).catch((error) => {
      console.error("[wechat-broker] failed to clean terminal requests", error)
    })
  }, requestCleanupScanIntervalMs)
  const deadLetterCleanupTimer = setInterval(() => {
    void cleanupDeadLetters(Date.now(), deadLetterRetentionMs).catch((error) => {
      console.error("[wechat-broker] failed to purge dead letters", error)
    })
  }, deadLetterScanIntervalMs)

  let closed = false

  const collectStatus = async (): Promise<CollectStatusResult> => {
    const requestId = `collect-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const view = readBrokerAuthoritativeView(liveWsCoordinator.getState())
    const instances = buildAggregatedStatusInstancesFromBrokerView(view)

    return {
      requestId,
      instances,
      reply: formatAggregatedStatusReplyFromBrokerView(view),
    }
  }

  const handleWechatSlashCommand = async (command: WechatSlashCommand): Promise<string> => {
    if (command.type === "status") {
      const result = await collectStatus()
      return result.reply
    }

    if (command.type === "reply") {
      return "命令暂未实现：/reply"
    }

    return "命令暂未实现：/allow"
  }

  const handleNotificationDeliveryFailure = async (input: {
    instanceID: string
    wechatAccountId: string
    userId: string
    registrationEpoch?: string
  }): Promise<void> => {
    await queueBrokerMutation("authoritativeRetryError", async () => {
      await Promise.resolve(markTokenStale({
        wechatAccountId: input.wechatAccountId,
        userId: input.userId,
        staleReason: NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
      })).catch(() => {})

      const liveRegistration = liveBridgeByInstanceID.get(input.instanceID)
      upsertRetryErrorSummary(liveWsCoordinator.getState(), {
        instanceID: input.instanceID,
        action: DELIVERY_FAILURE_ACTION,
        redactedSummary: DELIVERY_FAILURE_SUMMARY,
        severityAdvice: DELIVERY_FAILURE_SEVERITY,
        updatedAt: Date.now(),
        ...(liveRegistration ? { instanceIncarnation: liveRegistration.instanceIncarnation } : {}),
      })
      await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
    }).catch(() => {})
  }

  const dispatchReplyQuestionToInstance = async (input: {
    instanceID: string
    mutationId: string
    requestID: string
    answers: unknown[]
  }): Promise<ReplyMutationResult> => {
    const liveRegistration = liveBridgeByInstanceID.get(input.instanceID)
    if (liveRegistration && !liveRegistration.socket.destroyed) {
      const command = await queueBrokerMutation("dispatchWsReplyQuestion", async () => {
        const next = liveWsCoordinator.dispatchCommand({
          instanceID: input.instanceID,
          instanceIncarnation: liveRegistration.instanceIncarnation,
          commandId: input.mutationId,
          type: "replyQuestion",
          payload: {
            mutationId: input.mutationId,
            requestID: input.requestID,
            answers: input.answers,
          },
          target: {
            instanceID: input.instanceID,
            requestID: input.requestID,
          },
        })
        await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
        return next
      })
      if (!command) {
        return { mutationId: input.mutationId, ok: false, errorMessage: `replyQuestion unavailable: ${input.mutationId}` }
      }

      return new Promise<ReplyMutationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingWsReplyMutationsByCommandId.delete(command.commandId)
          resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyQuestion timeout: ${input.mutationId}` })
        }, 10_000)

        pendingWsReplyMutationsByCommandId.set(command.commandId, {
          mutationId: input.mutationId,
          resolve,
          timer,
        })

        writeEnvelope(liveRegistration.socket, {
          id: command.commandId,
          type: command.type,
          instanceID: input.instanceID,
          payload: command,
        })
      })
    }

    return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
  }

  const dispatchReplyPermissionToInstance = async (input: {
    instanceID: string
    mutationId: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
  }): Promise<ReplyMutationResult> => {
    const liveRegistration = liveBridgeByInstanceID.get(input.instanceID)
    if (liveRegistration && !liveRegistration.socket.destroyed) {
      const command = await queueBrokerMutation("dispatchWsReplyPermission", async () => {
        const next = liveWsCoordinator.dispatchCommand({
          instanceID: input.instanceID,
          instanceIncarnation: liveRegistration.instanceIncarnation,
          commandId: input.mutationId,
          type: "replyPermission",
          payload: {
            mutationId: input.mutationId,
            requestID: input.requestID,
            reply: input.reply,
            ...(input.message ? { message: input.message } : {}),
          },
          target: {
            instanceID: input.instanceID,
            requestID: input.requestID,
          },
        })
        await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
        return next
      })
      if (!command) {
        return { mutationId: input.mutationId, ok: false, errorMessage: `replyPermission unavailable: ${input.mutationId}` }
      }

      return new Promise<ReplyMutationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingWsReplyMutationsByCommandId.delete(command.commandId)
          resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyPermission timeout: ${input.mutationId}` })
        }, 10_000)

        pendingWsReplyMutationsByCommandId.set(command.commandId, {
          mutationId: input.mutationId,
          resolve,
          timer,
        })

        writeEnvelope(liveRegistration.socket, {
          id: command.commandId,
          type: command.type,
          instanceID: input.instanceID,
          payload: command,
        })
      })
    }

    return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
  }

  const dispatchReplyNaturalStopToInstance = async (input: {
    instanceID: string
    mutationId: string
    sessionID: string
    text: string
  }): Promise<ReplyMutationResult> => {
    const liveRegistration = liveBridgeByInstanceID.get(input.instanceID)
    if (liveRegistration && !liveRegistration.socket.destroyed) {
      const command = await queueBrokerMutation("dispatchWsReplyNaturalStop", async () => {
        const next = liveWsCoordinator.dispatchCommand({
          instanceID: input.instanceID,
          instanceIncarnation: liveRegistration.instanceIncarnation,
          commandId: input.mutationId,
          type: "replyNaturalStop",
          payload: {
            mutationId: input.mutationId,
            sessionID: input.sessionID,
            text: input.text,
          },
          target: {
            instanceID: input.instanceID,
            sessionID: input.sessionID,
          },
        })
        await persistBrokerStateStoreSnapshot(liveWsCoordinator.getState())
        return next
      })
      if (!command) {
        return { mutationId: input.mutationId, ok: false, errorMessage: `replyNaturalStop unavailable: ${input.mutationId}` }
      }

      return new Promise<ReplyMutationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingWsReplyMutationsByCommandId.delete(command.commandId)
          resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyNaturalStop timeout: ${input.mutationId}` })
        }, 10_000)

        pendingWsReplyMutationsByCommandId.set(command.commandId, {
          mutationId: input.mutationId,
          resolve,
          timer,
        })

        writeEnvelope(liveRegistration.socket, {
          id: command.commandId,
          type: command.type,
          instanceID: input.instanceID,
          payload: command,
        })
      })
    }

    return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
  }

  const close = async () => {
    if (closed) {
      return
    }
    closed = true

    clearInterval(staleConnectionTimer)
    clearInterval(requestCleanupTimer)
    clearInterval(deadLetterCleanupTimer)

    for (const record of liveBridgeByInstanceID.values()) {
      if (!record.socket.destroyed) {
        record.socket.destroy()
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    if (process.platform !== "win32" && !isTcpBrokerEndpoint(endpoint)) {
      await rm(endpoint, { force: true })
    }

    clearRuntimeState()
  }

  const hasBlockingActivity = async () => {
    for (const record of liveBridgeByInstanceID.values()) {
      if (!record.socket.destroyed) {
        return true
      }
    }

    const brokerView = readBrokerAuthoritativeView(liveWsCoordinator.getState())
    return Object.keys(brokerView.active.questions).length > 0 || Object.keys(brokerView.active.permissions).length > 0
  }

  return {
    endpoint: boundEndpoint,
    startedAt: Date.now(),
    collectStatus,
    handleWechatSlashCommand,
    handleNotificationDeliveryFailure,
    dispatchReplyQuestionToInstance,
    dispatchReplyPermissionToInstance,
    dispatchReplyNaturalStopToInstance,
    hasBlockingActivity,
    close,
  }
}
