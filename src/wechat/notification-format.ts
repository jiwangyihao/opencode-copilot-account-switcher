import type { NaturalStopTerminalReason, NotificationRecord } from "./notification-types.js"
import type { BrokerLegacyHandleClosure } from "./broker-state-store.js"
import type { RequestTerminalReason } from "./request-store.js"

function formatHandle(handle: string | undefined, fallback: string): string {
  if (typeof handle === "string" && handle.trim().length > 0) {
    return handle
  }
  return fallback
}

function formatQuestionType(mode: string | undefined) {
  if (mode === "multiple") return "多选"
  if (mode === "single") return "单选"
  return "文本"
}

function formatQuestionOptions(options: Array<{ index: number; label: string; description?: string }> = []) {
  return options.flatMap((option) => [
    `${option.index}. ${option.label}`,
    ...(typeof option.description === "string" && option.description.trim().length > 0 ? [option.description.trim()] : []),
  ])
}

function formatQuestionReplyExamples(handle: string, mode: string | undefined, allowCustom: boolean) {
  const examples: string[] = []
  if (mode === "single") {
    examples.push(`/reply ${handle} 1`)
  }
  if (mode === "multiple") {
    examples.push(`/reply ${handle} 1,2`)
  }
  if (mode === "text" || allowCustom) {
    examples.push(`/reply ${handle} 你的自定义回答`)
  }
  if (mode === "multiple" && allowCustom) {
    examples.push(`/reply ${handle} 1,3; 其他：先灰度再全量`)
  }
  return examples
}

function formatPermissionReplySemantics() {
  return [
    "once：仅处理这一次",
    "always：后续同类请求自动允许",
    "reject：拒绝当前请求",
  ]
}

function formatTerminalReasonLabel(reason: RequestTerminalReason | undefined): string {
  if (reason === "answered") return "已在电脑端回复"
  if (reason === "handled") return "已在电脑端处理"
  if (reason === "rejected") return "已在电脑端拒绝"
  if (reason === "expired") return "已过期"
  if (reason === "replaced") return "已被新入口替代"
  return "已结束"
}

function formatTerminalRefusalLabel(requestKind: "question" | "permission"): string {
  return requestKind === "permission" ? "该入口不再接受权限处理。" : "该入口不再接受回复。"
}

function formatNaturalStopTerminalReasonLabel(reason: NaturalStopTerminalReason | undefined): string {
  if (reason === "replied") return "已在微信端补充回复"
  if (reason === "continued") return "已在电脑端继续处理"
  if (reason === "expired") return "已过期"
  return "已结束"
}

function toRequestTerminalReason(reason: string | undefined): RequestTerminalReason | undefined {
  if (reason === "answered" || reason === "handled" || reason === "rejected" || reason === "expired" || reason === "replaced") {
    return reason
  }
  return undefined
}

function toNaturalStopTerminalReason(reason: string | undefined): NaturalStopTerminalReason | undefined {
  if (reason === "replied" || reason === "continued" || reason === "expired") {
    return reason
  }
  return undefined
}

export function formatNaturalStopClosedText(input: {
  handle?: string
  terminalReason?: NaturalStopTerminalReason
}): string {
  const handle = formatHandle(input.handle, "s?")
  return [
    `中止通知 ${handle} 已结束`,
    `原因：${formatNaturalStopTerminalReasonLabel(input.terminalReason)}`,
    "说明：该入口不再接受回复。",
  ].join("\n")
}

function formatSessionErrorText(record: NotificationRecord): string {
  if (
    typeof record.action !== "string"
    || record.action.trim().length === 0
    || typeof record.redactedSummary !== "string"
    || record.redactedSummary.trim().length === 0
    || typeof record.severityAdvice !== "string"
    || record.severityAdvice.trim().length === 0
  ) {
    return "检测到会话异常（retry），请在 OpenCode 中检查并处理。"
  }

  return [
    `检测到会话异常（${record.sessionID?.trim() || "session?"}）`,
    `动作：${record.action.trim()}`,
    `原因摘要：${record.redactedSummary.trim()}`,
    `处理建议：${record.severityAdvice.trim()}`,
  ].join("\n")
}

function formatNaturalStopText(record: NotificationRecord): string {
  if (record.naturalStopTerminalReason) {
    return formatNaturalStopClosedText({
      handle: record.handle,
      terminalReason: record.naturalStopTerminalReason,
    })
  }

  const handle = formatHandle(record.handle, "s?")
  return [
    `会话已自然中止（${handle}）`,
    `原因摘要：${record.redactedSummary?.trim() || "原因摘要不可安全展示"}`,
    `处理建议：${record.severityAdvice?.trim() || "已停止并等待你的回复"}`,
    `/reply ${handle} 你的补充内容`,
    "发送后会把补充说明回到当前会话。",
  ].join("\n")
}

export function formatTerminalRequestClosedText(input: {
  requestKind: "question" | "permission"
  handle?: string
  terminalReason?: RequestTerminalReason
  replacementHandle?: string
}): string {
  const handle = formatHandle(input.handle, input.requestKind === "permission" ? "p?" : "q?")
  const lines = [
    `${input.requestKind === "permission" ? "权限" : "问题"}入口 ${handle} 已结束`,
    `原因：${formatTerminalReasonLabel(input.terminalReason)}`,
    `说明：${formatTerminalRefusalLabel(input.requestKind)}`,
    ...(input.terminalReason === "replaced" && typeof input.replacementHandle === "string" && input.replacementHandle.trim().length > 0
      ? [`请改用新入口：${input.replacementHandle.trim()}`]
      : []),
  ]
  return lines.join("\n")
}

export function formatBrokerLegacyHandleClosureText(input: Pick<BrokerLegacyHandleClosure, "kind" | "handle" | "reason" | "message" | "replacementHandle">): string {
  if (typeof input.message === "string" && input.message.trim().length > 0) {
    return input.message.trim()
  }

  if (input.kind === "naturalStop") {
    return formatNaturalStopClosedText({
      handle: input.handle,
      terminalReason: toNaturalStopTerminalReason(input.reason),
    })
  }

  return formatTerminalRequestClosedText({
    requestKind: input.kind,
    handle: input.handle,
    terminalReason: toRequestTerminalReason(input.reason),
    replacementHandle: input.replacementHandle,
  })
}

export function formatWechatNotificationText(record: NotificationRecord): string {
  if (record.kind === "question") {
    const handle = formatHandle(record.handle, "q?")
    const prompt = record.prompt
    if (prompt && "mode" in prompt) {
      const lines = [
        `收到新的问题请求（${handle}）`,
        prompt.title ?? prompt.body ?? "请在 OpenCode 中处理该问题。",
        prompt.body && prompt.title ? prompt.body : undefined,
        `类型：${formatQuestionType(prompt.mode)}`,
        ...formatQuestionOptions(prompt.options),
        ...formatQuestionReplyExamples(handle, prompt.mode, prompt.custom === true),
      ].filter(Boolean)
      return lines.join("\n")
    }
    return `收到新的问题请求（${handle}），请在 OpenCode 中处理。`
  }

  if (record.kind === "permission") {
    const handle = formatHandle(record.handle, "p?")
    const prompt = record.prompt
    if (prompt && !('mode' in prompt)) {
      const lines = [
        `收到新的权限请求（${handle}）`,
        prompt.title ?? "请在 OpenCode 中处理该权限请求。",
        `类型：${prompt.type ?? "unknown"}`,
        prompt.description,
        `/allow ${handle} once`,
        `/allow ${handle} always`,
        `/allow ${handle} reject`,
        ...formatPermissionReplySemantics(),
      ].filter(Boolean)
      return lines.join("\n")
    }
    return `收到新的权限请求（${handle}），请在 OpenCode 中处理。`
  }

  if (record.kind === "requestTerminal") {
    return formatTerminalRequestClosedText({
      requestKind: record.requestKind === "permission" ? "permission" : "question",
      handle: record.handle,
      terminalReason: record.terminalReason,
      replacementHandle: record.replacementHandle,
    })
  }

  if (record.kind === "naturalStop") {
    return formatNaturalStopText(record)
  }

  return formatSessionErrorText(record)
}
