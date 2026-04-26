import { NOTIFICATION_DELIVERY_FAILED_STALE_REASON } from "./token-store.js"
import {
  SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
  type ShowFallbackToastPayload,
} from "./protocol.js"
import type { WechatDeadLetterRecord } from "./dead-letter-store.js"
import type { NotificationRecord } from "./notification-types.js"
import type { PreparedRecoveryRequestReopen, RequestRecord } from "./request-store.js"

type DestroyableSocket = {
  destroyed: boolean
}

export type LiveRegistration<TSocket extends DestroyableSocket = DestroyableSocket> = {
  socket: TSocket
  sessionToken: string
  registrationEpoch: string
}

export type FallbackToastMutation = {
  type: "fallbackToastMutation"
  instanceID: string
  wechatAccountId: string
  userId: string
  message: string
  reason: typeof SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON
  registrationEpoch?: string
}

export type BrokerMutationDiagnosticEvent = {
  type: "showFallbackToast" | "fallbackToastDropped"
  code: "showFallbackToast" | "fallbackToastDropped"
  instanceID: string
  reason?: typeof SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON
  registrationEpoch?: string
  liveRegistrationEpoch?: string
}

export type RecoveryMutation = {
  type: "recoveryMutation"
  requestedHandle: string
  deadLetter: WechatDeadLetterRecord
  originalRequest: RequestRecord
  pendingNotifications: NotificationRecord[]
  recoveryChainHandles: string[]
}

export type RecoveryMutationFailure = {
  recoveryErrorCode: string
  recoveryErrorMessage: string
}

export type RecoveryMutationResult = {
  ok: true
  recovered: RequestRecord
} | {
  ok: false
  message: string
}

type ExecuteRecoveryMutationDeps = {
  revalidate: (mutation: RecoveryMutation) => Promise<RecoveryMutationResult | undefined>
  prepareFreshRecovery: (mutation: RecoveryMutation, recoveredAt: number) => Promise<PreparedRecoveryRequestReopen>
  suppressPendingNotifications: (mutation: RecoveryMutation) => Promise<void>
  commitPreparedRecovery: (prepared: PreparedRecoveryRequestReopen, mutation: RecoveryMutation) => Promise<RequestRecord>
  rollbackPreparedRecovery: (prepared: PreparedRecoveryRequestReopen, mutation: RecoveryMutation) => Promise<void>
  markRecovered: (input: { kind: WechatDeadLetterRecord["kind"]; routeKey: string; recoveredAt: number }) => Promise<void>
  markFailed: (input: {
    kind: WechatDeadLetterRecord["kind"]
    routeKey: string
    failure: RecoveryMutationFailure
  }) => Promise<void>
  mapFailure: (error: unknown) => RecoveryMutationFailure
  appendDiagnostic?: (event: BrokerMutationDiagnosticEvent) => Promise<void>
  now?: () => number
  testHooks?: {
    afterReopenRequest?: (mutation: RecoveryMutation) => Promise<void> | void
  }
}

type ExecuteFallbackToastMutationDeps<TSocket extends DestroyableSocket = DestroyableSocket> = {
  markTokenStale: (input: {
    wechatAccountId: string
    userId: string
    staleReason: string
  }) => Promise<unknown>
  appendDiagnostic: (event: BrokerMutationDiagnosticEvent) => Promise<void>
  getLiveRegistration: (instanceID: string) => LiveRegistration<TSocket> | undefined
  deliverFallbackToast: (input: {
    instanceID: string
    registration: LiveRegistration<TSocket>
    payload: ShowFallbackToastPayload
  }) => Promise<void> | void
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }
  return new Error(String(value))
}

export type BrokerMutationQueue = {
  enqueue: <T>(mutationType: string, task: () => Promise<T>) => Promise<T>
  drain: () => Promise<void>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function createBrokerMutationQueue(): BrokerMutationQueue {
  let chain: Promise<void> = Promise.resolve()

  return {
    enqueue<T>(_mutationType: string, task: () => Promise<T>): Promise<T> {
      const next = chain.then(task)
      chain = next.then(() => undefined, () => undefined)
      return next
    },
    drain(): Promise<void> {
      return chain
    },
  }
}

export async function executeFallbackToastMutation<TSocket extends DestroyableSocket = DestroyableSocket>(
  mutation: FallbackToastMutation,
  deps: ExecuteFallbackToastMutationDeps<TSocket>,
): Promise<void> {
  await Promise.resolve(deps.markTokenStale({
    wechatAccountId: mutation.wechatAccountId,
    userId: mutation.userId,
    staleReason: NOTIFICATION_DELIVERY_FAILED_STALE_REASON,
  })).catch(() => {})

  const liveRegistration = deps.getLiveRegistration(mutation.instanceID)
  const registrationEpoch = mutation.registrationEpoch
  const canDeliver =
    liveRegistration
    && liveRegistration.socket.destroyed !== true
    && isNonEmptyString(registrationEpoch)
    && liveRegistration.registrationEpoch === registrationEpoch

  if (!canDeliver) {
    await deps.appendDiagnostic({
      type: "fallbackToastDropped",
      code: "fallbackToastDropped",
      instanceID: mutation.instanceID,
      reason: mutation.reason,
      ...(isNonEmptyString(registrationEpoch) ? { registrationEpoch } : {}),
      ...(liveRegistration ? { liveRegistrationEpoch: liveRegistration.registrationEpoch } : {}),
    })
    return
  }

  const payload: ShowFallbackToastPayload = {
    wechatAccountId: mutation.wechatAccountId,
    userId: mutation.userId,
    message: mutation.message,
    reason: mutation.reason,
    registrationEpoch,
  }

  await deps.appendDiagnostic({
    type: "showFallbackToast",
    code: "showFallbackToast",
    instanceID: mutation.instanceID,
    reason: mutation.reason,
    registrationEpoch,
    liveRegistrationEpoch: liveRegistration.registrationEpoch,
  })

  await Promise.resolve(deps.deliverFallbackToast({
    instanceID: mutation.instanceID,
    registration: liveRegistration,
    payload,
  }))
}

export async function executeRecoveryMutation(
  mutation: RecoveryMutation,
  deps: ExecuteRecoveryMutationDeps,
): Promise<RecoveryMutationResult> {
  const revalidated = await deps.revalidate(mutation)
  if (revalidated) {
    return revalidated
  }

  const recoveredAt = deps.now?.() ?? Date.now()
  let preparedRecovery: PreparedRecoveryRequestReopen | undefined

  try {
    preparedRecovery = await deps.prepareFreshRecovery(mutation, recoveredAt)
    await deps.suppressPendingNotifications(mutation)
    const recovered = await deps.commitPreparedRecovery(preparedRecovery, mutation)
    await deps.testHooks?.afterReopenRequest?.(mutation)
    await deps.markRecovered({
      kind: mutation.deadLetter.kind,
      routeKey: mutation.deadLetter.routeKey,
      recoveredAt,
    })
    return {
      ok: true,
      recovered,
    }
  } catch (error) {
    const failure = deps.mapFailure(error)
    let rollbackError: Error | undefined
    let markFailedError: Error | undefined

    if (preparedRecovery) {
      try {
        await deps.rollbackPreparedRecovery(preparedRecovery, mutation)
      } catch (rollbackFailure) {
        rollbackError = toError(rollbackFailure)
      }
    }

    try {
      await deps.markFailed({
        kind: mutation.deadLetter.kind,
        routeKey: mutation.deadLetter.routeKey,
        failure,
      })
    } catch (persistFailure) {
      markFailedError = toError(persistFailure)
    }

    if (rollbackError && markFailedError) {
      throw new Error(
        `recovery rollback failed: ${rollbackError.message}; recovery failed metadata persistence failed: ${markFailedError.message}`,
      )
    }
    if (rollbackError) {
      throw rollbackError
    }
    if (markFailedError) {
      throw markFailedError
    }

    return {
      ok: false,
      message: failure.recoveryErrorMessage,
    }
  }
}
