import test from "node:test"
import assert from "node:assert/strict"

import WaitPlugin, { WaitPlugin as NamedWaitPlugin, createWaitPlugin, createWaitTool } from "../dist/index.js"

function createContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "task",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("wait plugin entry registers only the wait tool", async () => {
  const plugin = createWaitPlugin({
    sleep: async () => {},
  })

  const hooks = await plugin({
    client: {},
    directory: "/tmp/project",
    serverUrl: "http://localhost",
  })

  assert.equal(typeof createWaitTool, "function")
  assert.equal(typeof WaitPlugin, "function")
  assert.equal(NamedWaitPlugin, WaitPlugin)
  assert.deepEqual(Object.keys(hooks.tool ?? {}), ["wait"])
  assert.equal(typeof hooks.tool.wait.execute, "function")
})

test("wait plugin entry exposes the timed wait path through wait", async () => {
  const plugin = createWaitPlugin({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 30_000
    })(),
    sleep: async () => {},
  })
  const hooks = await plugin({
    client: {},
    directory: "/tmp/project",
    serverUrl: "http://localhost",
  })

  const result = await hooks.tool.wait.execute({ seconds: 30 }, createContext())

  assert.match(result, /^started: /)
  assert.match(result, /waited: 30s/)
  assert.match(result, /; now: /)
})

test("wait plugin entry exposes unavailable event result without session messages", async () => {
  const plugin = createWaitPlugin({
    now: () => 1_700_000_000_000,
  })
  const hooks = await plugin({
    client: {},
    directory: "/tmp/project",
    serverUrl: "http://localhost",
  })

  const result = await hooks.tool.wait.execute({ until: "new_user_message" }, createContext())

  assert.match(result, /ended: unavailable/)
  assert.match(result, /event: new_user_message/)
  assert.match(result, /reason: session messages unavailable/)
})

test("wait plugin entry forwards the OpenCode client into wait", async () => {
  const messageCalls = []
  const plugin = createWaitPlugin({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 1_000
    })(),
    pollIntervalMs: 1,
  })

  const hooks = await plugin({
    client: {
      session: {
        messages: async () => {
          messageCalls.push(true)
          return {
            data: messageCalls.length === 1
              ? [
                  {
                    info: { id: "m1", role: "user", time: { created: 1_700_000_000_000 } },
                    parts: [],
                  },
                ]
              : [
                  {
                    info: { id: "m2", role: "user", time: { created: 1_700_000_001_000 } },
                    parts: [{ type: "text", text: "from host client" }],
                  },
                  {
                    info: { id: "m1", role: "user", time: { created: 1_700_000_000_000 } },
                    parts: [],
                  },
                ],
          }
        },
      },
    },
    directory: "/tmp/project",
    serverUrl: "http://localhost",
  })

  const result = await hooks.tool.wait.execute({ until: "new_user_message" }, createContext())

  assert.equal(messageCalls.length >= 2, true)
  assert.match(result, /ended: event/i)
  assert.match(result, /reason: new user message/i)
  assert.match(result, /message: m2/i)
})
