import type { CommonSettingsStore } from "./common-settings-store.js"

export type CommonSettingsActionType =
  | "toggle-experimental-slash-commands"
  | "toggle-network-retry"
  | "wechat-bind"
  | "wechat-rebind"
  | "wechat-unbind"
  | "toggle-wechat-notifications"
  | "toggle-wechat-question-notify"
  | "toggle-wechat-permission-notify"
  | "toggle-wechat-session-error-notify"

type WriteMeta = {
  reason?: string
  source?: string
  actionType?: string
}

export async function applyCommonSettingsAction(input: {
  action: { type: CommonSettingsActionType }
  readSettings: () => Promise<CommonSettingsStore>
  writeSettings: (settings: CommonSettingsStore, meta?: WriteMeta) => Promise<void>
}): Promise<boolean> {
  const settings = await input.readSettings()
  const existingNotifications = settings.wechat?.notifications
  const notifications = {
    enabled: existingNotifications?.enabled !== false,
    question: existingNotifications?.question !== false,
    permission: existingNotifications?.permission !== false,
    sessionError: existingNotifications?.sessionError !== false,
  }
  if (!settings.wechat) {
    settings.wechat = {
      notifications,
    }
  } else if (!settings.wechat.notifications) {
    settings.wechat.notifications = notifications
  }


  if (input.action.type === "toggle-experimental-slash-commands") {
    settings.experimentalSlashCommandsEnabled = settings.experimentalSlashCommandsEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-experimental-slash-commands",
      source: "applyCommonSettingsAction",
      actionType: "toggle-experimental-slash-commands",
    })
    return true
  }

  if (input.action.type === "toggle-network-retry") {
    settings.networkRetryEnabled = settings.networkRetryEnabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-network-retry",
      source: "applyCommonSettingsAction",
      actionType: "toggle-network-retry",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-notifications") {
    settings.wechat.notifications.enabled = settings.wechat.notifications.enabled !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-notifications",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-notifications",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-question-notify") {
    settings.wechat.notifications.question = settings.wechat.notifications.question !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-question-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-question-notify",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-permission-notify") {
    settings.wechat.notifications.permission = settings.wechat.notifications.permission !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-permission-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-permission-notify",
    })
    return true
  }

  if (input.action.type === "toggle-wechat-session-error-notify") {
    settings.wechat.notifications.sessionError = settings.wechat.notifications.sessionError !== true
    await input.writeSettings(settings, {
      reason: "toggle-wechat-session-error-notify",
      source: "applyCommonSettingsAction",
      actionType: "toggle-wechat-session-error-notify",
    })
    return true
  }

  if (input.action.type === "wechat-bind" || input.action.type === "wechat-rebind" || input.action.type === "wechat-unbind") {
    return true
  }

  return false
}
