import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const DIST_SYNC_BUF_MODULE = "../dist/wechat/compat/openclaw-sync-buf.js"

test("sync-buf wrapper persists updates buf via provided source helpers", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  const calls = []
  const helper = mod.createOpenClawSyncBufHelper({
    getSyncBufFilePath: (accountId) => `state/${accountId}.buf`,
    saveGetUpdatesBuf: (filePath, getUpdatesBuf) => {
      calls.push({ filePath, getUpdatesBuf })
    },
  })

  await helper.persistGetUpdatesBuf({ accountId: "acc-2x", getUpdatesBuf: "buf-2x" })

  assert.deepEqual(calls, [{ filePath: "state/acc-2x.buf", getUpdatesBuf: "buf-2x" }])
})

test("sync-buf module exports latest account state loader for assembly usage", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  assert.equal(typeof mod.loadLatestWeixinAccountState, "function")
})

test("loadLatestWeixinAccountState prefers plugin-owned latest account state over openclaw dir", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)
  const isolated = await setupIsolatedWechatStateRoot("wechat-sync-buf-latest-account-")

  try {
    await mkdir(isolated.stateRoot, { recursive: true })
    await writeFile(path.join(isolated.stateRoot, "latest-account.json"), JSON.stringify({
      accountId: "acc-plugin-owned",
      token: "token-plugin-owned",
      baseUrl: "https://plugin-owned.example",
    }, null, 2), "utf8")

    const fakeOpenClawRoot = path.join(isolated.sandboxConfigHome, "fake-openclaw")
    await mkdir(path.join(fakeOpenClawRoot, "openclaw-weixin", "accounts"), { recursive: true })
    await writeFile(path.join(fakeOpenClawRoot, "openclaw-weixin", "accounts.json"), JSON.stringify(["acc-upstream"], null, 2), "utf8")
    await writeFile(path.join(fakeOpenClawRoot, "openclaw-weixin", "accounts", "acc-upstream.json"), JSON.stringify({
      token: "token-upstream",
      baseUrl: "https://upstream.example",
    }, null, 2), "utf8")

    const latest = await mod.loadLatestWeixinAccountState({
      stateDirModulePath: path.join(process.cwd(), "test", "fixtures", "fake-openclaw-state-dir.mjs"),
    })

    assert.deepEqual(latest, {
      accountId: "acc-plugin-owned",
      token: "token-plugin-owned",
      baseUrl: "https://plugin-owned.example",
    })
  } finally {
    await isolated.restore()
  }
})

test("loadOpenClawSyncBufHelper throws when source helper missing", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  await assert.rejects(
    () => mod.loadOpenClawSyncBufHelper({ syncBufModulePath: "node:path" }),
    /sync-buf source helper unavailable/,
  )
})

test("createOpenClawSyncBufHelper rejects empty file path", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  const helper = mod.createOpenClawSyncBufHelper({
    getSyncBufFilePath: () => "",
    saveGetUpdatesBuf: () => {
      throw new Error("should not be called")
    },
  })

  await assert.rejects(
    () => helper.persistGetUpdatesBuf({ accountId: "acc-2x", getUpdatesBuf: "buf-2x" }),
    /sync-buf helper returned invalid file path/,
  )
})
