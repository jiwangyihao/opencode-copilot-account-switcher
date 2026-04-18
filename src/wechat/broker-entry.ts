import path from "node:path"
import process from "node:process"
import { readFileSync, rmSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { QuestionAnswer } from "@opencode-ai/sdk/v2"
import { startBrokerServer } from "./broker-server.js"
import { WECHAT_FILE_MODE, wechatStateRoot, wechatStatusRuntimeDiagnosticsPath } from "./state-paths.js"
import {
  createWechatStatusRuntime,
  type WechatStatusRuntime,
  type WechatStatusRuntimeDiagnosticEvent,
} from "./wechat-status-runtime.js"
import {
  createWechatNotificationDispatcher,
  suppressPreparedPendingNotifications,
  type WechatNotificationDeliveryFailureInput,
  type WechatNotificationSendInput,
} from "./notification-dispatcher.js"
import type { WechatSlashCommand } from "./command-parser.js"
import {
  listDeadLettersByHandle,
  listRecoverableDeadLettersByHandle,
  listRecoveryChainHandles,
  markDeadLetterRecoveryFailed,
  markDeadLetterRecovered,
  readDeadLetter,
  writeDeadLetter,
} from "./dead-letter-store.js"
import {
  commitPreparedRecoveryRequestReopen,
  findRequestByRouteKey,
  findOpenRequestByHandle,
  markRequestAnswered,
  markRequestRejected,
  prepareRecoveryRequestReopen,
  rollbackPreparedRecoveryRequestReopen,
} from "./request-store.js"
import {
  findSentNotificationByRequest,
  listPendingNotifications,
  markNotificationResolved,
} from "./notification-store.js"
import {
  createBrokerMutationQueue,
  executeRecoveryMutation,
  type BrokerMutationQueue,
  type RecoveryMutation,
} from "./broker-mutation-queue.js"
import { buildQuestionAnswersFromReply } from "./question-interaction.js"

type ReplyMutationResult = {
  mutationId: string
  ok: boolean
  errorMessage?: string
}

type BrokerState = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

const BROKER_WECHAT_RUNTIME_AUTOSTART_DELAY_MS = 1_000
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_BROKER_IDLE_SCAN_INTERVAL_MS = 1_000
const DEFAULT_BROKER_OWNERSHIP_SCAN_INTERVAL_MS = 1_000

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = new URL("../../package.json", import.meta.url)
  return readFile(packageJsonPath, "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw) as { version?: unknown }
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version
      }
      return "unknown"
    })
    .catch(() => "unknown")
}

function parseEndpointArg(argv: string[]): string {
  const prefix = "--endpoint="
  const endpointArg = argv.find((item) => item.startsWith(prefix))
  if (!endpointArg) {
    throw new Error("missing --endpoint argument")
  }
  const endpoint = endpointArg.slice(prefix.length)
  if (!endpoint) {
    throw new Error("missing --endpoint argument")
  }
  return endpoint
}

function parseStateRootArg(argv: string[]): string {
  const prefix = "--state-root="
  const arg = argv.find((item) => item.startsWith(prefix))
  if (!arg) {
    return wechatStateRoot()
  }

  const stateRoot = arg.slice(prefix.length)
  if (!stateRoot) {
    throw new Error("missing --state-root argument")
  }
  return stateRoot
}

function brokerStatePathForRoot(stateRoot: string): string {
  return path.join(stateRoot, "broker.json")
}

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

async function writeBrokerState(state: BrokerState, stateRoot: string) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const filePath = brokerStatePathForRoot(stateRoot)
  await writeFile(filePath, JSON.stringify(state, null, 2), { mode: WECHAT_FILE_MODE })
}

type BrokerOwnership = Pick<BrokerState, "pid" | "startedAt" | "version" | "endpoint">

function isBrokerStateOwnedBy(candidate: Partial<BrokerState>, ownership: BrokerOwnership) {
  return candidate.pid === ownership.pid
    && candidate.startedAt === ownership.startedAt
    && candidate.version === ownership.version
    && candidate.endpoint === ownership.endpoint
}

async function brokerStateStillOwnedBy(input: { stateRoot: string } & BrokerOwnership): Promise<boolean | undefined> {
  try {
    const raw = await readFile(brokerStatePathForRoot(input.stateRoot), "utf8")
    const parsed = JSON.parse(raw) as Partial<BrokerState>
    return isBrokerStateOwnedBy(parsed, input)
  } catch {
    return undefined
  }
}

function shouldExitForLostBrokerOwnership(input: {
  ownerEstablished: boolean
  stillOwned: boolean | undefined
}): boolean {
  return input.ownerEstablished && input.stillOwned === false
}

type BrokerWechatStatusRuntimeLifecycle = {
  start: () => Promise<void>
  close: () => Promise<void>
}

type BrokerWechatStatusRuntimeLifecycleDeps = {
  createStatusRuntime?: (deps: {
    onSlashCommand: (input: { command: import("./command-parser.js").WechatSlashCommand }) => Promise<string>
    onDiagnosticEvent: (event: WechatStatusRuntimeDiagnosticEvent) => void | Promise<void>
    drainOutboundMessages: (input?: {
      sendMessage: (input: WechatNotificationSendInput) => Promise<void>
    }) => Promise<void>
  }) => WechatStatusRuntime
  createNotificationDispatcher?: (input: {
    sendMessage: (input: WechatNotificationSendInput) => Promise<void>
    onDeliveryFailed?: (input: WechatNotificationDeliveryFailureInput) => Promise<void>
  }) => {
    drainOutboundMessages: () => Promise<void>
  }
  handleWechatSlashCommand?: (command: import("./command-parser.js").WechatSlashCommand) => Promise<string>
  sendReplyQuestionRpc?: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    answers: QuestionAnswer[]
  }) => Promise<ReplyMutationResult>
  sendReplyPermissionRpc?: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
  }) => Promise<ReplyMutationResult>
  handleNotificationDeliveryFailure?: (input: {
    instanceID: string
    wechatAccountId: string
    userId: string
    registrationEpoch?: string
  }) => Promise<void>
  onRuntimeError?: (error: unknown) => void
  onDiagnosticEvent?: (event: WechatStatusRuntimeDiagnosticEvent) => void | Promise<void>
  stateRoot?: string
}

function createWechatStatusRuntimeDiagnosticsFileWriter(input: {
  stateRoot: string
  onRuntimeError: (error: unknown) => void
}): (event: WechatStatusRuntimeDiagnosticEvent) => Promise<void> {
  return async (event) => {
    try {
      await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
      const filePath = wechatStatusRuntimeDiagnosticsPath(input.stateRoot)
      const line = `${JSON.stringify({
        timestamp: Date.now(),
        ...event,
      })}\n`
      await appendFile(filePath, line, { encoding: "utf8", mode: WECHAT_FILE_MODE })
    } catch (error) {
      input.onRuntimeError(error)
    }
  }
}

export function shouldEnableBrokerWechatStatusRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  void env
  return true
}

type BrokerWechatSlashHandlerClient = {
  question?: {
    reply?: (input: { requestID: string; directory?: string; answers?: Array<QuestionAnswer> }) => Promise<unknown>
  }
  permission?: {
    reply?: (input: { requestID: string; directory?: string; reply?: "once" | "always" | "reject"; message?: string }) => Promise<unknown>
  }
}

type PermissionMutationTestHooks = {
  beforeFinalizePermission?: (request: {
    readonly routeKey: string
    readonly handle: string
  }) => Promise<void> | void
}

function withOptionalDirectory<T extends object>(input: T, directory: string | undefined): T & { directory?: string } {
  if (typeof directory === "string" && directory.trim().length > 0) {
    return {
      ...input,
      directory,
    }
  }
  return input
}

function isInvalidHandleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /invalid handle format|raw requestID cannot be used as handle/i.test(error.message)
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

function getSdkMutationError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined
  }
  const error = (result as { error?: unknown }).error
  if (!error) {
    return undefined
  }
  return toErrorMessage(error)
}

function createRecoveryFailureToken(): string {
  return `recovery-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const brokerEntryMutationQueue = createBrokerMutationQueue()

export function createBrokerWechatSlashCommandHandler(input: {
  handleStatusCommand: () => Promise<string>
  client?: BrokerWechatSlashHandlerClient
  sendReplyQuestionRpc?: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    answers: QuestionAnswer[]
  }) => Promise<ReplyMutationResult>
  sendReplyPermissionRpc?: (input: {
    instanceID: string
    mutationId: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
  }) => Promise<ReplyMutationResult>
  directory?: string
  mutationQueue?: BrokerMutationQueue
  markDeadLetterRecoveryFailedImpl?: typeof markDeadLetterRecoveryFailed
  permissionMutationTestHooks?: PermissionMutationTestHooks
  recoveryTestHooks?: {
    afterReopenRequest?: (mutation: RecoveryMutation) => Promise<void> | void
  }
}): (command: WechatSlashCommand) => Promise<string> {
  const mutationQueue = input.mutationQueue ?? brokerEntryMutationQueue
  const markDeadLetterRecoveryFailedImpl = input.markDeadLetterRecoveryFailedImpl ?? markDeadLetterRecoveryFailed

  const persistRecoveryFailureWrites = async (records: Array<{
    kind: "question" | "permission"
    routeKey: string
    recoveryErrorCode: string
    recoveryErrorMessage: string
  }>) => {
    const recoveryFailureToken = createRecoveryFailureToken()
    const originals = await Promise.all(records.map(async (record) => {
      const original = await readDeadLetter(record.kind, record.routeKey)
      if (!original) {
        throw new Error(`dead-letter missing during failure persistence: ${record.routeKey}`)
      }
      return original
    }))

    for (const record of records) {
      try {
        await markDeadLetterRecoveryFailedImpl({
          kind: record.kind,
          routeKey: record.routeKey,
          recoveryErrorCode: record.recoveryErrorCode,
          recoveryErrorMessage: record.recoveryErrorMessage,
          recoveryFailureToken,
        })
      } catch (error) {
        const rollbackErrors: string[] = []
        for (const original of originals) {
          try {
            const current = await readDeadLetter(original.kind, original.routeKey)
            if (!current || current.recoveryFailureToken !== recoveryFailureToken) {
              continue
            }
            await writeDeadLetter(original)
          } catch (rollbackError) {
            rollbackErrors.push(`${original.routeKey}: ${toErrorMessage(rollbackError)}`)
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `failed to persist recovery failure metadata and rollback prior updates: ${toErrorMessage(error)}; rollback errors: ${rollbackErrors.join("; ")}`,
          )
        }
        throw new Error(`failed to persist recovery failure metadata: ${toErrorMessage(error)}`)
      }
    }
  }

  const persistRecoveryFailure = async (records: Array<{
    kind: "question" | "permission"
    routeKey: string
  }>, recoveryErrorCode: string, recoveryErrorMessage: string) => {
    await persistRecoveryFailureWrites(records.map((record) => ({
      kind: record.kind,
      routeKey: record.routeKey,
      recoveryErrorCode,
      recoveryErrorMessage,
    })))
    return recoveryErrorMessage
  }

  const persistRecoveryFailures = async (records: Array<{
    kind: "question" | "permission"
    routeKey: string
    recoveryErrorCode: string
    recoveryErrorMessage: string
  }>) => {
    await persistRecoveryFailureWrites(records)
  }

  const classifyRecoveryHandle = async (handle: string) => {
    const matchedDeadLetters = await listDeadLettersByHandleSafely(handle)
    const classifiedMatches = await classifyMatchedDeadLetters(matchedDeadLetters)
    const recoverableMatches = classifiedMatches
      .filter((item): item is Extract<typeof item, { state: "valid" }> => item.state === "valid")
    const invalidMatches = classifiedMatches.filter(
      (item): item is Extract<typeof item, { state: "invalid" }> => item.state === "invalid",
    )

    return {
      matchedDeadLetters,
      classifiedMatches,
      recoverableMatches,
      invalidMatches,
    }
  }

  const createQueuedInvalidRecoveryResult = async (input: {
    handle: string
    invalidMatches: Array<Extract<Awaited<ReturnType<typeof classifyMatchedDeadLetters>>[number], { state: "invalid" }>>
  }) => {
    if (input.invalidMatches.length > 0) {
      await persistRecoveryFailures(input.invalidMatches.map((item) => ({
        kind: item.record.kind,
        routeKey: item.record.routeKey,
        recoveryErrorCode: item.failure.recoveryErrorCode,
        recoveryErrorMessage: item.failure.recoveryErrorMessage,
      })))
      if (input.invalidMatches.length === 1 && input.invalidMatches[0].returnDetailedMessage) {
        return {
          ok: false as const,
          message: input.invalidMatches[0].failure.recoveryErrorMessage,
        }
      }
    }

    return {
      ok: false as const,
      message: `未找到可恢复的请求：${input.handle}`,
    }
  }

  const findOpenRequestSafely = async (requestInput: {
    kind: "question" | "permission"
    handle: string
  }) => {
    try {
      return await findOpenRequestByHandle(requestInput)
    } catch (error) {
      if (isInvalidHandleError(error)) {
        return undefined
      }
      throw error
    }
  }

  const resolveNotificationForOpenRequest = async (request: {
    kind: "question" | "permission"
    routeKey: string
    handle: string
  }) => {
    try {
      const sentNotification = await findSentNotificationByRequest({
        kind: request.kind,
        routeKey: request.routeKey,
        handle: request.handle,
      })
      if (!sentNotification) {
        return
      }
      await markNotificationResolved({
        idempotencyKey: sentNotification.idempotencyKey,
        resolvedAt: Date.now(),
      })
    } catch {
      // best-effort only: notification resolve failure should not fail slash reply
    }
  }

  const listDeadLettersByHandleSafely = async (handle: string) => {
    try {
      return await listDeadLettersByHandle(handle)
    } catch (error) {
      if (isInvalidHandleError(error)) {
        return []
      }
      throw error
    }
  }

  const listRecoverableDeadLettersByHandleSafely = async (handle: string) => {
    try {
      return await listRecoverableDeadLettersByHandle(handle)
    } catch (error) {
      if (isInvalidHandleError(error)) {
        return []
      }
      throw error
    }
  }

  const mapRecoveryFailure = (handle: string, error: unknown): {
    recoveryErrorCode: string
    recoveryErrorMessage: string
  } => {
    if (error instanceof Error) {
      if (/request missing for recovery/i.test(error.message)) {
        return {
          recoveryErrorCode: "requestMissing",
          recoveryErrorMessage: `无法恢复请求，原始记录不存在：${handle}`,
        }
      }
      if (/request is not recoverable from current status/i.test(error.message)) {
        return {
          recoveryErrorCode: "requestNotRecoverable",
          recoveryErrorMessage: `无法恢复请求，原始记录状态不可恢复：${handle}`,
        }
      }
      if (/failed to allocate recovery routekey/i.test(error.message)) {
        return {
          recoveryErrorCode: "routeAllocationFailed",
          recoveryErrorMessage: `无法恢复请求，无法分配新的路由：${handle}`,
        }
      }
    }

    return {
      recoveryErrorCode: "recoveryFailed",
      recoveryErrorMessage: `无法恢复请求：${handle}`,
    }
  }

  const classifyMatchedDeadLetters = async (records: Awaited<ReturnType<typeof listDeadLettersByHandleSafely>>) => {
    const recoverableRouteKeys = new Set(
      (await Promise.resolve(records.length > 0 ? listRecoverableDeadLettersByHandleSafely(records[0].handle) : []))
        .map((record) => record.routeKey),
    )

    return Promise.all(records.map(async (record) => {
      if (record.recoveryStatus === "recovered") {
        return {
          state: "ignored" as const,
          record,
        }
      }
      if (!recoverableRouteKeys.has(record.routeKey)) {
        return {
          state: "invalid" as const,
          record,
          returnDetailedMessage: false,
          failure: {
            recoveryErrorCode: "deadLetterNotRecoverable",
            recoveryErrorMessage: `无法恢复请求，记录状态不可恢复：${record.handle}`,
          },
        }
      }

      const request = await findRequestByRouteKey({
        kind: record.kind,
        routeKey: record.routeKey,
      })
      if (!request) {
        return {
          state: "invalid" as const,
          record,
          returnDetailedMessage: true,
          failure: {
            recoveryErrorCode: "requestMissing",
            recoveryErrorMessage: `无法恢复请求，原始记录不存在：${record.handle}`,
          },
        }
      }
      if (request.status !== "expired" && request.status !== "cleaned") {
        return {
          state: "invalid" as const,
          record,
          returnDetailedMessage: true,
          failure: {
            recoveryErrorCode: "requestNotRecoverable",
            recoveryErrorMessage: `无法恢复请求，原始记录状态不可恢复：${record.handle}`,
          },
        }
      }
      return {
        state: "valid" as const,
        record,
        request,
      }
    }))
  }

  const prepareRecoveryMutation = async (handle: string): Promise<
    | { kind: "error"; message: string }
    | { kind: "ready"; mutation: RecoveryMutation }
  > => {
    const {
      matchedDeadLetters,
      recoverableMatches,
      invalidMatches,
    } = await classifyRecoveryHandle(handle)
    if (matchedDeadLetters.length === 0) {
      return {
        kind: "error",
        message: `未找到可恢复的请求：${handle}`,
      }
    }

    if (recoverableMatches.length === 0) {
      if (invalidMatches.length > 0) {
        await persistRecoveryFailures(invalidMatches.map((item) => ({
          kind: item.record.kind,
          routeKey: item.record.routeKey,
          recoveryErrorCode: item.failure.recoveryErrorCode,
          recoveryErrorMessage: item.failure.recoveryErrorMessage,
        })))
      }
      if (invalidMatches.length === 1 && invalidMatches[0].returnDetailedMessage) {
        return {
          kind: "error",
          message: invalidMatches[0].failure.recoveryErrorMessage,
        }
      }
      return {
        kind: "error",
        message: `未找到可恢复的请求：${handle}`,
      }
    }

    if (recoverableMatches.length > 1) {
      return {
        kind: "error",
        message: await persistRecoveryFailure(
          recoverableMatches.map((item) => item.record),
          "ambiguousHandle",
          `找到多个可恢复的请求：${handle}`,
        ),
      }
    }

    const recoverable = recoverableMatches[0]
    const excludedHandles = await listRecoveryChainHandles({
      kind: recoverable.record.kind,
      requestID: recoverable.record.requestID,
      wechatAccountId: recoverable.record.wechatAccountId,
      userId: recoverable.record.userId,
    })

    const pendingNotifications = (await listPendingNotifications())
      .filter((record) => record.kind === recoverable.record.kind && record.routeKey === recoverable.record.routeKey)

    return {
      kind: "ready",
      mutation: {
        type: "recoveryMutation",
        requestedHandle: handle,
        deadLetter: recoverable.record,
        originalRequest: recoverable.request,
        pendingNotifications,
        recoveryChainHandles: excludedHandles,
      },
    }
  }

  return async (command) => {
    if (command.type === "status") {
      return input.handleStatusCommand()
    }

    if (command.type === "reply") {
      const openQuestion = await findOpenRequestSafely({
        kind: "question",
        handle: command.handle,
      })
      if (!openQuestion) {
        return `未找到待回复问题：${command.handle}`
      }
      let answers: QuestionAnswer[]
      try {
        answers = buildQuestionAnswersFromReply(
          openQuestion.prompt && "mode" in openQuestion.prompt ? openQuestion.prompt : undefined,
          command.text,
        )
      } catch (error) {
        return error instanceof Error ? error.message : "问题回复格式无效"
      }
      const mutationId = `reply-question-${Date.now()}-${Math.random().toString(16).slice(2)}`
      let result: ReplyMutationResult
      if (input.sendReplyQuestionRpc) {
        if (!openQuestion.scopeKey) {
          return `回复问题失败：bridge unavailable`
        }
        try {
          result = await input.sendReplyQuestionRpc({
            instanceID: openQuestion.scopeKey,
            mutationId,
            requestID: openQuestion.requestID,
            answers,
          })
        } catch (error) {
          result = { mutationId, ok: false, errorMessage: toErrorMessage(error) }
        }
      } else {
        const replyResult = await input.client?.question?.reply?.(withOptionalDirectory({
          requestID: openQuestion.requestID,
          answers,
        }, input.directory))
        const replyError = getSdkMutationError(replyResult)
        result = replyError
          ? { mutationId, ok: false, errorMessage: replyError }
          : { mutationId, ok: true }
      }
      if (result.ok !== true) {
        return `回复问题失败：${result.errorMessage ?? "unknown"}`
      }
      await markRequestAnswered({
        kind: "question",
        routeKey: openQuestion.routeKey,
        answeredAt: Date.now(),
      })
      await resolveNotificationForOpenRequest(openQuestion)
      return `已回复问题：${openQuestion.handle}`
    }

    if (command.type === "recover") {
      const prepared = await prepareRecoveryMutation(command.handle)
      if (prepared.kind === "error") {
        return prepared.message
      }

      const result = await mutationQueue.enqueue("recoveryMutation", () => executeRecoveryMutation(prepared.mutation, {
        revalidate: async (mutation) => {
          const { recoverableMatches, invalidMatches } = await classifyRecoveryHandle(mutation.requestedHandle)
          if (recoverableMatches.length > 1) {
            return {
              ok: false,
              message: await persistRecoveryFailure(
                recoverableMatches.map((item) => item.record),
                "ambiguousHandle",
                `找到多个可恢复的请求：${mutation.requestedHandle}`,
              ),
            }
          }
          if (recoverableMatches.length === 0) {
            return createQueuedInvalidRecoveryResult({
              handle: mutation.requestedHandle,
              invalidMatches,
            })
          }
          if (recoverableMatches[0].record.routeKey !== mutation.deadLetter.routeKey) {
            return createQueuedInvalidRecoveryResult({
              handle: mutation.requestedHandle,
              invalidMatches,
            })
          }

          const currentDeadLetter = await readDeadLetter(mutation.deadLetter.kind, mutation.deadLetter.routeKey)
          if (
            !currentDeadLetter
            || currentDeadLetter.recoveryStatus === "recovered"
            || currentDeadLetter.reason !== "instanceStale"
            || !currentDeadLetter.wechatAccountId
            || !currentDeadLetter.userId
          ) {
            return {
              ok: false,
              message: `未找到可恢复的请求：${mutation.requestedHandle}`,
            }
          }

          const currentRequest = await findRequestByRouteKey({
            kind: mutation.originalRequest.kind,
            routeKey: mutation.originalRequest.routeKey,
          })
          if (!currentRequest) {
            throw new Error("request missing for recovery")
          }
          if (currentRequest.status !== "expired" && currentRequest.status !== "cleaned") {
            throw new Error("request is not recoverable from current status")
          }
          return undefined
        },
        suppressPendingNotifications: async (mutation) => {
          await suppressPreparedPendingNotifications(mutation.pendingNotifications)
        },
        prepareFreshRecovery: async (mutation, recoveredAt) => prepareRecoveryRequestReopen({
          kind: mutation.deadLetter.kind,
          routeKey: mutation.deadLetter.routeKey,
          recoveredAt,
          bannedHandles: mutation.recoveryChainHandles,
        }),
        commitPreparedRecovery: async (preparedRecovery) => commitPreparedRecoveryRequestReopen(preparedRecovery),
        rollbackPreparedRecovery: async (preparedRecovery) => rollbackPreparedRecoveryRequestReopen(preparedRecovery),
        markRecovered: async ({ kind, routeKey, recoveredAt }) => {
          await markDeadLetterRecovered({ kind, routeKey, recoveredAt })
        },
        markFailed: async ({ kind, routeKey, failure }) => {
          await markDeadLetterRecoveryFailed({
            kind,
            routeKey,
            recoveryErrorCode: failure.recoveryErrorCode,
            recoveryErrorMessage: failure.recoveryErrorMessage,
          })
        },
        mapFailure: (error) => mapRecoveryFailure(prepared.mutation.requestedHandle, error),
        testHooks: input.recoveryTestHooks,
      }))

      if (!result.ok) {
        return result.message
      }
      return `已恢复请求：${result.recovered.handle}`
    }

    const openPermission = await findOpenRequestSafely({
      kind: "permission",
      handle: command.handle,
    })
    if (!openPermission) {
      return `未找到待处理权限请求：${command.handle}`
    }
    const mutationId = `reply-permission-${Date.now()}-${Math.random().toString(16).slice(2)}`
    let result: ReplyMutationResult
    if (input.sendReplyPermissionRpc) {
      if (!openPermission.scopeKey) {
        return `处理权限请求失败：bridge unavailable`
      }
      try {
        result = await input.sendReplyPermissionRpc({
          instanceID: openPermission.scopeKey,
          mutationId,
          requestID: openPermission.requestID,
          reply: command.reply,
          ...(command.message ? { message: command.message } : {}),
        })
      } catch (error) {
        result = { mutationId, ok: false, errorMessage: toErrorMessage(error) }
      }
    } else {
      const permissionReplyResult = await input.client?.permission?.reply?.(withOptionalDirectory({
        requestID: openPermission.requestID,
        reply: command.reply,
        ...(command.message ? { message: command.message } : {}),
      }, input.directory))
      const permissionReplyError = getSdkMutationError(permissionReplyResult)
      result = permissionReplyError
        ? { mutationId, ok: false, errorMessage: permissionReplyError }
        : { mutationId, ok: true }
    }
    if (result.ok !== true) {
      return `处理权限请求失败：${result.errorMessage ?? "unknown"}`
    }
    await input.permissionMutationTestHooks?.beforeFinalizePermission?.({
      routeKey: openPermission.routeKey,
      handle: openPermission.handle,
    })
    if (command.reply === "reject") {
      await markRequestRejected({
        kind: "permission",
        routeKey: openPermission.routeKey,
        rejectedAt: Date.now(),
      })
    } else {
      await markRequestAnswered({
        kind: "permission",
        routeKey: openPermission.routeKey,
        answeredAt: Date.now(),
      })
    }
    await resolveNotificationForOpenRequest(openPermission)
    return `已处理权限请求：${openPermission.handle} (${command.reply})`
  }
}

export function createBrokerWechatStatusRuntimeLifecycle(
  deps: BrokerWechatStatusRuntimeLifecycleDeps = {},
): BrokerWechatStatusRuntimeLifecycle {
  const onRuntimeError = deps.onRuntimeError ?? ((error) => console.error(error))
  const stateRoot = deps.stateRoot ?? wechatStateRoot()
  const onDiagnosticEvent =
    deps.onDiagnosticEvent ?? createWechatStatusRuntimeDiagnosticsFileWriter({ stateRoot, onRuntimeError })
  const handleWechatSlashCommand = deps.handleWechatSlashCommand ?? createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "命令暂未实现：/status",
    sendReplyQuestionRpc: deps.sendReplyQuestionRpc,
    sendReplyPermissionRpc: deps.sendReplyPermissionRpc,
    directory: process.cwd(),
  })
  const createStatusRuntime =
    deps.createStatusRuntime ??
    ((statusRuntimeDeps) =>
      createWechatStatusRuntime({
        onSlashCommand: async ({ command }) => statusRuntimeDeps.onSlashCommand({ command }),
        onRuntimeError,
        onDiagnosticEvent: statusRuntimeDeps.onDiagnosticEvent,
        drainOutboundMessages: async (drainInput) => {
          await statusRuntimeDeps.drainOutboundMessages({
            sendMessage: async (message) => {
              await drainInput.sendMessage(message)
            },
          })
        },
      }))
  const createNotificationDispatcher = deps.createNotificationDispatcher ?? createWechatNotificationDispatcher

  let runtime: WechatStatusRuntime | null = null
  let dispatcher:
    | {
        drainOutboundMessages: () => Promise<void>
      }
    | null = null

  return {
    start: async () => {
      if (runtime) {
        return
      }
      let runtimeSendMessage:
        | ((input: WechatNotificationSendInput) => Promise<void>)
        | null = null
      dispatcher = createNotificationDispatcher({
        sendMessage: async (message) => {
          if (!runtimeSendMessage) {
            throw new Error("wechat runtime send helper unavailable")
          }
          await runtimeSendMessage(message)
        },
        onDeliveryFailed: async (failure) => {
          if (!deps.handleNotificationDeliveryFailure) {
            return
          }
          if (failure.kind === "sessionError") {
            return
          }
          const immutableScopeKey = typeof failure.scopeKey === "string" && failure.scopeKey.trim().length > 0
            ? failure.scopeKey
            : undefined
          const request = !immutableScopeKey && typeof failure.routeKey === "string" && failure.routeKey.trim().length > 0
            ? await findRequestByRouteKey({
                kind: failure.kind,
                routeKey: failure.routeKey,
              })
            : undefined
          const instanceID = immutableScopeKey ?? request?.scopeKey
          if (!instanceID) {
            return
          }

          await deps.handleNotificationDeliveryFailure({
            instanceID,
            wechatAccountId: failure.wechatAccountId,
            userId: failure.userId,
            registrationEpoch: failure.registrationEpoch,
          })
        },
      })
      const created = createStatusRuntime({
        onSlashCommand: async ({ command }) => handleWechatSlashCommand(command),
        onDiagnosticEvent,
        drainOutboundMessages: async (runtimeDrainInput) => {
          if (runtimeDrainInput?.sendMessage) {
            runtimeSendMessage = runtimeDrainInput.sendMessage
          }
          if (!dispatcher) {
            return
          }
          await dispatcher.drainOutboundMessages()
        },
      })
      runtime = created
      try {
        await created.start()
      } catch (error) {
        onRuntimeError(error)
      }
    },
    close: async () => {
      if (!runtime) {
        return
      }
      const active = runtime
      runtime = null
      dispatcher = null
      await active.close().catch((error) => {
        onRuntimeError(error)
      })
    },
  }
}

function removeOwnedBrokerStateFileSync(ownership: BrokerOwnership, stateRoot: string) {
  try {
    const filePath = brokerStatePathForRoot(stateRoot)
    const raw = readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<BrokerState>
    if (!isBrokerStateOwnedBy(parsed, ownership)) {
      return
    }

    rmSync(filePath, { force: true })
  } catch {
    // ignore cleanup errors on shutdown
  }
}

async function run() {
  const args = process.argv.slice(2)
  const endpoint = parseEndpointArg(args)
  const stateRoot = parseStateRootArg(args)
  process.env.WECHAT_STATE_ROOT_OVERRIDE = stateRoot
  const server = await startBrokerServer(endpoint)
  const version = await readPackageVersion()
  const state: BrokerState = {
    pid: process.pid,
    endpoint: server.endpoint,
    startedAt: server.startedAt,
    version,
  }

  await writeBrokerState(state, stateRoot)
  const wechatRuntimeLifecycle = createBrokerWechatStatusRuntimeLifecycle({
    handleWechatSlashCommand: createBrokerWechatSlashCommandHandler({
      handleStatusCommand: async () => server.handleWechatSlashCommand({ type: "status" }),
      sendReplyQuestionRpc: server.dispatchReplyQuestionToInstance,
      sendReplyPermissionRpc: server.dispatchReplyPermissionToInstance,
      directory: stateRoot,
    }),
    sendReplyQuestionRpc: server.dispatchReplyQuestionToInstance,
    sendReplyPermissionRpc: server.dispatchReplyPermissionToInstance,
    handleNotificationDeliveryFailure: server.handleNotificationDeliveryFailure,
  })
  const ownership: BrokerOwnership = {
    pid: state.pid,
    startedAt: state.startedAt,
    version: state.version,
    endpoint: state.endpoint,
  }
  const idleTimeoutMs = toPositiveNumber(process.env.WECHAT_BROKER_IDLE_TIMEOUT_MS, DEFAULT_BROKER_IDLE_TIMEOUT_MS)
  const idleScanIntervalMs = toPositiveNumber(process.env.WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS, DEFAULT_BROKER_IDLE_SCAN_INTERVAL_MS)
  const ownershipScanIntervalMs = toPositiveNumber(
    process.env.WECHAT_BROKER_OWNERSHIP_SCAN_INTERVAL_MS,
    DEFAULT_BROKER_OWNERSHIP_SCAN_INTERVAL_MS,
  )

  let shuttingDown = false
  const ownerEstablished = true
  let ownershipScanInFlight = false
  let runtimeStartTimer: NodeJS.Timeout | undefined
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    clearTimeout(runtimeStartTimer)
    clearInterval(idleTimer)
    clearInterval(ownershipTimer)
    removeOwnedBrokerStateFileSync(ownership, stateRoot)
    await wechatRuntimeLifecycle.close()
    await server.close()
    process.exit(exitCode)
  }

  const shutdownIfBrokerOwnershipLost = async (): Promise<boolean> => {
    const stillOwned = await brokerStateStillOwnedBy({
      stateRoot,
      ...ownership,
    })
    if (shuttingDown) {
      return true
    }

    if (!shouldExitForLostBrokerOwnership({
      ownerEstablished,
      stillOwned,
    })) {
      return false
    }

    await shutdown(0)
    return true
  }

  if (shouldEnableBrokerWechatStatusRuntime()) {
    runtimeStartTimer = setTimeout(() => {
      if (shuttingDown) {
        return
      }

      void shutdownIfBrokerOwnershipLost().then((ownershipLost) => {
        if (ownershipLost || shuttingDown) {
          return
        }
        void wechatRuntimeLifecycle.start()
      })
    }, BROKER_WECHAT_RUNTIME_AUTOSTART_DELAY_MS)
  }

  const ownershipTimer = setInterval(() => {
    if (!ownerEstablished || ownershipScanInFlight) {
      return
    }

    ownershipScanInFlight = true
    void shutdownIfBrokerOwnershipLost().finally(() => {
      ownershipScanInFlight = false
    })
  }, ownershipScanIntervalMs)

  let idleSince: number | undefined
  const idleTimer = setInterval(() => {
    void server.hasBlockingActivity().then((hasBlockingActivity) => {
      if (hasBlockingActivity) {
        idleSince = undefined
        return
      }

      const now = Date.now()
      if (idleSince === undefined) {
        idleSince = now
        return
      }

      if (now - idleSince >= idleTimeoutMs) {
        void shutdown(0)
      }
    }).catch(() => {})
  }, idleScanIntervalMs)

  process.once("SIGINT", () => {
    void shutdown(0)
  })
  process.once("SIGTERM", () => {
    void shutdown(0)
  })

  if (process.env.WECHAT_BROKER_EXIT_ON_STDIN_EOF === "1") {
    process.stdin.on("end", () => {
      void shutdown(0)
    })
    process.stdin.resume()
  }

  process.once("uncaughtException", (error) => {
    console.error(error)
    void shutdown(1)
  })
  process.once("unhandledRejection", (error) => {
    console.error(error)
    void shutdown(1)
  })

  process.on("exit", () => {
    removeOwnedBrokerStateFileSync(ownership, stateRoot)
  })
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false
  }
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectRun()) {
  void run().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
