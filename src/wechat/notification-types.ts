import type { RequestPromptSummary } from "./question-interaction.js"
import type { RequestTerminalReason } from "./request-store.js"

export type SessionReplyTarget = {
  instanceID: string
  sessionID: string
}

export type NaturalStopTerminalReason = "replied" | "continued" | "expired"

export type NotificationKind = "question" | "permission" | "sessionError" | "requestTerminal" | "naturalStop"

export type NotificationStatus = "pending" | "sent" | "resolved" | "failed" | "suppressed"

export type NotificationRecord = {
  idempotencyKey: string
  kind: NotificationKind
  wechatAccountId: string
  userId: string
  registrationEpoch?: string
  createdAt: number
  status: NotificationStatus
  routeKey?: string
  handle?: string
  scopeKey?: string
  prompt?: RequestPromptSummary
  sessionID?: string
  action?: string
  redactedSummary?: string
  severityAdvice?: string
  replyTarget?: SessionReplyTarget
  naturalStopTerminalReason?: NaturalStopTerminalReason
  requestKind?: "question" | "permission"
  terminalReason?: RequestTerminalReason
  replacementHandle?: string
  sentAt?: number
  resolvedAt?: number
  failedAt?: number
  suppressedAt?: number
  failureReason?: string
}
