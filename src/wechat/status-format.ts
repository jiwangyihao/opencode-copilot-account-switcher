import type { WechatInstanceStatusSnapshot } from "./bridge.js"
import type { BrokerAuthoritativeView } from "./broker-state-store.js"
import type { SessionDigest, SessionDigestHighlight, SessionDigestTodoItem } from "./session-digest.js"

export type AggregatedStatusInstance =
  | {
      instanceID: string
      status: "ok"
      snapshot: unknown
    }
  | {
      instanceID: string
      status: "timeout/unreachable"
    }

export type AggregatedStatusReplyInput = {
  requestId: string
  instances: AggregatedStatusInstance[]
}

const HIGHLIGHT_ORDER: Record<SessionDigestHighlight["kind"], number> = {
  permission: 0,
  question: 1,
  "running-tool": 2,
  "completed-tool": 3,
  todo: 4,
  status: 5,
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {}
  }
  return value as Record<string, unknown>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  return fallback
}

function dedupeAndSortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function isHighlightKind(value: unknown): value is SessionDigestHighlight["kind"] {
  return (
    value === "permission" ||
    value === "question" ||
    value === "running-tool" ||
    value === "completed-tool" ||
    value === "todo" ||
    value === "status"
  )
}

function normalizeHighlight(value: unknown): SessionDigestHighlight | null {
  const record = asObject(value)
  if (!isHighlightKind(record.kind)) {
    return null
  }
  if (!isNonEmptyString(record.text)) {
    return null
  }
  return {
    kind: record.kind,
    text: record.text,
  }
}

function isTodoStatus(value: unknown): value is SessionDigestTodoItem["status"] {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
}

function normalizeTodoItem(value: unknown): SessionDigestTodoItem | null {
  const record = asObject(value)
  if (!isTodoStatus(record.status) || !isNonEmptyString(record.content)) {
    return null
  }
  return {
    status: record.status,
    content: record.content.trim(),
  }
}

function normalizeSessionDigest(value: unknown): SessionDigest | null {
  const record = asObject(value)
  if (!isNonEmptyString(record.sessionID)) {
    return null
  }

  const statusValue = record.status
  const normalizedStatus =
    statusValue === "busy" || statusValue === "idle" || statusValue === "retry" || statusValue === "unknown"
      ? statusValue
      : "unknown"

  const highlightsRaw = Array.isArray(record.highlights) ? record.highlights : []
  const highlights = highlightsRaw
    .map((item) => normalizeHighlight(item))
    .filter((item): item is SessionDigestHighlight => item !== null)

  const todoItems = Array.isArray(record.todoItems)
    ? record.todoItems
        .map((item) => normalizeTodoItem(item))
        .filter((item): item is SessionDigestTodoItem => item !== null)
    : undefined

  return {
    sessionID: record.sessionID,
    title: isNonEmptyString(record.title) ? record.title : "",
    directory: isNonEmptyString(record.directory) ? record.directory : "",
    updatedAt: toFiniteNumber(record.updatedAt),
    status: normalizedStatus,
    pendingQuestionCount: toFiniteNumber(record.pendingQuestionCount),
    pendingPermissionCount: toFiniteNumber(record.pendingPermissionCount),
    todoSummary: {
      total: toFiniteNumber(asObject(record.todoSummary).total),
      inProgress: toFiniteNumber(asObject(record.todoSummary).inProgress),
      completed: toFiniteNumber(asObject(record.todoSummary).completed),
    },
    unavailable: toSessionUnavailable(record.unavailable),
    highlights,
    ...(todoItems !== undefined ? { todoItems } : {}),
    ...(Array.isArray(record.questionHighlights)
      ? {
          questionHighlights: record.questionHighlights
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => item.trim()),
        }
      : {}),
  }
}

function toSessionDigestArray(value: unknown): SessionDigest[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((item) => normalizeSessionDigest(item)).filter((item): item is SessionDigest => item !== null)
}

function toSessionUnavailable(value: unknown): Array<"messages" | "todo"> {
  if (!Array.isArray(value)) {
    return []
  }
  return dedupeAndSortStrings(
    value.filter((item): item is string => item === "messages" || item === "todo"),
  ).filter((item): item is "messages" | "todo" => item === "messages" || item === "todo")
}

function toInstanceUnavailable(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return dedupeAndSortStrings(value.filter((item): item is string => typeof item === "string" && item.length > 0))
}

function normalizeSnapshot(snapshot: unknown): WechatInstanceStatusSnapshot {
  const record = asObject(snapshot)
  return {
    instanceID: isNonEmptyString(record.instanceID) ? record.instanceID : "unknown-instance",
    instanceName: isNonEmptyString(record.instanceName) ? record.instanceName : "",
    pid: typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : 0,
    projectName: isNonEmptyString(record.projectName) ? record.projectName : undefined,
    directory: isNonEmptyString(record.directory) ? record.directory : "",
    collectedAt: typeof record.collectedAt === "number" && Number.isFinite(record.collectedAt) ? record.collectedAt : 0,
    sessions: toSessionDigestArray(record.sessions),
    unavailable: toInstanceUnavailable(record.unavailable) as WechatInstanceStatusSnapshot["unavailable"],
  }
}

function sortHighlights(highlights: SessionDigestHighlight[]): SessionDigestHighlight[] {
  return [...highlights].sort((a, b) => {
    const orderA = HIGHLIGHT_ORDER[a.kind] ?? 999
    const orderB = HIGHLIGHT_ORDER[b.kind] ?? 999
    if (orderA !== orderB) {
      return orderA - orderB
    }
    return a.text.localeCompare(b.text)
  })
}

function pickTopSessions(sessions: SessionDigest[]): SessionDigest[] {
  return [...sessions]
    .sort((a, b) => {
      const ua = typeof a.updatedAt === "number" && Number.isFinite(a.updatedAt) ? a.updatedAt : 0
      const ub = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : 0
      if (ub !== ua) {
        return ub - ua
      }
      return a.sessionID.localeCompare(b.sessionID)
    })
    .slice(0, 3)
}

function formatSessionTags(session: SessionDigest): string {
  return [
    session.status === "busy" ? "#busy" : session.status === "idle" ? "#idle" : `#${session.status}`,
    `#todo:${session.todoSummary.total}`,
    `#question:${session.pendingQuestionCount}`,
    `#permission:${session.pendingPermissionCount}`,
  ].map((tag) => `\`${tag}\``).join(" ")
}

function formatTodoItem(todo: SessionDigestTodoItem): string {
  const prefix =
    todo.status === "completed"
      ? "[x]"
      : todo.status === "in_progress"
        ? "[-]"
        : todo.status === "cancelled"
          ? "[~]"
          : "[ ]"
  return `${prefix} ${todo.content}`
}

function listBrokerViewInstanceIDs(view: BrokerAuthoritativeView): string[] {
  const ids = new Set<string>()

  for (const instanceID of Object.keys(view.connections)) {
    if (instanceID.trim().length > 0) {
      ids.add(instanceID)
    }
  }

  for (const instanceID of Object.keys(view.active.instances)) {
    if (instanceID.trim().length > 0) {
      ids.add(instanceID)
    }
  }

  for (const record of Object.values(view.active.sessions)) {
    const candidate = isNonEmptyString(asObject(record).instanceID) ? String(asObject(record).instanceID).trim() : ""
    if (candidate.length > 0) {
      ids.add(candidate)
    }
  }

  for (const record of Object.values(view.active.retryErrors)) {
    const candidate = isNonEmptyString(asObject(record).instanceID) ? String(asObject(record).instanceID).trim() : ""
    if (candidate.length > 0) {
      ids.add(candidate)
    }
  }

  return [...ids].sort((left, right) => left.localeCompare(right))
}

function countActiveItemsBySession(
  records: Record<string, Record<string, unknown>>,
  instanceID: string,
  sessionID: string,
): number {
  return Object.values(records).filter((record) => (
    asObject(record).instanceID === instanceID && asObject(record).sessionID === sessionID
  )).length
}

function createRetryStatusHighlights(record: Record<string, unknown>): SessionDigestHighlight[] {
  const highlights: SessionDigestHighlight[] = []

  if (isNonEmptyString(record.action)) {
    highlights.push({ kind: "status", text: `动作：${record.action.trim()}` })
  }
  if (isNonEmptyString(record.redactedSummary)) {
    highlights.push({ kind: "status", text: `原因摘要：${record.redactedSummary.trim()}` })
  }
  if (isNonEmptyString(record.severityAdvice)) {
    highlights.push({ kind: "status", text: `处理建议：${record.severityAdvice.trim()}` })
  }

  return highlights
}

function buildBrokerViewSnapshot(view: BrokerAuthoritativeView, instanceID: string): WechatInstanceStatusSnapshot {
  const instanceRecord = asObject(view.active.instances[instanceID])
  const sessions: SessionDigest[] = Object.values(view.active.sessions)
    .map((record) => asObject(record))
    .filter((record) => record.instanceID === instanceID && isNonEmptyString(record.sessionID))
    .map((record) => ({
      sessionID: String(record.sessionID).trim(),
      title: isNonEmptyString(record.title) ? record.title : "",
      directory: isNonEmptyString(record.directory) ? record.directory : "",
      updatedAt: toFiniteNumber(record.updatedAt),
      status: (
        record.status === "busy" || record.status === "idle" || record.status === "retry" || record.status === "unknown"
          ? record.status
          : "unknown"
      ) as SessionDigest["status"],
      pendingQuestionCount:
        typeof record.pendingQuestionCount === "number"
          ? record.pendingQuestionCount
          : countActiveItemsBySession(view.active.questions, instanceID, String(record.sessionID).trim()),
      pendingPermissionCount:
        typeof record.pendingPermissionCount === "number"
          ? record.pendingPermissionCount
          : countActiveItemsBySession(view.active.permissions, instanceID, String(record.sessionID).trim()),
      todoSummary: {
        total: toFiniteNumber(asObject(record.todoSummary).total),
        inProgress: toFiniteNumber(asObject(record.todoSummary).inProgress),
        completed: toFiniteNumber(asObject(record.todoSummary).completed),
      },
      unavailable: toSessionUnavailable(record.unavailable),
      highlights: Array.isArray(record.highlights) ? record.highlights : [],
      ...(Array.isArray(record.todoItems) ? { todoItems: record.todoItems } : {}),
      ...(Array.isArray(record.questionHighlights) ? { questionHighlights: record.questionHighlights } : {}),
    }))

  const sessionByID = new Map(sessions.map((session) => [session.sessionID, session]))
  let syntheticRetryIndex = 0

  for (const retryRecord of Object.values(view.active.retryErrors)) {
    const record = asObject(retryRecord)
    if (record.instanceID !== instanceID) {
      continue
    }

    const retrySessionID = isNonEmptyString(record.sessionID)
      ? record.sessionID.trim()
      : `retry-${syntheticRetryIndex + 1}`
    let session = sessionByID.get(retrySessionID)
    if (!session) {
      syntheticRetryIndex += 1
      session = {
        sessionID: retrySessionID,
        title: isNonEmptyString(record.sessionID) ? record.sessionID.trim() : "通知投递异常",
        directory: "",
        updatedAt: toFiniteNumber(record.updatedAt),
        status: "retry",
        pendingQuestionCount: 0,
        pendingPermissionCount: 0,
        todoSummary: {
          total: 0,
          inProgress: 0,
          completed: 0,
        },
        unavailable: [],
        highlights: [],
      }
      sessions.push(session)
      sessionByID.set(retrySessionID, session)
    }

    session.status = "retry"
    session.updatedAt = Math.max(session.updatedAt, toFiniteNumber(record.updatedAt, session.updatedAt))
    session.highlights = [
      ...sortHighlights(Array.isArray(session.highlights) ? session.highlights : []),
      ...createRetryStatusHighlights(record),
    ]
  }

  return {
    instanceID,
    instanceName:
      (isNonEmptyString(instanceRecord.displayName) ? instanceRecord.displayName : undefined)
      ?? (isNonEmptyString(instanceRecord.instanceName) ? instanceRecord.instanceName : undefined)
      ?? "",
    pid: typeof instanceRecord.pid === "number" && Number.isFinite(instanceRecord.pid) ? instanceRecord.pid : 0,
    projectName: isNonEmptyString(instanceRecord.projectName) ? instanceRecord.projectName : undefined,
    directory:
      (isNonEmptyString(instanceRecord.projectDir) ? instanceRecord.projectDir : undefined)
      ?? (isNonEmptyString(instanceRecord.directory) ? instanceRecord.directory : undefined)
      ?? "",
    collectedAt:
      (typeof instanceRecord.updatedAt === "number" && Number.isFinite(instanceRecord.updatedAt) ? instanceRecord.updatedAt : undefined)
      ?? (typeof instanceRecord.connectedAt === "number" && Number.isFinite(instanceRecord.connectedAt) ? instanceRecord.connectedAt : undefined)
      ?? 0,
    sessions,
    unavailable: toInstanceUnavailable(instanceRecord.unavailable) as WechatInstanceStatusSnapshot["unavailable"],
  }
}

export function formatInstanceStatusSnapshot(snapshotInput: unknown): string {
  const snapshot = normalizeSnapshot(snapshotInput)
  const lines: string[] = []
  const name = snapshot.instanceName || snapshot.instanceID

  lines.push(`instance: ${name} (${snapshot.instanceID})`)

  const instanceUnavailable = toInstanceUnavailable(snapshot.unavailable)
  if (instanceUnavailable.length > 0) {
    lines.push(`instance unavailable: ${instanceUnavailable.join(", ")}`)
  }

  const sessions = pickTopSessions(snapshot.sessions)
  if (sessions.length === 0) {
    lines.push("- no active sessions")
    return lines.join("\n")
  }

  for (const session of sessions) {
    const title = isNonEmptyString(session.title) ? session.title : session.sessionID
    lines.push(`- session ${session.sessionID}: ${title}`)

    const sessionUnavailable = toSessionUnavailable(session.unavailable)
    if (sessionUnavailable.length > 0) {
      lines.push(`  session unavailable: ${sessionUnavailable.join(", ")}`)
    }

    const highlights = sortHighlights(Array.isArray(session.highlights) ? session.highlights : [])
    for (const highlight of highlights) {
      lines.push(`  ${highlight.text}`)
    }
  }

  return lines.join("\n")
}

export function formatAggregatedStatusReply(input: AggregatedStatusReplyInput): string {
  if (!Array.isArray(input.instances) || input.instances.length === 0) {
    return "wechat status: no online instances"
  }

  const sections: string[] = []
  sections.push("wechat status")

  for (const instance of input.instances) {
    if (instance.status === "timeout/unreachable") {
      sections.push("实例状态")
      sections.push("timeout/unreachable")
      continue
    }

    const snapshot = normalizeSnapshot(instance.snapshot)
    const sessions = pickTopSessions(snapshot.sessions)
    if (sessions.length === 0) {
      sections.push(snapshot.instanceName || "未命名实例")
      sections.push("- no active sessions")
      continue
    }

    for (const session of sessions) {
      sections.push(session.title || "未命名会话")
      sections.push(formatSessionTags(session))
      for (const todo of session.todoItems ?? []) {
        sections.push(formatTodoItem(todo))
      }
      for (const question of session.questionHighlights ?? []) {
        sections.push(question)
      }

      const sessionUnavailable = toSessionUnavailable(session.unavailable)
      if (sessionUnavailable.length > 0) {
        sections.push(`session unavailable: ${sessionUnavailable.join(", ")}`)
      }

      for (const highlight of sortHighlights(session.highlights)) {
        if (highlight.kind !== "todo" && highlight.kind !== "question" && (highlight.kind !== "status" || session.status === "retry")) {
          sections.push(highlight.text)
        }
      }
    }

    const instanceUnavailable = toInstanceUnavailable(snapshot.unavailable)
    if (instanceUnavailable.length > 0) {
      sections.push(`instance unavailable: ${instanceUnavailable.join(", ")}`)
    }
  }

  return sections.join("\n")
}

export function buildAggregatedStatusInstancesFromBrokerView(view: BrokerAuthoritativeView | undefined): AggregatedStatusInstance[] {
  if (!view) {
    return []
  }

  return listBrokerViewInstanceIDs(view).map((instanceID) => {
    const instanceRecord = asObject(view.active.instances[instanceID])
    const connectionGroup = view.connections[instanceID]
    const isOnline = Object.values(connectionGroup ?? {}).some((connection) => connection.online)
      || instanceRecord.online === true

    if (!isOnline) {
      return {
        instanceID,
        status: "timeout/unreachable" as const,
      }
    }

    return {
      instanceID,
      status: "ok" as const,
      snapshot: buildBrokerViewSnapshot(view, instanceID),
    }
  })
}

export function formatAggregatedStatusReplyFromBrokerView(view: BrokerAuthoritativeView | undefined): string {
  return formatAggregatedStatusReply({
    requestId: "broker-authoritative-view",
    instances: buildAggregatedStatusInstancesFromBrokerView(view),
  })
}
