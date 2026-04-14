import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"

export type QuestionPromptMode = "text" | "single" | "multiple"

export type QuestionPromptSummary = {
  title?: string
  body?: string
  mode: QuestionPromptMode
  custom?: boolean
  options?: Array<{
    index: number
    label: string
    value: string
  }>
}

export type PermissionPromptSummary = {
  title?: string
  type?: string
  description?: string
}

export type RequestPromptSummary = QuestionPromptSummary | PermissionPromptSummary

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function normalizeQuestionPromptSummary(input: unknown): QuestionPromptSummary {
  const record = input as Partial<QuestionPromptSummary>
  const mode = record.mode === "multiple" ? "multiple" : record.mode === "single" ? "single" : record.mode === "text" ? "text" : undefined
  if (!mode) {
    throw new Error("invalid request prompt format")
  }

  const options = Array.isArray(record.options)
    ? record.options.map((option) => {
        const item = option as { index?: unknown; label?: unknown; value?: unknown }
        if (!isFiniteNumber(item.index) || !isNonEmptyString(item.label) || !isNonEmptyString(item.value)) {
          throw new Error("invalid request prompt format")
        }
        return {
          index: item.index,
          label: item.label,
          value: item.value,
        }
      })
    : undefined

  return {
    ...(isNonEmptyString(record.title) ? { title: record.title.trim() } : {}),
    ...(isNonEmptyString(record.body) ? { body: record.body.trim() } : {}),
    mode,
    ...(record.custom === true ? { custom: true } : {}),
    ...(options && options.length > 0 ? { options } : {}),
  }
}

function normalizePermissionPromptSummary(input: unknown): PermissionPromptSummary {
  const record = input as Partial<PermissionPromptSummary>
  return {
    ...(isNonEmptyString(record.title) ? { title: record.title.trim() } : {}),
    ...(isNonEmptyString(record.type) ? { type: record.type.trim() } : {}),
    ...(isNonEmptyString(record.description) ? { description: record.description.trim() } : {}),
  }
}

export function normalizeRequestPromptSummary(
  kind: "question" | "permission",
  input: unknown,
): RequestPromptSummary | undefined {
  if (input === undefined) {
    return undefined
  }
  return kind === "question" ? normalizeQuestionPromptSummary(input) : normalizePermissionPromptSummary(input)
}

export function extractQuestionPromptSummary(question: QuestionRequest): QuestionPromptSummary | undefined {
  const first = Array.isArray(question.questions) ? question.questions[0] : undefined
  if (!first) {
    return undefined
  }

  const mode: QuestionPromptMode = first.multiple === true ? "multiple" : Array.isArray(first.options) && first.options.length > 0 ? "single" : "text"
  const options = Array.isArray(first.options)
    ? first.options
        .filter((option) => isNonEmptyString(option?.label))
        .map((option, index) => ({
          index: index + 1,
          label: option.label.trim(),
          value: option.label.trim(),
        }))
    : undefined

  return normalizeQuestionPromptSummary({
    title: isNonEmptyString(first.header) ? first.header : undefined,
    body: isNonEmptyString(first.question) ? first.question : undefined,
    mode,
    custom: first.custom === true,
    options,
  })
}

export function extractPermissionPromptSummary(permission: PermissionRequest): PermissionPromptSummary | undefined {
  const metadata = typeof permission.metadata === "object" && permission.metadata !== null
    ? permission.metadata as Record<string, unknown>
    : {}

  const type = isNonEmptyString(metadata.type) ? metadata.type : undefined
  const description = Array.isArray(permission.patterns) && permission.patterns.length > 0
    ? permission.patterns.join(", ")
    : undefined

  return normalizePermissionPromptSummary({
    title: isNonEmptyString(permission.permission) ? permission.permission : undefined,
    type,
    description,
  })
}

function findOptionValue(
  options: NonNullable<QuestionPromptSummary["options"]>,
  token: string,
): string {
  const index = Number(token)
  if (!Number.isInteger(index)) {
    throw new Error("回复格式无效，请按题目提示填写选项编号")
  }
  const match = options.find((option) => option.index === index)
  if (!match) {
    throw new Error(`选项编号超出范围：${token}`)
  }
  return match.value
}

export function buildQuestionAnswersFromReply(
  prompt: QuestionPromptSummary | undefined,
  rawText: string,
): Array<Array<string>> {
  const text = rawText.trim()
  if (!text) {
    throw new Error("回复内容不能为空")
  }

  if (!prompt || prompt.mode === "text") {
    return [[text]]
  }

  const options = prompt.options ?? []
  if (options.length === 0) {
    return [[text]]
  }

  if (prompt.custom === true && !/^\d+(,\d+)*$/.test(text)) {
    return [[text]]
  }

  if (prompt.mode === "single") {
    if (!/^\d+$/.test(text)) {
      throw new Error(
        prompt.custom === true
          ? "单选题请回复单个选项编号，或直接输入自定义回答"
          : "该问题不支持自定义回复，请按题目提示填写选项编号",
      )
    }
    return [[findOptionValue(options, text)]]
  }

  const tokens = text.split(",").map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) {
    throw new Error("多选题请使用逗号分隔的选项编号")
  }

  const seen = new Set<string>()
  const values: string[] = []
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      throw new Error(
        prompt.custom === true
          ? "多选题请使用逗号分隔的选项编号，或直接输入自定义回答"
          : "该问题不支持自定义回复，请按题目提示填写选项编号",
      )
    }
    if (seen.has(token)) {
      throw new Error(`选项编号不能重复：${token}`)
    }
    seen.add(token)
    values.push(findOptionValue(options, token))
  }
  return [values]
}
