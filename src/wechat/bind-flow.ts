import { bindOperator, readOperatorBinding, rebindOperator, resetOperatorBinding } from "./operator-store.js"
import { loadOpenClawWeixinBindHelpers } from "./compat/openclaw-bind-helpers.js"
import { buildOpenClawMenuAccount } from "./openclaw-account-adapter.js"
import { loadQrCodeTerminal } from "./compat/qrcode-terminal-loader.js"
import type { CommonSettingsStore } from "../common-settings-store.js"
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id"
import { writeWechatLatestAccountState } from "./latest-account-state-store.js"

type BindAction = "wechat-bind" | "wechat-rebind"
const DEFAULT_QR_WAIT_TIMEOUT_MS = 480000

type WechatBindFlowResult = {
  accountId: string
  userId: string
  name?: string
  enabled?: boolean
  configured?: boolean
  boundAt: number
}

type WechatBindFlowInput = {
  action: BindAction
  loadPublicHelpers?: typeof loadOpenClawWeixinBindHelpers
  bindOperator?: typeof bindOperator
  rebindOperator?: typeof rebindOperator
  readOperatorBinding?: typeof readOperatorBinding
  resetOperatorBinding?: typeof resetOperatorBinding
  readCommonSettings: () => Promise<CommonSettingsStore>
  writeCommonSettings: (settings: CommonSettingsStore) => Promise<void>
  writeLine?: (line: string) => Promise<void>
  renderQrTerminal?: (input: { value: string }) => Promise<string | undefined>
  now?: () => number
}

function pickFirstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return String(error)
}

function pickQrTerminal(value: unknown): string | undefined {
  return pickFirstNonEmptyString(
    (value as { qrTerminal?: unknown } | null | undefined)?.qrTerminal,
  )
}

function pickQrUrl(value: unknown): string | undefined {
  return pickFirstNonEmptyString(
    (value as { qrDataUrl?: unknown } | null | undefined)?.qrDataUrl,
  )
}

function isTimeoutWaitResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && String((value as { status?: unknown }).status) === "timeout")
}

async function rollbackBinding(action: BindAction, previousOperatorBinding: Awaited<ReturnType<typeof readOperatorBinding>>, persistOperatorRebinding: typeof rebindOperator, clearOperatorBinding: typeof resetOperatorBinding) {
  if (action === "wechat-rebind" && previousOperatorBinding) {
    await persistOperatorRebinding(previousOperatorBinding).catch(() => {})
    return
  }
  await clearOperatorBinding().catch(() => {})
}

function isSameOperatorBinding(
  left: Awaited<ReturnType<typeof readOperatorBinding>>,
  right: Awaited<ReturnType<typeof readOperatorBinding>>,
): boolean {
  if (!left || !right) {
    return false
  }
  return left.wechatAccountId === right.wechatAccountId && left.userId === right.userId && left.boundAt === right.boundAt
}

async function renderQrTerminalDefault(input: { value: string }): Promise<string | undefined> {
  const qrcodeTerminal = loadQrCodeTerminal()
  return await new Promise((resolve) => {
    qrcodeTerminal.generate(input.value, { small: true }, (output: string) => {
      resolve(typeof output === "string" && output.trim().length > 0 ? output : undefined)
    })
  })
}

export async function runWechatBindFlow(input: WechatBindFlowInput): Promise<WechatBindFlowResult> {
  const now = input.now ?? Date.now
  const loadPublicHelpers = input.loadPublicHelpers ?? loadOpenClawWeixinBindHelpers
  const persistOperatorBinding = input.bindOperator ?? bindOperator
  const persistOperatorRebinding = input.rebindOperator ?? rebindOperator
  const loadOperatorBinding = input.readOperatorBinding ?? readOperatorBinding
  const clearOperatorBinding = input.resetOperatorBinding ?? resetOperatorBinding
  const renderQrTerminal = input.renderQrTerminal ?? renderQrTerminalDefault
  const writeLine = input.writeLine ?? (async (line: string) => {
    process.stdout.write(`${line}\n`)
  })

  try {
    const helpers = await loadPublicHelpers()
    const started = await Promise.resolve(helpers.qrGateway.loginWithQrStart({ source: "menu", action: input.action }))
    const qrTerminal = pickQrTerminal(started)
    const qrUrl = pickQrUrl(started)
    const qrStartMessage = pickFirstNonEmptyString(
      (started as { message?: unknown } | null | undefined)?.message,
      (started as { detail?: unknown } | null | undefined)?.detail,
      (started as { reason?: unknown } | null | undefined)?.reason,
    )
    const sessionKey = pickFirstNonEmptyString(
      (started as { sessionKey?: unknown } | null | undefined)?.sessionKey,
    )
    if (!sessionKey) {
      throw new Error("missing sessionKey from qr start")
    }

    if (qrTerminal) {
      await writeLine(qrTerminal)
    } else if (qrUrl) {
      const renderedQr = await renderQrTerminal({ value: qrUrl }).catch(() => undefined)
      if (renderedQr) {
        await writeLine(renderedQr)
      }
      await writeLine(`QR URL fallback: ${qrUrl}`)
    } else {
      throw new Error(qrStartMessage || "invalid qr login result: missing qr code or qr url")
    }

    const waited = await Promise.resolve(helpers.qrGateway.loginWithQrWait({ timeoutMs: DEFAULT_QR_WAIT_TIMEOUT_MS, sessionKey }))
    if (isTimeoutWaitResult(waited)) {
      throw new Error("qr login timed out before completion")
    }
    if (waited && typeof waited === "object" && "connected" in waited && (waited as { connected?: unknown }).connected === false) {
      throw new Error("qr login did not complete")
    }

    const rawAccountId = pickFirstNonEmptyString(
      (waited as { accountId?: unknown } | null | undefined)?.accountId,
    )
    if (!rawAccountId) {
      throw new Error("missing accountId after qr login")
    }
    const accountId = normalizeAccountId(rawAccountId)

    const boundAt = now()
    const previousOperatorBinding = input.action === "wechat-rebind" ? await loadOperatorBinding() : undefined
    const userIdFromWait = pickFirstNonEmptyString(
      (waited as { userId?: unknown } | null | undefined)?.userId,
    )
    let menuAccount: Awaited<ReturnType<typeof buildOpenClawMenuAccount>>
    let boundUserId = ""
    const botToken = pickFirstNonEmptyString(
      (waited as { botToken?: unknown } | null | undefined)?.botToken,
    )
    let shouldRollbackBinding = false
    let attemptedOperatorBinding: Awaited<ReturnType<typeof readOperatorBinding>>
    try {
      const menuAccountState = {
        accountId,
        token: "",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }
      menuAccount = await buildOpenClawMenuAccount({
        latestAccountState: menuAccountState,
        accountHelpers: helpers.accountHelpers,
      })

      const userId = pickFirstNonEmptyString(
        menuAccount?.userId,
        userIdFromWait,
      )
      if (!userId) {
        throw new Error("missing userId after qr login")
      }
      boundUserId = userId
      attemptedOperatorBinding = {
        wechatAccountId: accountId,
        userId,
        boundAt,
      }
      if (input.action === "wechat-rebind") {
        shouldRollbackBinding = true
        await persistOperatorRebinding(attemptedOperatorBinding)
      } else {
        shouldRollbackBinding = true
        await persistOperatorBinding(attemptedOperatorBinding)
      }

      const settings = await input.readCommonSettings()
      const notifications = settings.wechat?.notifications ?? {
        enabled: true,
        question: true,
        permission: true,
        sessionError: true,
      }
      settings.wechat = {
        ...settings.wechat,
        notifications,
        primaryBinding: {
          accountId,
          userId,
          name: menuAccount?.name,
          enabled: menuAccount?.enabled,
          configured: menuAccount?.configured,
          boundAt,
        },
      }

      await input.writeCommonSettings(settings)

      if (botToken) {
        await writeWechatLatestAccountState({
          accountId,
          token: botToken,
          baseUrl: pickFirstNonEmptyString((waited as { baseUrl?: unknown } | null | undefined)?.baseUrl, menuAccountState.baseUrl) ?? "https://ilinkai.weixin.qq.com",
        })
      }
    } catch (error) {
      if (shouldRollbackBinding) {
        const currentOperatorBinding = await loadOperatorBinding().catch(() => undefined)
        if (isSameOperatorBinding(currentOperatorBinding, attemptedOperatorBinding)) {
          await rollbackBinding(input.action, previousOperatorBinding, persistOperatorRebinding, clearOperatorBinding)
        }
      }
      throw error
    }

    return {
      accountId,
      userId: boundUserId,
      name: menuAccount?.name,
      enabled: menuAccount?.enabled,
      configured: menuAccount?.configured,
      boundAt,
    }
  } catch (error) {
    if (input.action === "wechat-rebind") {
      throw new Error(`wechat rebind failed: ${toErrorMessage(error)}`)
    }
    throw new Error(`wechat bind failed: ${toErrorMessage(error)}`)
  }
}
