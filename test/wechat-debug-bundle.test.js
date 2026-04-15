import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { createRequire, syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const collectorModulePromise = import("../dist/wechat/debug-bundle-collector.js").catch((error) => ({
  __importError: error,
}))

const redactionModulePromise = import("../dist/wechat/debug-bundle-redaction.js").catch((error) => ({
  __importError: error,
}))

const require = createRequire(import.meta.url)

const restorers = []

afterEach(async () => {
  while (restorers.length > 0) {
    const restore = restorers.pop()
    await restore()
  }
})

async function withWechatStateRoot(prefix) {
  const sandbox = await setupIsolatedWechatStateRoot(prefix)
  restorers.push(() => sandbox.restore())
  return sandbox.stateRoot
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

function byBundlePath(bundle, relativePath) {
  return bundle.entries.find((entry) => entry.bundlePath === relativePath)
}

function readJsonEntry(bundle, relativePath) {
  const entry = byBundlePath(bundle, relativePath)
  assert.ok(entry, `missing entry: ${relativePath}`)
  return JSON.parse(entry.content.toString("utf8"))
}

function listBundlePaths(bundle) {
  return bundle.entries.map((entry) => entry.bundlePath).sort()
}

async function importFreshCollector() {
  return import(`../dist/wechat/debug-bundle-collector.js?ts=${Date.now()}-${Math.random()}`)
}

test("collector 枚举状态与诊断文件，并生成稳定 manifest 与环境摘要", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )
  assert.equal(typeof collectorModule.collectWechatDebugBundle, "function")

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-")
  const cwd = path.join(os.tmpdir(), "wechat-debug-bundle-cwd")
  await mkdir(cwd, { recursive: true })
  restorers.push(() => rm(cwd, { recursive: true, force: true }))

  await writeJson(path.join(stateRoot, "broker.json"), {
    contextToken: "ctx-secret",
    wechatAccountId: "wx-primary",
    userId: "user-primary",
  })
  await writeJson(path.join(stateRoot, "operator.json"), {
    wechatAccountId: "wx-primary",
    userId: "user-primary",
  })
  await writeJson(path.join(stateRoot, "latest-account.json"), {
    accountId: "wx-primary",
    token: "latest-token",
    baseUrl: "https://wx.example.com",
  })
  await writeJson(path.join(stateRoot, "tokens", "wx-primary", "user-primary.json"), {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    cookie: "session=abc",
  })
  await writeJson(path.join(stateRoot, "tokens", "wx-primary", "nested", "user-secondary.json"), {
    accessToken: "nested-secret",
  })
  await writeText(
    path.join(stateRoot, "tokens", "wx-primary", ".user-primary.json.1234.partial.tmp"),
    '{"accessToken":"temp-secret","contextToken":"ctx-temp"',
  )
  await writeJson(path.join(stateRoot, "notifications", "notif-1.json"), {
    messageBody: "hello world",
    text: "visible text",
  })
  await writeJson(path.join(stateRoot, "requests", "question", "route-a.json"), {
    body: "question body",
    fromUserId: "from-user-1",
  })
  await writeJson(path.join(stateRoot, "dead-letter", "permission", "route-dead.json"), {
    rawText: "dead body",
    toUserId: "to-user-1",
  })
  await writeJson(path.join(stateRoot, "instances", "instance-1.json"), {
    bearerToken: "bearer-secret",
    message: "instance message",
  })
  await writeText(
    path.join(stateRoot, "wechat-status-runtime.diagnostics.jsonl"),
    `${JSON.stringify({ contextToken: "ctx-log", messageBody: "runtime body" })}\n`,
  )
  await writeText(
    path.join(stateRoot, "wechat-broker.diagnostics.jsonl"),
    `${JSON.stringify({ accessToken: "diag-token", userId: "diag-user" })}\n`,
  )
  await writeText(
    path.join(stateRoot, "wechat-bridge.diagnostics.jsonl"),
    `${JSON.stringify({ cookie: "diag-cookie", text: "bridge text" })}\n`,
  )
  await writeText(
    path.join(stateRoot, "broker-startup.diagnostics.log"),
    "Authorization: Bearer abc\nmessageBody=hello\n",
  )

  const bundle = await collectorModule.collectWechatDebugBundle({
    mode: "sanitized",
    now: new Date("2026-04-11T08:30:00.000Z"),
    cwd,
    pluginVersion: "0.14.38-test",
    gitHead: "abcdef1234567890",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  assert.deepEqual(listBundlePaths(bundle), [
    "diagnostics/broker-startup.diagnostics.log",
    "diagnostics/wechat-bridge.diagnostics.jsonl",
    "diagnostics/wechat-broker.diagnostics.jsonl",
    "diagnostics/wechat-status-runtime.diagnostics.jsonl",
    "environment-summary.json",
    "manifest.json",
    "state/broker.json",
    "state/dead-letter/permission/route-dead.json",
    "state/instances/instance-1.json",
    "state/latest-account.json",
    "state/notifications/notif-1.json",
    "state/operator.json",
    "state/requests/question/route-a.json",
    "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2]/[REDACTED_USER_ID_3].json",
    "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_4].json",
  ])

  assert.equal(bundle.manifest.mode, "sanitized")
  assert.equal(bundle.manifest.exportedAt, "2026-04-11T08:30:00.000Z")
  assert.deepEqual(bundle.manifest.missingPaths, [])
  assert.deepEqual(bundle.manifest.entries.map((entry) => ({
    bundlePath: entry.bundlePath,
    category: entry.category,
    redacted: entry.redacted,
  })), [
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", category: "diagnostics", redacted: true },
    { bundlePath: "diagnostics/wechat-bridge.diagnostics.jsonl", category: "diagnostics", redacted: true },
    { bundlePath: "diagnostics/wechat-broker.diagnostics.jsonl", category: "diagnostics", redacted: true },
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", category: "diagnostics", redacted: true },
     { bundlePath: "environment-summary.json", category: "metadata", redacted: false },
     { bundlePath: "manifest.json", category: "metadata", redacted: false },
     { bundlePath: "state/broker.json", category: "state", redacted: true },
     { bundlePath: "state/dead-letter/permission/route-dead.json", category: "state", redacted: true },
     { bundlePath: "state/instances/instance-1.json", category: "state", redacted: true },
     { bundlePath: "state/latest-account.json", category: "state", redacted: true },
     { bundlePath: "state/notifications/notif-1.json", category: "state", redacted: true },
     { bundlePath: "state/operator.json", category: "state", redacted: true },
     { bundlePath: "state/requests/question/route-a.json", category: "state", redacted: true },
     {
       bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2]/[REDACTED_USER_ID_3].json",
       category: "state",
       redacted: true,
     },
     {
       bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_4].json",
       category: "state",
       redacted: true,
     },
  ])

  const environmentSummary = readJsonEntry(bundle, "environment-summary.json")
  assert.deepEqual(environmentSummary, {
    pluginVersion: "0.14.38-test",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
    cwd: "[REDACTED_CWD]",
    gitHead: "abcdef1234567890",
    mode: "sanitized",
    stateRoot: "[REDACTED_STATE_ROOT]",
    stateRootExists: true,
    checks: {
      "broker.json": true,
      "tokens": true,
      "notifications": true,
      "requests": true,
      "dead-letter": true,
      "instances": true,
      "wechat-status-runtime.diagnostics.jsonl": true,
      "wechat-broker.diagnostics.jsonl": true,
      "wechat-bridge.diagnostics.jsonl": true,
      "broker-startup.diagnostics.log": true,
    },
  })

  const manifestEntry = readJsonEntry(bundle, "manifest.json")
  assert.equal(manifestEntry.mode, "sanitized")
  assert.equal(manifestEntry.stateRoot, "[REDACTED_STATE_ROOT]")
  assert.equal(manifestEntry.entries[0].bundlePath, "diagnostics/broker-startup.diagnostics.log")
  assert.ok(manifestEntry.entries.filter((entry) => entry.category !== "metadata").every((entry) => entry.sourcePath === null))
  assert.ok(
    manifestEntry.entries
      .filter((entry) => entry.category !== "metadata")
      .every((entry) => entry.redactedSourcePath.startsWith("[REDACTED_STATE_ROOT]")),
  )
  assert.deepEqual(manifestEntry.entries.at(-2), {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2]/[REDACTED_USER_ID_3].json",
    category: "state",
    redacted: true,
    sourcePath: null,
    redactedSourcePath: path.join(
      "[REDACTED_STATE_ROOT]",
      "tokens",
      "[REDACTED_ACCOUNT_ID_1]",
      "[REDACTED_USER_ID_2]",
      "[REDACTED_USER_ID_3].json",
    ),
  })
  assert.deepEqual(manifestEntry.entries.at(-1), {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_4].json",
    category: "state",
    redacted: true,
    sourcePath: null,
    redactedSourcePath: path.join(
      "[REDACTED_STATE_ROOT]",
      "tokens",
      "[REDACTED_ACCOUNT_ID_1]",
      "[REDACTED_USER_ID_4].json",
    ),
  })
  assert.equal(
    byBundlePath(bundle, "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2]/[REDACTED_USER_ID_3].json").sourcePath,
    path.join(stateRoot, "tokens", "wx-primary", "nested", "user-secondary.json"),
  )
  assert.equal(
    byBundlePath(bundle, "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_4].json").sourcePath,
    path.join(stateRoot, "tokens", "wx-primary", "user-primary.json"),
  )
  const tempSkipped = manifestEntry.skippedEntries.find((entry) => entry.reason === "token-temp-file")
  assert.ok(tempSkipped)
  assert.match(tempSkipped.bundlePath, /^state\/tokens\/\[REDACTED_ACCOUNT_ID_1\]\/\[REDACTED_USER_ID_\d+\]\.tmp$/)
  assert.equal(tempSkipped.sourcePath, null)
  assert.match(
    tempSkipped.redactedSourcePath.replaceAll("\\", "/"),
    /^\[REDACTED_STATE_ROOT\]\/tokens\/\[REDACTED_ACCOUNT_ID_1\]\/\[REDACTED_USER_ID_\d+\]\.tmp$/,
  )
  assert.equal(bundle.entries.some((entry) => entry.bundlePath.endsWith(".tmp")), false)
  assert.doesNotMatch(JSON.stringify(manifestEntry), /wx-primary|user-primary|user-secondary/)
  assert.doesNotMatch(JSON.stringify(manifestEntry), /temp-secret|ctx-temp/)
})

test("sanitized 与 full 模式对敏感字段的处理不同", async () => {
  const collectorModule = await collectorModulePromise
  const redactionModule = await redactionModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )
  assert.equal(
    redactionModule.__importError,
    undefined,
    `redaction module should exist: ${redactionModule.__importError?.message ?? "missing"}`,
  )
  assert.equal(typeof redactionModule.redactDebugBundleContent, "function")

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-redaction-")
  await writeJson(path.join(stateRoot, "operator.json"), {
    wechatAccountId: "wx-raw",
    userId: "user-raw",
    contextToken: "operator-ctx-raw",
  })
  await writeJson(path.join(stateRoot, "broker.json"), {
    contextToken: "ctx-secret",
    wechatAccountId: "wx-raw",
    userId: "user-raw",
    accessToken: "access-raw",
    cookie: "session=raw",
    messageBody: "sensitive body",
  })
  await writeJson(path.join(stateRoot, "latest-account.json"), {
    accountId: "wx-raw",
    token: "latest-token-raw",
    baseUrl: "https://wx.example.com",
  })
  await writeJson(path.join(stateRoot, "tokens", "wx-raw", "user-raw.json"), {
    contextToken: "ctx-token-raw",
    wechatAccountId: "wx-raw",
    userId: "user-raw",
    accessToken: "access-token-raw",
    refreshToken: "refresh-token-raw",
    cookie: "session=token-raw",
  })
  await writeText(
    path.join(stateRoot, "broker-startup.diagnostics.log"),
    "Authorization: Bearer access-raw\nmessageBody=sensitive body\nuserId=user-raw\n",
  )

  const sanitized = await collectorModule.collectWechatDebugBundle({
    mode: "sanitized",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-1",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })
  const full = await collectorModule.collectWechatDebugBundle({
    mode: "full",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-1",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  const sanitizedOperator = readJsonEntry(sanitized, "state/operator.json")
  assert.equal(sanitizedOperator.wechatAccountId, "[REDACTED_ACCOUNT_ID]")
  assert.equal(sanitizedOperator.userId, "[REDACTED_USER_ID]")
  assert.equal(sanitizedOperator.contextToken, "[REDACTED_CONTEXT_TOKEN]")

  const sanitizedBroker = readJsonEntry(sanitized, "state/broker.json")
  assert.equal(sanitizedBroker.contextToken, "[REDACTED_CONTEXT_TOKEN]")
  assert.equal(sanitizedBroker.wechatAccountId, "[REDACTED_ACCOUNT_ID]")
  assert.equal(sanitizedBroker.userId, "[REDACTED_USER_ID]")
  assert.equal(sanitizedBroker.accessToken, "[REDACTED_TOKEN]")
  assert.equal(sanitizedBroker.cookie, "[REDACTED_CREDENTIAL]")
  assert.equal(sanitizedBroker.messageBody, "[REDACTED_MESSAGE_TEXT]")

  const sanitizedLatestAccount = readJsonEntry(sanitized, "state/latest-account.json")
  assert.equal(sanitizedLatestAccount.accountId, "[REDACTED_ACCOUNT_ID]")
  assert.equal(sanitizedLatestAccount.token, "[REDACTED_TOKEN]")
  assert.equal(sanitizedLatestAccount.baseUrl, "https://wx.example.com")

  const sanitizedTokenEntry = sanitized.entries.find((entry) => entry.bundlePath.startsWith("state/tokens/"))
  assert.ok(sanitizedTokenEntry, "missing sanitized token entry")
  const sanitizedToken = JSON.parse(sanitizedTokenEntry.content.toString("utf8"))
  assert.equal(sanitizedToken.contextToken, "[REDACTED_CONTEXT_TOKEN]")
  assert.equal(sanitizedToken.wechatAccountId, "[REDACTED_ACCOUNT_ID]")
  assert.equal(sanitizedToken.userId, "[REDACTED_USER_ID]")
  assert.equal(sanitizedToken.accessToken, "[REDACTED_TOKEN]")
  assert.equal(sanitizedToken.refreshToken, "[REDACTED_TOKEN]")
  assert.equal(sanitizedToken.cookie, "[REDACTED_CREDENTIAL]")

  const fullOperator = readJsonEntry(full, "state/operator.json")
  assert.equal(fullOperator.wechatAccountId, "wx-raw")
  assert.equal(fullOperator.userId, "user-raw")
  assert.equal(fullOperator.contextToken, "operator-ctx-raw")

  const fullBroker = readJsonEntry(full, "state/broker.json")
  assert.equal(fullBroker.contextToken, "ctx-secret")
  assert.equal(fullBroker.wechatAccountId, "wx-raw")
  assert.equal(fullBroker.userId, "user-raw")
  assert.equal(fullBroker.accessToken, "access-raw")
  assert.equal(fullBroker.cookie, "session=raw")
  assert.equal(fullBroker.messageBody, "sensitive body")

  const fullLatestAccount = readJsonEntry(full, "state/latest-account.json")
  assert.equal(fullLatestAccount.accountId, "wx-raw")
  assert.equal(fullLatestAccount.token, "latest-token-raw")
  assert.equal(fullLatestAccount.baseUrl, "https://wx.example.com")

  const fullToken = readJsonEntry(full, "state/tokens/wx-raw/user-raw.json")
  assert.equal(fullToken.contextToken, "ctx-token-raw")
  assert.equal(fullToken.wechatAccountId, "wx-raw")
  assert.equal(fullToken.userId, "user-raw")
  assert.equal(fullToken.accessToken, "access-token-raw")
  assert.equal(fullToken.refreshToken, "refresh-token-raw")
  assert.equal(fullToken.cookie, "session=token-raw")

  const sanitizedLog = byBundlePath(sanitized, "diagnostics/broker-startup.diagnostics.log")
  const fullLog = byBundlePath(full, "diagnostics/broker-startup.diagnostics.log")
  assert.match(sanitizedLog.content.toString("utf8"), /\[REDACTED_TOKEN\]/)
  assert.match(sanitizedLog.content.toString("utf8"), /\[REDACTED_MESSAGE_TEXT\]/)
  assert.match(sanitizedLog.content.toString("utf8"), /\[REDACTED_USER_ID\]/)
  assert.match(fullLog.content.toString("utf8"), /Bearer access-raw/)
  assert.match(fullLog.content.toString("utf8"), /messageBody=sensitive body/)
  assert.match(fullLog.content.toString("utf8"), /userId=user-raw/)
})

test("wechat debug bundle: sanitized 模式下损坏的新增状态文件 fail closed，full 模式保留原文", async () => {
  const collectorModule = await collectorModulePromise
  const redactionModule = await redactionModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )
  assert.equal(
    redactionModule.__importError,
    undefined,
    `redaction module should exist: ${redactionModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-corrupt-extra-state-")
  await writeText(
    path.join(stateRoot, "operator.json"),
    '{"wechatAccountId":"acc-secret","userId":"user-secret"',
  )
  await writeText(
    path.join(stateRoot, "latest-account.json"),
    '{"accountId":"acc-secret","token":"token-secret"',
  )
  await writeText(
    path.join(stateRoot, "tokens", "acc-secret", "user-secret.json"),
    '{"contextToken":"ctx-secret","refreshToken":"refresh-secret"',
  )

  const sanitized = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "sanitized",
  })
  const full = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  for (const relativePath of [
    "state/operator.json",
    "state/latest-account.json",
    "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
  ]) {
    const content = byBundlePath(sanitized, relativePath)?.content.toString("utf8") ?? ""
    assert.match(content, /\[REDACTED_CORRUPT_STRUCTURED_CONTENT\]/)
    assert.doesNotMatch(content, /acc-secret|user-secret|token-secret|ctx-secret|refresh-secret/)
  }

  assert.match(byBundlePath(full, "state/operator.json")?.content.toString("utf8") ?? "", /acc-secret/)
  assert.match(byBundlePath(full, "state/latest-account.json")?.content.toString("utf8") ?? "", /token-secret/)
  assert.match(byBundlePath(full, "state/tokens/acc-secret/user-secret.json")?.content.toString("utf8") ?? "", /ctx-secret/)
})

test("wechat debug bundle: full 模式导出 operator latest-account 与 token 文件", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-extra-state-")
  await writeJson(path.join(stateRoot, "operator.json"), {
    wechatAccountId: "acc-1",
    userId: "user-1",
  })
  await writeJson(path.join(stateRoot, "latest-account.json"), {
    accountId: "acc-1",
    token: "token-1",
    baseUrl: "https://wx.example.com",
  })
  await writeJson(path.join(stateRoot, "tokens", "acc-1", "user-1.json"), {
    contextToken: "ctx-1",
    stale: false,
  })

  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })
  const bundlePaths = listBundlePaths(bundle)
  const operatorJson = readJsonEntry(bundle, "state/operator.json")
  const latestAccountJson = readJsonEntry(bundle, "state/latest-account.json")
  const tokenJson = readJsonEntry(bundle, "state/tokens/acc-1/user-1.json")

  assert.equal(bundlePaths.includes("state/operator.json"), true)
  assert.equal(bundlePaths.includes("state/latest-account.json"), true)
  assert.equal(bundlePaths.includes("state/tokens/acc-1/user-1.json"), true)
  assert.equal(bundle.manifest.entries.some((entry) => entry.category === "state" && entry.bundlePath === "state/operator.json"), true)
  assert.equal(
    bundle.manifest.entries.some((entry) => entry.category === "state" && entry.bundlePath === "state/latest-account.json"),
    true,
  )
  assert.equal(
    bundle.manifest.entries.some((entry) => entry.category === "state" && entry.bundlePath === "state/tokens/acc-1/user-1.json"),
    true,
  )
  assert.deepEqual(operatorJson, {
    wechatAccountId: "acc-1",
    userId: "user-1",
  })
  assert.deepEqual(latestAccountJson, {
    accountId: "acc-1",
    token: "token-1",
    baseUrl: "https://wx.example.com",
  })
  assert.deepEqual(tokenJson, {
    contextToken: "ctx-1",
    stale: false,
  })
})

test("wechat debug bundle: 缺少 operator/latest-account/token 时进入 missingPaths 而不是整体失败", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-missing-extra-state-")
  await mkdir(stateRoot, { recursive: true })
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "operator.json"), true)
  assert.equal(
    bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "latest-account.json"),
    true,
  )
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
})

test("wechat debug bundle: operator.json stat 失败时进入 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-operator-stat-failed-")
  const operatorPath = path.join(stateRoot, "operator.json")
  const latestAccountPath = path.join(stateRoot, "latest-account.json")
  await writeJson(operatorPath, { wechatAccountId: "acc-1", userId: "user-1" })
  await writeJson(latestAccountPath, { accountId: "acc-1", token: "token-1", baseUrl: "https://wx.example.com" })

  const fsPromisesModule = require("node:fs/promises")
  const originalStat = fsPromisesModule.stat

  fsPromisesModule.stat = async (filePath, ...args) => {
    if (String(filePath) === operatorPath) {
      const error = new Error("stat failed")
      error.code = "EACCES"
      throw error
    }

    return originalStat(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.stat = originalStat
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(byBundlePath(bundle, "state/operator.json"), undefined)
  assert.ok(byBundlePath(bundle, "state/latest-account.json"))
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "operator.json"), false)
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/operator.json"),
    {
      bundlePath: "state/operator.json",
      category: "state",
      reason: "file-read-failed",
      sourcePath: operatorPath,
    },
  )
})

test("wechat debug bundle: latest-account.json 读取失败时进入 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-latest-account-read-failed-")
  const operatorPath = path.join(stateRoot, "operator.json")
  const latestAccountPath = path.join(stateRoot, "latest-account.json")
  await writeJson(operatorPath, { wechatAccountId: "acc-1", userId: "user-1" })
  await writeJson(latestAccountPath, { accountId: "acc-1", token: "token-1", baseUrl: "https://wx.example.com" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReadFile = fsPromisesModule.readFile

  fsPromisesModule.readFile = async (filePath, ...args) => {
    if (String(filePath) === latestAccountPath) {
      const error = new Error("read failed")
      error.code = "EACCES"
      throw error
    }

    return originalReadFile(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readFile = originalReadFile
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.ok(byBundlePath(bundle, "state/operator.json"))
  assert.equal(byBundlePath(bundle, "state/latest-account.json"), undefined)
  assert.equal(
    bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "latest-account.json"),
    false,
  )
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/latest-account.json"),
    {
      bundlePath: "state/latest-account.json",
      category: "state",
      reason: "file-read-failed",
      sourcePath: latestAccountPath,
    },
  )
})

test("wechat debug bundle: tokens 根目录 stat 失败时进入 missingPaths 与 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-root-stat-failed-")
  const tokensRoot = path.join(stateRoot, "tokens")
  await writeJson(path.join(tokensRoot, "acc-1", "user-1.json"), { contextToken: "ctx-1" })

  const fsPromisesModule = require("node:fs/promises")
  const originalStat = fsPromisesModule.stat

  fsPromisesModule.stat = async (filePath, ...args) => {
    if (String(filePath) === tokensRoot) {
      const error = new Error("stat failed")
      error.code = "EACCES"
      throw error
    }

    return originalStat(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.stat = originalStat
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.entries.some((entry) => entry.bundlePath.startsWith("state/tokens/")), false)
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/tokens"),
    {
      bundlePath: "state/tokens",
      category: "state",
      reason: "file-read-failed",
      sourcePath: tokensRoot,
    },
  )

  const environmentSummary = readJsonEntry(bundle, "environment-summary.json")
  assert.equal(environmentSummary.checks.tokens, false)
})

test("wechat debug bundle: tokens 目录存在但只有空文件或临时文件时，tokens 进入 missingPaths，文件进入 skippedEntries", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-filtering-")
  await writeText(path.join(stateRoot, "tokens", "acc-1", ".partial.tmp"), "tmp")
  await writeText(path.join(stateRoot, "tokens", "acc-1", "user-1.json"), "")

  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.entries.some((entry) => entry.bundlePath.startsWith("state/tokens/")), false)
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
  assert.equal(bundle.manifest.skippedEntries.some((item) => item.reason === "token-temp-file"), true)
  assert.equal(bundle.manifest.skippedEntries.some((item) => item.reason === "empty-token-file"), true)
})

test("wechat debug bundle: token 文件在枚举后消失时进入 skippedEntries(file-disappeared)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-disappeared-")
  const tokenPath = path.join(stateRoot, "tokens", "acc-1", "user-1.json")
  await writeJson(tokenPath, { contextToken: "ctx-1" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReadFile = fsPromisesModule.readFile

  fsPromisesModule.readFile = async (filePath, ...args) => {
    if (String(filePath) === tokenPath) {
      await rm(tokenPath, { force: true })
      const error = new Error("ENOENT: no such file or directory")
      error.code = "ENOENT"
      throw error
    }

    return originalReadFile(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readFile = originalReadFile
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.entries.some((entry) => entry.bundlePath.startsWith("state/tokens/")), false)
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
  assert.equal(bundle.manifest.skippedEntries.some((item) => item.reason === "file-disappeared"), true)
})

test("wechat debug bundle: token 文件读取失败时进入 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-read-failed-")
  const tokenPath = path.join(stateRoot, "tokens", "acc-1", "user-1.json")
  await writeJson(tokenPath, { contextToken: "ctx-1" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReadFile = fsPromisesModule.readFile

  fsPromisesModule.readFile = async (filePath, ...args) => {
    if (String(filePath) === tokenPath) {
      const error = new Error("read failed")
      error.code = "EACCES"
      throw error
    }

    return originalReadFile(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readFile = originalReadFile
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.entries.some((entry) => entry.bundlePath.startsWith("state/tokens/")), false)
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
  assert.equal(bundle.manifest.skippedEntries.some((item) => item.reason === "file-read-failed"), true)
})

test("wechat debug bundle: token 文件 stat 失败时进入 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-stat-failed-")
  const failedTokenPath = path.join(stateRoot, "tokens", "acc-1", "blocked-user.json")
  const stableTokenPath = path.join(stateRoot, "tokens", "acc-1", "stable-user.json")
  await writeJson(failedTokenPath, { contextToken: "ctx-blocked" })
  await writeJson(stableTokenPath, { contextToken: "ctx-stable" })

  const fsPromisesModule = require("node:fs/promises")
  const originalStat = fsPromisesModule.stat

  fsPromisesModule.stat = async (filePath, ...args) => {
    if (String(filePath) === failedTokenPath) {
      const error = new Error("stat failed")
      error.code = "EACCES"
      throw error
    }

    return originalStat(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.stat = originalStat
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(byBundlePath(bundle, "state/tokens/acc-1/blocked-user.json"), undefined)
  assert.ok(byBundlePath(bundle, "state/tokens/acc-1/stable-user.json"))
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), false)
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/tokens/acc-1/blocked-user.json"),
    {
      bundlePath: "state/tokens/acc-1/blocked-user.json",
      category: "state",
      reason: "file-read-failed",
      sourcePath: failedTokenPath,
    },
  )
})

test("wechat debug bundle: token 子目录在递归时消失会进入 fail-soft 结果", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-dir-disappeared-")
  const disappearingDir = path.join(stateRoot, "tokens", "acc-1")
  await writeJson(path.join(disappearingDir, "user-1.json"), { contextToken: "ctx-1" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReaddir = fsPromisesModule.readdir

  fsPromisesModule.readdir = async (filePath, ...args) => {
    if (String(filePath) === disappearingDir) {
      await rm(disappearingDir, { recursive: true, force: true })
      const error = new Error("gone")
      error.code = "ENOENT"
      throw error
    }

    return originalReaddir(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readdir = originalReaddir
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(bundle.entries.some((entry) => entry.bundlePath.startsWith("state/tokens/")), false)
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), true)
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/tokens/acc-1"),
    {
      bundlePath: "state/tokens/acc-1",
      category: "state",
      reason: "file-disappeared",
      sourcePath: disappearingDir,
    },
  )
})

test("wechat debug bundle: token 子目录读取失败时进入 skippedEntries(file-read-failed)", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-dir-read-failed-")
  const blockedDir = path.join(stateRoot, "tokens", "acc-blocked")
  await writeJson(path.join(blockedDir, "user-1.json"), { contextToken: "ctx-blocked" })
  await writeJson(path.join(stateRoot, "tokens", "acc-stable", "user-2.json"), { contextToken: "ctx-stable" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReaddir = fsPromisesModule.readdir

  fsPromisesModule.readdir = async (filePath, ...args) => {
    if (String(filePath) === blockedDir) {
      const error = new Error("directory blocked")
      error.code = "EACCES"
      throw error
    }

    return originalReaddir(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readdir = originalReaddir
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  assert.equal(byBundlePath(bundle, "state/tokens/acc-blocked/user-1.json"), undefined)
  assert.ok(byBundlePath(bundle, "state/tokens/acc-stable/user-2.json"))
  assert.equal(bundle.manifest.missingPaths.some((item) => item.category === "state" && item.relativePath === "tokens"), false)
  assert.deepEqual(
    bundle.manifest.skippedEntries.find((item) => item.bundlePath === "state/tokens/acc-blocked"),
    {
      bundlePath: "state/tokens/acc-blocked",
      category: "state",
      reason: "file-read-failed",
      sourcePath: blockedDir,
    },
  )
})

test("wechat debug bundle: sanitized 模式下 token 子目录读取失败不会与后续导出账号共用占位前缀", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-dir-read-failed-sanitized-")
  const blockedDir = path.join(stateRoot, "tokens", "acc-blocked")
  await writeJson(path.join(blockedDir, "user-1.json"), { contextToken: "ctx-blocked" })
  await writeJson(path.join(stateRoot, "tokens", "acc-stable", "user-2.json"), { contextToken: "ctx-stable" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReaddir = fsPromisesModule.readdir

  fsPromisesModule.readdir = async (filePath, ...args) => {
    if (String(filePath) === blockedDir) {
      const error = new Error("directory blocked")
      error.code = "EACCES"
      throw error
    }

    return originalReaddir(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readdir = originalReaddir
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "sanitized",
  })

  const skippedEntry = bundle.manifest.skippedEntries.find((item) => item.reason === "file-read-failed")
  const exportedEntry = bundle.manifest.entries.find((entry) => entry.bundlePath.startsWith("state/tokens/"))

  assert.deepEqual(skippedEntry, {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]",
    category: "state",
    reason: "file-read-failed",
    sourcePath: null,
    redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "tokens", "[REDACTED_ACCOUNT_ID_1]"),
  })
  assert.deepEqual(exportedEntry, {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_2]/[REDACTED_USER_ID_1].json",
    category: "state",
    redacted: true,
    sourcePath: null,
    redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "tokens", "[REDACTED_ACCOUNT_ID_2]", "[REDACTED_USER_ID_1].json"),
  })
})

test("wechat debug bundle: sanitized 模式下 skipped token 与导出 token 的可见路径稳定且不冲突", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-sanitized-order-")
  const skippedTokenPath = path.join(stateRoot, "tokens", "acc-1", "a-user.json")
  const exportedTokenPath = path.join(stateRoot, "tokens", "acc-1", "b-user.json")
  await writeText(skippedTokenPath, "")
  await writeJson(exportedTokenPath, { contextToken: "ctx-export" })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "sanitized",
  })

  const skippedEntry = bundle.manifest.skippedEntries.find((entry) => entry.reason === "empty-token-file")
  const exportedEntry = bundle.manifest.entries.find((entry) => entry.bundlePath.startsWith("state/tokens/"))

  assert.deepEqual(skippedEntry, {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
    category: "state",
    reason: "empty-token-file",
    sourcePath: null,
    redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "tokens", "[REDACTED_ACCOUNT_ID_1]", "[REDACTED_USER_ID_1].json"),
  })
  assert.deepEqual(exportedEntry, {
    bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2].json",
    category: "state",
    redacted: true,
    sourcePath: null,
    redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "tokens", "[REDACTED_ACCOUNT_ID_1]", "[REDACTED_USER_ID_2].json"),
  })
  assert.equal(skippedEntry.bundlePath === exportedEntry.bundlePath, false)
  assert.equal(skippedEntry.redactedSourcePath === exportedEntry.redactedSourcePath, false)
})

test("wechat debug bundle: sanitized 模式下忽略的 token 垃圾文件不会扰动导出 token 占位编号", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-token-junk-")
  await writeText(path.join(stateRoot, "tokens", "acc-1", "a-garbage.txt"), "junk")
  await writeJson(path.join(stateRoot, "tokens", "acc-1", "b-user.json"), {
    contextToken: "ctx-export",
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "sanitized",
  })

  const tokenEntries = bundle.manifest.entries.filter((entry) => entry.bundlePath.startsWith("state/tokens/"))

  assert.deepEqual(tokenEntries, [
    {
      bundlePath: "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
      category: "state",
      redacted: true,
      sourcePath: null,
      redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "tokens", "[REDACTED_ACCOUNT_ID_1]", "[REDACTED_USER_ID_1].json"),
    },
  ])
  assert.equal(bundle.manifest.skippedEntries.some((entry) => entry.bundlePath.endsWith("a-garbage.txt")), false)
  assert.equal(bundle.entries.some((entry) => entry.bundlePath.endsWith("a-garbage.txt")), false)
})

test("manifest 条目顺序稳定并保留源路径", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-manifest-")
  await writeJson(path.join(stateRoot, "tokens", "z-account", "b-user.json"), { token: "z" })
  await writeJson(path.join(stateRoot, "tokens", "a-account", "c-user.json"), { token: "a" })
  await writeJson(path.join(stateRoot, "tokens", "a-account", "a-user.json"), { token: "aa" })

  const bundle = await collectorModule.collectWechatDebugBundle({
    mode: "sanitized",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-2",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  const tokenEntries = bundle.manifest.entries.filter((entry) => entry.bundlePath.startsWith("state/tokens/"))
  assert.deepEqual(
    tokenEntries.map((entry) => entry.bundlePath),
    [
      "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
      "state/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2].json",
      "state/tokens/[REDACTED_ACCOUNT_ID_2]/[REDACTED_USER_ID_3].json",
    ],
  )
  assert.deepEqual(
    tokenEntries.map((entry) => entry.sourcePath),
    [null, null, null],
  )
  assert.deepEqual(
    tokenEntries.map((entry) => entry.redactedSourcePath.replaceAll("\\", "/")),
    [
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2].json",
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_2]/[REDACTED_USER_ID_3].json",
    ],
  )

  const tokenBundleEntries = bundle.entries.filter((entry) => entry.bundlePath.startsWith("state/tokens/"))
  assert.deepEqual(
    tokenBundleEntries.map((entry) => entry.sourcePath.replaceAll("\\", "/")),
    [
      `${stateRoot.replaceAll("\\", "/")}/tokens/a-account/a-user.json`,
      `${stateRoot.replaceAll("\\", "/")}/tokens/a-account/c-user.json`,
      `${stateRoot.replaceAll("\\", "/")}/tokens/z-account/b-user.json`,
    ],
  )

  const manifest = readJsonEntry(bundle, "manifest.json")
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.bundlePath.startsWith("state/tokens/"))
      .map((entry) => entry.sourcePath),
    [null, null, null],
  )
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.bundlePath.startsWith("state/tokens/"))
      .map((entry) => entry.redactedSourcePath.replaceAll("\\", "/")),
    [
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_1].json",
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_1]/[REDACTED_USER_ID_2].json",
      "[REDACTED_STATE_ROOT]/tokens/[REDACTED_ACCOUNT_ID_2]/[REDACTED_USER_ID_3].json",
    ],
  )
  assert.doesNotMatch(JSON.stringify(manifest), /a-account|a-user|b-user|c-user|z-account/)
})

test("redactor 支持 JSON 文本、JSONL 与普通文本脱敏", async () => {
  const redactionModule = await redactionModulePromise
  assert.equal(
    redactionModule.__importError,
    undefined,
    `redaction module should exist: ${redactionModule.__importError?.message ?? "missing"}`,
  )

  const redactedJson = redactionModule.redactDebugBundleContent(
    Buffer.from(
      JSON.stringify({
        contextToken: "ctx-1",
        wechatAccountId: "wx-1",
        userId: "u-1",
        accessToken: "token-1",
        cookie: "session=1",
        messageBody: "hello",
      }),
      "utf8",
    ),
    { bundlePath: "state/broker.json", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedJson, /\[REDACTED_CONTEXT_TOKEN\]/)
  assert.match(redactedJson, /\[REDACTED_ACCOUNT_ID\]/)
  assert.match(redactedJson, /\[REDACTED_USER_ID\]/)
  assert.match(redactedJson, /\[REDACTED_TOKEN\]/)
  assert.match(redactedJson, /\[REDACTED_CREDENTIAL\]/)
  assert.match(redactedJson, /\[REDACTED_MESSAGE_TEXT\]/)

  const redactedCorruptJson = redactionModule.redactDebugBundleContent(
    Buffer.from('{"contextToken":"ctx-truncated","accessToken":"token-truncated","messageBody":"hello"', "utf8"),
    { bundlePath: "state/broker.json", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedCorruptJson, /\[REDACTED_CORRUPT_STRUCTURED_CONTENT\]/)
  assert.doesNotMatch(redactedCorruptJson, /ctx-truncated|token-truncated|hello/)

  const redactedJsonl = redactionModule.redactDebugBundleContent(
    Buffer.from(`${JSON.stringify({ bearerToken: "abc", text: "hello" })}\n`, "utf8"),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedJsonl, /\[REDACTED_TOKEN\]/)
  assert.match(redactedJsonl, /\[REDACTED_MESSAGE_TEXT\]/)

  const redactedCorruptJsonl = redactionModule.redactDebugBundleContent(
    Buffer.from('{"accessToken":"token-line","messageBody":"hello"\n', "utf8"),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedCorruptJsonl, /\[REDACTED_CORRUPT_STRUCTURED_CONTENT\]/)
  assert.doesNotMatch(redactedCorruptJsonl, /token-line|hello/)

  const redactedEmbeddedJsonl = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({ reason: "Authorization: Bearer secret-token userId=user-1 messageBody=hello" })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedEmbeddedJsonl, /\[REDACTED_TOKEN\]/)
  assert.doesNotMatch(redactedEmbeddedJsonl, /secret-token|user-1|hello/)

  const redactedNestedJsonString = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        reason: JSON.stringify({ accessToken: "secret-token", userId: "user-1", messageBody: "hello" }),
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedNestedJsonString, /\[REDACTED_TOKEN\]/)
  assert.match(redactedNestedJsonString, /\[REDACTED_USER_ID\]/)
  assert.match(redactedNestedJsonString, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedNestedJsonString, /secret-token|user-1|hello/)

  const redactedMixedJsonFragment = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        reason: `payload=${JSON.stringify({ accessToken: "secret-token", userId: "user-1", messageBody: "hello" })}`,
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedMixedJsonFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedMixedJsonFragment, /\[REDACTED_USER_ID\]/)
  assert.match(redactedMixedJsonFragment, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedMixedJsonFragment, /secret-token|user-1|hello/)

  const redactedBrokenEmbeddedJsonFragment = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        error: 'request body {"accessToken":"secret-token","userId":"user-1","messageBody":"hello"',
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedBrokenEmbeddedJsonFragment, /\[REDACTED_CORRUPT_STRUCTURED_CONTENT\]/)
  assert.doesNotMatch(redactedBrokenEmbeddedJsonFragment, /secret-token|user-1|hello/)

  const redactedRuntimeErrorTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({ type: "runtimeError", error: "messageBody=top secret reason: token-raw" })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedRuntimeErrorTail, /messageBody=\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedRuntimeErrorTail, /top secret|token-raw|reason:/)

  const redactedUrlStyleMessageBody = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({ type: "runtimeError", error: "messageBody=https://x/?conversation=private-chat&id=42" })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedUrlStyleMessageBody, /messageBody=\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedUrlStyleMessageBody, /private-chat|id=42|conversation=/)

  const redactedMessageBodyWithSafeSuffix = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "messageBody=hello requestId=req-123 upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedMessageBodyWithSafeSuffix, /messageBody=\[REDACTED_MESSAGE_TEXT\]/)
  assert.match(redactedMessageBodyWithSafeSuffix, /requestId=req-123/)
  assert.match(redactedMessageBodyWithSafeSuffix, /upstream=502/)
  assert.doesNotMatch(redactedMessageBodyWithSafeSuffix, /messageBody=hello/)

  const redactedMessageBodyQueryTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "messageBody=https://x/?requestId=req-123&upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedMessageBodyQueryTail, /messageBody=\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedMessageBodyQueryTail, /requestId=req-123|upstream=502/)

  const redactedMessageBodyLooseCodeTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "messageBody=hello code=E42 more text",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedMessageBodyLooseCodeTail, /messageBody=\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedMessageBodyLooseCodeTail, /code=E42|more text/)

  const redactedAmpersandDelimitedDiagnostic = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization=Bearer secret-token&requestId=req-123&upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedAmpersandDelimitedDiagnostic, /Authorization=\[REDACTED_TOKEN\]/)
  assert.match(redactedAmpersandDelimitedDiagnostic, /requestId=req-123/)
  assert.match(redactedAmpersandDelimitedDiagnostic, /upstream=502/)
  assert.doesNotMatch(redactedAmpersandDelimitedDiagnostic, /secret-token/)

  const redactedColonDelimitedDiagnostic = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization: Bearer token-secret requestId: req-123 upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedColonDelimitedDiagnostic, /Authorization: \[REDACTED_TOKEN\]/)
  assert.match(redactedColonDelimitedDiagnostic, /requestId: req-123/)
  assert.match(redactedColonDelimitedDiagnostic, /upstream=502/)
  assert.doesNotMatch(redactedColonDelimitedDiagnostic, /token-secret/)

  const redactedBearerCodeSpaceDiagnostic = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization: Bearer token-secret code=oauth-live requestId=req-123",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedBearerCodeSpaceDiagnostic, /Authorization: \[REDACTED_TOKEN\]/)
  assert.match(redactedBearerCodeSpaceDiagnostic, /requestId=req-123/)
  assert.doesNotMatch(redactedBearerCodeSpaceDiagnostic, /token-secret|code=oauth-live/)

  const redactedCommaDelimitedDiagnostic = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization: Bearer token-secret,requestId=req-123,upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedCommaDelimitedDiagnostic, /Authorization: \[REDACTED_TOKEN\]/)
  assert.match(redactedCommaDelimitedDiagnostic, /requestId=req-123/)
  assert.match(redactedCommaDelimitedDiagnostic, /upstream=502/)
  assert.doesNotMatch(redactedCommaDelimitedDiagnostic, /token-secret/)

  const redactedBearerCodeAmpersandDiagnostic = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization=Bearer secret-token&code=oauth-live&requestId=req-123",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedBearerCodeAmpersandDiagnostic, /Authorization=\[REDACTED_TOKEN\]/)
  assert.match(redactedBearerCodeAmpersandDiagnostic, /requestId=req-123/)
  assert.doesNotMatch(redactedBearerCodeAmpersandDiagnostic, /secret-token|code=oauth-live/)

  const redactedAuthorizationQueryTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "Authorization=https://x/?requestId=req-123&code=oauth-live",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedAuthorizationQueryTail, /Authorization=\[REDACTED_TOKEN\]/)
  assert.doesNotMatch(redactedAuthorizationQueryTail, /requestId=req-123|code=oauth-live/)

  const redactedContextTokenQueryTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "contextToken=https://x/?requestId=req-123&upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedContextTokenQueryTail, /contextToken=\[REDACTED_CONTEXT_TOKEN\]/)
  assert.doesNotMatch(redactedContextTokenQueryTail, /requestId=req-123|upstream=502/)

  const redactedAccessTokenQueryTail = redactionModule.redactDebugBundleContent(
    Buffer.from(
      `${JSON.stringify({
        type: "runtimeError",
        error: "accessToken=https://x/?requestId=req-123&upstream=502",
      })}\n`,
      "utf8",
    ),
    { bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedAccessTokenQueryTail, /accessToken=\[REDACTED_TOKEN\]/)
  assert.doesNotMatch(redactedAccessTokenQueryTail, /requestId=req-123|upstream=502/)

  const redactedText = redactionModule.redactDebugBundleContent(
    Buffer.from(
      "Authorization: Bearer abc\nmessageBody=hello\n{\"accessToken\":\"abc\",\"userId\":\"user-1\",\"messageBody\":\"hello\"}\n",
      "utf8",
    ),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedText, /\[REDACTED_TOKEN\]/)
  assert.match(redactedText, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.match(redactedText, /\[REDACTED_USER_ID\]/)
  assert.doesNotMatch(redactedText, /\"abc\"|\"user-1\"|\"hello\"/)

  const redactedPlainTextFragment = redactionModule.redactDebugBundleContent(
    Buffer.from('payload={"accessToken":"secret-token","userId":"user-1","messageBody":"hello"}\n', "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedPlainTextFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedPlainTextFragment, /\[REDACTED_USER_ID\]/)
  assert.match(redactedPlainTextFragment, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedPlainTextFragment, /secret-token|user-1|hello/)

  const redactedQuotedEscapedFragment = redactionModule.redactDebugBundleContent(
    Buffer.from('payload="{\\"accessToken\\":\\"secret-token\\",\\"userId\\":\\"user-1\\",\\"messageBody\\":\\"hello\\"}"\n', "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedQuotedEscapedFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedQuotedEscapedFragment, /\[REDACTED_USER_ID\]/)
  assert.match(redactedQuotedEscapedFragment, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedQuotedEscapedFragment, /secret-token|user-1|hello/)

  const redactedQuotedEscapedArrayFragment = redactionModule.redactDebugBundleContent(
    Buffer.from('payload="[{\\"accessToken\\":\\"secret-token\\"},{\\"userId\\":\\"user-1\\",\\"messageBody\\":\\"hello\\"}]"\n', "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedQuotedEscapedArrayFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedQuotedEscapedArrayFragment, /\[REDACTED_USER_ID\]/)
  assert.match(redactedQuotedEscapedArrayFragment, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedQuotedEscapedArrayFragment, /secret-token|user-1|hello/)

  const redactedUnquotedEscapedFragment = redactionModule.redactDebugBundleContent(
    Buffer.from('payload={\\"accessToken\\":\\"secret-token\\",\\"userId\\":\\"user-1\\"}\n', "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedUnquotedEscapedFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedUnquotedEscapedFragment, /\[REDACTED_USER_ID\]/)
  assert.doesNotMatch(redactedUnquotedEscapedFragment, /secret-token|user-1/)

  const redactedUnquotedEscapedArrayFragment = redactionModule.redactDebugBundleContent(
    Buffer.from('payload=[{\\"accessToken\\":\\"secret-token\\"},{\\"userId\\":\\"user-1\\",\\"messageBody\\":\\"hello\\"}]\n', "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "sanitized" },
  ).toString("utf8")
  assert.match(redactedUnquotedEscapedArrayFragment, /\[REDACTED_TOKEN\]/)
  assert.match(redactedUnquotedEscapedArrayFragment, /\[REDACTED_USER_ID\]/)
  assert.match(redactedUnquotedEscapedArrayFragment, /\[REDACTED_MESSAGE_TEXT\]/)
  assert.doesNotMatch(redactedUnquotedEscapedArrayFragment, /secret-token|user-1|hello/)

  const fullText = redactionModule.redactDebugBundleContent(
    Buffer.from("Authorization: Bearer abc\n", "utf8"),
    { bundlePath: "diagnostics/broker-startup.diagnostics.log", mode: "full" },
  ).toString("utf8")
  assert.equal(fullText, "Authorization: Bearer abc\n")
})

test("large irrelevant files 在 full 模式下也会被排除", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-large-")
  await writeJson(path.join(stateRoot, "tokens", "wx-large", "user-large.json"), { token: "keep-me" })
  await writeText(path.join(stateRoot, "instances", "huge.bin"), "x".repeat(300_000))

  const bundle = await collectorModule.collectWechatDebugBundle({
    mode: "full",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-3",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  assert.equal(byBundlePath(bundle, "state/instances/huge.bin"), undefined)
  assert.ok(byBundlePath(bundle, "state/tokens/wx-large/user-large.json"))
  assert.deepEqual(bundle.manifest.skippedEntries, [
    {
      bundlePath: "state/instances/huge.bin",
      category: "state",
      reason: "file-too-large",
      sourcePath: path.join(stateRoot, "instances", "huge.bin"),
    },
  ])
})

test("collector 可以从磁盘读回 manifest 内容", async () => {
  const collectorModule = await collectorModulePromise
  assert.equal(
    collectorModule.__importError,
    undefined,
    `collector module should exist: ${collectorModule.__importError?.message ?? "missing"}`,
  )

  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-manifest-file-")
  await writeJson(path.join(stateRoot, "broker.json"), { contextToken: "ctx-1" })

  const bundle = await collectorModule.collectWechatDebugBundle({
    mode: "sanitized",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-4",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  const manifest = byBundlePath(bundle, "manifest.json")
  const parsed = JSON.parse(manifest.content.toString("utf8"))
  const brokerEntry = parsed.entries.find((entry) => entry.bundlePath === "state/broker.json")
  const brokerOnDisk = JSON.parse(await readFile(byBundlePath(bundle, "state/broker.json").sourcePath, "utf8"))

  assert.equal(brokerOnDisk.contextToken, "ctx-1")
  assert.equal(brokerEntry.redacted, true)
  assert.equal(brokerEntry.sourcePath, null)
  assert.equal(brokerEntry.redactedSourcePath, path.join("[REDACTED_STATE_ROOT]", "broker.json"))
})

test("collector 在单个文件读阶段消失时记录 skipped 而不是整体失败", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-race-")
  const disappearingFile = path.join(stateRoot, "notifications", "disappearing.json")
  await writeJson(path.join(stateRoot, "broker.json"), { contextToken: "ctx-1" })
  await writeJson(disappearingFile, { messageBody: "transient" })
  await writeJson(path.join(stateRoot, "notifications", "stable.json"), { messageBody: "stable body" })

  const fsPromisesModule = require("node:fs/promises")
  const originalReadFile = fsPromisesModule.readFile
  let injectedEnoent = false

  fsPromisesModule.readFile = async (filePath, ...args) => {
    if (!injectedEnoent && String(filePath) === disappearingFile) {
      injectedEnoent = true
      await rm(disappearingFile, { force: true })
      const error = new Error("ENOENT: no such file or directory")
      error.code = "ENOENT"
      throw error
    }

    return originalReadFile(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.readFile = originalReadFile
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    mode: "sanitized",
    now: new Date("2026-04-11T08:30:00.000Z"),
    pluginVersion: "0.14.38-test",
    gitHead: "head-race",
    nodeVersion: "v24.0.0-test",
    platform: "linux-test",
  })

  assert.ok(byBundlePath(bundle, "state/notifications/stable.json"))
  assert.equal(byBundlePath(bundle, "state/notifications/disappearing.json"), undefined)
  assert.deepEqual(bundle.manifest.skippedEntries, [
    {
      bundlePath: "state/notifications/disappearing.json",
      category: "state",
      reason: "file-disappeared",
      sourcePath: null,
      redactedSourcePath: path.join("[REDACTED_STATE_ROOT]", "notifications", "disappearing.json"),
    },
  ])
})

test("environment-summary 预检查在 broker 与 diagnostics stat 失败时不阻塞后续 fail-soft", async () => {
  const stateRoot = await withWechatStateRoot("wechat-debug-bundle-env-check-fail-soft-")
  const brokerPath = path.join(stateRoot, "broker.json")
  const diagnosticsPath = path.join(stateRoot, "wechat-status-runtime.diagnostics.jsonl")
  await writeJson(brokerPath, { contextToken: "ctx-1" })
  await writeText(diagnosticsPath, '{"messageBody":"runtime body"}\n')
  await writeJson(path.join(stateRoot, "notifications", "stable.json"), { messageBody: "stable body" })

  const fsPromisesModule = require("node:fs/promises")
  const originalStat = fsPromisesModule.stat

  fsPromisesModule.stat = async (filePath, ...args) => {
    if (String(filePath) === brokerPath || String(filePath) === diagnosticsPath) {
      const error = new Error("stat failed")
      error.code = "EACCES"
      throw error
    }

    return originalStat(filePath, ...args)
  }
  syncBuiltinESMExports()
  restorers.push(async () => {
    fsPromisesModule.stat = originalStat
    syncBuiltinESMExports()
  })

  const collectorModule = await importFreshCollector()
  const bundle = await collectorModule.collectWechatDebugBundle({
    stateRoot,
    mode: "full",
  })

  const environmentSummary = readJsonEntry(bundle, "environment-summary.json")
  assert.equal(environmentSummary.checks["broker.json"], false)
  assert.equal(environmentSummary.checks["wechat-status-runtime.diagnostics.jsonl"], false)
  assert.equal(byBundlePath(bundle, "state/broker.json"), undefined)
  assert.equal(byBundlePath(bundle, "diagnostics/wechat-status-runtime.diagnostics.jsonl"), undefined)
  assert.ok(byBundlePath(bundle, "state/notifications/stable.json"))
  assert.deepEqual(
    bundle.manifest.skippedEntries.filter(
      (entry) => entry.bundlePath === "state/broker.json" || entry.bundlePath === "diagnostics/wechat-status-runtime.diagnostics.jsonl",
    ),
    [
      {
        bundlePath: "diagnostics/wechat-status-runtime.diagnostics.jsonl",
        category: "diagnostics",
        reason: "file-read-failed",
        sourcePath: diagnosticsPath,
      },
      {
        bundlePath: "state/broker.json",
        category: "state",
        reason: "file-read-failed",
        sourcePath: brokerPath,
      },
    ],
  )
})
