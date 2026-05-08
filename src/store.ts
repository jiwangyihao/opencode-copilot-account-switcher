import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"
import { xdgConfig, xdgData } from "xdg-basedir"
import { copilotAccountsPath, legacyCopilotStorePath } from "./store-paths.js"

export type StoreWriteDebugMeta = {
  reason?: string
  source?: string
  actionType?: string
  inputStage?: string
  parsedKey?: string
}

export type AccountEntry = {
  name: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  user?: string
  email?: string
  orgs?: string[]
  addedAt?: number
  lastUsed?: number
  source?: "auth" | "manual"
  providerId?: string
  quota?: {
    plan?: string
    sku?: string
    reset?: string
    updatedAt?: number
    error?: string
    snapshots?: {
      premium?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
      chat?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
      completions?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
    }
  }
  models?: {
    available: string[]
    disabled: string[]
    updatedAt?: number
    error?: string
  }
}

export type StoreFile = {
  active?: string
  activeAccountNames?: string[]
  accounts: Record<string, AccountEntry>
  modelAccountAssignments?: Record<string, string[]>
  autoRefresh?: boolean
  refreshMinutes?: number
  lastAccountSwitchAt?: number
  lastQuotaRefresh?: number
  networkRetryEnabled?: boolean
  syntheticAgentInitiatorEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  // legacy migration fallback; new writes should use experimentalSlashCommandsEnabled
  experimentalStatusSlashCommandEnabled?: boolean
}

type LegacyStoreFile = Omit<StoreFile, "activeAccountNames" | "modelAccountAssignments"> & {
  activeAccountNames?: unknown
  modelAccountAssignments?: Record<string, unknown>
  experimentalStatusSlashCommandEnabled?: unknown
  loopSafetyEnabled?: unknown
  loopSafetyProviderScope?: unknown
}

const authFile = "auth.json"
const defaultStoreDebugLogFile = (() => {
  const tmp = process.env.TEMP || process.env.TMP || "/tmp"
  return `${tmp}/opencode-copilot-store-debug.log`
})()

function isStoreDebugEnabled() {
  return process.env.OPENCODE_COPILOT_STORE_DEBUG === "1"
}

function buildStoreSnapshot(store: StoreFile | undefined) {
  return {
    active: store?.active ?? null,
    accountCount: Object.keys(store?.accounts ?? {}).length,
    modelAccountAssignmentCount: Object.keys(store?.modelAccountAssignments ?? {}).length,
    networkRetryEnabled: store?.networkRetryEnabled ?? null,
    experimentalSlashCommandsEnabled: store?.experimentalSlashCommandsEnabled ?? null,
    lastAccountSwitchAt: store?.lastAccountSwitchAt ?? null,
    syntheticAgentInitiatorEnabled: store?.syntheticAgentInitiatorEnabled ?? false,
  }
}

function buildCallStack() {
  const stack = new Error().stack?.split("\n") ?? []
  return stack
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
}

async function logStoreWrite(input: {
  filePath: string
  before?: StoreFile
  after: StoreFile
  debug?: StoreWriteDebugMeta
}) {
  if (!isStoreDebugEnabled()) return

  const filePath = process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE || defaultStoreDebugLogFile
  const event = {
    kind: "store-write",
    at: new Date().toISOString(),
    targetFile: input.filePath,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    stack: buildCallStack(),
    ...input.debug,
    before: buildStoreSnapshot(input.before),
    after: buildStoreSnapshot(input.after),
  }

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8")
  } catch (error) {
    console.warn("[copilot-store-debug] failed to write debug log", error)
  }
}

export function storePath(): string {
  return copilotAccountsPath()
}

export function authPath(): string {
  const dataDir = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(dataDir, "opencode", authFile)
}

function normalizeAccountNameList(names: unknown, accounts: Record<string, AccountEntry>) {
  if (!Array.isArray(names)) return undefined
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of names) {
    if (typeof item !== "string" || item.length === 0 || !accounts[item] || seen.has(item)) continue
    seen.add(item)
    normalized.push(item)
  }
  return normalized.length > 0 ? normalized : undefined
}

function normalizeModelAccountAssignments(raw: unknown, accounts: Record<string, AccountEntry>) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const normalized: Record<string, string[]> = {}
  for (const [modelID, accountNames] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof modelID !== "string" || modelID.length === 0) continue
    const next = typeof accountNames === "string"
      ? normalizeAccountNameList([accountNames], accounts)
      : normalizeAccountNameList(accountNames, accounts)
    if (!next) continue
    normalized[modelID] = next
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function parseStore(raw: string): StoreFile {
  const parsed = raw ? (JSON.parse(raw) as LegacyStoreFile) : ({ accounts: {} } as LegacyStoreFile)
  const legacySlashCommandsEnabled = parsed.experimentalStatusSlashCommandEnabled
  const accounts = parsed.accounts ?? {}
  const {
    experimentalStatusSlashCommandEnabled: _legacyStatusSlash,
    loopSafetyEnabled: _legacyLoopSafetyEnabled,
    loopSafetyProviderScope: _legacyLoopSafetyProviderScope,
    ...parsedWithoutLegacy
  } = parsed
  const store: StoreFile = {
    ...(parsedWithoutLegacy as StoreFile),
    accounts,
  }

  const normalizedActiveAccountNames = normalizeAccountNameList(parsed.activeAccountNames, accounts)
  if (normalizedActiveAccountNames) store.activeAccountNames = normalizedActiveAccountNames
  else if (typeof store.active === "string" && store.active.length > 0 && accounts[store.active]) {
    store.activeAccountNames = [store.active]
  } else {
    delete store.activeAccountNames
  }

  store.modelAccountAssignments = normalizeModelAccountAssignments(parsed.modelAccountAssignments, accounts)
  if (typeof store.lastAccountSwitchAt !== "number" || Number.isNaN(store.lastAccountSwitchAt)) {
    delete store.lastAccountSwitchAt
  }
  if (store.networkRetryEnabled !== true) store.networkRetryEnabled = false
  if (store.syntheticAgentInitiatorEnabled !== true) store.syntheticAgentInitiatorEnabled = false
  if (store.experimentalSlashCommandsEnabled !== true && store.experimentalSlashCommandsEnabled !== false) {
    store.experimentalSlashCommandsEnabled = legacySlashCommandsEnabled === false ? false : true
  }
  for (const [name, entry] of Object.entries(store.accounts)) {
    const info = entry as AccountEntry
    if (!info.name) info.name = name
  }
  return store
}

export async function readStore(filePath = storePath()): Promise<StoreFile> {
  const raw = await fs.readFile(filePath, "utf-8").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    if (filePath !== storePath()) return ""
    return fs.readFile(legacyCopilotStorePath(), "utf-8").catch((legacyError: NodeJS.ErrnoException) => {
      if (legacyError.code === "ENOENT") return ""
      throw legacyError
    })
  })
  return parseStore(raw)
}

export async function readStoreSafe(filePath = storePath()): Promise<StoreFile | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8").catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      if (filePath !== storePath()) return ""
      return fs.readFile(legacyCopilotStorePath(), "utf-8").catch((legacyError: NodeJS.ErrnoException) => {
        if (legacyError.code === "ENOENT") return ""
        throw legacyError
      })
    })
    return parseStore(raw)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return parseStore("")
    return undefined
  }
}

export function readStoreSafeSync(filePath = storePath()): StoreFile | undefined {
  try {
    return parseStore(readFileSync(filePath, "utf-8"))
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") {
      try {
        if (filePath === storePath()) {
          return parseStore(readFileSync(legacyCopilotStorePath(), "utf-8"))
        }
      } catch (legacyError) {
        const legacyIssue = legacyError as NodeJS.ErrnoException
        if (legacyIssue.code !== "ENOENT") return undefined
      }
      return parseStore("")
    }
    return undefined
  }
}

export async function readAuth(filePath?: string): Promise<Record<string, AccountEntry>> {
  const dataFile = path.join(xdgData ?? path.join(os.homedir(), ".local", "share"), "opencode", authFile)
  const configFile = path.join(xdgConfig ?? path.join(os.homedir(), ".config"), "opencode", authFile)
  const files = filePath ? [filePath] : [dataFile, configFile]
  let raw = ""
  for (const file of files) {
    raw = await fs.readFile(file, "utf-8").catch(() => "")
    if (raw) break
  }
  if (!raw) return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return Object.entries(parsed).reduce((acc, [key, value]) => {
    if (!value || typeof value !== "object") return acc
    const info = value as {
      type?: string
      refresh?: string
      access?: string
      expires?: number
      accountId?: string
      enterpriseUrl?: string
    }
    if (info.type !== "oauth" || !(info.refresh || info.access)) return acc
    acc[key] = {
      name: `auth:${key}`,
      refresh: info.refresh ?? info.access!,
      access: info.access ?? info.refresh!,
      expires: info.expires ?? 0,
      accountId: info.accountId,
      enterpriseUrl: info.enterpriseUrl,
      source: "auth",
      providerId: key,
    }
    return acc
  }, {} as Record<string, AccountEntry>)
}

export async function writeStore(
  store: StoreFile,
  options?: {
    filePath?: string
    debug?: StoreWriteDebugMeta
  },
) {
  const file = options?.filePath ?? storePath()
  const {
    loopSafetyEnabled: _legacyLoopSafetyEnabled,
    loopSafetyProviderScope: _legacyLoopSafetyProviderScope,
    ...persistedStore
  } = store as StoreFile & {
    loopSafetyEnabled?: unknown
    loopSafetyProviderScope?: unknown
  }
  const before = await readStoreSafe(file)
  await logStoreWrite({
    filePath: file,
    before,
    after: persistedStore,
    debug: options?.debug,
  })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(persistedStore, null, 2), { mode: 0o600 })
}
