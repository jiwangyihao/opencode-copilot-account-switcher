import assert from "node:assert/strict"
import test from "node:test"

import { buildAccountActionItems, buildMenuItems, getMenuCopy, showMenuWithDeps } from "../dist/ui/menu.js"

test("getMenuCopy returns Chinese copy by default", () => {
  const copy = getMenuCopy()

  assert.equal(copy.menuTitle, "GitHub Copilot 账号")
  assert.equal(copy.switchLanguageLabel, "Switch to English")
})

test("getMenuCopy returns English copy when requested", () => {
  const copy = getMenuCopy("en")

  assert.equal(copy.menuTitle, "GitHub Copilot accounts")
  assert.equal(copy.switchLanguageLabel, "切换到中文")
})

test("root Copilot menu copy no longer exposes Codex provider title", () => {
  const copy = getMenuCopy("en")

  assert.equal(copy.menuTitle, "GitHub Copilot accounts")
})

test("getMenuCopy keeps network retry copy provider-agnostic for Copilot", () => {
  const enCopy = getMenuCopy("en", "copilot")
  const zhCopy = getMenuCopy("zh", "copilot")

  assert.doesNotMatch(enCopy.retryOff, /Copilot/i)
  assert.doesNotMatch(zhCopy.retryOff, /Copilot/i)
})

test("buildMenuItems does not expose WeChat actions", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
  })

  const actionTypes = items
    .map((item) => item.value?.type)
    .filter((type) => typeof type === "string")
  assert.deepEqual(actionTypes.filter((type) => /wechat/i.test(type)), [])
})

test("buildMenuItems no longer renders Loop Safety rows", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    capabilities: { networkRetry: true },
    networkRetryEnabled: true,
    language: "en",
  })

  const labels = items.map((item) => item.label).join("\n")
  assert.equal(/Guided Loop Safety|Policy (?:default )?scope|copilot-inject|copilot-policy-all-models/i.test(labels), false)
})

test("buildMenuItems shows default experimental slash command state when value is omitted", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: On")
  assert.ok(toggle)
})

test("buildMenuItems shows experimental slash command off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /copilot-status/)
  assert.equal((toggle?.hint ?? "").includes("copilot-inject"), false)
  assert.equal((toggle?.hint ?? "").includes("copilot-policy-all-models"), false)
})

test("experimental slash commands toggle is placed before network retry in common settings", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const commonHeadingIndex = labels.indexOf("Common settings")
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Network Retry: Off")

  assert.equal(slashIndex, commonHeadingIndex + 1)
  assert.equal(retryIndex, slashIndex + 1)
})

test("buildMenuItems shows Network Retry off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Network Retry: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /recover/i)
})

test("buildMenuItems shows Network Retry on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Network Retry: On")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /recover/i)
})

test("Copilot network retry toggle is placed after slash toggle in common settings", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Network Retry: Off")
  const commonHeadingIndex = labels.indexOf("Common settings")
  const separatorIndices = items
    .map((item, index) => (item.separator === true ? index : -1))
    .filter((index) => index >= 0)
  const commonSectionEnd = separatorIndices.find((index) => index > commonHeadingIndex) ?? -1

  assert.notEqual(slashIndex, -1)
  assert.notEqual(retryIndex, -1)
  assert.notEqual(commonSectionEnd, -1)
  assert.equal(retryIndex, slashIndex + 1)
  assert.equal(retryIndex < commonSectionEnd, true)
})

test("assign models action is placed after default account group", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const modelsIndex = labels.indexOf("Sync available models")
  const defaultGroupIndex = labels.indexOf("Default account group")
  const assignIndex = labels.indexOf("Assign account groups per model")

  assert.equal(defaultGroupIndex, modelsIndex + 1)
  assert.equal(assignIndex, defaultGroupIndex + 1)
})

test("buildMenuItems uses the updated action copy for sync-oriented items", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  assert.ok(labels.includes("Refresh quota info"))
  assert.ok(labels.includes("Sync account identity"))
  assert.ok(labels.includes("Sync available models"))
  assert.ok(labels.includes("Assign account groups per model"))
})

test("buildMenuItems shows default account group action with coherent hint", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
    defaultAccountGroupCount: 2,
  })

  const action = items.find((item) => item.label === "Default account group")
  assert.ok(action)
  assert.equal(action?.hint, "2 selected")
})

test("buildMenuItems keeps model assignment hint coherent for account groups", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
    language: "en",
    modelAccountAssignmentCount: 3,
  })

  const action = items.find((item) => item.label === "Assign account groups per model")
  assert.ok(action)
  assert.equal(action?.hint, "3 groups")
})

test("buildMenuItems shows synthetic initiator off state and risk hint when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Send synthetic messages as agent: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /upstream/i)
  assert.match(toggle?.hint ?? "", /billing risk/i)
  assert.match(toggle?.hint ?? "", /abuse/i)
})

test("buildMenuItems shows synthetic initiator on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Send synthetic messages as agent: On")
  assert.ok(toggle)
})

test("synthetic initiator toggle is placed after network retry and before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const retryIndex = labels.indexOf("Network Retry: Off")
  const syntheticIndex = labels.indexOf("Send synthetic messages as agent: Off")
  const providerHeadingIndex = labels.indexOf("Provider settings")
  const separatorIndices = items
    .map((item, index) => (item.separator === true ? index : -1))
    .filter((index) => index >= 0)
  const providerSectionEnd = separatorIndices.find((index) => index > providerHeadingIndex) ?? -1

  assert.notEqual(retryIndex, -1)
  assert.notEqual(syntheticIndex, -1)
  assert.notEqual(providerSectionEnd, -1)
  assert.equal(syntheticIndex > retryIndex, true)
  assert.equal(syntheticIndex < providerSectionEnd, true)
})

test("buildMenuItems includes a language switch action", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    networkRetryEnabled: false,
  })

  const toggle = items.find((item) => item.label === "Switch to English")
  assert.ok(toggle)
})

test("experimental slash commands hint includes compact and stop-tool commands", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    experimentalSlashCommandsEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /copilot-compact/)
  assert.match(toggle?.hint ?? "", /copilot-stop-tool/)
})

test("buildMenuItems keeps section order stable for Copilot", () => {
  const items = buildMenuItems({
    provider: "copilot",
    accounts: [{ name: "alice", index: 0 }],
    refresh: { enabled: false, minutes: 15 },
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const actionsHeadingIndex = labels.indexOf("Actions")
  const commonHeadingIndex = labels.indexOf("Common settings")
  const providerHeadingIndex = labels.indexOf("Provider settings")
  const accountsHeadingIndex = labels.indexOf("Accounts")
  const dangerHeadingIndex = labels.indexOf("Danger zone")

  assert.notEqual(actionsHeadingIndex, -1)
  assert.notEqual(commonHeadingIndex, -1)
  assert.notEqual(providerHeadingIndex, -1)
  assert.notEqual(accountsHeadingIndex, -1)
  assert.notEqual(dangerHeadingIndex, -1)
  assert.equal(actionsHeadingIndex < commonHeadingIndex, true)
  assert.equal(commonHeadingIndex < providerHeadingIndex, true)
  assert.equal(providerHeadingIndex < accountsHeadingIndex, true)
  assert.equal(accountsHeadingIndex < dangerHeadingIndex, true)
})

test("buildAccountActionItems keeps account submenu actions stable", () => {
  const items = buildAccountActionItems({
    name: "copilot-main",
    index: 0,
    plan: "team",
    modelList: {
      available: ["gpt-5"],
      disabled: [],
    },
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("View models"), true)
  assert.equal(labels.includes("Switch to this account"), true)
  assert.equal(labels.includes("Remove this account"), true)
})

test("showMenu routes account click into account submenu before returning runtime action", async () => {
  const account = { name: "alpha", index: 0 }
  const selected = []
  const submenu = []
  const menuSelections = [
    { type: "switch", account },
    { type: "cancel" },
  ]

  const result = await showMenuWithDeps([account], { provider: "copilot" }, {
    select: async () => {
      const next = menuSelections.shift() ?? { type: "cancel" }
      selected.push(next.type)
      return next
    },
    showAccountActions: async (nextAccount, input) => {
      submenu.push({ name: nextAccount.name, provider: input.provider })
      return "back"
    },
    confirm: async () => true,
  })

  assert.deepEqual(selected, ["switch", "cancel"])
  assert.deepEqual(submenu, [{ name: "alpha", provider: "copilot" }])
  assert.deepEqual(result, { type: "cancel" })
})

test("showMenu maps account submenu remove to remove action", async () => {
  const account = { name: "alpha", index: 0 }

  const result = await showMenuWithDeps([account], { provider: "copilot" }, {
    select: async () => ({ type: "switch", account }),
    showAccountActions: async () => "remove",
    confirm: async () => true,
  })

  assert.deepEqual(result, { type: "remove", account })
})

test("showMenu keeps Copilot account submenu dispatch", async () => {
  const account = { name: "alpha", index: 0 }
  const providers = []

  const menuSelections = [
    { type: "switch", account },
    { type: "cancel" },
  ]
  await showMenuWithDeps([account], { provider: "copilot" }, {
    select: async () => menuSelections.shift() ?? { type: "cancel" },
    showAccountActions: async (_account, input) => {
      providers.push(input.provider)
      return "back"
    },
    confirm: async () => true,
  })

  assert.deepEqual(providers, ["copilot"])
})

test("buildMenuItems shows workspaceName first in account hint", () => {
  const items = buildMenuItems({
    accounts: [{
      name: "acct_workspace",
      index: 0,
      workspaceName: "workspace-visible",
      plan: "team",
      quota: {
        premium: { remaining: 42, entitlement: 100 },
        chat: { remaining: 6, entitlement: 100 },
      },
    }],
    refresh: { enabled: false, minutes: 15 },
  })

  const accountItem = items.find((item) => item.label.includes("acct_workspace"))
  assert.equal(accountItem?.hint, "workspace-visible • team")
})
