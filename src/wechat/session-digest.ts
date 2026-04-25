import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2"

type SessionState = "busy" | "idle" | "retry" | "unknown"

type SessionMessages = Array<{ info: Message; parts: Part[] }>

export type SessionDigestHighlight = {
  kind: "question" | "permission" | "running-tool" | "completed-tool" | "todo" | "status"
  text: string
}

export type SessionDigestTodoItem = {
  status: "pending" | "in_progress" | "completed" | "cancelled"
  content: string
}

export type SessionDigest = {
  sessionID: string
  parentID?: string
  title: string
  directory: string
  updatedAt: number
  status: SessionState
  pendingQuestionCount: number
  pendingPermissionCount: number
  todoSummary: {
    total: number
    inProgress: number
    completed: number
  }
  unavailable?: Array<"messages" | "todo">
  highlights: SessionDigestHighlight[]
  todoItems?: SessionDigestTodoItem[]
  questionHighlights?: string[]
}

export type BuildSessionDigestInput = {
  session: Pick<Session, "id" | "title" | "directory" | "time"> & { parentID?: string }
  statusBySession: Record<string, SessionStatus | undefined>
  questionsBySession: Map<string, QuestionRequest[]>
  permissionsBySession: Map<string, PermissionRequest[]>
  todos?: Todo[]
  messages?: SessionMessages
  unavailable?: Array<"messages" | "todo">
}

function asSessionState(status: SessionStatus | undefined): SessionState {
  if (!status) {
    return "unknown"
  }
  return status.type
}

function toUpdatedAt(session: Pick<Session, "time">): number {
  const updated = session.time?.updated
  if (typeof updated === "number" && Number.isFinite(updated)) {
    return updated
  }
  return 0
}

function collectToolSlices(messages: SessionMessages): {
  runningText?: string
  completedText?: string
} {
  const runningTools: string[] = []
  let latestCompletedTool: string | undefined

  for (const message of messages) {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
      if (part.type !== "tool") {
        continue
      }

      const toolName = part.tool
      const status = part.state?.status

      if (status === "pending" || status === "running") {
        if (!runningTools.includes(toolName)) {
          runningTools.push(toolName)
        }
        continue
      }

      if (status === "completed") {
        latestCompletedTool = toolName
      }
    }
  }

  return {
    runningText:
      runningTools.length > 0 ? `running tool: ${runningTools.join(", ")}` : undefined,
    completedText: latestCompletedTool ? `completed tool: ${latestCompletedTool}` : undefined,
  }
}

function summarizeTodos(todos: Todo[]): { total: number; inProgress: number; completed: number } {
  let inProgress = 0
  let completed = 0

  for (const todo of todos) {
    if (todo.status === "in_progress") {
      inProgress += 1
    }
    if (todo.status === "completed") {
      completed += 1
    }
  }

  return {
    total: todos.length,
    inProgress,
    completed,
  }
}

function normalizeTodoStatus(status: unknown): SessionDigestTodoItem["status"] | null {
  return status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled"
    ? status
    : null
}

function pushIfDefined(highlights: SessionDigestHighlight[], kind: SessionDigestHighlight["kind"], text?: string) {
  if (!text) {
    return
  }
  highlights.push({ kind, text })
}

function summarizeQuestionHighlight(question: QuestionRequest): string | undefined {
  const first = Array.isArray(question.questions) ? question.questions[0] : undefined
  if (first && typeof first.question === "string" && first.question.trim().length > 0) {
    return `问题：${first.question.trim()}`
  }
  const fallback = (question as { text?: unknown }).text
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return `问题：${fallback.trim()}`
  }
  return undefined
}

export function groupQuestionsBySession(
  questions: QuestionRequest[] = [],
): Map<string, QuestionRequest[]> {
  const grouped = new Map<string, QuestionRequest[]>()
  for (const question of questions) {
    const sessionID = question.sessionID
    if (sessionID.length === 0) {
      continue
    }
    const list = grouped.get(sessionID) ?? []
    list.push(question)
    grouped.set(sessionID, list)
  }
  return grouped
}

export function groupPermissionsBySession(
  permissions: PermissionRequest[] = [],
): Map<string, PermissionRequest[]> {
  const grouped = new Map<string, PermissionRequest[]>()
  for (const permission of permissions) {
    const sessionID = permission.sessionID
    if (sessionID.length === 0) {
      continue
    }
    const list = grouped.get(sessionID) ?? []
    list.push(permission)
    grouped.set(sessionID, list)
  }
  return grouped
}

export function buildSessionDigest(input: BuildSessionDigestInput): SessionDigest {
  const sessionID = input.session.id
  const questions = input.questionsBySession.get(sessionID) ?? []
  const permissions = input.permissionsBySession.get(sessionID) ?? []
  const todos = input.todos ?? []
  const messages = input.messages ?? []
  const todoSummary = summarizeTodos(todos)
  const toolSlices = collectToolSlices(messages)
  const status = asSessionState(input.statusBySession[sessionID])
  const highlights: SessionDigestHighlight[] = []
  const todoItems = todos
    .map((todo) => {
      const status = normalizeTodoStatus(todo.status)
      return {
        status,
        content: typeof todo.content === "string" ? todo.content.trim() : "",
      }
    })
    .filter(
      (item): item is SessionDigestTodoItem => item.status !== null && item.content.length > 0,
    )
  const questionHighlights = questions
    .map((question) => summarizeQuestionHighlight(question))
    .filter((item): item is string => typeof item === "string" && item.length > 0)

  if (permissions.length > 0) {
    highlights.push({ kind: "permission", text: `pending permission: ${permissions.length}` })
  }

  if (questions.length > 0) {
    highlights.push({ kind: "question", text: `pending question: ${questions.length}` })
  }

  pushIfDefined(highlights, "running-tool", toolSlices.runningText)
  pushIfDefined(highlights, "completed-tool", toolSlices.completedText)

  if (todoSummary.total > 0) {
    highlights.push({
      kind: "todo",
      text: `todo: ${todoSummary.inProgress} in progress, ${todoSummary.completed} completed, ${todoSummary.total} total`,
    })
  }

  highlights.push({ kind: "status", text: `status: ${status}` })

  const unavailable = (input.unavailable ?? []).filter(
    (item): item is "messages" | "todo" => item === "messages" || item === "todo",
  )

  return {
    sessionID,
    ...(typeof input.session.parentID === "string" && input.session.parentID.trim().length > 0
      ? { parentID: input.session.parentID.trim() }
      : {}),
    title: input.session.title ?? "",
    directory: input.session.directory ?? "",
    updatedAt: toUpdatedAt(input.session),
    status,
    pendingQuestionCount: questions.length,
    pendingPermissionCount: permissions.length,
    todoSummary,
    unavailable: unavailable.length > 0 ? unavailable : undefined,
    highlights,
    ...(todoItems.length > 0 ? { todoItems } : {}),
    ...(questionHighlights.length > 0 ? { questionHighlights } : {}),
  }
}

type RecentSessionLike = Pick<Session, "time">

export function pickRecentSessions<TSession extends RecentSessionLike>(
  sessions: TSession[],
  limit = 3,
): TSession[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3
  return [...sessions]
    .sort((a, b) => toUpdatedAt(b) - toUpdatedAt(a))
    .slice(0, safeLimit)
}
