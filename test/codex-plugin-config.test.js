import test from "node:test"
import assert from "node:assert/strict"

import { buildPluginHooks as buildPluginHooksRaw } from "../dist/plugin-hooks.js"
import { buildAccountActionItems, buildMenuItems } from "../dist/ui/menu.js"

function buildPluginHooks(input = {}) {
  return buildPluginHooksRaw({
    ...input,
  })
}

test("experimental slash commands enabled registers codex-status", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
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

  assert.equal(typeof config.command["codex-status"], "object")
  assert.match(config.command["codex-status"].description, /Codex|status/i)
})

test("experimental slash commands disabled leaves codex-status unregistered", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
        experimentalSlashCommandsEnabled: false,
    }),
    loadStore: async () => ({
      accounts: {},
        experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = {
    command: {
      "codex-status": {
        description: "preloaded command from base config",
        template: "preloaded",
      },
    },
  }
  await plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "codex-status"), true)
  assert.equal(config.command["codex-status"].description, "preloaded command from base config")
})

test("codex-status command hook delegates only when experiment switch enabled", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
        experimentalSlashCommandsEnabled: true,
    }),
    handleCodexStatusCommandImpl: async () => {
      delegated.push("called")
      throw new Error("codex delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "codex-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /codex delegated/,
  )
  assert.deepEqual(delegated, ["called"])
})

test("codex-status command hook does not delegate when experiment switch disabled", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
        experimentalSlashCommandsEnabled: false,
    }),
    handleCodexStatusCommandImpl: async () => {
      delegated.push("called")
      throw new Error("should not delegate")
    },
  })

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "codex-status", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))
  assert.deepEqual(delegated, [])
})

test("codex-status hook does not use copilot quota refresh path", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
        experimentalSlashCommandsEnabled: true,
    }),
    refreshQuota: async () => {
      throw new Error("copilot refresh should not run")
    },
    handleCodexStatusCommandImpl: async () => {
      throw new Error("codex delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "codex-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /codex delegated/,
  )
})

test("codex menu path keeps common settings and hides provider-specific Copilot actions", async () => {
  const items = buildMenuItems({
    provider: "codex",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("从 auth.json 导入"), false)
  assert.equal(labels.includes("同步账号身份信息"), false)
  assert.equal(labels.includes("同步可用模型列表"), false)
  assert.equal(labels.includes("配置默认账号组"), false)
  assert.equal(labels.includes("为模型配置账号组"), false)
  assert.equal(labels.includes("Guided Loop Safety：已关闭"), false)
  assert.equal(labels.includes("Policy 默认注入范围：仅当前 provider"), false)
  assert.equal(labels.includes("实验性 Slash Commands：已开启"), true)
  assert.equal(labels.includes("Network Retry：已关闭"), true)
  assert.equal(labels.includes("synthetic 消息按 agent 身份发送：已开启"), false)
  assert.equal(labels.includes("添加账号"), true)
  assert.equal(labels.includes("刷新快照"), true)
})

test("showAccountActions keeps Codex account submenu free of Copilot-only wording", () => {
  const account = {
    name: "codex@example.com",
    index: 0,
    plan: "team",
    quota: {
      premium: { remaining: 42, entitlement: 100 },
      chat: { remaining: 6, entitlement: 100 },
    },
  }

  const items = buildAccountActionItems(account, { provider: "codex" })
  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("View models"), false)
  assert.equal(labels.includes("Switch to this account"), true)
  assert.equal(labels.includes("Remove this account"), true)
})

test("codex set-interval empty input should not coerce to one minute", async () => {
  const { createCodexMenuAdapter } = await import("../dist/providers/codex-menu-adapter.js")
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: {
      auth: {
        set: async () => {},
      },
    },
    promptText: async () => "",
  })

  const changed = await adapter.applyAction(store, { type: "provider", name: "set-interval" })
  assert.equal(changed, false)
  assert.equal(store.refreshMinutes, 15)
})

test("codex official adapter can be referenced by provider assembly hook input", async () => {
  const { loadOfficialCodexConfig } = await import("../dist/upstream/codex-loader-adapter.js")
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadOfficialConfig: loadOfficialCodexConfig,
  })

  assert.equal(typeof loadOfficialCodexConfig, "function")
  assert.equal(plugin.auth.provider, "openai")
})
