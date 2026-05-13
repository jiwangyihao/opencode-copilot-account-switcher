import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

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

function assertNoWechatSettings(settings) {
  assert.equal(Object.hasOwn(settings, "wechat"), false)
  assert.equal(Object.hasOwn(settings, "wechatNotificationsEnabled"), false)
  assert.equal(Object.hasOwn(settings, "wechatQuestionNotifyEnabled"), false)
  assert.equal(Object.hasOwn(settings, "wechatPermissionNotifyEnabled"), false)
  assert.equal(Object.hasOwn(settings, "wechatSessionErrorNotifyEnabled"), false)
}

test("common settings preserve retry fields without Loop Safety or WeChat fields", async () => {
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
    wechatNotificationsEnabled: false,
  }

  const settings = typeof normalizeCommonSettings === "function"
    ? normalizeCommonSettings(input)
    : storeModule.parseCommonSettingsStore(JSON.stringify(input))

  assert.equal(Object.hasOwn(settings, "loopSafetyEnabled"), false)
  assert.equal(Object.hasOwn(settings, "loopSafetyProviderScope"), false)
  assert.equal(settings.networkRetryEnabled, true)
  assert.equal(settings.experimentalSlashCommandsEnabled, true)
  assertNoWechatSettings(settings)
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
    const expectedPrefix = sandboxConfigHome.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    assert.match(normalized, new RegExp(`^${expectedPrefix}/opencode/account-switcher/settings\\.json$`))
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
  })

  await writeCommonSettingsStore(settings, { filePath: settingsFile })
  const raw = await readJson(settingsFile)

  assert.deepEqual(raw, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: false,
  })
  assertNoWechatSettings(raw)
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
  })
  assertNoWechatSettings(settings)
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
  })
  assertNoWechatSettings(second)
})

test("writing normalized defaults does not persist WeChat or legacy flat WeChat fields", async () => {
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
      wechatNotificationsEnabled: false,
      wechatQuestionNotifyEnabled: false,
    }, null, 2),
    "utf8",
  )

  await writeCommonSettingsStore({
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    wechat: {
      notifications: {
        enabled: false,
        question: false,
        permission: false,
        sessionError: false,
      },
    },
    wechatNotificationsEnabled: false,
  }, { filePath: settingsFile })

  const raw = await readJson(settingsFile)
  assert.deepEqual(raw, {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  })
  assertNoWechatSettings(raw)

  const settings = await readCommonSettingsStore({
    filePath: settingsFile,
    legacyCopilotFilePath: legacyCopilotFile,
  })

  assert.deepEqual(settings, {
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
  })
  assertNoWechatSettings(settings)
})

test("common settings store ignores legacy flat WeChat booleans", async () => {
  const { readCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-wechat-legacy-"))
  const settingsFile = path.join(dir, "settings.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      networkRetryEnabled: true,
      wechatNotificationsEnabled: false,
      wechatQuestionNotifyEnabled: true,
      wechatPermissionNotifyEnabled: false,
      wechatSessionErrorNotifyEnabled: true,
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({ filePath: settingsFile })
  assert.deepEqual(settings, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
  })
  assertNoWechatSettings(settings)
})

test("common settings store drops nested WeChat settings when reading and writing", async () => {
  const { readCommonSettingsStore, writeCommonSettingsStore } = await loadCommonSettingsStoreOrFail()
  const dir = await mkdtemp(path.join(os.tmpdir(), "common-settings-store-wechat-"))
  const settingsFile = path.join(dir, "settings.json")

  await writeFile(
    settingsFile,
    JSON.stringify({
      networkRetryEnabled: true,
      wechat: {
        primaryBinding: {
          accountId: "wechat-main",
          userId: "u-1",
        },
        notifications: {
          enabled: false,
          question: true,
          permission: false,
          sessionError: true,
        },
      },
    }, null, 2),
    "utf8",
  )

  const settings = await readCommonSettingsStore({ filePath: settingsFile })
  assert.deepEqual(settings, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
  })
  assertNoWechatSettings(settings)

  await writeCommonSettingsStore(settings, { filePath: settingsFile })
  const raw = await readJson(settingsFile)
  assert.deepEqual(raw, {
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
  })
  assertNoWechatSettings(raw)
})
