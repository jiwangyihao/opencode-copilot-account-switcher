export type WechatSlashCommand = {
  type: "status"
} | {
  type: "todo"
} | {
  type: "reply"
  handle: string
  text: string
} | {
  type: "recover"
  handle: string
} | {
  type: "allow"
  handle: string
  reply: "once" | "always" | "reject"
  message?: string
}

export function parseWechatSlashCommand(input: string): WechatSlashCommand | null {
  if (typeof input !== "string") {
    return null
  }

  const normalized = input.trim()
  if (normalized === "/status") {
    return { type: "status" }
  }
  if (normalized === "/todo") {
    return { type: "todo" }
  }

  const parts = normalized.split(/\s+/)
  const command = parts[0]

  if (command === "/reply") {
    if (parts.length < 3) {
      return null
    }
    const handle = parts[1]
    const textParts = parts.slice(2)
    const text = textParts.join(" ").trim()
    if (!handle || !text) {
      return null
    }
    return { type: "reply", handle, text }
  }

  if (command === "/recover") {
    if (parts.length !== 2) {
      return null
    }
    const handle = parts[1]
    if (!handle) {
      return null
    }
    return { type: "recover", handle }
  }

  if (command === "/allow") {
    if (parts.length < 3) {
      return null
    }
    const handle = parts[1]
    const rawReply = parts[2]
    const messageParts = parts.slice(3)
    if (!handle || !rawReply) {
      return null
    }
    if (rawReply !== "once" && rawReply !== "always" && rawReply !== "reject") {
      return null
    }
    const message = messageParts.join(" ").trim()
    return message.length > 0
      ? { type: "allow", handle, reply: rawReply, message }
      : { type: "allow", handle, reply: rawReply }
  }

  return null
}
