import type { Plugin } from "@opencode-ai/plugin"
import { appendFile } from "node:fs/promises"
import { normalizeDomain } from "./copilot-api-helpers.js"
import {
  listAssignableAccountsForModel,
  listKnownCopilotModels,
  rewriteModelAccountAssignments,
} from "./model-account-map.js"
import {
  runProviderMenu,
  type MenuAction as RuntimeMenuAction,
  type ProviderActionOutput,
} from "./menu-runtime.js"
import { persistAccountSwitch } from "./plugin-actions.js"
import { buildPluginHooks, isBridgeCapableBrokerOwnerInput } from "./plugin-hooks.js"
import {
  readCommonSettingsStore,
  readCommonSettingsStoreSync,
  writeCommonSettingsStore,
  type CommonSettingsStore,
} from "./common-settings-store.js"
import { connectOrSpawnBroker } from "./wechat/broker-launcher.js"
import { brokerStartupDiagnosticsPath, ensureWechatStateLayout } from "./wechat/state-paths.js"
import { createCodexMenuAdapter } from "./providers/codex-menu-adapter.js"
import { createCopilotMenuAdapter } from "./providers/copilot-menu-adapter.js"
import { createProviderRegistry } from "./providers/registry.js"
import { loadOfficialCodexAuthMethods } from "./upstream/codex-loader-adapter.js"
import { isTTY } from "./ui/ansi.js"
import { showMenu, type AccountInfo, type MenuAction as UiMenuAction } from "./ui/menu.js"
import { select, selectMany } from "./ui/select.js"
import { readAuth, readStore, writeStore, type AccountEntry, type StoreFile, type StoreWriteDebugMeta } from "./store.js"

function now() {
  return Date.now()
}

type WechatBrokerConnection = {
  endpoint: string
}

let brokerEnsurePromiseInProcess: Promise<WechatBrokerConnection> | undefined
let brokerEnsureSucceededInProcess = false

function toWechatBrokerConnection(value: unknown): WechatBrokerConnection {
  if (typeof value === "object" && value !== null && typeof (value as { endpoint?: unknown }).endpoint === "string") {
    return {
      endpoint: (value as { endpoint: string }).endpoint,
    }
  }
  throw new Error("Wechat broker 启动结果缺少 endpoint")
}

function formatBrokerStartupError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function recordBrokerStartupFailure(input: {
  provider: "github-copilot" | "openai"
  diagnosticsPath: string
  error: unknown
  showToast?: (options: { body: { message: string; variant: "warning" } }) => Promise<unknown>
}) {
  const reason = formatBrokerStartupError(input.error)
  const line = JSON.stringify({
    at: new Date().toISOString(),
    provider: input.provider,
    reason,
  })

  try {
    await ensureWechatStateLayout()
    await appendFile(input.diagnosticsPath, `${line}\n`, "utf8")
  } catch {
  }

  try {
    await input.showToast?.({
      body: {
        message: `Wechat broker 启动失败，已写入诊断文件：${input.diagnosticsPath}`,
        variant: "warning",
      },
    })
  } catch {
  }
}

function toSharedRuntimeAction(action: UiMenuAction): RuntimeMenuAction | undefined {
  if (action.type === "cancel") return { type: "cancel" }
  if (action.type === "add") return { type: "add" }
  if (action.type === "remove-all") return { type: "remove-all" }
  if (action.type === "switch") return { type: "switch", account: action.account }
  if (action.type === "remove") return { type: "remove", account: action.account }
  if (action.type === "toggle-loop-safety") return { type: "provider", name: "toggle-loop-safety" }
  if (action.type === "toggle-loop-safety-provider-scope") return { type: "provider", name: "toggle-loop-safety-provider-scope" }
  if (action.type === "toggle-experimental-slash-commands") return { type: "provider", name: "toggle-experimental-slash-commands" }
  if (action.type === "toggle-network-retry") return { type: "provider", name: "toggle-network-retry" }
  if (action.type === "toggle-wechat-notifications") return { type: "provider", name: "toggle-wechat-notifications" }
  if (action.type === "toggle-wechat-question-notify") return { type: "provider", name: "toggle-wechat-question-notify" }
  if (action.type === "toggle-wechat-permission-notify") return { type: "provider", name: "toggle-wechat-permission-notify" }
  if (action.type === "toggle-wechat-session-error-notify") return { type: "provider", name: "toggle-wechat-session-error-notify" }
  if (action.type === "wechat-bind") return { type: "provider", name: "wechat-bind" }
  if (action.type === "wechat-rebind") return { type: "provider", name: "wechat-rebind" }
  if (action.type === "wechat-export-debug-bundle") return { type: "provider", name: "wechat-export-debug-bundle", payload: { mode: action.mode } }
  return undefined
}

type WechatDebugBundleProviderSuccessResult = {
  mode: "sanitized" | "full"
  bundlePath: string
  message: string
}

type WechatDebugBundleProviderFailureResult = {
  ok: false
  mode: "sanitized" | "full"
  code: string
  message: string
  archivePath?: string
  details?: Record<string, unknown>
}

function isWechatDebugBundleProviderSuccessResult(value: unknown): value is WechatDebugBundleProviderSuccessResult {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as {
    mode?: unknown
    bundlePath?: unknown
    message?: unknown
  }
  return (candidate.mode === "sanitized" || candidate.mode === "full")
    && typeof candidate.bundlePath === "string"
    && typeof candidate.message === "string"
}

function isWechatDebugBundleProviderFailureResult(value: unknown): value is WechatDebugBundleProviderFailureResult {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as {
    ok?: unknown
    mode?: unknown
    code?: unknown
    message?: unknown
    archivePath?: unknown
    details?: unknown
  }
  return candidate.ok === false
    && (candidate.mode === "sanitized" || candidate.mode === "full")
    && typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && (candidate.archivePath === undefined || typeof candidate.archivePath === "string")
    && (candidate.details === undefined || typeof candidate.details === "object")
}

function handleProviderActionResult(output: ProviderActionOutput) {
  if (output.name !== "wechat-export-debug-bundle") return
  const result = output.result
  if (isWechatDebugBundleProviderSuccessResult(result)) {
    console.log(JSON.stringify({
      type: "wechat-export-debug-bundle",
      ok: true,
      mode: result.mode,
      bundlePath: result.bundlePath,
      message: result.message,
    }))
    return
  }
  if (!isWechatDebugBundleProviderFailureResult(result)) return
  console.log(JSON.stringify({
    type: "wechat-export-debug-bundle",
    ok: false,
    mode: result.mode,
    code: result.code,
    message: result.message,
    ...(typeof result.archivePath === "string" ? { archivePath: result.archivePath } : {}),
    ...(result.details && typeof result.details === "object" ? { details: result.details } : {}),
  }))
}
export async function configureDefaultAccountGroup(
  store: StoreFile,
  selectors?: {
    selectAccounts?: (options: Array<{ label: string; value: string; hint?: string }>) => Promise<string[] | null>
  },
) {
  const accountEntries = Object.entries(store.accounts)
  if (accountEntries.length === 0) {
    console.log("No accounts available yet.")
    return false
  }

  const options = accountEntries
    .map(([name, entry]) => ({
      label: name,
      value: name,
      hint: entry.enterpriseUrl ? normalizeDomain(entry.enterpriseUrl) : "github.com",
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const defaultSelectedNames = new Set(store.activeAccountNames ?? (store.active ? [store.active] : []))
  const selected = selectors?.selectAccounts
    ? await selectors.selectAccounts(options)
    : await selectMany(
        options.map((item) => ({ label: item.label, value: item.value, hint: item.hint })),
        {
          message: "Default account group",
          subtitle: "Pick accounts for model fallback routing",
          clearScreen: true,
          autoSelectSingle: false,
          minSelected: 1,
          initialSelected: options
            .map((item, index) => (defaultSelectedNames.has(item.value) ? index : -1))
            .filter((index) => index >= 0),
        },
      )

  if (!selected || selected.length === 0) return false

  const next = [...new Set(selected)]
    .filter((name) => Boolean(store.accounts[name]))
    .sort((a, b) => a.localeCompare(b))
  if (next.length === 0) return false

  store.activeAccountNames = next
  return true
}

export function clearAllAccounts(store: StoreFile) {
  store.accounts = {}
  store.active = undefined
  delete store.activeAccountNames
  delete store.modelAccountAssignments
}

export function removeAccountFromStore(store: StoreFile, name: string) {
  rewriteModelAccountAssignments(store, { [name]: undefined })
  delete store.accounts[name]

  if (Array.isArray(store.activeAccountNames)) {
    store.activeAccountNames = store.activeAccountNames.filter((item) => item !== name)
    if (store.activeAccountNames.length === 0) {
      delete store.activeAccountNames
    }
  }

  if (store.active !== name) return

  const fromDefaultGroup = (store.activeAccountNames ?? []).find((accountName) => Boolean(store.accounts[accountName]))
  if (fromDefaultGroup) {
    store.active = fromDefaultGroup
    return
  }

  const remaining = Object.keys(store.accounts).sort((a, b) => a.localeCompare(b))
  store.active = remaining[0]
}

export async function configureModelAccountAssignments(
  store: StoreFile,
  selectors?: {
    selectModel?: (options: Array<{ label: string; value: string; hint?: string }>) => Promise<string | null>
    selectAccounts?: (options: Array<{ label: string; value: string; hint?: string }>) => Promise<string[] | null>
  },
) {
  return configureModelAccountAssignmentsWithSelection(store, selectors)
}

async function configureModelAccountAssignmentsWithSelection(
  store: StoreFile,
  selectors?: {
    selectModel?: (options: Array<{ label: string; value: string; hint?: string }>) => Promise<string | null>
    selectAccounts?: (options: Array<{ label: string; value: string; hint?: string }>) => Promise<string[] | null>
  },
) {
  const models = listKnownCopilotModels(store)
  if (models.length === 0) {
    console.log("No Copilot models available yet. Run Check models first.")
    return false
  }

  const fallbackGroupNames = (store.activeAccountNames ?? [])
    .map((name) => store.accounts[name]?.name ?? name)
    .filter((name) => typeof name === "string" && name.length > 0)
  const fallbackLabel = fallbackGroupNames.length > 0
    ? fallbackGroupNames.join(", ")
    : (store.active ? store.accounts[store.active]?.name ?? store.active : "none")
  const modelOptions = models.map((model) => ({
    label: model,
    value: model,
    hint: store.modelAccountAssignments?.[model]?.length
      ? `group: ${(store.modelAccountAssignments[model] ?? []).join(", ")}`
      : `fallbacks to ${fallbackLabel}`,
  }))

  const modelID = selectors?.selectModel
    ? await selectors.selectModel(modelOptions)
    : await select(
        [
          { label: "Back", value: "" },
          ...modelOptions,
        ],
        {
          message: "Choose a Copilot model",
          subtitle: "Select which model should use a dedicated account group",
          clearScreen: true,
          autoSelectSingle: false,
        },
      )
  if (!modelID) return false

  const options = listAssignableAccountsForModel(store, modelID)
  if (options.length === 0) {
    console.log(`No account currently exposes model ${modelID}. Run Check models first.`)
    return false
  }

  const accountOptions = options.map((item) => ({
    label: item.name,
    value: item.name,
    hint: item.entry.enterpriseUrl ? normalizeDomain(item.entry.enterpriseUrl) : "github.com",
  }))

  const selected = selectors?.selectAccounts
    ? await selectors.selectAccounts(accountOptions)
    : await selectMany(accountOptions, {
        message: modelID,
        subtitle: "Pick account group for this model (empty means fallback)",
        clearScreen: true,
        autoSelectSingle: false,
        initialSelected: accountOptions
          .map((item, index) => (store.modelAccountAssignments?.[modelID]?.includes(item.value) ? index : -1))
          .filter((index) => index >= 0),
      })

  if (selected === null) return false

  if (selected.length === 0) {
    delete store.modelAccountAssignments?.[modelID]
    if (store.modelAccountAssignments && Object.keys(store.modelAccountAssignments).length === 0) {
      delete store.modelAccountAssignments
    }
    return true
  }

  const assigned = [...new Set(selected)]
    .filter((name) => Boolean(store.accounts[name]))
    .sort((a, b) => a.localeCompare(b))
  if (assigned.length === 0) return false

  store.modelAccountAssignments = {
    ...(store.modelAccountAssignments ?? {}),
    [modelID]: assigned,
  }
  return true
}

export async function activateAddedAccount(input: {
  store: StoreFile
  name: string
  switchAccount: () => Promise<void>
  writeStore: (store: StoreFile, meta?: StoreWriteDebugMeta) => Promise<void>
  now?: () => number
}) {
  await input.writeStore(input.store, {
    reason: "activate-added-account",
    source: "activateAddedAccount",
    actionType: "add",
  })
  await input.switchAccount()
  await persistAccountSwitch({
    store: input.store,
    name: input.name,
    at: (input.now ?? now)(),
    writeStore: input.writeStore,
  })
}

async function createAccountSwitcherPlugin(
  input: Parameters<Plugin>[0],
  provider: "github-copilot" | "openai",
) {
  const client = input.client
  const directory = input.directory
  const serverUrl = (input as { serverUrl?: URL }).serverUrl
  const ensureWechatBrokerStarted = (input as {
    ensureWechatBrokerStarted?: () => Promise<unknown>
  }).ensureWechatBrokerStarted ?? (async () => connectOrSpawnBroker())
  const createWechatBridgeLifecycleImpl = (input as {
    createWechatBridgeLifecycleImpl?: Parameters<typeof buildPluginHooks>[0]["createWechatBridgeLifecycleImpl"]
  }).createWechatBridgeLifecycleImpl
  const diagnosticsPath = brokerStartupDiagnosticsPath()
  const showToast = (input as {
    client?: {
      tui?: {
        showToast?: (options: { body: { message: string; variant: "warning" } }) => Promise<unknown>
      }
    }
  }).client?.tui?.showToast
  const isBridgeCapable = isBridgeCapableBrokerOwnerInput({ client, serverUrl })
  let initialWechatBrokerPromise: Promise<WechatBrokerConnection> | undefined
  if (isBridgeCapable && !brokerEnsureSucceededInProcess) {
    if (!brokerEnsurePromiseInProcess) {
      const brokerEnsurePromise = Promise.resolve()
        .then(() => ensureWechatBrokerStarted())
        .then((result) => toWechatBrokerConnection(result))
        .then((result) => {
          brokerEnsureSucceededInProcess = true
          return result
        })
      brokerEnsurePromiseInProcess = brokerEnsurePromise

      void brokerEnsurePromise
        .catch((error) => recordBrokerStartupFailure({
          provider,
          diagnosticsPath,
          error,
          showToast,
        }))
        .finally(() => {
          if (brokerEnsurePromiseInProcess === brokerEnsurePromise) {
            brokerEnsurePromiseInProcess = undefined
          }
        })
    }

    initialWechatBrokerPromise = brokerEnsurePromiseInProcess
  }
  const persistStore = (store: StoreFile, meta?: StoreWriteDebugMeta) => writeStore(store, { debug: meta })
  const codexClient = {
    auth: {
      set: async (options: {
        path: { id: string }
        body: {
          type: "oauth"
          refresh?: string
          access?: string
          expires?: number
          accountId?: string
        }
      }) => client.auth.set({
        path: options.path,
        body: {
          type: "oauth",
          refresh: options.body.refresh ?? options.body.access ?? "",
          access: options.body.access ?? options.body.refresh ?? "",
          expires: options.body.expires ?? 0,
          ...(options.body.accountId ? { accountId: options.body.accountId } : {}),
        },
      }),
    },
  }
  const copilotMethods = [
    {
      type: "oauth" as const,
      label: "Manage GitHub Copilot accounts",
      async authorize() {
        const entry = await runMenu()
        return {
          url: "",
          instructions: "",
          method: "auto" as const,
          async callback() {
            if (!entry) return { type: "failed" as const }
            return {
              type: "success" as const,
              provider: entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot",
              refresh: entry.refresh,
              access: entry.access,
              expires: entry.expires,
              ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
            }
          },
        }
      },
    },
  ]

  const codexMethods = [
    {
      type: "oauth" as const,
      label: "Manage OpenAI Codex accounts",
      async authorize() {
        const entry = await runCodexMenu()
        return {
          url: "",
          instructions: "",
          method: "auto" as const,
          async callback() {
            if (!entry) return { type: "failed" as const }
            return {
              type: "success" as const,
              provider: "openai",
              refresh: entry.refresh ?? "",
              access: entry.access ?? entry.refresh ?? "",
              expires: entry.expires ?? 0,
              ...(entry.accountId ? { accountId: entry.accountId } : {}),
            }
          },
        }
      },
    },
  ]

  async function runMenu(): Promise<AccountEntry | undefined> {
    if (!isTTY()) {
      console.log("Interactive menu requires a TTY terminal")
      return
    }
    const adapter = createCopilotMenuAdapter({
      client,
      readStore,
      writeStore: persistStore,
      readAuth,
      now,
      configureDefaultAccountGroup,
      configureModelAccountAssignments,
      clearAllAccounts,
      removeAccountFromStore,
      activateAddedAccount,
      logSwitchHint: () => {
        console.log("Switched account. If a later Copilot session hits input[*].id too long after switching, enable Copilot Network Retry from the menu.")
      },
      readCommonSettings: readCommonSettingsStore,
      writeCommonSettings: async (settings) => {
        await writeCommonSettingsStore(settings)
      },
    })

    const toRuntimeAction = async (accounts: AccountInfo[], store: StoreFile): Promise<RuntimeMenuAction> => {
      const common = await readCommonSettingsStore().catch(() => undefined)
      const action = await showMenu(accounts, {
        provider: "copilot",
        refresh: { enabled: store.autoRefresh === true, minutes: store.refreshMinutes ?? 15 },
        lastQuotaRefresh: store.lastQuotaRefresh,
        modelAccountAssignmentCount: Object.keys(store.modelAccountAssignments ?? {}).length,
        defaultAccountGroupCount: store.activeAccountNames?.length ?? (store.active ? 1 : 0),
        loopSafetyEnabled: common?.loopSafetyEnabled ?? store.loopSafetyEnabled === true,
        loopSafetyProviderScope: common?.loopSafetyProviderScope ?? store.loopSafetyProviderScope,
        experimentalSlashCommandsEnabled: common?.experimentalSlashCommandsEnabled ?? store.experimentalSlashCommandsEnabled,
        networkRetryEnabled: common?.networkRetryEnabled ?? store.networkRetryEnabled === true,
        syntheticAgentInitiatorEnabled: store.syntheticAgentInitiatorEnabled === true,
      })

      const shared = toSharedRuntimeAction(action)
      if (shared) return shared
      if (action.type === "import") return { type: "provider", name: "import-auth" }
      if (action.type === "refresh-identity") return { type: "provider", name: "refresh-identity" }
      if (action.type === "toggle-refresh") return { type: "provider", name: "toggle-refresh" }
      if (action.type === "set-interval") return { type: "provider", name: "set-interval" }
      if (action.type === "quota") return { type: "provider", name: "quota-refresh" }
      if (action.type === "check-models") return { type: "provider", name: "check-models" }
      if (action.type === "configure-default-group") return { type: "provider", name: "configure-default-group" }
      if (action.type === "assign-models") return { type: "provider", name: "assign-models" }
      if (action.type === "toggle-synthetic-agent-initiator") return { type: "provider", name: "toggle-synthetic-agent-initiator" }
      return { type: "cancel" }
    }

    return runProviderMenu({
      adapter,
      showMenu: toRuntimeAction,
      onProviderActionResult: handleProviderActionResult,
      now,
    })
  }

  async function runCodexMenu() {
    if (!isTTY()) {
      console.log("Interactive menu requires a TTY terminal")
      return
    }

    const adapter = createCodexMenuAdapter({
      client: codexClient,
      loadOfficialCodexAuthMethods: () => loadOfficialCodexAuthMethods({
        client: {
          auth: {
            set: async (value) => client.auth.set(value as Parameters<typeof client.auth.set>[0]),
          },
        },
      }),
      readCommonSettings: readCommonSettingsStore,
      writeCommonSettings: async (settings) => {
        await writeCommonSettingsStore(settings)
      },
    })

    const toRuntimeAction = async (accounts: AccountInfo[], store: Awaited<ReturnType<typeof adapter.loadStore>>): Promise<RuntimeMenuAction> => {
      const common: CommonSettingsStore | undefined = await readCommonSettingsStore().catch(() => undefined)
      const action = await showMenu(accounts, {
        provider: "codex",
        refresh: { enabled: store.autoRefresh === true, minutes: store.refreshMinutes ?? 15 },
        loopSafetyEnabled: common?.loopSafetyEnabled ?? true,
        loopSafetyProviderScope: common?.loopSafetyProviderScope,
        experimentalSlashCommandsEnabled: common?.experimentalSlashCommandsEnabled,
        networkRetryEnabled: common?.networkRetryEnabled === true,
      })

      const shared = toSharedRuntimeAction(action)
      if (shared) return shared
      if (action.type === "quota") return { type: "provider", name: "refresh-snapshot" }
      if (action.type === "toggle-refresh") return { type: "provider", name: "toggle-refresh" }
      if (action.type === "set-interval") return { type: "provider", name: "set-interval" }
      return { type: "cancel" }
    }

    return runProviderMenu({
      adapter,
      showMenu: toRuntimeAction,
      onProviderActionResult: handleProviderActionResult,
      now,
    })
  }

  const registry = createProviderRegistry({
    buildPluginHooks,
  })
  const assembled = provider === "github-copilot" ? registry.copilot.descriptor : registry.codex.descriptor

  return assembled.buildPluginHooks({
    auth: {
      provider,
      methods: provider === "github-copilot" ? copilotMethods : codexMethods,
    },
    client,
    directory,
    serverUrl,
    ensureWechatBrokerStarted: async () => {},
    initialWechatBrokerPromise,
    ...(createWechatBridgeLifecycleImpl ? { createWechatBridgeLifecycleImpl } : {}),
    loadCommonSettings: readCommonSettingsStore,
    loadCommonSettingsSync: readCommonSettingsStoreSync,
  })
}

export const CopilotAccountSwitcher: Plugin = async (input) => {
  return createAccountSwitcherPlugin(input, "github-copilot")
}

export const OpenAICodexAccountSwitcher: Plugin = async (input) => {
  return createAccountSwitcherPlugin(input, "openai")
}
