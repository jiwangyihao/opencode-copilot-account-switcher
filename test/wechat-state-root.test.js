import test from "node:test"
import assert from "node:assert/strict"

import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("setupIsolatedWechatStateRoot 会串行化并发调用，避免 process.env 串扰", async () => {
  const previousStateRoot = process.env.WECHAT_STATE_ROOT_OVERRIDE
  const previousConfigHome = process.env.XDG_CONFIG_HOME

  const first = await setupIsolatedWechatStateRoot("wechat-state-root-first-")
  let secondResolved = false
  const secondPromise = setupIsolatedWechatStateRoot("wechat-state-root-second-").then((value) => {
    secondResolved = true
    return value
  })

  try {
    await delay(50)

    assert.equal(secondResolved, false)
    assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, first.stateRoot)
    assert.equal(process.env.XDG_CONFIG_HOME, first.sandboxConfigHome)

    await first.restore()

    const second = await secondPromise
    try {
      assert.equal(secondResolved, true)
      assert.notEqual(second.stateRoot, first.stateRoot)
      assert.equal(process.env.WECHAT_STATE_ROOT_OVERRIDE, second.stateRoot)
      assert.equal(process.env.XDG_CONFIG_HOME, second.sandboxConfigHome)
    } finally {
      await second.restore()
    }
  } finally {
    if (process.env.WECHAT_STATE_ROOT_OVERRIDE !== previousStateRoot) {
      if (previousStateRoot === undefined) {
        delete process.env.WECHAT_STATE_ROOT_OVERRIDE
      } else {
        process.env.WECHAT_STATE_ROOT_OVERRIDE = previousStateRoot
      }
    }

    if (process.env.XDG_CONFIG_HOME !== previousConfigHome) {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
      }
    }
  }
})
