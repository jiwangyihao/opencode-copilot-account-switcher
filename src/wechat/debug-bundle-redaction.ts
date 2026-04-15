export type WechatDebugBundleMode = "sanitized" | "full"

export type RedactDebugBundleContentOptions = {
  bundlePath: string
  mode: WechatDebugBundleMode
}

export const REDACTED_CONTEXT_TOKEN = "[REDACTED_CONTEXT_TOKEN]"
export const REDACTED_ACCOUNT_ID = "[REDACTED_ACCOUNT_ID]"
export const REDACTED_USER_ID = "[REDACTED_USER_ID]"
export const REDACTED_TOKEN = "[REDACTED_TOKEN]"
export const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]"
export const REDACTED_MESSAGE_TEXT = "[REDACTED_MESSAGE_TEXT]"
export const REDACTED_CORRUPT_STRUCTURED_CONTENT = "[REDACTED_CORRUPT_STRUCTURED_CONTENT]"

const SAFE_DIAGNOSTIC_SUFFIX_KEYS = ["requestId", "upstream", "status"]

export function redactDebugBundleContent(
  content: Buffer,
  options: RedactDebugBundleContentOptions,
): Buffer {
  if (options.mode === "full") {
    return Buffer.from(content)
  }

  const text = content.toString("utf8")
  return Buffer.from(redactDebugBundleText(text, options.bundlePath), "utf8")
}

export function redactDebugBundleText(text: string, bundlePath: string): string {
  if (bundlePath.endsWith(".json")) {
    return redactJsonText(text)
  }
  if (bundlePath.endsWith(".jsonl")) {
    return redactJsonLines(text, { failClosed: true })
  }
  if (bundlePath.endsWith(".log")) {
    return redactJsonLines(text, { failClosed: false })
  }
  return redactPlainText(text)
}

function redactJsonText(text: string): string {
  const parsed = tryParseJson(text)
  if (parsed === undefined) {
    return serializeCorruptStructuredContent({ multiline: true, trailingNewline: text.endsWith("\n") })
  }

  const suffix = text.endsWith("\n") ? "\n" : ""
  return `${JSON.stringify(redactStructuredValue(parsed), null, 2)}${suffix}`
}

function redactJsonLines(text: string, options: { failClosed: boolean }): string {
  const lines = text.split(/\r?\n/)
  const redactedLines = lines.map((line) => {
    if (line.trim().length === 0) {
      return line
    }

    const parsed = tryParseJson(line)
    if (parsed === undefined) {
      if (options.failClosed || looksLikeStructuredLine(line)) {
        return serializeCorruptStructuredContent({ multiline: false, trailingNewline: false })
      }
      return redactPlainText(line)
    }

    return JSON.stringify(redactStructuredValue(parsed))
  })

  return redactedLines.join("\n")
}

function redactPlainText(text: string): string {
  let redacted = redactQuotedEscapedJsonFragments(text)
  redacted = redactUnquotedEscapedJsonFragments(redacted)
  redacted = redactEmbeddedJsonFragments(redacted)
  redacted = redacted.replace(/Bearer\s+[^\s\r\n&?,;|]+/gi, `Bearer ${REDACTED_TOKEN}`)

  redacted = replaceField(
    redacted,
    ["authorization"],
    REDACTED_TOKEN,
    {
      allowColonFollowers: true,
      followerKeys: SAFE_DIAGNOSTIC_SUFFIX_KEYS,
      preserveWholeSuffixOnly: true,
      allowAmpersandFollowers: true,
      forbidQuestionMarkBeforeSuffix: true,
    },
  )
  redacted = replaceField(redacted, ["contextToken"], REDACTED_CONTEXT_TOKEN)
  redacted = replaceField(redacted, ["wechatAccountId", "accountId"], REDACTED_ACCOUNT_ID)
  redacted = replaceField(redacted, ["userId", "fromUserId", "toUserId"], REDACTED_USER_ID)
  redacted = replaceField(redacted, ["cookie", "credential", "credentials"], REDACTED_CREDENTIAL)
  redacted = replaceField(redacted, ["accessToken", "refreshToken", "bearerToken", "token", "secret", "password"], REDACTED_TOKEN)
  redacted = replaceField(
    redacted,
    ["messageBody", "messageText", "message", "rawText", "rawMessage", "body", "text", "content"],
    REDACTED_MESSAGE_TEXT,
    {
      allowColonFollowers: true,
      followerKeys: SAFE_DIAGNOSTIC_SUFFIX_KEYS,
      preserveWholeSuffixOnly: true,
      requireMinimumFollowerCount: 2,
    },
  )

  return redacted
}

function redactQuotedEscapedJsonFragments(text: string): string {
  return text.replace(/"((?:\{(?:\\.|[^"\r\n])*\})|(?:\[(?:\\.|[^"\r\n])*\]))"/g, (match, fragment) => {
    const parsed = tryParseEscapedJsonFragment(fragment)
    if (parsed === undefined) {
      return match
    }
    return `"${stringifyEscapedJsonFragment(redactStructuredValue(parsed))}"`
  })
}

function redactUnquotedEscapedJsonFragments(text: string): string {
  return text.replace(/(?:\{(?:\\.|[^{}\r\n])*\})|(?:\[(?:\\.|[^\[\]\r\n])*\])/g, (fragment) => {
    if (!fragment.includes('\\"')) {
      return fragment
    }
    const parsed = tryParseEscapedJsonFragment(fragment)
    if (parsed === undefined) {
      return fragment
    }
    return stringifyEscapedJsonFragment(redactStructuredValue(parsed))
  })
}

function replaceField(
  text: string,
  keys: string[],
  replacement: string,
  options: {
    allowColonFollowers?: boolean
    followerKeys?: string[]
    preserveWholeSuffixOnly?: boolean
    requireMinimumFollowerCount?: number
    allowAmpersandFollowers?: boolean
    forbidQuestionMarkBeforeSuffix?: boolean
    terminal?: boolean
  } = {},
): string {
  const escapedKeys = keys.map((key) => escapeRegExp(key)).join("|")
  const followerValueSeparator = options.allowColonFollowers ? "(?:=|:)" : "="
  const followerKeyPattern = (options.followerKeys ?? [])
    .map((key) => escapeRegExp(key))
    .join("|")
  const structuredFollowerBoundary =
    followerKeyPattern.length > 0
      ? `(?:\\s+(?:${followerKeyPattern})\\s*${followerValueSeparator}|[&?](?:${followerKeyPattern})\\s*=|[,;|]+\\s*(?:${followerKeyPattern})\\s*${followerValueSeparator})`
      : null
  const matcher = new RegExp(
    options.terminal
      ? `(\\b(?:${escapedKeys})\\b\\s*[:=]\\s*)([^\\r\\n]*)`
      : options.preserveWholeSuffixOnly
        ? `(\\b(?:${escapedKeys})\\b\\s*[:=]\\s*)([^\\r\\n]*)`
      : structuredFollowerBoundary
        ? `(\\b(?:${escapedKeys})\\b\\s*[:=]\\s*)([^\\r\\n]*?)(?=(?:${structuredFollowerBoundary})|$)`
        : `(\\b(?:${escapedKeys})\\b\\s*[:=]\\s*)([^\\r\\n]*)`,
    "gi",
  )
  return text.replace(matcher, (_, prefix: string, value: string) => {
    if (options.preserveWholeSuffixOnly) {
      const suffix = extractSafeSuffixChain(value, {
        allowColonFollowers: options.allowColonFollowers === true,
        followerKeys: options.followerKeys ?? [],
        allowAmpersandFollowers: options.allowAmpersandFollowers === true,
        forbidQuestionMarkBeforeSuffix: options.forbidQuestionMarkBeforeSuffix === true,
        minimumCount: options.requireMinimumFollowerCount ?? 1,
      })
      return `${prefix}${replacement}${suffix}`
    }
    return `${prefix}${replacement}`
  })
}

function extractSafeSuffixChain(
  value: string,
  options: {
    allowColonFollowers: boolean
    followerKeys: string[]
    allowAmpersandFollowers: boolean
    forbidQuestionMarkBeforeSuffix: boolean
    minimumCount: number
  },
): string {
  if (options.followerKeys.length === 0) {
    return ""
  }

  const followerKeyPattern = options.followerKeys.map((key) => escapeRegExp(key)).join("|")
  const valueSeparator = options.allowColonFollowers ? "(?:=|:)" : "="
  const segmentSeparator = options.allowAmpersandFollowers ? `[\\s,;|&]+` : `[\\s,;|]+`
  const segment = `${segmentSeparator}(?:${followerKeyPattern})\\s*${valueSeparator}\\s*[^\\s,;|&?]+`
  const suffixMatcher = new RegExp(`((?:${segment})+)$`, "i")
  const suffixMatch = value.match(suffixMatcher)
  if (!suffixMatch) {
    return ""
  }

  const prefixValue = value.slice(0, value.length - suffixMatch[1].length)
  if (options.forbidQuestionMarkBeforeSuffix && prefixValue.includes("?")) {
    return ""
  }

  const segmentMatcher = new RegExp(segment, "gi")
  const segmentCount = Array.from(suffixMatch[1].matchAll(segmentMatcher)).length
  return segmentCount >= options.minimumCount ? suffixMatch[1] : ""
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function serializeCorruptStructuredContent(options: { multiline: boolean; trailingNewline: boolean }): string {
  const placeholder = { _corruptStructuredContent: REDACTED_CORRUPT_STRUCTURED_CONTENT }
  const serialized = options.multiline ? JSON.stringify(placeholder, null, 2) : JSON.stringify(placeholder)
  return options.trailingNewline ? `${serialized}\n` : serialized
}

function looksLikeStructuredLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function redactStructuredValue(value: unknown, key: string = ""): unknown {
  if (typeof value === "string") {
    const replacement = replacementForKey(key)
    if (replacement !== null) {
      return redactPlainText(replacement)
    }

    const nestedJson = tryParseJson(value)
    if (nestedJson !== undefined) {
      return JSON.stringify(redactStructuredValue(nestedJson))
    }

    return redactPlainText(redactEmbeddedJsonFragments(value))
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, key))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const next: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    next[childKey] = redactStructuredValue(childValue, childKey)
  }
  return next
}

function replacementForKey(key: string): string | null {
  const normalizedKey = normalizeKey(key)
  if (normalizedKey.length === 0) {
    return null
  }
  if (normalizedKey === "contexttoken") {
    return REDACTED_CONTEXT_TOKEN
  }
  if (normalizedKey === "wechataccountid" || normalizedKey === "accountid") {
    return REDACTED_ACCOUNT_ID
  }
  if (normalizedKey.endsWith("userid")) {
    return REDACTED_USER_ID
  }
  if (normalizedKey.includes("cookie") || normalizedKey.includes("credential")) {
    return REDACTED_CREDENTIAL
  }
  if (
    normalizedKey.includes("token") ||
    normalizedKey.includes("bearer") ||
    normalizedKey.includes("authorization") ||
    normalizedKey.includes("secret") ||
    normalizedKey.includes("password")
  ) {
    return REDACTED_TOKEN
  }
  if (
    normalizedKey === "body" ||
    normalizedKey === "text" ||
    normalizedKey === "content" ||
    normalizedKey.includes("message") ||
    normalizedKey.includes("rawtext") ||
    normalizedKey.includes("rawmessage")
  ) {
    return REDACTED_MESSAGE_TEXT
  }
  return null
}

function redactEmbeddedJsonFragments(text: string): string {
  let output = ""
  let cursor = 0

  while (cursor < text.length) {
    const fragment = findNextEmbeddedJsonFragment(text, cursor)
    if (!fragment) {
      output += text.slice(cursor)
      break
    }

    output += text.slice(cursor, fragment.start)
    output += fragment.stringify(redactStructuredValue(fragment.parsed))
    cursor = fragment.end
  }

  return output
}

function findNextEmbeddedJsonFragment(text: string, startIndex: number) {
  for (let index = startIndex; index < text.length; index++) {
    const character = text[index]
    if (character !== "{" && character !== "[") {
      continue
    }

    const end = findBalancedJsonEnd(text, index)
    if (end === -1) {
      const candidate = text.slice(index)
      if (looksLikeBrokenStructuredFragment(candidate)) {
        return {
          start: index,
          end: text.length,
          parsed: REDACTED_CORRUPT_STRUCTURED_CONTENT,
          stringify: stringifyCorruptStructuredFragment,
        }
      }
      continue
    }

    const candidate = text.slice(index, end)
    const parsed = tryParseJson(candidate)
    if (parsed === undefined) {
      const escapedParsed = tryParseEscapedJsonFragment(candidate)
      if (escapedParsed === undefined) {
        continue
      }

      return { start: index, end, parsed: escapedParsed, stringify: stringifyEscapedJsonFragment }
    }

    return { start: index, end, parsed, stringify: stringifyJsonFragment }
  }

  return null
}

function findBalancedJsonEnd(text: string, startIndex: number): number {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = startIndex; index < text.length; index++) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }

    if (inString) {
      if (character === "\\") {
        escaped = true
        continue
      }
      if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }

    if (character === "{") {
      stack.push("}")
      continue
    }
    if (character === "[") {
      stack.push("]")
      continue
    }
    if (character === "}" || character === "]") {
      const expected = stack.pop()
      if (expected !== character) {
        return -1
      }
      if (stack.length === 0) {
        return index + 1
      }
    }
  }

  return -1
}

function tryParseEscapedJsonFragment(text: string): unknown | undefined {
  if (!text.includes('\\"')) {
    return undefined
  }

  return tryParseJson(text.replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
}

function stringifyJsonFragment(value: unknown): string {
  return JSON.stringify(value)
}

function stringifyEscapedJsonFragment(value: unknown): string {
  return JSON.stringify(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function stringifyCorruptStructuredFragment(): string {
  return REDACTED_CORRUPT_STRUCTURED_CONTENT
}

function looksLikeBrokenStructuredFragment(text: string): boolean {
  return /"(?:contextToken|wechatAccountId|accountId|userId|fromUserId|toUserId|accessToken|refreshToken|bearerToken|token|cookie|credential|credentials|messageBody|messageText|message|rawText|rawMessage|body|text|content|authorization|secret|password)"\s*:/.test(
    text,
  )
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
