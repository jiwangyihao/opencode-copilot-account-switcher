import test from "node:test"
import assert from "node:assert/strict"

async function loadMenuModuleOrFail() {
  try {
    return await import("../dist/ui/menu.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("menu module is missing: ../dist/ui/menu.js")
    }
    throw error
  }
}

async function loadMenuRuntimeOrFail() {
  try {
    return await import("../dist/menu-runtime.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("menu runtime module is missing: ../dist/menu-runtime.js")
    }
    throw error
  }
}

test("wechat entry is under common settings and detailed wechat actions are not on main menu", async () => {
  const { buildMenuItems } = await loadMenuModuleOrFail()
  const items = buildMenuItems({
    provider: "copilot",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: false,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: false,
    language: "zh",
  })

  const labels = items.map((item) => item.label)
  const commonHeading = labels.indexOf("通用设置")
  const commonEnd = items.findIndex((item, index) => index > commonHeading && item.separator === true)
  const wechatEntry = labels.indexOf("微信通知")

  assert.notEqual(commonHeading, -1)
  assert.notEqual(commonEnd, -1)
  assert.notEqual(wechatEntry, -1)
  assert.equal(wechatEntry > commonHeading, true)
  assert.equal(wechatEntry < commonEnd, true)
  assert.equal(labels.includes("绑定 / 重绑微信"), false)
  assert.equal(labels.includes("微信通知总开关：已开启"), false)
  assert.equal(labels.includes("问题通知：已关闭"), false)
  assert.equal(labels.includes("权限通知：已开启"), false)
  assert.equal(labels.includes("会话错误通知：已关闭"), false)
})

test("wechat submenu selection returns explicit wechat-bind action", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const menuCalls = []

  const result = await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: false,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: false,
    language: "zh",
  }, {
    select: async (items) => {
      menuCalls.push(items.map((item) => item.label))
      if (menuCalls.length === 1) return { type: "wechat-menu" }
      if (menuCalls.length === 2) return { type: "wechat-bind" }
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
  })

  assert.equal(menuCalls.length, 2)
  assert.equal(menuCalls[0].includes("绑定 / 重绑微信"), false)
  assert.equal(menuCalls[1].includes("绑定 / 重绑微信"), true)
  assert.equal(menuCalls[1].includes("微信通知总开关：已开启"), true)
  assert.equal(menuCalls[1].includes("问题通知：已关闭"), true)
  assert.equal(menuCalls[1].includes("权限通知：已开启"), true)
  assert.equal(menuCalls[1].includes("会话错误通知：已关闭"), true)
  assert.deepEqual(result, { type: "wechat-bind" })
})

test("wechat submenu shows bound account info and hides internal baseUrl", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const calls = []

  await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: true,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: true,
    wechatPrimaryBinding: {
      accountId: "acc-main",
      name: "主账号",
      enabled: true,
      configured: true,
      userId: "user-1",
      boundAt: 1711000000000,
      baseUrl: "https://internal.example",
    },
    language: "zh",
  }, {
    select: async (items) => {
      calls.push(items.map((item) => item.label))
      if (calls.length === 1) return { type: "wechat-menu" }
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
  })

  assert.equal(calls.length, 3)
  const labels = calls[1]
  assert.equal(labels.some((label) => label.includes("当前绑定账号")), true)
  assert.equal(labels.some((label) => label.includes("acc-main")), true)
  assert.equal(labels.some((label) => label.includes("主账号")), true)
  assert.equal(labels.some((label) => label.includes("user-1")), true)
  assert.equal(labels.some((label) => label.includes("baseUrl")), false)
  assert.equal(labels.some((label) => label.includes("internal.example")), false)
})

test("wechat submenu treats operator binding as bound when settings binding is missing", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const calls = []

  const result = await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: true,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: true,
    wechatOperatorBinding: {
      wechatAccountId: "acc-op-only",
      userId: "user-op",
      boundAt: 1713000000000,
    },
    language: "zh",
  }, {
    select: async (items) => {
      calls.push(items.map((item) => item.label))
      if (calls.length === 1) return { type: "wechat-menu" }
      if (calls.length === 2) return { type: "wechat-rebind" }
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
  })

  assert.deepEqual(result, { type: "wechat-rebind" })
  const labels = calls[1]
  assert.equal(labels.some((label) => label.includes("当前绑定账号")), true)
  assert.equal(labels.some((label) => label.includes("acc-op-only")), true)
  assert.equal(labels.some((label) => label.includes("user-op")), true)
})

test("wechat submenu hydrates binding details from settings/operator deps when menu input omits them", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const calls = []

  const result = await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: true,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: true,
    language: "zh",
  }, {
    select: async (items) => {
      calls.push(items.map((item) => item.label))
      if (calls.length === 1) return { type: "wechat-menu" }
      if (calls.length === 2) return { type: "wechat-rebind" }
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
    readCommonSettings: async () => ({
      wechat: {
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
        primaryBinding: {
          accountId: "acc-from-settings",
          userId: "user-from-settings",
          name: "settings account",
          enabled: true,
          configured: true,
          boundAt: 1715000000000,
        },
      },
    }),
    readOperatorBinding: async () => ({
      wechatAccountId: "acc-from-operator",
      userId: "user-from-operator",
      boundAt: 1715000000001,
    }),
  })

  assert.deepEqual(result, { type: "wechat-rebind" })
  const labels = calls[1]
  assert.equal(labels.some((label) => label.includes("当前绑定账号")), true)
  assert.equal(labels.some((label) => label.includes("acc-from-settings")), true)
  assert.equal(labels.some((label) => label.includes("settings account")), true)
  assert.equal(labels.some((label) => label.includes("user-from-settings")), true)
  assert.equal(labels.some((label) => label.includes("acc-from-operator")), false)
})

test("wechat submenu cancel returns to main menu and keeps back behavior stable", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const calls = []

  const result = await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    language: "zh",
  }, {
    select: async (items) => {
      calls.push(items.map((item) => item.label))
      if (calls.length === 1) return { type: "wechat-menu" }
      if (calls.length === 2) return null
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
  })

  assert.equal(calls.length, 3)
  assert.equal(calls[0].includes("微信通知"), true)
  assert.equal(calls[1].includes("绑定 / 重绑微信"), true)
  assert.equal(calls[2].includes("微信通知"), true)
  assert.deepEqual(result, { type: "cancel" })
})

test("wechat bind menu action maps to explicit provider action", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const called = []
  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async () => {},
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async (_store, action) => {
      called.push(action.name)
      return action.name === "wechat-bind"
    },
  }

  const actions = [
    { type: "provider", name: "wechat-bind" },
    { type: "cancel" },
  ]
  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(called, ["wechat-bind"])
})

test("wechat bind action does not trigger provider store persistence", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const writes = []
  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async (_store, meta) => {
      writes.push(meta)
    },
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async (_store, action) => action.name === "wechat-bind",
  }

  const actions = [
    { type: "provider", name: "wechat-bind" },
    { type: "cancel" },
  ]
  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(writes.some((meta) => meta?.actionType === "wechat-bind"), false)
  assert.equal(writes.some((meta) => String(meta?.reason ?? "").includes("wechat-bind")), false)
})

test("wechat debug bundle menu prompts for mode and returns explicit action", async () => {
  const { showMenuWithDeps } = await loadMenuModuleOrFail()
  const menuCalls = []

  const result = await showMenuWithDeps([], {
    provider: "copilot",
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: true,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: true,
    language: "zh",
  }, {
    select: async (items) => {
      menuCalls.push(items.map((item) => item.label))
      if (menuCalls.length === 1) return { type: "wechat-menu" }
      if (menuCalls.length === 2) return { type: "wechat-export-debug-bundle-menu" }
      if (menuCalls.length === 3) return { type: "wechat-export-debug-bundle", mode: "sanitized" }
      return { type: "cancel" }
    },
    confirm: async () => true,
    showAccountActions: async () => "back",
  })

  assert.equal(menuCalls.length, 3)
  assert.equal(menuCalls[1].includes("导出微信调试包"), true)
  assert.equal(menuCalls[2].includes("脱敏包"), true)
  assert.equal(menuCalls[2].includes("完整包"), true)
  assert.deepEqual(result, { type: "wechat-export-debug-bundle", mode: "sanitized" })
})

test("wechat-export-debug-bundle action stays non-persistent in menu runtime", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const writes = []
  const called = []
  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async (_store, meta) => {
      writes.push(meta)
    },
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async (_store, action) => {
      called.push(action)
      return action.name === "wechat-export-debug-bundle"
    },
  }

  const actions = [
    { type: "provider", name: "wechat-export-debug-bundle", payload: { mode: "sanitized" } },
    { type: "cancel" },
  ]
  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(called, [{ type: "provider", name: "wechat-export-debug-bundle", payload: { mode: "sanitized" } }])
  assert.equal(writes.some((meta) => meta?.actionType === "wechat-export-debug-bundle"), false)
  assert.equal(writes.some((meta) => String(meta?.reason ?? "").includes("wechat-export-debug-bundle")), false)
})

test("wechat-export-debug-bundle action preserves structured result in menu runtime", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const outputs = []
  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async () => {},
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async () => ({
      handled: true,
      result: {
        mode: "sanitized",
        bundlePath: "C:/temp/wechat-debug-bundle-sanitized.zip",
        message: "微信调试包已生成：C:/temp/wechat-debug-bundle-sanitized.zip",
      },
    }),
  }

  const actions = [
    { type: "provider", name: "wechat-export-debug-bundle", payload: { mode: "sanitized" } },
    { type: "cancel" },
  ]
  const current = await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
    onProviderActionResult: async (output) => {
      outputs.push(output)
    },
  })

  assert.deepEqual(outputs, [{
    name: "wechat-export-debug-bundle",
    payload: { mode: "sanitized" },
    result: {
      mode: "sanitized",
      bundlePath: "C:/temp/wechat-debug-bundle-sanitized.zip",
      message: "微信调试包已生成：C:/temp/wechat-debug-bundle-sanitized.zip",
    },
  }])
  assert.deepEqual(current, { name: "alpha" })
})
