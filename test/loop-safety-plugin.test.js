import test from "node:test"
import assert from "node:assert/strict"
import { AsyncResource } from "node:async_hooks"

import {
  LOOP_SAFETY_POLICY,
  applyLoopSafetyPolicy,
  createCompactionLoopSafetyBypass,
  createLoopSafetySystemTransform,
  isCopilotProvider,
} from "../dist/loop-safety-plugin.js"

const EXPECTED_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- Channel contract: Use only question or notify for user-visible interactions; never emit ordinary assistant plain text.
- Notify contract: Pure progress, phase switches, and non-blocking background status updates belong to notify.
- Question contract: Required user response, user decisions or confirmations, final handoff, and no-safe-work-left states belong to question; do not use question for unattended waits that can resume automatically.
- Wait contract: All waiting that does not require user confirmation, including background waits for long-running tools, external jobs, cooldowns, or expected notifications, must use wait instead of question; use wait({ until: "new_user_message" }) when the expected event is a new user or plugin-synthesized message; timed waits may also end early and report that reason when a new user message appears.
- Decision matrix: If uncertain whether user input is required, default to question; if the only need is time passing or waiting for an expected non-user event, use wait.
- Marker contract: If a tool output contains [COPILOT_INJECT_V1_BEGIN] ... [COPILOT_INJECT_V1_END], immediately call question and wait for user instruction before continuing.
- Silent fallback discipline: If notify is unavailable, denied, absent, or fails, pure progress stays silent and work continues; do not automatically escalate that progress into question.
- Silent fallback discipline: If question is unavailable, denied, or absent, only strong-interaction content may fall back to direct assistant text.
- Silent fallback discipline: Tool availability does not change the interaction class of the content itself; progress stays progress and strong interaction stays strong interaction.
- Reflection and violation diagnosis: If the user says the reporting behavior was wrong, first check whether content was assigned to the wrong interaction class or sent through the wrong channel.
- Reflection and violation diagnosis: Check notify/question misclassification before blaming verbosity, timing, tone, or the policy itself.
- Reflection and violation diagnosis: Final completion handoff remains a question event, while unattended waits remain wait events.
`

test("isCopilotProvider recognizes both Copilot providers", () => {
  assert.equal(isCopilotProvider("github-copilot"), true)
  assert.equal(isCopilotProvider("github-copilot-enterprise"), true)
  assert.equal(isCopilotProvider("google"), false)
})

test("applyLoopSafetyPolicy leaves non-Copilot providers unchanged", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "google",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt"])
})

test("applyLoopSafetyPolicy appends for non-Copilot providers when scope is all-models", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "google",
    enabled: true,
    scope: "all-models",
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY])
})

test("applyLoopSafetyPolicy leaves disabled Copilot sessions unchanged", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: false,
    system,
  })

  assert.deepEqual(next, ["base prompt"])
})

test("applyLoopSafetyPolicy appends the fixed block once for enabled Copilot sessions", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY])
})

test("applyLoopSafetyPolicy is idempotent when the exact block already exists", () => {
  const system = ["base prompt", LOOP_SAFETY_POLICY]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY])
})

test("applyLoopSafetyPolicy is idempotent when the exact block already exists in the middle", () => {
  const system = ["base prompt", LOOP_SAFETY_POLICY, "tail prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY, "tail prompt"])
})

test("LOOP_SAFETY_POLICY exactly matches the fixed spec text", () => {
  assert.equal(LOOP_SAFETY_POLICY, EXPECTED_POLICY)
})

test("LOOP_SAFETY_POLICY does not route unattended waits back to question", () => {
  assert.doesNotMatch(LOOP_SAFETY_POLICY, /explicit waiting states remain question events/i)
  assert.match(LOOP_SAFETY_POLICY, /unattended waits that can resume automatically/i)
  assert.match(LOOP_SAFETY_POLICY, /must use wait instead of question/i)
})

test("createLoopSafetySystemTransform appends once for enabled Copilot sessions", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }))
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform skips when bypass callback says current session is compaction", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), (sessionID) => sessionID === "s1")
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform still appends when bypass callback returns false", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), () => false)
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform checks ancestry for enabled Copilot root sessions before appending", async () => {
  const ancestryCalls = []
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async (sessionID) => {
      ancestryCalls.push(sessionID)
      return [{ sessionID }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(ancestryCalls, ["s1"])
  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform skips derived child sessions after ancestry lookup", async () => {
  const ancestryCalls = []
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async (sessionID) => {
      ancestryCalls.push(sessionID)
      return [
        { sessionID, parentID: "root-session" },
        { sessionID: "root-session" },
      ]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "child-session", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(ancestryCalls, ["child-session"])
  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform skips derived child sessions even when current entry is not first", async () => {
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async (sessionID) => [
      { sessionID: "root-session" },
      { sessionID, parentID: "root-session" },
    ],
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "child-session", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform does not misclassify root sessions when another ancestor entry appears first", async () => {
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async (sessionID) => [
      { sessionID: "child-session", parentID: sessionID },
      { sessionID },
    ],
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "root-session", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform fails open when ancestry lookup rejects", async () => {
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async () => {
      throw new Error("boom")
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform does not check ancestry for non-Copilot transforms", async () => {
  let ancestryChecks = 0
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async () => {
      ancestryChecks += 1
      return [{ sessionID: "s1" }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "google" } },
    output,
  )

  assert.equal(ancestryChecks, 0)
  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform appends for non-Copilot providers when default scope is all-models", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "all-models",
  }))
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "google" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform skips non-Copilot derived child sessions when default scope is all-models", async () => {
  const ancestryCalls = []
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
      loopSafetyProviderScope: "all-models",
    }),
    () => false,
    async (sessionID) => {
      ancestryCalls.push(sessionID)
      return [{ sessionID, parentID: "root-session" }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "child-session", model: { providerID: "google" } },
    output,
  )

  assert.deepEqual(ancestryCalls, ["child-session"])
  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform does not check ancestry when loop safety is disabled", async () => {
  let ancestryChecks = 0
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: false,
    }),
    () => false,
    async () => {
      ancestryChecks += 1
      return [{ sessionID: "s1" }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.equal(ancestryChecks, 0)
  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform does not check ancestry when compaction bypass matches", async () => {
  let ancestryChecks = 0
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    (sessionID) => sessionID === "s1",
    async () => {
      ancestryChecks += 1
      return [{ sessionID: "s1" }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.equal(ancestryChecks, 0)
  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform checks ancestry for enterprise Copilot sessions too", async () => {
  const ancestryCalls = []
  const transform = createLoopSafetySystemTransform(
    async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    () => false,
    async (sessionID) => {
      ancestryCalls.push(sessionID)
      return [{ sessionID }]
    },
  )
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "enterprise-session", model: { providerID: "github-copilot-enterprise" } },
    output,
  )

  assert.deepEqual(ancestryCalls, ["enterprise-session"])
  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createCompactionLoopSafetyBypass only skips within the compaction async context", async () => {
  const bypass = createCompactionLoopSafetyBypass()

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  assert.equal(bypass.consume("s1"), true)
  assert.equal(bypass.consume("s1"), false)
  assert.equal(bypass.consume("s2"), false)
  assert.equal(bypass.consume(undefined), false)
  assert.equal(createCompactionLoopSafetyBypass().consume("s1"), false)
})

test("createCompactionLoopSafetyBypass does not leak to unrelated async contexts", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const foreign = new AsyncResource("foreign-context")

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const leaked = foreign.runInAsyncScope(() => bypass.consume("s1"))

  assert.equal(leaked, false)
  assert.equal(bypass.consume("s1"), true)
})

test("createLoopSafetySystemTransform does not consume bypass for non-Copilot transforms", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), bypass.consume)

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const nonCopilot = { system: ["base prompt"] }
  await transform(
    { sessionID: "s1", model: { providerID: "google" } },
    nonCopilot,
  )

  const copilot = { system: ["base prompt"] }
  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    copilot,
  )

  assert.deepEqual(nonCopilot.system, ["base prompt"])
  assert.deepEqual(copilot.system, ["base prompt"])
})

test("createLoopSafetySystemTransform does not consume bypass when loop safety is disabled", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const disabledTransform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: false,
  }), bypass.consume)
  const enabledTransform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), bypass.consume)

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const disabled = { system: ["base prompt"] }
  await disabledTransform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    disabled,
  )

  const enabled = { system: ["base prompt"] }
  await enabledTransform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    enabled,
  )

  assert.deepEqual(disabled.system, ["base prompt"])
  assert.deepEqual(enabled.system, ["base prompt"])
})

test("createLoopSafetySystemTransform fails open when store read rejects", async () => {
  const transform = createLoopSafetySystemTransform(async () => {
    throw new Error("boom")
  })
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform reads fresh store state on every call", async () => {
  let enabled = false
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: enabled,
  }))
  const first = { system: ["base prompt"] }
  const second = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    first,
  )

  enabled = true

  await transform(
    { sessionID: "s2", model: { providerID: "github-copilot" } },
    second,
  )

  assert.deepEqual(first.system, ["base prompt"])
  assert.deepEqual(second.system, ["base prompt", LOOP_SAFETY_POLICY])
})

