import test from "node:test"
import assert from "node:assert/strict"

import { buildPluginHooks as buildPluginHooksRaw } from "../dist/plugin-hooks.js"

async function loadSessionControlModule() {
  try {
    return await import("../dist/session-control-command.js")
  } catch (error) {
    assert.fail(`session-control-command helper missing: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildPluginHooks(input = {}) {
  return buildPluginHooksRaw({
    ...input,
    auth: input.auth ?? { provider: "github-copilot", methods: [] },
    loadStoreSync: input.loadStoreSync ?? (() => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    })),
    loadStore: input.loadStore ?? (async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    })),
  })
}

test("session-control helper exports compact/stop helpers", async () => {
  const helpers = await loadSessionControlModule()

  assert.equal(typeof helpers.handleCompactCommand, "function")
  assert.equal(typeof helpers.handleStopToolCommand, "function")
})

test("/copilot-compact triggers real summarize(auto=true) when model is known", async () => {
  const summarizeCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        summarize: async (options) => {
          summarizeCalls.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-compact", sessionID: "s1", arguments: "", model: "gpt-4.1" },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(summarizeCalls.length, 1)
  assert.equal(summarizeCalls[0]?.auto, true)
})

test("/copilot-compact falls back to nearest assistant model", async () => {
  const summarizeCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "assistant" }, model: "claude-3-7" },
          ],
        }),
        summarize: async (options) => {
          summarizeCalls.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-compact", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(summarizeCalls.length, 1)
  assert.equal(summarizeCalls[0]?.model, "claude-3-7")
})

test("/copilot-compact warns when session summarize is unavailable", async () => {
  const toasts = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-compact", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /summarize is unavailable|compact/i)
})

test("/copilot-compact summarizes without explicit model when model context is missing", async () => {
  const summarizeCalls = []
  const toasts = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({ data: [] }),
        summarize: async (options) => {
          summarizeCalls.push(options)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-compact", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(summarizeCalls.length, 1)
  assert.equal(summarizeCalls[0]?.auto, true)
  assert.equal(Object.hasOwn(summarizeCalls[0] ?? {}, "model"), false)
  assert.equal(toasts.length, 0)
})

test("/copilot-stop-tool warns when there is no running tool", async () => {
  const toasts = []
  const plugin = buildPluginHooks({
    client: {
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-stop-tool", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /running tool|没有正在运行的工具/i)
})

test("/copilot-stop-tool warns and bails when syntheticAgentInitiatorEnabled is disabled", async () => {
  const toasts = []
  const abortCalls = []
  const promptCalls = []
  const partUpdates = []
  const toolPart = {
    type: "tool",
    callID: "c1",
    state: "completed",
    output: "tool output",
    update: async (patch) => {
      partUpdates.push(patch)
    },
  }

  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: false,
    }),
    client: {
      session: {
        abort: async (payload) => {
          abortCalls.push(payload)
        },
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [toolPart] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /synthetic|initiator|开关|未开启/i)
  assert.equal(abortCalls.length, 0)
  assert.equal(partUpdates.length, 0)
  assert.equal(promptCalls.length, 0)
})

test("/copilot-stop-tool warns when there are zero running/pending tools", async () => {
  const toasts = []
  const abortCalls = []
  const promptCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        abort: async (payload) => {
          abortCalls.push(payload)
        },
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "completed" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /running|pending|没有正在运行的工具/i)
  assert.equal(abortCalls.length, 0)
  assert.equal(promptCalls.length, 0)
})

test("/copilot-stop-tool warns when multiple running/pending tools exist", async () => {
  const toasts = []
  const abortCalls = []
  const promptCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        abort: async (payload) => {
          abortCalls.push(payload)
        },
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [
          { callID: "c1", tool: "bash", state: "running" },
          { callID: "c2", tool: "read", state: "pending" },
        ],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /multiple|more than one|多个工具/i)
  assert.equal(abortCalls.length, 0)
  assert.equal(promptCalls.length, 0)
})

test("/copilot-stop-tool rejects when multiple tools are running", async () => {
  const toasts = []
  const plugin = buildPluginHooks({
    client: {
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [
          { callID: "c1", tool: "bash" },
          { callID: "c2", tool: "read" },
        ],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
  assert.match(String(toasts[0]?.body?.message ?? ""), /multiple|more than one|多个工具/i)
})

test("/copilot-stop-tool aborts single running tool and appends synthetic continue", async () => {
  const abortCalls = []
  const promptCalls = []
  const partUpdates = []
  let pollCount = 0
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: pollCount++ === 0
                ? [{ id: "p1", type: "tool", callID: "c1", state: "running" }]
                : [{ id: "p1", type: "tool", callID: "c1", state: "completed", output: "stdout" }],
            },
          ],
        }),
        abort: async (payload) => {
          abortCalls.push(payload)
        },
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      part: {
        update: async (patch) => {
          partUpdates.push(patch)
        },
      },
      tui: {
        showToast: async () => {},
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(abortCalls.length, 1)
  assert.equal(abortCalls[0]?.path?.id ?? abortCalls[0]?.id ?? abortCalls[0]?.sessionID, "s1")
  assert.equal(partUpdates.length, 1)
  assert.equal(promptCalls.length, 1)
  const promptPayload = JSON.stringify(promptCalls[0] ?? {})
  assert.match(promptPayload, /interrupted at the user's request|用户主动中止/i)
  assert.match(promptPayload, /partial evidence|结果可能不完整/i)
  assert.match(promptPayload, /do not resume|不要自动恢复/i)
  assert.match(promptPayload, /unless the user explicitly asks|除非用户明确要求/i)
  assert.match(promptPayload, /synthetic/i)
})

test("/copilot-stop-tool reports missing abort capability as capability error", async () => {
  const toasts = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [{ id: "p1", type: "tool", callID: "c1", state: "running" }],
            },
          ],
        }),
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "error")
  assert.match(String(toasts[0]?.body?.message ?? ""), /abort unavailable|abort capability|session\.abort/i)
})

test("/copilot-stop-tool reports recovery failure when promptAsync throws", async () => {
  const toasts = []
  const partUpdates = []
  let pollCount = 0
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: pollCount++ === 0
                ? [{ id: "p1", type: "tool", callID: "c1", state: "running" }]
                : [{ id: "p1", type: "tool", callID: "c1", state: "completed", output: "stdout" }],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async () => {
          throw new Error("prompt failed")
        },
      },
      part: {
        update: async (patch) => {
          partUpdates.push(patch)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length >= 1, true)
  assert.equal(partUpdates.length, 1)
  const lastToast = toasts.at(-1)
  assert.equal(lastToast?.body?.variant, "error")
  assert.match(String(lastToast?.body?.message ?? ""), /recovery failed|恢复失败|prompt failed/i)
})

test("/copilot-stop-tool patches completed tool transcript after abort before continue", async () => {
  const events = []
  const promptCalls = []
  const partUpdates = []
  const toasts = []
  const toolPart = {
    id: "p1",
    type: "tool",
    callID: "c1",
    state: "completed",
    output: "stdout",
  }

  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [toolPart],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async (payload) => {
          events.push("continue")
          promptCalls.push(payload)
        },
      },
      part: {
        update: async (patch) => {
          events.push("patch")
          partUpdates.push(patch)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [toolPart] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(partUpdates.length, 1)
  const patchPayload = JSON.stringify(partUpdates[0] ?? {})
  assert.match(patchPayload, /用户主动中止|结果可能不完整|aborted by user|result may be incomplete/i)
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(events, ["patch", "continue"])
  assert.equal(toasts.some((item) => item?.body?.variant === "error"), false)
})

test("/copilot-stop-tool patches error tool transcript after abort before continue", async () => {
  const events = []
  const promptCalls = []
  const partUpdates = []
  const toolPart = {
    id: "p1",
    type: "tool",
    callID: "c1",
    state: "error",
    error: "tool crashed",
  }

  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [toolPart],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async (payload) => {
          events.push("continue")
          promptCalls.push(payload)
        },
      },
      part: {
        update: async (patch) => {
          events.push("patch")
          partUpdates.push(patch)
        },
      },
      tui: {
        showToast: async () => {},
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [toolPart] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(partUpdates.length, 1)
  const patchPayload = JSON.stringify(partUpdates[0] ?? {})
  assert.match(patchPayload, /用户主动中止|结果可能不完整|aborted by user|result may be incomplete/i)
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(events, ["patch", "continue"])
})

test("/copilot-stop-tool warns when runningTools entry is not running/pending", async () => {
  const toasts = []
  const abortCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [{ type: "tool", callID: "c1", state: "completed" }],
            },
          ],
        }),
        abort: async (payload) => {
          abortCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(abortCalls.length, 0)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "warning")
})

test("/copilot-stop-tool reports abort failure via error toast", async () => {
  const toasts = []
  const promptCalls = []
  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [{ type: "tool", callID: "c1", state: "running" }],
            },
          ],
        }),
        abort: async () => {
          throw new Error("abort failed")
        },
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.body?.variant, "error")
  assert.match(String(toasts[0]?.body?.message ?? ""), /abort failed|停止失败|abort/i)
  assert.equal(promptCalls.length, 0)
})

test("/copilot-stop-tool reports unstable tool state timeout and does not continue", { timeout: 3000 }, async () => {
  const toasts = []
  const promptCalls = []
  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [{ type: "tool", callID: "c1", state: "running" }],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(promptCalls.length, 0)
  const lastToast = toasts.at(-1)
  assert.equal(lastToast?.body?.variant, "error")
  assert.match(String(lastToast?.body?.message ?? ""), /timeout|unstable|无法稳定|tool part/i)
})

test("/copilot-stop-tool does not continue when transcript patch update fails", async () => {
  const toasts = []
  const promptCalls = []
  const toolPart = {
    id: "p1",
    type: "tool",
    callID: "c1",
    state: "completed",
    output: "stdout",
  }
  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [toolPart],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      part: {
        update: async () => {
          throw new Error("patch failed")
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [toolPart] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(promptCalls.length, 0)
  const lastToast = toasts.at(-1)
  assert.equal(lastToast?.body?.variant, "error")
  assert.match(String(lastToast?.body?.message ?? ""), /patch failed|part\.update|补丁/i)
})

test("/copilot-stop-tool keeps patched transcript when promptAsync fails", async () => {
  const events = []
  const toasts = []
  const partUpdates = []
  const toolPart = {
    id: "p1",
    type: "tool",
    callID: "c1",
    state: "completed",
    output: "stdout",
  }

  const plugin = buildPluginHooks({
    loadStore: async () => ({
      accounts: {},
      experimentalSlashCommandsEnabled: true,
      syntheticAgentInitiatorEnabled: true,
    }),
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [toolPart],
            },
          ],
        }),
        abort: async () => {},
        promptAsync: async () => {
          events.push("continue")
          throw new Error("prompt failed")
        },
      },
      part: {
        update: async (patch) => {
          events.push("patch")
          partUpdates.push(patch)
        },
      },
      tui: {
        showToast: async (options) => {
          toasts.push(options)
        },
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash", state: "running" }],
      },
      { parts: [toolPart] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(partUpdates.length, 1)
  assert.match(JSON.stringify(partUpdates[0] ?? {}), /用户主动中止|结果可能不完整|aborted by user|result may be incomplete/i)
  assert.deepEqual(events, ["patch", "continue"])
  const lastToast = toasts.at(-1)
  assert.equal(lastToast?.body?.variant, "error")
  assert.match(String(lastToast?.body?.message ?? ""), /recovery failed|恢复失败|prompt failed/i)
})

test("/copilot-stop-tool keeps polling through transient missing messages", async () => {
  const promptCalls = []
  const messageResponses = [
    { data: [] },
    {
      data: [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [{ type: "tool", callID: "c1", state: "running" }],
        },
      ],
    },
    {
      data: [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [{ id: "p1", type: "tool", callID: "c1", state: "completed", output: "stdout" }],
        },
      ],
    },
  ]
  let messageCallCount = 0

  const plugin = buildPluginHooks({
    client: {
      session: {
        messages: async () => {
          const next = messageResponses[Math.min(messageCallCount, messageResponses.length - 1)]
          messageCallCount += 1
          return next
        },
        abort: async () => {},
        promptAsync: async (payload) => {
          promptCalls.push(payload)
        },
      },
      part: {
        update: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      {
        command: "copilot-stop-tool",
        sessionID: "s1",
        arguments: "",
        runningTools: [{ callID: "c1", tool: "bash" }],
      },
      { parts: [] },
    ),
    (error) => error?.name === "SessionControlCommandHandledError",
  )

  assert.equal(messageCallCount >= 3, true)
  assert.equal(promptCalls.length, 1)
})
