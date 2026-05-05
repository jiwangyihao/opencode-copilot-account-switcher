import { appendFileSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2/client"
import {
  createCompactionLoopSafetyBypass,
  createLoopSafetySystemTransform,
  getLoopSafetyProviderScope,
  type LoopSafetyProviderScope,
  type CopilotPluginHooks,
} from "./loop-safety-plugin.js"
import { COPILOT_PROVIDER_DESCRIPTOR } from "./providers/descriptor.js"
import { CODEX_PROVIDER_DESCRIPTOR } from "./providers/descriptor.js"
import {
  createCopilotRetryingFetch,
  cleanupLongIdsForAccountSwitch,
  detectRateLimitEvidence,
  INTERNAL_SESSION_CONTEXT_KEY,
  type CopilotRetryContext,
  type FetchLike,
} from "./copilot-network-retry.js"
import { createCodexRetryingFetch } from "./codex-network-retry.js"
import { createCopilotRetryNotifier } from "./copilot-retry-notifier.js"
import { resolveCopilotModelAccounts, type ResolvedModelAccountCandidate } from "./model-account-map.js"
import { normalizeDomain } from "./copilot-api-helpers.js"
import { readStoreSafe, readStoreSafeSync, writeStore, type StoreFile, type StoreWriteDebugMeta } from "./store.js"
import {
  loadOfficialCopilotConfig,
  loadOfficialCopilotChatHeaders,
  type CopilotAuthState,
  type CopilotProviderConfig,
  type OfficialCopilotConfig,
  type OfficialChatHeadersHook,
} from "./upstream/copilot-loader-adapter.js"
import {
  loadOfficialCodexConfig,
  loadOfficialCodexChatHeaders,
} from "./upstream/codex-loader-adapter.js"
import { createNotifyTool } from "./notify-tool.js"
import type { CommonSettingsStore } from "./common-settings-store.js"
import { refreshActiveAccountQuota, type RefreshActiveAccountQuotaResult } from "./active-account-quota.js"
import { handleStatusCommand, showStatusToast } from "./status-command.js"
import { handleCodexStatusCommand } from "./codex-status-command.js"
import {
  handleCompactCommand,
  handleStopToolCommand,
} from "./session-control-command.js"
import {
  type AppendSessionTouchEventInput,
  appendRoutingEvent,
  appendRouteDecisionEvent,
  appendSessionTouchEvent,
  buildCandidateAccountLoads,
  isAccountRateLimitCooledDown,
  readRoutingState,
  type RouteDecisionEvent,
  routingStatePath,
  type RoutingSnapshot,
  type RoutingEvent,
} from "./routing-state.js"
import {
  createWechatBridgeLifecycle,
  type WechatBridgeLifecycle,
  type WechatBridgeLifecycleInput,
} from "./wechat/bridge.js"

type AuthLoader = NonNullable<CopilotPluginHooks["auth"]>["loader"]
type AuthProvider = Parameters<NonNullable<AuthLoader>>[1]
type ChatHeadersHook = (input: {
  sessionID: string
  agent: string
  model: {
    providerID: string
    api?: {
      npm?: string
    }
  }
  provider: {
    source: string
    info: object
    options: object
  }
  message: {
    id: string
    sessionID?: string
  }
}, output: {
  headers: Record<string, string>
}) => Promise<void>

type CopilotPluginHooksWithChatHeaders = CopilotPluginHooks & {
  "chat.headers"?: ChatHeadersHook
}

type StatusCommandHandler = typeof handleStatusCommand
type CodexStatusCommandHandler = typeof handleCodexStatusCommand
type CompactCommandHandler = typeof handleCompactCommand
type StopToolCommandHandler = typeof handleStopToolCommand
type RefreshQuota = (store: StoreFile) => Promise<RefreshActiveAccountQuotaResult>

type CandidateAccountLoads = Record<string, number> | Map<string, number>
type SessionBinding = {
  accountName: string
  lastUsedAt: number
}

type LoadOfficialChatHeaders = (input: { client?: object; directory?: string }) => Promise<OfficialChatHeadersHook>

type WechatBridgeClientShape = WechatBridgeLifecycleInput["client"]

const SESSION_BINDING_IDLE_TTL_MS = 30 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_HIT_THRESHOLD = 3
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const MAX_SESSION_BINDINGS = 256
const TOUCH_WRITE_CACHE_IDLE_TTL_MS = 30 * 60 * 1000
const MAX_TOUCH_WRITE_CACHE_ENTRIES = 2048
const INTERNAL_DEBUG_LINK_HEADER = "x-opencode-debug-link-id"

type WechatBridgeLifecycleState = {
  key: string
  promise: Promise<WechatBridgeLifecycle>
  lifecycle?: WechatBridgeLifecycle
  closeRequested: boolean
}

type WechatBridgeSessionState = {
  key: string
  selectedSessionID?: string
  interactedSessionID?: string
}

type WechatBridgeGlobalState = {
  lifecycleState?: WechatBridgeLifecycleState
  sessionState?: WechatBridgeSessionState
  autoCloseAttached: boolean
  autoCloseListeners?: {
    beforeExit: () => void
    sigint: () => void
    sigterm: () => void
  }
}

const WECHAT_BRIDGE_GLOBAL_STATE_KEY = Symbol.for(
  "opencode-copilot-account-switcher.wechat-bridge-global-state",
)

function getWechatBridgeGlobalState(): WechatBridgeGlobalState {
  const stateContainer = globalThis as typeof globalThis & {
    [WECHAT_BRIDGE_GLOBAL_STATE_KEY]?: WechatBridgeGlobalState
  }

  if (!stateContainer[WECHAT_BRIDGE_GLOBAL_STATE_KEY]) {
    stateContainer[WECHAT_BRIDGE_GLOBAL_STATE_KEY] = {
      autoCloseAttached: false,
    }
  }

  return stateContainer[WECHAT_BRIDGE_GLOBAL_STATE_KEY]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function ensureWechatBridgeSessionState(key: string): WechatBridgeSessionState {
  const globalState = getWechatBridgeGlobalState()
  if (globalState.sessionState?.key === key) {
    return globalState.sessionState
  }

  const state: WechatBridgeSessionState = { key }
  globalState.sessionState = state
  return state
}

function trackWechatBridgeSelectedSession(state: WechatBridgeSessionState | undefined, sessionID: unknown) {
  if (!state || !isNonEmptyString(sessionID)) {
    return
  }
  state.selectedSessionID = sessionID
}

function trackWechatBridgeInteractedSession(state: WechatBridgeSessionState | undefined, sessionID: unknown) {
  if (!state || !isNonEmptyString(sessionID)) {
    return
  }
  state.interactedSessionID = sessionID
}

function getWechatBridgeActiveSessionID(state: WechatBridgeSessionState | undefined): string | undefined {
  return state?.selectedSessionID ?? state?.interactedSessionID
}

function handleWechatBridgeEvent(state: WechatBridgeSessionState | undefined, event: unknown) {
  if (!state || typeof event !== "object" || event === null) {
    return
  }

  const payload = event as {
    type?: unknown
    properties?: {
      sessionID?: unknown
    }
  }
  if (payload.type !== "tui.session.select") {
    return
  }

  trackWechatBridgeSelectedSession(state, payload.properties?.sessionID)
}

function buildWechatBridgeLifecycleKey(input: {
  directory?: string
  serverUrl?: URL
  project?: {
    id?: string
    name?: string
  }
}) {
  const projectName = typeof input.project?.name === "string" ? input.project.name : ""
  const projectId = typeof input.project?.id === "string" ? input.project.id : ""
  const directory = typeof input.directory === "string" ? input.directory : ""
  const serverUrl = input.serverUrl?.href ?? ""
  return `${serverUrl}|${directory}|${projectName}|${projectId}`
}

function attachWechatBridgeAutoClose() {
  const globalState = getWechatBridgeGlobalState()
  if (globalState.autoCloseAttached) {
    return
  }
  globalState.autoCloseAttached = true

  const closeLifecycle = () => {
    const state = getWechatBridgeGlobalState().lifecycleState
    if (!state) return
    closeWechatBridgeLifecycleState(state)
  }

  globalState.autoCloseListeners = {
    beforeExit: closeLifecycle,
    sigint: closeLifecycle,
    sigterm: closeLifecycle,
  }

  process.once("beforeExit", globalState.autoCloseListeners.beforeExit)
  process.once("SIGINT", globalState.autoCloseListeners.sigint)
  process.once("SIGTERM", globalState.autoCloseListeners.sigterm)
}

function closeWechatBridgeLifecycleState(state: WechatBridgeLifecycleState) {
  if (state.closeRequested) {
    return
  }
  state.closeRequested = true
  void state.promise
    .then((lifecycle) => lifecycle.close().catch(() => {}))
    .catch(() => {})
}

function ensureWechatBridgeLifecycle(input: {
  key: string
  create: () => Promise<WechatBridgeLifecycle>
}) {
  const globalState = getWechatBridgeGlobalState()

  if (globalState.lifecycleState?.key === input.key) {
    return globalState.lifecycleState.promise
  }

  const previous = globalState.lifecycleState
  const promise = input.create()
  const state: WechatBridgeLifecycleState = {
    key: input.key,
    promise,
    closeRequested: false,
  }
  globalState.lifecycleState = state

  if (previous) {
    closeWechatBridgeLifecycleState(previous)
  }

  void promise
    .then((lifecycle) => {
      if (getWechatBridgeGlobalState().lifecycleState !== state) {
        closeWechatBridgeLifecycleState(state)
        return
      }
      state.lifecycle = lifecycle
    })
    .catch((error) => {
      const nextGlobalState = getWechatBridgeGlobalState()
      if (nextGlobalState.lifecycleState === state) {
        nextGlobalState.lifecycleState = undefined
      }
      console.warn("[plugin-hooks] failed to initialize wechat bridge lifecycle", error)
    })

  return promise
}

export async function resetWechatBridgeGlobalsForTest() {
  const globalState = getWechatBridgeGlobalState()
  const currentLifecycleState = globalState.lifecycleState

  globalState.lifecycleState = undefined
  globalState.sessionState = undefined

  if (currentLifecycleState) {
    closeWechatBridgeLifecycleState(currentLifecycleState)
    await currentLifecycleState.promise
      .then((lifecycle) => lifecycle.close().catch(() => {}))
      .catch(() => {})
  }

  if (globalState.autoCloseListeners) {
    process.removeListener("beforeExit", globalState.autoCloseListeners.beforeExit)
    process.removeListener("SIGINT", globalState.autoCloseListeners.sigint)
    process.removeListener("SIGTERM", globalState.autoCloseListeners.sigterm)
  }

  globalState.autoCloseAttached = false
  globalState.autoCloseListeners = undefined
}

type TriggerBillingCompensationInput = {
  fromAccountName: string
  toAccountName: string
  sessionID: string
  modelID?: string
  at: number
  retryAfterMs?: number
}

export class InjectCommandHandledError extends Error {
  constructor() {
    super("copilot-inject-handled")
    this.name = "InjectCommandHandledError"
  }
}

export class PolicyScopeCommandHandledError extends Error {
  constructor() {
    super("copilot-policy-scope-handled")
    this.name = "PolicyScopeCommandHandledError"
  }
}

type RetryStoreContext = {
  networkRetryEnabled?: boolean
  lastAccountSwitchAt?: number
  syntheticAgentInitiatorEnabled?: boolean
}

function isCopilotProviderID(providerID: string) {
  return COPILOT_PROVIDER_DESCRIPTOR.providerIDs.includes(providerID)
}

function isCodexProviderID(providerID: string) {
  return CODEX_PROVIDER_DESCRIPTOR.providerIDs.includes(providerID)
}

type DebugPart = {
  type?: unknown
  text?: unknown
  synthetic?: unknown
}

type DebugSessionMessage = {
  info?: {
    id?: string
    role?: string
  }
  parentID?: string
  summary?: boolean
  finish?: string
  parts?: Array<DebugPart>
}

type SessionGetResponse = {
  data?: {
    parentID?: unknown
  }
}

function isDebugEnabled() {
  return process.env.OPENCODE_COPILOT_RETRY_DEBUG === "1"
}

function normalizePreview(value: string, limit = 80) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit)
}

function toPartTypeList(parts: Array<DebugPart> | undefined) {
  return (parts ?? []).map((part) => (typeof part?.type === "string" ? part.type : "unknown"))
}

function toCurrentMessageTextParts(parts: Array<DebugPart> | undefined) {
  return (parts ?? [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => ({
      synthetic: part.synthetic,
      preview: normalizePreview(String(part.text)),
    }))
}

function debugLog(message: string, details: Record<string, unknown>) {
  if (!isDebugEnabled()) return
  const filePath = process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
  if (!filePath) return
  appendFileSync(filePath, `[copilot-plugin-hooks debug] ${message} ${JSON.stringify(details)}\n`)
}

function readRetryStoreContext(store: StoreFile | undefined): RetryStoreContext | undefined {
  if (!store) return undefined

  const maybeLastAccountSwitchAt = (store as StoreFile & { lastAccountSwitchAt?: unknown }).lastAccountSwitchAt
  return {
    networkRetryEnabled: store.networkRetryEnabled,
    lastAccountSwitchAt: typeof maybeLastAccountSwitchAt === "number" ? maybeLastAccountSwitchAt : undefined,
    syntheticAgentInitiatorEnabled: store.syntheticAgentInitiatorEnabled === true,
  }
}

function areExperimentalSlashCommandsEnabled(store: StoreFile | undefined) {
  if (store?.experimentalSlashCommandsEnabled === false) return false
  if (store?.experimentalStatusSlashCommandEnabled === false) return false
  return true
}

function mergeStoreWithCommonSettings(
  store: StoreFile | undefined,
  common: CommonSettingsStore | undefined,
): StoreFile | undefined {
  if (!store && !common) return undefined
  return {
    ...(store ?? { accounts: {} }),
    ...(common?.loopSafetyEnabled === true || common?.loopSafetyEnabled === false
      ? { loopSafetyEnabled: common.loopSafetyEnabled }
      : {}),
    ...(common?.loopSafetyProviderScope
      ? { loopSafetyProviderScope: common.loopSafetyProviderScope }
      : {}),
    ...(common?.networkRetryEnabled === true || common?.networkRetryEnabled === false
      ? { networkRetryEnabled: common.networkRetryEnabled }
      : {}),
    ...(common?.experimentalSlashCommandsEnabled === true || common?.experimentalSlashCommandsEnabled === false
      ? { experimentalSlashCommandsEnabled: common.experimentalSlashCommandsEnabled }
      : {}),
  }
}

async function readRequestBody(request: Request | URL | string, init?: RequestInit) {
  try {
    if (typeof init?.body === "string") return init.body
    if (request instanceof Request) return request.clone().text().catch(() => undefined)
  } catch {
    return undefined
  }
  return undefined
}

async function readRequestModelID(request: Request | URL | string, init?: RequestInit) {
  const raw = await readRequestBody(request, init)
  if (!raw) return undefined

  try {
    const body = JSON.parse(raw) as { model?: unknown }
    return typeof body.model === "string" && body.model.length > 0 ? body.model : undefined
  } catch {
    return undefined
  }
}

function rewriteRequestForAccount(request: Request | URL | string, enterpriseUrl?: string) {
  const nextBase = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"

  try {
    const current = new URL(request instanceof Request ? request.url : request.toString())
    const target = new URL(nextBase)
    if (current.origin === target.origin) return request
    current.protocol = target.protocol
    current.host = target.host
    if (request instanceof Request) return new Request(current, request)
    if (request instanceof URL) return current
    return current.toString()
  } catch {
    return request
  }
}

function mergeAndRewriteRequestHeaders(
  request: Request | URL | string,
  init?: RequestInit,
  rewriteHeaders?: (headers: Headers) => void,
): {
  request: Request | URL | string
  init: RequestInit | undefined
} {
  const hasRequestHeaders = request instanceof Request && [...request.headers].length > 0
  const hasInitHeaders = init?.headers != null && [...new Headers(init.headers)].length > 0
  if (!hasRequestHeaders && !hasInitHeaders && !rewriteHeaders) {
    return {
      request,
      init,
    }
  }

  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  if (init?.headers != null) {
    for (const [name, value] of new Headers(init.headers).entries()) {
      headers.set(name, value)
    }
  }
  rewriteHeaders?.(headers)

  const rewriteRequestHeaders = (current: Request) => {
    try {
      return new Request(current, { headers })
    } catch {
      try {
        for (const name of [...current.headers.keys()]) {
          current.headers.delete(name)
        }
        for (const [name, value] of headers.entries()) {
          current.headers.set(name, value)
        }
      } catch {
        // keep fail-open when an already-consumed request cannot be cloned
      }
      return current
    }
  }

  const normalizedHeaders = Object.fromEntries(headers.entries())
  const normalizedInit = {
    ...(init ?? {}),
    headers: normalizedHeaders,
  }

  if (request instanceof Request) {
    const requestInit = { ...(init ?? {}) }
    delete requestInit.headers
    return {
      request: rewriteRequestHeaders(request),
      init: Object.keys(requestInit).length > 0 ? requestInit : undefined,
    }
  }

  return {
    request,
    init: normalizedInit,
  }
}

function stripDuplicateHeadersFromRequestWhenInitOverrides(
  request: Request | URL | string,
  init?: RequestInit,
): {
  request: Request | URL | string
  init: RequestInit | undefined
} {
  if (!(request instanceof Request) || init?.headers == null) {
    return { request, init }
  }

  const initHeaders = new Headers(init.headers)
  if ([...initHeaders.keys()].length === 0) {
    return { request, init }
  }

  const requestHeaders = new Headers(request.headers)
  let changed = false
  for (const name of initHeaders.keys()) {
    if (requestHeaders.has(name)) {
      requestHeaders.delete(name)
      changed = true
    }
  }
  if (!changed) {
    return { request, init }
  }

  return {
    request: new Request(request, { headers: requestHeaders }),
    init,
  }
}

function getMergedRequestHeader(request: Request | URL | string, init: RequestInit | undefined, name: string) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  for (const [headerName, value] of new Headers(init?.headers).entries()) {
    headers.set(headerName, value)
  }
  return headers.get(name)
}

function getMergedRequestHeadersRecord(request: Request | URL | string, init: RequestInit | undefined) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  for (const [headerName, value] of new Headers(init?.headers).entries()) {
    headers.set(headerName, value)
  }
  return Object.fromEntries(headers.entries())
}

function getFinalSentRequestHeadersRecord(request: Request | URL | string, init: RequestInit | undefined) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  for (const [headerName, value] of new Headers(init?.headers).entries()) {
    headers.set(headerName, value)
  }
  headers.delete("x-opencode-session-id")
  headers.delete(INTERNAL_DEBUG_LINK_HEADER)
  return sanitizeLoggedRequestHeadersRecord(Object.fromEntries(headers.entries()))
}

function hasWechatBridgeClientShape(value: unknown): value is WechatBridgeClientShape {
  if (typeof value !== "object" || value === null) return false
  const client = value as {
    session?: {
      list?: unknown
      status?: unknown
      todo?: unknown
      messages?: unknown
    }
    question?: {
      list?: unknown
    }
    permission?: {
      list?: unknown
    }
  }
  return typeof client.session?.list === "function"
    && typeof client.session?.status === "function"
    && typeof client.session?.todo === "function"
    && typeof client.session?.messages === "function"
    && typeof client.question?.list === "function"
    && typeof client.permission?.list === "function"
}

function hasWechatBridgeSessionShape(value: unknown): value is {
  session: {
    list: unknown
    status: unknown
    todo: unknown
    messages: unknown
  }
  _client?: unknown
} {
  if (typeof value !== "object" || value === null) return false
  const client = value as {
    session?: {
      list?: unknown
      status?: unknown
      todo?: unknown
      messages?: unknown
    }
    _client?: unknown
  }
  return typeof client.session?.list === "function"
    && typeof client.session?.status === "function"
    && typeof client.session?.todo === "function"
    && typeof client.session?.messages === "function"
}

function toWechatBridgeClient(value: unknown): WechatBridgeClientShape | undefined {
  if (hasWechatBridgeClientShape(value)) {
    return value
  }

  if (!hasWechatBridgeSessionShape(value)) {
    return undefined
  }

  const transport = value._client
  if (typeof transport !== "object" || transport === null) {
    return undefined
  }

  const wrapped = new OpencodeV2Client({ client: transport as never })
  return hasWechatBridgeClientShape(wrapped) ? wrapped : undefined
}

export function resolveBridgeCapableBrokerOwnerInput(input: {
  client?: unknown
  serverUrl?: URL
}) {
  if (!input.serverUrl) {
    return undefined
  }

  const client = toWechatBridgeClient(input.client)
  if (!client) {
    return undefined
  }

  return {
    client,
    serverUrl: input.serverUrl,
  }
}

export function isBridgeCapableBrokerOwnerInput(input: {
  client?: unknown
  serverUrl?: URL
}) {
  return resolveBridgeCapableBrokerOwnerInput(input) !== undefined
}

function sanitizeLoggedRequestHeadersRecord(headers: Record<string, string>) {
  const sanitized = { ...headers }
  if (typeof sanitized.authorization === "string" && sanitized.authorization.length > 0) {
    sanitized.authorization = "Bearer [redacted]"
  }
  if (typeof sanitized.Authorization === "string" && sanitized.Authorization.length > 0) {
    sanitized.Authorization = "Bearer [redacted]"
  }
  if (typeof sanitized["x-api-key"] === "string" && sanitized["x-api-key"].length > 0) {
    sanitized["x-api-key"] = "[redacted]"
  }
  return sanitized
}

function toAuthFingerprint(value: string | undefined) {
  if (typeof value !== "string" || value.length === 0) return undefined
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

function getInternalSessionID(request: Request | URL | string, init: RequestInit | undefined) {
  const headerValue = getMergedRequestHeader(request, init, "x-opencode-session-id")
  if (typeof headerValue === "string" && headerValue.length > 0) return headerValue

  const contextValue = (init as RequestInit & { [INTERNAL_SESSION_CONTEXT_KEY]?: unknown } | undefined)?.[INTERNAL_SESSION_CONTEXT_KEY]
  if (typeof contextValue === "string" && contextValue.length > 0) return contextValue

  return ""
}

function stripInternalSessionHeader(request: Request | URL | string, init?: RequestInit) {
  return mergeAndRewriteRequestHeaders(request, init, (headers) => {
    headers.delete("x-opencode-session-id")
    headers.delete(INTERNAL_DEBUG_LINK_HEADER)
  })
}

function toLoadMap(value: CandidateAccountLoads | undefined) {
  if (value instanceof Map) return value

  const loads = new Map<string, number>()
  if (!value) return loads
  for (const [name, count] of Object.entries(value)) {
    if (typeof count !== "number" || Number.isFinite(count) === false) continue
    loads.set(name, count)
  }
  return loads
}

function loadMapToRecord(loads: Map<string, number>, candidateNames: string[]) {
  const result: Record<string, number> = {}
  for (const name of candidateNames) {
    result[name] = loads.get(name) ?? 0
  }
  return result
}

function toReasonByInitiator(initiator: string | null): RouteDecisionEvent["reason"] {
  if (initiator === "agent") return "subagent"
  if (initiator === "user") return "user-reselect"
  return "regular"
}

type RequestClassification = {
  reason: RouteDecisionEvent["reason"]
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function toConsumptionReasonText(reason: RouteDecisionEvent["reason"]) {
  if (reason === "subagent") return "子代理请求"
  if (reason === "compaction") return "上下文压缩"
  if (reason === "user-reselect") return "用户回合重选"
  return "常规请求"
}

function buildConsumptionToast(input: {
  accountName: string
  reason: RouteDecisionEvent["reason"]
  switchFrom?: string
}) {
  if (input.reason === "rate-limit-switch") {
    return {
      message: `已切换到 ${input.accountName}（${input.switchFrom ?? "原账号"} 限流后切换）`,
      variant: "warning" as const,
    }
  }

  if (input.reason === "unbound-fallback") {
    return {
      message: `已使用 ${input.accountName}（异常无绑定 agent 入口，已按用户回合处理）`,
      variant: "warning" as const,
    }
  }

  return {
    message: `已使用 ${input.accountName}（${toConsumptionReasonText(input.reason)}）`,
    variant: "info" as const,
  }
}

function shouldShowConsumptionToast(input: {
  reason: RouteDecisionEvent["reason"]
  isFirstUse: boolean
}) {
  if (input.reason === "regular") return false
  if (input.reason === "subagent") return input.isFirstUse
  if (input.reason === "compaction") return false
  return true
}

function chooseCandidateAccount(input: {
  candidates: ResolvedModelAccountCandidate[]
  sessionID: string
  allowReselect: boolean
  sessionBindings: Map<string, SessionBinding>
  loads: Map<string, number>
  random: () => number
}) {
  const lowest = pickLowestWithRandom(input.candidates, input.loads, input.random)
  const boundName = input.sessionBindings.get(input.sessionID)?.accountName
  const bound = typeof boundName === "string" ? input.candidates.find((item) => item.name === boundName) : undefined

  if (!bound) return lowest
  if (!input.allowReselect) return bound

  const currentLoad = input.loads.get(bound.name) ?? 0
  const minimumLoad = input.loads.get(lowest.name) ?? 0
  if (currentLoad - minimumLoad >= 3) {
    return lowest
  }
  return bound
}

function toSafeReplacementRandomUnit(random: () => number) {
  const value = random()
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1 - Number.EPSILON
  return value
}

function pickLowestWithRandom(
  candidates: ResolvedModelAccountCandidate[],
  loads: Map<string, number>,
  random: () => number,
) {
  const ranked = [...candidates].sort((a, b) => (loads.get(a.name) ?? 0) - (loads.get(b.name) ?? 0))
  const minimum = loads.get(ranked[0].name) ?? 0
  const tied = ranked.filter((item) => (loads.get(item.name) ?? 0) === minimum)
  return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]
}

function pickLowestReplacementWithHardenedRandom(
  candidates: ResolvedModelAccountCandidate[],
  loads: Map<string, number>,
  random: () => number,
) {
  if (candidates.length === 0) return undefined
  const ranked = [...candidates].sort((a, b) => (loads.get(a.name) ?? 0) - (loads.get(b.name) ?? 0))
  const minimum = loads.get(ranked[0].name) ?? 0
  const tied = ranked.filter((item) => (loads.get(item.name) ?? 0) === minimum)
  const pickedIndex = Math.floor(toSafeReplacementRandomUnit(random) * tied.length)
  return tied[pickedIndex] ?? tied[0]
}

function normalizeStoreForRouting(store: StoreFile) {
  const assignments = (store as StoreFile & {
    modelAccountAssignments?: Record<string, unknown>
  }).modelAccountAssignments
  if (!assignments) return store

  let changed = false
  const normalized: Record<string, string[]> = {}
  for (const [modelID, candidate] of Object.entries(assignments as Record<string, unknown>)) {
    if (Array.isArray(candidate)) {
      normalized[modelID] = candidate
      continue
    }
    if (typeof candidate === "string" && candidate.length > 0) {
      normalized[modelID] = [candidate]
      changed = true
      continue
    }
    changed = true
  }

  if (!changed) return store
  return {
    ...store,
    modelAccountAssignments: normalized,
  }
}

function pruneSessionBindings(bindings: Map<string, SessionBinding>, now: number) {
  for (const [sessionID, binding] of bindings.entries()) {
    if (now - binding.lastUsedAt > SESSION_BINDING_IDLE_TTL_MS) {
      bindings.delete(sessionID)
    }
  }

  if (bindings.size <= MAX_SESSION_BINDINGS) return

  const oldest = [...bindings.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
  for (const [sessionID] of oldest) {
    if (bindings.size <= MAX_SESSION_BINDINGS) break
    bindings.delete(sessionID)
  }
}

function pruneTouchWriteCache(input: {
  cache: Map<string, number>
  now: number
  idleTtlMs: number
  maxEntries: number
}) {
  for (const [key, lastWriteAt] of input.cache.entries()) {
    if (input.now - lastWriteAt > input.idleTtlMs) {
      input.cache.delete(key)
    }
  }

  if (input.cache.size <= input.maxEntries) return

  const oldest = [...input.cache.entries()].sort((a, b) => a[1] - b[1])
  for (const [key] of oldest) {
    if (input.cache.size <= input.maxEntries) break
    input.cache.delete(key)
  }
}

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
  loadStoreSync?: () => StoreFile | undefined
  loadCommonSettings?: () => Promise<CommonSettingsStore | undefined>
  loadCommonSettingsSync?: () => CommonSettingsStore | undefined
  writeStore?: (store: StoreFile, meta?: StoreWriteDebugMeta) => Promise<void>
  loadOfficialConfig?: (input: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
    baseFetch?: typeof fetch
    version?: string
  }) => Promise<OfficialCopilotConfig | undefined>
  finalizeRequestForSelection?: (input: {
    request: Request | URL | string
    init?: RequestInit
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
  }) => Promise<
    | {
        request: Request | URL | string
        init?: RequestInit
      }
    | undefined
  >
  loadOfficialChatHeaders?: (input: { client?: object; directory?: string }) => Promise<OfficialChatHeadersHook>
  createRetryFetch?: (fetch: FetchLike, ctx?: CopilotRetryContext) => FetchLike
  client?: CopilotRetryContext["client"]
  project?: {
    id?: string
    name?: string
  }
  directory?: CopilotRetryContext["directory"]
  serverUrl?: CopilotRetryContext["serverUrl"]
  ensureWechatBrokerStarted?: () => Promise<unknown>
  initialWechatBrokerPromise?: WechatBridgeLifecycleInput["initialBrokerPromise"]
  createWechatBridgeLifecycleImpl?: (input: WechatBridgeLifecycleInput) => Promise<{ close: () => Promise<void> }>
  clearAccountSwitchContext?: (lastAccountSwitchAt?: number) => Promise<void>
  now?: () => number
  refreshQuota?: RefreshQuota
  handleStatusCommandImpl?: StatusCommandHandler
  handleCodexStatusCommandImpl?: CodexStatusCommandHandler
  handleCompactCommandImpl?: CompactCommandHandler
  handleStopToolCommandImpl?: StopToolCommandHandler
  loadCandidateAccountLoads?: (input: {
    sessionID: string
    modelID?: string
    store: StoreFile
    candidates: ResolvedModelAccountCandidate[]
  }) => Promise<CandidateAccountLoads | undefined>
  routingStateDirectory?: string
  appendSessionTouchEventImpl?: (input: AppendSessionTouchEventInput) => Promise<boolean>
  appendRoutingEventImpl?: (input: { directory: string; event: RoutingEvent }) => Promise<void>
  appendRouteDecisionEventImpl?: (input: { directory: string; event: RouteDecisionEvent }) => Promise<void>
  readRoutingStateImpl?: (directory: string) => Promise<RoutingSnapshot>
  triggerBillingCompensation?: (input: TriggerBillingCompensationInput) => Promise<void>
  touchWriteCacheIdleTtlMs?: number
  touchWriteCacheMaxEntries?: number
  random?: () => number
  authLoaderMode?: "copilot" | "codex" | "none"
  enableModelRouting?: boolean
}): CopilotPluginHooksWithChatHeaders {
  const authProvider = input.auth.provider ?? COPILOT_PROVIDER_DESCRIPTOR.providerIDs[0] ?? "github-copilot"
  const authLoaderMode = input.authLoaderMode
    ?? (isCopilotProviderID(authProvider) ? "copilot" : isCodexProviderID(authProvider) ? "codex" : "none")
  const enableCopilotAuthLoader = authLoaderMode === "copilot"
  const enableCodexAuthLoader = authLoaderMode === "codex"
  const enableModelRouting = input.enableModelRouting ?? enableCopilotAuthLoader
  const compactionLoopSafetyBypass = createCompactionLoopSafetyBypass()
  const loadStore = input.loadStore ?? readStoreSafe
  const loadStoreSync = input.loadStoreSync ?? readStoreSafeSync
  const loadCommonSettings = input.loadCommonSettings
  const loadCommonSettingsSync = input.loadCommonSettingsSync
  const persistStore = (store: StoreFile, meta?: StoreWriteDebugMeta) => {
    if (input.writeStore) return input.writeStore(store, meta)
    return writeStore(store, { debug: meta })
  }
  const refreshQuota = input.refreshQuota ?? ((store: StoreFile) => refreshActiveAccountQuota({ store }))
  const handleStatusCommandImpl = input.handleStatusCommandImpl ?? handleStatusCommand
  const handleCodexStatusCommandImpl = input.handleCodexStatusCommandImpl ?? handleCodexStatusCommand
  const handleCompactCommandImpl = input.handleCompactCommandImpl ?? handleCompactCommand
  const handleStopToolCommandImpl = input.handleStopToolCommandImpl ?? handleStopToolCommand
  const loadOfficialConfigForCopilot = (args: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
    baseFetch?: typeof fetch
    version?: string
  }) => {
    if (input.loadOfficialConfig) {
      return (input.loadOfficialConfig as (input: typeof args) => Promise<OfficialCopilotConfig | undefined>)(args)
    }
    return loadOfficialCopilotConfig(args)
  }
  const loadOfficialConfigForCodex = (args: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
    baseFetch?: typeof fetch
    version?: string
  }) => {
    if (input.loadOfficialConfig) {
      return (input.loadOfficialConfig as (input: typeof args) => Promise<{ fetch: FetchLike } | undefined>)(args)
    }
    return loadOfficialCodexConfig({
      getAuth: args.getAuth,
      baseFetch: args.baseFetch,
      version: args.version,
      client: input.client as {
        auth?: {
          set?: (value: unknown) => Promise<unknown>
        }
      } | undefined,
    })
  }
  const resolveOfficialChatHeaders: LoadOfficialChatHeaders = enableCopilotAuthLoader
    ? input.loadOfficialChatHeaders ?? loadOfficialCopilotChatHeaders
    : enableCodexAuthLoader
    ? loadOfficialCodexChatHeaders as unknown as LoadOfficialChatHeaders
    : (async () => async () => {})
  const createRetryFetch = input.createRetryFetch
    ?? (enableCodexAuthLoader ? createCodexRetryingFetch : createCopilotRetryingFetch)
  const now = input.now ?? (() => Date.now())
  const random = input.random ?? Math.random
  let injectArmed = false
  let policyScopeOverride: LoopSafetyProviderScope | undefined
  const modelAccountFirstUse = new Set<string>()
  const sessionAccountBindings = new Map<string, SessionBinding>()
  const rateLimitQueues = new Map<string, number[]>()
  const lastTouchWrites = new Map<string, number>()
  const routingDirectory = input.routingStateDirectory ?? routingStatePath()
  const touchWriteCacheIdleTtlMs = input.touchWriteCacheIdleTtlMs ?? TOUCH_WRITE_CACHE_IDLE_TTL_MS
  const touchWriteCacheMaxEntries = input.touchWriteCacheMaxEntries ?? MAX_TOUCH_WRITE_CACHE_ENTRIES
  const appendSessionTouchEventImpl = input.appendSessionTouchEventImpl ?? appendSessionTouchEvent
  const appendRoutingEventImpl = input.appendRoutingEventImpl ?? appendRoutingEvent
  const appendRouteDecisionEventImpl = input.appendRouteDecisionEventImpl ?? appendRouteDecisionEvent
  const readRoutingStateImpl = input.readRoutingStateImpl ?? readRoutingState
  const triggerBillingCompensation = input.triggerBillingCompensation ?? (async () => {})
  const createWechatBridgeLifecycleImpl = input.createWechatBridgeLifecycleImpl ?? createWechatBridgeLifecycle

  const bridgeCapableBrokerOwnerInput = resolveBridgeCapableBrokerOwnerInput({
    client: input.client,
    serverUrl: input.serverUrl,
  })
  const wechatBridgeClient = bridgeCapableBrokerOwnerInput?.client
  const wechatBridgeLifecycleKey = bridgeCapableBrokerOwnerInput
    ? buildWechatBridgeLifecycleKey({
        directory: input.directory,
        serverUrl: bridgeCapableBrokerOwnerInput.serverUrl,
        project: input.project,
      })
    : undefined
  const wechatBridgeSessionContext = wechatBridgeLifecycleKey
    ? ensureWechatBridgeSessionState(wechatBridgeLifecycleKey)
    : undefined

  if (wechatBridgeClient) {
    void showStatusToast({
      client: input.client,
      message: "正在尝试连接或拉起 WeChat broker...",
      variant: "info",
      warn: (scope, error) => {
        console.warn(`[${scope}] failed to show toast`, error)
      },
    })
  }

  if (bridgeCapableBrokerOwnerInput && wechatBridgeLifecycleKey) {
    const bridgeCapableClient = bridgeCapableBrokerOwnerInput.client

    attachWechatBridgeAutoClose()
    void ensureWechatBridgeLifecycle({
      key: wechatBridgeLifecycleKey,
      create: async () => {
        return createWechatBridgeLifecycleImpl({
          client: bridgeCapableClient,
          project: input.project,
          directory: input.directory,
          serverUrl: bridgeCapableBrokerOwnerInput.serverUrl,
          initialBrokerPromise: input.initialWechatBrokerPromise,
          statusCollectionEnabled: true,
          getActiveSessionID: () => getWechatBridgeActiveSessionID(wechatBridgeSessionContext),
          onFallbackToast: async (payload) => {
            await showStatusToast({
              client: input.client,
              message: payload.message,
              variant: "warning",
              warn: (scope, error) => {
                console.warn(`[${scope}] failed to show toast`, error)
              },
            })
          },
        })
      },
    }).catch(() => {})
  }

  const loadCandidateAccountLoads = input.loadCandidateAccountLoads ?? (async (ctx: {
    candidates: ResolvedModelAccountCandidate[]
  }) => {
    const snapshot = await readRoutingStateImpl(routingDirectory)
    return buildCandidateAccountLoads({
      snapshot,
      candidateAccountNames: ctx.candidates.map((item) => item.name),
      now: now(),
    })
  })

  const getPolicyScope = (store: StoreFile | undefined) => getLoopSafetyProviderScope(store, policyScopeOverride)

  const loadMergedStore = async () => {
    const [store, common] = await Promise.all([
      loadStore().catch(() => undefined),
      loadCommonSettings?.().catch(() => undefined),
    ])
    return mergeStoreWithCommonSettings(store, common)
  }

  const loadMergedStoreSync = () => mergeStoreWithCommonSettings(loadStoreSync(), loadCommonSettingsSync?.())

  const isNetworkRetryEnabled = async (retryStore?: RetryStoreContext) => {
    if (loadCommonSettings) {
      const common = await loadCommonSettings().catch(() => undefined)
      if (common?.networkRetryEnabled === true) return true
      if (common?.networkRetryEnabled === false) return false
    }

    if (retryStore) return retryStore.networkRetryEnabled === true
    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    return store?.networkRetryEnabled === true
  }

  const showInjectToast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    await showStatusToast({
      client: input.client,
      message,
      variant,
      warn: (scope, error) => {
        console.warn(`[${scope}] failed to show toast`, error)
      },
    })
  }

  const lookupSessionAncestry = async (sessionID: string) => {
    const session = await (input.client?.session?.get as undefined | ((input: {
      path: {
        id: string
      }
      query?: {
        directory?: string
      }
      throwOnError?: boolean
    }) => Promise<SessionGetResponse | undefined>))?.({
      path: {
        id: sessionID,
      },
      query: {
        directory: input.directory,
      },
      throwOnError: true,
    })

    return [{
      sessionID,
      parentID: typeof session?.data?.parentID === "string" && session.data.parentID.length > 0
        ? session.data.parentID
        : undefined,
    }]
  }

  const classifyRequestReason = async (requestInput: {
    sessionID: string
    hasExistingBinding: boolean
    request: Request | URL | string
    init?: RequestInit
  }): Promise<RequestClassification> => {
    const initiator = getMergedRequestHeader(requestInput.request, requestInput.init, "x-initiator")
    if (initiator !== "agent") {
      return {
        reason: toReasonByInitiator(initiator),
      }
    }

    const sessionClient = input.client?.session
    const sessionLookup = sessionClient?.get as undefined | ((input: {
      path: { id: string }
      query?: { directory?: string }
      throwOnError?: boolean
    }) => Promise<SessionGetResponse | undefined>)
    const messageLookup = sessionClient?.message as undefined | ((input: {
      path: { id: string; messageID: string }
      query?: { directory?: string }
      throwOnError?: boolean
    }) => Promise<{ data?: { parts?: Array<DebugPart> } } | undefined>)

    const messageIDHeader = getMergedRequestHeader(requestInput.request, requestInput.init, INTERNAL_DEBUG_LINK_HEADER)
    if (typeof messageIDHeader === "string" && messageIDHeader.length > 0) {
      const currentMessage = await messageLookup?.call(sessionClient, {
        path: {
          id: requestInput.sessionID,
          messageID: messageIDHeader,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }).catch(() => undefined)
      const parts = Array.isArray(currentMessage?.data?.parts) ? currentMessage.data.parts : undefined
      if (parts?.some((part) => part?.type === "compaction") === true) {
        return {
          reason: "compaction",
        }
      }
    }

    const session = await sessionLookup?.call(sessionClient, {
      path: {
        id: requestInput.sessionID,
      },
      query: {
        directory: input.directory,
      },
      throwOnError: true,
    }).catch(() => undefined)
    const canDetermineSessionAncestry = session !== undefined
    const isTrueChildSession = typeof session?.data?.parentID === "string" && session.data.parentID.length > 0
    if (canDetermineSessionAncestry && !isTrueChildSession && requestInput.hasExistingBinding === false) {
      return {
        reason: "unbound-fallback",
      }
    }
    return {
      reason: isTrueChildSession ? "subagent" : "regular",
    }
  }

  const getLatestLastAccountSwitchAt = async () => {
    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    return store?.lastAccountSwitchAt
  }

  const clearAccountSwitchContext = input.clearAccountSwitchContext ?? (async (capturedLastAccountSwitchAt?: number) => {
    if (capturedLastAccountSwitchAt === undefined) return

    try {
      const latestStore = await loadStore().catch(() => undefined)
      if (!latestStore) return
      if (latestStore.lastAccountSwitchAt !== capturedLastAccountSwitchAt) return
      delete latestStore.lastAccountSwitchAt
      await persistStore(latestStore, {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      })
    } catch (error) {
      console.warn("[plugin-hooks] failed to clear account-switch context", error)
    }
  })

  const loader: AuthLoader = async (getAuth, provider) => {
    const authOverride = new AsyncLocalStorage<CopilotAuthState | undefined>()
    const finalHeaderCapture = new AsyncLocalStorage<((headers: Record<string, string>) => void) | undefined>()
    const getScopedAuth = async () => authOverride.getStore() ?? getAuth()
    const providerConfig = provider as unknown as CopilotProviderConfig | undefined
    const loadOfficialConfig = enableCodexAuthLoader ? loadOfficialConfigForCodex : loadOfficialConfigForCopilot
    const config = await loadOfficialConfig({
      getAuth: getScopedAuth as () => Promise<CopilotAuthState | undefined>,
      provider: providerConfig,
      ...(input.loadOfficialConfig == null
        ? {
            baseFetch: async (nextRequest, nextInit) => {
              finalHeaderCapture.getStore()?.(getFinalSentRequestHeadersRecord(nextRequest, nextInit))
              return fetch(nextRequest, nextInit)
            },
          }
        : {}),
    })
    if (!config) return {}

    const finalizeRequestForSelection = input.finalizeRequestForSelection
      ?? (input.loadOfficialConfig
        ? undefined
        : async (selectionInput: {
            request: Request | URL | string
            init?: RequestInit
          }) => {
            let captured:
              | {
                  request: Request | URL | string
                  init?: RequestInit
                }
              | undefined

            const captureConfig = await loadOfficialConfig({
              getAuth: getScopedAuth as () => Promise<CopilotAuthState | undefined>,
              provider: providerConfig,
              baseFetch: async (nextRequest, nextInit) => {
                captured = {
                  request: nextRequest,
                  init: nextInit,
                }
                return new Response("{}", {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                })
              },
            })
            if (!captureConfig) return undefined

            const inspectionRequest = selectionInput.request instanceof Request
              ? selectionInput.request.clone()
              : selectionInput.request
            await captureConfig.fetch(inspectionRequest, selectionInput.init).catch(() => undefined)
            return captured
          })

    const store = await loadStore().catch(() => undefined)
    const retryStore = readRetryStoreContext(store)
    const fetchWithModelAccount = async (request: Request | URL | string, init?: RequestInit) => {
      const latestStoreRaw = await loadStore().catch(() => undefined)
      const latestStore = latestStoreRaw ? normalizeStoreForRouting(latestStoreRaw) : undefined
      const modelID = await readRequestModelID(request, init)
      const requestAt = now()
      pruneSessionBindings(sessionAccountBindings, requestAt)
      pruneTouchWriteCache({
        cache: lastTouchWrites,
        now: requestAt,
        idleTtlMs: touchWriteCacheIdleTtlMs,
        maxEntries: touchWriteCacheMaxEntries,
      })
      const sessionID = getInternalSessionID(request, init)
      const finalized = await finalizeRequestForSelection?.({
        request,
        init,
        getAuth: getScopedAuth as () => Promise<CopilotAuthState | undefined>,
        provider: providerConfig,
      }).catch(() => undefined)
      const selectionRequest = finalized?.request ?? request
      const selectionInit = finalized?.init ?? init
      const initiator = getMergedRequestHeader(selectionRequest, selectionInit, "x-initiator")
      const candidates = latestStore ? resolveCopilotModelAccounts(latestStore, modelID) : []
      if (candidates.length === 0) {
        const outbound = stripInternalSessionHeader(selectionRequest, selectionInit)
        return config.fetch(outbound.request, outbound.init)
      }

      const hasExistingBinding = sessionID.length > 0 && sessionAccountBindings.has(sessionID)
      const classification = sessionID.length > 0
        ? await classifyRequestReason({
            sessionID,
            hasExistingBinding,
            request: selectionRequest,
            init: selectionInit,
          })
        : {
            reason: toReasonByInitiator(initiator),
          }
      const selectionAllowReselect = classification.reason === "user-reselect"
        || classification.reason === "unbound-fallback"
      const hasExplicitModelGroup = Boolean(
        latestStore
        && typeof modelID === "string"
        && modelID.length > 0
        && latestStore.modelAccountAssignments
        && Object.prototype.hasOwnProperty.call(latestStore.modelAccountAssignments, modelID),
      )
      const hasUsableExplicitModelCandidate = candidates.some((item) => item.source === "model")
      if (hasExplicitModelGroup && !hasUsableExplicitModelCandidate) {
        throw new Error(`No usable account for model ${modelID}`)
      }
      const loads = latestStore && candidates.length > 0
        ? toLoadMap(await loadCandidateAccountLoads({
          sessionID,
          modelID,
          store: latestStore,
          candidates,
        }).catch(() => undefined))
        : new Map<string, number>()
      const resolved = candidates.length > 0
        ? chooseCandidateAccount({
          candidates,
          sessionID,
          allowReselect: selectionAllowReselect,
          sessionBindings: sessionAccountBindings,
          loads,
          random,
        })
        : undefined
      if (!resolved) {
        const outbound = stripInternalSessionHeader(selectionRequest, selectionInit)
        return config.fetch(outbound.request, outbound.init)
      }

      const candidateNames = candidates.map((item) => item.name)
      let decisionLoads = loadMapToRecord(loads, candidateNames)
      let decisionReason: RouteDecisionEvent["reason"] = classification.reason
      let decisionSwitched = false
      let decisionSwitchFrom: string | undefined
      let decisionSwitchBlockedBy: RouteDecisionEvent["switchBlockedBy"]
      let decisionRateLimitMatched = false
      let decisionRetryAfterMs: number | undefined
      let decisionTouchWriteOutcome: RouteDecisionEvent["touchWriteOutcome"] = "skipped-missing-session"
      let decisionTouchWriteError: string | undefined
      let finalChosenAccount = resolved.name
      let chosenAccountAuthFingerprint = toAuthFingerprint(resolved.entry.refresh)
      let finalRequestHeaders = getFinalSentRequestHeadersRecord(selectionRequest, selectionInit)
      let networkRequestHeaders: Record<string, string> | undefined
      let networkRequestUsedInitHeaders = selectionInit?.headers != null

      const previousBindingAccount = sessionID.length > 0 ? sessionAccountBindings.get(sessionID)?.accountName : undefined
      const debugLinkId = getMergedRequestHeader(selectionRequest, selectionInit, INTERNAL_DEBUG_LINK_HEADER) ?? undefined

      if (sessionID.length > 0) {
        sessionAccountBindings.set(sessionID, {
          accountName: resolved.name,
          lastUsedAt: requestAt,
        })

        try {
          const wrote = await appendSessionTouchEventImpl({
            directory: routingDirectory,
            accountName: resolved.name,
            sessionID,
            at: requestAt,
            lastTouchWrites,
          })
          decisionTouchWriteOutcome = wrote ? "written" : "throttled"
        } catch (error) {
          decisionTouchWriteOutcome = "failed"
          decisionTouchWriteError = toErrorMessage(error)
        }
      }

      const isFirstUse = modelAccountFirstUse.has(resolved.name) === false
      if (isFirstUse) {
        modelAccountFirstUse.add(resolved.name)
      }

      let nextRequest = selectionRequest
      let nextInit = selectionInit
      const currentInitiator = getMergedRequestHeader(selectionRequest, selectionInit, "x-initiator")
      const shouldStripAgentInitiator = classification.reason === "unbound-fallback"
        || (isFirstUse && currentInitiator === "agent")
      if (shouldStripAgentInitiator && currentInitiator === "agent") {
        const rewritten = mergeAndRewriteRequestHeaders(selectionRequest, selectionInit, (headers) => {
          headers.delete("x-initiator")
        })
        nextRequest = rewritten.request
        nextInit = rewritten.init
      }

      const auth: CopilotAuthState = {
        type: "oauth",
        refresh: resolved.entry.refresh,
        access: resolved.entry.access,
        expires: resolved.entry.expires,
        enterpriseUrl: resolved.entry.enterpriseUrl,
      }

      const sendBillingCompensationIfNeeded = async (input: {
        nextAccountName: string
        at: number
        retryAfterMs?: number
      }) => {
        if (sessionID.length === 0) return
        if (typeof previousBindingAccount !== "string" || previousBindingAccount.length === 0) return
        if (previousBindingAccount === input.nextAccountName) return

        await triggerBillingCompensation({
          fromAccountName: previousBindingAccount,
          toAccountName: input.nextAccountName,
          sessionID,
          modelID,
          at: input.at,
          retryAfterMs: input.retryAfterMs,
        }).catch(() => undefined)
      }

      const sendWithAccount = async (candidate: ResolvedModelAccountCandidate, requestValue: Request | URL | string, initValue: RequestInit | undefined) => {
        const candidateAuth: CopilotAuthState = {
          type: "oauth",
          refresh: candidate.entry.refresh,
          access: candidate.entry.access,
          expires: candidate.entry.expires,
          enterpriseUrl: candidate.entry.enterpriseUrl,
        }
        const deduplicated = stripDuplicateHeadersFromRequestWhenInitOverrides(requestValue, initValue)
        const outbound = stripInternalSessionHeader(deduplicated.request, deduplicated.init)
        return finalHeaderCapture.run(
          (headers) => {
            finalRequestHeaders = headers
            networkRequestHeaders = headers
            networkRequestUsedInitHeaders = outbound.init?.headers != null
          },
          () => authOverride.run(candidateAuth, () => config.fetch(
            rewriteRequestForAccount(outbound.request, candidate.entry.enterpriseUrl),
            outbound.init,
          )),
        )
      }

      const response = await sendWithAccount(resolved, nextRequest, nextInit)

      const observedAt = now()
      let rateLimitEvidence: { matched: boolean; retryAfterMs?: number } = { matched: false }
      try {
        rateLimitEvidence = await detectRateLimitEvidence(response)
      } catch {
        rateLimitEvidence = { matched: false }
      }
      if (rateLimitEvidence.matched) {
        decisionRateLimitMatched = true
        decisionRetryAfterMs = rateLimitEvidence.retryAfterMs
        const existingQueue = rateLimitQueues.get(resolved.name) ?? []
        const cutoff = observedAt - RATE_LIMIT_WINDOW_MS
        const queue = existingQueue.filter((at) => at >= cutoff)
        queue.push(observedAt)
        rateLimitQueues.set(resolved.name, queue)

        if (queue.length >= RATE_LIMIT_HIT_THRESHOLD) {
          if (queue.length === RATE_LIMIT_HIT_THRESHOLD) {
            await appendRoutingEventImpl({
              directory: routingDirectory,
              event: {
                type: "rate-limit-flagged",
                accountName: resolved.name,
                at: observedAt,
                retryAfterMs: rateLimitEvidence.retryAfterMs,
              },
            }).catch(() => undefined)
          }

          let routingSnapshot: RoutingSnapshot | undefined
          try {
            routingSnapshot = await readRoutingStateImpl(routingDirectory)
          } catch {
            routingSnapshot = undefined
            decisionSwitchBlockedBy = "routing-state-read-failed"
          }

          if (routingSnapshot) {
            const nextLoads = buildCandidateAccountLoads({
              snapshot: routingSnapshot,
              candidateAccountNames: candidates.map((item) => item.name),
              now: observedAt,
            })
            decisionLoads = loadMapToRecord(nextLoads, candidateNames)
            const currentLoad = nextLoads.get(resolved.name) ?? (loads.get(resolved.name) ?? 0)
            const replacementCandidates = [...candidates].filter((item) => item.name !== resolved.name)
            const cooledCandidates = replacementCandidates
              .filter((item) => item.name !== resolved.name)
              .filter((item) => isAccountRateLimitCooledDown({
                snapshot: routingSnapshot!,
                accountName: item.name,
                now: observedAt,
                cooldownMs: RATE_LIMIT_COOLDOWN_MS,
              }))
            const replacements = cooledCandidates.filter((item) => (nextLoads.get(item.name) ?? 0) <= currentLoad)
            const replacement = pickLowestReplacementWithHardenedRandom(replacements, nextLoads, random)

            if (!replacement) {
              if (replacementCandidates.length === 0) {
                decisionSwitchBlockedBy = "no-replacement-candidate"
              } else if (cooledCandidates.length === 0) {
                decisionSwitchBlockedBy = "no-cooled-down-candidate"
              } else if (replacements.length === 0) {
                decisionSwitchBlockedBy = "replacement-load-higher"
              } else {
                decisionSwitchBlockedBy = "no-replacement-candidate"
              }
            }

              if (replacement) {
              let retriedRequest = nextRequest
              let retriedInit = nextInit
              const rawPayload = await readRequestBody(nextRequest, nextInit)
                if (typeof rawPayload === "string") {
                try {
                  const parsed = JSON.parse(rawPayload) as Record<string, unknown>
                  const cleaned = await cleanupLongIdsForAccountSwitch({ payload: parsed })
                  if (cleaned.changed) {
                    const rewritten = mergeAndRewriteRequestHeaders(nextRequest, nextInit, (headers) => {
                      if (!headers.has("content-type")) headers.set("content-type", "application/json")
                    })
                    retriedRequest = rewritten.request
                    retriedInit = {
                      ...(rewritten.init ?? {}),
                      body: JSON.stringify(cleaned.payload),
                    }
                  }
                } catch {
                  // keep fail-open on payload parse failures
                }
                }

                finalRequestHeaders = getFinalSentRequestHeadersRecord(retriedRequest, retriedInit)

                if (sessionID.length > 0) {
                sessionAccountBindings.set(sessionID, {
                  accountName: replacement.name,
                  lastUsedAt: observedAt,
                })

                try {
                  const wrote = await appendSessionTouchEventImpl({
                    directory: routingDirectory,
                    accountName: replacement.name,
                    sessionID,
                    at: observedAt,
                    lastTouchWrites,
                  })
                  decisionTouchWriteOutcome = wrote ? "written" : "throttled"
                  decisionTouchWriteError = undefined
                } catch (error) {
                  decisionTouchWriteOutcome = "failed"
                  decisionTouchWriteError = toErrorMessage(error)
                }
              }

              decisionReason = "rate-limit-switch"
              decisionSwitched = true
              decisionSwitchFrom = resolved.name
              decisionSwitchBlockedBy = undefined
              finalChosenAccount = replacement.name
              chosenAccountAuthFingerprint = toAuthFingerprint(replacement.entry.refresh)

              modelAccountFirstUse.add(replacement.name)
              const switchToast = buildConsumptionToast({
                accountName: replacement.name,
                reason: "rate-limit-switch",
                switchFrom: resolved.name,
              })
              await showStatusToast({
                client: input.client,
                message: switchToast.message,
                variant: switchToast.variant,
                warn: (scope, error) => {
                  console.warn(`[${scope}] failed to show toast`, error)
                },
              }).catch(() => undefined)

              await sendBillingCompensationIfNeeded({
                nextAccountName: replacement.name,
                at: observedAt,
                retryAfterMs: rateLimitEvidence.retryAfterMs,
              })

              await appendRouteDecisionEventImpl({
                directory: routingDirectory,
                event: {
                  type: "route-decision",
                  at: observedAt,
                  modelID,
                  sessionID: sessionID.length > 0 ? sessionID : undefined,
                  sessionIDPresent: sessionID.length > 0,
                  groupSource: resolved.source,
                  candidateNames,
                    loads: decisionLoads,
                    chosenAccount: finalChosenAccount,
                    chosenAccountAuthFingerprint,
                    debugLinkId,
                    networkRequestUsedInitHeaders,
                    reason: decisionReason,
                    switched: decisionSwitched,
                  switchFrom: decisionSwitchFrom,
                  switchBlockedBy: decisionSwitchBlockedBy,
                    touchWriteOutcome: decisionTouchWriteOutcome,
                    touchWriteError: decisionTouchWriteError,
                    rateLimitMatched: decisionRateLimitMatched,
                    retryAfterMs: decisionRetryAfterMs,
                    finalRequestHeaders,
                    networkRequestHeaders,
                  },
                }).catch(() => undefined)

              return sendWithAccount(replacement, retriedRequest, retriedInit)
            }
          }
        }
      }

      await sendBillingCompensationIfNeeded({
        nextAccountName: finalChosenAccount,
        at: observedAt,
      })

      await appendRouteDecisionEventImpl({
        directory: routingDirectory,
        event: {
          type: "route-decision",
          at: observedAt,
          modelID,
          sessionID: sessionID.length > 0 ? sessionID : undefined,
          sessionIDPresent: sessionID.length > 0,
          groupSource: resolved.source,
          candidateNames,
          loads: decisionLoads,
          chosenAccount: finalChosenAccount,
          chosenAccountAuthFingerprint,
          debugLinkId,
          networkRequestUsedInitHeaders,
          reason: decisionReason,
          switched: decisionSwitched,
          switchFrom: decisionSwitchFrom,
          switchBlockedBy: decisionSwitchBlockedBy,
          touchWriteOutcome: decisionTouchWriteOutcome,
          touchWriteError: decisionTouchWriteError,
          rateLimitMatched: decisionRateLimitMatched,
          retryAfterMs: decisionRetryAfterMs,
          finalRequestHeaders,
          networkRequestHeaders,
        },
      }).catch(() => undefined)

      if (shouldShowConsumptionToast({ reason: decisionReason, isFirstUse })) {
        const consumptionToast = buildConsumptionToast({
          accountName: finalChosenAccount,
          reason: decisionReason,
          switchFrom: decisionSwitchFrom,
        })
        await showStatusToast({
          client: input.client,
          message: consumptionToast.message,
          variant: consumptionToast.variant,
          warn: (scope, error) => {
            console.warn(`[${scope}] failed to show toast`, error)
          },
        }).catch(() => undefined)
      }

      return response
    }

    const providerFetch = enableModelRouting
      ? fetchWithModelAccount
      : async (request: Request | URL | string, init?: RequestInit) => {
          const outbound = stripInternalSessionHeader(request, init)
          return config.fetch(outbound.request, outbound.init)
        }

    const networkRetryEnabled = await isNetworkRetryEnabled(retryStore)

    if (networkRetryEnabled !== true) return {
      ...config,
      fetch: providerFetch,
    }

    return {
      ...config,
      fetch: createRetryFetch(providerFetch, {
        client: input.client,
        directory: input.directory,
        serverUrl: input.serverUrl,
        lastAccountSwitchAt: retryStore?.lastAccountSwitchAt,
        notifier: createCopilotRetryNotifier({
          client: input.client,
          lastAccountSwitchAt: retryStore?.lastAccountSwitchAt,
          getLastAccountSwitchAt: getLatestLastAccountSwitchAt,
          clearAccountSwitchContext,
          now: input.now,
        }),
        clearAccountSwitchContext: async () => clearAccountSwitchContext(retryStore?.lastAccountSwitchAt),
      }),
    }
  }

  const codexLoader: AuthLoader = async (getAuth) => {
    const config = await loadOfficialConfigForCodex({
      getAuth: getAuth as () => Promise<CopilotAuthState | undefined>,
    }).catch(() => undefined)
    if (!config || typeof config.fetch !== "function") return {}

    if (await isNetworkRetryEnabled()) {
      return {
        ...config,
        fetch: createRetryFetch(config.fetch as FetchLike),
      }
    }

    return {
      ...config,
      fetch: config.fetch as FetchLike,
    }
  }

  const officialChatHeaders = (enableCopilotAuthLoader || enableCodexAuthLoader)
    ? resolveOfficialChatHeaders({
        client: input.client,
        directory: input.directory,
      })
    : Promise.resolve(async () => {})

  const chatHeaders: ChatHeadersHook = async (hookInput, output) => {
    trackWechatBridgeInteractedSession(wechatBridgeSessionContext, hookInput.sessionID)

    if (enableCodexAuthLoader) {
      if (hookInput.model.providerID !== authProvider) return
      await (await officialChatHeaders)(hookInput, output)
      return
    }

    if (!enableCopilotAuthLoader || !isCopilotProviderID(hookInput.model.providerID)) return
    const headersBeforeOfficial = { ...output.headers }
    await (await officialChatHeaders)(hookInput, output)

    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    const initiatorBeforeOfficial = headersBeforeOfficial["x-initiator"]
    const initiatorAfterOfficial = output.headers["x-initiator"]
    const officialWroteInitiator = initiatorAfterOfficial !== initiatorBeforeOfficial
    const messageID = hookInput.message.id
    const shouldCheckSyntheticInitiator =
      store?.syntheticAgentInitiatorEnabled === true
      && officialWroteInitiator !== true
      && typeof messageID === "string"
      && messageID.length > 0

    if (shouldCheckSyntheticInitiator) {
      const currentMessage = await (input.client?.session?.message as undefined | ((input: {
        path: {
          id: string
          messageID: string
        }
        query?: {
          directory?: string
        }
        throwOnError?: boolean
      }) => Promise<{ data?: { parts?: Array<DebugPart> } } | undefined>))?.({
        path: {
          id: hookInput.message.sessionID ?? hookInput.sessionID,
          messageID,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }).catch(() => undefined)
      const currentParts = Array.isArray(currentMessage?.data?.parts) ? currentMessage.data.parts as Array<DebugPart> : undefined
      const hasSyntheticTextPart = currentParts?.some((part) => part?.type === "text" && part?.synthetic === true) === true

      if (hasSyntheticTextPart) {
        output.headers["x-initiator"] = "agent"
      }
    }

    if (isDebugEnabled()) {
      const currentMessage = await input.client?.session?.message?.({
        path: {
          id: hookInput.message.sessionID ?? hookInput.sessionID,
          messageID: hookInput.message.id,
        },
      }).catch(() => undefined)
      const session = await input.client?.session?.get?.({
        path: {
          id: hookInput.sessionID,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }).catch(() => undefined)
      const recentMessages = await input.client?.session?.messages?.({
        path: {
          id: hookInput.sessionID,
        },
      }).catch(() => undefined)
      const currentParts = Array.isArray(currentMessage?.data?.parts) ? currentMessage.data.parts as Array<DebugPart> : []
      const currentTextParts = toCurrentMessageTextParts(currentParts)
      const messageList = (recentMessages?.data ?? []) as Array<DebugSessionMessage>
      const assistantMessages = messageList.filter((message) => message?.info?.role === "assistant")
      const nearestAssistant = assistantMessages[0]

      debugLog("chat.headers evidence", {
        evidence: {
          session_id: hookInput.sessionID,
          message_id: hookInput.message.id,
          message_session_id: hookInput.message.sessionID,
          model_provider_id: hookInput.model.providerID,
          model_api_npm: hookInput.model.api?.npm,
          current_message_part_types: toPartTypeList(currentParts),
          current_message_text_parts: currentTextParts,
          session_parent_id_present: typeof session?.data?.parentID === "string",
          direct_parent_assistant: nearestAssistant
            ? {
                id: nearestAssistant.info?.id,
                summary: nearestAssistant.summary === true,
                finish: nearestAssistant.finish,
              }
            : undefined,
          recent_messages: messageList.slice(0, 4).map((message) => ({
            id: message.info?.id,
            role: message.info?.role,
            parent_id_present: typeof message.parentID === "string",
            summary: message.summary === true,
            finish: message.finish,
            part_types: toPartTypeList(message.parts as Array<DebugPart> | undefined),
          })),
          headers_before_official: headersBeforeOfficial,
          headers_after_official: { ...output.headers },
        },
        candidates: {
          synthetic_text_count: currentTextParts.filter((part) => Boolean(part.synthetic)).length,
          matches_continue_template: currentTextParts.some((part) => /continue/i.test(part.preview)),
          parent_assistant_is_summary: nearestAssistant?.summary === true,
          latest_assistant_is_summary: assistantMessages[0]?.summary === true,
        },
      })
    }
    output.headers[INTERNAL_DEBUG_LINK_HEADER] = hookInput.message.id
    output.headers["x-opencode-session-id"] = hookInput.sessionID
  }

  return {
    event: async ({ event }) => {
      handleWechatBridgeEvent(wechatBridgeSessionContext, event)
    },
    auth: {
      ...input.auth,
      provider: authProvider,
      methods: input.auth.methods,
      loader: enableCopilotAuthLoader ? loader : (enableCodexAuthLoader ? codexLoader : undefined),
    } as AuthProvider extends never ? never : NonNullable<CopilotPluginHooks["auth"]>,
    config: async (config) => {
      if (!config.command) config.command = {}
      const store = loadMergedStoreSync()
      if (!areExperimentalSlashCommandsEnabled(store)) {
        return
      }
      if (enableCodexAuthLoader) {
        config.command["codex-status"] = {
          template: "Show the current Codex status and usage snapshot via the experimental status path.",
          description: "Experimental Codex status command",
        }
      }
      if (enableCopilotAuthLoader) {
        config.command["copilot-status"] = {
          template: "Show the current GitHub Copilot quota status via the experimental workaround path.",
          description: "Experimental Copilot quota status workaround",
        }
        config.command["copilot-compact"] = {
          template: "Summarize the current session via real session compacting flow.",
          description: "Experimental compact command for Copilot sessions",
        }
        config.command["copilot-stop-tool"] = {
          template: "Interrupt the current session tool flow, annotate the interrupted result, and append a synthetic continue.",
          description: "Experimental interrupt-and-annotate recovery with synthetic continue for Copilot sessions",
        }
        config.command["copilot-inject"] = {
          template: "Arm an immediate tool-output inject marker flow that drives model to question.",
          description: "Experimental force-intervene hook for Copilot workflows",
        }
        config.command["copilot-policy-all-models"] = {
          template: "Toggle the current OpenCode instance policy injection scope between Copilot-only and all providers/models.",
          description: "Experimental policy scope toggle for all providers",
        }
      }
    },
    "command.execute.before": async (hookInput) => {
      trackWechatBridgeInteractedSession(wechatBridgeSessionContext, hookInput.sessionID)
      const store = await loadMergedStore()
      if (hookInput.command === "copilot-inject") {
        if (!enableCopilotAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        injectArmed = true
        await showInjectToast("将在模型下次调用工具的时候要求模型立刻调用提问工具", "info")
        throw new InjectCommandHandledError()
      }

      if (hookInput.command === "copilot-policy-all-models") {
        if (!enableCopilotAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        const next = getPolicyScope(store) === "all-models" ? "copilot-only" : "all-models"
        policyScopeOverride = next
        await showInjectToast(
          next === "all-models"
            ? "当前实例已将 policy 注入扩展到所有 provider 和所有模型"
            : "当前实例已恢复为仅对 Copilot provider 注入 policy",
          "info",
        )
        throw new PolicyScopeCommandHandledError()
      }

      if (hookInput.command === "copilot-status") {
        if (!enableCopilotAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        await handleStatusCommandImpl({
          client: input.client,
          loadStore,
          writeStore: persistStore,
          refreshQuota,
        })
      }

      if (hookInput.command === "codex-status") {
        if (!enableCodexAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        await handleCodexStatusCommandImpl({
          client: input.client,
        })
      }

      if (hookInput.command === "copilot-compact") {
        if (!enableCopilotAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        await handleCompactCommandImpl({
          client: input.client ?? {},
          sessionID: hookInput.sessionID,
          model: (hookInput as { model?: string }).model,
        })
      }

      if (hookInput.command === "copilot-stop-tool") {
        if (!enableCopilotAuthLoader) return
        if (!areExperimentalSlashCommandsEnabled(store)) return
        await handleStopToolCommandImpl({
          client: input.client ?? {},
          sessionID: hookInput.sessionID,
          runningTools: (hookInput as { runningTools?: unknown[] }).runningTools,
          syntheticAgentInitiatorEnabled: store?.syntheticAgentInitiatorEnabled === true,
        })
      }
    },
    "tool.execute.before": async (hookInput) => {
      trackWechatBridgeInteractedSession(wechatBridgeSessionContext, hookInput.sessionID)
      if (!injectArmed) return
      if (hookInput.tool !== "question") return
      injectArmed = false
    },
    "tool.execute.after": async (hookInput, output) => {
      trackWechatBridgeInteractedSession(wechatBridgeSessionContext, hookInput.sessionID)
      if (hookInput.tool === "question") {
        injectArmed = false
        return
      }

      if (hookInput.tool === "task") return

      if (!injectArmed) return

      const begin = "[COPILOT_INJECT_V1_BEGIN]"
      const body = "立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。"
      const end = "[COPILOT_INJECT_V1_END]"
      const markerBlock = `${begin}\n${body}\n${end}`

      const currentOutput = output.output == null ? "" : String(output.output)
      const hasBegin = currentOutput.includes(begin)
      const hasEnd = currentOutput.includes(end)

      let normalized = currentOutput
      if (hasBegin !== hasEnd) {
        normalized = normalized
          .replace(begin, "")
          .replace(end, "")
          .trimEnd()
      }

      if (normalized.includes(begin) && normalized.includes(end)) {
        output.output = normalized
        return
      }

      output.output = `${normalized}${normalized.length > 0 ? "\n\n" : ""}${markerBlock}`
      await showInjectToast("已要求模型立刻调用提问工具", "warning")
    },
    tool: {
      notify: createNotifyTool({
        client: input.client,
      }),
    },
    "tool.definition": async (hookInput, output) => {
      if (hookInput.toolID === "question") {
        output.description = "Use for required user response, user confirmation, final handoff, no-safe-work-left states, or uncertain routing cases. Do not use for unattended/background waits that can resume automatically; use a dedicated wait tool when available."
      }
      if (hookInput.toolID === "notify") {
        output.description = "Use for non-blocking progress and phase updates only; do not require immediate user response."
      }
    },
    "chat.headers": chatHeaders,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(
      loadMergedStore,
      compactionLoopSafetyBypass.consume,
      lookupSessionAncestry,
      getPolicyScope,
    ),
    "experimental.session.compacting": compactionLoopSafetyBypass.hook,
  }
}



