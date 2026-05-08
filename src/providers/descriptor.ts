import type { buildPluginHooks as buildPluginHooksFn } from "../plugin-hooks.js"

export type ProviderCapability =
  | "auth"
  | "chat-headers"
  | "model-routing"
  | "network-retry"
  | "slash-commands"

export type ProviderDescriptor = {
  key: string
  providerIDs: string[]
  storeNamespace: string
  commands: string[]
  menuEntries: string[]
  capabilities: ProviderCapability[]
}

type BuildPluginHooks = typeof buildPluginHooksFn

export type AssembledProviderDescriptor = {
  key: string
  auth: {
    provider: string
  }
  buildPluginHooks: BuildPluginHooks
  enabledByDefault: boolean
}

export const COPILOT_PROVIDER_DESCRIPTOR: ProviderDescriptor = {
  key: "copilot",
  providerIDs: [
    "github-copilot",
    "github-copilot-enterprise",
  ],
  storeNamespace: "copilot",
  commands: [
    "copilot-status",
    "copilot-compact",
    "copilot-stop-tool",
  ],
  menuEntries: [
    "switch-account",
    "add-account",
    "import-auth",
    "quota-refresh",
    "configure-default-account-group",
    "assign-model-account",
    "toggle-network-retry",
  ],
  capabilities: [
    "auth",
    "chat-headers",
    "model-routing",
    "network-retry",
    "slash-commands",
  ],
}

export const CODEX_PROVIDER_DESCRIPTOR: ProviderDescriptor = {
  key: "codex",
  providerIDs: [
    "openai",
  ],
  storeNamespace: "codex",
  commands: [
    "codex-status",
  ],
  menuEntries: [
    "switch-account",
    "add-account",
    "refresh-snapshot",
  ],
  capabilities: [
    "auth",
    "chat-headers",
    "network-retry",
    "slash-commands",
  ],
}

export function createCopilotProviderDescriptor(input: {
  buildPluginHooks: BuildPluginHooks
}): AssembledProviderDescriptor {
  return {
    key: "copilot",
    auth: {
      provider: "github-copilot",
    },
    buildPluginHooks: input.buildPluginHooks,
    enabledByDefault: true,
  }
}

export function createCodexProviderDescriptor(input: {
  buildPluginHooks: BuildPluginHooks
  enabled?: boolean
}): AssembledProviderDescriptor {
  return {
    key: "codex",
    auth: {
      provider: "openai",
    },
    buildPluginHooks: input.buildPluginHooks,
    enabledByDefault: input.enabled !== false,
  }
}
