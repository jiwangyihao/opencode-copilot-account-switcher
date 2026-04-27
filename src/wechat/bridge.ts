import type {
  Message,
  Part,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"
import { connect } from "./broker-client.js"
import { connectOrSpawnBroker } from "./broker-launcher.js"
import { WECHAT_FILE_MODE, wechatBridgeDiagnosticsPath } from "./state-paths.js"
import {
  buildSessionDigest,
  groupPermissionsBySession,
  groupQuestionsBySession,
  pickRecentSessions,
  type SessionDigest,
} from "./session-digest.js"
import { readOperatorBinding } from "./operator-store.js"
import { createHandle, createRouteKey, createSessionReplyHandle } from "./handle.js"
import type {
  BrokerToBridgeCommand,
  BrokerToBridgeControl,
  BridgeToBrokerEvent,
  BrokerEnvelope,
  ReplyMutationResult,
  ReplyNaturalStopPayload,
  ReplyPermissionPayload,
  ReplyQuestionPayload,
  WechatNotificationCandidate,
} from "./protocol.js"
import { extractPermissionPromptSummary, extractQuestionPromptSummary } from "./question-interaction.js"

type SessionMessages = Array<{ info: Message; parts: Part[] }>

type RequestNotificationCandidate = Extract<WechatNotificationCandidate, { kind: "question" | "permission" }>
type NaturalStopNotificationCandidate = Extract<WechatNotificationCandidate, { kind: "naturalStop" }>
type NotificationCandidateSnapshot = {
  candidates: WechatNotificationCandidate[]
  authoritative: boolean
}

function indexRequestCandidates(candidates: WechatNotificationCandidate[], kind: "question" | "permission") {
  const indexed = new Map<string, RequestNotificationCandidate>()
  for (const candidate of candidates) {
    if (candidate.kind !== kind) {
      continue
    }
    indexed.set(candidate.routeKey, candidate)
  }
  return indexed
}

function indexNaturalStopCandidates(candidates: WechatNotificationCandidate[]) {
  const indexed = new Map<string, NaturalStopNotificationCandidate>()
  for (const candidate of candidates) {
    if (candidate.kind !== "naturalStop") {
      continue
    }
    indexed.set(candidate.handle, candidate)
  }
  return indexed
}

type SessionLite = Pick<Session, "id" | "title" | "directory" | "time"> & { parentID?: string }

type SdkFieldsResult<T> = {
  data: T | undefined
  error?: unknown
  request?: unknown
  response?: unknown
}

type SdkReadResult<T> = T | SdkFieldsResult<T>

type WechatBridgeClient = {
  session: {
    list: () => Promise<SdkReadResult<SessionLite[]>>
    status: () => Promise<SdkReadResult<Record<string, SessionStatus | undefined>>>
    todo: (parameters: { sessionID: string } | string) => Promise<SdkReadResult<Todo[]>>
    messages: (parameters: { sessionID: string; limit?: number } | string) => Promise<SdkReadResult<SessionMessages>>
    reply?: (input: { sessionID: string; text: string }) => Promise<SdkReadResult<unknown>>
  }
  question: {
    list: () => Promise<SdkReadResult<QuestionRequest[]>>
    reply?: (input: { requestID: string; answers: QuestionAnswer[] }) => Promise<SdkReadResult<unknown>>
  }
  permission: {
    list: () => Promise<SdkReadResult<PermissionRequest[]>>
    reply?: (input: { requestID: string; reply: "once" | "always" | "reject"; message?: string }) => Promise<SdkReadResult<unknown>>
  }
}

export type InstanceUnavailableKind = "sessionStatus" | "questionList" | "permissionList"

export type WechatInstanceStatusSnapshot = {
  instanceID: string
  instanceName: string
  pid: number
  projectName?: string
  directory: string
  collectedAt: number
  sessions: SessionDigest[]
  unavailable?: InstanceUnavailableKind[]
}

export type WechatFallbackToast = {
  wechatAccountId: string
  userId: string
  message: string
  reason: "deliveryFailed"
  registrationEpoch?: string
}

export type WechatBridgeInput = {
  instanceID: string
  instanceName: string
  pid: number
  projectName?: string
  directory: string
  client: WechatBridgeClient
  liveReadTimeoutMs?: number
  getActiveSessionID?: () => string | undefined
  onDiagnosticEvent?: (event: WechatBridgeDiagnosticEvent) => Promise<void> | void
  onFallbackToast?: (payload: WechatFallbackToast) => Promise<void> | void
}

export type WechatBridge = {
  collectStatusSnapshot: () => Promise<WechatInstanceStatusSnapshot>
  collectNotificationCandidates: () => Promise<WechatNotificationCandidate[]>
  collectNotificationCandidateSnapshot?: () => Promise<NotificationCandidateSnapshot>
  resyncBrokerState?: (input?: { reason?: "brokerReconnect" | "manual" }) => Promise<WechatInstanceStatusSnapshot>
  handleBrokerEnvelope?: (envelope: BrokerEnvelope) => Promise<ReplyMutationResult | null>
}

export type WechatBridgeLifecycleInput = {
  client: WechatBridgeClient
  project?: {
    id?: string
    name?: string
  }
  directory?: string
  serverUrl?: URL
  initialBrokerPromise?: Promise<{ endpoint: string }>
  statusCollectionEnabled?: boolean
  heartbeatIntervalMs?: number
  getActiveSessionID?: () => string | undefined
  onFallbackToast?: (payload: WechatFallbackToast) => Promise<void> | void
}

export type WechatBridgeLifecycle = {
  close: () => Promise<void>
}

const DEFAULT_LIVE_READ_TIMEOUT_MS = 2_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_BRIDGE_PROTOCOL_VERSION = 2
const DEFAULT_BRIDGE_STATE_GENERATION = "wechat-ws-v1"
const PROCESS_INSTANCE_ID = toSafeInstanceID(`wechat-${process.pid}-${randomUUID().slice(0, 8)}`)

type WechatBridgeLifecycleDeps = {
  connectOrSpawnBrokerImpl?: typeof connectOrSpawnBroker
  connectImpl?: typeof connect
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

function toSafeInstanceID(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  if (normalized.length === 0) {
    return `wechat-${process.pid}`
  }
  return normalized.slice(0, 64)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function toProjectName(project: WechatBridgeLifecycleInput["project"]): string | undefined {
  if (typeof project?.name === "string" && project.name.trim().length > 0) {
    return project.name.trim()
  }
  if (typeof project?.id === "string" && project.id.trim().length > 0) {
    return project.id.trim()
  }
  return undefined
}

function toDirectory(inputDirectory: string | undefined): string {
  if (typeof inputDirectory === "string" && inputDirectory.trim().length > 0) {
    return inputDirectory
  }
  return process.cwd()
}

function toInstanceName(projectName: string | undefined, directory: string): string {
  if (projectName) {
    return projectName
  }
  const parts = directory.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.at(-1) ?? `wechat-${process.pid}`
}

function toInstanceID(projectName: string | undefined, directory: string): string {
  const seed = projectName ?? directory
  return toSafeInstanceID(seed)
}

function withTimeout<T>(task: () => Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error(`${name} timed out in ${timeoutMs}ms`))
    }, timeoutMs)

    void Promise.resolve()
      .then(task)
      .then((value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

type WechatBridgeDiagnosticEvent =
  {
      type: "collectStatusCompleted"
      instanceID: string
      durationMs: number
      sessionCount: number
      unavailable?: InstanceUnavailableKind[]
    }
  | {
      type: "bridgeResyncFailed"
      code: "bridgeResyncFailed"
      instanceID: string
      reason: "brokerReconnect" | "manual"
      durationMs: number
      error: string
    }

function isErrorWithMessage(value: unknown): value is { message: string } {
  return typeof value === "object" && value !== null && "message" in value && typeof (value as { message: unknown }).message === "string"
}

function createWechatBridgeDiagnosticsWriter(filePath: string = wechatBridgeDiagnosticsPath()) {
  let warned = false

  return async (event: WechatBridgeDiagnosticEvent) => {
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      const line = `${JSON.stringify({ timestamp: Date.now(), ...event })}\n`
      await appendFile(filePath, line, { encoding: "utf8", mode: WECHAT_FILE_MODE })
    } catch (error) {
      if (!warned) {
        warned = true
        console.warn("[wechat-bridge] failed to write diagnostics", error)
      }
    }
  }
}

function toDiagnosticErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message
  }
  return String(error)
}

function wrapDiagnosticStage<T>(
  input: {
    instanceID: string
    stage: string
    onDiagnosticEvent?: (event: WechatBridgeDiagnosticEvent) => Promise<void> | void
  },
  task: () => Promise<T>,
): Promise<T> {
  void input.instanceID
  void input.stage
  void input.onDiagnosticEvent
  return Promise.resolve().then(task)
}

function isSdkFieldsResult<T>(value: SdkReadResult<T>): value is SdkFieldsResult<T> {
  return typeof value === "object"
    && value !== null
    && ("data" in value || "error" in value)
}

function unwrapSdkReadResult<T>(value: SdkReadResult<T>, name: string): T {
  if (!isSdkFieldsResult(value)) {
    return value
  }

  if (value.error != null) {
    throw value.error instanceof Error ? value.error : new Error(`${name} failed`)
  }

  if (value.data === undefined) {
    throw new Error(`${name} returned no data`)
  }

  return value.data
}

function normalizeReplyMutationResult(mutationId: string, value: unknown): ReplyMutationResult {
  if (isSdkFieldsResult(value) && value.error != null) {
    return {
      mutationId,
      ok: false,
      errorMessage: toDiagnosticErrorMessage(value.error),
    }
  }
  return {
    mutationId,
    ok: true,
  }
}

function asStatusRecord(status: SessionStatus | undefined): Record<string, unknown> {
  if (typeof status !== "object" || status === null) {
    return {}
  }
  return status as Record<string, unknown>
}

function readStatusText(status: SessionStatus | undefined, key: string): string | undefined {
  const value = asStatusRecord(status)[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function readStatusNumber(status: SessionStatus | undefined, key: string): number | undefined {
  const value = asStatusRecord(status)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isSensitiveSummary(summary: string): boolean {
  return /\n|\r|stack|trace|token|secret|password|authorization|cookie|set-cookie|bearer/i.test(summary)
}

function deriveStatusSummary(status: SessionStatus | undefined): string {
  const explicit = readStatusText(status, "redactedSummary")
  if (explicit) {
    return explicit
  }

  const message = readStatusText(status, "message")
  if (!message || isSensitiveSummary(message)) {
    return "原因摘要不可安全展示"
  }
  return message
}

function deriveRetryAction(status: SessionStatus | undefined): string {
  const explicit = readStatusText(status, "action") ?? readStatusText(status, "stage")
  if (explicit) {
    return explicit
  }

  const attempt = readStatusNumber(status, "attempt")
  if (typeof attempt === "number") {
    return `自动重试第 ${attempt} 次`
  }
  return "重试处理中"
}

function deriveRetrySeverity(status: SessionStatus | undefined): string {
  const explicit = readStatusText(status, "severityAdvice")
  if (explicit === "可等待自动重试" || explicit === "建议尽快人工查看") {
    return explicit
  }

  const attempt = readStatusNumber(status, "attempt")
  if (typeof attempt === "number" && attempt > 1) {
    return "建议尽快人工查看"
  }
  return "可等待自动重试"
}

function deriveNaturalStopSeverity(status: SessionStatus | undefined): string {
  void status
  return "已停止并等待你的回复"
}

function stableBridgeSignature(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableBridgeSignature(item)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableBridgeSignature(record[key])}`).join(",")}}`
}

export function createWechatBridge(input: WechatBridgeInput): WechatBridge {
  const retryEventSequenceBySessionID = new Map<string, number>()
  const retrySignatureBySessionID = new Map<string, string>()
  const isRetryBySessionID = new Map<string, boolean>()
  const naturalStopEventSequenceBySessionID = new Map<string, number>()
  const naturalStopSignatureBySessionID = new Map<string, string>()
  const isNaturalStopBySessionID = new Map<string, boolean>()

  function toIdempotencyPart(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    return normalized.length > 0 ? normalized : "na"
  }

  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(",")}]`
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
  }

  const collectLiveRead = async () => {
    const liveReadTimeoutMs =
      typeof input.liveReadTimeoutMs === "number" && Number.isFinite(input.liveReadTimeoutMs)
      ? Math.max(1, Math.floor(input.liveReadTimeoutMs))
      : DEFAULT_LIVE_READ_TIMEOUT_MS
    const onDiagnosticEvent = input.onDiagnosticEvent

    const [sessionListResult, statusResult, questionResult, permissionResult] = await Promise.allSettled([
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "session.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.session.list(), "session.list"), liveReadTimeoutMs, "session.list"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "session.status", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.session.status(), "session.status"), liveReadTimeoutMs, "session.status"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "question.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.question.list(), "question.list"), liveReadTimeoutMs, "question.list"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "permission.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.permission.list(), "permission.list"), liveReadTimeoutMs, "permission.list"),
      ),
    ])

    return {
      liveReadTimeoutMs,
      sessionListResult,
      statusResult,
      questionResult,
      permissionResult,
    }
  }

  const collectStatusSnapshot = async (): Promise<WechatInstanceStatusSnapshot> => {
    const startedAt = Date.now()
    const unavailable = new Set<InstanceUnavailableKind>()
    const onDiagnosticEvent = input.onDiagnosticEvent
    const activeSessionID = input.getActiveSessionID?.()

    if (input.getActiveSessionID && !isNonEmptyString(activeSessionID)) {
      const snapshot = {
        instanceID: input.instanceID,
        instanceName: input.instanceName,
        pid: input.pid,
        projectName: input.projectName,
        directory: input.directory,
        collectedAt: Date.now(),
        sessions: [] as SessionDigest[],
        unavailable: undefined,
      }

      void Promise.resolve(onDiagnosticEvent?.({
        type: "collectStatusCompleted",
        instanceID: input.instanceID,
        durationMs: Date.now() - startedAt,
        sessionCount: 0,
        unavailable: snapshot.unavailable,
      })).catch(() => {})

      return snapshot
    }

    const {
      liveReadTimeoutMs,
      sessionListResult,
      statusResult,
      questionResult,
      permissionResult,
    } = await collectLiveRead()

    const sessions = sessionListResult.status === "fulfilled" ? sessionListResult.value : []
    const recentSessions = isNonEmptyString(activeSessionID)
      ? sessions.filter((session) => session.id === activeSessionID).slice(0, 1)
      : pickRecentSessions(sessions, 3)
    if (sessionListResult.status === "rejected") {
      unavailable.add("sessionStatus")
    }

    const statusBySession =
      statusResult.status === "fulfilled"
        ? statusResult.value
        : (unavailable.add("sessionStatus"), ({} as Record<string, SessionStatus | undefined>))

    const questionsBySession =
      questionResult.status === "fulfilled"
        ? groupQuestionsBySession(questionResult.value)
        : (unavailable.add("questionList"), groupQuestionsBySession([]))

    const permissionsBySession =
      permissionResult.status === "fulfilled"
        ? groupPermissionsBySession(permissionResult.value)
        : (unavailable.add("permissionList"), groupPermissionsBySession([]))

    const sessionDigests = await Promise.all(
      recentSessions.map(async (session) => {
        const [todoResult, messagesResult] = await Promise.allSettled([
          wrapDiagnosticStage({ instanceID: input.instanceID, stage: `session.todo:${session.id}`, onDiagnosticEvent }, () =>
            withTimeout(
              async () => unwrapSdkReadResult(
                await input.client.session.todo({ sessionID: session.id }),
                `session.todo:${session.id}`,
              ),
              liveReadTimeoutMs,
              `session.todo:${session.id}`,
            ),
          ),
          wrapDiagnosticStage({ instanceID: input.instanceID, stage: `session.messages:${session.id}`, onDiagnosticEvent }, () =>
            withTimeout(
              async () => unwrapSdkReadResult(
                await input.client.session.messages({ sessionID: session.id, limit: 1 }),
                `session.messages:${session.id}`,
              ),
              liveReadTimeoutMs,
              `session.messages:${session.id}`,
            ),
          ),
        ])

        const sessionUnavailable: Array<"messages" | "todo"> = []
        const todos = todoResult.status === "fulfilled" ? todoResult.value : (sessionUnavailable.push("todo"), [])
        const messages =
          messagesResult.status === "fulfilled"
            ? messagesResult.value
            : (sessionUnavailable.push("messages"), [])

        return buildSessionDigest({
          session,
          statusBySession,
          questionsBySession,
          permissionsBySession,
          todos,
          messages,
          unavailable: sessionUnavailable,
        })
      }),
    )

    const snapshot = {
      instanceID: input.instanceID,
      instanceName: input.instanceName,
      pid: input.pid,
      projectName: input.projectName,
      directory: input.directory,
      collectedAt: Date.now(),
      sessions: sessionDigests,
      unavailable: unavailable.size > 0 ? [...unavailable] : undefined,
    }

    void Promise.resolve(onDiagnosticEvent?.({
      type: "collectStatusCompleted",
      instanceID: input.instanceID,
      durationMs: Date.now() - startedAt,
      sessionCount: snapshot.sessions.length,
      unavailable: snapshot.unavailable,
    })).catch(() => {})

    return snapshot
  }

  const collectNotificationCandidateSnapshot = async (): Promise<NotificationCandidateSnapshot> => {
    const binding = await readOperatorBinding().catch(() => undefined)
    if (!binding) {
      return {
        candidates: [],
        authoritative: false,
      }
    }

    const { questionResult, permissionResult, statusResult } = await collectLiveRead()
    const candidates: WechatNotificationCandidate[] = []
    const existingHandles = new Set<string>()
    const authoritative = questionResult.status === "fulfilled"
      && permissionResult.status === "fulfilled"
      && statusResult.status === "fulfilled"

    if (questionResult.status === "fulfilled") {
      for (const question of questionResult.value) {
        const routeKey = createRouteKey({
          kind: "question",
          requestID: question.id,
          scopeKey: input.instanceID,
        })
        const handle = createHandle("question", existingHandles)
        existingHandles.add(handle)
        candidates.push({
          idempotencyKey: `question-${toIdempotencyPart(input.instanceID)}-${toIdempotencyPart(question.id)}`,
          kind: "question",
          requestID: question.id,
          createdAt: Date.now(),
          routeKey,
          handle,
          scopeKey: input.instanceID,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          prompt: extractQuestionPromptSummary(question),
        })
      }
    }

    if (permissionResult.status === "fulfilled") {
      for (const permission of permissionResult.value) {
        const routeKey = createRouteKey({
          kind: "permission",
          requestID: permission.id,
          scopeKey: input.instanceID,
        })
        const handle = createHandle("permission", existingHandles)
        existingHandles.add(handle)
        candidates.push({
          idempotencyKey: `permission-${toIdempotencyPart(input.instanceID)}-${toIdempotencyPart(permission.id)}`,
          kind: "permission",
          requestID: permission.id,
          createdAt: Date.now(),
          routeKey,
          handle,
          scopeKey: input.instanceID,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          prompt: extractPermissionPromptSummary(permission),
        })
      }
    }

    if (statusResult.status === "fulfilled") {
      const seenSessionIDs = new Set<string>()
      for (const [sessionID, status] of Object.entries(statusResult.value)) {
        seenSessionIDs.add(sessionID)
        const statusType = readStatusText(status, "type")
        if (statusType === "retry") {
          const signature = stableStringify(status)
          const previousWasRetry = isRetryBySessionID.get(sessionID) === true
          const previousSignature = retrySignatureBySessionID.get(sessionID)
          if (!previousWasRetry || previousSignature !== signature) {
            const nextSequence = (retryEventSequenceBySessionID.get(sessionID) ?? 0) + 1
            retryEventSequenceBySessionID.set(sessionID, nextSequence)
          }

          isRetryBySessionID.set(sessionID, true)
          retrySignatureBySessionID.set(sessionID, signature)
          const eventSequence = retryEventSequenceBySessionID.get(sessionID) ?? 1
          candidates.push({
            idempotencyKey: `session-error-${toIdempotencyPart(input.instanceID)}-${toIdempotencyPart(sessionID)}-${eventSequence}`,
            kind: "sessionError",
            createdAt: Date.now(),
            sessionID,
            action: deriveRetryAction(status),
            redactedSummary: deriveStatusSummary(status),
            severityAdvice: deriveRetrySeverity(status),
          })
          isNaturalStopBySessionID.set(sessionID, false)
          naturalStopSignatureBySessionID.delete(sessionID)
          continue
        }

        if (statusType === "natural-stop") {
          const signature = stableStringify(status)
          const previousWasNaturalStop = isNaturalStopBySessionID.get(sessionID) === true
          const previousSignature = naturalStopSignatureBySessionID.get(sessionID)
          if (!previousWasNaturalStop || previousSignature !== signature) {
            const nextSequence = (naturalStopEventSequenceBySessionID.get(sessionID) ?? 0) + 1
            naturalStopEventSequenceBySessionID.set(sessionID, nextSequence)
          }

          isNaturalStopBySessionID.set(sessionID, true)
          naturalStopSignatureBySessionID.set(sessionID, signature)
          isRetryBySessionID.set(sessionID, false)
          retrySignatureBySessionID.delete(sessionID)
          const handle = createSessionReplyHandle(existingHandles)
          existingHandles.add(handle)
          const eventSequence = naturalStopEventSequenceBySessionID.get(sessionID) ?? 1
          candidates.push({
            idempotencyKey: `natural-stop-${toIdempotencyPart(input.instanceID)}-${toIdempotencyPart(sessionID)}-${eventSequence}`,
            kind: "naturalStop",
            createdAt: Date.now(),
            sessionID,
            handle,
            replyTarget: {
              instanceID: input.instanceID,
              sessionID,
            },
            redactedSummary: deriveStatusSummary(status),
            severityAdvice: deriveNaturalStopSeverity(status),
          })
        } else {
          isRetryBySessionID.set(sessionID, false)
          retrySignatureBySessionID.delete(sessionID)
          isNaturalStopBySessionID.set(sessionID, false)
          naturalStopSignatureBySessionID.delete(sessionID)
        }
      }

      for (const knownSessionID of isRetryBySessionID.keys()) {
        if (seenSessionIDs.has(knownSessionID)) {
          continue
        }
        isRetryBySessionID.set(knownSessionID, false)
        retrySignatureBySessionID.delete(knownSessionID)
      }

      for (const knownSessionID of isNaturalStopBySessionID.keys()) {
        if (seenSessionIDs.has(knownSessionID)) {
          continue
        }
        isNaturalStopBySessionID.set(knownSessionID, false)
        naturalStopSignatureBySessionID.delete(knownSessionID)
      }
    }

    return {
      candidates,
      authoritative,
    }
  }

  const collectNotificationCandidates = async (): Promise<WechatNotificationCandidate[]> => {
    const snapshot = await collectNotificationCandidateSnapshot()
    return snapshot.candidates
  }

  const resyncBrokerState = async (
    options: { reason?: "brokerReconnect" | "manual" } = {},
  ): Promise<WechatInstanceStatusSnapshot> => {
    const reason = options.reason ?? "manual"
    const startedAt = Date.now()

    try {
      return await collectStatusSnapshot()
    } catch (error) {
      await Promise.resolve(input.onDiagnosticEvent?.({
        type: "bridgeResyncFailed",
        code: "bridgeResyncFailed",
        instanceID: input.instanceID,
        reason,
        durationMs: Date.now() - startedAt,
        error: toDiagnosticErrorMessage(error),
      })).catch(() => {})
      throw error
    }
  }

  const handleBrokerEnvelope = async (envelope: BrokerEnvelope): Promise<ReplyMutationResult | null> => {
    if (envelope.type === "replyQuestion") {
      const payload = envelope.payload as ReplyQuestionPayload
      if (!input.client.question.reply) {
        return {
          mutationId: payload.mutationId,
          ok: false,
          errorMessage: "question.reply unavailable",
        }
      }
      const response = await input.client.question.reply({
        requestID: payload.requestID,
        answers: payload.answers as QuestionAnswer[],
      })
      return normalizeReplyMutationResult(payload.mutationId, response)
    }

    if (envelope.type === "replyPermission") {
      const payload = envelope.payload as ReplyPermissionPayload
      if (!input.client.permission.reply) {
        return {
          mutationId: payload.mutationId,
          ok: false,
          errorMessage: "permission.reply unavailable",
        }
      }
      const response = await input.client.permission.reply({
        requestID: payload.requestID,
        reply: payload.reply,
        ...(payload.message ? { message: payload.message } : {}),
      })
      return normalizeReplyMutationResult(payload.mutationId, response)
    }

    if (envelope.type === "replyNaturalStop") {
      const payload = envelope.payload as ReplyNaturalStopPayload
      if (!input.client.session.reply) {
        return {
          mutationId: payload.mutationId,
          ok: false,
          errorMessage: "session.reply unavailable",
        }
      }
      const response = await input.client.session.reply({
        sessionID: payload.sessionID,
        text: payload.text,
      })
      return normalizeReplyMutationResult(payload.mutationId, response)
    }

    return null
  }

  return {
    collectStatusSnapshot,
    collectNotificationCandidates,
    collectNotificationCandidateSnapshot,
    resyncBrokerState,
    handleBrokerEnvelope,
  }
}

export async function createWechatBridgeLifecycle(
  input: WechatBridgeLifecycleInput,
  deps: WechatBridgeLifecycleDeps = {},
): Promise<WechatBridgeLifecycle> {
  if (input.statusCollectionEnabled !== true) {
    return {
      close: async () => {},
    }
  }

  const connectOrSpawnBrokerImpl = deps.connectOrSpawnBrokerImpl ?? connectOrSpawnBroker
  const connectImpl = deps.connectImpl ?? connect
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval

  const directory = toDirectory(input.directory)
  const projectName = toProjectName(input.project)
  const instanceID = PROCESS_INSTANCE_ID
  const bridge = createWechatBridge({
    instanceID,
    instanceName: toInstanceName(projectName, directory),
    pid: process.pid,
    projectName,
    directory,
    client: input.client,
    getActiveSessionID: input.getActiveSessionID,
    onDiagnosticEvent: createWechatBridgeDiagnosticsWriter(),
    onFallbackToast: input.onFallbackToast,
  })

  let brokerClient!: Awaited<ReturnType<typeof connect>>
  const instanceIncarnation = randomUUID()
  let lastSeenBrokerSeq = 0
  let nextEventSeq = 0
  let lastSentEventSeq = 0
  let lastAckedEventSeq = 0
  let stagedRegisterFullSyncCandidates: NotificationCandidateSnapshot | null = null
  const bridgeEventLog: BridgeToBrokerEvent[] = []
  let lastSteadyStateSessionSignature: string | null = null
  let lastSteadyStateCandidateSignature: string | null = null
  let lastQuestionCandidates = new Map<string, RequestNotificationCandidate>()
  let lastPermissionCandidates = new Map<string, RequestNotificationCandidate>()
  let lastNaturalStopCandidates = new Map<string, NaturalStopNotificationCandidate>()
  let steadyStateSyncPromise: Promise<void> | null = null

  const supportsLiveBrokerClient = (candidate: unknown): candidate is Awaited<ReturnType<typeof connect>> => {
    if (typeof candidate !== "object" || candidate === null) {
      return false
    }
    return typeof (candidate as { setLiveHandlers?: unknown }).setLiveHandlers === "function"
      && typeof (candidate as { registerHello?: unknown }).registerHello === "function"
      && typeof (candidate as { ping?: unknown }).ping === "function"
    }

  const supportsLegacyInjectedBrokerClient = (candidate: unknown): candidate is {
    registerInstance: (payload: Record<string, unknown>) => Promise<unknown>
    heartbeat: () => Promise<unknown>
    close: () => Promise<void>
  } => {
    if (typeof candidate !== "object" || candidate === null) {
      return false
    }
    return typeof (candidate as { registerInstance?: unknown }).registerInstance === "function"
      && typeof (candidate as { heartbeat?: unknown }).heartbeat === "function"
      && typeof (candidate as { close?: unknown }).close === "function"
  }

  function trimAckedBridgeEvents(ackedEventSeq: number) {
    if (!Number.isSafeInteger(ackedEventSeq) || ackedEventSeq <= lastAckedEventSeq) {
      return
    }

    lastAckedEventSeq = ackedEventSeq
    const firstUnackedIndex = bridgeEventLog.findIndex((event) => event.eventSeq > ackedEventSeq)
    if (firstUnackedIndex === -1) {
      bridgeEventLog.length = 0
      return
    }

    bridgeEventLog.splice(0, firstUnackedIndex)
  }

  function createSequencedEvent(
    type: BridgeToBrokerEvent["type"],
    payload: Record<string, unknown>,
    options: { controlId?: string } = {},
  ): BridgeToBrokerEvent {
    nextEventSeq += 1
    return {
      type,
      eventSeq: nextEventSeq,
      instanceIncarnation,
      payload: {
        instanceID,
        ...payload,
      },
      ...(options.controlId ? { controlId: options.controlId } : {}),
    }
  }

  async function sendSequencedEvent(
    event: BridgeToBrokerEvent,
    options: { persist?: boolean; controlId?: string } = {},
  ) {
    if (options.persist !== false) {
      bridgeEventLog.push(event)
    }

    lastSentEventSeq = Math.max(lastSentEventSeq, event.eventSeq)

    const ack = await brokerClient.sendBridgeEvent(event, {
      instanceID,
      ...(options.controlId ?? event.controlId ? { controlId: options.controlId ?? event.controlId } : {}),
    })
    trimAckedBridgeEvents(ack.ackedEventSeq)
  }

  function toCandidateEvent(
    candidate: WechatNotificationCandidate,
    controlId?: string,
  ): BridgeToBrokerEvent | null {
    if (candidate.kind === "question") {
      return createSequencedEvent("questionOpened", {
        idempotencyKey: candidate.idempotencyKey,
        requestID: candidate.requestID,
        routeKey: candidate.routeKey,
        handle: candidate.handle,
        ...(candidate.scopeKey ? { scopeKey: candidate.scopeKey } : {}),
        ...(candidate.wechatAccountId ? { wechatAccountId: candidate.wechatAccountId } : {}),
        ...(candidate.userId ? { userId: candidate.userId } : {}),
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
        ...(candidate.prompt ? { prompt: candidate.prompt } : {}),
      }, { controlId })
    }

    if (candidate.kind === "permission") {
      return createSequencedEvent("permissionOpened", {
        idempotencyKey: candidate.idempotencyKey,
        requestID: candidate.requestID,
        routeKey: candidate.routeKey,
        handle: candidate.handle,
        ...(candidate.scopeKey ? { scopeKey: candidate.scopeKey } : {}),
        ...(candidate.wechatAccountId ? { wechatAccountId: candidate.wechatAccountId } : {}),
        ...(candidate.userId ? { userId: candidate.userId } : {}),
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
        ...(candidate.prompt ? { prompt: candidate.prompt } : {}),
      }, { controlId })
    }

    if (candidate.kind === "naturalStop") {
      return createSequencedEvent("naturalStopOpened", {
        idempotencyKey: candidate.idempotencyKey,
        sessionID: candidate.sessionID,
        handle: candidate.handle,
        replyTarget: candidate.replyTarget,
        redactedSummary: candidate.redactedSummary,
        severityAdvice: candidate.severityAdvice,
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
      }, { controlId })
    }

    if (candidate.kind === "sessionError") {
      return createSequencedEvent("retryErrorUpdated", {
        idempotencyKey: candidate.idempotencyKey,
        sessionID: candidate.sessionID,
        action: candidate.action,
        redactedSummary: candidate.redactedSummary,
        severityAdvice: candidate.severityAdvice,
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
      }, { controlId })
    }

    return null
  }

  async function handleReplayControl(control: BrokerToBridgeControl) {
    const payload = control.payload as {
      fromEventSeq?: unknown
      toEventSeq?: unknown
    }
    const fromEventSeq = typeof payload.fromEventSeq === "number" ? payload.fromEventSeq : undefined
    const toEventSeq = typeof payload.toEventSeq === "number" ? payload.toEventSeq : undefined
    if (fromEventSeq === undefined || toEventSeq === undefined) {
      return
    }

    for (const event of bridgeEventLog) {
      if (event.eventSeq < fromEventSeq || event.eventSeq > toEventSeq) {
        continue
      }
      await sendSequencedEvent(event, {
        persist: false,
        controlId: control.controlId,
      })
    }
  }

  async function handleFullSyncControl(control: BrokerToBridgeControl) {
    const snapshot = await bridge.collectStatusSnapshot()

    await sendSequencedEvent(createSequencedEvent("instanceOnline", {
      connectedAt: Date.now(),
      pid: process.pid,
      displayName: toInstanceName(projectName, directory),
      projectDir: directory,
    }, { controlId: control.controlId }))

    for (const session of snapshot.sessions) {
      await sendSequencedEvent(createSequencedEvent("sessionSnapshotChanged", {
        sessionID: session.sessionID,
        ...(isNonEmptyString(session.parentID) ? { parentID: session.parentID } : {}),
        title: session.title,
        directory: session.directory,
        updatedAt: session.updatedAt,
        status: session.status,
        pendingQuestionCount: session.pendingQuestionCount,
        pendingPermissionCount: session.pendingPermissionCount,
        todoSummary: session.todoSummary,
        highlights: session.highlights,
        ...(session.unavailable ? { unavailable: session.unavailable } : {}),
        ...(session.todoItems ? { todoItems: session.todoItems } : {}),
        ...(session.questionHighlights ? { questionHighlights: session.questionHighlights } : {}),
      }, { controlId: control.controlId }))
    }

    const candidateSnapshot = stagedRegisterFullSyncCandidates
      ?? await (bridge.collectNotificationCandidateSnapshot
        ? bridge.collectNotificationCandidateSnapshot()
        : Promise.resolve({
            candidates: await bridge.collectNotificationCandidates(),
            authoritative: true,
          }))
    const candidates = candidateSnapshot.candidates
    stagedRegisterFullSyncCandidates = null
    lastSteadyStateSessionSignature = stableBridgeSignature(snapshot.sessions)
    if (candidateSnapshot.authoritative) {
      lastSteadyStateCandidateSignature = stableBridgeSignature(candidates)
      lastQuestionCandidates = indexRequestCandidates(candidates, "question")
      lastPermissionCandidates = indexRequestCandidates(candidates, "permission")
      lastNaturalStopCandidates = indexNaturalStopCandidates(candidates)
      for (const candidate of candidates) {
        const event = toCandidateEvent(candidate, control.controlId)
        if (!event) {
          continue
        }
        await sendSequencedEvent(event)
      }
    }

    await sendSequencedEvent(createSequencedEvent("fullSyncCompleted", {
      controlId: control.controlId,
    }, { controlId: control.controlId }))
  }

  async function syncSteadyStateContentIfChanged() {
    if (steadyStateSyncPromise) {
      return steadyStateSyncPromise
    }

    steadyStateSyncPromise = (async () => {
      const snapshot = await bridge.collectStatusSnapshot()
      const sessionSignature = stableBridgeSignature(snapshot.sessions)
      if (sessionSignature !== lastSteadyStateSessionSignature) {
        for (const session of snapshot.sessions) {
          await sendSequencedEvent(createSequencedEvent("sessionSnapshotChanged", {
            sessionID: session.sessionID,
            ...(isNonEmptyString(session.parentID) ? { parentID: session.parentID } : {}),
            title: session.title,
            directory: session.directory,
            updatedAt: session.updatedAt,
            status: session.status,
            pendingQuestionCount: session.pendingQuestionCount,
            pendingPermissionCount: session.pendingPermissionCount,
            todoSummary: session.todoSummary,
            highlights: session.highlights,
            ...(session.unavailable ? { unavailable: session.unavailable } : {}),
            ...(session.todoItems ? { todoItems: session.todoItems } : {}),
            ...(session.questionHighlights ? { questionHighlights: session.questionHighlights } : {}),
          }))
        }
        lastSteadyStateSessionSignature = sessionSignature
      }

      const candidateSnapshot = await (bridge.collectNotificationCandidateSnapshot
        ? bridge.collectNotificationCandidateSnapshot()
        : Promise.resolve({
            candidates: await bridge.collectNotificationCandidates(),
            authoritative: true,
          }))
      if (!candidateSnapshot.authoritative) {
        return
      }
      const candidates = candidateSnapshot.candidates
      const candidateSignature = stableBridgeSignature(candidates)
      if (candidateSignature !== lastSteadyStateCandidateSignature) {
        const nextQuestionCandidates = indexRequestCandidates(candidates, "question")
        for (const [routeKey, candidate] of lastQuestionCandidates) {
          if (nextQuestionCandidates.has(routeKey)) {
            continue
          }
          await sendSequencedEvent(createSequencedEvent("questionClosed", {
            routeKey,
            handle: candidate.handle,
            reason: "answered",
          }))
        }

        const nextPermissionCandidates = indexRequestCandidates(candidates, "permission")
        for (const [routeKey, candidate] of lastPermissionCandidates) {
          if (nextPermissionCandidates.has(routeKey)) {
            continue
          }
          await sendSequencedEvent(createSequencedEvent("permissionClosed", {
            routeKey,
            handle: candidate.handle,
            reason: "handled",
          }))
        }

        const nextNaturalStopCandidates = indexNaturalStopCandidates(candidates)
        for (const [handle, candidate] of lastNaturalStopCandidates) {
          if (nextNaturalStopCandidates.has(handle)) {
            continue
          }
          await sendSequencedEvent(createSequencedEvent("naturalStopClosed", {
            handle,
            sessionID: candidate.sessionID,
            reason: "continued",
          }))
        }

        for (const candidate of candidates) {
          const event = toCandidateEvent(candidate)
          if (!event) {
            continue
          }
          await sendSequencedEvent(event)
        }
        lastQuestionCandidates = nextQuestionCandidates
        lastPermissionCandidates = nextPermissionCandidates
        lastNaturalStopCandidates = nextNaturalStopCandidates
        lastSteadyStateCandidateSignature = candidateSignature
      }
    })().finally(() => {
      steadyStateSyncPromise = null
    })

    return steadyStateSyncPromise
  }

  async function handleBrokerControl(control: BrokerToBridgeControl) {
    lastSeenBrokerSeq = Math.max(lastSeenBrokerSeq, control.brokerSeq)
    if (control.type === "requestReplay") {
      await handleReplayControl(control)
      return
    }
    await handleFullSyncControl(control)
  }

  async function handleBrokerCommand(command: BrokerToBridgeCommand) {
    lastSeenBrokerSeq = Math.max(lastSeenBrokerSeq, command.brokerSeq)

    if (!bridge.handleBrokerEnvelope) {
      await sendSequencedEvent(createSequencedEvent("commandResult", {
        commandId: command.commandId,
        status: "failed",
        completedAt: Date.now(),
        failure: {
          message: `${command.type} unavailable`,
        },
      }))
      return
    }

    await sendSequencedEvent(createSequencedEvent("commandAccepted", {
      commandId: command.commandId,
      acceptedAt: Date.now(),
    }))

    let result: ReplyMutationResult | null = null
    try {
      result = await bridge.handleBrokerEnvelope({
        id: command.commandId,
        type: command.type,
        payload: command.payload,
      })
    } catch (error) {
      await sendSequencedEvent(createSequencedEvent("commandResult", {
        commandId: command.commandId,
        status: "failed",
        completedAt: Date.now(),
        failure: {
          message: toDiagnosticErrorMessage(error),
        },
      }))
      return
    }

    const succeeded = result?.ok === true
    await sendSequencedEvent(createSequencedEvent("commandResult", {
      commandId: command.commandId,
      status: succeeded ? "completed" : "failed",
      completedAt: Date.now(),
      ...(succeeded
        ? {}
        : {
            failure: {
              message: result?.errorMessage ?? `${command.type} failed`,
            },
          }),
    }))
  }

  async function processRegisterResult(result: Awaited<ReturnType<typeof brokerClient.registerHello>>) {
    lastSeenBrokerSeq = Math.max(lastSeenBrokerSeq, result.ack.brokerSeq)

    if (result.control) {
      await handleBrokerControl(result.control)
    }

    for (const command of result.pendingCommands) {
      await handleBrokerCommand(command)
    }
  }

  async function registerCurrentBrokerClient() {
    try {
      const currentBrokerClient = brokerClient as unknown
      if (supportsLiveBrokerClient(currentBrokerClient)) {
        brokerClient.setLiveHandlers({
          onBrokerControl: (control) => handleBrokerControl(control),
          onBrokerCommand: (command) => handleBrokerCommand(command),
        })

        const registerResult = await brokerClient.registerHello({
          protocolVersion: DEFAULT_BRIDGE_PROTOCOL_VERSION,
          stateGeneration: DEFAULT_BRIDGE_STATE_GENERATION,
          instanceID,
          instanceIncarnation,
          lastSeenBrokerSeq,
          lastSentEventSeq,
        })
        stagedRegisterFullSyncCandidates = registerResult.control?.type === "requestFullSync"
          ? await (bridge.collectNotificationCandidateSnapshot
            ? bridge.collectNotificationCandidateSnapshot()
            : Promise.resolve({
                candidates: await bridge.collectNotificationCandidates(),
                authoritative: true,
              }))
          : null
        await processRegisterResult(registerResult)
        return
      }

      if (supportsLegacyInjectedBrokerClient(currentBrokerClient)) {
        await currentBrokerClient.registerInstance({
          instanceID,
          pid: process.pid,
          displayName: toInstanceName(projectName, directory),
          projectDir: directory,
        })
        stagedRegisterFullSyncCandidates = null
        return
      }

      throw new TypeError("broker client does not support live registration")
    } catch (error) {
      await brokerClient.close().catch(() => {})
      throw error
    }
  }

  if (input.initialBrokerPromise) {
    try {
      const initialBroker = await input.initialBrokerPromise
      brokerClient = await connectImpl(initialBroker.endpoint)
      await registerCurrentBrokerClient()
    } catch {
      const fallbackBroker = await connectOrSpawnBrokerImpl()
      brokerClient = await connectImpl(fallbackBroker.endpoint)
      await registerCurrentBrokerClient()
    }
  } else {
    const broker = await connectOrSpawnBrokerImpl()
    brokerClient = await connectImpl(broker.endpoint)
    await registerCurrentBrokerClient()
  }

  const heartbeatIntervalMs =
    typeof input.heartbeatIntervalMs === "number" && Number.isFinite(input.heartbeatIntervalMs)
      ? Math.max(1_000, Math.floor(input.heartbeatIntervalMs))
      : DEFAULT_HEARTBEAT_INTERVAL_MS
  let reconnectPromise: Promise<void> | null = null
  let closed = false

  const reconnectBrokerClient = async () => {
    if (closed) {
      return
    }
    if (reconnectPromise) {
      return reconnectPromise
    }

    reconnectPromise = (async () => {
      const previousBrokerClient = brokerClient
      await previousBrokerClient.close().catch(() => {})

      const nextBroker = await connectOrSpawnBrokerImpl()
      const nextBrokerClient = await connectImpl(nextBroker.endpoint)
      brokerClient = nextBrokerClient

      try {
        await registerCurrentBrokerClient()
      } catch (error) {
        await nextBrokerClient.close().catch(() => {})
        throw error
      }
    })().finally(() => {
      reconnectPromise = null
    })

    return reconnectPromise
  }

  const timer = setIntervalImpl(() => {
    if (closed) {
      return
    }
    const currentBrokerClient = brokerClient as unknown
    const heartbeatPromise = supportsLiveBrokerClient(currentBrokerClient)
      ? currentBrokerClient.ping()
      : supportsLegacyInjectedBrokerClient(currentBrokerClient)
        ? currentBrokerClient.heartbeat()
        : Promise.reject(new TypeError("broker client does not support keepalive"))
    void heartbeatPromise
      .then(() => syncSteadyStateContentIfChanged())
      .catch(() => reconnectBrokerClient().catch(() => {}))
  }, heartbeatIntervalMs)

  return {
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      clearIntervalImpl(timer)
      await reconnectPromise?.catch(() => {})
      await brokerClient.close().catch(() => {})
    },
  }
}
