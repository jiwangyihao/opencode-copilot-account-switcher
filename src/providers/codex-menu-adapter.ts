import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { fetchCodexStatus, type CodexStatusFetcherResult } from "../codex-status-fetcher.js"
import {
  loadOfficialCodexAuthMethods,
  type OfficialCodexAuthMethod,
} from "../upstream/codex-loader-adapter.js"
import {
  getActiveCodexAccount,
  readCodexStore,
  writeCodexStore,
  type CodexAccountEntry,
  type CodexStoreFile,
} from "../codex-store.js"
import { recoverInvalidCodexAccount } from "../codex-invalid-account.js"
import type { ProviderActionResult, ProviderMenuAdapter } from "../menu-runtime.js"
import { readAuth, type AccountEntry } from "../store.js"
import {
  readCommonSettingsStore,
  writeCommonSettingsStore,
  type CommonSettingsStore,
} from "../common-settings-store.js"
import { applyCommonSettingsAction } from "../common-settings-actions.js"

type WriteMeta = {
  reason?: string
  source?: string
  actionType?: string
}

type AuthClient = {
  auth: {
    set: (input: {
      path: { id: string }
      body: {
        type: "oauth"
        refresh?: string
        access?: string
        expires?: number
        accountId?: string
      }
    }) => Promise<unknown>
  }
  tui?: {
    showToast?: (options: { body: { message: string; variant: "success" | "warning" } }) => Promise<unknown>
  }
}

type OAuthAccount = {
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
  workspaceName?: string
}

type RecoveryWarningMeta = {
  code: "week_recovery_only"
  removed: string
  replacement: string
}

type AdapterDependencies = {
  client: AuthClient
  now?: () => number
  promptText?: (message: string) => Promise<string>
  readStore?: () => Promise<CodexStoreFile>
  writeStore?: (store: CodexStoreFile, meta: WriteMeta) => Promise<void>
  readAuthEntries?: () => Promise<Record<string, AccountEntry>>
  fetchStatus?: (input: {
    oauth: {
      type: "oauth"
      refresh?: string
      access?: string
      expires?: number
      accountId?: string
    }
    accountId?: string
  }) => Promise<CodexStatusFetcherResult>
  loadOfficialCodexAuthMethods?: () => Promise<OfficialCodexAuthMethod[]>
  readCommonSettings?: () => Promise<CommonSettingsStore>
  writeCommonSettings?: (settings: CommonSettingsStore, meta?: WriteMeta) => Promise<void>
}

function pickOfficialOauthMethodByKind(methods: OfficialCodexAuthMethod[], kind: "browser" | "headless") {
  return methods.find((method) => {
    if (method.type !== "oauth") return false
    if (typeof method.authorize !== "function") return false
    const label = method.label.toLowerCase()
    if (kind === "browser") return label.includes("browser")
    return label.includes("headless") || label.includes("device")
  })
}

function parseOfficialOauthSelection(raw: string) {
  const value = raw.trim().toLowerCase()
  if (!value) return "cancel" as const
  if (value === "1" || value === "browser" || value === "b") return "browser" as const
  if (value === "2" || value === "headless" || value === "h" || value === "device") return "headless" as const
  return undefined
}

function pickName(input: {
  accountId?: string
  email?: string
  fallback?: string
}) {
  const accountId = input.accountId?.trim()
  if (accountId) return accountId
  const email = input.email?.trim()
  if (email) return email
  return input.fallback ?? "openai"
}

function ensureUniqueAccountName(store: CodexStoreFile, preferred: string, currentName?: string) {
  if (!store.accounts[preferred] || preferred === currentName) return preferred
  let index = 2
  while (store.accounts[`${preferred}#${index}`]) {
    index += 1
  }
  return `${preferred}#${index}`
}

function toOAuth(entry: CodexAccountEntry) {
  return {
    type: "oauth" as const,
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
    accountId: entry.accountId,
  }
}

function getWechatDebugBundleMode(payload: unknown): "sanitized" | "full" | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined
  }
  const mode = (payload as { mode?: unknown }).mode
  return mode === "sanitized" || mode === "full" ? mode : undefined
}

function getWechatDebugBundleFlowInput(payload: unknown) {
  const mode = getWechatDebugBundleMode(payload)
  if (!mode) {
    return undefined
  }

  const candidate = payload && typeof payload === "object" ? payload as {
    cwd?: unknown
    gitHead?: unknown
    nodeVersion?: unknown
    now?: unknown
    outputRootDir?: unknown
    platform?: unknown
    pluginVersion?: unknown
    stateRoot?: unknown
  } : {}

  return {
    mode,
    ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
    ...(typeof candidate.gitHead === "string" || candidate.gitHead === null ? { gitHead: candidate.gitHead } : {}),
    ...(typeof candidate.nodeVersion === "string" ? { nodeVersion: candidate.nodeVersion } : {}),
    ...(candidate.now instanceof Date ? { now: candidate.now } : {}),
    ...(typeof candidate.outputRootDir === "string" ? { outputRootDir: candidate.outputRootDir } : {}),
    ...(typeof candidate.platform === "string" ? { platform: candidate.platform } : {}),
    ...(typeof candidate.pluginVersion === "string" ? { pluginVersion: candidate.pluginVersion } : {}),
    ...(typeof candidate.stateRoot === "string" ? { stateRoot: candidate.stateRoot } : {}),
  }
}

function toMenuQuota(entry: CodexAccountEntry) {
  return {
    premium: {
      remaining: entry.snapshot?.usage5h?.remaining,
      entitlement: entry.snapshot?.usage5h?.entitlement,
    },
    chat: {
      remaining: entry.snapshot?.usageWeek?.remaining,
      entitlement: entry.snapshot?.usageWeek?.entitlement,
    },
    completions: undefined,
  }
}

function withoutRecoveryWarning(snapshot: CodexAccountEntry["snapshot"]) {
  if (!snapshot) return undefined
  const next = { ...snapshot } as CodexAccountEntry["snapshot"] & { recoveryWarning?: RecoveryWarningMeta }
  delete next.recoveryWarning
  return next
}

async function promptText(message: string) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(message)).trim()
  } finally {
    rl.close()
  }
}

export function createCodexMenuAdapter(inputDeps: AdapterDependencies): ProviderMenuAdapter<CodexStoreFile, CodexAccountEntry> {
  const now = inputDeps.now ?? Date.now
  const loadStore = inputDeps.readStore ?? readCodexStore
  const prompt = inputDeps.promptText ?? promptText
  const persistStore = inputDeps.writeStore ?? (async (store, meta) => {
    await writeCodexStore(store)
    void meta
  })
  const loadAuth = inputDeps.readAuthEntries ?? readAuth
  const fetchStatus = inputDeps.fetchStatus ?? ((input) => fetchCodexStatus(input))
  const loadOfficialMethods = inputDeps.loadOfficialCodexAuthMethods
    ?? (() => loadOfficialCodexAuthMethods({
      client: {
        auth: {
          set: async (value) => inputDeps.client.auth.set(value as Parameters<AuthClient["auth"]["set"]>[0]),
        },
      },
    }))
  const readCommonSettings = inputDeps.readCommonSettings ?? readCommonSettingsStore
  const writeCommonSettings = async (settings: CommonSettingsStore, meta?: WriteMeta) => {
    if (inputDeps.writeCommonSettings) {
      await inputDeps.writeCommonSettings(settings, meta)
      return
    }
    await writeCommonSettingsStore(settings)
  }

  const refreshSnapshots = async (store: CodexStoreFile) => {
    const names = Object.keys(store.accounts)
    const pendingRecoveryWarnings = new Map<string, RecoveryWarningMeta>()
    for (const name of names) {
      const entry = store.accounts[name]
      if (!entry) continue
      const oauth = toOAuth(entry)
      if (!oauth.access && !oauth.refresh) {
        store.accounts[name] = {
          ...entry,
          snapshot: {
            ...(entry.snapshot ?? {}),
            updatedAt: now(),
            error: "missing-openai-oauth",
          },
        }
        continue
      }

      const result = await fetchStatus({ oauth, accountId: entry.accountId }).catch((error: unknown) => ({
        ok: false as const,
        error: {
          kind: "network_error" as const,
          message: error instanceof Error ? error.message : String(error),
        },
      }))
      if (!result.ok) {
        if (result.error.kind === "invalid_account") {
          const recovered = await recoverInvalidCodexAccount({
            store,
            invalidAccountName: name,
            setAuth: async (next) => {
              await inputDeps.client.auth.set(next)
            },
          })
          store.accounts = recovered.store.accounts
          store.active = recovered.store.active
          if (recovered.replacement) {
            const replacement = store.accounts[recovered.replacement]
            const weekRemaining = replacement?.snapshot?.usageWeek?.remaining ?? 0
            const fiveHourRemaining = replacement?.snapshot?.usage5h?.remaining ?? 0
            if (weekRemaining > 0 && fiveHourRemaining <= 0) {
              pendingRecoveryWarnings.set(recovered.replacement, {
                code: "week_recovery_only",
                removed: recovered.removed,
                replacement: recovered.replacement,
              })
            }
          }
          continue
        }

        store.accounts[name] = {
          ...entry,
          snapshot: {
            ...(entry.snapshot ?? {}),
            updatedAt: now(),
            error: result.error.message,
          },
        }
        continue
      }

      const nextName = ensureUniqueAccountName(store, pickName({
        accountId: result.status.identity.accountId,
        email: result.status.identity.email,
        fallback: name,
      }), name)
      const existing = store.accounts[nextName] ?? {}

      const nextEntry: CodexAccountEntry = {
        ...existing,
        ...entry,
        ...(result.authPatch?.refresh !== undefined ? { refresh: result.authPatch.refresh } : {}),
        ...(result.authPatch?.access !== undefined ? { access: result.authPatch.access } : {}),
        ...(result.authPatch?.expires !== undefined ? { expires: result.authPatch.expires } : {}),
        ...(result.authPatch?.accountId !== undefined ? { accountId: result.authPatch.accountId } : {}),
        name: nextName,
        providerId: "openai",
        workspaceName: (result.status.identity as { workspaceName?: string }).workspaceName ?? entry.workspaceName,
        accountId: result.status.identity.accountId ?? result.authPatch?.accountId ?? entry.accountId,
        email: result.status.identity.email ?? entry.email,
        snapshot: {
          ...(withoutRecoveryWarning(entry.snapshot) ?? {}),
          plan: result.status.identity.plan ?? entry.snapshot?.plan,
          usage5h: {
            entitlement: result.status.windows.primary.entitlement,
            remaining: result.status.windows.primary.remaining,
            used: result.status.windows.primary.used,
            resetAt: result.status.windows.primary.resetAt,
          },
          usageWeek: {
            entitlement: result.status.windows.secondary.entitlement,
            remaining: result.status.windows.secondary.remaining,
            used: result.status.windows.secondary.used,
            resetAt: result.status.windows.secondary.resetAt,
          },
          updatedAt: result.status.updatedAt,
          error: undefined,
        },
      }

      if (nextName !== name) delete store.accounts[name]
      store.accounts[nextName] = nextEntry
      store.lastSnapshotRefresh = result.status.updatedAt
      if (store.active === name || !store.active) store.active = nextName
    }

    for (const [name, entry] of Object.entries(store.accounts)) {
      const warning = pendingRecoveryWarnings.get(name)
      const snapshot = withoutRecoveryWarning(entry.snapshot)
      store.accounts[name] = {
        ...entry,
        ...(snapshot ? { snapshot } : {}),
      }
      if (!warning) continue
      const nextSnapshot = {
        ...(store.accounts[name].snapshot ?? {}),
      } as CodexAccountEntry["snapshot"] & { recoveryWarning?: RecoveryWarningMeta }
      nextSnapshot.recoveryWarning = warning
      store.accounts[name] = {
        ...store.accounts[name],
        snapshot: nextSnapshot,
      }
    }
  }

  return {
    key: "codex",
    loadStore,
    writeStore: persistStore,
    bootstrapAuthImport: async (store) => {
      if (store.bootstrapAuthImportTried === true) return false

      store.bootstrapAuthImportTried = true
      store.bootstrapAuthImportAt = now()

      const authEntries = await loadAuth().catch(() => ({} as Record<string, AccountEntry>))
      const openai = authEntries.openai
      if (openai && (openai.refresh || openai.access)) {
        const refresh = openai.refresh ?? openai.access
        const access = openai.access ?? openai.refresh
        const accountName = pickName({
          accountId: openai.accountId,
          email: openai.email,
          fallback: "openai",
        })
        store.accounts[accountName] = {
          ...(store.accounts[accountName] ?? {}),
          name: accountName,
          providerId: "openai",
          refresh,
          access,
          expires: openai.expires,
          accountId: openai.accountId,
          email: openai.email,
          source: "auth",
          addedAt: store.accounts[accountName]?.addedAt ?? now(),
        }
        if (!store.active) store.active = accountName
      }

      return true
    },
    authorizeNewAccount: async () => {
      const methods = await loadOfficialMethods()
      const browserMethod = pickOfficialOauthMethodByKind(methods, "browser")
      const headlessMethod = pickOfficialOauthMethodByKind(methods, "headless")

      const selectedKey = parseOfficialOauthSelection(await prompt("Choose Codex auth method (1/browser/b, 2/headless/h/device, Enter to cancel): "))
      if (selectedKey === "cancel" || !selectedKey) return undefined

      const selectedMethod = selectedKey === "browser" ? browserMethod : headlessMethod
      if (!selectedMethod || typeof selectedMethod.authorize !== "function") return undefined

      const pending = await selectedMethod.authorize()
      if (pending.method && pending.method !== "auto") {
        throw new Error(`Unsupported official Codex auth method: ${pending.method}`)
      }
      if (typeof pending.callback !== "function") return undefined
      if (pending.url) {
        console.log(`Go to: ${pending.url}`)
      }
      if (pending.instructions) {
        console.log(pending.instructions)
      }

      const result = await pending.callback()
      if (result.type !== "success" || (!result.refresh && !result.access)) return undefined

      const refresh = result.refresh ?? result.access
      const access = result.access ?? result.refresh
      await inputDeps.client.auth.set({
        path: { id: "openai" },
        body: {
          type: "oauth",
          refresh,
          access,
          expires: result.expires,
          accountId: result.accountId,
        },
      })

      return {
        name: pickName({
          accountId: result.accountId,
          fallback: `openai-${now()}`,
        }),
        providerId: "openai",
        refresh,
        access,
        expires: result.expires,
        accountId: result.accountId,
        source: "manual",
        addedAt: now(),
      }
    },
    refreshSnapshots,
    toMenuInfo: async (store) => {
      return Object.entries(store.accounts).map(([name, entry], index) => ({
        id: entry.accountId ?? name,
        name: entry.email ?? entry.accountId ?? name,
        workspaceName: entry.workspaceName,
        index,
        isCurrent: store.active === name,
        source: entry.source,
        plan: entry.snapshot?.plan,
        quota: toMenuQuota(entry),
        addedAt: entry.addedAt,
        lastUsed: entry.lastUsed,
      })) as ReturnType<ProviderMenuAdapter<CodexStoreFile, CodexAccountEntry>["toMenuInfo"]> extends Promise<infer T>
        ? T
        : never
    },
    getCurrentEntry: (store) => getActiveCodexAccount(store)?.entry,
    getRefreshConfig: (store) => ({ enabled: store.autoRefresh === true, minutes: store.refreshMinutes ?? 15 }),
    getAccountByName: (store, name) => {
      const direct = store.accounts[name]
      if (direct) return { name, entry: direct }
      const match = Object.entries(store.accounts).find(([, entry]) => entry.accountId === name)
      if (!match) return undefined
      return { name: match[0], entry: match[1] }
    },
    addAccount: (store, entry) => {
      const name = entry.name ?? pickName({ accountId: entry.accountId, email: entry.email, fallback: "openai" })
      store.accounts[name] = {
        ...entry,
        name,
      }
      store.active = store.active ?? name
      return true
    },
    removeAccount: (store, name) => {
      const resolved = store.accounts[name]
        ? name
        : Object.entries(store.accounts).find(([, entry]) => entry.accountId === name)?.[0]
      if (!resolved) return false
      delete store.accounts[resolved]
      if (store.active === resolved) store.active = Object.keys(store.accounts)[0]
      return true
    },
    removeAllAccounts: (store) => {
      if (Object.keys(store.accounts).length === 0) return false
      store.accounts = {}
      store.active = undefined
      return true
    },
    switchAccount: async (store, name, entry) => {
      await inputDeps.client.auth.set({
        path: { id: "openai" },
        body: {
          type: "oauth",
          refresh: entry.refresh,
          access: entry.access,
          expires: entry.expires,
          accountId: entry.accountId,
        },
      })
      store.active = name
      store.accounts[name] = {
        ...entry,
        name,
        providerId: "openai",
        lastUsed: now(),
      }
    },
    applyAction: async (store, action) => {
      if (action.name === "refresh-snapshot") {
        await refreshSnapshots(store)
        return true
      }
      if (action.name === "toggle-refresh") {
        store.autoRefresh = store.autoRefresh !== true
        store.refreshMinutes = store.refreshMinutes ?? 15
        return true
      }
      if (action.name === "set-interval") {
        const raw = await prompt("Refresh interval (minutes): ")
        if (!raw) return false
        const value = Number(raw)
        if (!Number.isFinite(value)) return false
        store.refreshMinutes = Math.max(1, Math.min(180, value))
        return true
      }
      if (
        action.name === "toggle-experimental-slash-commands"
        || action.name === "toggle-network-retry"
        || action.name === "toggle-wechat-notifications"
        || action.name === "toggle-wechat-question-notify"
        || action.name === "toggle-wechat-permission-notify"
        || action.name === "toggle-wechat-session-error-notify"
      ) {
        await applyCommonSettingsAction({
          action: { type: action.name },
          readSettings: readCommonSettings,
          writeSettings: writeCommonSettings,
        })
        return false
      }
      if (action.name === "wechat-bind" || action.name === "wechat-rebind") {
        const { runWechatBindFlow } = await import("../wechat/bind-flow.js")
        await runWechatBindFlow({
          action: action.name,
          readCommonSettings,
          writeCommonSettings,
        })
        return false
      }
      if (action.name === "wechat-export-debug-bundle") {
        const flowInput = getWechatDebugBundleFlowInput(action.payload)
        if (!flowInput) return false
        const {
          runWechatDebugBundleFlow,
          toWechatDebugBundleFailureResult,
        } = await import("../wechat/debug-bundle-flow.js")
        try {
          const result = await runWechatDebugBundleFlow(flowInput)
          await inputDeps.client.tui?.showToast?.({
            body: {
              message: result.message,
              variant: "success",
            },
          }).catch(() => {})
          const handled: ProviderActionResult = {
            handled: true,
            result,
          }
          return handled
        } catch (error) {
          const result = toWechatDebugBundleFailureResult(error, { mode: flowInput.mode })
          await inputDeps.client.tui?.showToast?.({
            body: {
              message: result.message,
              variant: "warning",
            },
          }).catch(() => {})
          return {
            handled: true,
            result,
          }
        }
      }
      return false
    },
  }
}
