import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { loadModuleWithTsFallback } from "./jiti-loader.js"
import { readWechatLatestAccountState } from "../latest-account-state-store.js"

export type PublicWeixinPersistGetUpdatesBuf = (params: {
  accountId: string
  getUpdatesBuf: string
}) => Promise<void>

const OPENCLAW_SYNC_BUF_MODULE = "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts"
const OPENCLAW_STATE_DIR_MODULE = "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts"

export function createOpenClawSyncBufHelper(input: {
  getSyncBufFilePath: (accountId: string) => string
  saveGetUpdatesBuf: (filePath: string, getUpdatesBuf: string) => void
}): {
  persistGetUpdatesBuf: PublicWeixinPersistGetUpdatesBuf
} {
  return {
    async persistGetUpdatesBuf({ accountId, getUpdatesBuf }) {
      const filePath = input.getSyncBufFilePath(accountId)
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error("[wechat-compat] sync-buf helper returned invalid file path")
      }
      input.saveGetUpdatesBuf(filePath, getUpdatesBuf)
    },
  }
}

export async function loadOpenClawSyncBufHelper(options: {
  syncBufModulePath?: string
} = {}): Promise<{
  persistGetUpdatesBuf: PublicWeixinPersistGetUpdatesBuf
}> {
  const require = createRequire(import.meta.url)
  const syncBufModulePath = require.resolve(options.syncBufModulePath ?? OPENCLAW_SYNC_BUF_MODULE)
  const syncBufModule = await loadModuleWithTsFallback(syncBufModulePath, { parentURL: import.meta.url }) as {
    getSyncBufFilePath?: (accountId: string) => string
    saveGetUpdatesBuf?: (filePath: string, getUpdatesBuf: string) => void
  }

  if (typeof syncBufModule.getSyncBufFilePath !== "function" || typeof syncBufModule.saveGetUpdatesBuf !== "function") {
    throw new Error("[wechat-compat] sync-buf source helper unavailable")
  }

  return createOpenClawSyncBufHelper({
    getSyncBufFilePath: syncBufModule.getSyncBufFilePath,
    saveGetUpdatesBuf: syncBufModule.saveGetUpdatesBuf,
  })
}

export async function loadLatestWeixinAccountState(options: {
  stateDirModulePath?: string
  syncBufModulePath?: string
} = {}): Promise<{ accountId: string; token: string; baseUrl: string; getUpdatesBuf?: string } | null> {
  const pluginOwned = await readWechatLatestAccountState()
  if (pluginOwned) {
    return pluginOwned
  }

  const require = createRequire(import.meta.url)
  const stateDirModulePath = require.resolve(options.stateDirModulePath ?? OPENCLAW_STATE_DIR_MODULE)
  const stateDirModule = await loadModuleWithTsFallback(stateDirModulePath, { parentURL: import.meta.url }) as { resolveStateDir?: () => string }
  const stateDir = stateDirModule.resolveStateDir?.()
  if (!stateDir) {
    return null
  }

  const accountsIndexPath = path.join(stateDir, "openclaw-weixin", "accounts.json")
  let accountIds: string[] = []
  try {
    const raw = await readFile(accountsIndexPath, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      accountIds = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    }
  } catch {
    return null
  }

  const accountId = accountIds.at(-1)
  if (!accountId) {
    return null
  }

  try {
    const accountFilePath = path.join(stateDir, "openclaw-weixin", "accounts", `${accountId}.json`)
    const accountRaw = await readFile(accountFilePath, "utf8")
    const account = JSON.parse(accountRaw) as { token?: unknown; baseUrl?: unknown }
    const syncBufModulePath = require.resolve(options.syncBufModulePath ?? OPENCLAW_SYNC_BUF_MODULE)
    const syncBufModule = await loadModuleWithTsFallback(syncBufModulePath, { parentURL: import.meta.url }) as {
      getSyncBufFilePath?: (accountId: string) => string
      loadGetUpdatesBuf?: (filePath: string) => string | undefined
    }
    if (typeof account.token !== "string" || account.token.trim().length === 0) {
      return null
    }
    const syncBufFilePath = syncBufModule.getSyncBufFilePath?.(accountId)
    const persistedGetUpdatesBuf = syncBufFilePath ? syncBufModule.loadGetUpdatesBuf?.(syncBufFilePath) : undefined
    return {
      accountId,
      token: account.token,
      baseUrl: typeof account.baseUrl === "string" && account.baseUrl.trim().length > 0 ? account.baseUrl : "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: typeof persistedGetUpdatesBuf === "string" ? persistedGetUpdatesBuf : undefined,
    }
  } catch {
    return null
  }
}
