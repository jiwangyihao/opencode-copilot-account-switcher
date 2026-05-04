import test from "node:test"
import assert from "node:assert/strict"

import { createWaitTool } from "../dist/wait-tool.js"

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

test("wait tool description directs unattended waits away from question", () => {
  const wait = createWaitTool()

  assert.match(wait.description ?? "", /unattended|background/i)
  assert.match(wait.description ?? "", /do not require user confirmation|without user confirmation/i)
})

test("wait tool enforces minimum 30 seconds", async () => {
  let sleptMs = 0
  const wait = createWaitTool({
    sleep: async (ms) => {
      sleptMs = ms
    },
  })

  await wait.execute({ seconds: 5 }, createContext())

  assert.equal(sleptMs, 30_000)
})

test("wait tool normalizes invalid seconds to 30", async () => {
  const calls = []
  const wait = createWaitTool({
    sleep: async (ms) => {
      calls.push(ms)
    },
  })

  await wait.execute({}, createContext())
  await wait.execute({ seconds: Number.NaN }, createContext())
  await wait.execute({ seconds: 0 }, createContext())
  await wait.execute({ seconds: -9 }, createContext())

  assert.deepEqual(calls, [30_000, 30_000, 30_000, 30_000])
})

test("wait tool rounds valid non-integer seconds down", async () => {
  let sleptMs = 0
  const wait = createWaitTool({
    sleep: async (ms) => {
      sleptMs = ms
    },
  })

  await wait.execute({ seconds: 45.9 }, createContext())

  assert.equal(sleptMs, 45_000)
})

test("wait tool returns started waited now timeline", async () => {
  const wait = createWaitTool({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 30_000
    })(),
    sleep: async () => {},
  })

  const result = await wait.execute({ seconds: 30 }, createContext())

  assert.match(result, /^started: /)
  assert.match(result, /waited: 30s/)
  assert.match(result, /; now: /)
  assert.doesNotMatch(result, /ended:/)
})

test("wait tool ends early when a new real user message appears in the current session", async () => {
  const messageCalls = []
  const wait = createWaitTool({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 1_000
    })(),
    pollIntervalMs: 1,
    sleep: () => new Promise(() => {}),
    client: {
      session: {
        messages: async (input) => {
          messageCalls.push(input)
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
                    parts: [{ type: "text", text: "typed by user", synthetic: false }],
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
  })

  const result = await wait.execute({ seconds: 30 }, createContext())

  assert.equal(messageCalls.length >= 2, true)
  assert.deepEqual(messageCalls[0], {
    path: { id: "s1" },
    query: { directory: "/tmp/project", limit: 20 },
  })
  assert.match(result, /ended: early/i)
  assert.match(result, /reason: new user message;/i)
  assert.match(result, /message: m2/i)
  assert.doesNotMatch(result, /waited: 30s/)
})

test("wait tool reports synthetic reason when a plugin-synthesized user message appears", async () => {
  const messageCalls = []
  const wait = createWaitTool({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 1_000
    })(),
    pollIntervalMs: 1,
    sleep: () => new Promise(() => {}),
    client: {
      session: {
        messages: async (input) => {
          messageCalls.push(input)
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
                    parts: [{ type: "text", text: "pty done", synthetic: true }],
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
  })

  const result = await wait.execute({ seconds: 30 }, createContext())

  assert.match(result, /ended: early/i)
  assert.match(result, /reason: new user message \(synthetic\)/i)
  assert.match(result, /message: m2/i)
  assert.doesNotMatch(result, /waited: 30s/)
})

test("wait tool can wait until a new user message event without a timeout", async () => {
  const timeoutSleeps = []
  const messageCalls = []
  const wait = createWaitTool({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 1_000
    })(),
    pollIntervalMs: 1,
    sleep: async (ms) => {
      timeoutSleeps.push(ms)
    },
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
                    parts: [{ type: "text", text: "event happened", synthetic: true }],
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
  })

  const result = await wait.execute({ until: "new_user_message" }, createContext())

  assert.deepEqual(timeoutSleeps, [])
  assert.match(result, /ended: event/i)
  assert.match(result, /event: new_user_message/i)
  assert.match(result, /reason: new user message \(synthetic\)/i)
  assert.match(result, /message: m2/i)
  assert.doesNotMatch(result, /requested: 30s/)
})
test("wait tool catches user messages that arrive before the initial session snapshot returns", async () => {
  const wait = createWaitTool({
    now: (() => {
      let tick = 0
      return () => 1_700_000_000_000 + tick++ * 1_000
    })(),
    pollIntervalMs: 1,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 10)),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "m2", role: "user", time: { created: 1_700_000_001_000 } },
              parts: [{ type: "text", text: "already arrived" }],
            },
            {
              info: { id: "m1", role: "user", time: { created: 1_700_000_000_000 } },
              parts: [],
            },
          ],
        }),
      },
    },
  })

  const result = await wait.execute({ seconds: 30 }, createContext())

  assert.match(result, /ended: early/i)
  assert.match(result, /reason: new user message;/i)
  assert.match(result, /message: m2/i)
})

test("wait tool returns unavailable for event wait without session messages", async () => {
  const wait = createWaitTool({
    now: () => 1_700_000_000_000,
  })

  const result = await wait.execute({ until: "new_user_message" }, createContext())

  assert.match(result, /ended: unavailable/i)
  assert.match(result, /event: new_user_message/i)
  assert.match(result, /reason: session messages unavailable/i)
  assert.doesNotMatch(result, /requested: 30s/)
})
