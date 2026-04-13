import { readFile, writeFile } from "node:fs/promises"
import { ensureWechatStateLayout, latestAccountStatePath, WECHAT_FILE_MODE } from "./state-paths.js"

export type WechatLatestAccountState = {
  accountId: string
  token: string
  baseUrl: string
  getUpdatesBuf?: string
}

function normalize(value: unknown): WechatLatestAccountState | null {
  if (!value || typeof value !== "object") {
    return null
  }
  const input = value as Record<string, unknown>
  const accountId = typeof input.accountId === "string" && input.accountId.trim().length > 0 ? input.accountId : null
  const token = typeof input.token === "string" && input.token.trim().length > 0 ? input.token : null
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim().length > 0 ? input.baseUrl : null
  if (!accountId || !token || !baseUrl) {
    return null
  }
  return {
    accountId,
    token,
    baseUrl,
    ...(typeof input.getUpdatesBuf === "string" && input.getUpdatesBuf.trim().length > 0 ? { getUpdatesBuf: input.getUpdatesBuf } : {}),
  }
}

export async function readWechatLatestAccountState(): Promise<WechatLatestAccountState | null> {
  try {
    const raw = await readFile(latestAccountStatePath(), "utf8")
    return normalize(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function writeWechatLatestAccountState(input: WechatLatestAccountState): Promise<WechatLatestAccountState> {
  await ensureWechatStateLayout()
  const normalized = normalize(input)
  if (!normalized) {
    throw new Error("invalid latest account state")
  }
  await writeFile(latestAccountStatePath(), `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: WECHAT_FILE_MODE })
  return normalized
}
