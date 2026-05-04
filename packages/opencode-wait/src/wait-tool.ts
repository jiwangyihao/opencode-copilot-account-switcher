import { tool } from "@opencode-ai/plugin"

export type WaitToolInput = {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  client?: {
    session?: {
      messages?: (input: {
        path: { id: string }
        query?: {
          directory?: string
          limit?: number
        }
      }) => Promise<{ data?: SessionMessage[] } | SessionMessage[] | undefined>
    }
  }
}

type SessionMessage = {
  info?: {
    id?: unknown
    role?: unknown
    time?: {
      created?: unknown
    }
  }
  parts?: unknown[]
}

type UserMessageObservation = {
  id: string
  created?: number
  synthetic: boolean
}

type WaitUntilEvent = "new_user_message"

const MIN_WAIT_SECONDS = 30
const DEFAULT_USER_MESSAGE_POLL_INTERVAL_MS = 1_000
const USER_MESSAGE_LOOKBACK_LIMIT = 20

function toIso(ms: number) {
  return new Date(ms).toISOString()
}

function normalizeSeconds(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return MIN_WAIT_SECONDS
  return Math.max(MIN_WAIT_SECONDS, Math.floor(parsed))
}

function normalizePollIntervalMs(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USER_MESSAGE_POLL_INTERVAL_MS
  return Math.max(1, Math.floor(parsed))
}

function normalizeUntil(value: unknown): WaitUntilEvent | undefined {
  return value === "new_user_message" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toUserMessageObservation(message: SessionMessage): UserMessageObservation | undefined {
  const info = message.info
  if (info?.role !== "user") return undefined
  if (typeof info.id !== "string" || info.id.length === 0) return undefined

  const created = typeof info.time?.created === "number" && Number.isFinite(info.time.created)
    ? info.time.created
    : undefined
  const synthetic = (message.parts ?? []).some((part) => isRecord(part) && part.synthetic === true)
  return { id: info.id, created, synthetic }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const createAbortError = () => {
    const error = new Error("Aborted")
    error.name = "AbortError"
    return error
  }

  if (signal?.aborted) return Promise.reject(createAbortError())

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>
    function cleanup() {
      signal?.removeEventListener("abort", onAbort)
    }
    function onAbort() {
      clearTimeout(timeout)
      cleanup()
      reject(createAbortError())
    }

    timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function readRecentUserMessages(input: {
  client: WaitToolInput["client"]
  sessionID: string
  directory: string
}): Promise<UserMessageObservation[] | undefined> {
  const response = await input.client?.session?.messages?.({
    path: { id: input.sessionID },
    query: {
      directory: input.directory,
      limit: USER_MESSAGE_LOOKBACK_LIMIT,
    },
  })
  const messages = Array.isArray(response)
    ? response
    : Array.isArray(response?.data)
      ? response.data
      : undefined

  return messages
    ?.map((message) => toUserMessageObservation(message))
    .filter((message): message is UserMessageObservation => message !== undefined)
}

async function waitForNewUserMessage(input: {
  client: WaitToolInput["client"]
  sessionID: string
  directory: string
  currentMessageID: string
  startedAt: number
  pollIntervalMs: number
  signal: AbortSignal
}) {
  if (!input.client?.session?.messages) return undefined

  const initialMessages = await readRecentUserMessages(input).catch(() => undefined)
  if (!initialMessages) return undefined
  const messageAlreadyArrived = initialMessages.find((message) =>
    message.id !== input.currentMessageID && message.created !== undefined && message.created > input.startedAt
  )
  if (messageAlreadyArrived) return messageAlreadyArrived

  const knownMessageIDs = new Set(initialMessages.map((message) => message.id))
  knownMessageIDs.add(input.currentMessageID)

  while (!input.signal.aborted) {
    await abortableSleep(input.pollIntervalMs, input.signal).catch(() => undefined)
    if (input.signal.aborted) return undefined

    const nextMessages = await readRecentUserMessages(input).catch(() => undefined)
    const newMessage = nextMessages?.find((message) => !knownMessageIDs.has(message.id))
    if (newMessage) return newMessage

    for (const message of nextMessages ?? []) {
      knownMessageIDs.add(message.id)
    }
  }

  return undefined
}

function formatUserMessageResult(input: {
  started: number
  finished: number
  seconds?: number
  eventMode: boolean
  message: UserMessageObservation
}) {
  const waited = Math.max(0, Math.floor((input.finished - input.started) / 1000))
  const reason = input.message.synthetic ? "new user message (synthetic)" : "new user message"
  const parts = [
    `started: ${toIso(input.started)}`,
    input.seconds === undefined ? undefined : `requested: ${input.seconds}s`,
    `waited: ${waited}s`,
    `now: ${toIso(input.finished)}`,
    `ended: ${input.eventMode ? "event" : "early"}`,
  ]
  if (input.eventMode) parts.push("event: new_user_message")
  parts.push(`reason: ${reason}`, `message: ${input.message.id}`)
  return parts.filter((part): part is string => part !== undefined).join("; ")
}

function formatUnavailableEventResult(input: {
  started: number
  finished: number
  event: WaitUntilEvent
}) {
  const waited = Math.max(0, Math.floor((input.finished - input.started) / 1000))
  return `started: ${toIso(input.started)}; waited: ${waited}s; now: ${toIso(input.finished)}; ended: unavailable; event: ${input.event}; reason: session messages unavailable`
}

export function createWaitTool(input: WaitToolInput = {}) {
  const now = input.now ?? (() => Date.now())
  const sleep = input.sleep ?? abortableSleep
  const pollIntervalMs = normalizePollIntervalMs(input.pollIntervalMs)

  return tool({
    description: "Wait in background for unattended tasks that do not require user confirmation, including long-running work, cooldowns, or expected non-user events. Use until: \"new_user_message\" to wait until the current session receives a new user message, including plugin-synthesized notifications.",
    args: {
      seconds: tool.schema.number().optional().describe("How long to wait in seconds (minimum 30)."),
      until: tool.schema.string().optional().describe("Event to wait for. Currently supported: new_user_message."),
    },
    async execute(args, context) {
      const until = normalizeUntil(args.until)
      const eventOnly = until === "new_user_message" && args.seconds === undefined
      const seconds = eventOnly ? undefined : normalizeSeconds(args.seconds)
      const started = now()
      if (eventOnly && !input.client?.session?.messages) {
        return formatUnavailableEventResult({
          started,
          finished: now(),
          event: until,
        })
      }

      const controller = new AbortController()
      const outcomes: Promise<
        | { type: "timeout" }
        | { type: "user-message"; message: UserMessageObservation }
      >[] = []
      if (seconds !== undefined) {
        outcomes.push(sleep(seconds * 1000, controller.signal).then(
          () => ({ type: "timeout" as const }),
          (error) => {
            if (controller.signal.aborted) return new Promise<never>(() => {})
            throw error
          },
        ))
      }
      outcomes.push(waitForNewUserMessage({
        client: input.client,
        sessionID: context.sessionID,
        directory: context.directory,
        currentMessageID: context.messageID,
        startedAt: started,
        pollIntervalMs,
        signal: controller.signal,
      }).then((message) => {
        if (!message) return new Promise<never>(() => {})
        return { type: "user-message" as const, message }
      }))

      const outcome = await Promise.race(outcomes)
      controller.abort()
      const finished = now()

      if (outcome.type === "user-message") {
        return formatUserMessageResult({
          started,
          finished,
          seconds,
          eventMode: eventOnly,
          message: outcome.message,
        })
      }

      return `started: ${toIso(started)}; waited: ${seconds}s; now: ${toIso(finished)}`
    },
  })
}
