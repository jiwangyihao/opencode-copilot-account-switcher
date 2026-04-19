import crypto from "node:crypto"
import type { WechatRequestKind } from "./state-paths.js"

const HANDLE_PREFIX: Record<WechatRequestKind, string> = {
  question: "q",
  permission: "p",
}

const SESSION_REPLY_HANDLE_PREFIX = "s"

function normalizeRequestID(requestID: string) {
  return requestID.trim().toLowerCase()
}

export function createRouteKey(input: { kind: WechatRequestKind; requestID: string; scopeKey?: string }) {
  const normalized = normalizeRequestID(input.requestID)
  const normalizedScope = typeof input.scopeKey === "string" ? input.scopeKey.trim().toLowerCase() : ""
  const digest = crypto
    .createHash("sha1")
    .update(`${input.kind}:${normalized}:${normalizedScope}`)
    .digest("hex")
    .slice(0, 12)
  return `${input.kind}-${digest}`
}

export function normalizeHandle(input: string) {
  const value = input.trim().toLowerCase()
  if (!/^[a-z][a-z0-9]*$/.test(value)) {
    throw new Error("invalid handle format")
  }
  return value
}

function isRawRequestIDLike(input: string) {
  return /^req(?:uest)?[-_]/i.test(input.trim())
}

export function assertValidHandleInput(input: string) {
  if (isRawRequestIDLike(input)) {
    throw new Error("raw requestID cannot be used as handle")
  }
  normalizeHandle(input)
}

export function createHandle(kind: WechatRequestKind, existingHandles: Iterable<string>) {
  return createPrefixedHandle(HANDLE_PREFIX[kind], existingHandles)
}

export function createSessionReplyHandle(existingHandles: Iterable<string>) {
  return createPrefixedHandle(SESSION_REPLY_HANDLE_PREFIX, existingHandles)
}

function createPrefixedHandle(prefix: string, existingHandles: Iterable<string>) {
  const seen = new Set<string>()

  for (const item of existingHandles) {
    try {
      seen.add(normalizeHandle(item))
    } catch {
      // ignore invalid historical values
    }
  }

  let index = 1
  while (seen.has(`${prefix}${index}`)) {
    index += 1
  }
  return `${prefix}${index}`
}
