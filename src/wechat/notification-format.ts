import type { NotificationRecord } from "./notification-types.js"
import {
  SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
  type ShowFallbackToastPayload,
} from "./protocol.js"

export const WECHAT_FALLBACK_TOAST_MESSAGE = "微信会话可能已失效，请在微信发送 /status 重新激活"

export function createDeliveryFailedFallbackToastPayload(input: {
  wechatAccountId: string
  userId: string
  registrationEpoch: string
}): ShowFallbackToastPayload {
  return {
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    message: WECHAT_FALLBACK_TOAST_MESSAGE,
    reason: SHOW_FALLBACK_TOAST_DELIVERY_FAILED_REASON,
    registrationEpoch: input.registrationEpoch,
  }
}

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

function formatQuestionOptions(options: Array<{ index: number; label: string }> = []) {
  return options.map((option) => `${option.index}. ${option.label}`)
}

function formatQuestionReplyExamples(handle: string, mode: string | undefined, allowCustom: boolean) {
  const examples: string[] = []
  if (mode === "single") {
    examples.push(`编号回复：/reply ${handle} 1`)
  }
  if (mode === "multiple") {
    examples.push(`编号回复：/reply ${handle} 1,2`)
  }
  if (mode === "text" || allowCustom) {
    examples.push(`自定义回复：/reply ${handle} 你的自定义回答`)
  }
  if (mode === "multiple" && allowCustom) {
    examples.push(`混合回复：/reply ${handle} 1,3; 其他：先灰度再全量`)
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
        `允许一次：/allow ${handle} once`,
        `始终允许：/allow ${handle} always`,
        `拒绝：/allow ${handle} reject`,
        ...formatPermissionReplySemantics(),
      ].filter(Boolean)
      return lines.join("\n")
    }
    return `收到新的权限请求（${handle}），请在 OpenCode 中处理。`
  }

  return "检测到会话异常（retry），请在 OpenCode 中检查并处理。"
}
