import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"

let isolatedStateRootQueue = Promise.resolve()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableCleanupError(error) {
  return error?.code === "EBUSY"
    || error?.code === "ENOTEMPTY"
    || error?.code === "EPERM"
}

async function removeSandboxWithRetry(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (!isRetryableCleanupError(error) || attempt === 4) {
        throw error
      }

      await delay(50 * (attempt + 1))
    }
  }
}

export async function setupIsolatedWechatStateRoot(prefix) {
  const waitForTurn = isolatedStateRootQueue
  let releaseTurn = () => {}
  isolatedStateRootQueue = new Promise((resolve) => {
    releaseTurn = resolve
  })

  await waitForTurn

  try {
    const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), prefix))
    const stateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousStateRoot = process.env.WECHAT_STATE_ROOT_OVERRIDE

    process.env.XDG_CONFIG_HOME = sandboxConfigHome
    process.env.WECHAT_STATE_ROOT_OVERRIDE = stateRoot

    let restored = false
    const restore = async () => {
      if (restored) {
        return
      }
      restored = true

      try {
        if (previousXdgConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME
        } else {
          process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }

        if (previousStateRoot === undefined) {
          delete process.env.WECHAT_STATE_ROOT_OVERRIDE
        } else {
          process.env.WECHAT_STATE_ROOT_OVERRIDE = previousStateRoot
        }

        await removeSandboxWithRetry(sandboxConfigHome)
      } finally {
        releaseTurn()
      }
    }

    return {
      sandboxConfigHome,
      stateRoot,
      restore,
    }
  } catch (error) {
    releaseTurn()
    throw error
  }
}
