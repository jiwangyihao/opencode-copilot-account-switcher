import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  WECHAT_FILE_MODE,
  ensureWechatStateLayout,
  notificationStatePath,
  notificationsDir,
} from "./state-paths.js"
import {
  type NaturalStopTerminalReason,
  type NotificationKind,
  type NotificationRecord,
  type SessionReplyTarget,
} from "./notification-types.js"
import { normalizeHandle } from "./handle.js"
import { normalizeRequestPromptSummary } from "./question-interaction.js"
import type { RequestTerminalReason } from "./request-store.js"

type NotificationStoreTestHooks = {
  beforePersistBackfilledScopeKey?: (input: { record: NotificationRecord; scopeKey: string }) => Promise<void> | void
  afterWriteNotification?: (record: NotificationRecord) => Promise<void> | void
}

let notificationStoreTestHooks: NotificationStoreTestHooks | undefined

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return value === "question" || value === "permission" || value === "sessionError" || value === "requestTerminal" || value === "naturalStop"
}

function isRequestNotificationKind(value: unknown): value is "question" | "permission" {
  return value === "question" || value === "permission"
}

function isRequestTerminalReason(value: unknown): value is RequestTerminalReason {
  return value === "answered" || value === "rejected" || value === "expired" || value === "replaced"
}

function isNaturalStopTerminalReason(value: unknown): value is NaturalStopTerminalReason {
  return value === "replied" || value === "continued" || value === "expired"
}

function isSessionReplyTarget(value: unknown): value is SessionReplyTarget {
  return typeof value === "object"
    && value !== null
    && isNonEmptyString((value as { instanceID?: unknown }).instanceID)
    && isNonEmptyString((value as { sessionID?: unknown }).sessionID)
}

function isNotificationStatus(value: unknown): value is NotificationRecord["status"] {
  return ["pending", "sent", "resolved", "failed", "suppressed"].includes(value as NotificationRecord["status"])
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase()
}

const DEFAULT_NOTIFICATION_MERGE_WINDOW_MS = 2_000

function sameNotificationSnapshot(left: NotificationRecord, right: NotificationRecord): boolean {
  return JSON.stringify(normalizeRecord(left)) === JSON.stringify(normalizeRecord(right))
}

function normalizeRecord(input: NotificationRecord): NotificationRecord {
  const base = {
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    ...(isNonEmptyString(input.registrationEpoch) ? { registrationEpoch: input.registrationEpoch } : {}),
    createdAt: input.createdAt,
    status: input.status,
    ...(typeof input.sentAt === "number" ? { sentAt: input.sentAt } : {}),
    ...(typeof input.resolvedAt === "number" ? { resolvedAt: input.resolvedAt } : {}),
    ...(typeof input.failedAt === "number" ? { failedAt: input.failedAt } : {}),
    ...(typeof input.suppressedAt === "number" ? { suppressedAt: input.suppressedAt } : {}),
    ...(isNonEmptyString(input.failureReason) ? { failureReason: input.failureReason } : {}),
  }

  if (input.kind === "sessionError") {
    return {
      ...base,
      ...(isNonEmptyString(input.sessionID) ? { sessionID: input.sessionID.trim() } : {}),
      ...(isNonEmptyString(input.action) ? { action: input.action.trim() } : {}),
      ...(isNonEmptyString(input.redactedSummary) ? { redactedSummary: input.redactedSummary.trim() } : {}),
      ...(isNonEmptyString(input.severityAdvice) ? { severityAdvice: input.severityAdvice.trim() } : {}),
    }
  }

  if (input.kind === "naturalStop") {
    return {
      ...base,
      ...(isNonEmptyString(input.handle) ? { handle: normalizeHandle(input.handle) } : {}),
      ...(isNonEmptyString(input.scopeKey) ? { scopeKey: input.scopeKey } : {}),
      ...(isNonEmptyString(input.sessionID) ? { sessionID: input.sessionID.trim() } : {}),
      ...(isNonEmptyString(input.redactedSummary) ? { redactedSummary: input.redactedSummary.trim() } : {}),
      ...(isNonEmptyString(input.severityAdvice) ? { severityAdvice: input.severityAdvice.trim() } : {}),
      ...(isSessionReplyTarget(input.replyTarget)
        ? {
            replyTarget: {
              instanceID: input.replyTarget.instanceID.trim(),
              sessionID: input.replyTarget.sessionID.trim(),
            },
          }
        : {}),
      ...(isNaturalStopTerminalReason(input.naturalStopTerminalReason)
        ? { naturalStopTerminalReason: input.naturalStopTerminalReason }
        : {}),
    }
  }

  return {
    ...base,
    ...(isNonEmptyString(input.routeKey) ? { routeKey: input.routeKey } : {}),
    ...(isNonEmptyString(input.handle) ? { handle: input.handle } : {}),
    ...(isNonEmptyString(input.scopeKey) ? { scopeKey: input.scopeKey } : {}),
    ...(isRequestNotificationKind(input.kind) && input.prompt !== undefined
      ? { prompt: normalizeRequestPromptSummary(input.kind, input.prompt) }
      : {}),
    ...(input.kind === "requestTerminal" && isRequestNotificationKind(input.requestKind)
      ? { requestKind: input.requestKind }
      : {}),
    ...(input.kind === "requestTerminal" && isRequestTerminalReason(input.terminalReason)
      ? { terminalReason: input.terminalReason }
      : {}),
    ...(input.kind === "requestTerminal" && isNonEmptyString(input.replacementHandle)
      ? { replacementHandle: normalizeHandle(input.replacementHandle) }
      : {}),
  }
}

function assertValidIdempotencyKey(idempotencyKey: string) {
  if (!/^[a-z0-9-]+$/.test(idempotencyKey) || idempotencyKey.includes("..")) {
    throw new Error("invalid notification record format")
  }
}

function toRecord(input: unknown): NotificationRecord {
  const parsed = input as Partial<NotificationRecord>
  if (
    !parsed ||
    !isNonEmptyString(parsed.idempotencyKey) ||
    !isNotificationKind(parsed.kind) ||
    !isNonEmptyString(parsed.wechatAccountId) ||
    !isNonEmptyString(parsed.userId) ||
    (parsed.registrationEpoch !== undefined && !isNonEmptyString(parsed.registrationEpoch)) ||
    !isFiniteNumber(parsed.createdAt) ||
    !isNotificationStatus(parsed.status)
  ) {
    throw new Error("invalid notification record format")
  }

  if (
    (parsed.sentAt !== undefined && !isFiniteNumber(parsed.sentAt)) ||
    (parsed.resolvedAt !== undefined && !isFiniteNumber(parsed.resolvedAt)) ||
    (parsed.failedAt !== undefined && !isFiniteNumber(parsed.failedAt)) ||
    (parsed.suppressedAt !== undefined && !isFiniteNumber(parsed.suppressedAt)) ||
    (parsed.failureReason !== undefined && !isNonEmptyString(parsed.failureReason))
  ) {
    throw new Error("invalid notification record format")
  }

  if (parsed.kind === "sessionError") {
    if (
      parsed.routeKey !== undefined
      || parsed.handle !== undefined
      || parsed.scopeKey !== undefined
      || parsed.prompt !== undefined
      || parsed.replyTarget !== undefined
      || parsed.naturalStopTerminalReason !== undefined
      || parsed.requestKind !== undefined
      || parsed.terminalReason !== undefined
      || parsed.replacementHandle !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
    if (
      (parsed.sessionID !== undefined && !isNonEmptyString(parsed.sessionID))
      || (parsed.action !== undefined && !isNonEmptyString(parsed.action))
      || (parsed.redactedSummary !== undefined && !isNonEmptyString(parsed.redactedSummary))
      || (parsed.severityAdvice !== undefined && !isNonEmptyString(parsed.severityAdvice))
    ) {
      throw new Error("invalid notification record format")
    }
  } else if (parsed.kind === "naturalStop") {
    if (
      parsed.routeKey !== undefined
      || parsed.prompt !== undefined
      || parsed.requestKind !== undefined
      || parsed.terminalReason !== undefined
      || parsed.replacementHandle !== undefined
      || parsed.action !== undefined
      || !isNonEmptyString(parsed.handle)
      || !isNonEmptyString(parsed.sessionID)
      || !isSessionReplyTarget(parsed.replyTarget)
      || !isNonEmptyString(parsed.redactedSummary)
      || !isNonEmptyString(parsed.severityAdvice)
      || (parsed.scopeKey !== undefined && !isNonEmptyString(parsed.scopeKey))
      || (parsed.naturalStopTerminalReason !== undefined && !isNaturalStopTerminalReason(parsed.naturalStopTerminalReason))
    ) {
      throw new Error("invalid notification record format")
    }
  } else if (isRequestNotificationKind(parsed.kind)) {
    if (!isNonEmptyString(parsed.routeKey) || !isNonEmptyString(parsed.handle)) {
      throw new Error("invalid notification record format")
    }
    if (parsed.scopeKey !== undefined && !isNonEmptyString(parsed.scopeKey)) {
      throw new Error("invalid notification record format")
    }
    if (parsed.prompt !== undefined) {
      normalizeRequestPromptSummary(parsed.kind, parsed.prompt)
    }
    if (
      parsed.requestKind !== undefined
      || parsed.terminalReason !== undefined
      || parsed.replacementHandle !== undefined
      || parsed.sessionID !== undefined
      || parsed.action !== undefined
      || parsed.redactedSummary !== undefined
      || parsed.severityAdvice !== undefined
      || parsed.replyTarget !== undefined
      || parsed.naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
  } else {
    if (
      !isNonEmptyString(parsed.routeKey)
      || !isNonEmptyString(parsed.handle)
      || !isRequestNotificationKind(parsed.requestKind)
      || !isRequestTerminalReason(parsed.terminalReason)
    ) {
      throw new Error("invalid notification record format")
    }
    if (parsed.scopeKey !== undefined && !isNonEmptyString(parsed.scopeKey)) {
      throw new Error("invalid notification record format")
    }
    if (parsed.prompt !== undefined) {
      throw new Error("invalid notification record format")
    }
    if (
      parsed.sessionID !== undefined
      || parsed.action !== undefined
      || parsed.redactedSummary !== undefined
      || parsed.severityAdvice !== undefined
      || parsed.replyTarget !== undefined
      || parsed.naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
    if (parsed.replacementHandle !== undefined && !isNonEmptyString(parsed.replacementHandle)) {
      throw new Error("invalid notification record format")
    }
    if (parsed.terminalReason === "replaced") {
      if (!isNonEmptyString(parsed.replacementHandle)) {
        throw new Error("invalid notification record format")
      }
    } else if (parsed.replacementHandle !== undefined) {
      throw new Error("invalid notification record format")
    }
  }

  if (parsed.status === "sent" && !isFiniteNumber(parsed.sentAt)) {
    throw new Error("invalid notification record format")
  }
  if (parsed.status === "resolved" && !isFiniteNumber(parsed.resolvedAt)) {
    throw new Error("invalid notification record format")
  }
  if (
    parsed.status === "failed" &&
    (!isFiniteNumber(parsed.failedAt) || !isNonEmptyString(parsed.failureReason))
  ) {
    throw new Error("invalid notification record format")
  }
  if (parsed.status === "suppressed" && !isFiniteNumber(parsed.suppressedAt)) {
    throw new Error("invalid notification record format")
  }

  return normalizeRecord(parsed as NotificationRecord)
}

async function readNotification(idempotencyKey: string): Promise<NotificationRecord> {
  try {
    const raw = await readFile(notificationStatePath(idempotencyKey), "utf8")
    const record = toRecord(JSON.parse(raw))
    if (record.idempotencyKey !== idempotencyKey) {
      throw new Error("invalid notification record format")
    }
    return record
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") throw error
    if (error instanceof Error && error.message === "invalid notification record format") throw error
    throw new Error("invalid notification record format")
  }
}

export function setNotificationStoreTestHooks(hooks: NotificationStoreTestHooks | undefined): void {
  notificationStoreTestHooks = hooks
}

async function writeNotification(record: NotificationRecord): Promise<NotificationRecord> {
  await ensureWechatStateLayout()
  const filePath = notificationStatePath(record.idempotencyKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  const normalized = normalizeRecord(record)
  await writeFile(filePath, JSON.stringify(normalized, null, 2), { mode: WECHAT_FILE_MODE })
  await notificationStoreTestHooks?.afterWriteNotification?.(normalized)
  return normalized
}

export async function upsertNotification(
  input: Omit<NotificationRecord, "status" | "sentAt" | "resolvedAt" | "failedAt" | "suppressedAt" | "failureReason">,
  options: {
    initialStatus?: "pending" | "suppressed"
    suppressedAt?: number
  } = {},
): Promise<NotificationRecord> {
  if (
    !isNonEmptyString((input as { idempotencyKey: unknown }).idempotencyKey) ||
    !isNotificationKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { wechatAccountId: unknown }).wechatAccountId) ||
    !isNonEmptyString((input as { userId: unknown }).userId) ||
    !isFiniteNumber((input as { createdAt: unknown }).createdAt)
  ) {
    throw new Error("invalid notification record format")
  }

  assertValidIdempotencyKey(input.idempotencyKey)

  const initialStatus = options.initialStatus ?? "pending"
  if (initialStatus === "suppressed" && !isFiniteNumber(options.suppressedAt)) {
    throw new Error("invalid notification record format")
  }

  if (input.kind === "sessionError") {
    if (
      (input as { routeKey?: string }).routeKey !== undefined
      || (input as { handle?: string }).handle !== undefined
      || (input as { scopeKey?: string }).scopeKey !== undefined
      || (input as { requestKind?: string }).requestKind !== undefined
      || (input as { terminalReason?: string }).terminalReason !== undefined
      || (input as { replacementHandle?: string }).replacementHandle !== undefined
      || (input as { replyTarget?: SessionReplyTarget }).replyTarget !== undefined
      || (input as { naturalStopTerminalReason?: NaturalStopTerminalReason }).naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
    const sessionID = (input as { sessionID?: unknown }).sessionID
    const action = (input as { action?: unknown }).action
    const redactedSummary = (input as { redactedSummary?: unknown }).redactedSummary
    const severityAdvice = (input as { severityAdvice?: unknown }).severityAdvice
    if (
      (sessionID !== undefined && !isNonEmptyString(sessionID))
      || (action !== undefined && !isNonEmptyString(action))
      || (redactedSummary !== undefined && !isNonEmptyString(redactedSummary))
      || (severityAdvice !== undefined && !isNonEmptyString(severityAdvice))
    ) {
      throw new Error("invalid notification record format")
    }
  } else if (input.kind === "naturalStop") {
    const handle = (input as { handle?: unknown }).handle
    const sessionID = (input as { sessionID?: unknown }).sessionID
    const replyTarget = (input as { replyTarget?: unknown }).replyTarget
    const redactedSummary = (input as { redactedSummary?: unknown }).redactedSummary
    const severityAdvice = (input as { severityAdvice?: unknown }).severityAdvice
    if (
      !isNonEmptyString(handle)
      || !isNonEmptyString(sessionID)
      || !isSessionReplyTarget(replyTarget)
      || !isNonEmptyString(redactedSummary)
      || !isNonEmptyString(severityAdvice)
      || (input as { routeKey?: unknown }).routeKey !== undefined
      || (input as { requestKind?: unknown }).requestKind !== undefined
      || (input as { terminalReason?: unknown }).terminalReason !== undefined
      || (input as { replacementHandle?: unknown }).replacementHandle !== undefined
      || (input as { action?: unknown }).action !== undefined
      || (input as { naturalStopTerminalReason?: unknown }).naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
    if ((input as { scopeKey?: unknown }).scopeKey !== undefined && !isNonEmptyString((input as { scopeKey?: unknown }).scopeKey)) {
      throw new Error("invalid notification record format")
    }
  } else if (isRequestNotificationKind(input.kind)) {
    if (
      !isNonEmptyString((input as { routeKey?: unknown }).routeKey)
      || !isNonEmptyString((input as { handle?: unknown }).handle)
    ) {
      throw new Error("invalid notification record format")
    }
    if ((input as { scopeKey?: unknown }).scopeKey !== undefined && !isNonEmptyString((input as { scopeKey?: unknown }).scopeKey)) {
      throw new Error("invalid notification record format")
    }
    if (
      (input as { requestKind?: unknown }).requestKind !== undefined
      || (input as { terminalReason?: unknown }).terminalReason !== undefined
      || (input as { replacementHandle?: unknown }).replacementHandle !== undefined
      || (input as { sessionID?: unknown }).sessionID !== undefined
      || (input as { action?: unknown }).action !== undefined
      || (input as { redactedSummary?: unknown }).redactedSummary !== undefined
      || (input as { severityAdvice?: unknown }).severityAdvice !== undefined
      || (input as { replyTarget?: unknown }).replyTarget !== undefined
      || (input as { naturalStopTerminalReason?: unknown }).naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
  } else if (
    !isNonEmptyString((input as { routeKey?: unknown }).routeKey) ||
    !isNonEmptyString((input as { handle?: unknown }).handle) ||
    !isRequestNotificationKind((input as { requestKind?: unknown }).requestKind) ||
    !isRequestTerminalReason((input as { terminalReason?: unknown }).terminalReason)
  ) {
    throw new Error("invalid notification record format")
  } else {
    if ((input as { scopeKey?: unknown }).scopeKey !== undefined && !isNonEmptyString((input as { scopeKey?: unknown }).scopeKey)) {
      throw new Error("invalid notification record format")
    }
    if (
      (input as { sessionID?: unknown }).sessionID !== undefined
      || (input as { action?: unknown }).action !== undefined
      || (input as { redactedSummary?: unknown }).redactedSummary !== undefined
      || (input as { severityAdvice?: unknown }).severityAdvice !== undefined
      || (input as { replyTarget?: unknown }).replyTarget !== undefined
      || (input as { naturalStopTerminalReason?: unknown }).naturalStopTerminalReason !== undefined
    ) {
      throw new Error("invalid notification record format")
    }
    const replacementHandle = (input as { replacementHandle?: unknown }).replacementHandle
    const terminalReason = (input as { terminalReason?: unknown }).terminalReason
    if (terminalReason === "replaced") {
      if (!isNonEmptyString(replacementHandle)) {
        throw new Error("invalid notification record format")
      }
    } else if (replacementHandle !== undefined) {
      throw new Error("invalid notification record format")
    }
  }

  try {
    const current = await readNotification(input.idempotencyKey)
    return current
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }

  return writeNotification({
    ...input,
    status: initialStatus,
    ...(initialStatus === "suppressed" ? { suppressedAt: options.suppressedAt } : {}),
  })
}

export async function markNotificationSent(input: { idempotencyKey: string; sentAt: number }): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.sentAt) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (current.status !== "pending" && current.status !== "failed") {
    throw new Error("notification is not pending")
  }
  return writeNotification({
    ...current,
    status: "sent",
    sentAt: input.sentAt,
    failedAt: undefined,
    failureReason: undefined,
  })
}

export async function markNotificationResolved(input: {
  idempotencyKey: string
  resolvedAt: number
  suppressed?: boolean
}): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.resolvedAt) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (input.suppressed) {
    if (current.status !== "pending" && current.status !== "sent") {
      throw new Error("notification is neither pending nor sent")
    }
    return writeNotification({
      ...current,
      status: "suppressed",
      suppressedAt: input.resolvedAt,
    })
  }

  if (current.status !== "sent") {
    throw new Error("notification is not sent")
  }

  return writeNotification({
    ...current,
    status: "resolved",
    resolvedAt: input.resolvedAt,
  })
}

export async function markNotificationFailed(input: {
  idempotencyKey: string
  failedAt: number
  reason: string
}): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.failedAt) || !isNonEmptyString(input.reason) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (current.status !== "pending") {
    throw new Error("notification is not pending")
  }
  return writeNotification({
    ...current,
    status: "failed",
    failedAt: input.failedAt,
    failureReason: input.reason,
  })
}

export async function listPendingNotifications(): Promise<NotificationRecord[]> {
  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const pending: NotificationRecord[] = []
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    if (record.status === "pending") {
      pending.push(record)
    }
  }
  pending.sort((a, b) => a.createdAt - b.createdAt)
  return pending
}

function isMergeableNotificationStatus(status: NotificationRecord["status"]): boolean {
  return status === "pending" || status === "sent"
}

export async function findMergeableNotification(input: {
  kind: "question" | "permission"
  routeKey: string
  handle: string
  scopeKey: string
  createdAt: number
  excludeIdempotencyKey?: string
}): Promise<NotificationRecord | undefined> {
  if (
    (input.kind !== "question" && input.kind !== "permission")
    || !isNonEmptyString(input.routeKey)
    || !isNonEmptyString(input.handle)
    || !isNonEmptyString(input.scopeKey)
    || !isFiniteNumber(input.createdAt)
    || (input.excludeIdempotencyKey !== undefined && !isNonEmptyString(input.excludeIdempotencyKey))
  ) {
    throw new Error("invalid notification record format")
  }

  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const expectedRouteKey = normalizeLookupValue(input.routeKey)
  const expectedHandle = normalizeLookupValue(input.handle)
  let mergeable: NotificationRecord | undefined

  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    if (input.excludeIdempotencyKey !== undefined && idempotencyKey === input.excludeIdempotencyKey) {
      continue
    }

    const record = await readNotification(idempotencyKey)
    if (record.kind !== input.kind || !isMergeableNotificationStatus(record.status)) continue
    if (!isNonEmptyString(record.routeKey) || !isNonEmptyString(record.handle) || !isNonEmptyString(record.scopeKey)) continue
    if (record.scopeKey !== input.scopeKey) continue
    if (normalizeLookupValue(record.routeKey) !== expectedRouteKey) continue
    if (normalizeLookupValue(record.handle) !== expectedHandle) continue
    if (Math.abs(record.createdAt - input.createdAt) > DEFAULT_NOTIFICATION_MERGE_WINDOW_MS) continue
    if (!mergeable || record.createdAt > mergeable.createdAt) {
      mergeable = record
    }
  }

  return mergeable
}

export async function findSentNotificationByRequest(input: {
  kind: "question" | "permission"
  routeKey: string
  handle: string
}): Promise<NotificationRecord | undefined> {
  if (
    (input.kind !== "question" && input.kind !== "permission")
    || !isNonEmptyString(input.routeKey)
    || !isNonEmptyString(input.handle)
  ) {
    throw new Error("invalid notification record format")
  }

  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const expectedRouteKey = normalizeLookupValue(input.routeKey)
  const expectedHandle = normalizeLookupValue(input.handle)
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    if (record.status !== "sent") continue
    if (record.kind !== input.kind) continue
    if (!isNonEmptyString(record.routeKey) || !isNonEmptyString(record.handle)) continue
    if (normalizeLookupValue(record.routeKey) !== expectedRouteKey) continue
    if (normalizeLookupValue(record.handle) !== expectedHandle) continue
    return record
  }

  return undefined
}

function isActiveNaturalStopRecord(record: NotificationRecord): boolean {
  return record.kind === "naturalStop" && (record.status === "pending" || record.status === "sent")
}

function isTerminalNaturalStopRecord(record: NotificationRecord): boolean {
  return record.kind === "naturalStop" && isNaturalStopTerminalReason(record.naturalStopTerminalReason)
}

function isSameReplyTarget(record: NotificationRecord, replyTarget: SessionReplyTarget): boolean {
  return record.replyTarget?.instanceID === replyTarget.instanceID
    && record.replyTarget?.sessionID === replyTarget.sessionID
}

async function listAllNotifications(): Promise<NotificationRecord[]> {
  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const records: NotificationRecord[] = []
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    records.push(await readNotification(fileName.slice(0, -5)))
  }
  return records
}

export async function listActiveNaturalStops(input: {
  wechatAccountId?: string
  userId?: string
  scopeKey?: string
} = {}): Promise<NotificationRecord[]> {
  if (input.wechatAccountId !== undefined && !isNonEmptyString(input.wechatAccountId)) {
    throw new Error("invalid notification record format")
  }
  if (input.userId !== undefined && !isNonEmptyString(input.userId)) {
    throw new Error("invalid notification record format")
  }
  if (input.scopeKey !== undefined && !isNonEmptyString(input.scopeKey)) {
    throw new Error("invalid notification record format")
  }

  const records = await listAllNotifications()
  return records
    .filter((record) => (
      isActiveNaturalStopRecord(record)
      && (input.wechatAccountId === undefined || record.wechatAccountId === input.wechatAccountId)
      && (input.userId === undefined || record.userId === input.userId)
      && (input.scopeKey === undefined || record.scopeKey === input.scopeKey)
    ))
    .sort((left, right) => left.createdAt - right.createdAt)
}

export async function listRetainedNaturalStopHandles(): Promise<string[]> {
  const records = await listAllNotifications()
  return records
    .filter((record) => record.kind === "naturalStop" && isNonEmptyString(record.handle))
    .map((record) => record.handle as string)
}

export async function findActiveNaturalStopByReplyTarget(input: {
  replyTarget: SessionReplyTarget
  wechatAccountId?: string
  userId?: string
}): Promise<NotificationRecord | undefined> {
  if (!isSessionReplyTarget(input.replyTarget)) {
    throw new Error("invalid notification record format")
  }
  if (input.wechatAccountId !== undefined && !isNonEmptyString(input.wechatAccountId)) {
    throw new Error("invalid notification record format")
  }
  if (input.userId !== undefined && !isNonEmptyString(input.userId)) {
    throw new Error("invalid notification record format")
  }

  const records = await listActiveNaturalStops({
    ...(input.wechatAccountId ? { wechatAccountId: input.wechatAccountId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
  })
  return records
    .filter((record) => isSameReplyTarget(record, input.replyTarget))
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

export async function findActiveNaturalStopByHandle(input: { handle: string }): Promise<NotificationRecord | undefined> {
  if (!isNonEmptyString(input.handle)) {
    throw new Error("invalid notification record format")
  }

  const expectedHandle = normalizeLookupValue(normalizeHandle(input.handle))
  const records = await listAllNotifications()
  return records
    .filter((record) => (
    isActiveNaturalStopRecord(record)
    && isNonEmptyString(record.handle)
    && normalizeLookupValue(record.handle) === expectedHandle
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

export async function findTerminalNaturalStopByHandle(input: { handle: string }): Promise<NotificationRecord | undefined> {
  if (!isNonEmptyString(input.handle)) {
    throw new Error("invalid notification record format")
  }

  const expectedHandle = normalizeLookupValue(normalizeHandle(input.handle))
  const records = await listAllNotifications()
  return records
    .filter((record) => (
    isTerminalNaturalStopRecord(record)
    && isNonEmptyString(record.handle)
    && normalizeLookupValue(record.handle) === expectedHandle
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

export async function listActiveNaturalStopsForScope(input: {
  scopeKey: string
  wechatAccountId?: string
  userId?: string
}): Promise<NotificationRecord[]> {
  if (!isNonEmptyString(input.scopeKey)) {
    throw new Error("invalid notification record format")
  }
  return listActiveNaturalStops({
    scopeKey: input.scopeKey,
    ...(input.wechatAccountId ? { wechatAccountId: input.wechatAccountId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
  })
}

export async function markNaturalStopTerminal(input: {
  idempotencyKey: string
  resolvedAt: number
  terminalReason: NaturalStopTerminalReason
}): Promise<NotificationRecord> {
  if (!isNonEmptyString(input.idempotencyKey) || !isFiniteNumber(input.resolvedAt) || !isNaturalStopTerminalReason(input.terminalReason)) {
    throw new Error("invalid notification record format")
  }

  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (current.kind !== "naturalStop") {
    throw new Error("invalid notification record format")
  }
  if (isNaturalStopTerminalReason(current.naturalStopTerminalReason)) {
    return current
  }
  if (current.status !== "pending" && current.status !== "sent") {
    throw new Error("notification is neither pending nor sent")
  }

  return writeNotification({
    ...current,
    status: "resolved",
    resolvedAt: input.resolvedAt,
    naturalStopTerminalReason: input.terminalReason,
  })
}

function terminalAt(record: NotificationRecord): number | undefined {
  if (record.status === "resolved") return record.resolvedAt
  if (record.status === "failed") return record.failedAt
  if (record.status === "suppressed") return record.suppressedAt
  return undefined
}

export async function purgeTerminalNotificationsBefore(input: { cutoffAt: number }): Promise<number> {
  if (!isFiniteNumber(input.cutoffAt)) {
    throw new Error("invalid notification record format")
  }
  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  let deleted = 0
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    const at = terminalAt(record)
    if (typeof at !== "number") continue
    if (at >= input.cutoffAt) continue
    await rm(notificationStatePath(idempotencyKey), { force: true })
    deleted += 1
  }

  return deleted
}
