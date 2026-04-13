import { randomUUID } from "node:crypto"
import { loadQrCodeTerminal } from "./qrcode-terminal-loader.js"

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
const DEFAULT_ILINK_BOT_TYPE = "3"
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
}

const activeLogins = new Map<string, ActiveLogin>()

type WeixinBindQrGateway = {
  loginWithQrStart: (input?: unknown) => Promise<unknown>
  loginWithQrWait: (input?: unknown) => Promise<unknown>
}

type WeixinBindAccountHelpers = {
  listAccountIds: () => Promise<string[]>
  resolveAccount: (accountId: string) => Promise<{
    accountId: string
    enabled: boolean
    configured: boolean
    name?: string
    userId?: string
  }>
  describeAccount: (accountIdOrInput: string | { accountId: string }) => Promise<{
    accountId: string
    enabled: boolean
    configured: boolean
    name?: string
    userId?: string
  }>
}

export type OpenClawWeixinBindHelpers = {
  qrGateway: WeixinBindQrGateway
  accountHelpers: WeixinBindAccountHelpers
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [sessionKey, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(sessionKey)
    }
  }
}

async function fetchQrCode(apiBaseUrl: string, botType: string): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base)
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`)
  }
  return await response.json() as { qrcode: string; qrcode_img_content: string }
}

async function renderQrTerminal(value: string): Promise<string | undefined> {
  const qrcodeTerminal = loadQrCodeTerminal()
  return await new Promise((resolve, reject) => {
    try {
      qrcodeTerminal.generate(value, { small: true }, (output: string) => {
        resolve(typeof output === "string" && output.trim().length > 0 ? output : undefined)
      })
    } catch (error) {
      reject(error)
    }
  })
}

async function pollQrStatus(apiBaseUrl: string, qrcode: string): Promise<Record<string, unknown>> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    })
    clearTimeout(timer)
    const rawText = await response.text()
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`)
    }
    const parsed = JSON.parse(rawText)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" }
    }
    throw error
  }
}

function createAccountHelpers(): WeixinBindAccountHelpers {
  async function describeAccount(accountId: string) {
    return {
      accountId,
      enabled: true,
      configured: false,
    }
  }

  return {
    async listAccountIds() {
      return []
    },
    resolveAccount: describeAccount,
    async describeAccount(accountIdOrInput) {
      const accountId = typeof accountIdOrInput === "string" ? accountIdOrInput : accountIdOrInput.accountId
      return await describeAccount(accountId)
    },
  }
}

export async function loadOpenClawWeixinBindHelpers(): Promise<OpenClawWeixinBindHelpers> {
  const accountHelpers = createAccountHelpers()

  return {
    qrGateway: {
      async loginWithQrStart(input?: unknown) {
        const params = asObject(input)
        const sessionKey = asNonEmptyString(params.accountId) ?? randomUUID()
        const force = params.force === true
        purgeExpiredLogins()

        const existing = activeLogins.get(sessionKey)
        if (!force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
          return {
            qrcodeUrl: existing.qrcodeUrl,
            message: "二维码已就绪，请使用微信扫描。",
            sessionKey,
          }
        }

        const qrResponse = await fetchQrCode(DEFAULT_BASE_URL, DEFAULT_ILINK_BOT_TYPE)
        activeLogins.set(sessionKey, {
          sessionKey,
          qrcode: qrResponse.qrcode,
          qrcodeUrl: qrResponse.qrcode_img_content,
          startedAt: Date.now(),
        })

        return {
          qrTerminal: await renderQrTerminal(qrResponse.qrcode_img_content).catch(() => undefined),
          qrDataUrl: qrResponse.qrcode_img_content,
          qrcodeUrl: qrResponse.qrcode_img_content,
          message: "使用微信扫描以下二维码，以完成连接。",
          sessionKey,
        }
      },
      async loginWithQrWait(input?: unknown) {
        const params = asObject(input)
        const sessionKey = asNonEmptyString(params.sessionKey)
        if (!sessionKey) {
          throw new Error("missing sessionKey from qr wait")
        }
        let activeLogin = activeLogins.get(sessionKey)
        if (!activeLogin) {
          return { connected: false, message: "当前没有进行中的登录，请先发起登录。" }
        }
        if (!isLoginFresh(activeLogin)) {
          activeLogins.delete(sessionKey)
          return { connected: false, message: "二维码已过期，请重新生成。" }
        }

        const timeoutMs = Math.max(asPositiveNumber(params.timeoutMs) ?? 480_000, 1000)
        const deadline = Date.now() + timeoutMs

        while (Date.now() < deadline) {
          const statusResponse = await pollQrStatus(DEFAULT_BASE_URL, activeLogin.qrcode)
          const status = asNonEmptyString(statusResponse.status)
          if (status === "confirmed") {
            activeLogins.delete(sessionKey)
            return {
              connected: true,
              botToken: asNonEmptyString(statusResponse.bot_token),
              accountId: asNonEmptyString(statusResponse.ilink_bot_id),
              baseUrl: asNonEmptyString(statusResponse.baseurl),
              userId: asNonEmptyString(statusResponse.ilink_user_id),
              message: "✅ 与微信连接成功！",
            }
          }
          if (status === "expired") {
            activeLogins.delete(sessionKey)
            return { connected: false, message: "二维码已过期，请重新生成。" }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
          activeLogin = activeLogins.get(sessionKey) ?? activeLogin
        }

        activeLogins.delete(sessionKey)
        return { connected: false, message: "登录超时，请重试。" }
      },
    },
    accountHelpers,
  }
}
