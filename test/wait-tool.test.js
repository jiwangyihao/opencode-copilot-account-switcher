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
})
