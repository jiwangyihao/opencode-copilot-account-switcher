import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const WECHAT_ACTION_PREFIX = ["we", "chat"].join("")
const WECHAT_ACTION_TYPES = [
  `${WECHAT_ACTION_PREFIX}-bind`,
  `${WECHAT_ACTION_PREFIX}-rebind`,
  `${WECHAT_ACTION_PREFIX}-unbind`,
  `toggle-${WECHAT_ACTION_PREFIX}-notifications`,
  `toggle-${WECHAT_ACTION_PREFIX}-question-notify`,
  `toggle-${WECHAT_ACTION_PREFIX}-permission-notify`,
  `toggle-${WECHAT_ACTION_PREFIX}-session-error-notify`,
]

async function loadCommonSettingsActionsOrFail() {
  try {
    return await import("../dist/common-settings-actions.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("common settings actions module is missing: ../dist/common-settings-actions.js")
    }
    throw error
  }
}

test("common settings actions toggles experimental slash commands and writes back", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
  }

  const handled = await applyCommonSettingsAction({
    action: { type: "toggle-experimental-slash-commands" },
    readSettings: async () => settings,
    writeSettings: async (next, meta) => {
      writes.push({ next: { ...next }, meta })
    },
  })

  assert.equal(handled, true)
  assert.equal(settings.experimentalSlashCommandsEnabled, false)
  assert.equal(Object.hasOwn(settings, "wechat"), false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.meta?.actionType, "toggle-experimental-slash-commands")
})

test("common settings actions toggles network retry and writes back", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()
  const writes = []
  const settings = {
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
  }

  const handled = await applyCommonSettingsAction({
    action: { type: "toggle-network-retry" },
    readSettings: async () => settings,
    writeSettings: async (next, meta) => {
      writes.push({ next: { ...next }, meta })
    },
  })

  assert.equal(handled, true)
  assert.equal(settings.networkRetryEnabled, true)
  assert.equal(Object.hasOwn(settings, "wechat"), false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.meta?.actionType, "toggle-network-retry")
})

test("common settings action union source excludes WeChat actions", async () => {
  const source = await readFile(new URL("../src/common-settings-actions.ts", import.meta.url), "utf8")

  for (const type of WECHAT_ACTION_TYPES) {
    assert.equal(source.includes(type), false, type)
  }
})

test("common settings actions do not handle WeChat actions", async () => {
  const { applyCommonSettingsAction } = await loadCommonSettingsActionsOrFail()

  for (const type of WECHAT_ACTION_TYPES) {
    const writes = []
    const settings = {
      experimentalSlashCommandsEnabled: true,
      networkRetryEnabled: false,
    }
    const handled = await applyCommonSettingsAction({
      action: { type },
      readSettings: async () => settings,
      writeSettings: async (next, meta) => {
        writes.push({ next, meta })
      },
    })

    assert.equal(handled, false, type)
    assert.equal(Object.hasOwn(settings, "wechat"), false, type)
    assert.deepEqual(writes, [], type)
  }
})
