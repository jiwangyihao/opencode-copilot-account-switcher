import path from "node:path"
import os from "node:os"
import { xdgConfig } from "xdg-basedir"

function configBaseDir() {
  const override = process.env.XDG_CONFIG_HOME
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim()
  }
  return xdgConfig ?? path.join(os.homedir(), ".config")
}

export function accountSwitcherConfigDir() {
  return path.join(configBaseDir(), "opencode", "account-switcher")
}

export function commonSettingsPath() {
  return path.join(accountSwitcherConfigDir(), "settings.json")
}

export function copilotAccountsPath() {
  return path.join(accountSwitcherConfigDir(), "copilot-accounts.json")
}

export function codexAccountsPath() {
  return path.join(accountSwitcherConfigDir(), "codex-accounts.json")
}

export function wechatConfigDir() {
  return path.join(accountSwitcherConfigDir(), "wechat")
}

export function legacyCopilotStorePath() {
  return path.join(configBaseDir(), "opencode", "copilot-accounts.json")
}

export function legacyCodexStorePath() {
  return path.join(configBaseDir(), "opencode", "codex-store.json")
}
