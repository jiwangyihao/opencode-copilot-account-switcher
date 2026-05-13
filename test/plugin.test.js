import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { ACCOUNT_SWITCH_TTL_MS } from "../dist/copilot-retry-notifier.js"
import { applyMenuAction } from "../dist/plugin-actions.js"
import { buildPluginHooks as buildPluginHooksRaw } from "../dist/plugin-hooks.js"
import { COPILOT_PROVIDER_DESCRIPTOR } from "../dist/providers/descriptor.js"
import { getProviderDescriptorByKey, getProviderDescriptorByProviderID, listProviderDescriptors } from "../dist/providers/registry.js"
import { buildCandidateAccountLoads } from "../dist/routing-state.js"

const execFileAsync = promisify(execFile)

function createTempRoutingStateDirectory() {
  return join(tmpdir(), `routing-state-${randomUUID()}`)
}

function buildPluginHooks(input = {}) {
  return buildPluginHooksRaw({
    ...input,
    routingStateDirectory: input.routingStateDirectory ?? createTempRoutingStateDirectory(),
  })
}

const upstreamAiDistPath = join(
  process.cwd(),
  "..",
  "opencode",
  "packages",
  "opencode",
  "node_modules",
  "ai",
  "dist",
  "index.mjs",
)

const upstreamProviderUtilsDistPath = join(
  process.cwd(),
  "..",
  "opencode",
  "packages",
  "opencode",
  "node_modules",
  "@ai-sdk",
  "provider-utils",
  "dist",
  "index.js",
)


async function waitForCondition(predicate, timeoutMs = 800) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await delay(10)
  }
  assert.equal(await predicate(), true)
}

test("waitForCondition 会等待异步谓词真正满足", async () => {
  let ready = false
  setTimeout(() => {
    ready = true
  }, 30)

  await waitForCondition(async () => ready, 5000)

  assert.equal(ready, true)
})

function createBridgeCapablePluginClient(extra = {}) {
  const base = {
    auth: {
      set: async () => {},
    },
    session: {
      list: async () => [],
      status: async () => ({ data: {} }),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [],
    },
    permission: {
      list: async () => [],
    },
  }

  return {
    ...base,
    ...extra,
    auth: {
      ...base.auth,
      ...(extra.auth ?? {}),
    },
    session: {
      ...base.session,
      ...(extra.session ?? {}),
    },
    question: {
      ...base.question,
      ...(extra.question ?? {}),
    },
    permission: {
      ...base.permission,
      ...(extra.permission ?? {}),
    },
  }
}

test("plugin exposes auth and chat headers without Loop Safety hooks", () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({ accounts: {} }),
  })

  assert.equal(plugin.auth?.provider, "github-copilot")
  assert.equal(typeof plugin.auth?.loader, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(Object.hasOwn(plugin, "experimental.chat.system.transform"), false)
})

test("copilot package no longer owns Loop Safety hooks", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {} }),
    client: {},
  })

  assert.equal(Object.hasOwn(plugin, "experimental.chat.system.transform"), false)
  assert.equal(Object.hasOwn(plugin, "experimental.session.compacting"), false)
})

test("copilot package leaves question definition untouched", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {} }),
    client: {},
  })

  const output = { description: "original question", parameters: {}, extra: "keep" }
  await plugin["tool.definition"]?.({ toolID: "question" }, output)

  assert.deepEqual(output, { description: "original question", parameters: {}, extra: "keep" })
})

test("copilot slash commands exclude old Loop Safety commands", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({ accounts: {}, experimentalSlashCommandsEnabled: true }),
    loadStore: async () => ({ accounts: {}, experimentalSlashCommandsEnabled: true }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-status"), true)
  assert.equal(Object.hasOwn(config.command, "copilot-compact"), true)
  assert.equal(Object.hasOwn(config.command, "copilot-stop-tool"), true)
})

test("status slash command is injected when experiment is enabled", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
    }),
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(typeof config.command["copilot-status"], "object")
  assert.match(config.command["copilot-status"].template, /quota|Copilot|status/i)
  assert.match(config.command["copilot-status"].description, /Copilot|status/i)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("session control slash commands are injected when experiment is enabled", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
    }),
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(typeof config.command["copilot-compact"], "object")
  assert.equal(typeof config.command["copilot-stop-tool"], "object")
  assert.equal(typeof config.command["copilot-compact"].description, "string")
  assert.equal(config.command["copilot-compact"].description.length > 0, true)
  assert.equal(typeof config.command["copilot-stop-tool"].description, "string")
  assert.equal(config.command["copilot-stop-tool"].description.length > 0, true)
  assert.equal(typeof config.command["copilot-stop-tool"].template, "string")
  assert.equal(config.command["copilot-stop-tool"].template.length > 0, true)
  assert.match(config.command["copilot-stop-tool"].template, /interrupt.*tool flow|tool flow.*interrupt|annotate.*interrupted|synthetic continue/i)
  assert.match(config.command["copilot-stop-tool"].description, /interrupt.*tool flow|annotate.*interrupted|synthetic continue/i)
  assert.doesNotMatch(config.command["copilot-stop-tool"].template, /single|exactly one|仅.*一个|唯一/i)
  assert.doesNotMatch(config.command["copilot-stop-tool"].description, /single|exactly one|仅.*一个|唯一/i)
})

test("experimental slash commands are not injected when unified switch is disabled", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: false,
    }),
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "copilot-status"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("slash commands are injected immediately without waiting for async store load", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: () => new Promise(() => {}),
    loadStoreSync: () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
    }),
  })

  const config = { command: {} }
  plugin.config?.(config)

  assert.equal(typeof config.command["copilot-status"], "object")
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("disabled experimental slash switch is decided from sync store path without waiting for async store load", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: () => new Promise(() => {}),
    loadStoreSync: () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = { command: {} }
  plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "copilot-status"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("tool registry keeps notify and wait outside the Copilot package", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {} }),
    client: {},
  })

  assert.deepEqual(Object.keys(plugin.tool ?? {}).sort(), [])
})

test("status command hook ignores unrelated commands", async () => {
  const calls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
  })

  assert.equal(typeof plugin["command.execute.before"], "function")

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "review", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))

  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test("status command hook delegates to status command handler", async () => {
  const calls = []
  const writes = []
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      active: "alice",
      accounts: {
        alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
      },
      experimentalSlashCommandsEnabled: true,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
    handleStatusCommandImpl: async (input) => {
      delegated.push({
        loadStore: typeof input.loadStore,
        writeStore: typeof input.writeStore,
        refreshQuota: typeof input.refreshQuota,
      })
      throw new Error("delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /delegated/,
  )

  assert.equal(delegated.length, 1)
  assert.equal(delegated[0]?.loadStore, "function")
  assert.equal(delegated[0]?.writeStore, "function")
  assert.equal(delegated[0]?.refreshQuota, "function")
  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test("session control command hooks delegate to injected handlers", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    handleCompactCommandImpl: async (input) => {
      delegated.push({
        command: "compact",
        sessionID: input.sessionID,
        client: typeof input.client,
      })
      throw new Error("compact delegated")
    },
    handleStopToolCommandImpl: async (input) => {
      delegated.push({
        command: "stop-tool",
        sessionID: input.sessionID,
        client: typeof input.client,
        syntheticAgentInitiatorEnabled: input.syntheticAgentInitiatorEnabled,
      })
      throw new Error("stop-tool delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-compact", sessionID: "s-compact", arguments: "" },
      { parts: [] },
    ),
    /compact delegated/,
  )

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-stop-tool", sessionID: "s-stop", arguments: "" },
      { parts: [] },
    ),
    /stop-tool delegated/,
  )

  assert.deepEqual(delegated, [
    { command: "compact", sessionID: "s-compact", client: "object" },
    {
      command: "stop-tool",
      sessionID: "s-stop",
      client: "object",
      syntheticAgentInitiatorEnabled: true,
    },
  ])
})

test("stop-tool command forwards synthetic switch as strict boolean", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: 1,
    }),
    handleStopToolCommandImpl: async (input) => {
      delegated.push(input.syntheticAgentInitiatorEnabled)
      throw new Error("stop-tool delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-stop-tool", sessionID: "s-stop", arguments: "" },
      { parts: [] },
    ),
    /stop-tool delegated/,
  )

  assert.deepEqual(delegated, [false])
})

test("status command hook still delegates when hook-level loadStore precheck fails", async () => {
  const delegated = []
  let refreshCount = 0
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => {
      throw new Error("store read failed")
    },
    handleStatusCommandImpl: async (input) => {
      delegated.push({
        loadStore: typeof input.loadStore,
        refreshQuota: typeof input.refreshQuota,
      })
      throw new Error("delegated")
    },
    refreshQuota: async () => {
      refreshCount += 1
      return { type: "missing-active" }
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /delegated/,
  )

  assert.equal(delegated.length, 1)
  assert.equal(delegated[0]?.loadStore, "function")
  assert.equal(delegated[0]?.refreshQuota, "function")
  assert.equal(refreshCount, 0)
})

test("status command hook does nothing when unified slash switch is disabled", async () => {
  const calls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      active: "alice",
      accounts: {
        alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
      },
      experimentalSlashCommandsEnabled: false,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
    handleStatusCommandImpl: async () => {
      throw new Error("should not delegate")
    },
  })

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "copilot-status", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))

  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test("plugin source does not preload upstream hook bundle for untouched hooks", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /loadOfficialCopilotHooks/)
})

test("plugin source does not reference legacy codex-oauth artifact", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /codex-oauth/)
})

test("source tree no longer keeps local codex oauth implementation", () => {
  const exists = existsSync(new URL("../src/codex-oauth.ts", import.meta.url))

  assert.equal(exists, false)
})

test("root Copilot package has no Codex runtime artifacts after build", () => {
  const codexArtifacts = [
    "../src/codex-auth-source.ts",
    "../src/codex-store.ts",
    "../src/codex-status-fetcher.ts",
    "../src/codex-status-command.ts",
    "../src/codex-invalid-account.ts",
    "../src/codex-network-retry.ts",
    "../src/retry/codex-policy.ts",
    "../src/providers/codex-menu-adapter.ts",
    "../src/upstream/codex-loader-adapter.ts",
    "../src/upstream/codex-plugin.snapshot.ts",
    "../scripts/sync-codex-upstream.mjs",
    "../dist/codex-store.js",
    "../dist/codex-status-command.js",
    "../dist/providers/codex-menu-adapter.js",
    "../dist/upstream/codex-plugin.snapshot.js",
  ]

  for (const relative of codexArtifacts) {
    assert.equal(existsSync(new URL(relative, import.meta.url)), false, relative)
  }
})

test("root public entries do not export OpenAICodexAccountSwitcher", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")

  assert.equal("OpenAICodexAccountSwitcher" in indexExports, false)
  assert.equal("OpenAICodexAccountSwitcher" in pluginExports, false)
})

test("copilot package has no stale notify-tool artifacts after build", () => {
  assert.equal(existsSync(new URL("../src/notify-tool.ts", import.meta.url)), false)
  assert.equal(existsSync(new URL("../dist/notify-tool.js", import.meta.url)), false)
  assert.equal(existsSync(new URL("../dist/notify-tool.d.ts", import.meta.url)), false)
})

test("npm pack dry run excludes Codex and notify-tool artifacts", async () => {
  const command = process.platform === "win32" ? "cmd.exe" : "npm"
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"]
  const { stdout } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    windowsHide: true,
  })
  const files = JSON.parse(stdout)[0].files.map((entry) => entry.path)
  const forbiddenPackNeedles = [
    "dist/codex-",
    "dist/providers/codex-menu-adapter",
    "dist/upstream/codex-",
    "codex-plugin.snapshot",
    "sync-codex-upstream",
  ]

  assert.equal(files.some((filePath) => filePath.includes("notify-tool")), false)
  for (const needle of forbiddenPackNeedles) {
    assert.equal(files.some((filePath) => filePath.replace(/\\/g, "/").includes(needle)), false, needle)
  }
})

test("plugin chat headers append internal session id for plugin-local routing", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
    }),
    loadOfficialChatHeaders: async () => async (_input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const chatHeaders = plugin["chat.headers"]
  const copilotOutput = {
    headers: {
      existing: "value",
    },
  }
  const enterpriseOutput = {
    headers: {},
  }
  const googleOutput = {
    headers: {
      existing: "value",
    },
  }

  await chatHeaders?.(
    {
      sessionID: "session-123",
      agent: "build",
      model: {
        providerID: "github-copilot",
        api: {
          npm: "@ai-sdk/anthropic",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m1" },
    },
    copilotOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-ent-123",
      agent: "build",
      model: {
        providerID: "github-copilot-enterprise",
        api: {
          npm: "@ai-sdk/github-copilot",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m2" },
    },
    enterpriseOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-456",
      agent: "build",
      model: {
        providerID: "google",
        api: {
          npm: "@ai-sdk/google",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m3" },
    },
    googleOutput,
  )

  assert.equal(copilotOutput.headers.existing, "value")
  assert.equal(copilotOutput.headers["x-opencode-session-id"], "session-123")
  assert.equal(enterpriseOutput.headers["x-opencode-session-id"], "session-ent-123")
  assert.equal(googleOutput.headers.existing, "value")
  assert.equal(Object.hasOwn(googleOutput.headers, "x-opencode-session-id"), false)
})

function createSyntheticChatHeadersHarness(input = {}) {
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      syntheticAgentInitiatorEnabled: input.syntheticAgentInitiatorEnabled === true,
    }),
    client: input.client ?? {
      session: {
        message: async (request) => {
          calls.push(request)
          if (typeof input.messageResponse === "function") {
            return input.messageResponse(request)
          }
          return input.messageResponse
        },
      },
    },
    directory: "/tmp/project",
    loadOfficialChatHeaders: async () => async (_hookInput, output) => {
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      if (input.officialInitiator !== undefined) {
        output.headers["x-initiator"] = input.officialInitiator
      }
    },
  })

  return {
    calls,
    chatHeaders: plugin["chat.headers"],
  }
}

function createChatHeadersInput(input = {}) {
  return {
    sessionID: input.sessionID ?? "session-123",
    agent: "task",
    model: {
      providerID: input.providerID ?? "github-copilot",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    },
    provider: { source: "custom", info: {}, options: {} },
    message: input.message ?? {
      id: "message-456",
      sessionID: input.sessionID ?? "session-123",
    },
  }
}

function createFirstUseInitiatorHarness(input = {}) {
  const outgoing = []
  const officialInitiators = new Map()
  const routingStateDirectory = input.routingStateDirectory ?? createTempRoutingStateDirectory()
  const store = {
    active: input.active ?? "main",
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
      },
      ...(input.accounts ?? {}),
    },
    modelAccountAssignments: input.modelAccountAssignments,
    networkRetryEnabled: false,
    ...(input.store ?? {}),
  }

  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const normalizedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        const call = {
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: normalizedHeaders,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        }
        outgoing.push(call)

        if (typeof input.fetchImpl === "function") {
          return input.fetchImpl({
            request,
            init,
            auth,
            call,
            attempt: outgoing.length,
          })
        }

        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
    loadOfficialChatHeaders: async () => async (hookInput, output) => {
      for (const [name, value] of Object.entries(input.officialHeaders ?? {})) {
        output.headers[name] = value
      }

      if (!officialInitiators.has(hookInput.message.id)) {
        return
      }

      const initiator = officialInitiators.get(hookInput.message.id)
      if (initiator !== null) {
        output.headers["x-initiator"] = initiator
      }
    },
    routingStateDirectory,
  })

  const authOptionsPromise = plugin.auth?.loader?.(
    async () => {
      const active = store.accounts[store.active]
      return {
        type: "oauth",
        refresh: active.refresh,
        access: active.access,
        expires: active.expires,
        enterpriseUrl: active.enterpriseUrl,
      }
    },
    { models: {} },
  )

  return {
    outgoing,
    routingStateDirectory,
    store,
    async sendRequest(options = {}) {
      const messageID = options.messageID ?? `message-${outgoing.length + 1}`
      const sessionID = options.sessionID ?? "session-123"
      const headers = { ...(options.initialHeaders ?? {}) }

      if (Object.hasOwn(options, "officialInitiator")) {
        officialInitiators.set(messageID, options.officialInitiator ?? null)
      }

      await plugin["chat.headers"]?.(
        createChatHeadersInput({
          sessionID,
          providerID: options.providerID,
          message: {
            id: messageID,
            sessionID,
          },
        }),
        { headers },
      )

      const authOptions = await authOptionsPromise
      return authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: options.model ?? "o3" }),
      })
    },
  }
}

function createPluginHooksTestHarness(input = {}) {
  const routingStateDirectory = input.routingStateDirectory ?? createTempRoutingStateDirectory()
  const plugin = buildPluginHooks({
    ...input,
    routingStateDirectory,
  })

  return {
    plugin,
    routingStateDirectory,
  }
}

function createSessionBindingHarness(input = {}) {
  const outgoing = []
  let loadCall = 0
  const routingStateDirectory = input.routingStateDirectory ?? createTempRoutingStateDirectory()
  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
      },
    },
    networkRetryEnabled: false,
    ...(input.store ?? {}),
  }

  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadCandidateAccountLoads: async (ctx) => {
      if (typeof input.loadCandidateAccountLoads !== "function") return undefined
      return input.loadCandidateAccountLoads({ ...ctx, call: loadCall++ })
    },
    appendSessionTouchEventImpl: input.appendSessionTouchEventImpl,
    appendRoutingEventImpl: input.appendRoutingEventImpl,
    appendRouteDecisionEventImpl: input.appendRouteDecisionEventImpl,
    readRoutingStateImpl: input.readRoutingStateImpl,
    triggerBillingCompensation: input.triggerBillingCompensation,
    routingStateDirectory,
    touchWriteCacheIdleTtlMs: input.touchWriteCacheIdleTtlMs,
    touchWriteCacheMaxEntries: input.touchWriteCacheMaxEntries,
    now: input.now,
    random: input.random ?? (() => 0),
    client: input.client,
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const normalizedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        const call = {
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: normalizedHeaders,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        }
        outgoing.push(call)
        if (typeof input.fetchImpl === "function") {
          return input.fetchImpl({
            request,
            init,
            auth,
            call,
            attempt: outgoing.length,
          })
        }
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptionsPromise = plugin.auth?.loader?.(
    async () => {
      const active = store.accounts[store.active]
      return {
        type: "oauth",
        refresh: active.refresh,
        access: active.access,
        expires: active.expires,
        enterpriseUrl: active.enterpriseUrl,
      }
    },
    { models: {} },
  )

  return {
    outgoing,
    routingStateDirectory,
    async sendRequest(options = {}) {
      const sessionID = options.sessionID ?? "child-session"
      const headers = {
        ...(options.headers ?? {}),
      }

      if (options.useChatHeaders === true) {
        await plugin["chat.headers"]?.(
          createChatHeadersInput({
            sessionID,
            providerID: options.providerID,
            message: {
              id: options.messageID ?? `message-${outgoing.length + 1}`,
              sessionID,
            },
          }),
          { headers },
        )
      }

      if (typeof options.initiator === "string") {
        headers["x-initiator"] = options.initiator
      }

      const authOptions = await authOptionsPromise
      return authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: {
          "x-opencode-session-id": sessionID,
          ...headers,
        },
        body: JSON.stringify({
          model: options.model ?? "gpt-5",
        }),
      })
    },
    async sendRawRequest(request, init) {
      const authOptions = await authOptionsPromise
      return authOptions?.fetch?.(request, init)
    },
  }
}

async function sendFirstUseRequest(harness, options = {}) {
  await harness.sendRequest(options)
  return harness.outgoing.at(-1)
}

function assertInitiatorHeader(call, expected) {
  if (expected === undefined) {
    assert.equal(Object.hasOwn(call.headers, "x-initiator"), false)
    return
  }

  assert.equal(call.headers["x-initiator"], expected)
}

test("plugin chat headers synthetic stays disabled by default", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.deepEqual(output.headers, {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-opencode-debug-link-id": "message-456",
    "x-opencode-session-id": "session-123",
  })
})

test("plugin chat headers synthetic text overrides x-initiator when enabled", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.deepEqual(output.headers, {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-initiator": "agent",
    "x-opencode-debug-link-id": "message-456",
    "x-opencode-session-id": "session-123",
  })
  assert.deepEqual(calls, [
    {
      path: {
        id: "session-123",
        messageID: "message-456",
      },
      query: {
        directory: "/tmp/project",
      },
      throwOnError: true,
    },
  ])
})

test("plugin chat headers synthetic leaves ordinary text unchanged", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Plain user message", synthetic: false }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers continue template text without synthetic never triggers", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task now", synthetic: false }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic non-text part does not trigger", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "tool", synthetic: true, text: "Continue with the next task now" }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers non-Copilot provider ignores synthetic initiator", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: async () => {
      throw new Error("lookup should not run")
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput({ providerID: "google" }), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic lookup failure preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: async () => {
      throw new Error("lookup failure")
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic preserves official initiator when official already set one", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic missing message id preserves official initiator", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput({ message: { sessionID: "session-123" } }), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic missing parts preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {},
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic empty parts preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers debug logs include evidence and candidates without leaking session parent id", async () => {
  const logLines = []
  const originalWarn = console.warn
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = ""
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  console.warn = (...args) => {
    logLines.push(args.map(String).join(" "))
  }

  try {
    const plugin = buildPluginHooks({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        accounts: {},
      }),
      client: {
        session: {
          message: async () => ({
            data: {
              parts: [
                { type: "compaction" },
                { type: "text", text: "Continue with   the next task now", synthetic: true },
              ],
            },
          }),
          get: async () => ({
            data: {
              parentID: "parent-secret-value",
            },
          }),
          messages: async () => ({
            data: [
              {
                info: { id: "message-456", role: "user" },
                parentID: "parent-secret-value",
                parts: [
                  { type: "compaction" },
                  { type: "text", text: "Continue with   the next task now", synthetic: true },
                ],
              },
              {
                info: { id: "assistant-1", role: "assistant" },
                parentID: "root-parent",
                summary: true,
                finish: "stop",
                parts: [{ type: "text" }],
              },
              {
                info: { id: "assistant-0", role: "assistant" },
                parentID: "older-parent",
                summary: false,
                finish: "length",
                parts: [{ type: "tool" }],
              },
            ],
          }),
        },
      },
      directory: "/tmp/project",
      loadOfficialChatHeaders: async () => async (_input, output) => {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
        output.headers["x-initiator"] = "agent"
      },
    })

    await plugin["chat.headers"]?.(
      {
        sessionID: "session-123",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: {
          id: "message-456",
          sessionID: "message-session-789",
        },
      },
      { headers: { existing: "value" } },
    )
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    console.warn = originalWarn
  }

  assert.deepEqual(logLines, [])
})

test("plugin auth loader keeps official fetch when network retry is disabled", async () => {
  const calls = []
  const fetchImpl = async (request, init) => {
    calls.push({ request, init })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: fetchImpl,
    }),
    createRetryFetch: () => {
      throw new Error("retry wrapper should stay disabled")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(options?.baseURL, "https://api.githubcopilot.com")
  assert.equal(typeof options?.fetch, "function")
  assert.notEqual(options?.fetch, fetchImpl)
  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "o3" }),
  })
  assert.equal(calls.length, 1)
})

test("plugin auth loader strips internal session header even without a resolved routing candidate", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (request, init) => {
        const headers = new Headers(request instanceof Request ? request.headers : undefined)
        for (const [name, value] of new Headers(init?.headers).entries()) {
          headers.set(name, value)
        }
        outgoing.push({
          url: request instanceof URL ? request.href : String(request),
          headers: Object.fromEntries(headers.entries()),
        })
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
    loadOfficialChatHeaders: async () => async (_hookInput, output) => {
      output.headers.existing = "value"
    },
  })

  const headers = {}
  await plugin["chat.headers"]?.(createChatHeadersInput(), { headers })
  assert.equal(headers["x-opencode-session-id"], "session-123")

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "o3" }),
  })

  assert.equal(outgoing.length, 1)
  assert.equal(outgoing[0]?.headers["x-opencode-session-id"], undefined)
  assert.equal(outgoing[0]?.headers.existing, "value")
})

test("plugin auth loader wraps official fetch when network retry is enabled", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const wrappedFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch) => {
      calls.push(fetch)
      return wrappedFetch
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0], "function")
  assert.notEqual(calls[0], officialFetch)
  assert.equal(options?.fetch, wrappedFetch)
})

test("unsupported provider chain never executes copilot routing or auth-loader semantics", async () => {
  let loadStoreCalls = 0
  let loadCommonSettingsCalls = 0
  const plugin = buildPluginHooks({
    auth: {
      provider: "openai",
      methods: [],
    },
    loadStore: async () => {
      loadStoreCalls += 1
      return {
        active: "main",
        accounts: {
          main: {
            name: "main",
            refresh: "refresh",
            access: "access",
            expires: 0,
          },
        },
        networkRetryEnabled: true,
        activeAccountNames: ["main"],
        modelAccountAssignments: { "gpt-5": ["main"] },
      }
    },
    loadCommonSettings: async () => {
      loadCommonSettingsCalls += 1
      return {
        networkRetryEnabled: true,
      }
    },
    loadOfficialConfig: async () => {
      throw new Error("unsupported provider should not load official config")
    },
    finalizeRequestForSelection: async () => {
      throw new Error("copilot finalize should not run")
    },
    loadCandidateAccountLoads: async () => {
      throw new Error("copilot routing should not run")
    },
    appendRouteDecisionEventImpl: async () => {
      throw new Error("copilot route decision should not run")
    },
    appendSessionTouchEventImpl: async () => {
      throw new Error("copilot touch event should not run")
    },
    triggerBillingCompensation: async () => {
      throw new Error("copilot billing compensation should not run")
    },
  })

  assert.equal(plugin.auth?.loader, undefined)
  assert.equal(loadStoreCalls, 0)
  assert.equal(loadCommonSettingsCalls, 0)
})

test("networkRetryEnabled from common settings enables retry for copilot provider", async () => {
  const calls = {
    copilotRetry: 0,
  }

  const copilot = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: false,
    }),
    loadCommonSettings: async () => ({
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      apiKey: "",
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }),
    createRetryFetch: (nextFetch) => {
      calls.copilotRetry += 1
      return nextFetch
    },
  })

  await copilot.auth?.loader?.(
    async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }),
    { models: {} },
  )

  assert.equal(calls.copilotRetry, 1)
})

test("plugin auth loader suppresses first-use agent initiator once and restores agent initiator on later requests", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (_request, init) => {
        outgoing.push(Object.fromEntries(new Headers(init?.headers).entries()))
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
    loadOfficialChatHeaders: async () => async (_input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  const sendAgentRequest = async (messageID) => {
    const headers = {}
    await plugin["chat.headers"]?.(
      {
        sessionID: "child-session",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: { id: messageID },
      },
      { headers },
    )

    await options?.fetch?.("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "o3",
        input: [{ role: "user", content: [] }],
      }),
    })
  }

  await sendAgentRequest("msg-1")
  await sendAgentRequest("msg-2")

  assert.equal(outgoing.length, 2)
  assert.equal(Object.hasOwn(outgoing[0], "x-initiator"), false)
  assert.equal(outgoing[1]["x-initiator"], "agent")
  assert.equal(outgoing[1]["anthropic-beta"], "interleaved-thinking-2025-05-14")
})

test("plugin auth loader only suppresses first use once and keeps subagent initiator across later retry requests", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (_request, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        outgoing.push({
          headers: {
            "x-initiator": "user",
            ...(init?.headers),
            Authorization: "Bearer test-token",
          },
          body,
        })

        if (body.input?.[1]?.id) {
          return new Response(
            "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
            { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
    loadOfficialChatHeaders: async () => async (_input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  const sendAgentRequest = async (messageID, body) => {
    const headers = {}
    await plugin["chat.headers"]?.(
      {
        sessionID: "child-session",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: { id: messageID },
      },
      { headers },
    )

    await options?.fetch?.("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  }

  await sendAgentRequest("msg-1", {
    model: "o3",
    input: [{ role: "user", content: [] }],
  })
  await sendAgentRequest("msg-2", {
    model: "o3",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
    ],
  })

  assert.equal(outgoing.length, 3)
  assert.equal(outgoing[0].headers["x-initiator"], "user")
  assert.equal(outgoing[1].headers["x-initiator"], "agent")
  assert.equal(outgoing[1].headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(outgoing[2].headers["x-initiator"], "agent")
  assert.equal(outgoing[2].headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(outgoing[2].body.input[1].id, undefined)
})

test("plugin auth loader initiator first use strips first agent request for an account", async () => {
  const harness = createFirstUseInitiatorHarness({
    officialHeaders: {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
  })

  const firstCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "kept",
    },
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(firstCall.auth.refresh, "main-refresh")
  assertInitiatorHeader(firstCall, undefined)
  assert.equal(firstCall.headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(firstCall.headers["x-test-header"], "kept")
})

test("plugin auth loader initiator first use restores agent header on second request for same account", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "first",
    },
  })
  const secondCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "second",
    },
  })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstCall, undefined)
  assert.equal(firstCall.headers["x-test-header"], "first")
  assertInitiatorHeader(secondCall, "agent")
  assert.equal(secondCall.headers["x-test-header"], "second")
})

test("plugin auth loader initiator first use is tracked independently per account", async () => {
  const harness = createFirstUseInitiatorHarness({
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
  })

  const altFirstCall = await sendFirstUseRequest(harness, { model: "gpt-5", officialInitiator: "agent" })
  const mainFirstCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(altFirstCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(altFirstCall, undefined)
  assert.equal(mainFirstCall.auth.refresh, "main-refresh")
  assertInitiatorHeader(mainFirstCall, undefined)
})

test("plugin auth loader initiator first use keeps first user header and leaves next agent request unchanged", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstUserCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "user" })
  const secondAgentCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstUserCall, "user")
  assertInitiatorHeader(secondAgentCall, "agent")
})

test("plugin auth loader initiator first use keeps missing initiator missing and leaves next agent request unchanged", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstMissingCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: null })
  const secondAgentCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstMissingCall, undefined)
  assertInitiatorHeader(secondAgentCall, "agent")
})

test("plugin auth loader initiator first use consumes first use when account is chosen by active fallback", async () => {
  const harness = createFirstUseInitiatorHarness({
    active: "alt",
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
  })

  const fallbackFirstCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })
  const mappedSecondCall = await sendFirstUseRequest(harness, { model: "gpt-5", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(fallbackFirstCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(fallbackFirstCall, undefined)
  assert.equal(mappedSecondCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(mappedSecondCall, "agent")
})

test("plugin auth loader initiator first use does not roll back when first send fails", async () => {
  const harness = createFirstUseInitiatorHarness({
    fetchImpl: ({ attempt }) => {
      if (attempt === 1) {
        throw new Error("send failed")
      }

      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await assert.rejects(
    harness.sendRequest({ model: "o3", officialInitiator: "agent" }),
    /send failed/,
  )
  const secondCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(harness.outgoing[0], undefined)
  assertInitiatorHeader(secondCall, "agent")
})

test("plugin auth loader initiator first use normalizes Request and init headers together", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = new Headers(request instanceof Request ? request.headers : undefined)
        for (const [name, value] of new Headers(init?.headers).entries()) {
          headers.set(name, value)
        }
        const normalizedHeaders = Object.fromEntries(headers.entries())
        outgoing.push({ auth, headers: normalizedHeaders })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-test-header": "request",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })
  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-test-header": "request",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })

  assert.equal(outgoing.length, 2)
  assert.equal(outgoing[0].auth.refresh, "main-refresh")
  assertInitiatorHeader(outgoing[0], undefined)
  assert.equal(outgoing[0].headers["x-test-header"], "request")
  assert.equal(outgoing[0].headers["x-added-header"], "init")
  assertInitiatorHeader(outgoing[1], "agent")
  assert.equal(outgoing[1].headers["x-test-header"], "request")
  assert.equal(outgoing[1].headers["x-added-header"], "init")
})

test("plugin auth loader first-use agent detection uses merged header precedence", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = new Headers(request instanceof Request ? request.headers : undefined)
        for (const [name, value] of new Headers(init?.headers).entries()) {
          headers.set(name, value)
        }
        outgoing.push({ auth, headers: Object.fromEntries(headers.entries()) })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-initiator": "user",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })

  assert.equal(outgoing.length, 1)
  assertInitiatorHeader(outgoing[0], undefined)
  assert.equal(outgoing[0].headers["x-added-header"], "init")
})

test("plugin auth loader passes plugin context into retry wrapper factory", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const fakeClient = { session: { messages: async () => ({ data: [] }) } }
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    client: fakeClient,
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].fetch, "function")
  assert.notEqual(calls[0].fetch, officialFetch)
  assert.equal(calls[0].ctx?.client, fakeClient)
  assert.equal(calls[0].ctx?.directory, "C:/repo")
  assert.equal(calls[0].ctx?.serverUrl?.href, "http://localhost:4096/")
})

test("plugin auth loader only wires explicitly provided account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const clearCalls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    clearAccountSwitchContext: async (lastAccountSwitchAt) => {
      clearCalls.push(lastAccountSwitchAt)
    },
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].ctx?.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
  await calls[0].ctx?.clearAccountSwitchContext?.()
  assert.deepEqual(clearCalls, [1_717_171_717_171])
})

test("plugin auth loader provides default account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
})

test("plugin auth loader instantiates notifier and injects its interface into retry wrapper", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const toastCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  assert.equal(typeof retryCalls[0].ctx?.notifier?.started, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.progress, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.repairWarning, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.completed, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.stopped, "function")
  assert.equal("tui" in retryCalls[0].ctx.notifier, false)

  await retryCalls[0].ctx.notifier.started({ remaining: 2 })
  assert.equal(toastCalls.length, 1)
  assert.match(toastCalls[0].body.message, /剩余 2 项/)
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader notifier is a no-op when plugin client toast sdk is unavailable", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  await assert.doesNotReject(async () => {
    await retryCalls[0].ctx.notifier.started({ remaining: 3 })
    await retryCalls[0].ctx.notifier.progress({ remaining: 2 })
    await retryCalls[0].ctx.notifier.repairWarning({ remaining: 2 })
    await retryCalls[0].ctx.notifier.completed({ remaining: 0 })
    await retryCalls[0].ctx.notifier.stopped({ remaining: 1 })
  })
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader leaves sse stream timeout errors untouched from retry fetch", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async () => {
        let sent = false
        const body = new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
              return
            }
            controller.error(new Error("SSE read timed out"))
          },
        })

        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  const response = await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })

  await assert.rejects(
    response?.text(),
    (error) => {
      assert.equal(error?.name, "Error")
      assert.match(String(error?.message ?? ""), /sse read timed out/i)
      assert.equal(error?.isRetryable, undefined)
      return true
    },
  )
})

test("plugin auth loader leaves raw stream timeout errors on upstream responses streamText path", {
  skip: !existsSync(upstreamAiDistPath) || !existsSync(upstreamProviderUtilsDistPath),
}, async () => {
  const { streamText } = await import(pathToFileURL(upstreamAiDistPath).href)
  const { createEventSourceResponseHandler, postJsonToApi } = await import(pathToFileURL(upstreamProviderUtilsDistPath).href)

  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async () => {
        let sent = false
        const body = new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n"))
              return
            }
            controller.error(new Error("SSE read timed out"))
          },
        })

        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  const chunkSchema = {
    "~standard": {
      validate: async (value) => ({ value }),
    },
  }

  const model = {
    specificationVersion: "v2",
    provider: "github-copilot.responses",
    modelId: "gpt-5.4",
    supportedUrls: async () => ({}),
    async doGenerate() {
      throw new Error("unused")
    },
    async doStream() {
      let emittedText = false
      const { value } = await postJsonToApi({
        url: "https://api.githubcopilot.com/responses",
        headers: {},
        body: {
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
          stream: true,
        },
        failedResponseHandler: async () => {
          throw new Error("unexpected")
        },
        successfulResponseHandler: createEventSourceResponseHandler(chunkSchema),
        fetch: options.fetch,
      })

      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })

          try {
            const reader = value.getReader()
            while (true) {
              const next = await reader.read()
              if (next.done) break
              if (emittedText) continue
              emittedText = true
              controller.enqueue({ type: "text-start", id: "text_1" })
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "hello" })
            }

            if (emittedText) {
              controller.enqueue({ type: "text-end", id: "text_1" })
            }
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            })
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
      })

      return {
        stream,
        request: { body: JSON.stringify({ model: "gpt-5.4" }) },
        response: { headers: {} },
      }
    },
  }

  const result = streamText({
    model,
    messages: [{ role: "user", content: "hi" }],
    maxRetries: 0,
    onError: () => {},
  })

  await assert.rejects(
    (async () => {
      for await (const _part of result.fullStream) {
        // consume stream until the SSE error surfaces
      }
    })(),
    (error) => {
      assert.equal(error?.name, "Error")
      assert.match(String(error?.message ?? ""), /sse read timed out/i)
      assert.equal(error?.isRetryable, undefined)
      return true
    },
  )
})

test("plugin auth loader notifier reads latest account switch context from store after loader setup", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const recentSwitchAt = now - 5_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.started, "function")

  store.lastAccountSwitchAt = recentSwitchAt
  await retryContext.notifier.started({ remaining: 2 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)

  store.lastAccountSwitchAt = expiredSwitchAt
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[1].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin auth loader notifier keeps captured account-switch copy after external context clears", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const now = 1_717_171_900_000
  const initialSwitchAt = now - 5_000
  const store = {
    active: "account",
    lastAccountSwitchAt: initialSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  store.lastAccountSwitchAt = undefined
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
})


test("plugin auth loader returns empty config when official loader has no oauth config", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => undefined,
    createRetryFetch: () => {
      throw new Error("retry wrapper should not be called")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "token" }), { models: {} })

  assert.deepEqual(options, {})
})

test("plugin auth loader uses mapped account for matching Copilot model requests and falls back otherwise", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
        alt: {
          name: "alt",
          refresh: "alt-refresh",
          access: "alt-access",
          expires: 0,
          enterpriseUrl: "example.ghe.com",
          models: {
            available: ["gpt-5"],
            disabled: [],
          },
        },
      },
      modelAccountAssignments: {
        "gpt-5": "alt",
      },
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const info = await getAuth()
        calls.push({
          info,
          url: request instanceof URL ? request.href : String(request),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(
    async () => ({
      type: "oauth",
      refresh: "main-refresh",
      access: "main-access",
      expires: 0,
    }),
    { models: {} },
  )

  assert.equal(typeof options?.fetch, "function")

  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5" }),
  })
  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "o3" }),
  })

  assert.equal(calls[0]?.info?.refresh, "alt-refresh")
  assert.match(String(calls[0]?.url), /copilot-api\.example\.ghe\.com/)
  assert.equal(calls[1]?.info?.refresh, "main-refresh")
  assert.match(String(calls[1]?.url), /api\.githubcopilot\.com/)
})

test("plugin auth loader binds the first real request of a child session to a selected account from candidates", async () => {
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async () => ({
      main: 4,
      alt: 1,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-1",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader reuses the bound account for non-user-turn follow-up requests", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 0, alt: 10 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
  })

  await harness.sendRequest({
    sessionID: "child-2",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "child-2",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader reselects on a new user turn when current account load exceeds min by 3 or more", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
  })

  await harness.sendRequest({
    sessionID: "child-3",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "child-3",
    initiator: "user",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader keeps bound account for main-agent follow-up when upstream initiator remains agent", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
   client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  await harness.sendRequest({
    sessionID: "main-agent-follow-up",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "main-agent-follow-up",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader reselects when final initiator header is user even if request body looks like agent follow-up", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  await harness.sendRawRequest("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "main-user-header-agent-body",
      "x-initiator": "agent",
    },
    body: JSON.stringify({
      model: "gpt-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  })

  await harness.sendRawRequest("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "main-user-header-agent-body",
      "x-initiator": "user",
    },
    body: JSON.stringify({
      model: "gpt-5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "tool follow-up" }] },
      ],
    }),
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader reselects for Request completions when final initiator header is user", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  await harness.sendRawRequest(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "request-completions-agent-follow-up",
      "x-initiator": "agent",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    }),
  }))

  await harness.sendRawRequest(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "request-completions-agent-follow-up",
      "x-initiator": "user",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "tool follow-up" },
      ],
    }),
  }))

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader reselect uses x-initiator after chat.headers processing", async () => {
  const outgoing = []
  const processedHeaders = []
  const loadsSeen = []
  let loadCall = 0
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const officialInitiators = ["agent", "user"]
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main", "alt"],
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
        alt: {
          name: "alt",
          refresh: "alt-refresh",
          access: "alt-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadCandidateAccountLoads: async () => {
      const loads = loadsByCall[loadCall] ?? loadsByCall.at(-1)
      loadCall += 1
      loadsSeen.push(loads)
      return loads
    },
    loadOfficialChatHeaders: async () => async (_hookInput, output) => {
      output.headers["x-initiator"] = officialInitiators.shift() ?? "agent"
    },
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        outgoing.push({
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  const sendProcessedRequest = async (messageID) => {
    const headers = {}
    await plugin["chat.headers"]?.(
      createChatHeadersInput({
        sessionID: "processed-header-session",
        message: {
          id: messageID,
          sessionID: "processed-header-session",
        },
      }),
      { headers },
    )
    processedHeaders.push({ ...headers })

    await authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5" }),
    })
  }

  await sendProcessedRequest("processed-1")
  await sendProcessedRequest("processed-2")

  assert.equal(outgoing.length, 2)
  assert.equal(processedHeaders[0]?.["x-initiator"], "agent")
  assert.equal(outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(processedHeaders[1]?.["x-initiator"], "user")
  assert.equal(outgoing[1]?.auth?.refresh, "main-refresh")
  assert.deepEqual(loadsSeen, [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ])
})

test("plugin auth loader should reuse the bound account when official finalized headers mark follow-up as agent", async () => {
  const officialNetworkHeaders = []
  const loadsSeen = []
  let loadCall = 0
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main", "alt"],
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
        alt: {
          name: "alt",
          refresh: "alt-refresh",
          access: "alt-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadCandidateAccountLoads: async () => {
      const loads = loadsByCall[loadCall] ?? loadsByCall.at(-1)
      loadCall += 1
      loadsSeen.push(loads)
      return loads
    },
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "agent",
        },
      },
    }),
    loadOfficialConfig: async ({ getAuth, baseFetch }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          Authorization: `Bearer ${auth?.refresh ?? ""}`,
          "x-initiator": "agent",
        }

        if (typeof baseFetch === "function") {
          return baseFetch(request, {
            ...(init ?? {}),
            headers,
          })
        }

        officialNetworkHeaders.push(headers)
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), {
    models: {
      "gpt-5": {
        api: {
          url: "https://api.githubcopilot.com/chat/completions",
          npm: "@ai-sdk/github-copilot",
        },
      },
    },
  })

  const send = async () => {
    await authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-opencode-session-id": "late-agent-finalization",
        "x-initiator": "user",
      }),
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "tool follow-up" },
        ],
      }),
    })
  }

  await send()
  await send()

  assert.equal(officialNetworkHeaders.length, 2)
  assert.equal(officialNetworkHeaders[0]?.["x-initiator"], "agent")
  assert.equal(officialNetworkHeaders[1]?.["x-initiator"], "agent")
  assert.equal(officialNetworkHeaders[0]?.Authorization, "Bearer alt-refresh")
  assert.equal(officialNetworkHeaders[1]?.Authorization, "Bearer alt-refresh")
  assert.deepEqual(loadsSeen, [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ])
})

test("plugin auth loader preserves session client this binding when finalized initiator becomes agent", async () => {
  const outgoing = []
  const sessionCalls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main"],
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "agent",
        },
      },
    }),
    client: {
      session: {
        _client: { id: "bound-session-client" },
        get(request) {
          if (this?._client?.id !== "bound-session-client") {
            throw new TypeError("undefined is not an object (evaluating 'this._client')")
          }
          sessionCalls.push(request)
          return Promise.resolve({ data: {} })
        },
      },
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (_request, init) => {
        outgoing.push({
          auth: await getAuth(),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await assert.doesNotReject(() => authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "binding-session",
      "x-initiator": "user",
    },
    body: JSON.stringify({
      model: "gpt-5",
    }),
  }))

  assert.equal(sessionCalls.length, 1)
  assert.equal(outgoing.length, 1)
  assert.equal(outgoing[0]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader preserves session message this binding when finalized initiator becomes agent", async () => {
  const outgoing = []
  const messageCalls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main"],
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "agent",
        },
      },
    }),
    client: {
      session: {
        _client: { id: "bound-session-client" },
        message(request) {
          if (this?._client?.id !== "bound-session-client") {
            throw new TypeError("undefined is not an object (evaluating 'this._client')")
          }
          messageCalls.push(request)
          return Promise.resolve({ data: { parts: [] } })
        },
      },
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (_request, init) => {
        outgoing.push({
          auth: await getAuth(),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await assert.doesNotReject(() => authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "binding-session-message",
      "x-opencode-debug-link-id": "msg-1",
      "x-initiator": "user",
    },
    body: JSON.stringify({
      model: "gpt-5",
    }),
  }))

  assert.equal(messageCalls.length, 1)
  assert.equal(outgoing.length, 1)
  assert.equal(outgoing[0]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader default finalized-header inspection does not consume Request body before real send", async () => {
  const seenBodies = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth, baseFetch }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          Authorization: `Bearer ${auth?.refresh ?? ""}`,
          "x-initiator": "agent",
        }

        if (typeof baseFetch === "function") {
          return baseFetch(request, {
            ...(init ?? {}),
            headers,
          })
        }

        const rawBody =
          typeof init?.body === "string"
            ? init.body
            : request instanceof Request
              ? await request.clone().text()
              : undefined
        seenBodies.push(rawBody)
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), {
    models: {
      "gpt-5": {
        api: {
          url: "https://api.githubcopilot.com/chat/completions",
          npm: "@ai-sdk/github-copilot",
        },
      },
    },
  })

  const request = new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "request-body-preserved",
      "x-initiator": "user",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "tool follow-up" },
      ],
    }),
  })

  await assert.doesNotReject(() => authOptions?.fetch?.(request))
  assert.equal(seenBodies.length, 1)
  assert.match(String(seenBodies[0]), /tool follow-up/)
})

test("plugin auth loader does not flag account as rate-limited before the third hit", async () => {
  let currentNow = 10_000
  const events = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    appendRoutingEventImpl: async (input) => {
      events.push(input.event)
    },
    fetchImpl: async () => new Response(
      JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "5",
        },
      },
    ),
  })

  await harness.sendRequest({ sessionID: "child-rate-0", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "child-rate-0", initiator: "agent", model: "gpt-5" })

  assert.deepEqual(events, [])
})

test("plugin auth loader does not treat bare 429 responses as rate-limit hits without semantic evidence", async () => {
  let currentNow = 15_000
  const events = []
  const decisions = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
    },
    appendRoutingEventImpl: async (input) => {
      events.push(input.event)
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
    fetchImpl: async () => new Response("upstream overloaded", {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    }),
  })

  await harness.sendRequest({ sessionID: "child-rate-bare-429", useChatHeaders: true, model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "child-rate-bare-429", useChatHeaders: true, model: "gpt-5" })
  currentNow += 60_000
  const response = await harness.sendRequest({ sessionID: "child-rate-bare-429", useChatHeaders: true, model: "gpt-5" })

  assert.equal(response?.status, 429)
  assert.deepEqual(events, [])
  assert.equal(decisions.length, 3)
  assert.equal(decisions[2]?.rateLimitMatched, false)
  assert.equal(decisions[2]?.retryAfterMs, undefined)
  assert.equal(decisions[2]?.reason, "subagent")
  assert.equal(decisions[2]?.switched, false)
})

test("records route decision evidence for regular request with successful touch write", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
    },
    appendSessionTouchEventImpl: async () => true,
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "decision-regular",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.type, "route-decision")
  assert.equal(decisions[0]?.modelID, "gpt-5")
  assert.equal(decisions[0]?.sessionID, "decision-regular")
  assert.equal(decisions[0]?.sessionIDPresent, true)
  assert.equal(decisions[0]?.groupSource, "active")
  assert.deepEqual(decisions[0]?.candidateNames, ["main", "alt"])
  assert.deepEqual(decisions[0]?.loads, { main: 0, alt: 0 })
  assert.equal(decisions[0]?.chosenAccount, "main")
  assert.equal(decisions[0]?.reason, "subagent")
  assert.equal(decisions[0]?.switched, false)
  assert.equal(decisions[0]?.switchFrom, undefined)
  assert.equal(decisions[0]?.switchBlockedBy, undefined)
  assert.equal(decisions[0]?.touchWriteOutcome, "written")
  assert.equal(decisions[0]?.touchWriteError, undefined)
  assert.equal(decisions[0]?.rateLimitMatched, false)
  assert.equal(decisions[0]?.retryAfterMs, undefined)
  assert.equal(typeof decisions[0]?.at, "number")
})

test("records route decision evidence when session touch write is skipped", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRawRequest("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5" }),
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.sessionIDPresent, false)
  assert.equal(decisions[0]?.sessionID, undefined)
  assert.equal(decisions[0]?.touchWriteOutcome, "skipped-missing-session")
  assert.equal(decisions[0]?.reason, "regular")
})

test("records route decision evidence when session touch write fails", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    appendSessionTouchEventImpl: async () => {
      throw new Error("touch-write-down")
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "decision-touch-failed",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.touchWriteOutcome, "failed")
  assert.match(String(decisions[0]?.touchWriteError ?? ""), /touch-write-down/)
})

test("network retry keeps session visible to routing while stripping it from external fetch", async () => {
  const decisions = []
  const touches = []
  const harness = createSessionBindingHarness({
    store: {
      networkRetryEnabled: true,
    },
    appendSessionTouchEventImpl: async (input) => {
      touches.push({
        accountName: input.accountName,
        sessionID: input.sessionID,
      })
      return true
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "retry-session-visible",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.sessionIDPresent, true)
  assert.equal(decisions[0]?.sessionID, "retry-session-visible")
  assert.equal(decisions[0]?.touchWriteOutcome, "written")
  assert.deepEqual(touches, [
    {
      accountName: "main",
      sessionID: "retry-session-visible",
    },
  ])
  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.headers["x-opencode-session-id"], undefined)
})

test("non-retry requests keep session visible to routing while stripping it from external fetch", async () => {
  const decisions = []
  const touches = []
  const harness = createSessionBindingHarness({
    store: {
      networkRetryEnabled: false,
    },
    appendSessionTouchEventImpl: async (input) => {
      touches.push({
        accountName: input.accountName,
        sessionID: input.sessionID,
      })
      return true
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "non-retry-session-visible",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.sessionIDPresent, true)
  assert.equal(decisions[0]?.sessionID, "non-retry-session-visible")
  assert.equal(decisions[0]?.touchWriteOutcome, "written")
  assert.deepEqual(touches, [
    {
      accountName: "main",
      sessionID: "non-retry-session-visible",
    },
  ])
  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.headers["x-opencode-session-id"], undefined)
})

test("records route decision reason as subagent only when upstream session parentID exists", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "derived-child-session",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.reason, "subagent")
})

test("records route decision reason as compaction for upstream compaction requests", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [{ type: "compaction" }] } }),
        get: async () => ({ data: {} }),
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "derived-compaction-session",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.reason, "compaction")
})

test("records unbound-fallback for root agent request without existing session binding", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "unbound-fallback-root",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.reason, "unbound-fallback")
  assert.equal(harness.outgoing.length, 1)
  assert.equal(Object.hasOwn(harness.outgoing[0]?.headers ?? {}, "x-initiator"), false)
})

test("writes unbound-fallback route decision as JSON line end-to-end", async () => {
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
  })

  const response = await harness.sendRequest({
    sessionID: "decision-log-unbound-fallback",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)

  const decisionsLogPath = join(harness.routingStateDirectory, "decisions.log")
  assert.equal(existsSync(decisionsLogPath), true)
  const lines = (await fs.readFile(decisionsLogPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  assert.equal(lines.length, 1)

  const event = JSON.parse(lines[0])
  assert.equal(event.type, "route-decision")
  assert.equal(event.reason, "unbound-fallback")
  assert.equal(event.sessionID, "decision-log-unbound-fallback")
})

test("unbound-fallback keeps decision reason while sending aligns with user-reselect first entry and not regular reuse", async () => {
  const decisions = []
  let regularContrastCall = 0
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    loadCandidateAccountLoads: async ({ sessionID }) => {
      if (sessionID === "regular-reuse-contrast") {
        const call = regularContrastCall
        regularContrastCall += 1
        return call === 0 ? { main: 5, alt: 0 } : { main: 0, alt: 5 }
      }

      if (sessionID === "unbound-fallback-sending") {
        return { main: 0, alt: 5 }
      }

      if (sessionID === "user-first-entry") {
        return { main: 0, alt: 5 }
      }

      return { main: 0, alt: 0 }
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  await harness.sendRequest({
    sessionID: "regular-reuse-contrast",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "regular-reuse-contrast",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "unbound-fallback-sending",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "user-first-entry",
    initiator: "user",
    model: "gpt-5",
  })

  assert.equal(decisions.length, 4)
  const regularFollowupDecision = decisions[1]
  const unboundFallbackDecision = decisions[2]
  const userFirstEntryDecision = decisions[3]

  assert.equal(regularFollowupDecision?.reason, "regular")
  assert.equal(unboundFallbackDecision?.reason, "unbound-fallback")
  assert.equal(userFirstEntryDecision?.reason, "user-reselect")

  assert.equal(unboundFallbackDecision?.chosenAccount, userFirstEntryDecision?.chosenAccount)
  assert.notEqual(unboundFallbackDecision?.chosenAccount, regularFollowupDecision?.chosenAccount)

  assert.equal(harness.outgoing.length, 4)
  assert.equal(Object.hasOwn(harness.outgoing[2]?.headers ?? {}, "x-initiator"), false)
})

test("agent pass-through without resolved candidate does not trigger session ancestry lookup", async () => {
  const sessionGetCalls = []
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      networkRetryEnabled: false,
    }),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => {
          sessionGetCalls.push("called")
          return { data: {} }
        },
      },
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        outgoing.push({
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  const response = await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "no-candidate-pass-through",
      "x-initiator": "agent",
    },
    body: JSON.stringify({ model: "gpt-5" }),
  })

  assert.equal(response?.status, 200)
  assert.equal(sessionGetCalls.length, 0)
  assert.equal(outgoing.length, 1)
  assert.equal(outgoing[0]?.auth?.refresh, "base-refresh")
})

test("session lookup unavailable does not classify as unbound-fallback", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  await harness.sendRequest({
    sessionID: "prewarm-first-use",
    initiator: "user",
    model: "gpt-5",
  })

  const response = await harness.sendRequest({
    sessionID: "lookup-unavailable-root",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 2)
  assert.equal(decisions[1]?.reason, "regular")
  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[1]?.headers["x-initiator"], "agent")
})

test("unbound-fallback emits dedicated warning toast with required key phrases", async () => {
  const toasts = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  const response = await harness.sendRequest({
    sessionID: "toast-unbound-fallback",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /异常无绑定 agent 入口/)
  assert.match(String(toasts[0]?.body?.message ?? ""), /已按用户回合处理/)
})

test("regular follow-up no longer emits ordinary consumption toast", async () => {
  const toasts = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await harness.sendRawRequest("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5" }),
  })
  await harness.sendRequest({
    sessionID: "toast-subagent",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(toasts.length, 0)
})

test("toasts first billed true child use but suppresses the second use of same account", async () => {
  const toasts = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await harness.sendRequest({
    sessionID: "toast-subagent-first-use",
    useChatHeaders: true,
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "toast-subagent-second-use",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "info")
  assert.equal(toasts[0]?.body?.message, "已使用 main（子代理请求）")
})

test("suppresses ordinary consumption toast for first compaction account selection", async () => {
  const toasts = []
  const decisions = []
  const harness = createSessionBindingHarness({
    client: {
      session: {
        message: async () => ({ data: { parts: [{ type: "compaction" }] } }),
        get: async () => ({ data: {} }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const response = await harness.sendRequest({
    sessionID: "toast-compaction-first-use",
    useChatHeaders: true,
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.reason, "compaction")
  assert.equal(toasts.length, 0)
})

test("toasts actual consumption with user-reselect reason", async () => {
  const toasts = []
  const decisions = []
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await harness.sendRequest({
    sessionID: "toast-user-reselect",
    initiator: "agent",
    model: "gpt-5",
  })
  toasts.length = 0

  await harness.sendRequest({
    sessionID: "toast-user-reselect",
    initiator: "user",
    model: "gpt-5",
  })

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "info")
  assert.equal(toasts[0]?.body?.message, "已使用 main（用户回合重选）")
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0]?.chosenAccount, "alt")
  assert.equal(decisions[0]?.reason, "unbound-fallback")
  assert.equal(decisions[1]?.chosenAccount, "main")
  assert.equal(decisions[1]?.reason, "user-reselect")
})

test("rate-limit switch still overrides final reason after prior unbound-fallback and regular decisions", async () => {
  let now = 11_000_000
  const decisions = []
  const harness = createSessionBindingHarness({
    now: () => now,
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
          },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
  })

  await harness.sendRequest({ sessionID: "switch-from-unbound-fallback", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "switch-from-unbound-fallback", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const thirdResponse = await harness.sendRequest({
    sessionID: "switch-from-unbound-fallback",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(thirdResponse?.status, 200)
  assert.equal(decisions.length, 3)
  assert.equal(decisions[0]?.reason, "unbound-fallback")
  assert.equal(decisions[1]?.reason, "regular")
  assert.equal(decisions[2]?.reason, "rate-limit-switch")
  assert.equal(decisions[2]?.switched, true)
  assert.equal(decisions[2]?.switchFrom, "main")
  assert.equal(decisions[2]?.chosenAccount, "alt")
})

test("keeps request fail-open when route decision append fails", async () => {
  const harness = createSessionBindingHarness({
    appendRouteDecisionEventImpl: async () => {
      throw new Error("decision-log-down")
    },
  })

  const response = await harness.sendRequest({
    sessionID: "decision-fail-open",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "main-refresh")
})

test("records rate-limit switch decision evidence with switchFrom", async () => {
  let now = 8_000_000
  const decisions = []
  const selectionLoads = [
    { main: 0, alt: 0 },
    { main: 9, alt: 2 },
    { main: 9, alt: 2 },
  ]
  const harness = createSessionBindingHarness({
    now: () => now,
    loadCandidateAccountLoads: async ({ call }) => selectionLoads[call] ?? selectionLoads.at(-1),
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after-ms": "5000",
          },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
  })

  await harness.sendRequest({ sessionID: "decision-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "decision-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "decision-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(decisions.length, 3)
  const event = decisions[2]
  assert.equal(event?.reason, "rate-limit-switch")
  assert.equal(event?.switched, true)
  assert.equal(event?.switchFrom, "main")
  assert.equal(event?.switchBlockedBy, undefined)
  assert.equal(event?.chosenAccount, "alt")
  assert.deepEqual(event?.loads, { main: 1, alt: 1 })
  assert.equal(event?.rateLimitMatched, true)
  assert.equal(event?.retryAfterMs, 5_000)
})

test("records route decision evidence when switch is blocked by routing-state read failure", async () => {
  let now = 9_000_000
  const decisions = []
  const harness = createSessionBindingHarness({
    now: () => now,
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root-session" } }),
      },
    },
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
    readRoutingStateImpl: async () => {
      throw new Error("routing-state-read-failed")
    },
    fetchImpl: async () => new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
      },
    }),
  })

  await harness.sendRequest({ sessionID: "decision-blocked", useChatHeaders: true, model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "decision-blocked", useChatHeaders: true, model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "decision-blocked", useChatHeaders: true, model: "gpt-5" })

  assert.equal(response?.status, 429)
  assert.equal(decisions.length, 3)
  const event = decisions[2]
  assert.equal(event?.reason, "subagent")
  assert.equal(event?.switched, false)
  assert.equal(event?.switchFrom, undefined)
  assert.equal(event?.switchBlockedBy, "routing-state-read-failed")
  assert.equal(event?.chosenAccount, "main")
  assert.equal(event?.rateLimitMatched, true)
})

test("plugin auth loader flags account as rate-limited only after three hits within five minutes", async () => {
  let currentNow = 20_000
  const events = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    appendRoutingEventImpl: async (input) => {
      events.push(input.event)
    },
    fetchImpl: async () => new Response(
      JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "retry-after-ms": "2500",
        },
      },
    ),
  })

  await harness.sendRequest({ sessionID: "child-rate-1", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "child-rate-1", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "child-rate-1", initiator: "agent", model: "gpt-5" })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "rate-limit-flagged")
  assert.equal(events[0]?.accountName, "main")
  assert.equal(events[0]?.at, currentNow)
  assert.equal(events[0]?.retryAfterMs, 2_500)

  currentNow += 30_000
  await harness.sendRequest({ sessionID: "child-rate-1", initiator: "agent", model: "gpt-5" })
  assert.equal(events.length, 1)
})

test("plugin auth loader uses response-observed time for rate-limit window and flagged timestamp", async () => {
  let currentNow = 0
  const events = []
  let call = 0
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          touchBuckets: {},
        },
        alt: {
          touchBuckets: {},
          lastRateLimitedAt: currentNow - 60_000,
        },
      },
      appliedSegments: [],
    }),
    appendRoutingEventImpl: async (input) => {
      events.push(input.event)
    },
    fetchImpl: async () => {
      call += 1
      if (call === 1) currentNow += 100_000
      else currentNow += 1_000
      return new Response(
        JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
          },
        },
      )
    },
  })

  await harness.sendRequest({ sessionID: "child-rate-observed", initiator: "agent", model: "gpt-5" })
  currentNow += 220_000
  await harness.sendRequest({ sessionID: "child-rate-observed", initiator: "agent", model: "gpt-5" })
  currentNow += 10_000
  await harness.sendRequest({ sessionID: "child-rate-observed", initiator: "agent", model: "gpt-5" })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "rate-limit-flagged")
  assert.equal(events[0]?.at, currentNow)
})

test("switches accounts after rate limit when replacement load equals current load", async () => {
  let now = 1_000_000
  const harness = createSessionBindingHarness({
    now: () => now,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  })

  await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})

test("rate-limit replacement breaks equal-load ties with injected random", async () => {
  let now = 1_200_000
  const harness = createSessionBindingHarness({
    now: () => now,
    random: () => 0.9,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
        org: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    store: {
      active: "main",
      activeAccountNames: ["main", "alt", "org"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
        org: { name: "org", refresh: "org-refresh", access: "org-access", expires: 0 },
      },
    },
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  })

  await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "org-refresh")
})

test("rate-limit replacement tie selection tolerates invalid injected random", async () => {
  let now = 1_250_000
  let randomCalls = 0
  const harness = createSessionBindingHarness({
    now: () => now,
    random: () => {
      randomCalls += 1
      return randomCalls <= 3 ? 0 : -1
    },
    loadCandidateAccountLoads: async () => ({
      main: 0,
      alt: 2,
      org: 2,
    }),
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
        org: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    store: {
      active: "main",
      activeAccountNames: ["main", "alt", "org"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
        org: { name: "org", refresh: "org-refresh", access: "org-access", expires: 0 },
      },
    },
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  })

  await harness.sendRequest({ sessionID: "invalid-random-replacement", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "invalid-random-replacement", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "invalid-random-replacement", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})

test("switches to a lower-load account whose lastRateLimitedAt is older than ten minutes", async () => {
  let currentNow = 1_000_000
  const toasts = []
  const compensationCalls = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    loadCandidateAccountLoads: async () => ({
      main: 0,
      alt: 2,
    }),
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 3,
          },
        },
        alt: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 1,
          },
          lastRateLimitedAt: currentNow - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    triggerBillingCompensation: async (input) => {
      compensationCalls.push(input)
    },
    client: {
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "switch-1", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "switch-1", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  const thirdResponse = await harness.sendRequest({ sessionID: "switch-1", initiator: "agent", model: "gpt-5" })

  assert.equal(thirdResponse?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
  assert.equal(compensationCalls.length, 1)
  assert.equal(compensationCalls[0]?.toAccountName, "alt")
  assert.match(String(toasts.at(-1)?.body?.message ?? ""), /切换到 alt/)
})

test("same-session user reselect switch triggers billing compensation", async () => {
  const compensationCalls = []
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
    triggerBillingCompensation: async (input) => {
      compensationCalls.push(input)
    },
  })

  await harness.sendRequest({
    sessionID: "user-reselect-compensation",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "user-reselect-compensation",
    initiator: "user",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "main-refresh")
  assert.equal(compensationCalls.length, 1)
  assert.equal(compensationCalls[0]?.fromAccountName, "alt")
  assert.equal(compensationCalls[0]?.toAccountName, "main")
  assert.equal(compensationCalls[0]?.sessionID, "user-reselect-compensation")
  assert.equal(compensationCalls[0]?.modelID, "gpt-5")
})

test("rate-limit switch emits exactly one warning toast without extra consumption toast", async () => {
  let currentNow = 1_050_000
  const toasts = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 3,
          },
        },
        alt: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 1,
          },
          lastRateLimitedAt: currentNow - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    client: {
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "toast-rate-switch", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "toast-rate-switch", initiator: "agent", model: "gpt-5" })

  toasts.length = 0
  currentNow += 60_000
  const thirdResponse = await harness.sendRequest({ sessionID: "toast-rate-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(thirdResponse?.status, 200)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.equal(toasts[0]?.body?.message, "已切换到 alt（main 限流后切换）")
})

test("appends replacement account touch event after successful switch", async () => {
  let currentNow = 1_500_000
  const touches = []
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    appendSessionTouchEventImpl: async (input) => {
      touches.push({
        accountName: input.accountName,
        sessionID: input.sessionID,
        at: input.at,
      })
      return true
    },
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 3,
          },
        },
        alt: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 1,
          },
          lastRateLimitedAt: currentNow - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "switch-touch", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "switch-touch", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  const thirdResponse = await harness.sendRequest({ sessionID: "switch-touch", initiator: "agent", model: "gpt-5" })

  assert.equal(thirdResponse?.status, 200)
  assert.equal(touches.some((item) => item.accountName === "alt" && item.sessionID === "switch-touch"), true)
})

test("switch evaluation continues after threshold and can switch on fourth hit", async () => {
  let currentNow = 2_500_000
  let routingReadCount = 0
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    readRoutingStateImpl: async () => {
      routingReadCount += 1
      const cooldownMinutes = routingReadCount >= 2 ? 11 : 9
      return {
        accounts: {
          main: {
            touchBuckets: {
              [String(currentNow - 60_000)]: 3,
            },
          },
          alt: {
            touchBuckets: {
              [String(currentNow - 60_000)]: 1,
            },
            lastRateLimitedAt: currentNow - cooldownMinutes * 60 * 1000,
          },
        },
        appliedSegments: [],
      }
    },
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "switch-fourth", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "switch-fourth", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  const thirdResponse = await harness.sendRequest({ sessionID: "switch-fourth", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  const fourthResponse = await harness.sendRequest({ sessionID: "switch-fourth", initiator: "agent", model: "gpt-5" })

  assert.equal(thirdResponse?.status, 429)
  assert.equal(fourthResponse?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})

test("replacement cleanup fails open when request body is already consumed", async () => {
  let currentNow = 3_000_000
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 3,
          },
        },
        alt: {
          touchBuckets: {
            [String(currentNow - 60_000)]: 1,
          },
          lastRateLimitedAt: currentNow - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "switch-consumed", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "switch-consumed", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000

  const consumedRequest = new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "switch-consumed",
      "x-initiator": "agent",
    },
    body: JSON.stringify({ model: "gpt-5" }),
  })
  await consumedRequest.text()

  const thirdResponse = await harness.sendRawRequest(consumedRequest)
  assert.equal(thirdResponse?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})

test("keeps current account when no better candidate exists", async () => {
  let currentNow = 2_000_000
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    loadCandidateAccountLoads: async () => ({
      main: 0,
      alt: 2,
    }),
    readRoutingStateImpl: async () => ({
      accounts: {
        main: {
          sessions: {
            s1: currentNow - 20_000,
          },
        },
        alt: {
          sessions: {
            s9: currentNow - 10_000,
          },
          lastRateLimitedAt: currentNow - 5 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => {
      if (auth?.refresh === "main-refresh") {
        return new Response(
          JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await harness.sendRequest({ sessionID: "switch-2", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  await harness.sendRequest({ sessionID: "switch-2", initiator: "agent", model: "gpt-5" })
  currentNow += 60_000
  const thirdResponse = await harness.sendRequest({ sessionID: "switch-2", initiator: "agent", model: "gpt-5" })

  assert.equal(thirdResponse?.status, 429)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "main-refresh")
})

test("fails open when routing-state read fails during candidate selection", async () => {
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async () => {
      throw new Error("routing-state broken")
    },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  })

  const response = await harness.sendRequest({
    sessionID: "fail-open-routing-state",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(response?.status, 200)
})

test("surfaces a clear error when an explicit model group has no usable accounts", async () => {
  const harness = createSessionBindingHarness({
    store: {
      active: "main",
      activeAccountNames: ["main"],
      modelAccountAssignments: {
        "gpt-5": ["alt"],
      },
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
        alt: {
          name: "alt",
          refresh: "alt-refresh",
          access: "alt-access",
          expires: 0,
          models: {
            available: ["o3"],
            disabled: ["gpt-5"],
          },
        },
      },
    },
  })

  await assert.rejects(
    harness.sendRequest({
      sessionID: "explicit-empty",
      initiator: "agent",
      model: "gpt-5",
    }),
    /No usable account for model gpt-5/i,
  )
})

test("plugin auth loader selection path can consume routing-state-derived loads", async () => {
  const now = 2_000_000
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ candidates }) => buildCandidateAccountLoads({
      snapshot: {
        accounts: {
          main: {
            touchBuckets: {
              [String(now - 60_000)]: 3,
            },
          },
          alt: {
            touchBuckets: {
              [String(now - 60_000)]: 1,
            },
          },
        },
        appliedSegments: [],
      },
      candidateAccountNames: candidates.map((item) => item.name),
      now,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-routing-loads",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader supports injected routing-state write path", async () => {
  const touched = []
  const harness = createSessionBindingHarness({
    appendSessionTouchEventImpl: async (input) => {
      touched.push(input)
      return true
    },
  })

  await harness.sendRequest({
    sessionID: "child-injected-touch",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(touched.length, 1)
  assert.equal(typeof touched[0]?.directory, "string")
  assert.equal(touched[0]?.accountName, "main")
  assert.equal(touched[0]?.sessionID, "child-injected-touch")
})

test("plugin auth loader prunes touch cache by ttl and max entries", async () => {
  const touched = []
  let currentNow = 1_000_000
  const harness = createSessionBindingHarness({
    now: () => currentNow,
    touchWriteCacheIdleTtlMs: 60_000,
    touchWriteCacheMaxEntries: 2,
    appendSessionTouchEventImpl: async (input) => {
      touched.push({
        accountName: input.accountName,
        sessionID: input.sessionID,
        at: input.at,
        cacheKeys: [...input.lastTouchWrites.keys()].sort(),
      })
      input.lastTouchWrites.set(`${input.accountName}:${input.sessionID}`, input.at)
      return true
    },
  })

  await harness.sendRequest({ sessionID: "s1", initiator: "agent", model: "gpt-5" })
  currentNow += 10_000
  await harness.sendRequest({ sessionID: "s2", initiator: "agent", model: "gpt-5" })
  currentNow += 10_000
  await harness.sendRequest({ sessionID: "s3", initiator: "agent", model: "gpt-5" })
  currentNow += 1_000
  await harness.sendRequest({ sessionID: "s4", initiator: "agent", model: "gpt-5" })
  currentNow += 120_000
  await harness.sendRequest({ sessionID: "s5", initiator: "agent", model: "gpt-5" })

  assert.equal(touched.length, 5)
  assert.deepEqual(touched[0]?.cacheKeys, [])
  assert.deepEqual(touched[1]?.cacheKeys, ["main:s1"])
  assert.deepEqual(touched[2]?.cacheKeys, ["main:s1", "main:s2"])
  assert.deepEqual(touched[3]?.cacheKeys, ["main:s2", "main:s3"])
  assert.deepEqual(touched[4]?.cacheKeys, [])
})

test("plugin auth loader breaks equal-load ties with injected random", async () => {
  const harness = createSessionBindingHarness({
    random: () => 0.9,
    loadCandidateAccountLoads: async () => ({
      main: 2,
      alt: 2,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-tie",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
})

test("createSessionBindingHarness defaults routing-state to isolated temporary directory", async () => {
  const harness = createSessionBindingHarness()

  await harness.sendRequest({
    sessionID: "isolated-routing-state",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(typeof harness.routingStateDirectory, "string")
  assert.match(basename(harness.routingStateDirectory), /^routing-state-/)
  assert.doesNotMatch(harness.routingStateDirectory.replaceAll("\\", "/"), /\/\.local\/share\/opencode\/copilot-routing-state\/?$/)

  const decisionsLog = await fs.stat(join(harness.routingStateDirectory, "decisions.log"))
  assert.equal(decisionsLog.isFile(), true)
})

test("createFirstUseInitiatorHarness defaults routing-state to isolated temporary directory", async () => {
  const harness = createFirstUseInitiatorHarness()

  await harness.sendRequest({
    sessionID: "first-use-isolated",
    model: "o3",
  })

  assert.equal(typeof harness.routingStateDirectory, "string")
  assert.match(basename(harness.routingStateDirectory), /^routing-state-/)
  assert.doesNotMatch(harness.routingStateDirectory.replaceAll("\\", "/"), /\/\.local\/share\/opencode\/copilot-routing-state\/?$/)

  const decisionsLog = await fs.stat(join(harness.routingStateDirectory, "decisions.log"))
  assert.equal(decisionsLog.isFile(), true)
})

test("direct plugin fetch tests default routing-state to isolated temporary directory", async () => {
  const calls = []
  const { plugin, routingStateDirectory } = createPluginHooksTestHarness({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (_request, init) => {
        const info = await getAuth()
        calls.push({ info, init })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(
    async () => ({
      type: "oauth",
      refresh: "main-refresh",
      access: "main-access",
      expires: 0,
    }),
    { models: {} },
  )

  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-opencode-session-id": "direct-isolated",
      "x-initiator": "agent",
    },
    body: JSON.stringify({ model: "o3" }),
  })

  assert.equal(calls.length, 1)
  assert.match(basename(routingStateDirectory), /^routing-state-/)
  assert.doesNotMatch(routingStateDirectory.replaceAll("\\", "/"), /\/\.local\/share\/opencode\/copilot-routing-state\/?$/)

  const decisionsLog = await fs.stat(join(routingStateDirectory, "decisions.log"))
  assert.equal(decisionsLog.isFile(), true)
})

test("plain buildPluginHooks test instances default routing-state to isolated temporary directory", async () => {
  const directories = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      networkRetryEnabled: false,
    }),
    appendSessionTouchEventImpl: async (input) => {
      directories.push(input.directory)
      return true
    },
    appendRouteDecisionEventImpl: async (input) => {
      directories.push(input.directory)
    },
    loadOfficialConfig: async () => ({
      apiKey: "",
      fetch: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    }),
  })

  const options = await plugin.auth?.loader?.(
    async () => ({
      type: "oauth",
      refresh: "main-refresh",
      access: "main-access",
      expires: 0,
    }),
    { models: {} },
  )

  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-opencode-session-id": "plain-build-plugin-hooks-test",
      "x-initiator": "agent",
    },
    body: JSON.stringify({ model: "o3" }),
  })

  assert.equal(directories.length >= 1, true)
  assert.match(basename(directories[0]), /^routing-state-/)
  assert.doesNotMatch(directories[0].replaceAll("\\", "/"), /\/\.local\/share\/opencode\/copilot-routing-state\/?$/)
})

test("session binding harness keeps tie selection deterministic without explicit random", async () => {
  const originalRandom = Math.random
  Math.random = () => 0.9

  try {
    const harness = createSessionBindingHarness({
      loadCandidateAccountLoads: async () => ({
        main: 2,
        alt: 2,
      }),
    })

    await harness.sendRequest({
      sessionID: "child-tie-default-random",
      initiator: "agent",
      model: "gpt-5",
    })

    assert.equal(harness.outgoing.length, 1)
    assert.equal(harness.outgoing[0]?.auth?.refresh, "main-refresh")
  } finally {
    Math.random = originalRandom
  }
})

test("plugin auth loader evicts stale session bindings when binding cache grows too large", async () => {
  let child0Hits = 0
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ sessionID }) => {
      if (sessionID === "child-0") {
        child0Hits += 1
        if (child0Hits === 1) {
          return { main: 10, alt: 0 }
        }
        return { main: 0, alt: 10 }
      }
      return { main: 5, alt: 1 }
    },
  })

  for (let index = 0; index < 260; index += 1) {
    await harness.sendRequest({
      sessionID: `child-${index}`,
      initiator: "agent",
      model: "gpt-5",
    })
  }

  await harness.sendRequest({
    sessionID: "child-0",
    initiator: "agent",
    model: "gpt-5",
  })

  const firstCall = harness.outgoing[0]
  const lastCall = harness.outgoing.at(-1)
  assert.equal(firstCall?.auth?.refresh, "alt-refresh")
  assert.equal(lastCall?.auth?.refresh, "main-refresh")
})

test("configureModelAccountAssignments stores multiple selected accounts", async () => {
  const { configureModelAccountAssignments } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main"],
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      org: {
        name: "org",
        refresh: "org-refresh",
        access: "org-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
    },
  }

  const changed = await configureModelAccountAssignments(store, {
    selectModel: async () => "gpt-5",
    selectAccounts: async () => ["alt", "org"],
  })

  assert.equal(changed, true)
  assert.deepEqual(store.modelAccountAssignments?.["gpt-5"], ["alt", "org"])
})

test("default account group can include multiple accounts", async () => {
  const { configureDefaultAccountGroup } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      "student-2": { name: "student-2", refresh: "s2-refresh", access: "s2-access", expires: 0 },
    },
  }

  const changed = await configureDefaultAccountGroup(store, {
    selectAccounts: async () => ["main", "student-2"],
  })

  assert.equal(changed, true)
  assert.deepEqual(store.activeAccountNames, ["main", "student-2"])
  assert.equal(store.active, "main")
})

test("configureModelAccountAssignments fallback hint uses default account group when available", async () => {
  const { configureModelAccountAssignments } = await import("../dist/plugin.js")

  let capturedModelOptions = []
  const store = {
    active: "solo",
    activeAccountNames: ["student-1", "student-2"],
    accounts: {
      solo: {
        name: "solo",
        refresh: "solo-refresh",
        access: "solo-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      "student-1": {
        name: "student-1",
        refresh: "s1-refresh",
        access: "s1-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      "student-2": {
        name: "student-2",
        refresh: "s2-refresh",
        access: "s2-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
    },
  }

  const changed = await configureModelAccountAssignments(store, {
    selectModel: async (options) => {
      capturedModelOptions = options
      return null
    },
  })

  assert.equal(changed, false)
  assert.match(capturedModelOptions[0]?.hint ?? "", /fallbacks to student-1, student-2/)
})

test("configureDefaultAccountGroup keeps active account unchanged when it is outside new default group", async () => {
  const { configureDefaultAccountGroup } = await import("../dist/plugin.js")

  const store = {
    active: "manual-current",
    activeAccountNames: ["manual-current"],
    accounts: {
      "manual-current": { name: "manual-current", refresh: "mc-refresh", access: "mc-access", expires: 0 },
      "student-1": { name: "student-1", refresh: "s1-refresh", access: "s1-access", expires: 0 },
      "student-2": { name: "student-2", refresh: "s2-refresh", access: "s2-access", expires: 0 },
    },
  }

  const changed = await configureDefaultAccountGroup(store, {
    selectAccounts: async () => ["student-1", "student-2"],
  })

  assert.equal(changed, true)
  assert.equal(store.active, "manual-current")
  assert.deepEqual(store.activeAccountNames, ["student-1", "student-2"])
})

test("clearAllAccounts also clears activeAccountNames", async () => {
  const { clearAllAccounts } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
    },
    modelAccountAssignments: {
      "gpt-5": ["alt"],
    },
  }

  clearAllAccounts(store)

  assert.equal(store.active, undefined)
  assert.equal(store.activeAccountNames, undefined)
  assert.deepEqual(store.accounts, {})
  assert.equal(store.modelAccountAssignments, undefined)
})

test("removeAccountFromStore chooses deterministic active fallback", async () => {
  const { removeAccountFromStore } = await import("../dist/plugin.js")

  const preferGroupStore = {
    active: "main",
    activeAccountNames: ["alt"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
      beta: { name: "beta", refresh: "beta-refresh", access: "beta-access", expires: 0 },
    },
  }

  removeAccountFromStore(preferGroupStore, "main")
  assert.equal(preferGroupStore.active, "alt")

  const fallbackStore = {
    active: "main",
    activeAccountNames: ["missing"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      zeta: { name: "zeta", refresh: "zeta-refresh", access: "zeta-access", expires: 0 },
      alpha: { name: "alpha", refresh: "alpha-refresh", access: "alpha-access", expires: 0 },
    },
  }

  removeAccountFromStore(fallbackStore, "main")
  assert.equal(fallbackStore.active, "alpha")
})

test("removeAccountFromStore immediately removes deleted account from modelAccountAssignments", async () => {
  const { removeAccountFromStore } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
    },
    modelAccountAssignments: {
      "gpt-5": ["main", "alt"],
      "claude-3.7": ["main"],
    },
  }

  removeAccountFromStore(store, "main")

  const stillContainsDeleted = Object.values(store.modelAccountAssignments ?? {}).some((entry) => Array.isArray(entry)
    ? entry.includes("main")
    : entry === "main")
  assert.equal(stillContainsDeleted, false)
})

test("plugin auth loader sends the finalized request headers it used for classification", async () => {
  const decisions = []
  const outgoing = []
  let loadCall = 0
  const originalFetch = globalThis.fetch
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]

  try {
    globalThis.fetch = async (_request, init) => {
      outgoing.push({
        url: _request instanceof Request ? _request.url : String(_request),
        headers: {
          ...Object.fromEntries(_request instanceof Request ? _request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
        },
      })
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    }

    const { plugin } = createPluginHooksTestHarness({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        active: "main",
        activeAccountNames: ["main", "alt"],
        accounts: {
          main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
          alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
        },
        networkRetryEnabled: false,
      }),
      loadCandidateAccountLoads: async () => {
        const loads = loadsByCall[loadCall] ?? loadsByCall.at(-1)
        loadCall += 1
        return loads
      },
      finalizeRequestForSelection: async ({ request, init }) => ({
        request,
        init: {
          ...(init ?? {}),
          headers: {
            ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            "x-initiator": "user",
            "x-finalized-classification": "true",
          },
        },
      }),
      appendRouteDecisionEventImpl: async (input) => {
        decisions.push(input.event)
      },
    })

    const authOptions = await plugin.auth?.loader?.(async () => ({
      type: "oauth",
      refresh: "base-refresh",
      access: "base-access",
      expires: 0,
    }), { models: {} })

    const send = async () => authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-session-id": "finalized-headers-for-classification",
        "x-initiator": "agent",
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "tool follow-up" },
        ],
      }),
    })

    await send()
    await send()

    const finalDecision = decisions.at(-1)
    const finalOutgoing = outgoing.at(-1)
    assert.equal(finalDecision?.reason, "user-reselect")
    assert.equal(finalDecision?.chosenAccount, "main")
    assert.equal(finalDecision?.chosenAccountAuthFingerprint, "aae77eccb5dd")
    assert.equal(finalDecision?.finalRequestHeaders?.authorization, "Bearer [redacted]")
    assert.equal(finalDecision?.finalRequestHeaders?.["content-type"], "application/json")
    assert.equal(finalDecision?.finalRequestHeaders?.["openai-intent"], "conversation-edits")
    assert.equal(finalDecision?.finalRequestHeaders?.["x-finalized-classification"], "true")
    assert.equal(finalDecision?.finalRequestHeaders?.["x-initiator"], "user")
    assert.match(String(finalDecision?.finalRequestHeaders?.["user-agent"] ?? ""), /^opencode\//)
    assert.equal(finalDecision?.networkRequestHeaders?.authorization, "Bearer [redacted]")
    assert.equal(finalDecision?.networkRequestHeaders?.["openai-intent"], "conversation-edits")
    assert.equal(finalDecision?.networkRequestHeaders?.["x-initiator"], "user")
    assert.equal(finalOutgoing?.headers["x-initiator"], "user")
    assert.equal(finalOutgoing?.headers["x-finalized-classification"], "true")
    assert.equal(finalOutgoing?.headers.authorization, "Bearer main-refresh")
    assert.equal(finalOutgoing?.headers["openai-intent"], "conversation-edits")
    assert.equal(finalOutgoing?.headers["x-opencode-session-id"], undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("route decision logs chosen account auth fingerprint for routed user turns", async () => {
  const decisions = []

  const { plugin } = createPluginHooksTestHarness({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main", "alt"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
      },
      networkRetryEnabled: false,
    }),
    loadCandidateAccountLoads: async () => ({ main: 1, alt: 5 }),
    loadOfficialConfig: async () => ({
      apiKey: "",
      fetch: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    }),
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "user",
        },
      },
    }),
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "fingerprint-session",
      "x-initiator": "agent",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "tool follow-up" },
      ],
    }),
  })

  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.chosenAccount, "main")
  assert.equal(decisions[0]?.chosenAccountAuthFingerprint, "aae77eccb5dd")
})

test("route decision logs debug link id for routed user turns", async () => {
  const decisions = []

  const { plugin } = createPluginHooksTestHarness({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main", "alt"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
      },
      networkRetryEnabled: false,
    }),
    loadCandidateAccountLoads: async () => ({ main: 1, alt: 5 }),
    loadOfficialConfig: async () => ({
      apiKey: "",
      fetch: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    }),
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "user",
        },
      },
    }),
    appendRouteDecisionEventImpl: async (input) => {
      decisions.push(input.event)
    },
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "debug-link-session",
      "x-opencode-debug-link-id": "debug-link-123",
      "x-initiator": "agent",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "tool follow-up" },
      ],
    }),
  })

  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.reason, "user-reselect")
  assert.equal(decisions[0]?.debugLinkId, "debug-link-123")
})

test("plugin auth loader avoids duplicate finalized headers when request already carries official headers", async () => {
  const decisions = []
  const outgoing = []
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async (request, init) => {
      outgoing.push({
        url: request instanceof Request ? request.url : String(request),
        headers: {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
        },
      })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const { plugin } = createPluginHooksTestHarness({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        active: "main",
        activeAccountNames: ["main"],
        accounts: {
          main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        },
        networkRetryEnabled: false,
      }),
      appendRouteDecisionEventImpl: async (input) => {
        decisions.push(input.event)
      },
    })

    const authOptions = await plugin.auth?.loader?.(async () => ({
      type: "oauth",
      refresh: "base-refresh",
      access: "base-access",
      expires: 0,
    }), { models: {} })

    const request = new Request("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-session-id": "no-duplicate-final-headers",
        authorization: "Bearer request-auth",
        "openai-intent": "conversation-edits",
        "user-agent": "opencode/request",
        "x-initiator": "user",
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    await authOptions?.fetch?.(request, {
      headers: {
        authorization: "Bearer init-auth",
        "openai-intent": "conversation-edits",
        "user-agent": "opencode/init",
      },
    })

    assert.equal(outgoing.length, 1)
    assert.equal(outgoing[0]?.headers.authorization, "Bearer main-refresh")
    assert.equal(outgoing[0]?.headers["openai-intent"], "conversation-edits")
    assert.equal(outgoing[0]?.headers["user-agent"], "opencode/snapshot")
    assert.equal(decisions[0]?.finalRequestHeaders?.["openai-intent"], "conversation-edits")
    assert.equal(decisions[0]?.finalRequestHeaders?.["user-agent"], "opencode/snapshot")
    assert.equal(decisions[0]?.networkRequestHeaders?.["openai-intent"], "conversation-edits")
    assert.equal(decisions[0]?.networkRequestHeaders?.["user-agent"], "opencode/snapshot")
    assert.equal(decisions[0]?.networkRequestUsedInitHeaders, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("user-reselect toast and outbound x-initiator stay aligned for routed user turns", async () => {
  const toasts = []
  const outgoing = []
  let loadCall = 0
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]

  const { plugin } = createPluginHooksTestHarness({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      activeAccountNames: ["main", "alt"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
      },
      networkRetryEnabled: false,
    }),
    loadCandidateAccountLoads: async () => {
      const loads = loadsByCall[loadCall] ?? loadsByCall.at(-1)
      loadCall += 1
      return loads
    },
    finalizeRequestForSelection: async ({ request, init }) => ({
      request,
      init: {
        ...(init ?? {}),
        headers: {
          ...Object.fromEntries(request instanceof Request ? request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "x-initiator": "user",
        },
      },
    }),
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (_request, init) => {
        const headers = {
          ...Object.fromEntries(_request instanceof Request ? _request.headers.entries() : []),
          ...Object.fromEntries(new Headers(init?.headers).entries()),
        }
        outgoing.push({
          auth: await getAuth(),
          headers,
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  const send = async () => authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "toast-alignment-user-reselect",
      "x-initiator": "agent",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "tool follow-up" },
      ],
    }),
  })

  await send()
  toasts.length = 0
  await send()

  assert.equal(toasts.length, 1)
  assert.match(String(toasts[0]?.body?.message ?? ""), /用户回合重选/)
  assert.equal(outgoing.at(-1)?.headers["x-initiator"], "user")
})

test("plugin menu common toggle path requires common settings store for networkRetryEnabled", async () => {
  const store = {
    accounts: {},
    networkRetryEnabled: false,
  }

  await assert.rejects(() => applyMenuAction({
    action: { type: "toggle-network-retry" },
    store,
    writeStore: async () => {},
  }), /requires common settings store/i)
})

test("plugin menu common toggle path persists networkRetryEnabled via common settings store", async () => {
  const storeWrites = []
  const commonWrites = []
  const store = {
    accounts: {},
    networkRetryEnabled: false,
  }
  const commonSettings = {
    networkRetryEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-network-retry" },
    store,
    writeStore: async (next) => {
      storeWrites.push(next.networkRetryEnabled)
    },
    readCommonSettings: async () => commonSettings,
    writeCommonSettings: async (next) => {
      commonSettings.networkRetryEnabled = next.networkRetryEnabled
      commonWrites.push(next.networkRetryEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.networkRetryEnabled, false)
  assert.equal(commonSettings.networkRetryEnabled, true)
  assert.deepEqual(storeWrites, [])
  assert.deepEqual(commonWrites, [true])
})

test("plugin menu toggle path persists synthetic initiator state", async () => {
  const writes = []
  const store = {
    accounts: {},
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-synthetic-agent-initiator" },
    store,
    writeStore: async (next) => {
      writes.push(next.syntheticAgentInitiatorEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.syntheticAgentInitiatorEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu common toggle path requires common settings store for experimental slash commands", async () => {
  const store = {
    accounts: {},
    experimentalSlashCommandsEnabled: true,
  }

  await assert.rejects(() => applyMenuAction({
    action: { type: "toggle-experimental-slash-commands" },
    store,
    writeStore: async () => {},
  }), /requires common settings store/i)
})

test("plugin menu common toggle path persists experimental slash commands state via common settings store", async () => {
  const storeWrites = []
  const commonWrites = []
  const store = {
    accounts: {},
    experimentalSlashCommandsEnabled: true,
  }
  const commonSettings = {
    experimentalSlashCommandsEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-experimental-slash-commands" },
    store,
    writeStore: async (next) => {
      storeWrites.push(next.experimentalSlashCommandsEnabled)
    },
    readCommonSettings: async () => commonSettings,
    writeCommonSettings: async (next) => {
      commonSettings.experimentalSlashCommandsEnabled = next.experimentalSlashCommandsEnabled
      commonWrites.push(next.experimentalSlashCommandsEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.experimentalSlashCommandsEnabled, true)
  assert.equal(commonSettings.experimentalSlashCommandsEnabled, false)
  assert.deepEqual(storeWrites, [])
  assert.deepEqual(commonWrites, [false])
})

test("plugin menu common toggle path forwards debug reason for experimental slash command writes", async () => {
  const writes = []
  const store = {
    accounts: {},
    experimentalSlashCommandsEnabled: true,
  }
  const commonSettings = {
    experimentalSlashCommandsEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-experimental-slash-commands" },
    store,
    writeStore: async () => {},
    readCommonSettings: async () => commonSettings,
    writeCommonSettings: async (_next, meta) => {
      writes.push(meta)
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-experimental-slash-commands",
      source: "applyCommonSettingsAction",
      actionType: "toggle-experimental-slash-commands",
    },
  ])
})

test("persistAccountSwitch keeps active in sync while preserving activeAccountNames and updates lastUsed", async () => {
  const { persistAccountSwitch } = await import("../dist/plugin-actions.js")

  assert.equal(typeof persistAccountSwitch, "function")

  const at = 1_717_171_717_171
  const writes = []
  const store = {
    active: "old-account",
    activeAccountNames: ["old-account", "new-account"],
    lastAccountSwitchAt: 123,
    accounts: {
      "old-account": { name: "old-account", refresh: "r1", access: "a1", expires: 0, lastUsed: 10 },
      "new-account": { name: "new-account", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({
    store,
    name: "new-account",
    at,
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        activeAccountNames: next.activeAccountNames,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  assert.equal(store.active, "new-account")
  assert.deepEqual(store.activeAccountNames, ["old-account", "new-account"])
  assert.equal(store.accounts["new-account"].lastUsed, at)
  assert.equal(store.lastAccountSwitchAt, at)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      activeAccountNames: ["old-account", "new-account"],
      lastUsed: at,
      lastAccountSwitchAt: at,
    },
  ])

  const storeWithoutDefaultGroup = {
    active: "old-account",
    accounts: {
      "old-account": { name: "old-account", refresh: "r1", access: "a1", expires: 0, lastUsed: 10 },
      "new-account": { name: "new-account", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({
    store: storeWithoutDefaultGroup,
    name: "new-account",
    at,
    writeStore: async () => {},
  })

  assert.deepEqual(storeWithoutDefaultGroup.activeAccountNames, ["new-account"])
})

test("activateAddedAccount records switch metadata only after switch succeeds", async () => {
  const { activateAddedAccount } = await import("../dist/plugin.js")

  assert.equal(typeof activateAddedAccount, "function")

  const writes = []
  const metas = []
  const store = {
    active: "new-account",
    accounts: {
      "new-account": { name: "new-account", refresh: "r", access: "a", expires: 0 },
    },
  }

  await activateAddedAccount({
    store,
    name: "new-account",
    switchAccount: async () => {},
    writeStore: async (next, meta) => {
      writes.push({
        active: next.active,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
      metas.push(meta)
    },
    now: () => 1_717_171_717_171,
  })

  assert.equal(store.active, "new-account")
  assert.equal(store.accounts["new-account"].lastUsed, 1_717_171_717_171)
  assert.equal(store.lastAccountSwitchAt, 1_717_171_717_171)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      lastUsed: undefined,
      lastAccountSwitchAt: undefined,
    },
    {
      active: "new-account",
      lastUsed: 1_717_171_717_171,
      lastAccountSwitchAt: 1_717_171_717_171,
    },
  ])
  assert.deepEqual(metas, [
    {
      reason: "activate-added-account",
      source: "activateAddedAccount",
      actionType: "add",
    },
    {
      reason: "persist-account-switch",
      source: "persistAccountSwitch",
      actionType: "switch",
    },
  ])
})

test("copilot menu runtime keeps import-auth bootstrap semantics", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const writes = []
  const adapter = createCopilotMenuAdapter({
    client: { auth: { set: async () => {} } },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({
      "github-copilot": {
        name: "auth:github-copilot",
        refresh: "refresh-token",
        access: "access-token",
        expires: 0,
        user: "student",
        source: "auth",
        providerId: "github-copilot",
      },
    }),
    fetchUser: async () => ({ login: "student" }),
  })

  await runProviderMenu({
    adapter,
    showMenu: async () => ({ type: "cancel" }),
  })

  assert.equal(store.active, "auth:github-copilot")
  assert.equal(store.accounts["auth:github-copilot"]?.name, "auth:github-copilot")
  assert.equal(writes.length, 0)
})

test("copilot menu runtime switch-account keeps persistAccountSwitch semantics", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const authSetCalls = []
  const writes = []
  const store = {
    active: "main",
    activeAccountNames: ["main", "github.com:backup"],
    accounts: {
      main: { name: "main", refresh: "main-r", access: "main-a", expires: 0, user: "main" },
      "github.com:backup": { name: "github.com:backup", refresh: "backup-r", access: "backup-a", expires: 0, user: "backup" },
    },
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const adapter = createCopilotMenuAdapter({
    client: {
      auth: {
        set: async (input) => {
          authSetCalls.push(input)
        },
      },
    },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({}),
    showAccountActions: async () => "switch",
    now: () => 1_717_171_717_171,
  })
  const accounts = await adapter.toMenuInfo(store)
  const backup = accounts.find((account) => account.id === "github.com:backup")
  const actions = [
    { type: "switch", account: backup },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(backup?.name, "backup")
  assert.equal(authSetCalls.length, 1)
  assert.equal(store.active, "github.com:backup")
  assert.equal(store.accounts["github.com:backup"].lastUsed, 1_717_171_717_171)
  assert.deepEqual(writes, [
    {
      reason: "persist-account-switch",
      source: "persistAccountSwitch",
      actionType: "switch",
    },
  ])
})

test("copilot menu runtime shared add action keeps activateAddedAccount flow", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { activateAddedAccount } = await import("../dist/plugin.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const authSetCalls = []
  const writes = []
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const adapter = createCopilotMenuAdapter({
    client: {
      auth: {
        set: async (input) => {
          authSetCalls.push(input)
        },
      },
    },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({}),
    authorizeNewAccount: async () => ({
      name: "new-account",
      refresh: "new-r",
      access: "new-a",
      expires: 0,
      user: "new",
      source: "manual",
    }),
    activateAddedAccount,
    now: () => 1_717_171_717_171,
  })
  const actions = [
    { type: "add" },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(authSetCalls.length, 1)
  assert.equal(store.active, "new-account")
  assert.deepEqual(writes, [
    {
      reason: "activate-added-account",
      source: "activateAddedAccount",
      actionType: "add",
    },
    {
      reason: "persist-account-switch",
      source: "persistAccountSwitch",
      actionType: "switch",
    },
  ])
})

test("copilot menu runtime shared remove actions keep debug metadata", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const writes = []
  const store = {
    active: "main",
    activeAccountNames: ["main", "github.com:backup"],
    accounts: {
      main: { name: "main", refresh: "main-r", access: "main-a", expires: 0, user: "main" },
      "github.com:backup": { name: "github.com:backup", refresh: "backup-r", access: "backup-a", expires: 0, user: "backup" },
    },
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const adapter = createCopilotMenuAdapter({
    client: { auth: { set: async () => {} } },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({}),
    readCommonSettings: async () => ({
      networkRetryEnabled: store.networkRetryEnabled,
    }),
    writeCommonSettings: async (settings, meta) => {
      store.networkRetryEnabled = settings.networkRetryEnabled === true
      writes.push(meta)
    },
  })
  const accounts = await adapter.toMenuInfo(store)
  const backup = accounts.find((account) => account.id === "github.com:backup")
  const actions = [
    { type: "remove", account: backup },
    { type: "remove-all" },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(store.accounts, {})
  assert.deepEqual(writes, [
    {
      reason: "remove-account",
      source: "plugin.runMenu",
      actionType: "remove",
    },
    {
      reason: "remove-all",
      source: "plugin.runMenu",
      actionType: "remove-all",
    },
  ])
})

test("copilot menu runtime quota refresh and models refresh keep debug metadata", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const writes = []
  const store = {
    active: "main",
    accounts: {
      main: { name: "main", refresh: "main-r", access: "main-a", expires: 0, user: "main" },
    },
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const adapter = createCopilotMenuAdapter({
    client: { auth: { set: async () => {} } },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({}),
    fetchQuota: async () => ({ plan: "pro" }),
    fetchModels: async () => ({ available: ["gpt-5"], disabled: [] }),
    now: () => 1_717_171_717_171,
  })
  const actions = [
    { type: "provider", name: "quota-refresh" },
    { type: "provider", name: "check-models" },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(writes, [
    {
      reason: "quota-refresh",
      source: "plugin.runMenu",
      actionType: "quota",
    },
    {
      reason: "check-models",
      source: "plugin.runMenu",
      actionType: "check-models",
    },
  ])
})

test("copilot menu runtime toggle actions keep write semantics", async () => {
  const { runProviderMenu } = await import("../dist/menu-runtime.js")
  const { createCopilotMenuAdapter } = await import("../dist/providers/copilot-menu-adapter.js")

  const writes = []
  const commonSettings = {
    networkRetryEnabled: false,
  }
  const store = {
    active: "main",
    accounts: {
      main: { name: "main", refresh: "main-r", access: "main-a", expires: 0, user: "main" },
    },
    autoRefresh: false,
    refreshMinutes: 15,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }
  const adapter = createCopilotMenuAdapter({
    client: { auth: { set: async () => {} } },
    readStore: async () => store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
    readAuth: async () => ({}),
    readCommonSettings: async () => commonSettings,
    writeCommonSettings: async (settings, meta) => {
      commonSettings.networkRetryEnabled = settings.networkRetryEnabled === true
      writes.push(meta)
    },
  })
  const actions = [
    { type: "provider", name: "toggle-network-retry" },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(store.networkRetryEnabled, false)
  assert.equal(commonSettings.networkRetryEnabled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-network-retry",
      source: "applyCommonSettingsAction",
      actionType: "toggle-network-retry",
    },
  ])
})

test("plugin shared runtime action mapping excludes WeChat provider actions", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")
  const wechatActionPrefix = ["we", "chat"].join("")

  for (const needle of [
    `${wechatActionPrefix}-bind`,
    `${wechatActionPrefix}-rebind`,
    `toggle-${wechatActionPrefix}-notifications`,
    `toggle-${wechatActionPrefix}-question-notify`,
    `toggle-${wechatActionPrefix}-permission-notify`,
    `toggle-${wechatActionPrefix}-session-error-notify`,
    `${wechatActionPrefix}-export-debug-bundle`,
  ]) {
    assert.equal(pluginSource.includes(needle), false, needle)
  }
})

test("copilot provider adapter does not load WeChat flows", async () => {
  const copilotSource = await fs.readFile(new URL("../dist/providers/copilot-menu-adapter.js", import.meta.url), "utf8")
  const wechatActionPrefix = ["we", "chat"].join("")
  const forbiddenActionPattern = new RegExp([
    `${wechatActionPrefix}-bind`,
    `${wechatActionPrefix}-rebind`,
    `${wechatActionPrefix}-export-debug-bundle`,
    `toggle-${wechatActionPrefix}`,
  ].join("|"))

  assert.doesNotMatch(copilotSource, /\.\.\/wechat\//)
  assert.doesNotMatch(copilotSource, forbiddenActionPattern)
})

test("plugin auth loader default clearAccountSwitchContext reloads and persists matching switch timestamp", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const staleStore = {
    active: "stale-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "stale-account": { name: "stale-account", refresh: "r1", access: "a1", expires: 0 },
    },
    networkRetryEnabled: true,
  }
  const freshStore = {
    active: "fresh-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "fresh-account": { name: "fresh-account", refresh: "r2", access: "a2", expires: 0 },
    },
    networkRetryEnabled: true,
  }
  const writes = []
  let loads = 0
  let clearAccountSwitchContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => {
      loads += 1
      return loads === 1 ? staleStore : freshStore
    },
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      clearAccountSwitchContext = ctx?.clearAccountSwitchContext
      return fetch
    },
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        accountNames: Object.keys(next.accounts),
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof clearAccountSwitchContext, "function")
  await clearAccountSwitchContext()

  assert.equal(loads, 2)
  assert.equal(staleStore.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(freshStore.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [
    {
      active: "fresh-account",
      accountNames: ["fresh-account"],
      lastAccountSwitchAt: undefined,
    },
  ])
})

test("plugin auth loader default clearAccountSwitchContext logs minimal diagnostics on persist failure", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const warns = []
  let clearAccountSwitchContext
  const originalWarn = console.warn

  console.warn = (...args) => {
    warns.push(args)
  }

  try {
    const plugin = buildPluginHooks({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        active: "account",
        lastAccountSwitchAt: 1_717_171_717_171,
        accounts: {
          account: { name: "account", refresh: "r", access: "a", expires: 0 },
        },
        networkRetryEnabled: true,
      }),
      loadOfficialConfig: async () => ({
        baseURL: "https://api.githubcopilot.com",
        apiKey: "",
        fetch: officialFetch,
      }),
      createRetryFetch: (fetch, ctx) => {
        clearAccountSwitchContext = ctx?.clearAccountSwitchContext
        return fetch
      },
      writeStore: async () => {
        throw new Error("persist failed")
      },
    })

    await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
      models: {},
    })

    assert.equal(typeof clearAccountSwitchContext, "function")
    await clearAccountSwitchContext()
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warns.length, 1)
  assert.match(String(warns[0][0]), /plugin-hooks/i)
  assert.match(String(warns[0][0]), /clear account-switch context/i)
})

test("plugin auth loader notifier clears ttl-expired persisted switch context without changing wording", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    lastAccountSwitchAt: expiredSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.progress, "function")
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin switch flow prints retry hint after account switch", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /input\[\*\]\.id too long/)
  assert.match(pluginSource, /enable Copilot Network Retry from the menu/i)
})

test("plugin menu bridges common account actions through shared runtime", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /if \(action\.type === "add"\)\s*return \{ type: "add" \}/)
  assert.match(pluginSource, /if \(action\.type === "switch"\)\s*return \{ type: "switch", account: action\.account \}/)
  assert.match(pluginSource, /if \(action\.type === "remove"\)\s*return \{ type: "remove", account: action\.account \}/)
  assert.match(pluginSource, /if \(action\.type === "remove-all"\)\s*return \{ type: "remove-all" \}/)
  assert.doesNotMatch(pluginSource, /name: "add-account"/)
  assert.doesNotMatch(pluginSource, /name: "switch-account"/)
  assert.doesNotMatch(pluginSource, /name: "remove-account"/)
  assert.doesNotMatch(pluginSource, /name: "remove-all"/)
})

test("plugin source does not force promptAccountEntry on empty store bootstrap", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /if \(!Object\.entries\(store\.accounts\)\.length\)\s*\{\s*const \{ name, entry \} = await promptAccountEntry\(\[\]\)/)
})

test("package root only exposes plugin entry and internal subpath exposes helpers", async () => {
  const root = await import("../dist/index.js")
  const internal = await import("../dist/internal.js")

  assert.equal(typeof root.CopilotAccountSwitcher, "function")
  assert.equal("buildPluginHooks" in root, false)
  assert.equal("loadOfficialCopilotConfig" in root, false)
  assert.equal(typeof internal.buildPluginHooks, "function")
  assert.equal(typeof internal.loadOfficialCopilotConfig, "function")
})

test("provider descriptor includes required copilot fields", () => {
  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.key, "copilot")
  assert.deepEqual(COPILOT_PROVIDER_DESCRIPTOR.providerIDs, [
    "github-copilot",
    "github-copilot-enterprise",
  ])
  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.storeNamespace, "copilot")
  assert.ok(Array.isArray(COPILOT_PROVIDER_DESCRIPTOR.commands))
  assert.ok(Array.isArray(COPILOT_PROVIDER_DESCRIPTOR.menuEntries))
  assert.ok(Array.isArray(COPILOT_PROVIDER_DESCRIPTOR.capabilities))

  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.commands.includes("copilot-inject"), false)
  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.commands.includes("copilot-policy-all-models"), false)
  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.menuEntries.includes("toggle-loop-safety"), false)
  assert.equal(COPILOT_PROVIDER_DESCRIPTOR.capabilities.includes("loop-safety"), false)

  for (const command of ["copilot-status", "copilot-compact", "copilot-stop-tool"]) {
    assert.equal(COPILOT_PROVIDER_DESCRIPTOR.commands.includes(command), true)
  }
  for (const capability of ["auth", "chat-headers", "model-routing", "network-retry", "slash-commands"]) {
    assert.equal(COPILOT_PROVIDER_DESCRIPTOR.capabilities.includes(capability), true)
  }
})

test("provider registry global lookup remains copilot-scoped for providerID matching", () => {
  const descriptors = listProviderDescriptors()
  assert.equal(descriptors.length, 1)
  assert.equal(descriptors[0]?.key, "copilot")
  assert.equal(getProviderDescriptorByKey("copilot")?.key, "copilot")
  assert.equal(getProviderDescriptorByKey("codex"), undefined)
  assert.equal(getProviderDescriptorByProviderID("github-copilot")?.key, "copilot")
  assert.equal(getProviderDescriptorByProviderID("github-copilot-enterprise")?.key, "copilot")
  assert.equal(getProviderDescriptorByProviderID("openai"), undefined)
})

test("provider registry exposes only Copilot descriptor", async () => {
  const registry = await import(`../dist/provider-registry.js?provider-registry-${Date.now()}`)

  assert.equal(typeof registry.createProviderRegistry, "function")

  const providers = registry.createProviderRegistry({
    buildPluginHooks,
  })
  assert.equal(typeof providers?.then, "undefined")

  assert.equal(typeof providers?.copilot?.descriptor, "object")
  assert.equal(providers?.copilot?.descriptor?.auth?.provider, "github-copilot")
  assert.equal(providers?.codex, undefined)
})

test("provider registry maps descriptor capabilities into buildPluginHooks runtime options", async () => {
  const captured = []
  const registry = await import(`../dist/provider-registry.js?provider-runtime-${Date.now()}`)

  const providers = registry.createProviderRegistry({
    buildPluginHooks: (input) => {
      captured.push({
        provider: input.auth.provider,
        authLoaderMode: input.authLoaderMode,
        enableModelRouting: input.enableModelRouting,
        hasOfficialConfig: typeof input.loadOfficialConfig === "function",
        hasOfficialChatHeaders: typeof input.loadOfficialChatHeaders === "function",
        hasRetryFetch: typeof input.createRetryFetch === "function",
      })
      return {
        auth: input.auth,
      }
    },
  })

  assert.equal(providers.codex, undefined)
  providers.copilot.descriptor.buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
  })

  assert.deepEqual(captured, [
    {
      provider: "github-copilot",
      authLoaderMode: "copilot",
      enableModelRouting: true,
      hasOfficialConfig: true,
      hasOfficialChatHeaders: true,
      hasRetryFetch: true,
    },
  ])
})

test("github-copilot auth methods no longer include Codex entry", async () => {
  const { CopilotAccountSwitcher } = await import(`../dist/plugin.js?copilot-auth-${Date.now()}`)

  const plugin = await CopilotAccountSwitcher({
    client: {
      auth: {
        set: async () => {},
      },
    },
    directory: process.cwd(),
  })

  assert.equal(plugin.auth?.provider, "github-copilot")
  assert.deepEqual(plugin.auth?.methods?.map((method) => method.label), [
    "Manage GitHub Copilot accounts",
  ])
})

test("CopilotAccountSwitcher does not call WeChat broker or bridge seams when loaded", async () => {
  const { CopilotAccountSwitcher } = await import(`../dist/plugin.js?copilot-wechat-absence-${Date.now()}`)
  const calls = []

  await CopilotAccountSwitcher({
    client: createBridgeCapablePluginClient(),
    directory: `${process.cwd()}-wechat-absence-${Date.now()}`,
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => {
      calls.push("ensureWechatBrokerStarted")
      return { endpoint: "fake-endpoint" }
    },
    createWechatBridgeLifecycleImpl: async () => {
      calls.push("createWechatBridgeLifecycleImpl")
      return { close: async () => {} }
    },
  })

  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(calls, [])
})

test("provider descriptor contract keeps Copilot assembled without Codex facade", async () => {
  const descriptors = await import(`../dist/provider-descriptor.js?provider-descriptor-${Date.now()}`)

  assert.equal("CODEX_PROVIDER_DESCRIPTOR" in descriptors, false)
  assert.equal(typeof descriptors.createCopilotProviderDescriptor, "function")
  assert.equal("createCodexProviderDescriptor" in descriptors, false)

  const copilot = descriptors.createCopilotProviderDescriptor({
    buildPluginHooks,
  })

  assert.equal(copilot.auth.provider, "github-copilot")
})



