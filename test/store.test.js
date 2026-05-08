import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseStore, readAuth, readStore, readStoreSafe, storePath, writeStore } from "../dist/store.js"

async function withStoreDebugEnv(logFile, enabled, action) {
  const previousFile = process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE
  const previousEnabled = process.env.OPENCODE_COPILOT_STORE_DEBUG

  process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE = logFile
  if (enabled === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG
  else process.env.OPENCODE_COPILOT_STORE_DEBUG = enabled

  try {
    return await action()
  } finally {
    if (previousFile === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE
    else process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE = previousFile

    if (previousEnabled === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG
    else process.env.OPENCODE_COPILOT_STORE_DEBUG = previousEnabled
  }
}

async function readDebugLogEvent(logFile) {
  const log = await readFile(logFile, "utf8")
  const lines = log.trim().split("\n")

  assert.equal(lines.length, 1)
  return JSON.parse(lines[0])
}


test("storePath uses account-switcher copilot store path", () => {
  const normalized = storePath().replace(/\\/g, "/")

  assert.equal(path.basename(normalized), "copilot-accounts.json")
  assert.match(normalized, /\/opencode\/account-switcher\/copilot-accounts\.json$/)
})

test("parseStore defaults networkRetryEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.networkRetryEnabled, false)
})

test("parseStore defaults syntheticAgentInitiatorEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.syntheticAgentInitiatorEnabled, false)
})

test("parseStore coerces invalid syntheticAgentInitiatorEnabled values to false", () => {
  const store = parseStore('{"accounts":{},"syntheticAgentInitiatorEnabled":"yes"}')

  assert.equal(store.syntheticAgentInitiatorEnabled, false)
})

test("parseStore preserves networkRetryEnabled when explicitly true", () => {
  const store = parseStore('{"accounts":{},"networkRetryEnabled":true}')

  assert.equal(store.networkRetryEnabled, true)
})

test("experimental slash commands default to enabled", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.experimentalSlashCommandsEnabled, true)
})

test("experimental slash commands preserve explicit false", () => {
  const store = parseStore('{"accounts":{},"experimentalSlashCommandsEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, false)
})

test("experimental slash commands inherit legacy status slash false when new flag is missing", () => {
  const store = parseStore('{"accounts":{},"experimentalStatusSlashCommandEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, false)
})

test("experimental slash commands explicit true overrides legacy false", () => {
  const store = parseStore('{"accounts":{},"experimentalSlashCommandsEnabled":true,"experimentalStatusSlashCommandEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, true)
})

test("parseStore does not leak legacy experimentalStatusSlashCommandEnabled field", () => {
  const store = parseStore('{"accounts":{},"experimentalStatusSlashCommandEnabled":false}')

  assert.equal("experimentalStatusSlashCommandEnabled" in store, false)
})

test("parseStore keeps lastAccountSwitchAt when present", () => {
  const store = parseStore(
    '{"accounts":{"primary":{"refresh":"r","access":"a","expires":1}},"lastAccountSwitchAt":1735689600000}'
  )

  assert.equal(store.lastAccountSwitchAt, 1735689600000)
  assert.equal(store.accounts.primary.name, "primary")
})

test("parseStore clears lastAccountSwitchAt when it is not numeric", () => {
  const store = parseStore(
    '{"accounts":{"primary":{"refresh":"r","access":"a","expires":1}},"lastAccountSwitchAt":"1735689600000"}'
  )

  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.equal(store.accounts.primary.name, "primary")
})

test("parseStore leaves lastAccountSwitchAt undefined by default", () => {
  const store = parseStore('{"accounts":{"secondary":{"refresh":"r","access":"a","expires":1}}}')

  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.equal(store.networkRetryEnabled, false)
  assert.equal(store.accounts.secondary.name, "secondary")
})

test("parseStore migrates legacy active into activeAccountNames while preserving active", () => {
  const store = parseStore(
    JSON.stringify({
      active: "main",
      accounts: {
        main: { name: "main", refresh: "r", access: "a", expires: 0 },
      },
    }),
  )

  assert.equal(store.active, "main")
  assert.deepEqual(store.activeAccountNames, ["main"])
})

test("parseStore normalizes array model assignments and drops missing accounts", () => {
  const store = parseStore(
    JSON.stringify({
      active: "main",
      activeAccountNames: ["alt", "missing", "main", "alt"],
      modelAccountAssignments: {
        "gpt-5": ["main", "alt", "main", "missing"],
      },
      accounts: {
        main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
        alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
      },
    }),
  )

  assert.deepEqual(store.activeAccountNames, ["alt", "main"])
  assert.deepEqual(store.modelAccountAssignments, { "gpt-5": ["main", "alt"] })
})

test("parseStore migrates legacy string model assignment into single-element array", () => {
  const store = parseStore(
    JSON.stringify({
      active: "main",
      modelAccountAssignments: {
        "gpt-5": "alt",
      },
      accounts: {
        main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
        alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
      },
    }),
  )

  assert.deepEqual(store.modelAccountAssignments, { "gpt-5": ["alt"] })
})

test("parseStore throws on malformed JSON for strict readers", () => {
  assert.throws(() => parseStore("{"))
})

test("readStore rejects malformed JSON from an existing store file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-bad-json-"))
  const file = path.join(dir, "copilot-accounts.json")
  await writeFile(file, "{", "utf8")

  await assert.rejects(() => readStore(file))
})

test("readStore defaults a missing store file to an empty store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStore(file)

  assert.deepEqual(store.accounts, {})
})

test("readStoreSafe also defaults a missing store file to an empty store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-safe-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStoreSafe(file)

  assert.deepEqual(store?.accounts, {})
})

test("readStore throws when the path is unreadable as a file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-dir-"))

  await assert.rejects(() => readStore(dir))
})

test("readStoreSafe returns undefined for malformed JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-"))
  const file = path.join(dir, "copilot-accounts.json")
  await writeFile(file, "{", "utf8")

  const store = await readStoreSafe(file)

  assert.equal(store, undefined)
})

test("readStoreSafe returns undefined for unreadable files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-unreadable-"))

  const store = await readStoreSafe(dir)

  assert.equal(store, undefined)
})

test("readAuth preserves optional accountId from auth.json oauth entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-auth-"))
  const file = path.join(dir, "auth.json")
  await writeFile(
    file,
    JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh_token",
        access: "access_token",
        expires: 1700000000000,
        accountId: "acct_from_auth_json",
      },
    }),
    "utf8",
  )

  const auth = await readAuth(file)

  assert.equal(auth.openai?.accountId, "acct_from_auth_json")
})

test("writeStore does not emit debug log by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-store-debug-default-off-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        networkRetryEnabled: true,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, undefined, async () => {
    await writeStore(
      {
        accounts: {},
        networkRetryEnabled: true,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-network-retry",
          source: "applyCommonSettingsAction",
          actionType: "toggle-network-retry",
        },
      },
    )
  })

  await assert.rejects(readFile(logFile, "utf8"), /ENOENT/)
})

test("writeStore emits enabled debug log with reason and before-after snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-store-debug-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        networkRetryEnabled: true,
        lastAccountSwitchAt: 123,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, "1", async () => {
    await writeStore(
      {
        accounts: {},
        networkRetryEnabled: true,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-network-retry",
          source: "applyCommonSettingsAction",
          actionType: "toggle-network-retry",
        },
      },
    )
  })

  const event = await readDebugLogEvent(logFile)

  assert.equal(event.kind, "store-write")
  assert.equal(event.reason, "toggle-network-retry")
  assert.equal(event.source, "applyCommonSettingsAction")
  assert.equal(event.actionType, "toggle-network-retry")
  assert.equal(event.cwd, process.cwd())
  assert.ok(Array.isArray(event.argv))
  assert.ok(Array.isArray(event.stack))
  assert.match(event.stack.join("\n"), /store\.test\.js/)
  assert.deepEqual(event.before, {
    active: null,
    accountCount: 1,
    modelAccountAssignmentCount: 0,
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
    lastAccountSwitchAt: 123,
    syntheticAgentInitiatorEnabled: false,
  })
  assert.deepEqual(event.after, {
    active: null,
    accountCount: 0,
    modelAccountAssignmentCount: 0,
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: null,
    lastAccountSwitchAt: null,
    syntheticAgentInitiatorEnabled: false,
  })
})

test("writeStore enabled debug snapshot includes syntheticAgentInitiatorEnabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-initiator-store-debug-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        syntheticAgentInitiatorEnabled: true,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, "1", async () => {
    await writeStore(
      {
        accounts: {},
        syntheticAgentInitiatorEnabled: false,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-synthetic-agent-initiator",
        },
      },
    )
  })

  const event = await readDebugLogEvent(logFile)

  assert.equal(event.before.syntheticAgentInitiatorEnabled, true)
  assert.equal(event.after.syntheticAgentInitiatorEnabled, false)
})
