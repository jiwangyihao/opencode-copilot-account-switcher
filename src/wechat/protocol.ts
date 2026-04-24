import type { RequestPromptSummary } from "./question-interaction.js"

export type BrokerCommandStatus = "queued" | "delivered" | "accepted" | "completed" | "failed"

export type BrokerToBridgeCommandType = "replyQuestion" | "replyPermission" | "replyNaturalStop"

export type BrokerToBridgeControlType = "requestReplay" | "requestFullSync"

export type BridgeToBrokerEventType =
  | "instanceOnline"
  | "instanceOffline"
  | "sessionSnapshotChanged"
  | "questionOpened"
  | "questionUpdated"
  | "questionClosed"
  | "permissionOpened"
  | "permissionUpdated"
  | "permissionClosed"
  | "naturalStopOpened"
  | "naturalStopClosed"
  | "retryErrorUpdated"
  | "commandAccepted"
  | "commandResult"
  | "fullSyncCompleted"

export type BrokerToBridgeCommand<TPayload = unknown> = {
  brokerSeq: number
  commandId: string
  type: BrokerToBridgeCommandType
  payload: TPayload
}

export type BrokerToBridgeControl<TPayload = unknown> = {
  brokerSeq: number
  controlId: string
  type: BrokerToBridgeControlType
  payload: TPayload
}

export type BridgeToBrokerEvent<TPayload = unknown> = {
  eventSeq: number
  instanceIncarnation: string
  type: BridgeToBrokerEventType
  payload: TPayload
  controlId?: string
}

export type HelloRegisterPayload = {
  protocolVersion: number
  stateGeneration: string
  instanceID: string
  instanceIncarnation: string
  lastSeenBrokerSeq?: number
  lastSentEventSeq?: number
}

export type RegisterAckPayload = {
  protocolVersion: number
  stateGeneration: string
  instanceIncarnation: string
  brokerSeq: number
  needReplay: boolean
  needFullSync: boolean
}

export type BrokerAckPayload = {
  ackedEventSeq: number
  instanceIncarnation: string
}

export type HelloRegisterEnvelope = {
  type: "hello/register"
  payload: HelloRegisterPayload
}

export type RegisterAckEnvelope = {
  type: "registerAck"
  payload: RegisterAckPayload
}

export type BrokerAckEnvelope = {
  type: "ack"
  payload: BrokerAckPayload
}

export type BrokerImplementedMessageType =
  | "hello/register"
  | "registerAck"
  | "ack"
  | "ping"
  | "pong"
  | "error"

export type BrokerFutureMessageType =
  | BrokerToBridgeControlType
  | BridgeToBrokerEventType
  | "replyQuestion"
  | "replyNaturalStop"
  | "rejectQuestion"
  | "replyPermission"

export type LegacyRemovedBrokerMessageType =
  | "collectStatus"
  | "registerInstance"
  | "heartbeat"
  | "statusSnapshot"
  | "syncWechatNotifications"
  | "replyQuestionResult"
  | "replyNaturalStopResult"
  | "replyPermissionResult"
  | "showFallbackToast"

export type BrokerMessageType = BrokerImplementedMessageType | BrokerFutureMessageType | LegacyRemovedBrokerMessageType

export const SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON = "deliveryFailed"

export type ShowFallbackToastPayload = {
  wechatAccountId: string
  userId: string
  message: string
  reason: typeof SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON
  registrationEpoch: string
}

export type ReplyMutationResult = {
  mutationId: string
  ok: boolean
  errorMessage?: string
}

export type ReplyQuestionPayload = {
  mutationId: string
  requestID: string
  answers: unknown[]
}

export type ReplyPermissionPayload = {
  mutationId: string
  requestID: string
  reply: "once" | "always" | "reject"
  message?: string
}

export type ReplyNaturalStopPayload = {
  mutationId: string
  sessionID: string
  text: string
}

export type SessionReplyTarget = {
  instanceID: string
  sessionID: string
}

export type WechatNotificationCandidate =
  | {
      idempotencyKey: string
      kind: "question" | "permission"
      requestID: string
      createdAt: number
      routeKey: string
      handle: string
      scopeKey?: string
      wechatAccountId?: string
      userId?: string
      prompt?: RequestPromptSummary
    }
  | {
      idempotencyKey: string
      kind: "sessionError"
      createdAt: number
      sessionID: string
      action: string
      redactedSummary: string
      severityAdvice: string
    }
  | {
      idempotencyKey: string
      kind: "naturalStop"
      createdAt: number
      sessionID: string
      handle: string
      replyTarget: SessionReplyTarget
      redactedSummary: string
      severityAdvice: string
    }

export type SyncWechatNotificationsPayload = {
  candidates: WechatNotificationCandidate[]
}

export type BrokerErrorCode = "unauthorized" | "invalidMessage" | "notImplemented" | "brokerUnavailable"

type EnvelopeBase = {
  id: string
  type: BrokerMessageType
  instanceID?: string
  sessionToken?: string
}

export type BrokerEnvelope<TPayload = unknown> = EnvelopeBase & {
  payload: TPayload
}

export type ErrorPayload = {
  code: BrokerErrorCode
  message: string
  requestId: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function assertNonNegativeInteger(value: unknown, fieldName: string) {
  if (!isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${fieldName}`)
  }
}

function assertCommandType(value: unknown): asserts value is BrokerToBridgeCommandType {
  if (value !== "replyQuestion" && value !== "replyPermission" && value !== "replyNaturalStop") {
    throw new Error("invalid broker command type")
  }
}

function assertControlType(value: unknown): asserts value is BrokerToBridgeControlType {
  if (value !== "requestReplay" && value !== "requestFullSync") {
    throw new Error("invalid broker control type")
  }
}

function assertBridgeEventType(value: unknown): asserts value is BridgeToBrokerEventType {
  if (
    value !== "instanceOnline"
    && value !== "instanceOffline"
    && value !== "sessionSnapshotChanged"
    && value !== "questionOpened"
    && value !== "questionUpdated"
    && value !== "questionClosed"
    && value !== "permissionOpened"
    && value !== "permissionUpdated"
    && value !== "permissionClosed"
    && value !== "naturalStopOpened"
    && value !== "naturalStopClosed"
    && value !== "retryErrorUpdated"
    && value !== "commandAccepted"
    && value !== "commandResult"
    && value !== "fullSyncCompleted"
  ) {
    throw new Error("invalid bridge event type")
  }
}

export function createBrokerCommandEnvelope<TPayload = unknown>(
  envelope: BrokerToBridgeCommand<TPayload>,
): BrokerToBridgeCommand<TPayload> {
  assertNonNegativeInteger(envelope.brokerSeq, "brokerSeq")
  if (!isNonEmptyString(envelope.commandId)) {
    throw new Error("invalid commandId")
  }
  assertCommandType(envelope.type)
  return { ...envelope }
}

export function createBrokerControlEnvelope<TPayload = unknown>(
  envelope: BrokerToBridgeControl<TPayload>,
): BrokerToBridgeControl<TPayload> {
  assertNonNegativeInteger(envelope.brokerSeq, "brokerSeq")
  if (!isNonEmptyString(envelope.controlId)) {
    throw new Error("invalid controlId")
  }
  assertControlType(envelope.type)
  return { ...envelope }
}

export function createBridgeEventEnvelope<TPayload = unknown>(
  envelope: BridgeToBrokerEvent<TPayload>,
): BridgeToBrokerEvent<TPayload> {
  assertNonNegativeInteger(envelope.eventSeq, "eventSeq")
  if (!isNonEmptyString(envelope.instanceIncarnation)) {
    throw new Error("invalid instanceIncarnation")
  }
  assertBridgeEventType(envelope.type)
  if (envelope.type === "fullSyncCompleted" && !isNonEmptyString(envelope.controlId)) {
    throw new Error("invalid controlId")
  }
  return { ...envelope }
}

export function createHelloRegisterEnvelope(payload: HelloRegisterPayload): HelloRegisterEnvelope {
  assertNonNegativeInteger(payload.protocolVersion, "protocolVersion")
  if (
    !isNonEmptyString(payload.stateGeneration)
    || !isNonEmptyString(payload.instanceID)
    || !isNonEmptyString(payload.instanceIncarnation)
  ) {
    throw new Error("invalid hello/register payload")
  }
  if (payload.lastSeenBrokerSeq !== undefined) {
    assertNonNegativeInteger(payload.lastSeenBrokerSeq, "lastSeenBrokerSeq")
  }
  if (payload.lastSentEventSeq !== undefined) {
    assertNonNegativeInteger(payload.lastSentEventSeq, "lastSentEventSeq")
  }

  return {
    type: "hello/register",
    payload: { ...payload },
  }
}

export function createRegisterAckEnvelope(payload: RegisterAckPayload): RegisterAckEnvelope {
  assertNonNegativeInteger(payload.protocolVersion, "protocolVersion")
  assertNonNegativeInteger(payload.brokerSeq, "brokerSeq")
  if (
    !isNonEmptyString(payload.stateGeneration)
    || !isNonEmptyString(payload.instanceIncarnation)
    || typeof payload.needReplay !== "boolean"
    || typeof payload.needFullSync !== "boolean"
  ) {
    throw new Error("invalid registerAck payload")
  }

  return {
    type: "registerAck",
    payload: { ...payload },
  }
}

export function createBrokerAckEnvelope(payload: BrokerAckPayload): BrokerAckEnvelope {
  assertNonNegativeInteger(payload.ackedEventSeq, "ackedEventSeq")
  if (!isNonEmptyString(payload.instanceIncarnation)) {
    throw new Error("invalid ack payload")
  }

  return {
    type: "ack",
    payload: { ...payload },
  }
}

function isMessageType(value: unknown): value is BrokerMessageType {
  return (
    value === "hello/register" ||
    value === "registerAck" ||
    value === "ack" ||
    value === "ping" ||
    value === "pong" ||
    value === "error" ||
    value === "requestReplay" ||
    value === "requestFullSync" ||
    value === "instanceOnline" ||
    value === "instanceOffline" ||
    value === "sessionSnapshotChanged" ||
    value === "questionOpened" ||
    value === "questionUpdated" ||
    value === "questionClosed" ||
    value === "permissionOpened" ||
    value === "permissionUpdated" ||
    value === "permissionClosed" ||
    value === "naturalStopOpened" ||
    value === "naturalStopClosed" ||
    value === "retryErrorUpdated" ||
    value === "commandAccepted" ||
    value === "commandResult" ||
    value === "fullSyncCompleted" ||
    value === "replyQuestion" ||
    value === "replyNaturalStop" ||
    value === "rejectQuestion" ||
    value === "replyPermission"
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function assertValidEnvelope(envelope: unknown): asserts envelope is BrokerEnvelope {
  if (!isObject(envelope)) {
    throw new Error("invalid message envelope")
  }

  if (!isNonEmptyString(envelope.id) || !isMessageType(envelope.type)) {
    throw new Error("invalid message envelope")
  }

  if (!("payload" in envelope)) {
    throw new Error("invalid message envelope")
  }

  if (envelope.instanceID !== undefined && !isNonEmptyString(envelope.instanceID)) {
    throw new Error("invalid message envelope")
  }

  if (envelope.sessionToken !== undefined && !isNonEmptyString(envelope.sessionToken)) {
    throw new Error("invalid message envelope")
  }
}

export function serializeEnvelope<TPayload = unknown>(envelope: BrokerEnvelope<TPayload>): string {
  assertValidEnvelope(envelope)
  return `${JSON.stringify(envelope)}\n`
}

export function parseEnvelopeLine(line: string): BrokerEnvelope {
  if (typeof line !== "string" || line.length === 0) {
    throw new Error("invalid message line")
  }

  if (!line.endsWith("\n")) {
    throw new Error("invalid message line")
  }

  const body = line.slice(0, -1)
  if (body.length === 0 || body.includes("\n") || body.includes("\r")) {
    throw new Error("invalid message line")
  }

  try {
    const parsed = JSON.parse(body)
    assertValidEnvelope(parsed)
    return parsed
  } catch {
    throw new Error("invalid message line")
  }
}

export function createErrorEnvelope(
  code: BrokerErrorCode,
  message: string,
  requestId: string,
): BrokerEnvelope<ErrorPayload> {
  if (!isNonEmptyString(message) || !isNonEmptyString(requestId)) {
    throw new Error("invalid error envelope")
  }

  return {
    id: `err-${requestId}`,
    type: "error",
    payload: {
      code,
      message,
      requestId,
    },
  }
}
