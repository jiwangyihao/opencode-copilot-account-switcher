import { ANSI, isTTY, parseKey } from "./ansi.js"

const defaultSelectDebugLogFile = (() => {
  const tmp = process.env.TEMP || process.env.TMP || "/tmp"
  return `${tmp}/opencode-copilot-store-debug.log`
})()

function shouldLogSuspiciousAction(actionType: unknown) {
  return actionType === "toggle-network-retry"
}

function getActionType(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const actionType = (value as { type?: unknown }).type
  return typeof actionType === "string" ? actionType : undefined
}

export function buildSelectDebugEvent(input: {
  stage: "key" | "result"
  parsedKey: string | null
  currentValue?: unknown
  nextValue?: unknown
}) {
  const currentActionType = getActionType(input.currentValue)
  const nextActionType = getActionType(input.nextValue)
  const actionType = nextActionType ?? currentActionType
  if (!shouldLogSuspiciousAction(actionType)) return undefined
  return {
    stage: input.stage,
    parsedKey: input.parsedKey,
    currentActionType: currentActionType ?? null,
    nextActionType: nextActionType ?? null,
    actionType,
  }
}

async function logSelectDebug(input: {
  stage: "key" | "result"
  parsedKey: string | null
  currentValue?: unknown
  nextValue?: unknown
}) {
  const event = buildSelectDebugEvent(input)
  if (!event) return

  const filePath = process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE || defaultSelectDebugLogFile
  try {
    const { promises: fs } = await import("node:fs")
    const { dirname } = await import("node:path")
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.appendFile(
      filePath,
      `${JSON.stringify({ kind: "select-action", at: new Date().toISOString(), ...event })}\n`,
      "utf8",
    )
  } catch (error) {
    console.warn("[copilot-store-debug] failed to write select debug log", error)
  }
}

export interface MenuItem<T = string> {
  label: string
  value: T
  hint?: string
  disabled?: boolean
  separator?: boolean
  kind?: "heading"
  color?: "red" | "green" | "yellow" | "cyan"
}

export interface SelectOptions {
  message: string
  subtitle?: string
  help?: string
  clearScreen?: boolean
  autoSelectSingle?: boolean
}

export interface SelectManyOptions extends SelectOptions {
  doneLabel?: string
  backLabel?: string
  minSelected?: number
  initialSelected?: number[]
}

const ESCAPE_TIMEOUT_MS = 50

const ANSI_REGEX = new RegExp("\\x1b\\[[0-9;]*m", "g")
const ANSI_LEADING_REGEX = new RegExp("^\\x1b\\[[0-9;]*m")

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "")
}

function truncateAnsi(input: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) return ""
  const visible = stripAnsi(input)
  if (visible.length <= maxVisibleChars) return input
  const suffix = maxVisibleChars >= 3 ? "..." : ".".repeat(maxVisibleChars)
  const keep = Math.max(0, maxVisibleChars - suffix.length)
  let out = ""
  let i = 0
  let kept = 0
  while (i < input.length && kept < keep) {
    if (input[i] === "\x1b") {
      const m = input.slice(i).match(ANSI_LEADING_REGEX)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    out += input[i]
    i += 1
    kept += 1
  }
  if (out.includes("\x1b[")) return `${out}${ANSI.reset}${suffix}`
  return out + suffix
}

function getColorCode(color: MenuItem["color"]): string {
  if (color === "red") return ANSI.red
  if (color === "green") return ANSI.green
  if (color === "yellow") return ANSI.yellow
  if (color === "cyan") return ANSI.cyan
  return ""
}

export async function select<T>(items: MenuItem<T>[], options: SelectOptions): Promise<T | null> {
  if (!isTTY()) throw new Error("Interactive select requires a TTY terminal")
  if (items.length === 0) throw new Error("No menu items provided")
  const isSelectable = (i: MenuItem<T>) => !i.disabled && !i.separator && i.kind !== "heading"
  const enabled = items.filter(isSelectable)
  if (enabled.length === 0) throw new Error("All items disabled")
  const autoSelectSingle = options.autoSelectSingle ?? true
  if (enabled.length === 1 && autoSelectSingle) return enabled[0]?.value ?? null

  const { message, subtitle } = options
  const { stdin, stdout } = process
  let cursor = items.findIndex(isSelectable)
  if (cursor === -1) cursor = 0
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null
  let done = false
  let rendered = 0

  const render = () => {
    const columns = stdout.columns ?? 80
    const rows = stdout.rows ?? 24
    const clearScreen = options.clearScreen === true
    const prev = rendered
    if (clearScreen) {
      stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
    } else if (prev > 0) {
      stdout.write(ANSI.up(prev))
    }

    let lines = 0
    const write = (line: string) => {
      stdout.write(`${ANSI.clearLine}${line}\n`)
      lines += 1
    }

    const subtitleLines = subtitle ? subtitle.split("\n").length + 2 : 0
    const fixed = 1 + subtitleLines + 2
    const maxVisible = Math.max(1, Math.min(items.length, rows - fixed - 1))

    let windowStart = 0
    let windowEnd = items.length
    if (items.length > maxVisible) {
      windowStart = cursor - Math.floor(maxVisible / 2)
      windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisible))
      windowEnd = windowStart + maxVisible
    }

    const visibleItems = items.slice(windowStart, windowEnd)
    const header = truncateAnsi(message, Math.max(1, columns - 4))
    write(`${ANSI.dim}┌  ${ANSI.reset}${header}`)

    if (subtitle) {
      write(`${ANSI.dim}│${ANSI.reset}`)
      for (const line of subtitle.split("\n")) {
        const sub = truncateAnsi(line, Math.max(1, columns - 4))
        write(`${ANSI.cyan}◆${ANSI.reset}  ${sub}`)
      }
      write("")
    }

    for (let i = 0; i < visibleItems.length; i += 1) {
      const index = windowStart + i
      const item = visibleItems[i]
      if (!item) continue
      if (item.separator) {
        write(`${ANSI.dim}│${ANSI.reset}`)
        continue
      }
      if (item.kind === "heading") {
        const heading = truncateAnsi(`${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`, Math.max(1, columns - 6))
        write(`${ANSI.cyan}│${ANSI.reset}  ${heading}`)
        continue
      }

      const selected = index === cursor
      const color = getColorCode(item.color)
      let label: string
      if (item.disabled) {
        label = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`
      } else if (selected) {
        label = color ? `${color}${item.label}${ANSI.reset}` : item.label
        if (item.hint) label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`
      } else {
        label = color ? `${ANSI.dim}${color}${item.label}${ANSI.reset}` : `${ANSI.dim}${item.label}${ANSI.reset}`
        if (item.hint) label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`
      }

      label = truncateAnsi(label, Math.max(1, columns - 8))
      if (selected) {
        write(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${label}`)
      } else {
        write(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${label}`)
      }
    }

    const windowHint = items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : ""
    const helpText = options.help ?? `Up/Down to select | Enter: confirm | Esc: back${windowHint}`
    const help = truncateAnsi(helpText, Math.max(1, columns - 6))
    write(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${help}${ANSI.reset}`)
    write(`${ANSI.cyan}└${ANSI.reset}`)

    if (!clearScreen && prev > lines) {
      const extra = prev - lines
      for (let i = 0; i < extra; i += 1) write("")
    }

    rendered = lines
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false

    const cleanup = () => {
      if (done) return
      done = true
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      try {
        stdin.removeListener("data", onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write(ANSI.show)
      } catch {}
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
    }

    const onSignal = () => {
      cleanup()
      resolve(null)
    }

    const finish = (value: T | null) => {
      cleanup()
      resolve(value)
    }

    const findNextSelectable = (from: number, direction: 1 | -1): number => {
      if (items.length === 0) return from
      let next = from
      do {
        next = (next + direction + items.length) % items.length
      } while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading")
      return next
    }

    const onKey = (data: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      const action = parseKey(data)
      if (action === "up") {
        void logSelectDebug({ stage: "key", parsedKey: action, currentValue: items[cursor]?.value })
        cursor = findNextSelectable(cursor, -1)
        render()
        return
      }
      if (action === "down") {
        void logSelectDebug({ stage: "key", parsedKey: action, currentValue: items[cursor]?.value })
        cursor = findNextSelectable(cursor, 1)
        render()
        return
      }
      if (action === "enter") {
        void logSelectDebug({
          stage: "key",
          parsedKey: action,
          currentValue: items[cursor]?.value,
        })
        void logSelectDebug({
          stage: "result",
          parsedKey: action,
          currentValue: items[cursor]?.value,
          nextValue: items[cursor]?.value,
        })
        finish(items[cursor]?.value ?? null)
        return
      }
      if (action === "escape") {
        finish(null)
        return
      }
      if (action === "escape-start") {
        escapeTimeout = setTimeout(() => {
          finish(null)
        }, ESCAPE_TIMEOUT_MS)
        return
      }
    }

    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      stdin.setRawMode(true)
    } catch {
      cleanup()
      resolve(null)
      return
    }

    stdin.resume()
    stdout.write(ANSI.hide)
    render()
    stdin.on("data", onKey)
  })
}

export async function selectMany<T>(items: MenuItem<T>[], options: SelectManyOptions): Promise<T[] | null> {
  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.disabled && !item.separator && item.kind !== "heading")

  if (selectable.length === 0) return []

  const selected = new Set<number>()
  for (const index of options.initialSelected ?? []) {
    if (Number.isInteger(index) && index >= 0 && index < selectable.length) {
      selected.add(index)
    }
  }

  const DONE = "__select_many_done__"
  const BACK = "__select_many_back__"

  while (true) {
    const menuItems: MenuItem<string>[] = [
      { label: options.backLabel ?? "Back", value: BACK },
      {
        label: options.doneLabel ?? "Done",
        value: DONE,
        color: "cyan",
        hint: `${selected.size} selected`,
      },
      { label: "", value: "", separator: true },
      ...selectable.map(({ item }, index) => {
        const marker = selected.has(index) ? "[x]" : "[ ]"
        return {
          label: `${marker} ${item.label}`,
          value: String(index),
          hint: item.hint,
          color: item.color,
        } satisfies MenuItem<string>
      }),
    ]

    const choice = await select(menuItems, {
      ...options,
      autoSelectSingle: false,
      help: options.help ?? "Up/Down to select | Enter: toggle | Choose Done to confirm | Esc: back",
    })

    if (choice === null || choice === BACK) return null
    if (choice === DONE) {
      if ((options.minSelected ?? 0) > selected.size) continue
      return selectable
        .map(({ item }, index) => ({ item, index }))
        .filter(({ index }) => selected.has(index))
        .map(({ item }) => item.value)
    }

    const index = Number(choice)
    if (!Number.isInteger(index) || index < 0 || index >= selectable.length) continue
    if (selected.has(index)) selected.delete(index)
    else selected.add(index)
  }
}
