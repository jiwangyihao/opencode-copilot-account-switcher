import { readCommonSettingsStore } from "../common-settings-store.js"
import {
  listPendingNotifications,
  markNotificationResolved,
  markNotificationFailed,
  markNotificationSent,
  purgeTerminalNotificationsBefore,
} from "./notification-store.js"
import { formatWechatNotificationText } from "./notification-format.js"
import type { NotificationKind } from "./notification-types.js"
import type { NotificationRecord } from "./notification-types.js"
import { readBrokerDeliveryToken, readBrokerIndexedRequest } from "./broker-state-store.js"

export type WechatNotificationSendInput = {
  to: string
  text: string
  contextToken?: string
}

export type WechatNotificationDeliveryFailureInput = {
  kind: NotificationKind
  requestKind?: NotificationRecord["requestKind"]
  routeKey?: string
  scopeKey?: string
  wechatAccountId: string
  userId: string
  registrationEpoch?: string
}

type NotificationStateOps = {
  listPendingNotifications: typeof listPendingNotifications
  markNotificationResolved: typeof markNotificationResolved
  markNotificationFailed: typeof markNotificationFailed
  markNotificationSent: typeof markNotificationSent
  purgeTerminalNotificationsBefore: typeof purgeTerminalNotificationsBefore
}

type CreateWechatNotificationDispatcherInput = {
  sendMessage: (input: WechatNotificationSendInput) => Promise<unknown>
  onDeliveryFailed?: (input: WechatNotificationDeliveryFailureInput) => Promise<void> | void
  notificationStateOps?: Partial<NotificationStateOps>
}

type WechatNotificationDispatcher = {
  drainOutboundMessages: () => Promise<void>
}

const DEFAULT_NOTIFICATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function toPositiveNumber(rawValue: string | undefined, fallback: number): number {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function shouldSendRecord(record: Pick<NotificationRecord, "kind" | "requestKind">, notifications: {
  enabled: boolean
  question: boolean
  permission: boolean
  sessionError: boolean
}): boolean {
  if (!notifications.enabled) {
    return false
  }
  if (record.kind === "question") {
    return notifications.question
  }
  if (record.kind === "permission") {
    return notifications.permission
  }
  if (record.kind === "requestTerminal") {
    return record.requestKind === "permission" ? notifications.permission : notifications.question
  }
  if (record.kind === "naturalStop") {
    return notifications.sessionError
  }
  return notifications.sessionError
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return String(error)
}

function isNotPendingStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /not pending/i.test(error.message)
}

function isNotSuppressibleStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /not pending|neither pending nor sent/i.test(error.message)
}

async function shouldSuppressPendingNotification(record: {
  kind: NotificationKind
  createdAt: number
  wechatAccountId: string
  userId: string
  routeKey?: string
}): Promise<boolean> {
  if (record.kind === "sessionError") {
    const tokenState = await readBrokerDeliveryToken({
      wechatAccountId: record.wechatAccountId,
      userId: record.userId,
    }).catch(() => undefined)
    return Boolean(tokenState && !tokenState.staleReason && tokenState.updatedAt > record.createdAt)
  }
  if (record.kind === "requestTerminal") {
    return false
  }
  if (record.kind === "naturalStop") {
    return false
  }
  if (typeof record.routeKey !== "string" || record.routeKey.trim().length === 0) {
    return false
  }

  const request = await readBrokerIndexedRequest({
    kind: record.kind,
    routeKey: record.routeKey,
  })
  if (!request) {
    return true
  }
  return request.status !== "open"
}

function isNotFailWritableStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /not pending/i.test(error.message)
}

export async function suppressPreparedPendingNotifications(records: NotificationRecord[]): Promise<void> {
  for (const record of records) {
    try {
      await markNotificationResolved({
        idempotencyKey: record.idempotencyKey,
        resolvedAt: Date.now(),
        suppressed: true,
      })
    } catch (error) {
      if (!isNotSuppressibleStateError(error)) {
        throw error
      }
    }
  }
}

export function createWechatNotificationDispatcher(
  input: CreateWechatNotificationDispatcherInput,
): WechatNotificationDispatcher {
  const notificationStateOps: NotificationStateOps = {
    listPendingNotifications,
    markNotificationResolved,
    markNotificationFailed,
    markNotificationSent,
    purgeTerminalNotificationsBefore,
    ...input.notificationStateOps,
  }
  const inFlightNotificationIds = new Set<string>()

  return {
    drainOutboundMessages: async () => {
      const retentionMs = toPositiveNumber(
        process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS,
        DEFAULT_NOTIFICATION_TERMINAL_RETENTION_MS,
      )
      await notificationStateOps.purgeTerminalNotificationsBefore({
        cutoffAt: Date.now() - retentionMs,
      })

      const settings = await readCommonSettingsStore()
      const notifications = settings.wechat?.notifications
      const targetUserId = settings.wechat?.primaryBinding?.userId
      const targetAccountId = settings.wechat?.primaryBinding?.accountId
      if (!notifications) {
        return
      }
      if (typeof targetUserId !== "string" || targetUserId.trim().length === 0) {
        return
      }
      if (typeof targetAccountId !== "string" || targetAccountId.trim().length === 0) {
        return
      }

      const pending = await notificationStateOps.listPendingNotifications()
      for (const record of pending) {
        if (inFlightNotificationIds.has(record.idempotencyKey)) {
          continue
        }
        inFlightNotificationIds.add(record.idempotencyKey)

        try {
          if (await shouldSuppressPendingNotification(record)) {
            try {
              await notificationStateOps.markNotificationResolved({
                idempotencyKey: record.idempotencyKey,
                resolvedAt: Date.now(),
                suppressed: true,
              })
            } catch (error) {
              if (!isNotSuppressibleStateError(error)) {
                throw error
              }
            }
            continue
          }

          if (!shouldSendRecord(record, notifications)) {
            continue
          }
          if (record.userId !== targetUserId || record.wechatAccountId !== targetAccountId) {
            continue
          }

          const tokenState = await readBrokerDeliveryToken({
            wechatAccountId: record.wechatAccountId,
            userId: record.userId,
          }).catch(() => undefined)
          if (tokenState && tokenState.staleReason) {
            continue
          }

          try {
            await input.sendMessage({
              to: targetUserId,
              text: formatWechatNotificationText(record),
              ...(tokenState && !tokenState.staleReason ? { contextToken: tokenState.contextToken } : {}),
            })
          } catch (error) {
            let markFailedError: unknown
            let persistedFailed = false
            try {
              await notificationStateOps.markNotificationFailed({
                idempotencyKey: record.idempotencyKey,
                failedAt: Date.now(),
                reason: toErrorMessage(error),
              })
              persistedFailed = true
            } catch (markError) {
              if (!isNotFailWritableStateError(markError)) {
                markFailedError = markError
              }
            }
            if (persistedFailed) {
              await input.onDeliveryFailed?.({
                kind: record.kind,
                requestKind: record.requestKind,
                routeKey: record.routeKey,
                scopeKey: record.scopeKey,
                wechatAccountId: record.wechatAccountId,
                userId: record.userId,
                registrationEpoch: record.registrationEpoch,
              })
            }
            if (markFailedError) {
              throw markFailedError
            }
            continue
          }

          try {
            await notificationStateOps.markNotificationSent({
              idempotencyKey: record.idempotencyKey,
              sentAt: Date.now(),
            })
          } catch (error) {
            if (!isNotPendingStateError(error)) {
              try {
                await notificationStateOps.markNotificationFailed({
                  idempotencyKey: record.idempotencyKey,
                  failedAt: Date.now(),
                  reason: `notification delivered but sent persistence failed: ${toErrorMessage(error)}`,
                })
              } catch (markFailedError) {
                if (!isNotFailWritableStateError(markFailedError)) {
                  throw markFailedError
                }
              }
            }
          }
        } finally {
          inFlightNotificationIds.delete(record.idempotencyKey)
        }
      }
    },
  }
}
