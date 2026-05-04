import type { Plugin } from "@opencode-ai/plugin"
import { createWaitTool, type WaitToolInput } from "./wait-tool.js"

const WAIT_TOOL_DESCRIPTION = "Use for unattended/background waits that do not require user confirmation, including long-running tasks, external jobs, cooldowns, or expected notifications; pass until: \"new_user_message\" to wait for the current session to receive a new user message, including plugin-synthesized notifications, or resume after a timed wait exits early for that reason."

export { createWaitTool }
export type { WaitToolInput }

export function createWaitPlugin(waitInput: WaitToolInput = {}): Plugin {
  return async (input) => ({
    tool: {
      wait: createWaitTool({
        ...waitInput,
        client: waitInput.client ?? input.client,
      }),
    },
    "tool.definition": async (hookInput, output) => {
      if (hookInput.toolID === "wait") {
        output.description = WAIT_TOOL_DESCRIPTION
      }
    },
  })
}

export const WaitPlugin: Plugin = createWaitPlugin()

export default WaitPlugin