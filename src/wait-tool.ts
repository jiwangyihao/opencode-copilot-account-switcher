import { tool } from "@opencode-ai/plugin"

type WaitToolInput = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const MIN_WAIT_SECONDS = 30

function toIso(ms: number) {
  return new Date(ms).toISOString()
}

function normalizeSeconds(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return MIN_WAIT_SECONDS
  return Math.max(MIN_WAIT_SECONDS, Math.floor(parsed))
}

export function createWaitTool(input: WaitToolInput = {}) {
  const now = input.now ?? (() => Date.now())
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return tool({
    description: "Wait in background for unattended tasks that do not require user confirmation, including long-running work, cooldowns, or expected non-user events.",
    args: {
      seconds: tool.schema.number().optional().describe("How long to wait in seconds (minimum 30)."),
    },
    async execute(args) {
      const seconds = normalizeSeconds(args.seconds)
      const started = now()
      await sleep(seconds * 1000)
      const finished = now()

      return `started: ${toIso(started)}; waited: ${seconds}s; now: ${toIso(finished)}`
    },
  })
}
