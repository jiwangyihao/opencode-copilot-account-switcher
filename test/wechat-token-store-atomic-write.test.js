import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fsPromises, { mkdir, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-token-store-atomic-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}`)

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("测试隔离会显式固定 WECHAT_STATE_ROOT_OVERRIDE", () => {
  assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, statePaths.wechatStateRoot())
})

test("readTokenState() 在 upsertInboundToken() 写入进行中不会读到半截 JSON，也不会回退旧 live token 文件", async () => {
  await statePaths.ensureWechatStateLayout()

  const wechatAccountId = "wx-atomic"
  const userId = "u-atomic"
  const filePath = statePaths.tokenStatePath(wechatAccountId, userId)
  const oldState = {
    contextToken: "token-old",
    updatedAt: 1_700_100_000_000,
    source: "question",
    sourceRef: "q-old",
  }

  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(oldState, null, 2))

  const originalWriteFile = fsPromises.writeFile
  let releaseWrite = () => {}
  const continueWrite = new Promise((resolve) => {
    releaseWrite = resolve
  })
  let signalPartialWrite = () => {}
  const partialWriteObserved = new Promise((resolve) => {
    signalPartialWrite = resolve
  })
  let intercepted = false
  let writePromise = null

  fsPromises.writeFile = async (targetPath, data, options) => {
    const targetDir = path.dirname(filePath)
    const isTokenWrite = !intercepted && typeof targetPath === "string" && targetPath.startsWith(targetDir)
    if (!isTokenWrite) {
      return originalWriteFile(targetPath, data, options)
    }

    intercepted = true
    const text = typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : String(data)
    const midpoint = Math.max(1, Math.floor(text.length / 2))

    await originalWriteFile(targetPath, text.slice(0, midpoint), options)
    signalPartialWrite()
    await continueWrite
    await originalWriteFile(targetPath, text, options)
  }
  syncBuiltinESMExports()

  try {
    const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)
    writePromise = tokenStore.upsertInboundToken({
      wechatAccountId,
      userId,
      contextToken: "token-new",
      updatedAt: 1_700_100_100_000,
      source: "permission",
      sourceRef: "p-new",
    })

    await partialWriteObserved

    const duringWrite = await tokenStore.readTokenState(wechatAccountId, userId)
    assert.equal(duringWrite, undefined)

    const persistedDuringWrite = JSON.parse(await fsPromises.readFile(filePath, "utf8"))
    assert.deepEqual(persistedDuringWrite, oldState)

    releaseWrite()

    const latest = await writePromise
    assert.deepEqual(latest, {
      contextToken: "token-new",
      updatedAt: 1_700_100_100_000,
      source: "permission",
      sourceRef: "p-new",
    })

    const stored = await tokenStore.readTokenState(wechatAccountId, userId)
    assert.deepEqual(stored, latest)
  } finally {
    releaseWrite()
    await writePromise?.catch(() => {})
    fsPromises.writeFile = originalWriteFile
    syncBuiltinESMExports()
  }
})

test("upsertInboundToken() 覆盖已有 token 文件时会重试瞬时 EPERM", async () => {
  await statePaths.ensureWechatStateLayout()

  const wechatAccountId = "wx-retry"
  const userId = "u-retry"
  const filePath = statePaths.tokenStatePath(wechatAccountId, userId)
  const oldState = {
    contextToken: "token-old",
    updatedAt: 1_700_200_000_000,
    source: "question",
    sourceRef: "q-old",
  }

  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(oldState, null, 2))

  const originalRename = fsPromises.rename
  let tokenRenameAttempts = 0
  fsPromises.rename = async (fromPath, toPath) => {
    const isTokenReplace = typeof toPath === "string" && toPath === filePath
    if (isTokenReplace && tokenRenameAttempts < 2) {
      tokenRenameAttempts += 1
      const error = new Error("target is temporarily locked")
      error.code = "EPERM"
      throw error
    }

    if (isTokenReplace) {
      tokenRenameAttempts += 1
    }
    return originalRename(fromPath, toPath)
  }
  syncBuiltinESMExports()

  try {
    const tokenStore = await import(`../dist/wechat/token-store.js?reload=${Date.now()}`)
    const latest = await tokenStore.upsertInboundToken({
      wechatAccountId,
      userId,
      contextToken: "token-new",
      updatedAt: 1_700_200_100_000,
      source: "permission",
      sourceRef: "p-new",
    })

    assert.deepEqual(latest, {
      contextToken: "token-new",
      updatedAt: 1_700_200_100_000,
      source: "permission",
      sourceRef: "p-new",
    })
    assert.equal(tokenRenameAttempts, 3)

    const stored = await tokenStore.readTokenState(wechatAccountId, userId)
    assert.deepEqual(stored, latest)
  } finally {
    fsPromises.rename = originalRename
    syncBuiltinESMExports()
  }
})
