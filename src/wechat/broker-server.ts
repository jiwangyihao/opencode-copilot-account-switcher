import net from "node:net"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createBrokerSocket, isTcpBrokerEndpoint, listenOnBrokerEndpoint } from "./broker-endpoint.js"
import { registerConnection, revokeSessionToken, validateSessionToken } from "./ipc-auth.js"
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
  type BrokerMessageType,
  type BridgeToBrokerEvent,
  type BridgeToBrokerEventType,
  type CollectStatusPayload,
  type HelloRegisterPayload,
  type RegisterAckEnvelope,
  type ReplyNaturalStopPayload,
  type ReplyMutationResult,
  type ReplyPermissionPayload,
  type ReplyQuestionPayload,
  SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
  type SyncWechatNotificationsPayload,
  type ShowFallbackToastPayload,
  type StatusSnapshotPayload,
  type WechatNotificationCandidate,
} from "./protocol.js"
import {
  applyBridgeEvent as applyBrokerStateEvent,
  createEmptyBrokerState,
  markBrokerFullSyncCompleted,
  markBrokerReplayCompleted,
  markConnectionAckedEventSeq as markBrokerStateAckedEventSeq,
  markConnectionSentBrokerSeq as markBrokerStateSentBrokerSeq,
  persistBrokerStateStoreSnapshot,
  readBrokerControlRecord,
  requestBrokerFullSync,
  requestBrokerReplay,
  stageBrokerFullSyncEvent,
  upsertBrokerCommand as upsertBrokerStateCommand,
  type BrokerCommandRecord,
  type BrokerState,
} from "./broker-state-store.js"
import {
  createBrokerMutationQueue,
  executeFallbackToastMutation,
} from "./broker-mutation-queue.js"
import {
  WECHAT_DIR_MODE,
  WECHAT_FILE_MODE,
  instanceStatePath,
  instancesDir,
  wechatBrokerDiagnosticsPath,
} from "./state-paths.js"
import { formatAggregatedStatusReply } from "./status-format.js"
import type { WechatSlashCommand } from "./command-parser.js"
import {
  findActiveNaturalStopByReplyTarget,
  listRetainedNaturalStopHandles,
  findMergeableNotification,
  listActiveNaturalStopsForScope,
  markNaturalStopTerminal,
  upsertNotification,
} from "./notification-store.js"
import { readOperatorBinding } from "./operator-store.js"
import { createHandle, createRouteKey, createSessionReplyHandle } from "./handle.js"
import {
  expireOpenRequestsForScope,
  findRequestByRouteKey,
  findOpenRequestByIdentity,
  listActiveRequests,
  markCleaned,
  markRequestAnswered,
  markTerminalMetadata,
  markTerminalResultSent,
  purgeCleanedRequestsBefore,
  upsertRequest,
  type RequestRecord,
} from "./request-store.js"
import { purgeDeadLettersBefore, writeDeadLetter } from "./dead-letter-store.js"
import { markTokenStale } from "./token-store.js"
import {
  createDeliveryFailedFallbackToastPayload,
  WECHAT_FALLBACK_TOAST_MESSAGE,
} from "./notification-format.js"

const FUTURE_MESSAGE_TYPES = new Set<BrokerMessageType>([
  "collectStatus",
  "replyQuestion",
  "rejectQuestion",
  "replyPermission",
  "showFallbackToast",
])

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS = 1_000
export const DEFAULT_STATUS_COLLECT_WINDOW_MS = 5_000
const DEFAULT_REQUEST_CLEAN_AFTER_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_PURGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_REQUEST_CLEANUP_SCAN_INTERVAL_MS = 60_000
const DEFAULT_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_DEAD_LETTER_SCAN_INTERVAL_MS = 60_000

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

function getRequestId(envelope: BrokerEnvelope): string {
  return envelope.id
}

function writeEnvelope(socket: net.Socket, envelope: BrokerEnvelope) {
  socket.write(serializeEnvelope(envelope))
}

function writeFallbackToastEnvelope(input: {
  instanceID: string
  socket: net.Socket
  sessionToken: string
  payload: ShowFallbackToastPayload
}) {
  writeEnvelope(input.socket, {
    id: `showFallbackToast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: "showFallbackToast",
    instanceID: input.instanceID,
    sessionToken: input.sessionToken,
    payload: input.payload,
  })
}

function writeError(
  socket: net.Socket,
  code: "unauthorized" | "invalidMessage" | "notImplemented" | "brokerUnavailable",
  message: string,
  requestId: string,
) {
  writeEnvelope(socket, createErrorEnvelope(code, message, requestId))
}

function requireAuthorized(envelope: BrokerEnvelope): boolean {
  const instanceID = envelope.instanceID
  const sessionToken = envelope.sessionToken
  if (!isNonEmptyString(instanceID) || !isNonEmptyString(sessionToken)) {
    return false
  }
  return validateSessionToken(instanceID, sessionToken)
}

type RegistrationRecord = {
  socket: net.Socket
  sessionToken: string
  registeredAt: number
  registrationEpoch: string
  brokerPid: number
}

type InstanceSnapshotStatus = "connected" | "stale"

type InstanceSnapshot = {
  instanceID: string
  pid: number
  displayName: string
  projectDir: string
  connectedAt: number
  lastHeartbeatAt: number
  status: InstanceSnapshotStatus
  staleSince?: number
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

type PendingCollectStatus = {
  requestedInstanceIDs: Set<string>
  snapshotsByInstanceID: Map<string, unknown>
  resolve: (result: CollectStatusResult) => void
  timer: NodeJS.Timeout
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

const registrationByInstanceID = new Map<string, RegistrationRecord>()
const instanceIDsBySocket = new Map<net.Socket, Set<string>>()
const liveBridgeByInstanceID = new Map<string, LiveBridgeRegistration>()
const liveBridgeBySocket = new Map<net.Socket, LiveBridgeRegistration>()
const snapshotByInstanceID = new Map<string, InstanceSnapshot>()
const snapshotPersistQueueByInstanceID = new Map<string, Promise<void>>()
const pendingCollectStatusByRequestId = new Map<string, PendingCollectStatus>()
const pendingReplyMutationsByRequestId = new Map<string, PendingReplyMutation>()
const pendingWsReplyMutationsByCommandId = new Map<string, PendingReplyMutation>()
let syncWechatNotificationsChain: Promise<void> = Promise.resolve()
let brokerMutationQueue = createBrokerMutationQueue()
let liveWsCoordinator = createBrokerWsCoordinator()

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
  for (const instanceID of registrationByInstanceID.keys()) {
    revokeSessionToken(instanceID)
  }
  registrationByInstanceID.clear()
  instanceIDsBySocket.clear()
  liveBridgeByInstanceID.clear()
  liveBridgeBySocket.clear()
  snapshotByInstanceID.clear()
  snapshotPersistQueueByInstanceID.clear()
  pendingCollectStatusByRequestId.clear()
  for (const pending of pendingReplyMutationsByRequestId.values()) {
    clearTimeout(pending.timer)
  }
  pendingReplyMutationsByRequestId.clear()
  for (const pending of pendingWsReplyMutationsByCommandId.values()) {
    clearTimeout(pending.timer)
  }
  pendingWsReplyMutationsByCommandId.clear()
  syncWechatNotificationsChain = Promise.resolve()
  brokerMutationQueue = createBrokerMutationQueue()
  liveWsCoordinator = createBrokerWsCoordinator()
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

function normalizeRequestIdentityForSync(value: string): string {
  return value.trim().toLowerCase()
}

function toNotificationCandidateIdentityKey(candidate: Extract<WechatNotificationCandidate, { kind: "question" | "permission" }>): string {
  return `${candidate.kind}:${normalizeRequestIdentityForSync(candidate.requestID)}`
}

function toRequestIdentityKey(record: Pick<RequestRecord, "kind" | "requestID">): string {
  return `${record.kind}:${normalizeRequestIdentityForSync(record.requestID)}`
}

function toNaturalStopIdentityKey(input: {
  scopeKey?: string
  sessionID?: string
  replyTarget?: { instanceID: string; sessionID: string }
}): string | undefined {
  const instanceID = input.replyTarget?.instanceID ?? input.scopeKey
  const sessionID = input.replyTarget?.sessionID ?? input.sessionID
  if (!isNonEmptyString(instanceID) || !isNonEmptyString(sessionID)) {
    return undefined
  }
  return `${instanceID.trim().toLowerCase()}:${sessionID.trim().toLowerCase()}`
}

function createRequestTerminalIdempotencyKey(record: Pick<RequestRecord, "kind" | "routeKey">): string {
  return `request-terminal-${record.kind}-${record.routeKey}`
}

function findReplacementHandle(record: RequestRecord, activeRequests: RequestRecord[]): string | undefined {
  const replacement = activeRequests
    .filter((item) => (
      item.status === "open"
      && item.kind === record.kind
      && item.routeKey !== record.routeKey
      && normalizeRequestIdentityForSync(item.requestID) === normalizeRequestIdentityForSync(record.requestID)
      && item.wechatAccountId === record.wechatAccountId
      && item.userId === record.userId
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0]

  return replacement?.handle
}

export function setBrokerServerTestHooks(hooks: BrokerServerTestHooks | undefined): void {
  brokerServerTestHooks = hooks
}

async function finalizeExitedReplyableRequest(input: {
  request: RequestRecord
  activeRequestsAfterSync: RequestRecord[]
  registrationEpoch?: string
}) {
  const current = await findRequestByRouteKey({
    kind: input.request.kind,
    routeKey: input.request.routeKey,
  })
  if (!current) {
    return
  }

  const finalizedAt = Date.now()
  let terminal = current
  if (current.status === "open") {
    await brokerServerTestHooks?.beforeFinalizeOpenRequest?.({ request: current })

    try {
      terminal = await markRequestAnswered({
        kind: current.kind,
        routeKey: current.routeKey,
        answeredAt: finalizedAt,
      })
    } catch (error) {
      if (!(error instanceof Error) || !/request is not open/i.test(error.message)) {
        throw error
      }

      const raced = await findRequestByRouteKey({
        kind: current.kind,
        routeKey: current.routeKey,
      })
      if (!raced || raced.status === "open") {
        throw error
      }
      terminal = raced
    }

    if (terminal.status === "answered") {
      const replacementHandle = findReplacementHandle(terminal, input.activeRequestsAfterSync)
      if (replacementHandle) {
        terminal = await markTerminalMetadata({
          kind: terminal.kind,
          routeKey: terminal.routeKey,
          terminalReason: "replaced",
          replacementHandle,
        })
      }
    }
  }

  if (terminal.terminalResultSent === true || !terminal.terminalReason) {
    return
  }

  await upsertNotification({
    idempotencyKey: createRequestTerminalIdempotencyKey(terminal),
    kind: "requestTerminal",
    requestKind: terminal.kind,
    terminalReason: terminal.terminalReason,
    ...(terminal.replacementHandle ? { replacementHandle: terminal.replacementHandle } : {}),
    wechatAccountId: terminal.wechatAccountId,
    userId: terminal.userId,
    registrationEpoch: input.registrationEpoch,
    routeKey: terminal.routeKey,
    handle: terminal.handle,
    ...(terminal.scopeKey ? { scopeKey: terminal.scopeKey } : {}),
    createdAt: finalizedAt,
  })

  await markTerminalResultSent({
    kind: terminal.kind,
    routeKey: terminal.routeKey,
    sentAt: finalizedAt,
  })
}

function hasCollectStatusPayload(payload: unknown): payload is CollectStatusPayload {
  return asObject(payload).requestId !== undefined && isNonEmptyString(asObject(payload).requestId)
}

function hasStatusSnapshotPayload(payload: unknown): payload is StatusSnapshotPayload {
  const record = asObject(payload)
  return isNonEmptyString(record.requestId) && "snapshot" in record
}

function isWechatNotificationCandidate(value: unknown): value is WechatNotificationCandidate {
  const record = asObject(value)
  if (!isNonEmptyString(record.idempotencyKey) || !isFiniteNumber(record.createdAt)) {
    return false
  }
  if (record.kind === "sessionError") {
    return isNonEmptyString(record.sessionID)
      && isNonEmptyString(record.action)
      && isNonEmptyString(record.redactedSummary)
      && isNonEmptyString(record.severityAdvice)
  }
  if (record.kind === "naturalStop") {
    const replyTarget = asObject(record.replyTarget)
    return isNonEmptyString(record.sessionID)
      && isNonEmptyString(record.handle)
      && isNonEmptyString(record.redactedSummary)
      && isNonEmptyString(record.severityAdvice)
      && isNonEmptyString(replyTarget.instanceID)
      && isNonEmptyString(replyTarget.sessionID)
  }
  if (record.kind === "question" || record.kind === "permission") {
    return isNonEmptyString(record.requestID) && isNonEmptyString(record.routeKey) && isNonEmptyString(record.handle)
  }
  return false
}

function hasSyncWechatNotificationsPayload(payload: unknown): payload is SyncWechatNotificationsPayload {
  const record = asObject(payload)
  if (!Array.isArray(record.candidates)) {
    return false
  }
  return record.candidates.every((candidate) => isWechatNotificationCandidate(candidate))
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

function makeConnectedSnapshot(instanceID: string, payload: unknown, now: number): InstanceSnapshot {
  const record = asObject(payload)
  return {
    instanceID,
    pid: isFiniteNumber(record.pid) ? record.pid : process.pid,
    displayName: isNonEmptyString(record.displayName) ? record.displayName : "",
    projectDir: isNonEmptyString(record.projectDir) ? record.projectDir : "",
    connectedAt: now,
    lastHeartbeatAt: now,
    status: "connected",
  }
}

function serializeSnapshot(snapshot: InstanceSnapshot) {
  if (snapshot.status === "stale") {
    return {
      instanceID: snapshot.instanceID,
      pid: snapshot.pid,
      displayName: snapshot.displayName,
      projectDir: snapshot.projectDir,
      connectedAt: snapshot.connectedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      status: snapshot.status,
      staleSince: snapshot.staleSince,
    }
  }

  return {
    instanceID: snapshot.instanceID,
    pid: snapshot.pid,
    displayName: snapshot.displayName,
    projectDir: snapshot.projectDir,
    connectedAt: snapshot.connectedAt,
    lastHeartbeatAt: snapshot.lastHeartbeatAt,
    status: snapshot.status,
  }
}

async function persistInstanceSnapshot(snapshot: InstanceSnapshot) {
  await mkdir(instancesDir(), { recursive: true, mode: WECHAT_DIR_MODE })
  await writeFile(instanceStatePath(snapshot.instanceID), JSON.stringify(serializeSnapshot(snapshot), null, 2), {
    mode: WECHAT_FILE_MODE,
  })
}

function queuePersistSnapshot(snapshot: InstanceSnapshot): Promise<void> {
  const currentChain = snapshotPersistQueueByInstanceID.get(snapshot.instanceID) ?? Promise.resolve()
  const nextWrite = currentChain.then(() => persistInstanceSnapshot(snapshot))
  const queueTail = nextWrite.catch(() => {})
  snapshotPersistQueueByInstanceID.set(snapshot.instanceID, queueTail)
  return nextWrite
}

async function upsertConnectedSnapshot(instanceID: string, payload: unknown, now: number): Promise<InstanceSnapshot> {
  const next = makeConnectedSnapshot(instanceID, payload, now)
  snapshotByInstanceID.set(instanceID, next)
  await queuePersistSnapshot(next)
  return next
}

async function recoverSnapshotFromHeartbeat(instanceID: string, now: number): Promise<void> {
  const current = snapshotByInstanceID.get(instanceID)
  if (!current) {
    const fallback: InstanceSnapshot = {
      instanceID,
      pid: process.pid,
      displayName: "",
      projectDir: "",
      connectedAt: now,
      lastHeartbeatAt: now,
      status: "connected",
    }
    snapshotByInstanceID.set(instanceID, fallback)
    await queuePersistSnapshot(fallback)
    return
  }

  const next: InstanceSnapshot = {
    instanceID: current.instanceID,
    pid: current.pid,
    displayName: current.displayName,
    projectDir: current.projectDir,
    connectedAt: current.connectedAt,
    lastHeartbeatAt: now,
    status: "connected",
  }
  snapshotByInstanceID.set(instanceID, next)
  await queuePersistSnapshot(next)
  if (current.status === "stale") {
    await appendBrokerDiagnostic({
      type: "instanceRecovered",
      code: "instanceRecovered",
      instanceID,
    })
  }
}

function toInstanceSnapshot(input: unknown): InstanceSnapshot | undefined {
  const snapshot = asObject(input)
  if (!isNonEmptyString(snapshot.instanceID) || !isSafeInstanceID(snapshot.instanceID) || !isFiniteNumber(snapshot.connectedAt) || !isFiniteNumber(snapshot.lastHeartbeatAt)) {
    return undefined
  }
  const instanceID = snapshot.instanceID
  const connectedAt = snapshot.connectedAt
  const lastHeartbeatAt = snapshot.lastHeartbeatAt

  const status = snapshot.status === "stale" ? "stale" : snapshot.status === "connected" ? "connected" : undefined
  if (!status) {
    return undefined
  }

  if (status === "stale" && !isFiniteNumber(snapshot.staleSince)) {
    return undefined
  }
  const staleSince: number | undefined = status === "stale" ? (snapshot.staleSince as number) : undefined

  return {
    instanceID,
    pid: isFiniteNumber(snapshot.pid) ? snapshot.pid : process.pid,
    displayName: isNonEmptyString(snapshot.displayName) ? snapshot.displayName : "",
    projectDir: isNonEmptyString(snapshot.projectDir) ? snapshot.projectDir : "",
    connectedAt,
    lastHeartbeatAt,
    status,
    ...(status === "stale" ? { staleSince } : {}),
  }
}

async function loadPersistedSnapshots(): Promise<void> {
  const files = await readdir(instancesDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return []
    }
    throw error
  })

  for (const fileName of files) {
    if (!fileName.endsWith(".json")) {
      continue
    }

    try {
      const raw = await readFile(path.join(instancesDir(), fileName), "utf8")
      const parsed = toInstanceSnapshot(JSON.parse(raw))
      if (!parsed) {
        continue
      }
      snapshotByInstanceID.set(parsed.instanceID, parsed)
    } catch {
      // ignore malformed persisted snapshots during startup cleanup
    }
  }
}

async function markStaleSnapshots(now: number, heartbeatTimeoutMs: number): Promise<void> {
  for (const [instanceID, snapshot] of snapshotByInstanceID.entries()) {
    if (snapshot.status !== "connected") {
      continue
    }

    if (now - snapshot.lastHeartbeatAt < heartbeatTimeoutMs) {
      continue
    }

    const staleSnapshot: InstanceSnapshot = {
      instanceID: snapshot.instanceID,
      pid: snapshot.pid,
      displayName: snapshot.displayName,
      projectDir: snapshot.projectDir,
      connectedAt: snapshot.connectedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      status: "stale",
      staleSince: now,
    }
    snapshotByInstanceID.set(instanceID, staleSnapshot)
    await queuePersistSnapshot(staleSnapshot)
    await appendBrokerDiagnostic({
      type: "instanceStale",
      code: "instanceStale",
      instanceID,
    })
    const expiredRequests = await expireOpenRequestsForScope({
      scopeKey: instanceID,
      expiredAt: now,
    })
    for (const request of expiredRequests) {
      await appendBrokerDiagnostic({
        type: "requestExpired",
        code: "requestExpired",
        instanceID,
        kind: request.kind,
        routeKey: request.routeKey,
      })
      await writeDeadLetter({
        kind: request.kind,
        routeKey: request.routeKey,
        requestID: request.requestID,
        handle: request.handle,
        scopeKey: request.scopeKey,
        finalStatus: "expired",
        reason: "instanceStale",
        createdAt: request.createdAt,
        finalizedAt: request.expiredAt ?? now,
        wechatAccountId: request.wechatAccountId,
        userId: request.userId,
        instanceID,
      })
      await appendBrokerDiagnostic({
        type: "deadLetterWritten",
        code: "deadLetterWritten",
        instanceID,
        kind: request.kind,
        routeKey: request.routeKey,
        reason: "instanceStale",
      })
      await finalizeExitedReplyableRequest({
        request,
        activeRequestsAfterSync: [],
      })
    }

    const expiredNaturalStops = await listActiveNaturalStopsForScope({
      scopeKey: instanceID,
    })
    for (const notification of expiredNaturalStops) {
      await markNaturalStopTerminal({
        idempotencyKey: notification.idempotencyKey,
        resolvedAt: now,
        terminalReason: "expired",
      })
    }
  }
}

function getTerminalTimestamp(record: RequestRecord): number | undefined {
  if (record.status === "answered") {
    return record.answeredAt
  }
  if (record.status === "rejected") {
    return record.rejectedAt
  }
  if (record.status === "expired") {
    return record.expiredAt
  }
  return undefined
}

async function cleanupTerminalRequests(now: number, cleanAfterMs: number, purgeRetentionMs: number): Promise<void> {
  const activeRequests = await listActiveRequests()

  for (const request of activeRequests) {
    if (!["answered", "rejected", "expired"].includes(request.status)) {
      continue
    }

    const terminalAt = getTerminalTimestamp(request)
    if (typeof terminalAt !== "number") {
      continue
    }
    if (now - terminalAt < cleanAfterMs) {
      continue
    }

    const cleaned = await markCleaned({
      kind: request.kind,
      routeKey: request.routeKey,
      cleanedAt: now,
    })
    await appendBrokerDiagnostic({
      type: "requestCleaned",
      code: "requestCleaned",
      instanceID: cleaned.scopeKey ?? "unknown",
      kind: cleaned.kind,
      routeKey: cleaned.routeKey,
    })
  }

  const purged = await purgeCleanedRequestsBefore({
    cutoffAt: now - purgeRetentionMs,
  })
  for (const request of purged) {
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
      reason: record.reason,
    })
  }
}

function bindSocketInstance(socket: net.Socket, instanceID: string) {
  const set = instanceIDsBySocket.get(socket) ?? new Set<string>()
  set.add(instanceID)
  instanceIDsBySocket.set(socket, set)
}

function unbindSocketInstance(socket: net.Socket, instanceID: string) {
  const set = instanceIDsBySocket.get(socket)
  if (!set) {
    return
  }
  set.delete(instanceID)
  if (set.size === 0) {
    instanceIDsBySocket.delete(socket)
  }
}

function cleanupSocketRegistrations(socket: net.Socket) {
  const set = instanceIDsBySocket.get(socket)
  if (!set) {
    return
  }

  for (const instanceID of set) {
    const current = registrationByInstanceID.get(instanceID)
    if (current?.socket === socket) {
      registrationByInstanceID.delete(instanceID)
      revokeSessionToken(instanceID)
    }
  }
  instanceIDsBySocket.delete(socket)

  const live = liveBridgeBySocket.get(socket)
  if (live?.socket === socket) {
    const current = liveBridgeByInstanceID.get(live.instanceID)
    if (current?.socket === socket) {
      liveBridgeByInstanceID.delete(live.instanceID)
    }
    liveBridgeBySocket.delete(socket)
  }
}

function finalizePendingCollectStatus(requestId: string) {
  const pending = pendingCollectStatusByRequestId.get(requestId)
  if (!pending) {
    return
  }

  clearTimeout(pending.timer)
  pendingCollectStatusByRequestId.delete(requestId)

  const instances: AggregatedStatusInstance[] = []
  for (const instanceID of pending.requestedInstanceIDs) {
    if (pending.snapshotsByInstanceID.has(instanceID)) {
      instances.push({
        instanceID,
        status: "ok",
        snapshot: pending.snapshotsByInstanceID.get(instanceID),
      })
      continue
    }

    instances.push({
      instanceID,
      status: "timeout/unreachable",
    })
  }

  pending.resolve({
    requestId,
    instances,
    reply: formatAggregatedStatusReply({
      requestId,
      instances,
    }),
  })
}

function queueSyncWechatNotifications(task: () => Promise<void>): Promise<void> {
  const next = syncWechatNotificationsChain.then(task)
  syncWechatNotificationsChain = next.catch(() => {})
  return next
}

function hasLiveBridgeEventType(type: BrokerMessageType): type is BridgeToBrokerEventType {
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

async function handleMessage(envelope: BrokerEnvelope, socket: net.Socket): Promise<void> {
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
    if (!isSafeInstanceID(envelope.instanceID ?? "")) {
      writeError(socket, "invalidMessage", "instanceID is required", requestId)
      return
    }

    const instanceID = envelope.instanceID as string
    let registerAckPayload: {
      sessionToken: string
      registeredAt: number
      registrationEpoch: string
      brokerPid: number
    }
    try {
      registerAckPayload = await queueBrokerMutation("registerInstance", async () => {
        const existing = registrationByInstanceID.get(instanceID)

        const registeredAt = Date.now()
        const registrationEpoch = createRegistrationEpoch()
        await upsertConnectedSnapshot(instanceID, envelope.payload, registeredAt)

        const sessionToken = registerConnection(instanceID, { socket })
        const nextRecord: RegistrationRecord = {
          socket,
          sessionToken,
          registeredAt,
          registrationEpoch,
          brokerPid: process.pid,
        }
        registrationByInstanceID.set(instanceID, nextRecord)
        bindSocketInstance(socket, instanceID)

        if (existing && existing.socket !== socket) {
          unbindSocketInstance(existing.socket, instanceID)
        }

        return {
          sessionToken,
          registeredAt: nextRecord.registeredAt,
          registrationEpoch: nextRecord.registrationEpoch,
          brokerPid: nextRecord.brokerPid,
        }
      })
    } catch {
      writeError(socket, "brokerUnavailable", "failed to persist instance snapshot", requestId)
      return
    }

    writeEnvelope(socket, {
      id: `registerAck-${requestId}`,
      type: "registerAck",
      instanceID,
      payload: registerAckPayload,
    })
    return
  }

  if (envelope.type === "heartbeat") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    try {
      await recoverSnapshotFromHeartbeat(envelope.instanceID!, Date.now())
    } catch {
      writeError(socket, "brokerUnavailable", "failed to persist instance snapshot", requestId)
      return
    }

    writeEnvelope(socket, {
      id: `pong-${requestId}`,
      type: "pong",
      payload: { message: "pong" },
    })
    return
  }

  if (envelope.type === "statusSnapshot") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    const payload = envelope.payload
    if (!hasStatusSnapshotPayload(payload)) {
      writeError(socket, "invalidMessage", "statusSnapshot payload is invalid", requestId)
      return
    }

    const pending = pendingCollectStatusByRequestId.get(payload.requestId)
    if (!pending) {
      return
    }

    const sourceInstanceID = envelope.instanceID
    if (!isNonEmptyString(sourceInstanceID)) {
      return
    }

    if (!pending.requestedInstanceIDs.has(sourceInstanceID)) {
      return
    }

    pending.snapshotsByInstanceID.set(sourceInstanceID, payload.snapshot)
    if (pending.snapshotsByInstanceID.size >= pending.requestedInstanceIDs.size) {
      finalizePendingCollectStatus(payload.requestId)
    }
    return
  }

  if (
    envelope.type === "replyQuestionResult"
    || envelope.type === "replyPermissionResult"
    || envelope.type === "replyNaturalStopResult"
  ) {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    const pending = pendingReplyMutationsByRequestId.get(requestId)
    if (!pending) {
      return
    }

    const payload = envelope.payload as Partial<ReplyMutationResult>
    pendingReplyMutationsByRequestId.delete(requestId)
    clearTimeout(pending.timer)
    if (!isNonEmptyString(payload.mutationId) || payload.mutationId !== pending.mutationId || payload.ok !== true && payload.ok !== false) {
      pending.resolve({ mutationId: pending.mutationId, ok: false, errorMessage: "invalid bridge reply result" })
      return
    }
    pending.resolve({
      mutationId: payload.mutationId,
      ok: payload.ok,
      ...(isNonEmptyString(payload.errorMessage) ? { errorMessage: payload.errorMessage } : {}),
    })
    return
  }

  if (envelope.type === "syncWechatNotifications") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    const payload = envelope.payload
    if (!hasSyncWechatNotificationsPayload(payload)) {
      writeError(socket, "invalidMessage", "syncWechatNotifications payload is invalid", requestId)
      return
    }

    const capturedRegistration = isNonEmptyString(envelope.instanceID)
      ? registrationByInstanceID.get(envelope.instanceID)
      : undefined
    const capturedRegistrationEpoch = capturedRegistration && capturedRegistration.sessionToken === envelope.sessionToken
      ? capturedRegistration.registrationEpoch
      : undefined

    const binding = await readOperatorBinding().catch(() => undefined)
    if (!binding) {
      return
    }

    await queueSyncWechatNotifications(async () => {
      const relevantRequestsBeforeSync = (await listActiveRequests()).filter((item) => (
        item.scopeKey === envelope.instanceID
        && item.wechatAccountId === binding.wechatAccountId
        && item.userId === binding.userId
        && (item.status === "open" || item.terminalResultSent !== true)
      ))
      const relevantNaturalStopsBeforeSync = isNonEmptyString(envelope.instanceID)
        ? await listActiveNaturalStopsForScope({
            scopeKey: envelope.instanceID,
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
          })
        : []
      const currentCandidateIdentityKeys = new Set(
        payload.candidates
          .filter((candidate): candidate is Extract<WechatNotificationCandidate, { kind: "question" | "permission" }> => (
            candidate.kind === "question" || candidate.kind === "permission"
          ))
          .map((candidate) => toNotificationCandidateIdentityKey(candidate)),
      )
      const currentNaturalStopIdentityKeys = new Set(
        payload.candidates
          .filter((candidate): candidate is Extract<WechatNotificationCandidate, { kind: "naturalStop" }> => candidate.kind === "naturalStop")
          .map((candidate) => toNaturalStopIdentityKey(candidate))
          .filter((key): key is string => isNonEmptyString(key)),
      )

      for (const candidate of payload.candidates) {
        if (candidate.kind === "sessionError") {
          await upsertNotification({
            idempotencyKey: candidate.idempotencyKey,
            kind: "sessionError",
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            registrationEpoch: capturedRegistrationEpoch,
            createdAt: candidate.createdAt,
            sessionID: candidate.sessionID,
            action: candidate.action,
            redactedSummary: candidate.redactedSummary,
            severityAdvice: candidate.severityAdvice,
          })
          continue
        }

        if (candidate.kind === "naturalStop") {
          const existingActiveNaturalStop = await findActiveNaturalStopByReplyTarget({
            replyTarget: candidate.replyTarget,
          }).catch(() => undefined)

          if (existingActiveNaturalStop && existingActiveNaturalStop.idempotencyKey !== candidate.idempotencyKey) {
            await markNaturalStopTerminal({
              idempotencyKey: existingActiveNaturalStop.idempotencyKey,
              resolvedAt: Date.now(),
              terminalReason: "continued",
            })
          }

          const canonicalHandle = existingActiveNaturalStop?.idempotencyKey === candidate.idempotencyKey
            ? existingActiveNaturalStop.handle
            : createSessionReplyHandle([
                ...(existingActiveNaturalStop?.handle ? [existingActiveNaturalStop.handle] : []),
                ...(await listRetainedNaturalStopHandles()),
              ])

          await upsertNotification({
            idempotencyKey: candidate.idempotencyKey,
            kind: "naturalStop",
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            registrationEpoch: capturedRegistrationEpoch,
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

        const existingOpen = await findOpenRequestByIdentity({
          kind: candidate.kind,
          requestID: candidate.requestID,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          scopeKey: envelope.instanceID,
        })

        let canonicalRouteKey: string
        let canonicalHandle: string

        if (existingOpen) {
          canonicalRouteKey = existingOpen.routeKey
          canonicalHandle = existingOpen.handle
        } else {
          const activeRequests = await listActiveRequests()
          const existingHandles = activeRequests
            .filter((item) => item.kind === candidate.kind && item.status === "open")
            .map((item) => item.handle)

          const nextRouteKey = createRouteKey({
            kind: candidate.kind,
            requestID: candidate.requestID,
            scopeKey: envelope.instanceID,
          })
          const nextHandle = createHandle(candidate.kind, existingHandles)

          const created = await upsertRequest({
            kind: candidate.kind,
            requestID: candidate.requestID,
            routeKey: nextRouteKey,
            handle: nextHandle,
            scopeKey: envelope.instanceID,
            prompt: candidate.prompt,
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            createdAt: candidate.createdAt,
          })

          canonicalRouteKey = created.routeKey
          canonicalHandle = created.handle
        }

        const notificationScopeKey = existingOpen?.scopeKey ?? envelope.instanceID
        if (!isNonEmptyString(notificationScopeKey)) {
          continue
        }

        const mergeableNotification = await findMergeableNotification({
          kind: candidate.kind,
          routeKey: canonicalRouteKey,
          handle: canonicalHandle,
          scopeKey: notificationScopeKey,
          createdAt: candidate.createdAt,
          excludeIdempotencyKey: candidate.idempotencyKey,
        })

        await upsertNotification({
          idempotencyKey: candidate.idempotencyKey,
          kind: candidate.kind,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          registrationEpoch: capturedRegistrationEpoch,
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

      const activeRequestsAfterSync = await listActiveRequests()
      for (const request of relevantRequestsBeforeSync) {
        if (currentCandidateIdentityKeys.has(toRequestIdentityKey(request))) {
          continue
        }

        await finalizeExitedReplyableRequest({
          request,
          activeRequestsAfterSync,
          registrationEpoch: capturedRegistrationEpoch,
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

        await markNaturalStopTerminal({
          idempotencyKey: notification.idempotencyKey,
          resolvedAt: Date.now(),
          terminalReason: "continued",
        })
      }
    })
    return
  }

  if (FUTURE_MESSAGE_TYPES.has(envelope.type)) {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

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
  liveWsCoordinator = createBrokerWsCoordinator()

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
        cleanupSocketRegistrations(socket)
      }).catch(() => {})
    })

    socket.on("error", () => {
      void queueBrokerMutation("cleanupSocketRegistrations", async () => {
        cleanupSocketRegistrations(socket)
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
          const envelope = parseEnvelopeLine(`${line}\n`)
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

  await loadPersistedSnapshots()
  await markStaleSnapshots(Date.now(), heartbeatTimeoutMs)
  await cleanupTerminalRequests(Date.now(), requestCleanAfterMs, requestPurgeRetentionMs)
  await cleanupDeadLetters(Date.now(), deadLetterRetentionMs)

  const staleScanTimer = setInterval(() => {
    void markStaleSnapshots(Date.now(), heartbeatTimeoutMs).catch((error) => {
      console.error("[wechat-broker] failed to persist stale snapshot", error)
    })
  }, heartbeatScanIntervalMs)
  const requestCleanupTimer = setInterval(() => {
    void cleanupTerminalRequests(Date.now(), requestCleanAfterMs, requestPurgeRetentionMs).catch((error) => {
      console.error("[wechat-broker] failed to clean terminal requests", error)
    })
  }, requestCleanupScanIntervalMs)
  const deadLetterCleanupTimer = setInterval(() => {
    void cleanupDeadLetters(Date.now(), deadLetterRetentionMs).catch((error) => {
      console.error("[wechat-broker] failed to clean dead letters", error)
    })
  }, deadLetterScanIntervalMs)

  let closed = false

  const collectStatus = async (): Promise<CollectStatusResult> => {
    const requestId = `collect-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const requestedInstanceIDs = new Set<string>()

    for (const [instanceID, record] of registrationByInstanceID.entries()) {
      if (record.socket.destroyed) {
        continue
      }
      requestedInstanceIDs.add(instanceID)
      writeEnvelope(record.socket, {
        id: `collectStatus-${requestId}-${instanceID}`,
        type: "collectStatus",
        instanceID,
        sessionToken: record.sessionToken,
        payload: {
          requestId,
        } as CollectStatusPayload,
      })
    }

    if (requestedInstanceIDs.size === 0) {
      return {
        requestId,
        instances: [],
        reply: formatAggregatedStatusReply({
          requestId,
          instances: [],
        }),
      }
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finalizePendingCollectStatus(requestId)
      }, statusCollectWindowMs)

      pendingCollectStatusByRequestId.set(requestId, {
        requestedInstanceIDs,
        snapshotsByInstanceID: new Map(),
        resolve,
        timer,
      })
    })
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
    const registrationEpoch = input.registrationEpoch

    await queueBrokerMutation("fallbackToastMutation", async () => {
      await executeFallbackToastMutation<net.Socket>(
        {
          type: "fallbackToastMutation",
          instanceID: input.instanceID,
          wechatAccountId: input.wechatAccountId,
          userId: input.userId,
          message: registrationEpoch === undefined
            ? WECHAT_FALLBACK_TOAST_MESSAGE
            : createDeliveryFailedFallbackToastPayload({
                wechatAccountId: input.wechatAccountId,
                userId: input.userId,
                registrationEpoch,
              }).message,
          reason: SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
          registrationEpoch,
        },
        {
          markTokenStale,
          appendDiagnostic: appendBrokerDiagnostic,
          getLiveRegistration: (instanceID) => {
            const record = registrationByInstanceID.get(instanceID)
            if (!record) {
              return undefined
            }
              return {
                socket: record.socket,
                sessionToken: record.sessionToken,
                registrationEpoch: record.registrationEpoch,
              }
          },
          deliverFallbackToast: ({ instanceID, registration, payload }) => {
            writeFallbackToastEnvelope({
              instanceID,
              socket: registration.socket,
              sessionToken: registration.sessionToken,
              payload,
            })
          },
        },
      )
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

    const registration = registrationByInstanceID.get(input.instanceID)
    if (!registration) {
      return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
    }

    const requestId = `replyQuestion-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return new Promise<ReplyMutationResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingReplyMutationsByRequestId.delete(requestId)
        resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyQuestion timeout: ${input.mutationId}` })
      }, 10_000)

      pendingReplyMutationsByRequestId.set(requestId, {
        mutationId: input.mutationId,
        resolve,
        timer,
      })

      writeEnvelope(registration.socket, {
        id: requestId,
        type: "replyQuestion",
        instanceID: input.instanceID,
        sessionToken: registration.sessionToken,
        payload: {
          mutationId: input.mutationId,
          requestID: input.requestID,
          answers: input.answers,
        } satisfies ReplyQuestionPayload,
      })
    })
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

    const registration = registrationByInstanceID.get(input.instanceID)
    if (!registration) {
      return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
    }

    const requestId = `replyPermission-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return new Promise<ReplyMutationResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingReplyMutationsByRequestId.delete(requestId)
        resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyPermission timeout: ${input.mutationId}` })
      }, 10_000)

      pendingReplyMutationsByRequestId.set(requestId, {
        mutationId: input.mutationId,
        resolve,
        timer,
      })

      writeEnvelope(registration.socket, {
        id: requestId,
        type: "replyPermission",
        instanceID: input.instanceID,
        sessionToken: registration.sessionToken,
        payload: {
          mutationId: input.mutationId,
          requestID: input.requestID,
          reply: input.reply,
          ...(input.message ? { message: input.message } : {}),
        } satisfies ReplyPermissionPayload,
      })
    })
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

    const registration = registrationByInstanceID.get(input.instanceID)
    if (!registration) {
      return { mutationId: input.mutationId, ok: false, errorMessage: `bridge unavailable: ${input.instanceID}` }
    }

    const requestId = `replyNaturalStop-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return new Promise<ReplyMutationResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingReplyMutationsByRequestId.delete(requestId)
        resolve({ mutationId: input.mutationId, ok: false, errorMessage: `replyNaturalStop timeout: ${input.mutationId}` })
      }, 10_000)

      pendingReplyMutationsByRequestId.set(requestId, {
        mutationId: input.mutationId,
        resolve,
        timer,
      })

      writeEnvelope(registration.socket, {
        id: requestId,
        type: "replyNaturalStop",
        instanceID: input.instanceID,
        sessionToken: registration.sessionToken,
        payload: {
          mutationId: input.mutationId,
          sessionID: input.sessionID,
          text: input.text,
        } satisfies ReplyNaturalStopPayload,
      })
    })
  }

  const close = async () => {
    if (closed) {
      return
    }
    closed = true

    clearInterval(staleScanTimer)
    clearInterval(requestCleanupTimer)
    clearInterval(deadLetterCleanupTimer)

    for (const requestId of pendingCollectStatusByRequestId.keys()) {
      finalizePendingCollectStatus(requestId)
    }

    for (const record of registrationByInstanceID.values()) {
      if (!record.socket.destroyed) {
        record.socket.destroy()
      }
    }
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
    for (const record of registrationByInstanceID.values()) {
      if (!record.socket.destroyed) {
        return true
      }
    }
    for (const record of liveBridgeByInstanceID.values()) {
      if (!record.socket.destroyed) {
        return true
      }
    }

    const activeRequests = await listActiveRequests()
    return activeRequests.some((request) => request.status === "open")
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
