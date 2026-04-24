import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { WECHAT_FILE_MODE, ensureWechatStateLayout, tokenStatePath } from "./state-paths.js"
import {
  loadBrokerStateStoreForMutation,
  persistBrokerStateStoreSnapshot,
  readBrokerDeliveryToken,
  upsertBrokerDeliveryToken,
} from "./broker-state-store.js"

export type TokenSource = "question" | "permission" | "message"

export const NOTIFICATION_DELIVERY_FAILED_STALE_REASON = "notification-delivery-failed"
const SYNTHETIC_STALE_TOKEN_SOURCE_REF_PREFIX = "synthetic-stale"
const TOKEN_REPLACE_MAX_ATTEMPTS = 5
const TOKEN_REPLACE_RETRY_DELAY_MS = 10

export type TokenState = {
  contextToken: string
  updatedAt: number
  source: TokenSource
  sourceRef?: string
  staleReason?: string
}

type TokenKey = {
  wechatAccountId: string
  userId: string
}

function isSafeTokenKeyPart(value: unknown): value is string {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes("..")
}

function toTokenKey(input: TokenKey): TokenKey {
  if (!isSafeTokenKeyPart(input.wechatAccountId) || !isSafeTokenKeyPart(input.userId)) {
    throw new Error("invalid token state format")
  }
  return {
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeTokenState(input: TokenState): TokenState {
  return {
    contextToken: input.contextToken,
    updatedAt: input.updatedAt,
    source: input.source,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.staleReason ? { staleReason: input.staleReason } : {}),
  }
}

function isTokenSource(value: unknown): value is TokenSource {
  return value === "question" || value === "permission" || value === "message"
}

function isRetryableTokenReplaceError(error: unknown): boolean {
  const issue = error as NodeJS.ErrnoException
  return issue?.code === "EPERM" || issue?.code === "EBUSY"
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function replaceTokenStateFile(tempPath: string, filePath: string) {
  let lastError: unknown = undefined

  for (let attempt = 0; attempt < TOKEN_REPLACE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(tempPath, filePath)
      return
    } catch (error) {
      lastError = error
      if (attempt === TOKEN_REPLACE_MAX_ATTEMPTS - 1 || !isRetryableTokenReplaceError(error)) {
        throw error
      }

      await delay(TOKEN_REPLACE_RETRY_DELAY_MS)
    }
  }

  if (lastError) throw lastError
}

function createSyntheticStaleTokenState(input: TokenKey & { staleReason: string }): TokenState {
  return {
    contextToken: `stale-placeholder:${input.wechatAccountId}:${input.userId}`,
    updatedAt: Date.now(),
    source: "question",
    sourceRef: `${SYNTHETIC_STALE_TOKEN_SOURCE_REF_PREFIX}:${input.staleReason}`,
    staleReason: input.staleReason,
  }
}

function toTokenState(input: unknown): TokenState {
  const parsed = input as Partial<TokenState>
  if (
    !parsed ||
    !isNonEmptyString(parsed.contextToken) ||
    !isFiniteNumber(parsed.updatedAt) ||
    !isTokenSource(parsed.source)
  ) {
    throw new Error("invalid token state format")
  }

  if (
    (parsed.sourceRef !== undefined && !isNonEmptyString(parsed.sourceRef)) ||
    (parsed.staleReason !== undefined && !isNonEmptyString(parsed.staleReason))
  ) {
    throw new Error("invalid token state format")
  }

  return normalizeTokenState(parsed as TokenState)
}

async function writeTokenState(key: TokenKey, state: TokenState) {
  const safeKey = toTokenKey(key)
  await ensureWechatStateLayout()
  const filePath = tokenStatePath(safeKey.wechatAccountId, safeKey.userId)
  const dirPath = path.dirname(filePath)
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const serializedState = JSON.stringify(normalizeTokenState(state), null, 2)

  await mkdir(dirPath, { recursive: true })

  try {
    await writeFile(tempPath, serializedState, { mode: WECHAT_FILE_MODE })
    await replaceTokenStateFile(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }

  const normalized = normalizeTokenState(state)
  const brokerState = await loadBrokerStateStoreForMutation()
  upsertBrokerDeliveryToken(brokerState, {
    ...safeKey,
    ...normalized,
  })
  await persistBrokerStateStoreSnapshot(brokerState)

  return normalized
}

async function readPersistedTokenStateFile(wechatAccountId: string, userId: string): Promise<TokenState | undefined> {
  try {
    const safeKey = toTokenKey({ wechatAccountId, userId })
    const raw = await readFile(tokenStatePath(safeKey.wechatAccountId, safeKey.userId), "utf8")
    return toTokenState(JSON.parse(raw))
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return undefined
    if (error instanceof Error && error.message === "invalid token state format") throw error
    throw new Error("invalid token state format")
  }
}

export async function readTokenState(wechatAccountId: string, userId: string): Promise<TokenState | undefined> {
  const brokerToken = await readBrokerDeliveryToken({ wechatAccountId, userId })
  if (brokerToken) {
    return normalizeTokenState({
      contextToken: brokerToken.contextToken,
      updatedAt: brokerToken.updatedAt,
      source: brokerToken.source,
      sourceRef: brokerToken.sourceRef,
      staleReason: brokerToken.staleReason,
    })
  }

  const persisted = await readPersistedTokenStateFile(wechatAccountId, userId)
  if (persisted) {
    return undefined
  }
  return undefined
}

export function isLiveTokenState(state: TokenState | undefined): state is TokenState {
  return Boolean(state && !state.staleReason)
}

export async function upsertInboundToken(input: TokenKey & TokenState): Promise<TokenState> {
  const safeKey = toTokenKey(input)
  const next = toTokenState({
    contextToken: input.contextToken,
    updatedAt: input.updatedAt,
    source: input.source,
    sourceRef: input.sourceRef,
    staleReason: input.staleReason,
  })

  return writeTokenState(safeKey, next)
}

export async function markTokenStale(input: TokenKey & { staleReason: string }): Promise<TokenState> {
  const safeKey = toTokenKey(input)
  if (!isNonEmptyString(input.staleReason)) {
    throw new Error("invalid token state format")
  }

  let current: TokenState | undefined
  try {
    current = await readTokenState(safeKey.wechatAccountId, safeKey.userId)
    if (!current) {
      current = await readPersistedTokenStateFile(safeKey.wechatAccountId, safeKey.userId)
    }
  } catch (error) {
    if (error instanceof Error && error.message === "invalid token state format") {
      current = undefined
    } else {
      throw error
    }
  }

  return writeTokenState(safeKey, {
    ...(current ?? createSyntheticStaleTokenState({
      ...safeKey,
      staleReason: input.staleReason,
    })),
    staleReason: input.staleReason,
  })
}
