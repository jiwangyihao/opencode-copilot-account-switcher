import { AsyncLocalStorage } from "node:async_hooks"
import type { Hooks } from "@opencode-ai/plugin"
import { readStoreSafe, type StoreFile } from "./store.js"

export const LOOP_SAFETY_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- Channel contract: Use only question or notify for user-visible interactions; never emit ordinary assistant plain text.
- Notify contract: Pure progress, phase switches, and non-blocking background status updates belong to notify.
- Question contract: Required user response, user decisions or confirmations, final handoff, and no-safe-work-left states belong to question; do not use question for unattended waits that can resume automatically.
- Wait contract: All waiting that does not require user confirmation, including background waits for long-running tools, external jobs, cooldowns, or expected notifications, must use wait instead of question.
- Decision matrix: If uncertain whether user input is required, default to question; if the only need is time passing or waiting for an expected non-user event, use wait.
- Marker contract: If a tool output contains [COPILOT_INJECT_V1_BEGIN] ... [COPILOT_INJECT_V1_END], immediately call question and wait for user instruction before continuing.
- Silent fallback discipline: If notify is unavailable, denied, absent, or fails, pure progress stays silent and work continues; do not automatically escalate that progress into question.
- Silent fallback discipline: If question is unavailable, denied, or absent, only strong-interaction content may fall back to direct assistant text.
- Silent fallback discipline: Tool availability does not change the interaction class of the content itself; progress stays progress and strong interaction stays strong interaction.
- Reflection and violation diagnosis: If the user says the reporting behavior was wrong, first check whether content was assigned to the wrong interaction class or sent through the wrong channel.
- Reflection and violation diagnosis: Check notify/question misclassification before blaming verbosity, timing, tone, or the policy itself.
- Reflection and violation diagnosis: Final completion handoff remains a question event, while unattended waits remain wait events.
`

export type ExperimentalChatSystemTransformHook = (
  input: {
    sessionID?: string
    model: {
      providerID: string
    }
  },
  output: {
    system: string[]
  },
) => Promise<void>

export type ExperimentalSessionCompactingHook = (
  input: {
    sessionID: string
  },
  output: {
    context: string[]
    prompt?: string
  },
) => Promise<void>

export type CopilotPluginHooks = Hooks & {
  "experimental.chat.system.transform"?: ExperimentalChatSystemTransformHook
  "experimental.session.compacting"?: ExperimentalSessionCompactingHook
}

export type CompactionLoopSafetyBypass = {
  hook: ExperimentalSessionCompactingHook
  consume(sessionID?: string): boolean
}

export type SessionAncestryEntry = {
  sessionID?: string
  parentID?: string
}

export type LoopSafetyProviderScope = "copilot-only" | "all-models"

export type LookupSessionAncestry = (
  sessionID: string,
) => Promise<SessionAncestryEntry[] | undefined>

function hasParentSession(entries: SessionAncestryEntry[] | undefined, sessionID: string): boolean {
  const currentSession = entries?.find((entry) => entry?.sessionID === sessionID)
  return currentSession?.parentID != null
}

export function isCopilotProvider(providerID: string): boolean {
  return providerID === "github-copilot" || providerID === "github-copilot-enterprise"
}

export function getLoopSafetyProviderScope(
  store: StoreFile | undefined,
  override?: LoopSafetyProviderScope,
): LoopSafetyProviderScope {
  if (override === "all-models" || override === "copilot-only") return override
  if (store?.loopSafetyProviderScope === "all-models") return "all-models"
  return "copilot-only"
}

export function applyLoopSafetyPolicy(input: {
  providerID: string
  enabled: boolean
  scope?: LoopSafetyProviderScope
  skip?: boolean
  system: string[]
}): string[] {
  if (!input.enabled) return input.system
  if (input.skip) return input.system
  if (input.scope !== "all-models" && !isCopilotProvider(input.providerID)) return input.system
  if (input.system.includes(LOOP_SAFETY_POLICY)) return input.system
  return [...input.system, LOOP_SAFETY_POLICY]
}

export function createLoopSafetySystemTransform(
  loadStore: () => Promise<StoreFile | undefined> = readStoreSafe,
  consumeCompactionBypass: (sessionID?: string) => boolean = () => false,
  lookupSessionAncestry: LookupSessionAncestry = async () => undefined,
  resolveScope: (store: StoreFile | undefined) => LoopSafetyProviderScope = (store) => getLoopSafetyProviderScope(store),
): ExperimentalChatSystemTransformHook {
  return async (input, output) => {
    const store = await loadStore().catch(() => undefined)
    const enabled = store?.loopSafetyEnabled === true
    const scope = resolveScope(store)
    const sessionID = typeof input.sessionID === "string" && input.sessionID.length > 0
      ? input.sessionID
      : undefined
    const shouldCheckProvider = scope === "all-models" || isCopilotProvider(input.model.providerID)
    const bypassed = enabled && shouldCheckProvider
      ? consumeCompactionBypass(sessionID)
      : false
    const derivedSession = enabled
      && shouldCheckProvider
      && !bypassed
      && sessionID !== undefined
      ? await lookupSessionAncestry(sessionID)
        .then((entries) => hasParentSession(entries, sessionID))
        .catch(() => false)
      : false
    const skip = bypassed || derivedSession
    const next = applyLoopSafetyPolicy({
      providerID: input.model.providerID,
      enabled,
      scope,
      skip,
      system: output.system,
    })

    if (next.length === output.system.length) return
    output.system.push(LOOP_SAFETY_POLICY)
  }
}

export function createCompactionLoopSafetyBypass(): CompactionLoopSafetyBypass {
  const storage = new AsyncLocalStorage<{
    sessionID: string
    pending: boolean
  }>()

  return {
    hook: async (input, _output) => {
      storage.enterWith({ sessionID: input.sessionID, pending: true })
    },
    consume(sessionID?: string) {
      if (!sessionID) return false
      const state = storage.getStore()
      if (!state) return false
      if (state.pending !== true) return false
      if (state.sessionID !== sessionID) return false
      state.pending = false
      return true
    },
  }
}
