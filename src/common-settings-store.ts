import path from "node:path"
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"

import { commonSettingsPath as defaultCommonSettingsPath, legacyCopilotStorePath } from "./store-paths.js"
import { parseStore, type StoreFile } from "./store.js"

export type CommonSettingsStore = {
  networkRetryEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  experimentalStatusSlashCommandEnabled?: boolean
  wechat?: WechatMenuSettings
  wechatNotificationsEnabled?: boolean
  wechatQuestionNotifyEnabled?: boolean
  wechatPermissionNotifyEnabled?: boolean
  wechatSessionErrorNotifyEnabled?: boolean
}

export type WechatBinding = {
  accountId: string
  userId?: string
  name?: string
  enabled?: boolean
  configured?: boolean
  boundAt?: number
}

export type WechatMenuSettings = {
  primaryBinding?: WechatBinding
  notifications: {
    enabled: boolean
    question: boolean
    permission: boolean
    sessionError: boolean
  }
  future?: {
    accounts?: WechatBinding[]
  }
}

export type WechatNotificationDispatchSettings = {
  targetUserId?: string
  notifications: {
    enabled: boolean
    question: boolean
    permission: boolean
    sessionError: boolean
  }
}

function normalizeWechatBinding(input: unknown): WechatBinding | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  if (typeof value.accountId !== "string" || value.accountId.length === 0) return undefined
  const binding: WechatBinding = { accountId: value.accountId }
  if (typeof value.userId === "string") binding.userId = value.userId
  if (typeof value.name === "string") binding.name = value.name
  if (typeof value.enabled === "boolean") binding.enabled = value.enabled
  if (typeof value.configured === "boolean") binding.configured = value.configured
  if (typeof value.boundAt === "number" && Number.isFinite(value.boundAt)) binding.boundAt = value.boundAt
  return binding
}

function normalizeWechatSettings(source: CommonSettingsStore): WechatMenuSettings {
  const wechatValue = source.wechat && typeof source.wechat === "object"
    ? (source.wechat as Record<string, unknown>)
    : undefined
  const notificationsValue = wechatValue?.notifications && typeof wechatValue.notifications === "object"
    ? (wechatValue.notifications as Record<string, unknown>)
    : undefined
  const futureValue = wechatValue?.future && typeof wechatValue.future === "object"
    ? (wechatValue.future as Record<string, unknown>)
    : undefined

  const enabled = typeof notificationsValue?.enabled === "boolean"
    ? notificationsValue.enabled
    : source.wechatNotificationsEnabled !== false
  const question = typeof notificationsValue?.question === "boolean"
    ? notificationsValue.question
    : source.wechatQuestionNotifyEnabled !== false
  const permission = typeof notificationsValue?.permission === "boolean"
    ? notificationsValue.permission
    : source.wechatPermissionNotifyEnabled !== false
  const sessionError = typeof notificationsValue?.sessionError === "boolean"
    ? notificationsValue.sessionError
    : source.wechatSessionErrorNotifyEnabled !== false

  const primaryBinding = normalizeWechatBinding(wechatValue?.primaryBinding)
  const accounts = Array.isArray(futureValue?.accounts)
    ? futureValue.accounts
      .map((account) => normalizeWechatBinding(account))
      .filter((account): account is WechatBinding => Boolean(account))
    : undefined

  return {
    ...(primaryBinding ? { primaryBinding } : {}),
    notifications: {
      enabled,
      question,
      permission,
      sessionError,
    },
    ...(accounts ? { future: { accounts } } : {}),
  }
}

export function normalizeCommonSettingsStore(input: CommonSettingsStore | undefined): CommonSettingsStore {
  const source = input ?? {}
  const legacySlashCommandsEnabled = source.experimentalStatusSlashCommandEnabled
  const wechat = normalizeWechatSettings(source)
  return {
    ...(source.networkRetryEnabled === true ? { networkRetryEnabled: true } : { networkRetryEnabled: false }),
    experimentalSlashCommandsEnabled:
      source.experimentalSlashCommandsEnabled === true || source.experimentalSlashCommandsEnabled === false
        ? source.experimentalSlashCommandsEnabled
        : legacySlashCommandsEnabled === false
        ? false
        : true,
    wechat,
  }
}

function parsePartialCommonSettingsStore(raw: string): CommonSettingsStore {
  const parsed = raw ? (JSON.parse(raw) as CommonSettingsStore) : {}
  const partial: CommonSettingsStore = {}

  if (parsed.networkRetryEnabled === true || parsed.networkRetryEnabled === false) {
    partial.networkRetryEnabled = parsed.networkRetryEnabled
  }
  if (parsed.experimentalSlashCommandsEnabled === true || parsed.experimentalSlashCommandsEnabled === false) {
    partial.experimentalSlashCommandsEnabled = parsed.experimentalSlashCommandsEnabled
  }
  if (parsed.experimentalStatusSlashCommandEnabled === true || parsed.experimentalStatusSlashCommandEnabled === false) {
    partial.experimentalStatusSlashCommandEnabled = parsed.experimentalStatusSlashCommandEnabled
  }
  if (parsed.wechat && typeof parsed.wechat === "object") {
    partial.wechat = parsed.wechat
  }
  if (parsed.wechatNotificationsEnabled === true || parsed.wechatNotificationsEnabled === false) {
    partial.wechatNotificationsEnabled = parsed.wechatNotificationsEnabled
  }
  if (parsed.wechatQuestionNotifyEnabled === true || parsed.wechatQuestionNotifyEnabled === false) {
    partial.wechatQuestionNotifyEnabled = parsed.wechatQuestionNotifyEnabled
  }
  if (parsed.wechatPermissionNotifyEnabled === true || parsed.wechatPermissionNotifyEnabled === false) {
    partial.wechatPermissionNotifyEnabled = parsed.wechatPermissionNotifyEnabled
  }
  if (parsed.wechatSessionErrorNotifyEnabled === true || parsed.wechatSessionErrorNotifyEnabled === false) {
    partial.wechatSessionErrorNotifyEnabled = parsed.wechatSessionErrorNotifyEnabled
  }

  return partial
}

function readLegacyCommonSettings(store: StoreFile | undefined): CommonSettingsStore {
  if (!store) return {}
  return normalizeCommonSettingsStore({
    networkRetryEnabled: store.networkRetryEnabled,
    experimentalSlashCommandsEnabled: store.experimentalSlashCommandsEnabled,
    experimentalStatusSlashCommandEnabled: store.experimentalStatusSlashCommandEnabled,
  })
}

function mergeCommonSettings(current: CommonSettingsStore, legacy: CommonSettingsStore) {
  return normalizeCommonSettingsStore({
    networkRetryEnabled: current.networkRetryEnabled ?? legacy.networkRetryEnabled,
    experimentalSlashCommandsEnabled:
      current.experimentalSlashCommandsEnabled ?? legacy.experimentalSlashCommandsEnabled,
    experimentalStatusSlashCommandEnabled:
      current.experimentalStatusSlashCommandEnabled ?? legacy.experimentalStatusSlashCommandEnabled,
    wechat: current.wechat,
    wechatNotificationsEnabled: current.wechatNotificationsEnabled ?? legacy.wechatNotificationsEnabled,
    wechatQuestionNotifyEnabled: current.wechatQuestionNotifyEnabled ?? legacy.wechatQuestionNotifyEnabled,
    wechatPermissionNotifyEnabled: current.wechatPermissionNotifyEnabled ?? legacy.wechatPermissionNotifyEnabled,
    wechatSessionErrorNotifyEnabled: current.wechatSessionErrorNotifyEnabled ?? legacy.wechatSessionErrorNotifyEnabled,
  })
}

export function parseCommonSettingsStore(raw: string): CommonSettingsStore {
  return normalizeCommonSettingsStore(parsePartialCommonSettingsStore(raw))
}

export function commonSettingsPath() {
  return defaultCommonSettingsPath()
}

export async function readCommonSettingsStore(options?: {
  filePath?: string
  legacyCopilotFilePath?: string
}): Promise<CommonSettingsStore> {
  const file = options?.filePath ?? commonSettingsPath()
  const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const current = parsePartialCommonSettingsStore(raw)

  const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath()
  const legacyRaw = await fs.readFile(legacyFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

  if (!legacyRaw) return normalizeCommonSettingsStore(current)
  const legacy = readLegacyCommonSettings(parseStore(legacyRaw))
  return mergeCommonSettings(current, legacy)
}

export function readCommonSettingsStoreSync(options?: {
  filePath?: string
  legacyCopilotFilePath?: string
}): CommonSettingsStore | undefined {
  const file = options?.filePath ?? commonSettingsPath()
  let current = ""
  try {
    current = readFileSync(file, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") return undefined
  }

  const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath()
  let legacyRaw = ""
  try {
    legacyRaw = readFileSync(legacyFile, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") return undefined
  }

  const partial = parsePartialCommonSettingsStore(current)
  if (!legacyRaw) return normalizeCommonSettingsStore(partial)
  return mergeCommonSettings(partial, readLegacyCommonSettings(parseStore(legacyRaw)))
}

export async function writeCommonSettingsStore(
  store: CommonSettingsStore,
  options?: {
    filePath?: string
  },
) {
  const file = options?.filePath ?? commonSettingsPath()
  const normalized = normalizeCommonSettingsStore(store)
  const persisted: CommonSettingsStore = {
    networkRetryEnabled: normalized.networkRetryEnabled,
    experimentalSlashCommandsEnabled: normalized.experimentalSlashCommandsEnabled,
    wechat: normalized.wechat,
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(persisted, null, 2), { mode: 0o600 })
}

export async function readWechatNotificationDispatchSettings(options?: {
  filePath?: string
  legacyCopilotFilePath?: string
}): Promise<WechatNotificationDispatchSettings> {
  const settings = await readCommonSettingsStore(options)
  return {
    ...(typeof settings.wechat?.primaryBinding?.userId === "string"
      ? { targetUserId: settings.wechat.primaryBinding.userId }
      : {}),
    notifications: settings.wechat?.notifications ?? {
      enabled: true,
      question: true,
      permission: true,
      sessionError: true,
    },
  }
}
