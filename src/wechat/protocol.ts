import type { RequestPromptSummary } from "./question-interaction.js"

export type BrokerImplementedMessageType =
  | "registerInstance"
  | "registerAck"
  | "heartbeat"
  | "ping"
  | "pong"
  | "statusSnapshot"
  | "syncWechatNotifications"
  | "error"

export type BrokerFutureMessageType =
  | "collectStatus"
  | "replyQuestion"
  | "replyQuestionResult"
  | "replyNaturalStop"
  | "replyNaturalStopResult"
  | "rejectQuestion"
  | "replyPermission"
  | "replyPermissionResult"
  | "showFallbackToast"

export type BrokerMessageType = BrokerImplementedMessageType | BrokerFutureMessageType

export type CollectStatusPayload = {
  requestId: string
}

export type StatusSnapshotPayload = {
  requestId: string
  snapshot: unknown
}

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

function isMessageType(value: unknown): value is BrokerMessageType {
  return (
    value === "registerInstance" ||
    value === "registerAck" ||
    value === "heartbeat" ||
    value === "ping" ||
    value === "pong" ||
    value === "statusSnapshot" ||
    value === "syncWechatNotifications" ||
    value === "error" ||
    value === "collectStatus" ||
    value === "replyQuestion" ||
    value === "replyQuestionResult" ||
    value === "replyNaturalStop" ||
    value === "replyNaturalStopResult" ||
    value === "rejectQuestion" ||
    value === "replyPermission" ||
    value === "replyPermissionResult" ||
    value === "showFallbackToast"
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
