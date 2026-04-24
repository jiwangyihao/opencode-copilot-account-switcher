import test, { afterEach } from "node:test"
import assert from "node:assert/strict"

const serialTest = (name, fn) => test(name, { concurrency: false }, fn)

async function importPluginHooks() {
  return import(`../dist/plugin-hooks.js?reload=${Date.now()}-${Math.random()}`)
}

async function resetPluginHooksGlobals() {
  const module = await import("../dist/plugin-hooks.js")
  await module.resetWechatBridgeGlobalsForTest?.()
}

afterEach(async () => {
  await resetPluginHooksGlobals()
})

async function importBridgeModule() {
  return import(`../dist/wechat/bridge.js?reload=${Date.now()}-${Math.random()}`)
}

function createBridgeCapableClient(extra = {}) {
  const base = {
    session: {
      list: async () => [],
      status: async () => ({}),
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

serialTest("plugin-hooks 仅接入 /status bridge 生命周期", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const calls = []
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
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
  const project = { id: "project-id", name: "wechat-stage-a" }
  const directory = "/workspace/wechat-stage-a"
  const serverUrl = new URL("http://127.0.0.1:4096")

  const plugin = buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project,
    directory,
    serverUrl,
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].client, client)
  assert.equal(calls[0].project, project)
  assert.equal(calls[0].directory, directory)
  assert.equal(calls[0].serverUrl, serverUrl)
  assert.equal(calls[0].statusCollectionEnabled, true)

  assert.equal(typeof plugin["command.execute.before"], "function")
  assert.equal(Object.hasOwn(plugin, "wechat.event.notify"), false)
  assert.equal(Object.hasOwn(plugin, "wechat.question.reply"), false)
  assert.equal(Object.hasOwn(plugin, "wechat.permission.reply"), false)
})

serialTest("plugin-hooks 对根 SDK client 应包装出带 question/permission 的 bridge client", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const { createOpencodeClient } = await import("@opencode-ai/sdk/client")
  const calls = []
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })
  client.tui.showToast = async () => ({ data: undefined })

  buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project: { id: "project-id", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls.length, 1)
  assert.notEqual(calls[0]?.client, client)
  assert.equal(calls[0]?.client?.client, client._client)
  assert.equal(typeof calls[0]?.client?.session?.list, "function")
  assert.equal(typeof calls[0]?.client?.question?.list, "function")
  assert.equal(typeof calls[0]?.client?.permission?.list, "function")
  assert.equal(calls[0]?.statusCollectionEnabled, true)
})

serialTest("plugin-hooks 用事件与请求作用域共同维护当前前台 session", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
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
  let lifecycleInput

  const plugin = buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project: { id: "project-id", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      lifecycleInput = input
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(lifecycleInput?.getActiveSessionID?.(), undefined)
  assert.equal(typeof plugin.event, "function")

  await plugin.event?.({
    event: {
      type: "tui.session.select",
      properties: {
        sessionID: "sess-ui",
      },
    },
  })
  assert.equal(lifecycleInput?.getActiveSessionID?.(), "sess-ui")

  await plugin["tool.execute.before"]?.(
    {
      tool: "bash",
      sessionID: "sess-request",
      callID: "call-1",
    },
    { args: {} },
  )
  assert.equal(lifecycleInput?.getActiveSessionID?.(), "sess-ui")
})

serialTest("plugin-hooks 不再把实例初始化当作第二条 eager broker 启动入口", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  const client = createBridgeCapableClient()
  let launcherCalls = 0
  const connectedEndpoints = []
  let registerHelloCalls = 0
  const registerHelloPayloads = []
  let pingCalls = 0
  let liveHandlers = null

  buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project: { id: "project-id", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    initialWechatBrokerPromise: Promise.resolve({ endpoint: "fake-endpoint-from-plugin" }),
    createWechatBridgeLifecycleImpl: (input) => createWechatBridgeLifecycle(input, {
      connectOrSpawnBrokerImpl: async () => {
        launcherCalls += 1
        return {
          endpoint: "fake-endpoint-from-launcher",
        }
      },
      connectImpl: async (endpoint) => {
        connectedEndpoints.push(endpoint)
        return {
          setLiveHandlers: (handlers) => {
            liveHandlers = handlers
          },
          registerHello: async (payload) => {
            registerHelloCalls += 1
            registerHelloPayloads.push(payload)
            return {
              ack: {
                protocolVersion: payload.protocolVersion,
                stateGeneration: payload.stateGeneration,
                instanceIncarnation: payload.instanceIncarnation,
                brokerSeq: 0,
                needReplay: false,
                needFullSync: false,
              },
              pendingCommands: [],
            }
          },
          ping: async () => {
            pingCalls += 1
            return {}
          },
          close: async () => {},
        }
      },
      setIntervalImpl: () => ({ id: Symbol("timer") }),
      clearIntervalImpl: () => {},
    }),
  })

  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(launcherCalls, 0)
  assert.deepEqual(connectedEndpoints, ["fake-endpoint-from-plugin"])
  assert.equal(registerHelloCalls, 1)
  assert.equal(typeof registerHelloPayloads[0]?.instanceID, "string")
  assert.equal(typeof registerHelloPayloads[0]?.instanceIncarnation, "string")
  assert.equal(typeof registerHelloPayloads[0]?.protocolVersion, "number")
  assert.equal(typeof registerHelloPayloads[0]?.stateGeneration, "string")
  assert.equal(pingCalls, 0)
  assert.equal(typeof liveHandlers?.onBrokerControl, "function")
  assert.equal(typeof liveHandlers?.onBrokerCommand, "function")
})

serialTest("plugin-hooks 在非 bridge-capable 输入下不会额外 eager ensure broker 或显示启动提示", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const toastCalls = []
  const client = createBridgeCapableClient({
    tui: {
      showToast: async (options) => {
        toastCalls.push(options)
      },
    },
  })
  let ensureBrokerCalls = 0
  let lifecycleCalls = 0

  buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project: { id: "project-id", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    ensureWechatBrokerStarted: async () => {
      ensureBrokerCalls += 1
      return { endpoint: "fake-endpoint" }
    },
    createWechatBridgeLifecycleImpl: async () => {
      lifecycleCalls += 1
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(ensureBrokerCalls, 0)
  assert.equal(lifecycleCalls, 0)
  assert.equal(toastCalls.length, 0)
})

serialTest("plugin-hooks 将 wechat fallback toast 透传到现有 UI toast", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const toastCalls = []
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [],
    },
    permission: {
      list: async () => [],
    },
    tui: {
      showToast: async (options) => {
        toastCalls.push(options)
      },
    },
  }

  buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project: { id: "project-id", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      await input.onFallbackToast?.({
        wechatAccountId: "wx-fallback",
        userId: "u-fallback",
        message: "微信会话可能已失效，请在微信发送 /status 重新激活",
        reason: "deliveryFailed",
        registrationEpoch: "epoch-123",
      })
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  const warningToast = toastCalls.find((item) => item?.body?.variant === "warning")
  assert.equal(Boolean(warningToast), true)
  assert.equal(warningToast?.body?.message, "微信会话可能已失效，请在微信发送 /status 重新激活")
})

serialTest("plugin-hooks lifecycle 初始化不依赖 eager broker ensure", async () => {
  const runCase = async (ensureWechatBrokerStarted) => {
    const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
    const client = createBridgeCapableClient()
    let ensureCalls = 0
    let lifecycleCalls = 0

    buildPluginHooksRaw({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      client,
      project: { id: "project-id", name: "wechat-stage-a" },
      directory: `/workspace/wechat-stage-fail-open-${Math.random()}`,
      serverUrl: new URL("http://127.0.0.1:4096"),
      ensureWechatBrokerStarted: async () => {
        ensureCalls += 1
        return ensureWechatBrokerStarted()
      },
      createWechatBridgeLifecycleImpl: async () => {
        lifecycleCalls += 1
        return {
          close: async () => {},
        }
      },
    })

    await Promise.resolve()
    await Promise.resolve()

    assert.equal(ensureCalls, 0)
    assert.equal(lifecycleCalls, 1)
  }

  await runCase(async () => {
    throw new Error("ensure rejected")
  })
  await runCase(() => {
    throw new Error("ensure thrown")
  })
})

serialTest("plugin-hooks 重复 build 不应重复初始化 bridge lifecycle", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const calls = []
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
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

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls.length, 1)
})

serialTest("plugin-hooks lifecycle key 变化时必须关闭旧实例，最终仅保留一个活跃 lifecycle", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const active = new Set()
  let closeCount = 0

  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
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

  const createWechatBridgeLifecycleImpl = async () => {
    const handle = Symbol("lifecycle")
    active.add(handle)
    return {
      close: async () => {
        if (active.delete(handle)) {
          closeCount += 1
        }
      },
    }
  }

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a-A",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(active.size, 1)

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a-B",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(closeCount, 1)
  assert.equal(active.size, 1)
})

serialTest("plugin-hooks 旧 lifecycle 仍在初始化中时切 key，旧 promise resolve 后也必须 close", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const active = new Set()
  let closeCount = 0
  let firstResolve
  const secondHandle = Symbol("second-lifecycle")

  const firstPromise = new Promise((resolve) => {
    firstResolve = resolve
  })

  let createCalls = 0
  const createWechatBridgeLifecycleImpl = async () => {
    createCalls += 1
    if (createCalls === 1) {
      return firstPromise
    }

    active.add(secondHandle)
    return {
      close: async () => {
        if (active.delete(secondHandle)) {
          closeCount += 1
        }
      },
    }
  }

  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: { list: async () => [] },
    permission: { list: async () => [] },
  }

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/pending-old-A",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl,
  })

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/pending-old-B",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint" }),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(createCalls, 2)
  assert.equal(active.size, 1)
  assert.equal(closeCount, 0)

  firstResolve({
    close: async () => {
      closeCount += 1
    },
  })

  for (let attempt = 0; attempt < 20 && closeCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  assert.equal(closeCount, 1)
  assert.equal(active.size, 1)
})

serialTest("bridge lifecycle registerHello 失败时会回收已建立 brokerClient", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let closed = 0

  const deps = {
    connectOrSpawnBrokerImpl: async () => ({ endpoint: "fake-endpoint" }),
    connectImpl: async () => ({
      setLiveHandlers: () => {},
      registerHello: async () => {
        throw new Error("register failed")
      },
      ping: async () => ({ type: "pong", payload: {} }),
      close: async () => {
        closed += 1
      },
    }),
    setIntervalImpl: globalThis.setInterval,
    clearIntervalImpl: globalThis.clearInterval,
  }

  await assert.rejects(
    () => createWechatBridgeLifecycle({
      statusCollectionEnabled: true,
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: { list: async () => [] },
        permission: { list: async () => [] },
      },
      directory: "/workspace/wechat-stage-a",
    }, deps),
    /register failed/i,
  )

  assert.equal(closed, 1)
})

serialTest("bridge lifecycle registerHello 生成的 instanceID 应按进程唯一，而不是目录派生", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let registeredInstanceID = ""

  const deps = {
    connectOrSpawnBrokerImpl: async () => ({ endpoint: "fake-endpoint" }),
    connectImpl: async () => ({
      setLiveHandlers: () => {},
      registerHello: async (meta) => {
        registeredInstanceID = meta.instanceID
        return {
          ack: {
            protocolVersion: 2,
            stateGeneration: "wechat-ws-v1",
            instanceIncarnation: meta.instanceIncarnation,
            brokerSeq: 1,
            needReplay: false,
            needFullSync: false,
          },
          pendingCommands: [],
        }
      },
      ping: async () => ({ type: "pong", payload: {} }),
      close: async () => {},
    }),
    setIntervalImpl: () => ({ id: Symbol("timer") }),
    clearIntervalImpl: () => {},
  }

  const lifecycle = await createWechatBridgeLifecycle({
    statusCollectionEnabled: true,
    client: {
      session: {
        list: async () => [],
        status: async () => ({}),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
    directory: "/workspace/wechat-stage-a",
  }, deps)

  assert.match(registeredInstanceID, new RegExp(String(process.pid)))
  assert.doesNotMatch(registeredInstanceID, /wechat-stage-a|workspace/i)

  await lifecycle.close()
})

serialTest("bridge lifecycle steady keepalive 使用 ping，close 清理且幂等", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let pingCalls = 0
  let closeCalls = 0
  let timerCallback = null
  const activeTimers = new Set()

  const deps = {
    connectOrSpawnBrokerImpl: async () => ({ endpoint: "fake-endpoint" }),
    connectImpl: async () => ({
      setLiveHandlers: () => {},
      registerHello: async (meta) => ({
        ack: {
          protocolVersion: 2,
          stateGeneration: "wechat-ws-v1",
          instanceIncarnation: meta.instanceIncarnation,
          brokerSeq: 1,
          needReplay: false,
          needFullSync: false,
        },
        pendingCommands: [],
      }),
      ping: async () => {
        pingCalls += 1
        return { type: "pong", payload: {} }
      },
      close: async () => {
        closeCalls += 1
      },
    }),
    setIntervalImpl: (cb, _ms) => {
      const handle = { id: Symbol("timer") }
      timerCallback = cb
      activeTimers.add(handle)
      return handle
    },
    clearIntervalImpl: (handle) => {
      activeTimers.delete(handle)
    },
  }

  const lifecycle = await createWechatBridgeLifecycle({
    statusCollectionEnabled: true,
    heartbeatIntervalMs: 50,
    client: {
      session: {
        list: async () => [],
        status: async () => ({}),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
    directory: "/workspace/wechat-stage-a",
  }, deps)

  assert.equal(typeof timerCallback, "function")
  assert.equal(activeTimers.size, 1)

  await timerCallback()
  assert.equal(pingCalls, 1)

  await lifecycle.close()
  assert.equal(activeTimers.size, 0)
  assert.equal(closeCalls, 1)

  await lifecycle.close()
  assert.equal(closeCalls, 1)
})

serialTest("bridge lifecycle ping 失败后会重连 broker，但不会假定 full sync churn", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let connectOrSpawnCalls = 0
  let connectCalls = 0
  let registerCalls = 0
  let closeCalls = 0
  let timerCallback = null
  const brokerEndpoint = "fake-endpoint-reused"

  const liveReadCalls = []
  const registerHelloCalls = []
  const client = {
    session: {
      list: async () => {
        liveReadCalls.push("session.list")
        return []
      },
      status: async () => {
        liveReadCalls.push("session.status")
        return {}
      },
      todo: async () => {
        liveReadCalls.push("session.todo")
        return []
      },
      messages: async () => {
        liveReadCalls.push("session.messages")
        return []
      },
    },
    question: {
      list: async () => {
        liveReadCalls.push("question.list")
        return []
      },
    },
    permission: {
      list: async () => {
        liveReadCalls.push("permission.list")
        return []
      },
    },
  }

  const deps = {
    connectOrSpawnBrokerImpl: async () => {
      connectOrSpawnCalls += 1
      return { endpoint: brokerEndpoint }
    },
    connectImpl: async (endpoint) => {
      assert.equal(endpoint, brokerEndpoint)
      connectCalls += 1
      const currentConnect = connectCalls
      return {
        setLiveHandlers: () => {},
        registerHello: async (payload) => {
          registerCalls += 1
          registerHelloCalls.push(payload)
          return {
            ack: {
              protocolVersion: 2,
              stateGeneration: "wechat-ws-v1",
              instanceIncarnation: payload.instanceIncarnation,
              brokerSeq: currentConnect,
              needReplay: false,
              needFullSync: false,
            },
            pendingCommands: [],
          }
        },
        ping: async () => {
          if (currentConnect === 1) {
            throw new Error("broker connection closed")
          }
          return { type: "pong", payload: {} }
        },
        close: async () => {
          closeCalls += 1
        },
      }
    },
    setIntervalImpl: (cb) => {
      timerCallback = cb
      return { id: Symbol("timer") }
    },
    clearIntervalImpl: () => {},
  }

  const lifecycle = await createWechatBridgeLifecycle({
    statusCollectionEnabled: true,
    heartbeatIntervalMs: 50,
    client,
    directory: "/workspace/wechat-stage-a",
  }, deps)

  assert.equal(registerCalls, 1)
  assert.equal(typeof timerCallback, "function")

  await timerCallback()

  for (let attempt = 0; attempt < 20 && (registerCalls < 2 || liveReadCalls.length === 0); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  assert.equal(connectOrSpawnCalls, 2)
  assert.equal(connectCalls, 2)
  assert.equal(registerCalls, 2)
  assert.equal(closeCalls >= 1, true)
  assert.equal(registerHelloCalls.length, 2)
  assert.equal(typeof registerHelloCalls[1]?.lastSeenBrokerSeq, "number")
  assert.equal(typeof registerHelloCalls[1]?.lastSentEventSeq, "number")
  assert.deepEqual(liveReadCalls, [])

  await lifecycle.close()
})

serialTest("plugin-hooks fresh import 不会重复附加 auto-close listeners，且会接管并关闭旧 lifecycle", async () => {
  const beforeExitListeners = process.listeners("beforeExit")
  const sigintListeners = process.listeners("SIGINT")
  const sigtermListeners = process.listeners("SIGTERM")

  const closeCalls = []
  const firstModule = await importPluginHooks()
  const secondModule = await importPluginHooks()

  firstModule.buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client: createBridgeCapableClient(),
    project: { id: "project-a", name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint-a" }),
    createWechatBridgeLifecycleImpl: async () => ({
      close: async () => {
        closeCalls.push("first")
      },
    }),
  })

  await Promise.resolve()
  await Promise.resolve()

  secondModule.buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client: createBridgeCapableClient(),
    project: { id: "project-b", name: "wechat-stage-b" },
    directory: "/workspace/wechat-stage-b",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ensureWechatBrokerStarted: async () => ({ endpoint: "fake-endpoint-b" }),
    createWechatBridgeLifecycleImpl: async () => ({
      close: async () => {
        closeCalls.push("second")
      },
    }),
  })

  await Promise.resolve()
  await Promise.resolve()

  const afterBeforeExitListeners = process.listeners("beforeExit")
  const afterSigintListeners = process.listeners("SIGINT")
  const afterSigtermListeners = process.listeners("SIGTERM")

  const addedBeforeExitListeners = afterBeforeExitListeners.filter((listener) => !beforeExitListeners.includes(listener))
  const addedSigintListeners = afterSigintListeners.filter((listener) => !sigintListeners.includes(listener))
  const addedSigtermListeners = afterSigtermListeners.filter((listener) => !sigtermListeners.includes(listener))

  try {
    assert.equal(addedBeforeExitListeners.length, 1)
    assert.equal(addedSigintListeners.length, 1)
    assert.equal(addedSigtermListeners.length, 1)
    assert.deepEqual(closeCalls, ["first"])
  } finally {
    for (const listener of addedBeforeExitListeners) {
      process.removeListener("beforeExit", listener)
    }
    for (const listener of addedSigintListeners) {
      process.removeListener("SIGINT", listener)
    }
    for (const listener of addedSigtermListeners) {
      process.removeListener("SIGTERM", listener)
    }
  }
})
