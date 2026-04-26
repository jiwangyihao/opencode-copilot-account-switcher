import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createHandle, normalizeHandle } from "./handle.js"
import type {
  BrokerAckPayload,
  BrokerCommandStatus,
  BrokerToBridgeCommandType,
  BrokerToBridgeControlType,
  BridgeToBrokerEvent,
} from "./protocol.js"
import {
  brokerStateSchemaPath,
  brokerStateStorePath,
  notificationsDir,
  requestKindDir,
  WECHAT_FILE_MODE,
} from "./state-paths.js"

type UnknownRecord = Record<string, unknown>

export const BROKER_STATE_SCHEMA_MARKER_KIND = "wechat-broker-state-store"
export const LEGACY_STATE_RESET_UPGRADE_CLOSE_REASON = "legacy-state-reset-awaiting-full-sync"
const BROKER_STATE_REPLACE_MAX_ATTEMPTS = 50
const BROKER_STATE_REPLACE_RETRY_DELAY_MS = 10

export type BrokerStateSchemaMarker = {
  kind?: string
  protocolVersion: number
  stateGeneration: string
  updatedAt: number
  upgradeCloseReason?: string
  legacyHandleClosures?: string[]
}

export type PrepareBrokerStateStoreForStartupInput = {
  protocolVersion: number
  stateGeneration: string
  now?: () => number
}

export type PrepareBrokerStateStoreForStartupResult = {
  state: BrokerState
  recoveredFromLegacyState: boolean
  legacyHandleClosures: string[]
}

export type BrokerConnectionState = {
  instanceID: string
  instanceIncarnation: string
  online: boolean
  lastEventSeq: number
  lastAckedEventSeq: number
  lastSentBrokerSeq: number
  lastObservedAt?: number
  connectedAt?: number
  disconnectedAt?: number
  disconnectReason?: string
}

export type BrokerConnectionScope = {
  instanceID: string
  instanceIncarnation: string
}

export type BrokerActiveState = {
  instances: Record<string, UnknownRecord>
  sessions: Record<string, UnknownRecord>
  questions: Record<string, UnknownRecord>
  permissions: Record<string, UnknownRecord>
  naturalStops: Record<string, UnknownRecord>
  retryErrors: Record<string, UnknownRecord>
}

export type BrokerTerminalMetadata = {
  reason: string
  replacementHandle?: string
  terminalResultSent?: boolean
  retainedUntil?: number
  handle?: string
  requestID?: string
  scopeKey?: string
  prompt?: unknown
  wechatAccountId?: string
  userId?: string
  createdAt?: number
  answeredAt?: number
  rejectedAt?: number
  expiredAt?: number
  cleanedAt?: number
}

export type BrokerRetainedOccupancy = {
  handle: string
  retainedUntil: number
}

export type BrokerIndexedRequestRecord = {
  kind: "question" | "permission"
  requestID: string
  routeKey: string
  handle: string
  scopeKey?: string
  prompt?: unknown
  wechatAccountId: string
  userId: string
  status: "open" | "answered" | "rejected" | "expired" | "cleaned"
  createdAt: number
  answeredAt?: number
  rejectedAt?: number
  expiredAt?: number
  cleanedAt?: number
  terminalReason?: "answered" | "handled" | "rejected" | "expired" | "replaced"
  replacementHandle?: string
  terminalResultSent?: boolean
}

export type BrokerDeliveryTokenState = {
  wechatAccountId: string
  userId: string
  contextToken: string
  updatedAt: number
  source: "question" | "permission" | "message"
  sourceRef?: string
  staleReason?: string
}

export type BrokerRuntimeExpiredRequest = BrokerIndexedRequestRecord

export type BrokerRuntimeClosedNaturalStop = {
  handle: string
  scopeKey?: string
  idempotencyKey?: string
  terminalReason: string
}

export type BrokerRuntimeCleanupResult = {
  cleanedRequests: BrokerIndexedRequestRecord[]
  purgedRequests: BrokerIndexedRequestRecord[]
}

export type BrokerLegacyHandleKind = "question" | "permission" | "naturalStop"

export type BrokerLegacyHandleClosure = {
  kind: BrokerLegacyHandleKind
  handle: string
  reason: string
  message?: string
  replacementHandle?: string
  routeKey?: string
  retainedUntil?: number
}

export type BrokerCommandRecord = {
  commandId: string
  brokerSeq: number
  type: BrokerToBridgeCommandType
  target: UnknownRecord
  payload?: unknown
  status: BrokerCommandStatus
  acceptedAt?: number
  completedAt?: number
  failure?: UnknownRecord
  instanceID?: string
  instanceIncarnation?: string
  acceptedEventSeq?: number
  resultEventSeq?: number
}

export type BrokerControlStatus = "inFlight" | "completed"

export type BrokerControlRecord = {
  controlId: string
  brokerSeq: number
  type: BrokerToBridgeControlType
  status: BrokerControlStatus
  instanceID: string
  instanceIncarnation: string
  fromEventSeq?: number
  toEventSeq?: number
  reason?: string
  completedEventSeq?: number
}

export type BrokerFullSyncStage = {
  controlId: string
  instanceID: string
  instanceIncarnation: string
  state: BrokerState
}

export type BrokerFullSyncSnapshot = {
  connections?: Record<string, Record<string, BrokerConnectionState>>
  active: BrokerActiveState
}

export type BrokerState = {
  connections: Record<string, Record<string, BrokerConnectionState>>
  active: BrokerActiveState
  terminalMetadata: Record<string, BrokerTerminalMetadata>
  retainedOccupancy: Record<string, BrokerRetainedOccupancy>
  legacyHandleClosures: Record<string, BrokerLegacyHandleClosure>
  requestIndex: Record<string, BrokerIndexedRequestRecord>
  deliveryTokens: Record<string, BrokerDeliveryTokenState>
  commandLedger: Record<string, BrokerCommandRecord>
  controlLedger: Record<string, BrokerControlRecord>
  fullSync: {
    lastCompletedControlId?: string
    lastCompletedEventSeq?: number
    lastCompletedInstanceIncarnation?: string
    stagedByControlId: Record<string, BrokerFullSyncStage>
  }
}

export type UpsertBrokerCommandInput = {
  commandId: string
  brokerSeq: number
  type: BrokerToBridgeCommandType
  status: "queued" | "delivered"
  target: UnknownRecord
  payload?: unknown
  instanceID?: string
  instanceIncarnation?: string
}

export type RequestBrokerReplayInput = {
  controlId: string
  brokerSeq: number
  instanceID: string
  instanceIncarnation: string
  fromEventSeq: number
  toEventSeq: number
}

export type MarkBrokerReplayCompletedInput = {
  controlId: string
  completedEventSeq: number
}

export type RequestBrokerFullSyncInput = {
  controlId: string
  brokerSeq: number
  instanceID: string
  instanceIncarnation: string
  reason: string
}

export type StageBrokerFullSyncEventInput = {
  controlId: string
  event: BridgeToBrokerEvent
  context?: ApplyBridgeEventContext
}

export type MarkBrokerFullSyncCompletedInput = {
  controlId: string
  instanceID: string
  instanceIncarnation: string
  eventSeq: number
}

export type MarkBrokerCommandAcceptedInput = {
  commandId: string
  instanceID: string
  instanceIncarnation: string
  eventSeq: number
  acceptedAt?: number
}

export type MarkBrokerCommandResultInput = {
  commandId: string
  instanceID: string
  instanceIncarnation: string
  eventSeq: number
  status: "completed" | "failed"
  completedAt?: number
  failure?: UnknownRecord
}

export type UpsertRetryErrorSummaryInput = {
  instanceID: string
  sessionID?: string
  action: string
  redactedSummary: string
  severityAdvice: string
  updatedAt?: number
  instanceIncarnation?: string
}

export type MarkConnectionAckedEventSeqInput = BrokerAckPayload & {
  instanceID: string
}

export type MarkConnectionSentBrokerSeqInput = BrokerConnectionScope & {
  brokerSeq: number
}

export type ApplyBridgeEventContext = {
  instanceID?: string
}

export type BrokerAuthoritativeView = {
  connections: Record<string, Record<string, BrokerConnectionState>>
  active: BrokerActiveState
  terminalMetadata: Record<string, BrokerTerminalMetadata>
  retainedOccupancy: Record<string, BrokerRetainedOccupancy>
  commandLedger: Record<string, BrokerCommandRecord>
  legacyHandleClosures: Record<string, BrokerLegacyHandleClosure>
}

export type BrokerCommandActionInput = {
  type: BrokerToBridgeCommandType
  target: UnknownRecord
  payload?: unknown
}

const trackedBrokerStates: BrokerState[] = []
const trackedBrokerStateTouch = new WeakMap<BrokerState, number>()
let nextTrackedBrokerStateTouch = 0
let brokerStateMutationTarget: BrokerState | undefined

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null
}

function assertNonNegativeInteger(value: unknown, fieldName: string) {
  if (!isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${fieldName}`)
  }
}

function assertCommandType(value: unknown): asserts value is BrokerToBridgeCommandType {
  if (value !== "replyQuestion" && value !== "replyPermission" && value !== "replyNaturalStop") {
    throw new Error("invalid broker command type")
  }
}

function assertControlType(value: unknown): asserts value is BrokerToBridgeControlType {
  if (value !== "requestReplay" && value !== "requestFullSync") {
    throw new Error("invalid broker control type")
  }
}

function createEmptyActiveState(): BrokerActiveState {
  return {
    instances: {},
    sessions: {},
    questions: {},
    permissions: {},
    naturalStops: {},
    retryErrors: {},
  }
}

function cloneRecordMap<T extends Record<string, UnknownRecord>>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneUnknownValue(item)])) as T
}

function cloneUnknownValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneUnknownValue(item)) as T
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneUnknownValue(item)])) as T
  }
  return value
}

function cloneTerminalMetadataMap(value: Record<string, BrokerTerminalMetadata>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneUnknownValue(item)]))
}

function cloneRetainedOccupancyMap(value: Record<string, BrokerRetainedOccupancy>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { ...item }]))
}

function cloneLegacyHandleClosure(record: BrokerLegacyHandleClosure): BrokerLegacyHandleClosure {
  return {
    ...record,
  }
}

function cloneLegacyHandleClosureMap(value: Record<string, BrokerLegacyHandleClosure>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneLegacyHandleClosure(item)]))
}

function cloneIndexedRequestRecord(record: BrokerIndexedRequestRecord): BrokerIndexedRequestRecord {
  return cloneUnknownValue(record)
}

function cloneRequestIndexMap(value: Record<string, BrokerIndexedRequestRecord>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneIndexedRequestRecord(item)]))
}

function cloneDeliveryTokenState(record: BrokerDeliveryTokenState): BrokerDeliveryTokenState {
  return { ...record }
}

function cloneDeliveryTokenMap(value: Record<string, BrokerDeliveryTokenState>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDeliveryTokenState(item)]))
}

function normalizeHandleClosures(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(new Set(
    value
      .map((item) => normalizeActionString(item))
      .filter((item): item is string => item !== undefined),
  )).sort((left, right) => left.localeCompare(right))
}

function cloneCommandRecord(record: BrokerCommandRecord): BrokerCommandRecord {
  return {
    ...record,
    target: cloneUnknownValue(record.target),
    ...(record.payload !== undefined ? { payload: cloneUnknownValue(record.payload) } : {}),
    ...(record.failure ? { failure: cloneUnknownValue(record.failure) } : {}),
  }
}

function rememberBrokerState<T extends BrokerState>(state: T): T {
  if (!trackedBrokerStateTouch.has(state)) {
    trackedBrokerStates.push(state)
  }
  nextTrackedBrokerStateTouch += 1
  trackedBrokerStateTouch.set(state, nextTrackedBrokerStateTouch)
  return state
}

function resolveBrokerState(state?: BrokerState): BrokerState | undefined {
  if (state) {
    return rememberBrokerState(state)
  }

  const stagedStates = new Set<BrokerState>()
  for (const candidate of trackedBrokerStates) {
    for (const stage of Object.values(candidate.fullSync.stagedByControlId)) {
      stagedStates.add(stage.state)
    }
  }

  const candidates = trackedBrokerStates
    .filter((candidate) => trackedBrokerStateTouch.has(candidate) && !stagedStates.has(candidate))
    .sort((left, right) => (trackedBrokerStateTouch.get(right) ?? 0) - (trackedBrokerStateTouch.get(left) ?? 0))

  const latest = candidates[0]
  return latest ? rememberBrokerState(latest) : undefined
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(filePath, "utf8")
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    return undefined
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableBrokerStateReplaceError(error: unknown): boolean {
  const issue = error as NodeJS.ErrnoException
  return issue?.code === "EPERM" || issue?.code === "EBUSY"
}

async function replaceBrokerStateFile(tempPath: string, filePath: string): Promise<void> {
  let lastError: unknown = undefined

  for (let attempt = 0; attempt < BROKER_STATE_REPLACE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(tempPath, filePath)
      return
    } catch (error) {
      lastError = error
      if (attempt === BROKER_STATE_REPLACE_MAX_ATTEMPTS - 1 || !isRetryableBrokerStateReplaceError(error)) {
        throw error
      }

      await delay(BROKER_STATE_REPLACE_RETRY_DELAY_MS)
    }
  }

  if (lastError) throw lastError
}

async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const dirPath = path.dirname(filePath)
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(dirPath, { recursive: true })

  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: WECHAT_FILE_MODE })
    await replaceBrokerStateFile(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function collectHandleClosuresFromJsonFiles(
  filePaths: string[],
  predicate?: (record: UnknownRecord) => boolean,
): Promise<string[]> {
  const handles = new Set<string>()

  for (const filePath of filePaths) {
    const raw = await readJsonFile(filePath)
    if (!isRecord(raw)) {
      continue
    }
    if (predicate && !predicate(raw)) {
      continue
    }

    const handle = getStringField(raw, "handle")
    if (handle) {
      handles.add(handle)
    }
  }

  return Array.from(handles)
}

async function collectLegacyHandleClosures(): Promise<string[]> {
  const questionFiles = await listJsonFiles(requestKindDir("question"))
  const permissionFiles = await listJsonFiles(requestKindDir("permission"))
  const notificationFiles = await listJsonFiles(notificationsDir())
  const [questionHandles, permissionHandles, naturalStopHandles] = await Promise.all([
    collectHandleClosuresFromJsonFiles(questionFiles),
    collectHandleClosuresFromJsonFiles(permissionFiles),
    collectHandleClosuresFromJsonFiles(notificationFiles, (record) => getStringField(record, "kind") === "naturalStop"),
  ])

  return Array.from(new Set([
    ...questionHandles,
    ...permissionHandles,
    ...naturalStopHandles,
  ])).sort((left, right) => left.localeCompare(right))
}

function restorePersistedBrokerState(raw: unknown, options: { track?: boolean } = {}): BrokerState | undefined {
  if (!isRecord(raw) || !isRecord(raw.connections) || !isRecord(raw.active)) {
    return undefined
  }

  const active = raw.active
  if (
    !isRecord(active.instances)
    || !isRecord(active.sessions)
    || !isRecord(active.questions)
    || !isRecord(active.permissions)
    || !isRecord(active.naturalStops)
    || !isRecord(active.retryErrors)
  ) {
    return undefined
  }

  const state = createEmptyBrokerState({ track: options.track === false ? false : true })
  state.connections = cloneUnknownValue(raw.connections as Record<string, Record<string, BrokerConnectionState>>)
  state.active = cloneUnknownValue(active as BrokerActiveState)
  state.terminalMetadata = isRecord(raw.terminalMetadata)
    ? cloneUnknownValue(raw.terminalMetadata as Record<string, BrokerTerminalMetadata>)
    : {}
  state.retainedOccupancy = isRecord(raw.retainedOccupancy)
    ? cloneUnknownValue(raw.retainedOccupancy as Record<string, BrokerRetainedOccupancy>)
    : {}
  state.legacyHandleClosures = isRecord(raw.legacyHandleClosures)
    ? cloneUnknownValue(raw.legacyHandleClosures as Record<string, BrokerLegacyHandleClosure>)
    : {}
  state.requestIndex = isRecord(raw.requestIndex)
    ? cloneUnknownValue(raw.requestIndex as Record<string, BrokerIndexedRequestRecord>)
    : {}
  state.deliveryTokens = isRecord(raw.deliveryTokens)
    ? cloneUnknownValue(raw.deliveryTokens as Record<string, BrokerDeliveryTokenState>)
    : {}
  state.commandLedger = isRecord(raw.commandLedger)
    ? cloneUnknownValue(raw.commandLedger as Record<string, BrokerCommandRecord>)
    : {}
  state.controlLedger = isRecord(raw.controlLedger)
    ? cloneUnknownValue(raw.controlLedger as Record<string, BrokerControlRecord>)
    : {}
  state.fullSync = {
    stagedByControlId: {},
    ...(isRecord(raw.fullSync) && isNonEmptyString(raw.fullSync.lastCompletedControlId)
      ? { lastCompletedControlId: raw.fullSync.lastCompletedControlId }
      : {}),
    ...(isRecord(raw.fullSync) && isSafeInteger(raw.fullSync.lastCompletedEventSeq)
      ? { lastCompletedEventSeq: raw.fullSync.lastCompletedEventSeq }
      : {}),
    ...(isRecord(raw.fullSync) && isNonEmptyString(raw.fullSync.lastCompletedInstanceIncarnation)
      ? { lastCompletedInstanceIncarnation: raw.fullSync.lastCompletedInstanceIncarnation }
      : {}),
  }
  return options.track === false ? state : rememberBrokerState(state)
}

async function writeBrokerStateStoreSnapshot(state: BrokerState): Promise<void> {
  await writeJsonFileAtomically(brokerStateStorePath(), state)
}

export async function persistBrokerStateStoreSnapshot(state: BrokerState): Promise<void> {
  await writeBrokerStateStoreSnapshot(state)
}

export async function loadBrokerStateStoreSnapshot(): Promise<BrokerState | undefined> {
  const raw = await readJsonFile(brokerStateStorePath())
  const restored = restorePersistedBrokerState(raw, { track: false })
  if (restored) {
    return restored
  }

  return resolveBrokerState()
}

export async function loadBrokerStateStoreForMutation(): Promise<BrokerState> {
  if (brokerStateMutationTarget) {
    return rememberBrokerState(brokerStateMutationTarget)
  }

  const restored = await loadBrokerStateStoreSnapshot()
  return restored ? rememberBrokerState(restored) : createEmptyBrokerState()
}

export function setBrokerStateMutationTarget(state: BrokerState | undefined): void {
  brokerStateMutationTarget = state ? rememberBrokerState(state) : undefined
}

export async function readBrokerStateSchemaMarker(): Promise<BrokerStateSchemaMarker | undefined> {
  const raw = await readJsonFile(brokerStateSchemaPath())
  if (!isRecord(raw) || !isSafeInteger(raw.protocolVersion) || !isNonEmptyString(raw.stateGeneration) || !isSafeInteger(raw.updatedAt)) {
    return undefined
  }

  return {
    kind: isNonEmptyString(raw.kind) ? raw.kind : BROKER_STATE_SCHEMA_MARKER_KIND,
    protocolVersion: raw.protocolVersion,
    stateGeneration: raw.stateGeneration,
    updatedAt: raw.updatedAt,
    ...(isNonEmptyString(raw.upgradeCloseReason) ? { upgradeCloseReason: raw.upgradeCloseReason } : {}),
    ...(normalizeHandleClosures(raw.legacyHandleClosures).length > 0
      ? { legacyHandleClosures: normalizeHandleClosures(raw.legacyHandleClosures) }
      : {}),
  }
}

export async function writeBrokerStateSchemaMarker(input: BrokerStateSchemaMarker): Promise<BrokerStateSchemaMarker> {
  assertNonNegativeInteger(input.protocolVersion, "protocolVersion")
  if (!isNonEmptyString(input.stateGeneration)) {
    throw new Error("invalid stateGeneration")
  }
  assertNonNegativeInteger(input.updatedAt, "updatedAt")

  const marker: BrokerStateSchemaMarker = {
    kind: BROKER_STATE_SCHEMA_MARKER_KIND,
    protocolVersion: input.protocolVersion,
    stateGeneration: input.stateGeneration,
    updatedAt: input.updatedAt,
    ...(isNonEmptyString(input.upgradeCloseReason) ? { upgradeCloseReason: input.upgradeCloseReason } : {}),
    ...(normalizeHandleClosures(input.legacyHandleClosures).length > 0
      ? { legacyHandleClosures: normalizeHandleClosures(input.legacyHandleClosures) }
      : {}),
  }

  await writeJsonFileAtomically(brokerStateSchemaPath(), marker)
  return marker
}

export async function prepareBrokerStateStoreForStartup(
  input: PrepareBrokerStateStoreForStartupInput,
): Promise<PrepareBrokerStateStoreForStartupResult> {
  assertNonNegativeInteger(input.protocolVersion, "protocolVersion")
  if (!isNonEmptyString(input.stateGeneration)) {
    throw new Error("invalid stateGeneration")
  }

  const now = input.now ?? Date.now
  const marker = await readBrokerStateSchemaMarker()
  const rawState = await readJsonFile(brokerStateStorePath())
  const markerMatches = marker?.protocolVersion === input.protocolVersion && marker?.stateGeneration === input.stateGeneration
  const hasPersistedState = marker !== undefined || rawState !== undefined

  let recoveredFromLegacyState = false
  let legacyHandleClosures = markerMatches ? normalizeHandleClosures(marker?.legacyHandleClosures) : []
  let state = markerMatches ? (restorePersistedBrokerState(rawState) ?? createEmptyBrokerState()) : createEmptyBrokerState()

  if (!markerMatches && hasPersistedState) {
    recoveredFromLegacyState = true
    legacyHandleClosures = await collectLegacyHandleClosures()
    state = createEmptyBrokerState()
  }

  await writeBrokerStateStoreSnapshot(state)
  const persistedMarker = await writeBrokerStateSchemaMarker({
    protocolVersion: input.protocolVersion,
    stateGeneration: input.stateGeneration,
    updatedAt: now(),
    ...(legacyHandleClosures.length > 0
      ? {
          upgradeCloseReason: marker?.upgradeCloseReason ?? LEGACY_STATE_RESET_UPGRADE_CLOSE_REASON,
          legacyHandleClosures,
        }
      : {}),
  })

  return {
    state,
    recoveredFromLegacyState,
    legacyHandleClosures: normalizeHandleClosures(persistedMarker.legacyHandleClosures),
  }
}

export async function readBrokerStateUpgradeCloseReason(handle: string): Promise<string | undefined> {
  if (!isNonEmptyString(handle)) {
    return undefined
  }

  const marker = await readBrokerStateSchemaMarker()
  if (!marker?.upgradeCloseReason) {
    return undefined
  }

  const closures = normalizeHandleClosures(marker.legacyHandleClosures)
  if (!closures.includes(handle)) {
    return undefined
  }

  if (marker.upgradeCloseReason === LEGACY_STATE_RESET_UPGRADE_CLOSE_REASON) {
    return `该句柄来自旧状态代际，broker 正在升级恢复，请等待实例重连并完成 full sync 后再试：${handle}`
  }

  return `该句柄暂时不可用：${handle}`
}

function normalizeActionString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length > 0 ? normalized : undefined
}

function normalizeAnswerMatrix(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: string[] = []
  for (const group of value) {
    if (Array.isArray(group)) {
      normalized.push(...group.map((item) => normalizeActionString(item)).filter((item): item is string => item !== undefined))
      continue
    }
    const next = normalizeActionString(group)
    if (next) {
      normalized.push(next)
    }
  }

  return normalized.sort((left, right) => left.localeCompare(right))
}

function createBrokerCommandActionKey(input: BrokerCommandActionInput): string {
  const instanceID = normalizeActionString(input.target.instanceID) ?? ""

  if (input.type === "replyQuestion") {
    const requestID = normalizeActionString(input.target.requestID)
      ?? normalizeActionString(isRecord(input.payload) ? input.payload.requestID : undefined)
      ?? ""
    const answers = normalizeAnswerMatrix(isRecord(input.payload) ? input.payload.answers : undefined)
    return JSON.stringify({
      type: input.type,
      target: { instanceID, requestID },
      payload: { answers },
    })
  }

  if (input.type === "replyPermission") {
    const requestID = normalizeActionString(input.target.requestID)
      ?? normalizeActionString(isRecord(input.payload) ? input.payload.requestID : undefined)
      ?? ""
    const reply = normalizeActionString(isRecord(input.payload) ? input.payload.reply : undefined) ?? ""
    const message = normalizeActionString(isRecord(input.payload) ? input.payload.message : undefined) ?? ""
    return JSON.stringify({
      type: input.type,
      target: { instanceID, requestID },
      payload: { reply, message },
    })
  }

  const sessionID = normalizeActionString(input.target.sessionID)
    ?? normalizeActionString(isRecord(input.payload) ? input.payload.sessionID : undefined)
    ?? ""
  const text = normalizeActionString(isRecord(input.payload) ? input.payload.text : undefined) ?? ""
  return JSON.stringify({
    type: input.type,
    target: { instanceID, sessionID },
    payload: { text },
  })
}

function cloneConnectionMap(value: Record<string, Record<string, BrokerConnectionState>>) {
  return Object.fromEntries(
    Object.entries(value).map(([instanceID, incarnations]) => [
      instanceID,
      Object.fromEntries(Object.entries(incarnations).map(([incarnation, item]) => [incarnation, { ...item }])),
    ]),
  )
}

function cloneActiveState(state: BrokerActiveState): BrokerActiveState {
  return {
    instances: cloneRecordMap(state.instances),
    sessions: cloneRecordMap(state.sessions),
    questions: cloneRecordMap(state.questions),
    permissions: cloneRecordMap(state.permissions),
    naturalStops: cloneRecordMap(state.naturalStops),
    retryErrors: cloneRecordMap(state.retryErrors),
  }
}

function getConnectionGroup(state: BrokerState, instanceID: string) {
  const current = state.connections[instanceID]
  if (current) {
    return current
  }

  const created: Record<string, BrokerConnectionState> = {}
  state.connections[instanceID] = created
  return created
}

function getStringField(record: UnknownRecord, fieldName: string): string | undefined {
  const value = record[fieldName]
  return isNonEmptyString(value) ? value : undefined
}

function getNumberField(record: UnknownRecord, fieldName: string): number | undefined {
  const value = record[fieldName]
  return isSafeInteger(value) ? value : undefined
}

function ensureConnection(
  state: BrokerState,
  instanceID: string,
  instanceIncarnation: string,
): BrokerConnectionState {
  const current = getConnectionGroup(state, instanceID)[instanceIncarnation]
  if (current) {
    return current
  }

  const created: BrokerConnectionState = {
    instanceID,
    instanceIncarnation,
    online: false,
    lastEventSeq: 0,
    lastAckedEventSeq: 0,
    lastSentBrokerSeq: 0,
  }
  getConnectionGroup(state, instanceID)[instanceIncarnation] = created
  return created
}

function resolveInstanceID(payload: UnknownRecord, context?: ApplyBridgeEventContext): string | undefined {
  if (isNonEmptyString(context?.instanceID)) {
    return context.instanceID
  }
  return getStringField(payload, "instanceID")
}

function updateConnectionEventWatermark(
  state: BrokerState,
  event: BridgeToBrokerEvent,
  payload: UnknownRecord,
  context?: ApplyBridgeEventContext,
) {
  const instanceID = resolveInstanceID(payload, context)
  if (!instanceID) {
    return undefined
  }

  const connection = ensureConnection(state, instanceID, event.instanceIncarnation)
  connection.lastEventSeq = Math.max(connection.lastEventSeq, event.eventSeq)
  return connection
}

function requireCommand(state: BrokerState, commandId: string): BrokerCommandRecord {
  const current = state.commandLedger[commandId]
  if (!current) {
    throw new Error("unknown broker command")
  }
  return current
}

export function createEmptyBrokerState(options: { track?: boolean } = {}): BrokerState {
  const state: BrokerState = {
    connections: {},
    active: createEmptyActiveState(),
    terminalMetadata: {},
    retainedOccupancy: {},
    legacyHandleClosures: {},
    requestIndex: {},
    deliveryTokens: {},
    commandLedger: {},
    controlLedger: {},
    fullSync: {
      stagedByControlId: {},
    },
  }
  return options.track === false ? state : rememberBrokerState(state)
}

function isLegacyHandleKind(value: unknown): value is BrokerLegacyHandleKind {
  return value === "question" || value === "permission" || value === "naturalStop"
}

function toLegacyHandleClosure(input: BrokerLegacyHandleClosure): BrokerLegacyHandleClosure {
  if (!isLegacyHandleKind(input.kind) || !isNonEmptyString(input.handle) || !isNonEmptyString(input.reason)) {
    throw new Error("invalid legacy handle closure")
  }

  return {
    kind: input.kind,
    handle: input.handle,
    reason: input.reason,
    ...(isNonEmptyString(input.message) ? { message: input.message.trim() } : {}),
    ...(isNonEmptyString(input.replacementHandle) ? { replacementHandle: input.replacementHandle.trim() } : {}),
    ...(isNonEmptyString(input.routeKey) ? { routeKey: input.routeKey.trim() } : {}),
    ...(isSafeInteger(input.retainedUntil) ? { retainedUntil: input.retainedUntil } : {}),
  }
}

export function writeLegacyHandleClosure(state: BrokerState, input: BrokerLegacyHandleClosure): BrokerLegacyHandleClosure {
  rememberBrokerState(state)
  const next = toLegacyHandleClosure(input)
  state.legacyHandleClosures[next.handle] = next
  return next
}

export function readLegacyHandleClosure(
  state: BrokerState | undefined,
  input: { kind: BrokerLegacyHandleKind; handle: string },
): BrokerLegacyHandleClosure | undefined {
  if (!isLegacyHandleKind(input.kind) || !isNonEmptyString(input.handle)) {
    return undefined
  }

  const resolved = resolveBrokerState(state)
  const candidate = resolved?.legacyHandleClosures[input.handle]
  if (!candidate || candidate.kind !== input.kind) {
    return undefined
  }

  return cloneLegacyHandleClosure(candidate)
}

export function applyBridgeEvent<TPayload = unknown>(
  state: BrokerState,
  event: BridgeToBrokerEvent<TPayload>,
  context?: ApplyBridgeEventContext,
): BrokerState {
  rememberBrokerState(state)
  assertNonNegativeInteger(event.eventSeq, "eventSeq")
  if (!isNonEmptyString(event.instanceIncarnation)) {
    throw new Error("invalid instanceIncarnation")
  }
  if (!isRecord(event.payload)) {
    throw new Error("invalid bridge event payload")
  }

  const payload = event.payload
  const connection = updateConnectionEventWatermark(state, event, payload, context)

  switch (event.type) {
    case "instanceOnline": {
      const instanceID = resolveInstanceID(payload, context)
      if (!instanceID) {
        throw new Error("invalid instanceOnline payload")
      }

      const nextConnection = ensureConnection(state, instanceID, event.instanceIncarnation)
      nextConnection.online = true
      nextConnection.connectedAt = getNumberField(payload, "connectedAt")
      state.active.instances[instanceID] = {
        ...payload,
        instanceID,
        instanceIncarnation: event.instanceIncarnation,
        online: true,
      }
      return state
    }
    case "instanceOffline": {
      const instanceID = resolveInstanceID(payload, context)
      if (!instanceID) {
        throw new Error("invalid instanceOffline payload")
      }

      const nextConnection = ensureConnection(state, instanceID, event.instanceIncarnation)
      nextConnection.online = false
      nextConnection.disconnectedAt = getNumberField(payload, "disconnectedAt")
      nextConnection.disconnectReason = getStringField(payload, "reason")
      state.active.instances[instanceID] = {
        ...state.active.instances[instanceID],
        ...payload,
        instanceID,
        instanceIncarnation: event.instanceIncarnation,
        online: false,
      }
      return state
    }
    case "sessionSnapshotChanged": {
      const sessionID = getStringField(payload, "sessionID")
      if (!sessionID) {
        throw new Error("invalid sessionSnapshotChanged payload")
      }

      const instanceID = resolveInstanceID(payload, context)
      state.active.sessions[sessionID] = {
        ...payload,
        ...(instanceID ? { instanceID } : {}),
        instanceIncarnation: event.instanceIncarnation,
      }
      return state
    }
    case "questionOpened":
    case "questionUpdated": {
      const routeKey = getStringField(payload, "routeKey")
      if (!routeKey) {
        throw new Error("invalid question payload")
      }

      const instanceID = resolveInstanceID(payload, context)
      state.active.questions[routeKey] = {
        ...payload,
        ...(instanceID ? { instanceID } : {}),
        instanceIncarnation: event.instanceIncarnation,
      }
      state.active.questions = ensureUniqueBrokerRequestHandles(state.active.questions, "question", {
        updatedRouteKey: routeKey,
      })
      const handle = getStringField(payload, "handle")
      if (handle) {
        delete state.legacyHandleClosures[handle]
      }
      return state
    }
    case "questionClosed": {
      const routeKey = getStringField(payload, "routeKey")
      if (!routeKey) {
        throw new Error("invalid question payload")
      }
      const currentQuestion = isRecord(state.active.questions[routeKey]) ? state.active.questions[routeKey] : undefined
      const previousTerminal = state.terminalMetadata[routeKey]
      delete state.active.questions[routeKey]
      const reason = getStringField(payload, "reason")
      if (reason) {
        const handle = (currentQuestion ? getStringField(currentQuestion, "handle") : undefined)
          ?? (isNonEmptyString(previousTerminal?.handle) ? previousTerminal.handle : undefined)
          ?? getStringField(payload, "handle")
        const requestID = getStringField(payload, "requestID") ?? (currentQuestion ? getStringField(currentQuestion, "requestID") : undefined) ?? previousTerminal?.requestID
        const scopeKey = getStringField(payload, "scopeKey") ?? (currentQuestion ? readBrokerScopeKey(currentQuestion) : undefined) ?? previousTerminal?.scopeKey
        const wechatAccountId = getStringField(payload, "wechatAccountId") ?? (currentQuestion ? getStringField(currentQuestion, "wechatAccountId") : undefined) ?? previousTerminal?.wechatAccountId
        const userId = getStringField(payload, "userId") ?? (currentQuestion ? getStringField(currentQuestion, "userId") : undefined) ?? previousTerminal?.userId
        const createdAt = getNumberField(payload, "createdAt") ?? (currentQuestion ? getNumberField(currentQuestion, "createdAt") : undefined) ?? previousTerminal?.createdAt
        const terminalAt = getNumberField(payload, "updatedAt") ?? (currentQuestion ? getNumberField(currentQuestion, "updatedAt") : undefined)
        const terminalResultSent = previousTerminal?.terminalResultSent === true || payload.terminalResultSent === true
          ? true
          : payload.terminalResultSent === false
            ? false
            : undefined
        state.terminalMetadata[routeKey] = {
          reason,
          ...(handle ? { handle } : {}),
          ...(requestID ? { requestID } : {}),
          ...(scopeKey ? { scopeKey } : {}),
          ...(currentQuestion && Object.hasOwn(currentQuestion, "prompt") ? { prompt: cloneUnknownValue(currentQuestion.prompt) } : {}),
          ...(wechatAccountId ? { wechatAccountId } : {}),
          ...(userId ? { userId } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...((reason === "answered" || reason === "handled") && terminalAt !== undefined ? { answeredAt: terminalAt } : {}),
          ...(reason === "rejected" && terminalAt !== undefined ? { rejectedAt: terminalAt } : {}),
          ...(reason === "expired" && terminalAt !== undefined ? { expiredAt: terminalAt } : {}),
          ...(isNonEmptyString(payload.replacementHandle) ? { replacementHandle: payload.replacementHandle } : {}),
          ...(typeof terminalResultSent === "boolean"
            ? { terminalResultSent }
            : {}),
          ...(isSafeInteger(payload.retainedUntil) ? { retainedUntil: payload.retainedUntil } : {}),
        }
        if (handle) {
          writeLegacyHandleClosure(state, {
            kind: "question",
            handle,
            reason,
            routeKey,
            ...(isNonEmptyString(payload.replacementHandle) ? { replacementHandle: payload.replacementHandle } : {}),
            ...(isSafeInteger(payload.retainedUntil) ? { retainedUntil: payload.retainedUntil } : {}),
          })
        }
      }
      return state
    }
    case "permissionOpened":
    case "permissionUpdated": {
      const routeKey = getStringField(payload, "routeKey")
      if (!routeKey) {
        throw new Error("invalid permission payload")
      }

      const instanceID = resolveInstanceID(payload, context)
      state.active.permissions[routeKey] = {
        ...payload,
        ...(instanceID ? { instanceID } : {}),
        instanceIncarnation: event.instanceIncarnation,
      }
      state.active.permissions = ensureUniqueBrokerRequestHandles(state.active.permissions, "permission", {
        updatedRouteKey: routeKey,
      })
      const handle = getStringField(payload, "handle")
      if (handle) {
        delete state.legacyHandleClosures[handle]
      }
      return state
    }
    case "permissionClosed": {
      const routeKey = getStringField(payload, "routeKey")
      if (!routeKey) {
        throw new Error("invalid permission payload")
      }
      const currentPermission = isRecord(state.active.permissions[routeKey]) ? state.active.permissions[routeKey] : undefined
      const previousTerminal = state.terminalMetadata[routeKey]
      delete state.active.permissions[routeKey]
      const reason = getStringField(payload, "reason")
      if (reason) {
        const handle = (currentPermission ? getStringField(currentPermission, "handle") : undefined)
          ?? (isNonEmptyString(previousTerminal?.handle) ? previousTerminal.handle : undefined)
          ?? getStringField(payload, "handle")
        const requestID = getStringField(payload, "requestID") ?? (currentPermission ? getStringField(currentPermission, "requestID") : undefined) ?? previousTerminal?.requestID
        const scopeKey = getStringField(payload, "scopeKey") ?? (currentPermission ? readBrokerScopeKey(currentPermission) : undefined) ?? previousTerminal?.scopeKey
        const wechatAccountId = getStringField(payload, "wechatAccountId") ?? (currentPermission ? getStringField(currentPermission, "wechatAccountId") : undefined) ?? previousTerminal?.wechatAccountId
        const userId = getStringField(payload, "userId") ?? (currentPermission ? getStringField(currentPermission, "userId") : undefined) ?? previousTerminal?.userId
        const createdAt = getNumberField(payload, "createdAt") ?? (currentPermission ? getNumberField(currentPermission, "createdAt") : undefined) ?? previousTerminal?.createdAt
        const terminalAt = getNumberField(payload, "updatedAt") ?? (currentPermission ? getNumberField(currentPermission, "updatedAt") : undefined)
        const terminalResultSent = previousTerminal?.terminalResultSent === true || payload.terminalResultSent === true
          ? true
          : payload.terminalResultSent === false
            ? false
            : undefined
        state.terminalMetadata[routeKey] = {
          reason,
          ...(handle ? { handle } : {}),
          ...(requestID ? { requestID } : {}),
          ...(scopeKey ? { scopeKey } : {}),
          ...(currentPermission && Object.hasOwn(currentPermission, "prompt") ? { prompt: cloneUnknownValue(currentPermission.prompt) } : {}),
          ...(wechatAccountId ? { wechatAccountId } : {}),
          ...(userId ? { userId } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...((reason === "answered" || reason === "handled") && terminalAt !== undefined ? { answeredAt: terminalAt } : {}),
          ...(reason === "rejected" && terminalAt !== undefined ? { rejectedAt: terminalAt } : {}),
          ...(reason === "expired" && terminalAt !== undefined ? { expiredAt: terminalAt } : {}),
          ...(isNonEmptyString(payload.replacementHandle) ? { replacementHandle: payload.replacementHandle } : {}),
          ...(typeof terminalResultSent === "boolean"
            ? { terminalResultSent }
            : {}),
          ...(isSafeInteger(payload.retainedUntil) ? { retainedUntil: payload.retainedUntil } : {}),
        }
        if (handle) {
          writeLegacyHandleClosure(state, {
            kind: "permission",
            handle,
            reason,
            routeKey,
            ...(isNonEmptyString(payload.replacementHandle) ? { replacementHandle: payload.replacementHandle } : {}),
            ...(isSafeInteger(payload.retainedUntil) ? { retainedUntil: payload.retainedUntil } : {}),
          })
        }
      }
      return state
    }
    case "naturalStopOpened": {
      const handle = getStringField(payload, "handle")
      if (!handle) {
        throw new Error("invalid naturalStop payload")
      }

      const instanceID = resolveInstanceID(payload, context)
      state.active.naturalStops[handle] = {
        ...payload,
        ...(instanceID ? { instanceID } : {}),
        instanceIncarnation: event.instanceIncarnation,
      }
      delete state.legacyHandleClosures[handle]
      return state
    }
    case "naturalStopClosed": {
      const handle = getStringField(payload, "handle")
      if (!handle) {
        throw new Error("invalid naturalStop payload")
      }
      const currentNaturalStop = isRecord(state.active.naturalStops[handle]) ? state.active.naturalStops[handle] : undefined
      delete state.active.naturalStops[handle]
      const retainedUntil = getNumberField(payload, "retainedUntil")
      if (retainedUntil !== undefined) {
        state.retainedOccupancy[handle] = {
          handle,
          retainedUntil,
        }
      }
      const reason = getStringField(payload, "reason")
        ?? getStringField(payload, "terminalReason")
        ?? getStringField(payload, "naturalStopTerminalReason")
        ?? (currentNaturalStop ? getStringField(currentNaturalStop, "naturalStopTerminalReason") : undefined)
      if (reason) {
        writeLegacyHandleClosure(state, {
          kind: "naturalStop",
          handle,
          reason,
          ...(retainedUntil !== undefined ? { retainedUntil } : {}),
        })
      }
      return state
    }
    case "retryErrorUpdated": {
      const retryKey = getStringField(payload, "sessionID") ?? getStringField(payload, "instanceID") ?? `retry-${event.eventSeq}`
      const instanceID = resolveInstanceID(payload, context)
      state.active.retryErrors[retryKey] = {
        ...payload,
        ...(instanceID ? { instanceID } : {}),
        instanceIncarnation: event.instanceIncarnation,
      }
      return state
    }
    case "commandAccepted": {
      const commandId = getStringField(payload, "commandId")
      if (!commandId || !connection) {
        throw new Error("invalid commandAccepted payload")
      }

      markBrokerCommandAccepted(state, {
        commandId,
        instanceID: connection.instanceID,
        instanceIncarnation: event.instanceIncarnation,
        eventSeq: event.eventSeq,
        acceptedAt: getNumberField(payload, "acceptedAt"),
      })
      return state
    }
    case "commandResult": {
      const commandId = getStringField(payload, "commandId")
      const status = payload.status
      if (!commandId || !connection || (status !== "completed" && status !== "failed")) {
        throw new Error("invalid commandResult payload")
      }

      markBrokerCommandResult(state, {
        commandId,
        instanceID: connection.instanceID,
        instanceIncarnation: event.instanceIncarnation,
        eventSeq: event.eventSeq,
        status,
        completedAt: getNumberField(payload, "completedAt"),
        failure: isRecord(payload.failure) ? payload.failure : undefined,
      })
      return state
    }
    case "fullSyncCompleted": {
      const controlId = event.controlId ?? getStringField(payload, "controlId")
      if (!controlId) {
        throw new Error("invalid fullSyncCompleted payload")
      }

      state.fullSync = {
        ...state.fullSync,
        lastCompletedControlId: controlId,
        lastCompletedEventSeq: event.eventSeq,
        lastCompletedInstanceIncarnation: event.instanceIncarnation,
      }
      return state
    }
    default:
      return state
  }
}

function matchesActiveScope(record: UnknownRecord, scope: BrokerConnectionScope): boolean {
  const instanceID = getStringField(record, "instanceID")
  if (instanceID !== scope.instanceID) {
    return false
  }

  const instanceIncarnation = getStringField(record, "instanceIncarnation")
  return instanceIncarnation === undefined || instanceIncarnation === scope.instanceIncarnation
}

function addScopedRecord(record: UnknownRecord, scope: BrokerConnectionScope): UnknownRecord {
  return {
    ...record,
    instanceID: getStringField(record, "instanceID") ?? scope.instanceID,
    instanceIncarnation: getStringField(record, "instanceIncarnation") ?? scope.instanceIncarnation,
  }
}

function replaceScopedActiveRecords(
  current: Record<string, UnknownRecord>,
  incoming: Record<string, UnknownRecord>,
  scope: BrokerConnectionScope,
): Record<string, UnknownRecord> {
  const retainedEntries = Object.entries(current).filter(([, record]) => !matchesActiveScope(record, scope))
  const scopedEntries = Object.entries(incoming).map(([key, record]) => [key, addScopedRecord(record, scope)])
  return Object.fromEntries([...retainedEntries, ...scopedEntries])
}

export function applyFullSyncSnapshot(
  state: BrokerState,
  scope: BrokerConnectionScope,
  snapshot: BrokerFullSyncSnapshot,
): BrokerState {
  rememberBrokerState(state)
  if (!isNonEmptyString(scope.instanceID) || !isNonEmptyString(scope.instanceIncarnation)) {
    throw new Error("invalid full sync scope")
  }
  if (!isRecord(snapshot) || !isRecord(snapshot.active)) {
    throw new Error("invalid full sync snapshot")
  }

  if (snapshot.connections?.[scope.instanceID]?.[scope.instanceIncarnation]) {
    const incomingConnection = snapshot.connections[scope.instanceID][scope.instanceIncarnation]
    getConnectionGroup(state, scope.instanceID)[scope.instanceIncarnation] = { ...incomingConnection }
  }

  // Full sync only replaces the targeted instance/incarnation live domains.
  state.active = {
    instances: replaceScopedActiveRecords(state.active.instances, snapshot.active.instances, scope),
    sessions: replaceScopedActiveRecords(state.active.sessions, snapshot.active.sessions, scope),
    questions: ensureUniqueBrokerRequestHandles(
      replaceScopedActiveRecords(state.active.questions, snapshot.active.questions, scope),
      "question",
      { updatedScope: scope },
    ),
    permissions: ensureUniqueBrokerRequestHandles(
      replaceScopedActiveRecords(state.active.permissions, snapshot.active.permissions, scope),
      "permission",
      { updatedScope: scope },
    ),
    naturalStops: replaceScopedActiveRecords(state.active.naturalStops, snapshot.active.naturalStops, scope),
    retryErrors: replaceScopedActiveRecords(state.active.retryErrors, snapshot.active.retryErrors, scope),
  }
  return state
}

export function upsertBrokerCommand(
  state: BrokerState,
  input: UpsertBrokerCommandInput,
): BrokerCommandRecord {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.commandId)) {
    throw new Error("invalid commandId")
  }
  assertNonNegativeInteger(input.brokerSeq, "brokerSeq")
  assertCommandType(input.type)
  if (input.status !== "queued" && input.status !== "delivered") {
    throw new Error("invalid broker command status")
  }
  if (!isRecord(input.target)) {
    throw new Error("invalid broker command target")
  }

  const current = state.commandLedger[input.commandId]
  const next: BrokerCommandRecord = {
    commandId: input.commandId,
    brokerSeq: input.brokerSeq,
    type: input.type,
    target: { ...input.target },
    ...(input.payload !== undefined
      ? { payload: cloneUnknownValue(input.payload) }
      : current?.payload !== undefined
        ? { payload: cloneUnknownValue(current.payload) }
        : {}),
    status: input.status,
    ...(current?.acceptedAt !== undefined ? { acceptedAt: current.acceptedAt } : {}),
    ...(current?.completedAt !== undefined ? { completedAt: current.completedAt } : {}),
    ...(current?.failure ? { failure: { ...current.failure } } : {}),
    ...(input.instanceID !== undefined
      ? { instanceID: input.instanceID }
      : current?.instanceID
        ? { instanceID: current.instanceID }
        : {}),
    ...(input.instanceIncarnation !== undefined
      ? { instanceIncarnation: input.instanceIncarnation }
      : current?.instanceIncarnation
        ? { instanceIncarnation: current.instanceIncarnation }
        : {}),
    ...(current?.acceptedEventSeq !== undefined ? { acceptedEventSeq: current.acceptedEventSeq } : {}),
    ...(current?.resultEventSeq !== undefined ? { resultEventSeq: current.resultEventSeq } : {}),
  }
  state.commandLedger[input.commandId] = next
  return next
}

function requireControlRecord(state: BrokerState, controlId: string): BrokerControlRecord {
  const current = state.controlLedger[controlId]
  if (!current) {
    throw new Error("unknown broker control")
  }
  return current
}

function createRetryErrorKey(input: Pick<UpsertRetryErrorSummaryInput, "instanceID" | "sessionID">): string {
  return isNonEmptyString(input.sessionID) ? input.sessionID.trim() : input.instanceID.trim()
}

function createBrokerRequestIndexKey(input: Pick<BrokerIndexedRequestRecord, "kind" | "routeKey">): string {
  return `${input.kind}:${input.routeKey}`
}

function createBrokerDeliveryTokenKey(input: Pick<BrokerDeliveryTokenState, "wechatAccountId" | "userId">): string {
  return `${input.wechatAccountId}:${input.userId}`
}

function readBrokerScopeKey(record: Record<string, unknown>): string | undefined {
  return getStringField(record, "scopeKey") ?? getStringField(record, "instanceID")
}

function normalizeHandleOrUndefined(value: string | undefined): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined
  }
  try {
    return normalizeHandle(value)
  } catch {
    return undefined
  }
}

function brokerHandleIdentityKey(value: string | undefined): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined
  }
  return normalizeHandleOrUndefined(value) ?? value.trim().toLowerCase()
}

function sortBrokerRequestRecords(left: [string, UnknownRecord], right: [string, UnknownRecord]): number {
  const leftCreated = getNumberField(left[1], "createdAt") ?? 0
  const rightCreated = getNumberField(right[1], "createdAt") ?? 0
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated
  }
  return left[0].localeCompare(right[0])
}

type EnsureUniqueBrokerRequestHandleOptions = {
  updatedRouteKey?: string
  updatedScope?: BrokerConnectionScope
}

type BrokerRequestHandleReservation = {
  kind: "question" | "permission"
  routeKey: string
  handle: string
  createdAt: number
  sentAt?: number
}

const VISIBLE_REQUEST_RESERVATION_READ_RETRIES = 3
const VISIBLE_REQUEST_RESERVATION_READ_RETRY_DELAY_MS = 5

function isVisibleRequestNotificationStatus(value: unknown): boolean {
  return value === "pending" || value === "sent"
}

function toRequestHandleReservation(record: UnknownRecord): BrokerRequestHandleReservation | undefined {
  const kind = record.kind === "question" || record.kind === "permission" ? record.kind : undefined
  const routeKey = getStringField(record, "routeKey")
  const handle = normalizeHandleOrUndefined(getStringField(record, "handle"))
  const createdAt = getNumberField(record, "createdAt")
  if (!kind || !routeKey || !handle || createdAt === undefined || !isVisibleRequestNotificationStatus(record.status)) {
    return undefined
  }

  const sentAt = getNumberField(record, "sentAt")
  return {
    kind,
    routeKey,
    handle,
    createdAt,
    ...(sentAt !== undefined ? { sentAt } : {}),
  }
}

function waitForVisibleRequestReservationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, VISIBLE_REQUEST_RESERVATION_READ_RETRY_DELAY_MS))
}

async function readJsonFileForVisibleRequestReservation(filePath: string): Promise<unknown | undefined> {
  for (let attempt = 0; attempt < VISIBLE_REQUEST_RESERVATION_READ_RETRIES; attempt += 1) {
    try {
      const raw = await readFile(filePath, "utf8")
      return JSON.parse(raw) as unknown
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined
      }
      if (attempt < VISIBLE_REQUEST_RESERVATION_READ_RETRIES - 1) {
        await waitForVisibleRequestReservationRetry()
      }
    }
  }
  return undefined
}

async function listVisibleRequestHandleReservations(): Promise<BrokerRequestHandleReservation[]> {
  const notificationFiles = await listJsonFiles(notificationsDir())
  const reservations: BrokerRequestHandleReservation[] = []
  for (const filePath of notificationFiles) {
    const raw = await readJsonFileForVisibleRequestReservation(filePath)
    if (!isRecord(raw)) {
      continue
    }
    const reservation = toRequestHandleReservation(raw)
    if (reservation) {
      reservations.push(reservation)
    }
  }
  return reservations.sort((left, right) => {
    const leftAt = left.sentAt ?? left.createdAt
    const rightAt = right.sentAt ?? right.createdAt
    if (leftAt !== rightAt) return leftAt - rightAt
    return left.routeKey.localeCompare(right.routeKey)
  })
}

function selectVisibleRequestHandlesByRoute(
  records: Record<string, UnknownRecord>,
  kind: "question" | "permission",
  reservations: BrokerRequestHandleReservation[],
): Map<string, string> {
  const activeRoutes = new Set(Object.keys(records))
  const byRoute = new Map<string, string>()
  for (const reservation of reservations) {
    if (reservation.kind !== kind || !activeRoutes.has(reservation.routeKey)) {
      continue
    }
    byRoute.set(reservation.routeKey, reservation.handle)
  }
  return byRoute
}

function isReservedForAnotherRoute(routeKey: string, handleKey: string, routeReservations: Map<string, string>): boolean {
  for (const [reservedRouteKey, reservedHandle] of routeReservations) {
    if (reservedRouteKey === routeKey) {
      continue
    }
    if (brokerHandleIdentityKey(reservedHandle) === handleKey) {
      return true
    }
  }
  return false
}

function listReservedHandlesForOtherRoutes(routeKey: string, routeReservations: Map<string, string>): string[] {
  const handles: string[] = []
  for (const [reservedRouteKey, reservedHandle] of routeReservations) {
    if (reservedRouteKey !== routeKey) {
      handles.push(reservedHandle)
    }
  }
  return handles
}

function orderBrokerRequestRecordsForHandleAllocation(
  records: Record<string, UnknownRecord>,
  options: EnsureUniqueBrokerRequestHandleOptions,
): Array<[string, UnknownRecord]> {
  const entries = Object.entries(records)
  if (isNonEmptyString(options.updatedRouteKey)) {
    const retained = entries.filter(([routeKey]) => routeKey !== options.updatedRouteKey).sort(sortBrokerRequestRecords)
    const updated = entries.filter(([routeKey]) => routeKey === options.updatedRouteKey)
    return [...retained, ...updated]
  }

  if (options.updatedScope) {
    const retained = entries
      .filter(([, record]) => !matchesActiveScope(record, options.updatedScope as BrokerConnectionScope))
      .sort(sortBrokerRequestRecords)
    const updated = entries
      .filter(([, record]) => matchesActiveScope(record, options.updatedScope as BrokerConnectionScope))
      .sort(sortBrokerRequestRecords)
    return [...retained, ...updated]
  }

  return entries.sort(sortBrokerRequestRecords)
}

function ensureUniqueBrokerRequestHandles(
  records: Record<string, UnknownRecord>,
  kind: "question" | "permission",
  options: EnsureUniqueBrokerRequestHandleOptions = {},
): Record<string, UnknownRecord> {
  const usedHandles: string[] = []
  const usedIdentityKeys = new Set<string>()
  const nextEntries: Array<[string, UnknownRecord]> = []

  for (const [routeKey, record] of orderBrokerRequestRecordsForHandleAllocation(records, options)) {
    const rawHandle = getStringField(record, "handle")
    const requestedHandle = normalizeHandleOrUndefined(rawHandle) ?? rawHandle?.trim()
    const requestedKey = brokerHandleIdentityKey(requestedHandle)
    const handle = requestedHandle && requestedKey && !usedIdentityKeys.has(requestedKey)
      ? requestedHandle
      : createHandle(kind, usedHandles)
    usedHandles.push(handle)
    const handleKey = brokerHandleIdentityKey(handle)
    if (handleKey) {
      usedIdentityKeys.add(handleKey)
    }
    nextEntries.push([routeKey, { ...record, handle }])
  }

  return Object.fromEntries(nextEntries)
}

function ensureUniqueBrokerRequestHandlesWithVisibleReservations(
  records: Record<string, UnknownRecord>,
  kind: "question" | "permission",
  routeReservations: Map<string, string>,
): Record<string, UnknownRecord> {
  if (routeReservations.size === 0) {
    return records
  }

  const usedHandles: string[] = []
  const usedIdentityKeys = new Set<string>()
  const nextEntries: Array<[string, UnknownRecord]> = []

  for (const [routeKey, record] of orderBrokerRequestRecordsForHandleAllocation(records, {})) {
    const reservedHandle = routeReservations.get(routeKey)
    const reservedKey = brokerHandleIdentityKey(reservedHandle)
    const rawHandle = getStringField(record, "handle")
    const requestedHandle = normalizeHandleOrUndefined(rawHandle) ?? rawHandle?.trim()
    const requestedKey = brokerHandleIdentityKey(requestedHandle)
    let handle: string

    if (reservedHandle && reservedKey && !usedIdentityKeys.has(reservedKey)) {
      handle = reservedHandle
    } else if (
      requestedHandle
      && requestedKey
      && !usedIdentityKeys.has(requestedKey)
      && !isReservedForAnotherRoute(routeKey, requestedKey, routeReservations)
    ) {
      handle = requestedHandle
    } else {
      handle = createHandle(kind, [
        ...usedHandles,
        ...listReservedHandlesForOtherRoutes(routeKey, routeReservations),
      ])
    }

    usedHandles.push(handle)
    const handleKey = brokerHandleIdentityKey(handle)
    if (handleKey) {
      usedIdentityKeys.add(handleKey)
    }
    nextEntries.push([routeKey, { ...record, handle }])
  }

  return Object.fromEntries(nextEntries)
}

function syncOpenRequestIndexHandlesWithActive(
  state: BrokerState,
  kind: "question" | "permission",
  activeRecords: Record<string, UnknownRecord>,
): void {
  for (const [routeKey, activeRecord] of Object.entries(activeRecords)) {
    const handle = getStringField(activeRecord, "handle")
    if (!handle) {
      continue
    }
    const indexKey = createBrokerRequestIndexKey({ kind, routeKey })
    const indexed = state.requestIndex[indexKey]
    if (indexed?.status === "open" && indexed.handle !== handle) {
      state.requestIndex[indexKey] = {
        ...indexed,
        handle,
      }
    }
  }
}

export async function reconcileBrokerActiveRequestHandlesWithVisibleNotifications(state: BrokerState): Promise<BrokerState> {
  rememberBrokerState(state)
  const reservations = await listVisibleRequestHandleReservations()
  if (reservations.length === 0) {
    return state
  }

  state.active.questions = ensureUniqueBrokerRequestHandlesWithVisibleReservations(
    state.active.questions,
    "question",
    selectVisibleRequestHandlesByRoute(state.active.questions, "question", reservations),
  )
  state.active.permissions = ensureUniqueBrokerRequestHandlesWithVisibleReservations(
    state.active.permissions,
    "permission",
    selectVisibleRequestHandlesByRoute(state.active.permissions, "permission", reservations),
  )
  syncOpenRequestIndexHandlesWithActive(state, "question", state.active.questions)
  syncOpenRequestIndexHandlesWithActive(state, "permission", state.active.permissions)
  return state
}

function toBrokerIndexedRequestRecord(input: BrokerIndexedRequestRecord): BrokerIndexedRequestRecord {
  if (
    (input.kind !== "question" && input.kind !== "permission")
    || !isNonEmptyString(input.requestID)
    || !isNonEmptyString(input.routeKey)
    || !isNonEmptyString(input.handle)
    || !isNonEmptyString(input.wechatAccountId)
    || !isNonEmptyString(input.userId)
    || !isSafeInteger(input.createdAt)
  ) {
    throw new Error("invalid broker indexed request")
  }

  if (!["open", "answered", "rejected", "expired", "cleaned"].includes(input.status)) {
    throw new Error("invalid broker indexed request")
  }

  return cloneUnknownValue({
    kind: input.kind,
    requestID: input.requestID,
    routeKey: input.routeKey,
    handle: input.handle,
    ...(isNonEmptyString(input.scopeKey) ? { scopeKey: input.scopeKey } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    status: input.status,
    createdAt: input.createdAt,
    ...(isSafeInteger(input.answeredAt) ? { answeredAt: input.answeredAt } : {}),
    ...(isSafeInteger(input.rejectedAt) ? { rejectedAt: input.rejectedAt } : {}),
    ...(isSafeInteger(input.expiredAt) ? { expiredAt: input.expiredAt } : {}),
    ...(isSafeInteger(input.cleanedAt) ? { cleanedAt: input.cleanedAt } : {}),
    ...(isNonEmptyString(input.terminalReason) ? { terminalReason: input.terminalReason } : {}),
    ...(isNonEmptyString(input.replacementHandle) ? { replacementHandle: input.replacementHandle } : {}),
    ...(input.terminalResultSent === true ? { terminalResultSent: true } : {}),
  })
}

function toBrokerDeliveryTokenState(input: BrokerDeliveryTokenState): BrokerDeliveryTokenState {
  if (
    !isNonEmptyString(input.wechatAccountId)
    || !isNonEmptyString(input.userId)
    || !isNonEmptyString(input.contextToken)
    || !isSafeInteger(input.updatedAt)
    || (input.source !== "question" && input.source !== "permission" && input.source !== "message")
  ) {
    throw new Error("invalid broker delivery token")
  }

  if (
    (input.sourceRef !== undefined && !isNonEmptyString(input.sourceRef))
    || (input.staleReason !== undefined && !isNonEmptyString(input.staleReason))
  ) {
    throw new Error("invalid broker delivery token")
  }

  return {
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    contextToken: input.contextToken,
    updatedAt: input.updatedAt,
    source: input.source,
    ...(isNonEmptyString(input.sourceRef) ? { sourceRef: input.sourceRef } : {}),
    ...(isNonEmptyString(input.staleReason) ? { staleReason: input.staleReason } : {}),
  }
}

export function readBrokerControlRecord(state: BrokerState, controlId: string): BrokerControlRecord | undefined {
  return state.controlLedger[controlId]
}

export function upsertRetryErrorSummary(
  state: BrokerState,
  input: UpsertRetryErrorSummaryInput,
): UnknownRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.action)
    || !isNonEmptyString(input.redactedSummary)
    || !isNonEmptyString(input.severityAdvice)
  ) {
    throw new Error("invalid retry error summary")
  }
  if (input.updatedAt !== undefined) {
    assertNonNegativeInteger(input.updatedAt, "updatedAt")
  }

  const key = createRetryErrorKey(input)
  const next: UnknownRecord = {
    instanceID: input.instanceID.trim(),
    action: input.action.trim(),
    redactedSummary: input.redactedSummary.trim(),
    severityAdvice: input.severityAdvice.trim(),
    ...(isNonEmptyString(input.sessionID) ? { sessionID: input.sessionID.trim() } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    ...(isNonEmptyString(input.instanceIncarnation) ? { instanceIncarnation: input.instanceIncarnation.trim() } : {}),
  }
  state.active.retryErrors[key] = next
  return next
}

export function upsertBrokerIndexedRequest(
  state: BrokerState,
  input: BrokerIndexedRequestRecord,
): BrokerIndexedRequestRecord {
  rememberBrokerState(state)
  const next = toBrokerIndexedRequestRecord(input)
  state.requestIndex[createBrokerRequestIndexKey(next)] = cloneIndexedRequestRecord(next)

  if (next.status === "open") {
    const activeKey = next.kind === "question" ? "questions" : "permissions"
    state.active[activeKey][next.routeKey] = {
      routeKey: next.routeKey,
      handle: next.handle,
      requestID: next.requestID,
      ...(isNonEmptyString(next.scopeKey) ? { scopeKey: next.scopeKey, instanceID: next.scopeKey } : {}),
      ...(next.prompt !== undefined ? { prompt: cloneUnknownValue(next.prompt) } : {}),
      wechatAccountId: next.wechatAccountId,
      userId: next.userId,
      createdAt: next.createdAt,
    }
    delete state.terminalMetadata[next.routeKey]
    delete state.legacyHandleClosures[next.handle]
    return cloneIndexedRequestRecord(next)
  }

  const activeKey = next.kind === "question" ? "questions" : "permissions"
  delete state.active[activeKey][next.routeKey]
  state.terminalMetadata[next.routeKey] = {
    reason: next.terminalReason ?? next.status,
    ...(isNonEmptyString(next.replacementHandle) ? { replacementHandle: next.replacementHandle } : {}),
    ...(next.terminalResultSent === true ? { terminalResultSent: true } : {}),
    handle: next.handle,
    requestID: next.requestID,
    ...(isNonEmptyString(next.scopeKey) ? { scopeKey: next.scopeKey } : {}),
    ...(next.prompt !== undefined ? { prompt: cloneUnknownValue(next.prompt) } : {}),
    wechatAccountId: next.wechatAccountId,
    userId: next.userId,
    createdAt: next.createdAt,
    ...(isSafeInteger(next.answeredAt) ? { answeredAt: next.answeredAt } : {}),
    ...(isSafeInteger(next.rejectedAt) ? { rejectedAt: next.rejectedAt } : {}),
    ...(isSafeInteger(next.expiredAt) ? { expiredAt: next.expiredAt } : {}),
    ...(isSafeInteger(next.cleanedAt) ? { cleanedAt: next.cleanedAt } : {}),
  }
  writeLegacyHandleClosure(state, {
    kind: next.kind,
    handle: next.handle,
    reason: next.terminalReason ?? next.status,
    routeKey: next.routeKey,
    ...(isNonEmptyString(next.replacementHandle) ? { replacementHandle: next.replacementHandle } : {}),
  })
  return cloneIndexedRequestRecord(next)
}

export async function readBrokerIndexedRequest(
  input: { kind: "question" | "permission"; routeKey: string },
  state?: BrokerState,
): Promise<BrokerIndexedRequestRecord | undefined> {
  const resolved = state ?? await loadBrokerStateStoreSnapshot()
  if (!resolved || !isNonEmptyString(input.routeKey)) {
    return undefined
  }

  const current = resolved.requestIndex[createBrokerRequestIndexKey(input)]
  if (current) {
    return cloneIndexedRequestRecord(current)
  }

  const activeKey = input.kind === "question" ? "questions" : "permissions"
  const active = resolved.active[activeKey][input.routeKey]
  if (isRecord(active)) {
    const requestID = getStringField(active, "requestID")
    const handle = getStringField(active, "handle")
    const wechatAccountId = getStringField(active, "wechatAccountId")
    const userId = getStringField(active, "userId")
    const createdAt = getNumberField(active, "createdAt")
    if (requestID && handle && wechatAccountId && userId && createdAt !== undefined) {
      return {
        kind: input.kind,
        requestID,
        routeKey: input.routeKey,
        handle,
        ...(getStringField(active, "scopeKey") ? { scopeKey: getStringField(active, "scopeKey") } : {}),
        ...(Object.hasOwn(active, "prompt") ? { prompt: cloneUnknownValue(active.prompt) } : {}),
        wechatAccountId,
        userId,
        status: "open",
        createdAt,
      }
    }
  }

  const terminal = resolved.terminalMetadata[input.routeKey]
  if (
    terminal
    && isNonEmptyString(terminal.handle)
    && isNonEmptyString(terminal.requestID)
    && isNonEmptyString(terminal.wechatAccountId)
    && isNonEmptyString(terminal.userId)
    && isSafeInteger(terminal.createdAt)
  ) {
    return {
      kind: input.kind,
      requestID: terminal.requestID,
      routeKey: input.routeKey,
      handle: terminal.handle,
      ...(isNonEmptyString(terminal.scopeKey) ? { scopeKey: terminal.scopeKey } : {}),
      ...(terminal.prompt !== undefined ? { prompt: cloneUnknownValue(terminal.prompt) } : {}),
      wechatAccountId: terminal.wechatAccountId,
      userId: terminal.userId,
      status: terminal.cleanedAt !== undefined ? "cleaned" : terminal.expiredAt !== undefined ? "expired" : terminal.rejectedAt !== undefined ? "rejected" : "answered",
      createdAt: terminal.createdAt,
      ...(isSafeInteger(terminal.answeredAt) ? { answeredAt: terminal.answeredAt } : {}),
      ...(isSafeInteger(terminal.rejectedAt) ? { rejectedAt: terminal.rejectedAt } : {}),
      ...(isSafeInteger(terminal.expiredAt) ? { expiredAt: terminal.expiredAt } : {}),
      ...(isSafeInteger(terminal.cleanedAt) ? { cleanedAt: terminal.cleanedAt } : {}),
      ...(isNonEmptyString(terminal.reason) ? { terminalReason: terminal.reason as BrokerIndexedRequestRecord["terminalReason"] } : {}),
      ...(isNonEmptyString(terminal.replacementHandle) ? { replacementHandle: terminal.replacementHandle } : {}),
      ...(terminal.terminalResultSent === true ? { terminalResultSent: true } : {}),
    }
  }

  return undefined
}

export function upsertBrokerDeliveryToken(
  state: BrokerState,
  input: BrokerDeliveryTokenState,
): BrokerDeliveryTokenState {
  rememberBrokerState(state)
  const next = toBrokerDeliveryTokenState(input)
  state.deliveryTokens[createBrokerDeliveryTokenKey(next)] = cloneDeliveryTokenState(next)
  return cloneDeliveryTokenState(next)
}

export async function readBrokerDeliveryToken(
  input: { wechatAccountId: string; userId: string },
  state?: BrokerState,
): Promise<BrokerDeliveryTokenState | undefined> {
  const resolved = state ?? await loadBrokerStateStoreSnapshot()
  if (!resolved || !isNonEmptyString(input.wechatAccountId) || !isNonEmptyString(input.userId)) {
    return undefined
  }

  const current = resolved.deliveryTokens[createBrokerDeliveryTokenKey(input)]
  return current ? cloneDeliveryTokenState(current) : undefined
}

function collectBrokerOpenRequestsForScope(
  state: BrokerState,
  scopeKey: string,
): BrokerIndexedRequestRecord[] {
  const indexed = new Map<string, BrokerIndexedRequestRecord>()

  for (const record of Object.values(state.requestIndex)) {
    if (record.status !== "open") {
      continue
    }
    if (record.scopeKey !== scopeKey) {
      continue
    }
    indexed.set(createBrokerRequestIndexKey(record), cloneIndexedRequestRecord(record))
  }

  for (const kind of ["question", "permission"] as const) {
    const source = kind === "question" ? state.active.questions : state.active.permissions
    for (const [routeKey, rawRecord] of Object.entries(source)) {
      if (!isRecord(rawRecord)) {
        continue
      }
      if (readBrokerScopeKey(rawRecord) !== scopeKey) {
        continue
      }
      const key = createBrokerRequestIndexKey({ kind, routeKey })
      if (indexed.has(key)) {
        continue
      }
      const requestID = getStringField(rawRecord, "requestID")
      const handle = getStringField(rawRecord, "handle")
      const wechatAccountId = getStringField(rawRecord, "wechatAccountId")
      const userId = getStringField(rawRecord, "userId")
      const createdAt = getNumberField(rawRecord, "createdAt")
      if (!requestID || !handle || !wechatAccountId || !userId || createdAt === undefined) {
        continue
      }
      indexed.set(key, {
        kind,
        requestID,
        routeKey,
        handle,
        scopeKey,
        ...(Object.hasOwn(rawRecord, "prompt") ? { prompt: cloneUnknownValue(rawRecord.prompt) } : {}),
        wechatAccountId,
        userId,
        status: "open",
        createdAt,
      })
    }
  }

  return [...indexed.values()].sort((left, right) => left.createdAt - right.createdAt)
}

export function expireBrokerIndexedRequestsForScope(
  state: BrokerState,
  input: { scopeKey: string; expiredAt: number },
): BrokerRuntimeExpiredRequest[] {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.scopeKey)) {
    throw new Error("invalid broker request expiration scope")
  }
  assertNonNegativeInteger(input.expiredAt, "expiredAt")

  const expired: BrokerRuntimeExpiredRequest[] = []
  for (const record of collectBrokerOpenRequestsForScope(state, input.scopeKey)) {
    const next = upsertBrokerIndexedRequest(state, {
      ...record,
      status: "expired",
      expiredAt: input.expiredAt,
      terminalReason: "expired",
      terminalResultSent: record.terminalResultSent === true,
    })
    expired.push(next)
  }

  return expired
}

export function closeBrokerNaturalStopsForScope(
  state: BrokerState,
  input: { scopeKey: string; terminalReason: string },
): BrokerRuntimeClosedNaturalStop[] {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.scopeKey) || !isNonEmptyString(input.terminalReason)) {
    throw new Error("invalid broker natural-stop closure scope")
  }

  const closed: BrokerRuntimeClosedNaturalStop[] = []
  for (const [handle, rawRecord] of Object.entries(state.active.naturalStops)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.naturalStops[handle]
    const retainedUntil = getNumberField(rawRecord, "retainedUntil")
    if (retainedUntil !== undefined) {
      state.retainedOccupancy[handle] = {
        handle,
        retainedUntil,
      }
    }
    writeLegacyHandleClosure(state, {
      kind: "naturalStop",
      handle,
      reason: input.terminalReason,
      ...(retainedUntil !== undefined ? { retainedUntil } : {}),
    })
    closed.push({
      handle,
      ...(readBrokerScopeKey(rawRecord) ? { scopeKey: readBrokerScopeKey(rawRecord) } : {}),
      ...(getStringField(rawRecord, "idempotencyKey") ? { idempotencyKey: getStringField(rawRecord, "idempotencyKey") } : {}),
      terminalReason: input.terminalReason,
    })
  }

  return closed
}

export function clearBrokerActiveScope(
  state: BrokerState,
  input: { scopeKey: string },
): void {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.scopeKey)) {
    throw new Error("invalid broker active scope")
  }

  for (const [sessionID, rawRecord] of Object.entries(state.active.sessions)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.sessions[sessionID]
  }

  for (const [routeKey, rawRecord] of Object.entries(state.active.questions)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.questions[routeKey]
  }

  for (const [routeKey, rawRecord] of Object.entries(state.active.permissions)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.permissions[routeKey]
  }

  for (const [handle, rawRecord] of Object.entries(state.active.naturalStops)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.naturalStops[handle]
  }

  for (const [retryKey, rawRecord] of Object.entries(state.active.retryErrors)) {
    if (!isRecord(rawRecord) || readBrokerScopeKey(rawRecord) !== input.scopeKey) {
      continue
    }
    delete state.active.retryErrors[retryKey]
  }

  delete state.active.instances[input.scopeKey]
}

export function removeBrokerConnectionScope(
  state: BrokerState,
  input: BrokerConnectionScope,
): void {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.instanceID) || !isNonEmptyString(input.instanceIncarnation)) {
    throw new Error("invalid broker connection scope")
  }

  const group = state.connections[input.instanceID]
  if (!group) {
    return
  }

  delete group[input.instanceIncarnation]
  if (Object.keys(group).length === 0) {
    delete state.connections[input.instanceID]
  }
}

export function reconcileBrokerDisconnectedScopes(
  state: BrokerState,
  input: { disconnectedAt: number },
): void {
  rememberBrokerState(state)
  assertNonNegativeInteger(input.disconnectedAt, "disconnectedAt")

  for (const [instanceID, incarnations] of Object.entries(state.connections)) {
    if (Object.values(incarnations).some((connection) => connection.online)) {
      continue
    }

    expireBrokerIndexedRequestsForScope(state, {
      scopeKey: instanceID,
      expiredAt: input.disconnectedAt,
    })
    closeBrokerNaturalStopsForScope(state, {
      scopeKey: instanceID,
      terminalReason: "expired",
    })
    clearBrokerActiveScope(state, { scopeKey: instanceID })
    delete state.connections[instanceID]
  }
}

function readBrokerRequestTerminalTimestamp(record: BrokerIndexedRequestRecord): number | undefined {
  if (record.status === "answered") {
    return record.answeredAt
  }
  if (record.status === "rejected") {
    return record.rejectedAt
  }
  if (record.status === "expired") {
    return record.expiredAt
  }
  if (record.status === "cleaned") {
    return record.cleanedAt
  }
  return undefined
}

export function cleanupBrokerRuntimeTerminalRequests(
  state: BrokerState,
  input: { now: number; cleanAfterMs: number; purgeRetentionMs: number },
): BrokerRuntimeCleanupResult {
  rememberBrokerState(state)
  assertNonNegativeInteger(input.now, "now")
  assertNonNegativeInteger(input.cleanAfterMs, "cleanAfterMs")
  assertNonNegativeInteger(input.purgeRetentionMs, "purgeRetentionMs")

  const cleanedRequests: BrokerIndexedRequestRecord[] = []
  const purgedRequests: BrokerIndexedRequestRecord[] = []

  for (const record of Object.values(state.requestIndex)) {
    if (!["answered", "rejected", "expired"].includes(record.status)) {
      continue
    }
    const terminalAt = readBrokerRequestTerminalTimestamp(record)
    if (terminalAt === undefined || input.now - terminalAt < input.cleanAfterMs) {
      continue
    }
    cleanedRequests.push(upsertBrokerIndexedRequest(state, {
      ...record,
      status: "cleaned",
      cleanedAt: input.now,
      terminalReason: record.terminalReason,
      replacementHandle: record.replacementHandle,
      terminalResultSent: record.terminalResultSent,
    }))
  }

  const purgeCutoff = input.now - input.purgeRetentionMs
  for (const [key, record] of Object.entries(state.requestIndex)) {
    if (record.status !== "cleaned") {
      continue
    }
    if (!isSafeInteger(record.cleanedAt) || record.cleanedAt >= purgeCutoff) {
      continue
    }
    purgedRequests.push(cloneIndexedRequestRecord(record))
    delete state.requestIndex[key]
  }

  return { cleanedRequests, purgedRequests }
}

export function markBrokerConnectionObserved(
  state: BrokerState,
  input: BrokerConnectionScope & { observedAt: number; connectedAt?: number },
): BrokerConnectionState {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.instanceID) || !isNonEmptyString(input.instanceIncarnation)) {
    throw new Error("invalid broker connection observation")
  }
  assertNonNegativeInteger(input.observedAt, "observedAt")
  if (input.connectedAt !== undefined) {
    assertNonNegativeInteger(input.connectedAt, "connectedAt")
  }

  const connection = ensureConnection(state, input.instanceID, input.instanceIncarnation)
  connection.online = true
  connection.lastObservedAt = input.observedAt
  if (input.connectedAt !== undefined) {
    connection.connectedAt = input.connectedAt
  }
  delete connection.disconnectedAt
  delete connection.disconnectReason

  if (isRecord(state.active.instances[input.instanceID])) {
    state.active.instances[input.instanceID] = {
      ...state.active.instances[input.instanceID],
      instanceID: input.instanceID,
      instanceIncarnation: input.instanceIncarnation,
      online: true,
    }
  }

  return { ...connection }
}

export function markBrokerConnectionOffline(
  state: BrokerState,
  input: BrokerConnectionScope & { disconnectedAt: number; reason: string },
): BrokerConnectionState {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.instanceID) || !isNonEmptyString(input.instanceIncarnation) || !isNonEmptyString(input.reason)) {
    throw new Error("invalid broker connection offline")
  }
  assertNonNegativeInteger(input.disconnectedAt, "disconnectedAt")

  const connection = ensureConnection(state, input.instanceID, input.instanceIncarnation)
  connection.online = false
  connection.disconnectedAt = input.disconnectedAt
  connection.disconnectReason = input.reason

  if (isRecord(state.active.instances[input.instanceID])) {
    state.active.instances[input.instanceID] = {
      ...state.active.instances[input.instanceID],
      instanceID: input.instanceID,
      instanceIncarnation: input.instanceIncarnation,
      online: false,
      disconnectedAt: input.disconnectedAt,
      disconnectReason: input.reason,
    }
  }

  return { ...connection }
}

export function listTimedOutBrokerConnectionScopes(
  state: BrokerState,
  input: { now: number; timeoutMs: number },
): BrokerConnectionScope[] {
  assertNonNegativeInteger(input.now, "now")
  assertNonNegativeInteger(input.timeoutMs, "timeoutMs")

  const timedOut: BrokerConnectionScope[] = []
  for (const [instanceID, incarnations] of Object.entries(state.connections)) {
    for (const [instanceIncarnation, connection] of Object.entries(incarnations)) {
      if (!connection.online) {
        continue
      }
      const lastObservedAt = connection.lastObservedAt ?? connection.connectedAt
      if (!isSafeInteger(lastObservedAt)) {
        continue
      }
      if (input.now - lastObservedAt < input.timeoutMs) {
        continue
      }
      timedOut.push({ instanceID, instanceIncarnation })
    }
  }

  return timedOut
}

export function readBrokerAuthoritativeView(state?: BrokerState): BrokerAuthoritativeView {
  const resolved = resolveBrokerState(state)
  if (!resolved) {
    return {
      connections: {},
      active: createEmptyActiveState(),
      terminalMetadata: {},
      retainedOccupancy: {},
      commandLedger: {},
      legacyHandleClosures: {},
    }
  }

  return {
    connections: cloneConnectionMap(resolved.connections),
    active: cloneActiveState(resolved.active),
    terminalMetadata: cloneTerminalMetadataMap(resolved.terminalMetadata),
    retainedOccupancy: cloneRetainedOccupancyMap(resolved.retainedOccupancy),
    commandLedger: Object.fromEntries(
      Object.entries(resolved.commandLedger).map(([key, item]) => [key, cloneCommandRecord(item)]),
    ),
    legacyHandleClosures: cloneLegacyHandleClosureMap(resolved.legacyHandleClosures),
  }
}

export function readBrokerCommandStateByAction(
  input: BrokerCommandActionInput,
  state?: BrokerState,
): BrokerCommandRecord | undefined {
  const resolved = resolveBrokerState(state)
  if (!resolved) {
    return undefined
  }

  const expectedActionKey = createBrokerCommandActionKey(input)
  const matched = Object.values(resolved.commandLedger)
    .filter((record) => createBrokerCommandActionKey({
      type: record.type,
      target: record.target,
      payload: record.payload,
    }) === expectedActionKey)
    .sort((left, right) => right.brokerSeq - left.brokerSeq)[0]

  return matched ? cloneCommandRecord(matched) : undefined
}

export function readBrokerFullSyncStage(state: BrokerState, controlId: string): BrokerState | undefined {
  return state.fullSync.stagedByControlId[controlId]?.state
}

export function requestBrokerReplay(
  state: BrokerState,
  input: RequestBrokerReplayInput,
): BrokerControlRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.controlId)
    || !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.instanceIncarnation)
  ) {
    throw new Error("invalid broker replay request")
  }
  assertNonNegativeInteger(input.brokerSeq, "brokerSeq")
  assertNonNegativeInteger(input.fromEventSeq, "fromEventSeq")
  assertNonNegativeInteger(input.toEventSeq, "toEventSeq")

  const next: BrokerControlRecord = {
    controlId: input.controlId,
    brokerSeq: input.brokerSeq,
    type: "requestReplay",
    status: "inFlight",
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    fromEventSeq: input.fromEventSeq,
    toEventSeq: input.toEventSeq,
  }

  state.controlLedger[input.controlId] = next
  markConnectionSentBrokerSeq(state, {
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    brokerSeq: input.brokerSeq,
  })
  return next
}

export function markBrokerReplayCompleted(
  state: BrokerState,
  input: MarkBrokerReplayCompletedInput,
): BrokerControlRecord {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.controlId)) {
    throw new Error("invalid replay completion")
  }
  assertNonNegativeInteger(input.completedEventSeq, "completedEventSeq")

  const current = requireControlRecord(state, input.controlId)
  assertControlType(current.type)
  if (current.type !== "requestReplay") {
    throw new Error("broker control is not a replay request")
  }

  const next: BrokerControlRecord = {
    ...current,
    status: "completed",
    completedEventSeq: Math.max(current.completedEventSeq ?? 0, input.completedEventSeq),
  }
  state.controlLedger[input.controlId] = next
  return next
}

export function requestBrokerFullSync(
  state: BrokerState,
  input: RequestBrokerFullSyncInput,
): BrokerControlRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.controlId)
    || !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.instanceIncarnation)
    || !isNonEmptyString(input.reason)
  ) {
    throw new Error("invalid broker full sync request")
  }
  assertNonNegativeInteger(input.brokerSeq, "brokerSeq")

  const next: BrokerControlRecord = {
    controlId: input.controlId,
    brokerSeq: input.brokerSeq,
    type: "requestFullSync",
    status: "inFlight",
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    reason: input.reason,
  }

  state.controlLedger[input.controlId] = next
  state.fullSync.stagedByControlId[input.controlId] = {
    controlId: input.controlId,
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    state: createEmptyBrokerState(),
  }
  markConnectionSentBrokerSeq(state, {
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    brokerSeq: input.brokerSeq,
  })
  return next
}

export function stageBrokerFullSyncEvent(
  state: BrokerState,
  input: StageBrokerFullSyncEventInput,
): BrokerState {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.controlId)) {
    throw new Error("invalid full sync stage controlId")
  }

  const current = requireControlRecord(state, input.controlId)
  assertControlType(current.type)
  if (current.type !== "requestFullSync") {
    throw new Error("broker control is not a full sync request")
  }
  if (input.event.type === "fullSyncCompleted") {
    throw new Error("fullSyncCompleted must commit instead of staging")
  }

  const stage = state.fullSync.stagedByControlId[input.controlId]
  if (!stage) {
    throw new Error("missing full sync stage")
  }

  applyBridgeEvent(stage.state, input.event, input.context)
  return stage.state
}

export function markBrokerFullSyncCompleted(
  state: BrokerState,
  input: MarkBrokerFullSyncCompletedInput,
): BrokerControlRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.controlId)
    || !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.instanceIncarnation)
  ) {
    throw new Error("invalid full sync completion")
  }
  assertNonNegativeInteger(input.eventSeq, "eventSeq")

  const current = requireControlRecord(state, input.controlId)
  assertControlType(current.type)
  if (current.type !== "requestFullSync") {
    throw new Error("broker control is not a full sync request")
  }

  const stage = state.fullSync.stagedByControlId[input.controlId]
  if (!stage) {
    throw new Error("missing full sync stage")
  }

  applyFullSyncSnapshot(
    state,
    {
      instanceID: input.instanceID,
      instanceIncarnation: input.instanceIncarnation,
    },
    {
      connections: stage.state.connections,
      active: cloneActiveState(stage.state.active),
    },
  )

  delete state.fullSync.stagedByControlId[input.controlId]
  state.fullSync = {
    ...state.fullSync,
    lastCompletedControlId: input.controlId,
    lastCompletedEventSeq: input.eventSeq,
    lastCompletedInstanceIncarnation: input.instanceIncarnation,
  }

  const next: BrokerControlRecord = {
    ...current,
    status: "completed",
    completedEventSeq: Math.max(current.completedEventSeq ?? 0, input.eventSeq),
  }
  state.controlLedger[input.controlId] = next
  return next
}

export function markBrokerCommandAccepted(
  state: BrokerState,
  input: MarkBrokerCommandAcceptedInput,
): BrokerCommandRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.commandId)
    || !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.instanceIncarnation)
  ) {
    throw new Error("invalid command acceptance")
  }
  assertNonNegativeInteger(input.eventSeq, "eventSeq")
  if (input.acceptedAt !== undefined) {
    assertNonNegativeInteger(input.acceptedAt, "acceptedAt")
  }

  const current = requireCommand(state, input.commandId)
  if (current.status === "completed" || current.status === "failed") {
    return current
  }

  const next: BrokerCommandRecord = {
    ...current,
    status: "accepted",
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    acceptedEventSeq: input.eventSeq,
    ...(input.acceptedAt !== undefined
      ? { acceptedAt: input.acceptedAt }
      : current.acceptedAt !== undefined
        ? { acceptedAt: current.acceptedAt }
        : {}),
  }
  state.commandLedger[input.commandId] = next
  return next
}

export function markBrokerCommandResult(
  state: BrokerState,
  input: MarkBrokerCommandResultInput,
): BrokerCommandRecord {
  rememberBrokerState(state)
  if (
    !isNonEmptyString(input.commandId)
    || !isNonEmptyString(input.instanceID)
    || !isNonEmptyString(input.instanceIncarnation)
  ) {
    throw new Error("invalid command result")
  }
  assertNonNegativeInteger(input.eventSeq, "eventSeq")
  if (input.completedAt !== undefined) {
    assertNonNegativeInteger(input.completedAt, "completedAt")
  }
  if (input.status !== "completed" && input.status !== "failed") {
    throw new Error("invalid broker command result status")
  }

  const current = requireCommand(state, input.commandId)
  if (current.status !== "accepted" && current.status !== "completed" && current.status !== "failed") {
    throw new Error("command result requires accepted command")
  }

  const next: BrokerCommandRecord = {
    ...current,
    status: input.status,
    instanceID: input.instanceID,
    instanceIncarnation: input.instanceIncarnation,
    resultEventSeq: input.eventSeq,
    ...(input.completedAt !== undefined
      ? { completedAt: input.completedAt }
      : current.completedAt !== undefined
        ? { completedAt: current.completedAt }
        : {}),
    ...(input.status === "failed" && input.failure ? { failure: { ...input.failure } } : {}),
  }
  state.commandLedger[input.commandId] = next
  return next
}

export function markConnectionAckedEventSeq(
  state: BrokerState,
  input: MarkConnectionAckedEventSeqInput,
): BrokerConnectionState {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.instanceID) || !isNonEmptyString(input.instanceIncarnation)) {
    throw new Error("invalid broker ack input")
  }
  assertNonNegativeInteger(input.ackedEventSeq, "ackedEventSeq")

  const connection = ensureConnection(state, input.instanceID, input.instanceIncarnation)
  connection.lastAckedEventSeq = Math.max(connection.lastAckedEventSeq, input.ackedEventSeq)
  return connection
}

export function markConnectionSentBrokerSeq(
  state: BrokerState,
  input: MarkConnectionSentBrokerSeqInput,
): BrokerConnectionState {
  rememberBrokerState(state)
  if (!isNonEmptyString(input.instanceID) || !isNonEmptyString(input.instanceIncarnation)) {
    throw new Error("invalid broker sent seq input")
  }
  assertNonNegativeInteger(input.brokerSeq, "brokerSeq")

  const connection = ensureConnection(state, input.instanceID, input.instanceIncarnation)
  connection.lastSentBrokerSeq = Math.max(connection.lastSentBrokerSeq, input.brokerSeq)
  return connection
}
