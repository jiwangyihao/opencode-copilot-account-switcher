import {
  loadOpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpersLoaderOptions,
  type PublicWeixinMessage,
} from "./compat/openclaw-public-helpers.js"
import { STAGE_A_SLASH_ONLY_MESSAGE } from "./compat/slash-guard.js"
import { parseWechatSlashCommand, type WechatSlashCommand } from "./command-parser.js"
import { redactDebugBundleText } from "./debug-bundle-redaction.js"
import { upsertInboundToken, type TokenSource } from "./token-store.js"

const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_LONG_POLL_TIMEOUT_MS = 25_000
const MAX_HELPER_FAILURE_BACKOFF_MS = 30_000

export const DEFAULT_NON_SLASH_REPLY_TEXT = STAGE_A_SLASH_ONLY_MESSAGE
export const DEFAULT_SLASH_HANDLER_ERROR_REPLY_TEXT = "命令处理失败，请稍后重试。"

type RuntimeErrorStage =
  | "loadPublicHelpers"
  | "getUpdates"
  | "persistGetUpdatesBuf"
  | "drainOutboundMessages"
  | "sendReplyMessage"

type HelperFailureRetryState = "backing-off"

type HelperFailureState = {
  stage: "loadPublicHelpers"
  consecutiveFailures: number
  currentBackoffMs: number
  retryState: HelperFailureRetryState
  reachedGetUpdates: false
  lastFailureAtMs: number
  nextRetryAtMs: number
}

type LoadPublicHelpersRuntimeErrorDiagnostic = {
  type: "runtimeError"
  stage: "loadPublicHelpers"
  error: string
  consecutiveFailures: number
  backoffMs: number
  retryState: HelperFailureRetryState
  reachedGetUpdates: false
}

type ReachedGetUpdatesRuntimeErrorDiagnostic = {
  type: "runtimeError"
  stage: Exclude<RuntimeErrorStage, "loadPublicHelpers">
  error: string
  reachedGetUpdates: true
}

type PublicHelpersForRuntime = Pick<
  OpenClawWeixinPublicHelpers,
  "latestAccountState" | "getUpdates" | "sendMessageWeixin" | "persistGetUpdatesBuf"
>

type SlashCommandHandlerInput = {
  command: WechatSlashCommand
  text: string
  message: PublicWeixinMessage
}

type RuntimeSendMessageInput = {
  to: string
  text: string
  contextToken?: string
}

type RuntimeDrainOutboundMessagesInput = {
  sendMessage: (input: RuntimeSendMessageInput) => Promise<void>
}

type InitializedRuntimeState = {
  helpers: PublicHelpersForRuntime
  accountId: string
  baseUrl: string
  token: string
  getUpdatesBuf: string
}

export type WechatStatusRuntimeDiagnosticEvent =
  | LoadPublicHelpersRuntimeErrorDiagnostic
  | ReachedGetUpdatesRuntimeErrorDiagnostic
  | {
      type: "messageSkipped"
      reason: "missingFromUserId" | "missingText"
      hasFromUserId: boolean
      hasText: boolean
    }
  | {
      type: "slashCommandRecognized"
      command: WechatSlashCommand
      text: string
      to: string
    }
  | {
      type: "replySendFailed"
      to: string
      error: string
      commandType: WechatSlashCommand["type"] | null
    }

type CreateWechatStatusRuntimeInput = {
  loadPublicHelpers?: (options?: OpenClawWeixinPublicHelpersLoaderOptions) => Promise<PublicHelpersForRuntime>
  publicHelpersOptions?: OpenClawWeixinPublicHelpersLoaderOptions
  onSlashCommand?: (input: SlashCommandHandlerInput) => Promise<string>
  onRuntimeError?: (error: unknown) => void
  onDiagnosticEvent?: (event: WechatStatusRuntimeDiagnosticEvent) => void | Promise<void>
  drainOutboundMessages?: (input: RuntimeDrainOutboundMessagesInput) => Promise<void>
  retryDelayMs?: number
  longPollTimeoutMs?: number
  now?: () => number
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>
  onFailureStateChange?: (state: HelperFailureState | null) => void | Promise<void>
  shouldReloadState?: (state: {
    accountId: string
    baseUrl: string
    token: string
    getUpdatesBuf: string
  }) => boolean
}

export type WechatStatusRuntime = {
  start: () => Promise<void>
  close: () => Promise<void>
  getDebugFailureStateForTest: () => {
    helperFailureState: HelperFailureState | null
    retainedFailureObjectCount: number
  }
}

function createAbortError(): Error {
  const error = new Error("wechat status runtime stopped")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(createAbortError())
    }

    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(createAbortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function computeHelperFailureBackoffMs(retryDelayMs: number, consecutiveFailures: number): number {
  return Math.min(retryDelayMs * 2 ** Math.max(0, consecutiveFailures - 1), MAX_HELPER_FAILURE_BACKOFF_MS)
}

function cloneHelperFailureState(state: HelperFailureState | null): HelperFailureState | null {
  if (!state) {
    return null
  }
  return { ...state }
}

function extractMessageText(message: PublicWeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item?.type !== 1) {
      continue
    }
    if (typeof item.text_item?.text === "string" && item.text_item.text.trim().length > 0) {
      return item.text_item.text
    }
  }
  return ""
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

function sanitizeRuntimeDiagnosticError(error: string): string {
  return redactDebugBundleText(error, "diagnostics/wechat-status-runtime.runtime-error.txt")
}

function toRuntimeDiagnosticError(error: unknown): string {
  return sanitizeRuntimeDiagnosticError(toErrorMessage(error))
}

function toInboundTokenSource(command: WechatSlashCommand | null): TokenSource {
  if (command?.type === "reply") {
    return "question"
  }
  if (command?.type === "allow") {
    return "permission"
  }
  return "message"
}

export function createWechatStatusRuntime(input: CreateWechatStatusRuntimeInput = {}): WechatStatusRuntime {
  const loadPublicHelpers = input.loadPublicHelpers ?? loadOpenClawWeixinPublicHelpers
  const onSlashCommand =
    input.onSlashCommand ??
    (async () => {
      return "/status 处理中"
    })
  const onRuntimeError = input.onRuntimeError ?? (() => {})
  const onDiagnosticEvent = input.onDiagnosticEvent ?? (() => {})
  const retryDelayMs = normalizePositiveInteger(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS)
  const longPollTimeoutMs = normalizePositiveInteger(input.longPollTimeoutMs, DEFAULT_LONG_POLL_TIMEOUT_MS)
  const now = input.now ?? Date.now
  const sleepImpl = input.sleepImpl ?? sleep
  const onFailureStateChange = input.onFailureStateChange ?? (() => {})
  const shouldReloadState = input.shouldReloadState ?? (() => false)
  const drainOutboundMessages = input.drainOutboundMessages

  let started = false
  let closed = false
  let stopController: AbortController | null = null
  let pollingTask: Promise<void> | null = null
  let outboundDrainTask: Promise<void> | null = null
  let helperFailureState: HelperFailureState | null = null
  let activeRuntimeState: InitializedRuntimeState | null = null
  let inFlightDrain: Promise<void> | null = null

  const retainedHelperFailureObjects = new Set<object>()

  const emitDiagnosticEvent = (event: WechatStatusRuntimeDiagnosticEvent) => {
    void Promise.resolve()
      .then(() => onDiagnosticEvent(event))
      .catch((error) => {
        onRuntimeError(error)
      })
  }

  const emitFailureStateChange = (state: HelperFailureState | null) => {
    const snapshot = cloneHelperFailureState(state)
    void Promise.resolve()
      .then(() => onFailureStateChange(snapshot))
      .catch((error) => {
        onRuntimeError(error)
      })
  }

  const replaceHelperFailureState = (nextState: HelperFailureState | null) => {
    if (helperFailureState) {
      retainedHelperFailureObjects.delete(helperFailureState)
    }
    helperFailureState = nextState
    if (helperFailureState) {
      retainedHelperFailureObjects.add(helperFailureState)
    }
    emitFailureStateChange(helperFailureState)
  }

  const clearHelperFailureState = () => {
    if (!helperFailureState && retainedHelperFailureObjects.size === 0) {
      return
    }
    replaceHelperFailureState(null)
  }

  const drainOutboundWithState = async (initialized: InitializedRuntimeState, signal: AbortSignal) => {
    if (!drainOutboundMessages) {
      return
    }
    await withAbort(
      drainOutboundMessages({
        sendMessage: async (message) => {
          await initialized.helpers.sendMessageWeixin({
            to: message.to,
            text: message.text,
            opts: {
              baseUrl: initialized.baseUrl,
              token: initialized.token,
              ...(typeof message.contextToken === "string" && message.contextToken.trim().length > 0
                ? { contextToken: message.contextToken }
                : {}),
            },
          })
        },
      }),
      signal,
    )
  }

  const drainCurrentOutboundMessages = async (signal: AbortSignal) => {
    if (!drainOutboundMessages || !activeRuntimeState) {
      return
    }
    if (inFlightDrain) {
      return inFlightDrain
    }
    const currentState = activeRuntimeState
    const currentDrain = drainOutboundWithState(currentState, signal)
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }
        emitRuntimeErrorDiagnostic("drainOutboundMessages", error)
        onRuntimeError(error)
      })
      .finally(() => {
        if (inFlightDrain === currentDrain) {
          inFlightDrain = null
        }
      })
    inFlightDrain = currentDrain
    return currentDrain
  }

  const pollOutboundMessages = async (signal: AbortSignal) => {
    if (!drainOutboundMessages) {
      return
    }
    while (!signal.aborted) {
      await drainCurrentOutboundMessages(signal)
      try {
        await sleepImpl(retryDelayMs, signal)
      } catch (error) {
        if (isAbortError(error)) {
          return
        }
        onRuntimeError(error)
      }
    }
  }

  const noteLoadPublicHelpersFailure = (): HelperFailureState => {
    const consecutiveFailures = (helperFailureState?.consecutiveFailures ?? 0) + 1
    const currentBackoffMs = computeHelperFailureBackoffMs(retryDelayMs, consecutiveFailures)
    const lastFailureAtMs = now()
    const nextState: HelperFailureState = {
      stage: "loadPublicHelpers",
      consecutiveFailures,
      currentBackoffMs,
      retryState: "backing-off",
      reachedGetUpdates: false,
      lastFailureAtMs,
      nextRetryAtMs: lastFailureAtMs + currentBackoffMs,
    }
    replaceHelperFailureState(nextState)
    return nextState
  }

  const emitRuntimeErrorDiagnostic = (
    stage: RuntimeErrorStage,
    error: unknown,
    options?: {
      consecutiveFailures?: number
      backoffMs?: number
      retryState?: HelperFailureRetryState
      reachedGetUpdates?: boolean
    },
  ) => {
    const runtimeError = toRuntimeDiagnosticError(error)
    if (stage === "loadPublicHelpers") {
      emitDiagnosticEvent({
        type: "runtimeError",
        stage,
        error: runtimeError,
        consecutiveFailures: options?.consecutiveFailures ?? 1,
        backoffMs: options?.backoffMs ?? retryDelayMs,
        retryState: options?.retryState ?? "backing-off",
        reachedGetUpdates: false,
      })
      return
    }
    emitDiagnosticEvent({
      type: "runtimeError",
      stage,
      error: runtimeError,
      reachedGetUpdates: true,
    })
  }

  const poll = async (signal: AbortSignal) => {
    let initialized: InitializedRuntimeState | null = null

    while (!signal.aborted) {
      let nextRetryDelayMs = retryDelayMs
      try {
        let justInitialized = false
        if (!initialized) {
          try {
            const helpers = await withAbort(loadPublicHelpers(input.publicHelpersOptions), signal)
            const latestAccountState = helpers.latestAccountState
            if (!latestAccountState) {
              throw new Error("missing wechat account state")
            }
            initialized = {
              helpers,
              accountId: latestAccountState.accountId,
              baseUrl: latestAccountState.baseUrl,
              token: latestAccountState.token,
              getUpdatesBuf: typeof latestAccountState.getUpdatesBuf === "string" ? latestAccountState.getUpdatesBuf : "",
            }
            activeRuntimeState = initialized
            clearHelperFailureState()
            justInitialized = true
          } catch (error) {
            if (isAbortError(error)) {
              return
            }
            const failureState = noteLoadPublicHelpersFailure()
            nextRetryDelayMs = failureState.currentBackoffMs
            emitRuntimeErrorDiagnostic("loadPublicHelpers", error, {
              consecutiveFailures: failureState.consecutiveFailures,
              backoffMs: failureState.currentBackoffMs,
              retryState: failureState.retryState,
            })
            throw error
          }
        }

        if (!justInitialized && initialized && shouldReloadState({
          accountId: initialized.accountId,
          baseUrl: initialized.baseUrl,
          token: initialized.token,
          getUpdatesBuf: initialized.getUpdatesBuf,
        })) {
          initialized = null
          activeRuntimeState = null
          continue
        }

        let response: Awaited<ReturnType<PublicHelpersForRuntime["getUpdates"]>>
        try {
          response = await withAbort(
            initialized.helpers.getUpdates({
              baseUrl: initialized.baseUrl,
              token: initialized.token,
              get_updates_buf: initialized.getUpdatesBuf,
              timeoutMs: longPollTimeoutMs,
            }),
            signal,
          )
        } catch (error) {
          if (isAbortError(error)) {
            return
          }
          emitRuntimeErrorDiagnostic("getUpdates", error)
          throw error
        }

        // 语义锁定：一旦服务端返回新的 get_updates_buf，立即推进游标；
        // 后续轮询即便失败，也不会回滚到旧 buf。
        if (typeof response.get_updates_buf === "string") {
          initialized.getUpdatesBuf = response.get_updates_buf
          if (typeof initialized.helpers.persistGetUpdatesBuf === "function") {
            try {
              await withAbort(
                initialized.helpers.persistGetUpdatesBuf({
                  accountId: initialized.accountId,
                  getUpdatesBuf: response.get_updates_buf,
                }),
                signal,
              )
            } catch (error) {
              if (isAbortError(error)) {
                return
              }
            emitRuntimeErrorDiagnostic("persistGetUpdatesBuf", error)
            onRuntimeError(error)
          }
          }
        }

        const messages = Array.isArray(response.msgs) ? response.msgs : []

        await drainCurrentOutboundMessages(signal)

        for (const message of messages) {
          if (signal.aborted) {
            return
          }

          const to = toNonEmptyString(message.from_user_id)
          const text = extractMessageText(message)
          const hasText = text.trim().length > 0
          if (!to) {
            emitDiagnosticEvent({
              type: "messageSkipped",
              reason: "missingFromUserId",
              hasFromUserId: false,
              hasText,
            })
            continue
          }
          if (!hasText) {
            emitDiagnosticEvent({
              type: "messageSkipped",
              reason: "missingText",
              hasFromUserId: true,
              hasText: false,
            })
            continue
          }

          const parsedCommand = parseWechatSlashCommand(text)
          const inboundContextToken = toNonEmptyString(message.context_token) ?? undefined

          let replyText = DEFAULT_NON_SLASH_REPLY_TEXT

          if (parsedCommand) {
            if (inboundContextToken) {
              try {
                await upsertInboundToken({
                  wechatAccountId: initialized.accountId,
                  userId: to,
                  contextToken: inboundContextToken,
                  updatedAt: Date.now(),
                  source: toInboundTokenSource(parsedCommand),
                })
              } catch (error) {
                onRuntimeError(error)
              }
            }
            emitDiagnosticEvent({
              type: "slashCommandRecognized",
              command: parsedCommand,
              text,
              to,
            })
            try {
              replyText = await onSlashCommand({
                command: parsedCommand,
                text,
                message,
              })
            } catch (error) {
              onRuntimeError(error)
              replyText = DEFAULT_SLASH_HANDLER_ERROR_REPLY_TEXT
            }
          }

          try {
            await withAbort(
              initialized.helpers.sendMessageWeixin({
                to,
                text: replyText,
                opts: {
                  baseUrl: initialized.baseUrl,
                  token: initialized.token,
                  contextToken: toNonEmptyString(message.context_token) ?? undefined,
                },
              }),
              signal,
            )
          } catch (error) {
            if (isAbortError(error)) {
              return
            }
            emitDiagnosticEvent({
              type: "replySendFailed",
              to,
              error: toErrorMessage(error),
              commandType: parsedCommand?.type ?? null,
            })
            emitRuntimeErrorDiagnostic("sendReplyMessage", error)
            onRuntimeError(error)
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          return
        }
        onRuntimeError(error)
        if (signal.aborted || closed) {
          return
        }
        try {
          await sleepImpl(nextRetryDelayMs, signal)
        } catch (sleepError) {
          if (isAbortError(sleepError)) {
            return
          }
          onRuntimeError(sleepError)
        }
      }
    }
  }

  return {
    start: async () => {
      if (started) {
        return
      }
      clearHelperFailureState()
      started = true
      closed = false
      const controller = new AbortController()
      stopController = controller
      pollingTask = poll(controller.signal)
      outboundDrainTask = pollOutboundMessages(controller.signal)
    },
    close: async () => {
      if (!started) {
        clearHelperFailureState()
        return
      }
      closed = true
      started = false

      const controller = stopController
      stopController = null
      controller?.abort()

      const task = pollingTask
      pollingTask = null
      const drainTask = outboundDrainTask
      outboundDrainTask = null
      if (task) {
        await task.catch(() => {})
      }
      if (drainTask) {
        await drainTask.catch(() => {})
      }
      activeRuntimeState = null
      inFlightDrain = null
      clearHelperFailureState()
    },
    getDebugFailureStateForTest: () => {
      return {
        helperFailureState: cloneHelperFailureState(helperFailureState),
        retainedFailureObjectCount: retainedHelperFailureObjects.size,
      }
    },
  }
}
