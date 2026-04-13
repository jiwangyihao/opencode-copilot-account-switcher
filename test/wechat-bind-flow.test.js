import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

async function loadBindFlowOrFail() {
  try {
    const bindFlow = await import("../dist/wechat/bind-flow.js")
    return {
      ...bindFlow,
      runWechatBindFlow(input) {
        return bindFlow.runWechatBindFlow({
          ...input,
          writeLine: input?.writeLine ?? (async () => {}),
        })
      },
    }
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("wechat bind flow module is missing: ../dist/wechat/bind-flow.js")
    }
    throw error
  }
}

test("wechat bind flow lazy-loads qrcode-terminal", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../dist/wechat/bind-flow.js", import.meta.url), "utf8"),
  )

  assert.doesNotMatch(source, /import qrcodeTerminal from "qrcode-terminal"/)
  assert.match(source, /loadQrCodeTerminal\(\)/)
})

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

test("wechat-bind action triggers real flow and keeps menu running", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const bindFlow = await loadBindFlowOrFail()

  let showMenuCalls = 0
  let bindCalls = 0

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
      if (action.name !== "wechat-bind") return false
      bindCalls += 1
      await bindFlow.runWechatBindFlow({
        action: "wechat-bind",
        loadPublicHelpers: async () => ({
          latestAccountState: { accountId: "acc-flow", token: "token", baseUrl: "https://internal.example" },
          qrGateway: {
            loginWithQrStart: () => ({ sessionKey: "s1", qrDataUrl: "https://example.test/qr-flow" }),
            loginWithQrWait: () => ({ connected: true, accountId: "acc-flow", userId: "user-flow" }),
          },
          accountHelpers: {
            listAccountIds: async () => ["acc-flow"],
            resolveAccount: async () => ({ enabled: true, name: "Flow Account", userId: "user-flow" }),
            describeAccount: async () => ({ configured: true }),
          },
        }),
        bindOperator: async () => ({ wechatAccountId: "acc-flow", userId: "user-flow", boundAt: 1710000000000 }),
        readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
        writeCommonSettings: async () => {},
        now: () => 1710000000000,
      })
      return true
    },
  }

  const actions = [{ type: "provider", name: "wechat-bind" }, { type: "cancel" }]
  await runProviderMenu({
    adapter,
    showMenu: async () => {
      showMenuCalls += 1
      return actions.shift() ?? { type: "cancel" }
    },
  })

  assert.equal(bindCalls, 1)
  assert.equal(showMenuCalls, 2)
})

test("wechat bind flow writes binding status to common settings", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const writes = []
  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-1", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-1", qrDataUrl: "https://example.test/qr-1" }),
        loginWithQrWait: () => ({ connected: true, accountId: "acc-1", userId: "user-1" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-1"],
          resolveAccount: async () => ({ enabled: true, name: "主账号", userId: "user-1" }),
        describeAccount: async () => ({ configured: true }),
      },
    }),
    bindOperator: async (binding) => binding,
    readCommonSettings: async () => ({
      wechat: {
        notifications: {
          enabled: true,
          question: false,
          permission: true,
          sessionError: false,
        },
      },
    }),
    writeCommonSettings: async (settings) => {
      writes.push(settings)
    },
    now: () => 1711000000000,
  })

  assert.equal(result.accountId, "acc-1")
  assert.equal(result.userId, "user-1")
  assert.equal(result.name, "主账号")
  assert.equal(result.enabled, true)
  assert.equal(result.configured, true)
  assert.equal(result.boundAt, 1711000000000)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].wechat.primaryBinding, {
    accountId: "acc-1",
    userId: "user-1",
    name: "主账号",
    enabled: true,
    configured: true,
    boundAt: 1711000000000,
  })
})

test("wechat bind flow persists latest account state for runtime polling", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()
  const isolated = await setupIsolatedWechatStateRoot("wechat-bind-flow-account-state-")

  try {
    await runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-runtime", qrDataUrl: "https://example.test/qr-runtime" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-runtime", userId: "user-runtime", botToken: "token-runtime", baseUrl: "https://runtime.example" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-runtime"],
          resolveAccount: async () => ({ enabled: true, name: "Runtime Account", userId: "user-runtime" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1711000001234,
    })

    const latestAccountPath = path.join(isolated.stateRoot, "latest-account.json")
    const latestAccount = JSON.parse(await readFile(latestAccountPath, "utf8"))
    assert.deepEqual(latestAccount, {
      accountId: "acc-runtime",
      token: "token-runtime",
      baseUrl: "https://runtime.example",
    })
  } finally {
    await isolated.restore()
  }
})

test("wechat bind flow throws explicit error when binding fails", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-err", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-err", qrDataUrl: "https://example.test/qr-err" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-err", userId: "user-err" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-err"],
          resolveAccount: async () => ({ enabled: true, name: "Err Account", userId: "user-err" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        throw new Error("operator already bound to another user")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1712000000000,
    }),
    /wechat bind failed: operator already bound to another user/i,
  )
})

test("wechat bind flow does not clear binding when bindOperator precheck fails", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let rollbackCalled = 0
  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-bind-side-effect", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-bind-side-effect", qrDataUrl: "https://example.test/qr-bind-side-effect" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-bind-side-effect", userId: "user-bind-side-effect" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-bind-side-effect"],
          resolveAccount: async () => ({ enabled: true, name: "Bind Side Effect", userId: "user-bind-side-effect" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        throw new Error("precheck rejected before write")
      },
      resetOperatorBinding: async () => {
        rollbackCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1712500000000,
    }),
    /wechat bind failed: precheck rejected before write/i,
  )

  assert.equal(rollbackCalled, 0)
})

test("wechat bind flow rolls back when bindOperator throws after partial persist", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let rollbackCalled = 0
  let persistedBinding
  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-bind-partial", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-bind-partial", qrDataUrl: "https://example.test/qr-bind-partial" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-bind-partial", userId: "user-bind-partial" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-bind-partial"],
          resolveAccount: async () => ({ enabled: true, name: "Bind Partial", userId: "user-bind-partial" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => {
        persistedBinding = { ...binding }
        throw new Error("bind partially persisted before failure")
      },
      readOperatorBinding: async () => persistedBinding,
      resetOperatorBinding: async () => {
        rollbackCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1712500000001,
    }),
    /wechat bind failed: bind partially persisted before failure/i,
  )

  assert.equal(rollbackCalled, 1)
})

test("wechat rebind flow uses rebindOperator branch and keeps old binding on failure", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let bindCalled = 0
  let rebindCalled = 0
  let writeCalled = 0

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-rb", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-rb", qrDataUrl: "https://example.test/qr-rb" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-rb", userId: "user-rb" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-rb"],
          resolveAccount: async () => ({ enabled: true, name: "RB Account", userId: "user-rb" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        bindCalled += 1
        throw new Error("bind path should not be used for rebind")
      },
      rebindOperator: async () => {
        rebindCalled += 1
        throw new Error("rebind rejected by upstream")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        writeCalled += 1
      },
      now: () => 1713000000000,
    }),
    /wechat rebind failed: rebind rejected by upstream/i,
  )

  assert.equal(bindCalled, 0)
  assert.equal(rebindCalled, 1)
  assert.equal(writeCalled, 0)
})

test("wechat rebind flow restores previous binding if rebindOperator writes then throws", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const previousBinding = {
    wechatAccountId: "acc-prev-side-effect",
    userId: "user-prev-side-effect",
    boundAt: 1713499999999,
  }
  const rebindCalls = []
  let persistedBinding

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-next-side-effect", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-next-side-effect", qrDataUrl: "https://example.test/qr-next-side-effect" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-next-side-effect", userId: "user-next-side-effect" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-next-side-effect"],
          resolveAccount: async () => ({ enabled: true, name: "Rebind Side Effect", userId: "user-next-side-effect" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      rebindOperator: async (binding) => {
        rebindCalls.push({ ...binding })
        if (rebindCalls.length === 1) {
          persistedBinding = { ...binding }
          throw new Error("rebind wrote state before failing")
        }
        return binding
      },
      readOperatorBinding: async () => persistedBinding ?? previousBinding,
      resetOperatorBinding: async () => {
        assert.fail("rebind rollback should restore previous binding instead of reset")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1713500000000,
    }),
    /wechat rebind failed: rebind wrote state before failing/i,
  )

  assert.deepEqual(rebindCalls, [
    { wechatAccountId: "acc-next-side-effect", userId: "user-next-side-effect", boundAt: 1713500000000 },
    previousBinding,
  ])
})

test("wechat bind and rebind keep consistent explicit error prefix", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-a", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-a", qrDataUrl: "https://example.test/qr-a" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-a", userId: "user-a" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-a"],
          resolveAccount: async () => ({ enabled: true, name: "A", userId: "user-a" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        throw new Error("operator write failed")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1714000000000,
    }),
    /wechat bind failed: operator write failed/i,
  )

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-b", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-b", qrDataUrl: "https://example.test/qr-b" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-b", userId: "user-b" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-b"],
          resolveAccount: async () => ({ enabled: true, name: "B", userId: "user-b" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      rebindOperator: async () => {
        throw new Error("operator write failed")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1714000000001,
    }),
    /wechat rebind failed: operator write failed/i,
  )
})

test("writeCommonSettings failure rolls back operator binding for retry safety", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let bindCalled = 0
  let rollbackCalled = 0
  let persistedBinding

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-rb2", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-rb2", qrDataUrl: "https://example.test/qr-rb2" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-rb2", userId: "user-rb2" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-rb2"],
          resolveAccount: async () => ({ enabled: true, name: "Rollback Account", userId: "user-rb2" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => {
        bindCalled += 1
        persistedBinding = { ...binding }
        return binding
      },
      readOperatorBinding: async () => persistedBinding,
      resetOperatorBinding: async () => {
        rollbackCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        throw new Error("disk full")
      },
      now: () => 1715000000000,
    }),
    /wechat bind failed: disk full/i,
  )

  assert.equal(bindCalled, 1)
  assert.equal(rollbackCalled, 1)
})

test("writeCommonSettings failure in rebind restores previous operator binding", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const rebindCalls = []
  let resetCalled = 0
  let persistedBinding
  const previousBinding = {
    wechatAccountId: "acc-old",
    userId: "user-old",
    boundAt: 1715999999999,
  }

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-new", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-recover", qrDataUrl: "https://example.test/qr-recover" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-new", userId: "user-new" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-new"],
          resolveAccount: async () => ({ enabled: true, name: "Recover Account", userId: "user-new" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      rebindOperator: async (binding) => {
        persistedBinding = { ...binding }
        rebindCalls.push(binding)
        return binding
      },
      readOperatorBinding: async () => persistedBinding ?? previousBinding,
      resetOperatorBinding: async () => {
        resetCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        throw new Error("disk full")
      },
      now: () => 1716000000000,
    }),
    /wechat rebind failed: disk full/i,
  )

  assert.equal(rebindCalls.length, 2)
  assert.deepEqual(rebindCalls[0], {
    wechatAccountId: "acc-new",
    userId: "user-new",
    boundAt: 1716000000000,
  })
  assert.deepEqual(rebindCalls[1], previousBinding)
  assert.equal(resetCalled, 0)
})

test("wechat bind flow rejects qr start payload missing stable sessionKey", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const writes = []
  const qrStartCalls = []
  const qrWaitCalls = []

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-stale", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: (input) => {
            qrStartCalls.push(input)
            return {
              accountId: "acc-from-start",
              terminalQr: "SCAN-ME",
            }
          },
          loginWithQrWait: (input) => {
            qrWaitCalls.push(input)
            return { connected: true, accountId: "acc-from-wait", userId: "user-from-wait" }
          },
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-old", "acc-from-wait"],
          resolveAccount: async () => ({ enabled: true, name: "Wait Account" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      writeLine: async (line) => {
        writes.push(line)
      },
      now: () => 1717000000000,
    }),
    /wechat bind failed: missing sessionKey from qr start/i,
  )

  assert.deepEqual(qrStartCalls, [{ source: "menu", action: "wechat-bind" }])
  assert.deepEqual(qrWaitCalls, [])
  assert.deepEqual(writes, [])
})

test("wechat bind flow fails fast when qr wait returns no accountId", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-stale", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-missing-account", qrDataUrl: "https://example.test/qr-account" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-without-account" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-1", "acc-2"],
          resolveAccount: async () => ({ accountId: "", enabled: true, configured: true }),
          describeAccount: async () => ({ accountId: "", enabled: true, configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1718000000000,
    }),
    /wechat bind failed: missing accountId after qr login/i,
  )
})

test("wechat bind flow rejects stale state fallback when qr wait omits accountId", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-stale", token: "token-stale", baseUrl: "https://internal.example", userId: "user-stale" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-stale", qrDataUrl: "https://example.test/qr-stale" }),
          loginWithQrWait: () => ({ connected: true }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-stale", "acc-fresh"],
          resolveAccount: async () => ({ enabled: true, name: "Fresh Account", userId: "user-fresh" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1718000000001,
    }),
    /wechat bind failed: missing accountId after qr login/i,
  )
})

test("wechat bind flow uses account helper userId instead of qr wait userId", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const bindCalls = []
  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-real", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-real-contract", qrDataUrl: "https://example.test/qr-real-contract" }),
        loginWithQrWait: () => ({ connected: true, accountId: "acc-real", userId: "user-from-wait" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-real"],
        resolveAccount: async () => ({ enabled: true, name: "Real Account", userId: "user-from-account" }),
        describeAccount: async () => ({ configured: true }),
      },
    }),
    bindOperator: async (binding) => {
      bindCalls.push({ ...binding })
      return binding
    },
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    now: () => 1718000000002,
  })

  assert.deepEqual(bindCalls, [{ wechatAccountId: "acc-real", userId: "user-from-account", boundAt: 1718000000002 }])
  assert.equal(result.accountId, "acc-real")
  assert.equal(result.userId, "user-from-account")
})

test("wechat bind flow accepts qr wait userId as supplemental local value", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const bindCalls = []
  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-fallback", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-fallback", qrDataUrl: "https://example.test/qr-fallback" }),
        loginWithQrWait: () => ({ connected: true, accountId: "acc-fallback", userId: "user-from-wait-only" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-fallback"],
        resolveAccount: async () => ({ enabled: true, name: "Fallback Account" }),
        describeAccount: async () => ({ configured: true }),
      },
    }),
    bindOperator: async (binding) => {
      bindCalls.push({ ...binding })
      return binding
    },
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    now: () => 1718000000003,
  })

  assert.deepEqual(bindCalls, [{ wechatAccountId: "acc-fallback", userId: "user-from-wait-only", boundAt: 1718000000003 }])
  assert.equal(result.accountId, "acc-fallback")
  assert.equal(result.userId, "user-from-wait-only")
})

test("wechat bind flow normalizes qr wait accountId before helper lookup and binding", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const bindCalls = []
  const resolvedAccountIds = []
  const describedAccountIds = []
  const rawAccountId = "bot-123@im.bot"
  const normalizedAccountId = "bot-123-im-bot"

  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: null,
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-normalized", qrDataUrl: "https://example.test/qr-normalized" }),
        loginWithQrWait: () => ({ connected: true, accountId: rawAccountId }),
      },
      accountHelpers: {
        listAccountIds: async () => [normalizedAccountId],
        resolveAccount: async (accountId) => {
          resolvedAccountIds.push(accountId)
          return { enabled: true, name: "Normalized Account", userId: accountId === normalizedAccountId ? "user-normalized" : undefined }
        },
        describeAccount: async (accountIdOrInput) => {
          const accountId = typeof accountIdOrInput === "string" ? accountIdOrInput : accountIdOrInput.accountId
          describedAccountIds.push(accountId)
          return { configured: true }
        },
      },
    }),
    bindOperator: async (binding) => {
      bindCalls.push({ ...binding })
      return binding
    },
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    now: () => 1718000000004,
  })

  assert.deepEqual(resolvedAccountIds, [normalizedAccountId])
  assert.deepEqual(describedAccountIds, [normalizedAccountId])
  assert.deepEqual(bindCalls, [{ wechatAccountId: normalizedAccountId, userId: "user-normalized", boundAt: 1718000000004 }])
  assert.equal(result.accountId, normalizedAccountId)
  assert.equal(result.userId, "user-normalized")
})

test("wechat bind flow fails early when qr start returns no qr payload", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let waitCalled = 0
  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-qr-missing", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-missing", detail: "upstream missing qr image" }),
          loginWithQrWait: () => {
            waitCalled += 1
            return { connected: true, userId: "user-qr-missing" }
          },
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-qr-missing"],
          resolveAccount: async () => ({ enabled: true, name: "Missing QR", userId: "user-qr-missing" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1717000000001,
    }),
    /wechat bind failed: upstream missing qr image/i,
  )

  assert.equal(waitCalled, 0)
})

test("wechat bind flow does not persist operator binding when menu account build fails", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let bindCalled = 0
  let resetCalled = 0
  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-rollback-build", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-build", qrDataUrl: "https://example.test/qr" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-rollback-build", userId: "user-build" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-rollback-build"],
          resolveAccount: async () => {
            throw new Error("account helper unavailable")
          },
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => {
        bindCalled += 1
        return binding
      },
      resetOperatorBinding: async () => {
        resetCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1717000000002,
    }),
    /wechat bind failed: account helper unavailable/i,
  )

  assert.equal(bindCalled, 0)
  assert.equal(resetCalled, 0)
})

test("wechat bind flow falls back to resolved account userId when wait result omits it", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const bindCalls = []
  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-real", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-real", qrDataUrl: "https://example.test/qr-real" }),
        loginWithQrWait: () => ({ connected: true, accountId: "acc-real" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-real"],
        resolveAccount: async () => ({ enabled: true, name: "Real Account", userId: "user-from-account" }),
        describeAccount: async () => ({ configured: true, userId: "user-from-describe" }),
      },
    }),
    bindOperator: async (binding) => {
      bindCalls.push({ ...binding })
      return binding
    },
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    now: () => 1717000000003,
  })

  assert.deepEqual(bindCalls, [{ wechatAccountId: "acc-real", userId: "user-from-account", boundAt: 1717000000003 }])
  assert.equal(result.accountId, "acc-real")
  assert.equal(result.userId, "user-from-account")
})

test("wechat bind flow renders ascii qr when qrDataUrl is returned", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const writes = []
  const qrRenderCalls = []

  await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-ascii", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-ascii", qrDataUrl: "https://example.test/qr-ascii" }),
        loginWithQrWait: () => ({ connected: true, accountId: "acc-ascii", userId: "user-ascii" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-ascii"],
        resolveAccount: async () => ({ enabled: true, name: "ASCII Account", userId: "user-ascii" }),
        describeAccount: async () => ({ configured: true }),
      },
    }),
    bindOperator: async (binding) => binding,
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    writeLine: async (line) => {
      writes.push(line)
    },
    renderQrTerminal: async (input) => {
      qrRenderCalls.push(input)
      return "ASCII-QR"
    },
    now: () => 1717000000004,
  })

  assert.deepEqual(qrRenderCalls, [{ value: "https://example.test/qr-ascii" }])
  assert.deepEqual(writes, ["ASCII-QR", "QR URL fallback: https://example.test/qr-ascii"])
})

test("wechat bind flow rejects qr start payload that only provides legacy qrUrl", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-legacy-qr", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-legacy-qr", qrUrl: "https://example.test/qr-legacy" }),
          loginWithQrWait: () => ({ connected: true, accountId: "acc-legacy-qr", userId: "user-legacy-qr" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-legacy-qr"],
          resolveAccount: async () => ({ enabled: true, name: "Legacy QR", userId: "user-legacy-qr" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => binding,
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1717000000005,
    }),
    /wechat bind failed: invalid qr login result: missing qr code or qr url/i,
  )
})
