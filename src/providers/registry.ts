import { COPILOT_PROVIDER_DESCRIPTOR, type ProviderDescriptor } from "./descriptor.js"
import { createCopilotProviderDescriptor } from "./descriptor.js"
import type { buildPluginHooks as buildPluginHooksFn } from "../plugin-hooks.js"
import { createCopilotRetryingFetch } from "../copilot-network-retry.js"
import { loadOfficialCopilotChatHeaders, loadOfficialCopilotConfig } from "../upstream/copilot-loader-adapter.js"

const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  COPILOT_PROVIDER_DESCRIPTOR,
]

export function listProviderDescriptors(): ProviderDescriptor[] {
  return [...PROVIDER_DESCRIPTORS]
}

export function getProviderDescriptorByKey(key: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.key === key)
}

export function getProviderDescriptorByProviderID(providerID: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providerIDs.includes(providerID))
}

export function isProviderIDSupportedByAnyDescriptor(providerID: string): boolean {
  return getProviderDescriptorByProviderID(providerID) !== undefined
}

type BuildPluginHooks = typeof buildPluginHooksFn

function hasCapability(descriptor: ProviderDescriptor, capability: ProviderDescriptor["capabilities"][number]) {
  return descriptor.capabilities.includes(capability)
}

export function createProviderRegistry(input: {
  buildPluginHooks: BuildPluginHooks
}) {
  const copilotCapabilities = COPILOT_PROVIDER_DESCRIPTOR

  const buildCopilotPluginHooks: BuildPluginHooks = (hookInput) => input.buildPluginHooks({
    ...hookInput,
    authLoaderMode: hasCapability(copilotCapabilities, "auth") ? "copilot" : "none",
    enableModelRouting: hasCapability(copilotCapabilities, "model-routing"),
    loadOfficialConfig: hasCapability(copilotCapabilities, "auth") ? loadOfficialCopilotConfig : undefined,
    loadOfficialChatHeaders: hasCapability(copilotCapabilities, "chat-headers") ? loadOfficialCopilotChatHeaders : undefined,
    createRetryFetch: hasCapability(copilotCapabilities, "network-retry") ? createCopilotRetryingFetch : undefined,
  })

  return {
    copilot: {
      descriptor: createCopilotProviderDescriptor({ buildPluginHooks: buildCopilotPluginHooks }),
    },
  }
}
