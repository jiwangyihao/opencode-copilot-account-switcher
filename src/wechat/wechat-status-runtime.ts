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

export const DEFAULT_NON_SLASH_REPLY_TEXT = STAGE_A_SLASH_ONLY_MESSAGE
export const DEFAULT_SLASH_HANDLER_ERROR_REPLY_TEXT = "命令处理失败，请稍后重试。"

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

export type WechatStatusRuntimeDiagnosticEvent =
  | {
      type: "runtimeError"
      stage:
        | "loadPublicHelpers"
        | "getUpdates"
        | "persistGetUpdatesBuf"
        | "drainOutboundMessages"
        | "sendReplyMessage"
      error: string
    }
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
  const shouldReloadState = input.shouldReloadState ?? (() => false)
  const drainOutboundMessages = input.drainOutboundMessages

  let started = false
  let closed = false
  let stopController: AbortController | null = null
  let pollingTask: Promise<void> | null = null

  const emitDiagnosticEvent = (event: WechatStatusRuntimeDiagnosticEvent) => {
    void Promise.resolve()
      .then(() => onDiagnosticEvent(event))
      .catch((error) => {
        onRuntimeError(error)
      })
  }

  const emitRuntimeErrorDiagnostic = (
    stage:
      | "loadPublicHelpers"
      | "getUpdates"
      | "persistGetUpdatesBuf"
      | "drainOutboundMessages"
      | "sendReplyMessage",
    error: unknown,
  ) => {
    emitDiagnosticEvent({
      type: "runtimeError",
      stage,
      error: toRuntimeDiagnosticError(error),
    })
  }

  const poll = async (signal: AbortSignal) => {
    let initialized: {
      helpers: PublicHelpersForRuntime
      accountId: string
      baseUrl: string
      token: string
      getUpdatesBuf: string
    } | null = null

    while (!signal.aborted) {
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
            justInitialized = true
          } catch (error) {
            if (isAbortError(error)) {
              return
            }
            emitRuntimeErrorDiagnostic("loadPublicHelpers", error)
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

        if (drainOutboundMessages && initialized) {
          const runtimeState = initialized
          try {
            await withAbort(
              drainOutboundMessages({
                sendMessage: async (message) => {
                  await runtimeState.helpers.sendMessageWeixin({
                    to: message.to,
                    text: message.text,
                    opts: {
                      baseUrl: runtimeState.baseUrl,
                      token: runtimeState.token,
                      ...(typeof message.contextToken === "string" && message.contextToken.trim().length > 0
                        ? { contextToken: message.contextToken }
                        : {}),
                    },
                  })
                },
              }),
              signal,
            )
          } catch (error) {
            if (isAbortError(error)) {
              return
            }
            emitRuntimeErrorDiagnostic("drainOutboundMessages", error)
            onRuntimeError(error)
          }
        }

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
          await sleep(retryDelayMs, signal)
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
      started = true
      closed = false
      const controller = new AbortController()
      stopController = controller
      pollingTask = poll(controller.signal)
    },
    close: async () => {
      if (!started) {
        return
      }
      closed = true
      started = false

      const controller = stopController
      stopController = null
      controller?.abort()

      const task = pollingTask
      pollingTask = null
      if (task) {
        await task.catch(() => {})
      }
    },
  }
}
