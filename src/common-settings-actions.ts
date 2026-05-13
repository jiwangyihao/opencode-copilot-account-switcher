import type { CommonSettingsStore } from "./common-settings-store.js"

export type CommonSettingsActionType =
  | "toggle-experimental-slash-commands"
  | "toggle-network-retry"

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


  return false
}
