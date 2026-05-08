import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function loadCommonSettingsStoreOrFail() {
  try {
    return await import("../dist/common-settings-store.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("common settings store module is missing: ../dist/common-settings-store.js")
    }
    throw error
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

test("common settings preserve retry and WeChat fields without Loop Safety fields", async () => {
  const storeModule = await loadCommonSettingsStoreOrFail()
  const normalizeCommonSettings = storeModule.normalizeCommonSettings ?? storeModule.normalizeCommonSettingsStore
  const input = {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: false,
        sessionError: true,
      },
    },
  }

  const settings = typeof normalizeCommonSettings === "function"
    ? normalizeCommonSettings(input)
    : storeModule.parseCommonSettingsStore(JSON.stringify(input))

  assert.equal(Object.hasOwn(settings, "loopSafetyEnabled"), false)
  assert.equal(Object.hasOwn(settings, "loopSafetyProviderScope"), false)
  assert.equal(settings.networkRetryEnabled, true)
  assert.equal(settings.experimentalSlashCommandsEnabled, true)
  assert.equal(settings.wechat.notifications.permission, false)
})

test("common settings store path uses account-switcher settings.json", async () => {
  const { commonSettingsPath } = await loadCommonSettingsStoreOrFail()
  const normalized = commonSettingsPath().replace(/\\/g, "/")

  assert.equal(path.basename(normalized), "settings.json")
  assert.match(normalized, /\/opencode\/account-switcher\/settings\.json$/)
})

test("common settings store path follows late XDG_CONFIG_HOME override", async () => {
  const { commonSettingsPath } = await loadCommonSettingsStoreOrFail()
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-late-xdg-"))

  try {
    process.env.XDG_CONFIG_HOME = sandboxConfigHome
    const normalized = commonSettingsPath().replace(/\\/g, "/")
    const expectedPrefix = sandboxConfigHome.replace(/\\/g, "/")

    assert.match(normalized, new RegExp(`^${expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/opencode/account-switcher/settings\\.json$`))
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }
})

test("common settings store migrates retained legacy copilot flags into dedicated settings file", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-legacy-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
      experimentalStatusSlashCommandEnabled: true,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  await writeCommonSettingsStore(settings, { filePath: settingsFile })
  const raw = await readJson(settingsFile)

  assert.deepEqual(raw, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
  assert.equal(Object.hasOwn(raw, "experimentalStatusSlashCommandEnabled"), false)
})

test("common settings store prefers new settings and only backfills missing legacy fields", async () => {
  const { readCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-merge-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      networkRetryEnabled: false,
    }, null, 2),
    "utf8",
  )
  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {
        legacy: { name: "legacy", refresh: "r", access: "a", expires: 0 },
      },
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: false,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
})

test("common settings store migration is idempotent across repeated reads and writes", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-idempotent-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      networkRetryEnabled: true,
      experimentalStatusSlashCommandEnabled: false,
    }, null, 2),
    "utf8",
  )

  const first = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })
  await writeCommonSettingsStore(first, { filePath: settingsFile })

  const second = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })
  await writeCommonSettingsStore(second, { filePath: settingsFile })

  assert.deepEqual(second, first)
  assert.deepEqual(await readJson(settingsFile), {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
})

test("writing normalized defaults overrides legacy common settings instead of reviving old values", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-defaults-"))
  const settingsFile = path.join(dir, "settings.json")
  const legacyCopilotFile = path.join(dir, "copilot-accounts.json")

  await writeFile(
    legacyCopilotFile,
    JSON.stringify({
      accounts: {},
      networkRetryEnabled: true,
      experimentalSlashCommandsEnabled: false,
    }, null, 2),
    "utf8",
  )

  await writeCommonSettingsStore({
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  }, { filePath: settingsFile })

  assert.deepEqual(await readJson(settingsFile), {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    wechat: {
      notifications: {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      },
    },
  })
})

test("common settings store migrates legacy flat wechat booleans into nested object", async () => {
  const { readCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-wechat-legacy-"))
  const settingsFile = path.join(dir, "settings.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      wechatNotificationsEnabled: false,
      wechatQuestionNotifyEnabled: true,
      wechatPermissionNotifyEnabled: false,
      wechatSessionErrorNotifyEnabled: true,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({ filePath: settingsFile })
  assert.deepEqual(settings.wechat, {
    notifications: {
      enabled: false,
      question: true,
      permission: false,
      sessionError: true,
    },
  })
})

test("common settings store persists nested wechat settings with primaryBinding and future accounts", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-wechat-"))
  const settingsFile = path.join(dir, "settings.json")

  await writeCommonSettingsStore({
    wechat: {
      primaryBinding: {
        accountId: "wechat-main",
        userId: "u-1",
        name: "主微信",
        enabled: true,
        configured: true,
        boundAt: 1710000000000,
      },
      notifications: {
        enabled: false,
        question: true,
        permission: false,
        sessionError: true,
      },
      future: {
        accounts: [
          {
            accountId: "wechat-main",
            userId: "u-1",
            name: "主微信",
            enabled: true,
            configured: true,
            boundAt: 1710000000000,
          },
        ],
      },
    },
  }, { filePath: settingsFile })

  const raw = await readJson(settingsFile)
  assert.deepEqual(raw, {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    wechat: {
      primaryBinding: {
        accountId: "wechat-main",
        userId: "u-1",
        name: "主微信",
        enabled: true,
        configured: true,
        boundAt: 1710000000000,
      },
      notifications: {
        enabled: false,
        question: true,
        permission: false,
        sessionError: true,
      },
      future: {
        accounts: [
          {
            accountId: "wechat-main",
            userId: "u-1",
            name: "主微信",
            enabled: true,
            configured: true,
            boundAt: 1710000000000,
          },
        ],
      },
    },
  })

  const settings = await readCommonSettingsStore({ filePath: settingsFile })
  assert.equal(settings.wechat?.primaryBinding?.accountId, "wechat-main")
  assert.deepEqual(settings.wechat?.notifications, {
    enabled: false,
    question: true,
    permission: false,
    sessionError: true,
  })
  assert.deepEqual(settings.wechat?.future?.accounts, [
    {
      accountId: "wechat-main",
      userId: "u-1",
      name: "主微信",
      enabled: true,
      configured: true,
      boundAt: 1710000000000,
    },
  ])
})

test("common settings store keeps reading notifications when future accounts is absent", async () => {
  const { readCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-wechat-future-"))
  const settingsFile = path.join(dir, "settings.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      wechat: {
        notifications: {
          enabled: true,
          question: false,
          permission: true,
          sessionError: false,
        },
      },
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({ filePath: settingsFile })
  assert.deepEqual(settings.wechat?.notifications, {
    enabled: true,
    question: false,
    permission: true,
    sessionError: false,
  })
})
