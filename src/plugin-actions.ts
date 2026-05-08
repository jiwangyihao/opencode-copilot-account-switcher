import type { StoreFile } from "./store.js"
import type { MenuAction } from "./ui/menu.js"
import { applyCommonSettingsAction } from "./common-settings-actions.js"
import type { CommonSettingsStore } from "./common-settings-store.js"

function isCommonSettingsAction(action: MenuAction): action is Extract<MenuAction,
  { type: "toggle-experimental-slash-commands" }
  | { type: "toggle-network-retry" }
> {
  return action.type === "toggle-experimental-slash-commands"
    || action.type === "toggle-network-retry"
}

export async function persistAccountSwitch(input: {
  store: StoreFile
  name: string
  at: number
  writeStore: (store: StoreFile, meta?: {
    reason?: string
    source?: string
    actionType?: string
    inputStage?: string
    parsedKey?: string
  }) => Promise<void>
}) {
  input.store.active = input.name
  if (!Array.isArray(input.store.activeAccountNames) || input.store.activeAccountNames.length === 0) {
    input.store.activeAccountNames = [input.name]
  }
  input.store.accounts[input.name].lastUsed = input.at
  input.store.lastAccountSwitchAt = input.at
  await input.writeStore(input.store, {
    reason: "persist-account-switch",
    source: "persistAccountSwitch",
    actionType: "switch",
  })
}

export async function applyMenuAction(input: {
  action: MenuAction
  store: StoreFile
  writeStore: (store: StoreFile, meta?: {
    reason?: string
    source?: string
    actionType?: string
    inputStage?: string
    parsedKey?: string
  }) => Promise<void>
  readCommonSettings?: () => Promise<CommonSettingsStore>
  writeCommonSettings?: (settings: CommonSettingsStore, meta?: {
    reason?: string
    source?: string
    actionType?: string
    inputStage?: string
    parsedKey?: string
  }) => Promise<void>
}): Promise<boolean> {
  if (isCommonSettingsAction(input.action)) {
    if (!input.readCommonSettings || !input.writeCommonSettings) {
      throw new Error(`Common settings action ${input.action.type} requires common settings store dependencies`)
    }

    await applyCommonSettingsAction({
      action: { type: input.action.type },
      readSettings: input.readCommonSettings,
      writeSettings: input.writeCommonSettings,
    })
    return true
  }

  if (input.action.type === "toggle-synthetic-agent-initiator") {
    input.store.syntheticAgentInitiatorEnabled = input.store.syntheticAgentInitiatorEnabled !== true
    await input.writeStore(input.store, {
      reason: "toggle-synthetic-agent-initiator",
      source: "applyMenuAction",
      actionType: "toggle-synthetic-agent-initiator",
    })
    return true
  }

  return false
}
