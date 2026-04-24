import test, { after } from "node:test"
import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-state-paths-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const storePaths = await import("../dist/store-paths.js")
const statePaths = await import("../dist/wechat/state-paths.js")

test("wechat 根目录固定在 account-switcher 下的 wechat 子目录", () => {
  const expected = path.join(storePaths.accountSwitcherConfigDir(), "wechat")
  const actual = statePaths.wechatStateRoot()

  assert.equal(actual, expected)
  assert.match(actual.replace(/\\/g, "/"), /\/opencode\/account-switcher\/wechat$/)
})

test("wechat 状态 helper 路径布局稳定", () => {
  const root = statePaths.wechatStateRoot()

  assert.equal(statePaths.brokerStatePath(), path.join(root, "broker.json"))
  assert.equal(statePaths.brokerStartupDiagnosticsPath(), path.join(root, "broker-startup.diagnostics.log"))
  assert.equal(statePaths.wechatBrokerDiagnosticsPath(), path.join(root, "wechat-broker.diagnostics.jsonl"))
  assert.equal(statePaths.wechatDeadLetterRoot(), path.join(root, "dead-letter"))
  assert.equal(statePaths.launchLockPath(), path.join(root, "launch.lock"))
  assert.equal(statePaths.operatorStatePath(), path.join(root, "operator.json"))
  assert.equal(statePaths.instancesDir(), path.join(root, "instances"))
  assert.equal(statePaths.tokensDir(), path.join(root, "tokens"))
  assert.equal(statePaths.requestKindDir("question"), path.join(root, "requests", "question"))
  assert.equal(statePaths.requestKindDir("permission"), path.join(root, "requests", "permission"))
})

test("wechat 派生状态路径稳定", () => {
  const root = statePaths.wechatStateRoot()

  assert.equal(statePaths.instanceStatePath("inst-1"), path.join(root, "instances", "inst-1.json"))
  assert.equal(
    statePaths.wechatDeadLetterKindDir("question"),
    path.join(root, "dead-letter", "question"),
  )
  assert.equal(
    statePaths.wechatDeadLetterPath("permission", "route-dead-1"),
    path.join(root, "dead-letter", "permission", "route-dead-1.json"),
  )
  assert.equal(
    statePaths.tokenStatePath("wx-account", "user-42"),
    path.join(root, "tokens", "wx-account", "user-42.json"),
  )
  assert.equal(
    statePaths.requestStatePath("question", "route-a"),
    path.join(root, "requests", "question", "route-a.json"),
  )
  assert.equal(
    statePaths.requestStatePath("permission", "route-b"),
    path.join(root, "requests", "permission", "route-b.json"),
  )
})

test("ensureWechatStateLayout 会创建完整目录树", async () => {
  await statePaths.ensureWechatStateLayout()

  const requiredDirs = [
    statePaths.wechatStateRoot(),
    statePaths.tokensDir(),
    statePaths.notificationsDir(),
    statePaths.wechatDeadLetterKindDir("question"),
    statePaths.wechatDeadLetterKindDir("permission"),
    statePaths.requestKindDir("question"),
    statePaths.requestKindDir("permission"),
  ]

  for (const dirPath of requiredDirs) {
    const info = await stat(dirPath)
    assert.equal(info.isDirectory(), true)
  }

  await assert.rejects(
    () => stat(statePaths.instancesDir()),
    (error) => error?.code === "ENOENT",
  )
})

test("权限边界策略在 POSIX/Windows 下可识别", async () => {
  assert.equal(statePaths.WECHAT_DIR_MODE, 0o700)
  assert.equal(statePaths.WECHAT_FILE_MODE, 0o600)

  await statePaths.ensureWechatStateLayout()

  if (process.platform === "win32") {
    const rootInfo = await stat(statePaths.wechatStateRoot())
    assert.equal(rootInfo.isDirectory(), true)
    return
  }

  const dirs = [
    statePaths.wechatStateRoot(),
    statePaths.tokensDir(),
    statePaths.notificationsDir(),
    statePaths.wechatDeadLetterKindDir("question"),
    statePaths.wechatDeadLetterKindDir("permission"),
    statePaths.requestKindDir("question"),
    statePaths.requestKindDir("permission"),
  ]

  for (const dirPath of dirs) {
    const info = await stat(dirPath)
    assert.equal(info.mode & 0o777, 0o700)
  }
})
