import test from "node:test"
import { after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, stat, access, writeFile, rm, readdir } from "node:fs/promises"
import { mkdirSync, readFileSync } from "node:fs"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const DIST_PROTOCOL_MODULE = "../dist/wechat/protocol.js"
const DIST_AUTH_MODULE = "../dist/wechat/ipc-auth.js"
const DIST_BROKER_CLIENT_MODULE = "../dist/wechat/broker-client.js"
const DIST_BROKER_LAUNCHER_MODULE = "../dist/wechat/broker-launcher.js"
const DIST_BROKER_SERVER_MODULE = "../dist/wechat/broker-server.js"
const DIST_BROKER_ENTRY = fileURLToPath(new URL("../dist/wechat/broker-entry.js", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

const FUTURE_TYPES = [
  "collectStatus",
  "replyQuestion",
  "rejectQuestion",
  "replyPermission",
  "showFallbackToast",
]

function countChar(text, target) {
  let count = 0
  for (const char of text) {
    if (char === target) count += 1
  }
  return count
}

function handleFutureMessage({ protocol, auth, request }) {
  const token = typeof request.sessionToken === "string" ? request.sessionToken : ""
  if (!auth.validateSessionToken(request.instanceID, token)) {
    return protocol.createErrorEnvelope("unauthorized", "session token is invalid", request.id)
  }
  return protocol.createErrorEnvelope("notImplemented", "future message is not implemented", request.id)
}

const childProcesses = new Set()

after(async () => {
  for (const child of childProcesses) {
    await terminateChild(child)
  }
})

function createBrokerEndpoint(tempDir) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\wechat-broker-${process.pid}-${suffix}`
  }
  return path.join(tempDir, `wechat-broker-${suffix}.sock`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createSocketConnection(endpoint) {
  if (typeof endpoint === "string" && endpoint.startsWith("tcp://")) {
    const parsed = new URL(endpoint)
    return net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
    })
  }

  return net.createConnection(endpoint)
}

async function waitForBrokerMetadata(brokerJsonPath, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(brokerJsonPath, "utf8")
      return JSON.parse(raw)
    } catch {
      await delay(50)
    }
  }
  throw new Error(`timeout waiting for broker metadata: ${brokerJsonPath}`)
}

async function waitForFileRemoved(filePath, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(filePath, "utf8")
      await delay(50)
    } catch (error) {
      if (error?.code === "ENOENT") {
        return
      }
      throw error
    }
  }
  throw new Error(`timeout waiting for file removal: ${filePath}`)
}

async function waitForInstanceSnapshot(instancePath, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(instancePath, "utf8")
      const parsed = JSON.parse(raw)
      if (!predicate || predicate(parsed)) {
        return parsed
      }
    } catch {
      // keep polling
    }
    await delay(50)
  }
  throw new Error(`timeout waiting for instance snapshot: ${instancePath}`)
}

async function waitForRequestRecord(requestStore, lookup, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const record = await requestStore.findRequestByRouteKey(lookup)
    if (record && (!predicate || predicate(record))) {
      return record
    }
    await delay(50)
  }
  throw new Error(`timeout waiting for request record: ${lookup.kind}:${lookup.routeKey}`)
}

async function waitForJsonFile(filePath, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(filePath, "utf8")
      const parsed = JSON.parse(raw)
      if (!predicate || predicate(parsed)) {
        return parsed
      }
    } catch {
      // keep polling
    }
    await delay(50)
  }
  throw new Error(`timeout waiting for json file: ${filePath}`)
}

async function waitForFileText(filePath, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await readFile(filePath, "utf8")
      if (!predicate || predicate(text)) {
        return text
      }
    } catch {
      // keep polling
    }
    await delay(50)
  }
  throw new Error(`timeout waiting for file text: ${filePath}`)
}

async function waitForNotificationRecords(notificationDir, fileNamePredicate, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const files = (await readdir(notificationDir)).filter((fileName) => fileNamePredicate(fileName))
      const records = await Promise.all(
        files.map(async (fileName) => JSON.parse(await readFile(path.join(notificationDir, fileName), "utf8"))),
      )
      if (predicate(records)) {
        return records
      }
    } catch {
      // keep polling
    }
    await delay(50)
  }
  throw new Error(`timeout waiting for notification records: ${notificationDir}`)
}

function spawnBrokerEntry({ endpoint, xdgConfigHome, extraEnv = {} }) {
  const child = spawn(process.execPath, [DIST_BROKER_ENTRY, `--endpoint=${endpoint}`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      WECHAT_STATE_ROOT_OVERRIDE: "",
      WECHAT_BROKER_EXIT_ON_STDIN_EOF: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  childProcesses.add(child)
  return child
}

function spawnDetachedBrokerEntry({ endpoint, xdgConfigHome }) {
  const child = spawn(process.execPath, [DIST_BROKER_ENTRY, `--endpoint=${endpoint}`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      WECHAT_STATE_ROOT_OVERRIDE: "",
    },
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  childProcesses.add(child)
  return child
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function assertProcessStaysAlive(pid, durationMs, pollIntervalMs = 25) {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    assert.equal(isProcessAlive(pid), true)
    await delay(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 1)))
  }
}

async function killProcessByPid(pid, signal = "SIGTERM", timeoutMs = 5000) {
  if (!isProcessAlive(pid)) {
    return
  }

  process.kill(pid, signal)

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return
    }
    await delay(50)
  }

  throw new Error(`timeout waiting process exit: ${pid}`)
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout waiting for broker exit"))
    }, timeoutMs)

    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  if (child.stdin && !child.stdin.destroyed) {
    child.stdin.end()
  }

  try {
    await waitForExit(child, 2000)
    return
  } catch {
    // continue with signal fallback
  }

  child.kill("SIGINT")
  try {
    await waitForExit(child, 2000)
    return
  } catch {
    // fall through and force terminate
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    await waitForExit(child, 3000)
  }
}

async function sendFrameAndReadResponse(endpoint, line, timeoutMs = 4000) {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  return new Promise((resolve, reject) => {
    const socket = createSocketConnection(endpoint)
    let buffer = ""

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("timeout waiting for broker response"))
    }, timeoutMs)

    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })

    socket.on("connect", () => {
      socket.write(line)
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const index = buffer.indexOf("\n")
      if (index === -1) {
        return
      }
      const frame = buffer.slice(0, index + 1)
      clearTimeout(timer)
      socket.end()
      try {
        resolve(protocol.parseEnvelopeLine(frame))
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function createPersistentConnection(endpoint) {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const socket = createSocketConnection(endpoint)
  let buffer = ""
  let pendingResolve = null
  let pendingReject = null

  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    while (true) {
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }
      const frame = buffer.slice(0, newlineIndex + 1)
      buffer = buffer.slice(newlineIndex + 1)
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
        resolve(protocol.parseEnvelopeLine(frame))
      }
    }
  })

  socket.on("error", (error) => {
    if (pendingReject) {
      const reject = pendingReject
      pendingResolve = null
      pendingReject = null
      reject(error)
    }
  })

  await ready

  return {
    async send(envelope, timeoutMs = 4000) {
      if (pendingResolve) {
        throw new Error("connection already has pending request")
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingReject === reject) {
            pendingResolve = null
            pendingReject = null
          }
          reject(new Error("timeout waiting for broker response"))
        }, timeoutMs)

        pendingResolve = (message) => {
          clearTimeout(timer)
          resolve(message)
        }
        pendingReject = (error) => {
          clearTimeout(timer)
          reject(error)
        }

        socket.write(protocol.serializeEnvelope(envelope))
      })
    },
    async close(timeoutMs = 4000) {
      if (socket.destroyed) {
        return
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timeout waiting for connection close"))
        }, timeoutMs)

        socket.once("close", () => {
          clearTimeout(timer)
          resolve()
        })
        socket.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })

        socket.destroy()
      })
    },
  }
}

test("NDJSON 单行一帧：serialize 输出单行并以换行结尾，裸换行必须转义", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const envelope = {
    id: "req-1",
    type: "heartbeat",
    instanceID: "wx-1",
    sessionToken: "token-1",
    payload: { message: "line-1\nline-2" },
  }

  const line = protocol.serializeEnvelope(envelope)
  assert.equal(typeof line, "string")
  assert.equal(line.endsWith("\n"), true)
  assert.equal(countChar(line, "\n"), 1)

  const parsed = protocol.parseEnvelopeLine(line)
  assert.equal(parsed.id, envelope.id)
  assert.equal(parsed.type, envelope.type)
  assert.equal(parsed.payload.message, envelope.payload.message)
})

test("parseEnvelopeLine 拒绝多行输入，显式约束 NDJSON 单行一帧", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)

  assert.throws(
    () => protocol.parseEnvelopeLine('{"id":"1","type":"ping","payload":{}}\n{"id":"2","type":"ping","payload":{}}\n'),
    /invalid message/i,
  )
})

test("envelope 固定字段：必须含 id/type/payload，可选 instanceID/sessionToken", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)

  const parsed = protocol.parseEnvelopeLine(
    protocol.serializeEnvelope({
      id: "msg-1",
      type: "registerInstance",
      payload: { hello: "world" },
    }),
  )
  assert.equal(parsed.id, "msg-1")
  assert.equal(parsed.type, "registerInstance")
  assert.deepEqual(parsed.payload, { hello: "world" })

  assert.throws(
    () => protocol.parseEnvelopeLine('{"type":"ping","payload":{}}\n'),
    /invalid message/i,
  )
  assert.throws(
    () => protocol.parseEnvelopeLine('{"id":"x","payload":{}}\n'),
    /invalid message/i,
  )
  assert.throws(
    () => protocol.parseEnvelopeLine('{"id":"x","type":"ping"}\n'),
    /invalid message/i,
  )
})

test("error payload 固定字段与 code 集合覆盖", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const codes = ["unauthorized", "invalidMessage", "notImplemented", "brokerUnavailable"]

  for (const code of codes) {
    const envelope = protocol.createErrorEnvelope(code, "boom", "req-err")
    assert.equal(envelope.type, "error")
    assert.equal(envelope.payload.code, code)
    assert.equal(envelope.payload.message, "boom")
    assert.equal(envelope.payload.requestId, "req-err")
  }
})

test("registerInstance/ping 免鉴权，heartbeat 与 future message 需要 token", async () => {
  const auth = await import(DIST_AUTH_MODULE)
  assert.equal(auth.isAuthRequired("registerInstance"), false)
  assert.equal(auth.isAuthRequired("ping"), false)
  assert.equal(auth.isAuthRequired("heartbeat"), true)
  assert.equal(auth.isAuthRequired("registerAck"), true)
  assert.equal(auth.isAuthRequired("error"), true)

  for (const type of FUTURE_TYPES) {
    assert.equal(auth.isAuthRequired(type), true)
  }

  assert.equal(auth.isAuthRequired("__unknown_future_type__"), true)
})

test("future message: 未注册或未带 token 返回 unauthorized", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const auth = await import(DIST_AUTH_MODULE)
  const request = {
    id: "f-1",
    type: "collectStatus",
    instanceID: "instance-a",
    payload: {},
  }

  const withoutRegistration = handleFutureMessage({ protocol, auth, request })
  assert.equal(withoutRegistration.type, "error")
  assert.equal(withoutRegistration.payload.code, "unauthorized")

  auth.registerConnection("instance-a", { channel: "memory" })
  const withoutToken = handleFutureMessage({ protocol, auth, request })
  assert.equal(withoutToken.type, "error")
  assert.equal(withoutToken.payload.code, "unauthorized")
})

test("future message: 鉴权通过后返回 notImplemented", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const auth = await import(DIST_AUTH_MODULE)
  const instanceID = "instance-b"
  const sessionToken = auth.registerConnection(instanceID, { channel: "memory" })

  const response = handleFutureMessage({
    protocol,
    auth,
    request: {
      id: "f-2",
      type: "replyQuestion",
      instanceID,
      sessionToken,
      payload: { answer: "yes" },
    },
  })

  assert.equal(response.type, "error")
  assert.equal(response.payload.code, "notImplemented")
  assert.equal(response.payload.requestId, "f-2")
})

test("broker 重启后旧 token 默认失效（fresh module state）", async () => {
  const authA = await import(DIST_AUTH_MODULE)
  const instanceID = "instance-restart"
  const token = authA.registerConnection(instanceID, { channel: "memory" })
  assert.equal(authA.validateSessionToken(instanceID, token), true)

  const authB = await import(`${DIST_AUTH_MODULE}?reload=${Date.now()}`)
  assert.equal(authB.validateSessionToken(instanceID, token), false)
})

test("broker-entry 写出 broker.json，ping 返回 pong，退出清理 broker.json", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-lifecycle-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    const brokerMetadata = await waitForBrokerMetadata(brokerJsonPath)
    const keys = Object.keys(brokerMetadata).sort()
    assert.deepEqual(keys, ["endpoint", "pid", "startedAt", "version"])
    assert.equal(typeof brokerMetadata.pid, "number")
    assert.equal(typeof brokerMetadata.endpoint, "string")
    assert.equal(typeof brokerMetadata.startedAt, "number")
    assert.equal(typeof brokerMetadata.version, "string")
    assert.equal(brokerMetadata.endpoint, endpoint)
    assert.equal(brokerMetadata.pid, child.pid)

    const pingResponse = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({ id: "ping-1", type: "ping", payload: {} }),
    )
    assert.equal(pingResponse.type, "pong")
    assert.equal(pingResponse.payload.message, "pong")

    if (process.platform === "win32") {
      await access(brokerMetadata.endpoint)
    } else {
      const endpointStat = await stat(brokerMetadata.endpoint)
      assert.equal(endpointStat.mode & 0o777, 0o600)
    }
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }

  await waitForFileRemoved(brokerJsonPath)
})

test("broker 退出只清理自己写出的 broker.json，不删除后继 broker 文件", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-ownership-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  const firstMetadata = await waitForBrokerMetadata(brokerJsonPath)
  const replacedMetadata = {
    pid: firstMetadata.pid + 10000,
    endpoint: firstMetadata.endpoint,
    startedAt: firstMetadata.startedAt + 10000,
    version: "shadow-broker",
  }

  await writeFile(brokerJsonPath, JSON.stringify(replacedMetadata, null, 2), "utf8")

  try {
    await terminateChild(child)
    childProcesses.delete(child)

    const remaining = JSON.parse(await readFile(brokerJsonPath, "utf8"))
    assert.deepEqual(remaining, replacedMetadata)
  } finally {
    childProcesses.delete(child)
    await rm(brokerJsonPath, { force: true })
  }
})

test("detached + stdio ignore 启动后 broker 持续存活并可 ping", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-detached-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnDetachedBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    const brokerMetadata = await waitForBrokerMetadata(brokerJsonPath)
    assert.equal(isProcessAlive(brokerMetadata.pid), true)

    await delay(300)
    assert.equal(isProcessAlive(brokerMetadata.pid), true)

    const pingResponse = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({ id: "ping-detached", type: "ping", payload: {} }),
    )
    assert.equal(pingResponse.type, "pong")
    assert.equal(pingResponse.payload.message, "pong")

    await killProcessByPid(brokerMetadata.pid)
    if (process.platform !== "win32") {
      await waitForFileRemoved(brokerJsonPath)
    }
  } finally {
    if (child.pid && isProcessAlive(child.pid)) {
      await killProcessByPid(child.pid)
    }
    childProcesses.delete(child)
  }
})

test("broker-entry 空闲超时后在无实例且无 open request 时自动退出", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-idle-exit-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_IDLE_TIMEOUT_MS: "120",
      WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS: "20",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const exited = await waitForExit(child, 5_000)
    assert.equal(exited.code, 0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await terminateChild(child)
    }
    childProcesses.delete(child)
  }

  await waitForFileRemoved(brokerJsonPath, 5_000)
})

test("broker-entry 空闲超时期间若仍有 open request 则保持存活", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-idle-blocked-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const requestDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "requests", "question")
  const openRouteKey = "question-idle-open"
  await rm(requestDir, { recursive: true, force: true })
  await mkdirSync(requestDir, { recursive: true })
  await writeFile(
    path.join(requestDir, `${openRouteKey}.json`),
    JSON.stringify({
      kind: "question",
      requestID: "q-idle-open-1",
      routeKey: openRouteKey,
      handle: "qidle1",
      scopeKey: "instance-idle-open",
      wechatAccountId: "wx-idle-open",
      userId: "u-idle-open",
      status: "open",
      createdAt: Date.now() - 1_000,
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_IDLE_TIMEOUT_MS: "120",
      WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS: "20",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    await assertProcessStaysAlive(child.pid, 400)
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker-entry 空闲计时期间若实例重新注册则取消退出，断开后重新进入空闲并最终退出", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-idle-cancel-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const idleTimeoutMs = 180
  const idleScanIntervalMs = 20
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS: String(idleScanIntervalMs),
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    await delay(80)

    const conn = await createPersistentConnection(endpoint)
    const registerAck = await conn.send({
      id: "register-idle-cancel",
      type: "registerInstance",
      instanceID: "instance-idle-cancel",
      payload: {
        pid: 9001,
        displayName: "Idle Cancel",
        projectDir: "/tmp/idle-cancel",
      },
    })
    assert.equal(registerAck.type, "registerAck")

    await assertProcessStaysAlive(child.pid, 220)

    await conn.close()
    const exited = await waitForExit(child, 5_000)
    assert.equal(exited.code, 0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await terminateChild(child)
    }
    childProcesses.delete(child)
  }

  await waitForFileRemoved(brokerJsonPath, 5_000)
})

test("broker-entry 启动时会立刻把过期 connected snapshot 标记为 stale", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-startup-stale-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const instanceDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "instances")
  const instancePath = path.join(instanceDir, "startup-stale-a.json")
  const diagnosticsPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "wechat-broker.diagnostics.jsonl")
  const now = Date.now()

  await rm(instanceDir, { recursive: true, force: true })
  mkdirSync(instanceDir, { recursive: true })
  await writeFile(
    instancePath,
    JSON.stringify({
      instanceID: "startup-stale-a",
      pid: 7788,
      displayName: "Startup Stale",
      projectDir: "/tmp/startup-stale",
      connectedAt: now - 1_000,
      lastHeartbeatAt: now - 1_000,
      status: "connected",
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS: "80",
      WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS: "5000",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const staleSnapshot = await waitForInstanceSnapshot(instancePath, (snapshot) => snapshot.status === "stale", 5_000)
    assert.equal(staleSnapshot.status, "stale")
    assert.equal(typeof staleSnapshot.staleSince, "number")

    const diagnosticsRaw = await waitForFileText(
      diagnosticsPath,
      (text) => text.includes('"type":"instanceStale"') && text.includes('"instanceID":"startup-stale-a"'),
      5_000,
    )
    assert.match(diagnosticsRaw, /"code":"instanceStale"/)
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker-entry 启动时会立刻 purge 过期 cleaned request", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-startup-purge-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const requestDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "requests", "question")
  const diagnosticsPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "wechat-broker.diagnostics.jsonl")
  const routeKey = "startup-cleaned-old"
  const now = Date.now()

  await rm(requestDir, { recursive: true, force: true })
  mkdirSync(requestDir, { recursive: true })
  await writeFile(
    path.join(requestDir, `${routeKey}.json`),
    JSON.stringify({
      kind: "question",
      requestID: "q-startup-cleaned-old",
      routeKey,
      handle: "qstartup1",
      scopeKey: "startup-cleanup",
      wechatAccountId: "wx-startup-cleanup",
      userId: "u-startup-cleanup",
      status: "cleaned",
      createdAt: now - 10_000,
      answeredAt: now - 9_000,
      cleanedAt: now - 8_000,
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_REQUEST_PURGE_RETENTION_MS: "100",
      WECHAT_BROKER_REQUEST_CLEANUP_SCAN_INTERVAL_MS: "5000",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    await waitForFileRemoved(path.join(requestDir, `${routeKey}.json`), 5_000)
    const diagnosticsRaw = await waitForFileText(
      diagnosticsPath,
      (text) => text.includes('"type":"requestPurged"') && text.includes(`"routeKey":"${routeKey}"`),
      5_000,
    )
    assert.match(diagnosticsRaw, /"code":"requestPurged"/)
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker 启动时会立刻 purge 超期 dead-letter", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-dead-letter-startup-purge-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const deadLetterDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "dead-letter", "question")
  const deadLetterPath = path.join(deadLetterDir, "question-dead-letter-old.json")
  const diagnosticsPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "wechat-broker.diagnostics.jsonl")

  await mkdirSync(deadLetterDir, { recursive: true })
  await writeFile(
    deadLetterPath,
    JSON.stringify({
      kind: "question",
      routeKey: "question-dead-letter-old",
      requestID: "q-dead-letter-old",
      handle: "qdeadold",
      finalStatus: "expired",
      reason: "startupCleanup",
      createdAt: Date.now() - 10_000,
      finalizedAt: Date.now() - 10_000,
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_DEAD_LETTER_RETENTION_MS: "100",
      WECHAT_BROKER_DEAD_LETTER_SCAN_INTERVAL_MS: "5000",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    await waitForFileRemoved(deadLetterPath, 1_500)

    const diagnosticsRaw = await waitForFileText(
      diagnosticsPath,
      (text) => text.includes('"type":"deadLetterPurged"'),
      1_500,
    )
    assert.match(diagnosticsRaw, /"code":"deadLetterPurged"/)
    assert.match(diagnosticsRaw, /"routeKey":"question-dead-letter-old"/)
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("dead-letter 不参与 idle 判定", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-dead-letter-idle-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const deadLetterDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "dead-letter", "question")

  await mkdirSync(deadLetterDir, { recursive: true })
  await writeFile(
    path.join(deadLetterDir, "question-dead-letter-idle.json"),
    JSON.stringify({
      kind: "question",
      routeKey: "question-dead-letter-idle",
      requestID: "q-dead-letter-idle",
      handle: "qdeadidle",
      finalStatus: "expired",
      reason: "runtimeCleanup",
      createdAt: Date.now() - 5_000,
      finalizedAt: Date.now() - 4_000,
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_IDLE_TIMEOUT_MS: "120",
      WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS: "20",
      WECHAT_BROKER_DEAD_LETTER_RETENTION_MS: "999999",
      WECHAT_BROKER_DEAD_LETTER_SCAN_INTERVAL_MS: "5000",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const exited = await waitForExit(child, 2_000)
    assert.equal(exited.code, 0)
    await waitForFileRemoved(brokerJsonPath, 2_000)
  } finally {
    if (child.exitCode === null) {
      await terminateChild(child)
    }
    childProcesses.delete(child)
  }
})

test("broker future message 错误优先级: invalidMessage -> unauthorized -> notImplemented，heartbeat 校验 token", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-priority-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)

    const invalidResponse = await sendFrameAndReadResponse(endpoint, "not-json\n")
    assert.equal(invalidResponse.type, "error")
    assert.equal(invalidResponse.payload.code, "invalidMessage")

    const unauthorizedFuture = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "future-unauthorized",
        type: "collectStatus",
        instanceID: "instance-priority",
        payload: {},
      }),
    )
    assert.equal(unauthorizedFuture.type, "error")
    assert.equal(unauthorizedFuture.payload.code, "unauthorized")

    const registerAck = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "register-1",
        type: "registerInstance",
        instanceID: "instance-priority",
        payload: {},
      }),
    )
    assert.equal(registerAck.type, "registerAck")
    assert.equal(typeof registerAck.payload.sessionToken, "string")
    assert.equal(registerAck.payload.sessionToken.length > 0, true)

    const notImplemented = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "future-implemented-check",
        type: "replyQuestion",
        instanceID: "instance-priority",
        sessionToken: registerAck.payload.sessionToken,
        payload: { answer: "ok" },
      }),
    )
    assert.equal(notImplemented.type, "error")
    assert.equal(notImplemented.payload.code, "notImplemented")

    const heartbeatUnauthorized = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "heartbeat-unauthorized",
        type: "heartbeat",
        instanceID: "instance-priority",
        sessionToken: "wrong-token",
        payload: {},
      }),
    )
    assert.equal(heartbeatUnauthorized.type, "error")
    assert.equal(heartbeatUnauthorized.payload.code, "unauthorized")
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("两个 launcher 并发时只会有一个 broker 被真正拉起，且 launch.lock 包含 pid/acquiredAt", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-race-"))
  const stateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const brokerJsonPath = path.join(stateRoot, "broker.json")
  const launchLockPath = path.join(stateRoot, "launch.lock")
  const endpoint = createBrokerEndpoint(sandboxConfigHome)

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })

  let spawned = 0
  let metadata = null
  let customLockSeen = null
  let lockSnapshot = null

  const spawnImpl = () => {
    spawned += 1
    lockSnapshot = JSON.parse(readFileSync(launchLockPath, "utf8"))
    const created = {
      pid: 45000 + spawned,
      endpoint,
      startedAt: Date.now(),
      version: "test",
    }
    metadata = created
    void writeFile(brokerJsonPath, JSON.stringify(created, null, 2), "utf8")
    return {
      pid: created.pid,
      unref() {},
    }
  }

  const pingImpl = async (candidateEndpoint) => {
    if (!metadata) {
      return false
    }
    return candidateEndpoint === metadata.endpoint
  }

  const options = {
    stateRoot,
    brokerJsonPath,
    launchLockPath,
    expectedVersion: "test",
    backoffMs: 20,
    maxAttempts: 30,
    endpointFactory: () => endpoint,
    spawnImpl,
    pingImpl,
    onLockAcquired: () => {},
  }

  const [first, second] = await Promise.all([
    launcher.connectOrSpawnBroker(options),
    launcher.connectOrSpawnBroker(options),
  ])

  assert.equal(spawned, 1)
  assert.equal(first.endpoint, endpoint)
  assert.equal(second.endpoint, endpoint)
  assert.equal(first.pid, second.pid)

  const lockOnDisk = lockSnapshot
  assert.equal(typeof lockOnDisk.pid, "number")
  assert.equal(typeof lockOnDisk.acquiredAt, "number")
})

test("锁持有者消失后，后续 launcher 可重新竞争并完成 spawn", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-stale-lock-"))
  const stateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const brokerJsonPath = path.join(stateRoot, "broker.json")
  const launchLockPath = path.join(stateRoot, "launch.lock")
  const diagnosticsPath = path.join(stateRoot, "wechat-broker.diagnostics.jsonl")
  const endpoint = createBrokerEndpoint(sandboxConfigHome)

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })

  await writeFile(
    launchLockPath,
    JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 10000, lockId: "stale-lock" }, null, 2),
    "utf8",
  )

  let spawned = 0
  let metadata = null
  const spawnImpl = () => {
    spawned += 1
    const created = {
      pid: 46000,
      endpoint,
      startedAt: Date.now(),
      version: "test",
    }
    metadata = created
    void writeFile(brokerJsonPath, JSON.stringify(created, null, 2), "utf8")
    return {
      pid: created.pid,
      unref() {},
    }
  }

  const result = await launcher.connectOrSpawnBroker({
    stateRoot,
    brokerJsonPath,
    launchLockPath,
    expectedVersion: "test",
    backoffMs: 20,
    maxAttempts: 30,
    endpointFactory: () => endpoint,
    spawnImpl,
    pingImpl: async () => metadata !== null,
  })

  assert.equal(spawned, 1)
  assert.equal(result.endpoint, endpoint)

  const diagnosticsRaw = await waitForFileText(
    diagnosticsPath,
    (text) => text.includes('"type":"brokerTakeover"') && text.includes('"reason":"staleLock"'),
    5_000,
  )
  assert.match(diagnosticsRaw, /"code":"brokerTakeover"/)
  assert.match(diagnosticsRaw, /"previousPid":99999999/)
})

test("launcher 仅传入自定义 stateRoot 时，默认 broker/lock 路径与目录 ensure 都应基于该 root", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-custom-root-"))
  const customStateRoot = path.join(sandboxConfigHome, "custom", "wechat")
  const customBrokerJsonPath = path.join(customStateRoot, "broker.json")
  const customLaunchLockPath = path.join(customStateRoot, "launch.lock")
  const endpoint = createBrokerEndpoint(sandboxConfigHome)

  mkdirSync(customStateRoot, { recursive: true, mode: 0o700 })

  let spawned = 0
  let metadata = null
  let customLockSeen = null

  const result = await launcher.connectOrSpawnBroker({
    stateRoot: customStateRoot,
    expectedVersion: "test",
    backoffMs: 10,
    maxAttempts: 10,
    endpointFactory: () => endpoint,
    spawnImpl: () => {
      spawned += 1
      metadata = {
        pid: 47000,
        endpoint,
        startedAt: Date.now(),
        version: "test",
      }
      void writeFile(customBrokerJsonPath, JSON.stringify(metadata, null, 2), "utf8")
      return { pid: metadata.pid, unref() {} }
    },
    pingImpl: async (candidateEndpoint) => metadata !== null && candidateEndpoint === metadata.endpoint,
    onLockAcquired: () => {
      customLockSeen = JSON.parse(readFileSync(customLaunchLockPath, "utf8"))
    },
  })

  assert.equal(spawned, 1)
  assert.equal(result.endpoint, endpoint)
  assert.equal(typeof customLockSeen?.pid, "number")
  assert.equal(typeof customLockSeen?.acquiredAt, "number")
})

test("launcher 遇到版本落后的 broker 会先退役旧进程再拉起当前版本 broker", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-version-mismatch-"))
  const stateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const brokerJsonPath = path.join(stateRoot, "broker.json")
  const diagnosticsPath = path.join(stateRoot, "wechat-broker.diagnostics.jsonl")
  const oldEndpoint = createBrokerEndpoint(sandboxConfigHome)
  const newEndpoint = createBrokerEndpoint(sandboxConfigHome)

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  await writeFile(
    brokerJsonPath,
    JSON.stringify({ pid: 48000, endpoint: oldEndpoint, startedAt: Date.now() - 1000, version: "0.13.6" }, null, 2),
    "utf8",
  )

  let spawned = 0
  const retired = []
  let metadata = {
    pid: 48000,
    endpoint: oldEndpoint,
    startedAt: Date.now() - 1000,
    version: "0.13.6",
  }

  const result = await launcher.connectOrSpawnBroker({
    stateRoot,
    brokerJsonPath,
    expectedVersion: "0.14.9",
    backoffMs: 10,
    maxAttempts: 10,
    endpointFactory: () => newEndpoint,
    pingImpl: async (candidateEndpoint) => candidateEndpoint === metadata.endpoint,
    spawnImpl: () => {
      spawned += 1
      metadata = {
        pid: 49000,
        endpoint: newEndpoint,
        startedAt: Date.now(),
        version: "0.14.9",
      }
      void writeFile(brokerJsonPath, JSON.stringify(metadata, null, 2), "utf8")
      return { pid: metadata.pid, unref() {} }
    },
    retireBrokerImpl: async (candidate) => {
      retired.push(candidate)
    },
  })

  assert.equal(retired.length, 1)
  assert.equal(retired[0]?.pid, 48000)
  assert.equal(retired[0]?.version, "0.13.6")
  assert.equal(spawned, 1)
  assert.equal(result.endpoint, newEndpoint)
  assert.equal(result.version, "0.14.9")

  const diagnosticsRaw = await waitForFileText(
    diagnosticsPath,
    (text) => text.includes('"type":"brokerTakeover"'),
    5_000,
  )
  assert.match(diagnosticsRaw, /"code":"brokerTakeover"/)
  assert.match(diagnosticsRaw, /"reason":"versionMismatch"/)
  assert.match(diagnosticsRaw, /"previousVersion":"0.13.6"/)
  assert.match(diagnosticsRaw, /"nextVersion":"0.14.9"/)
})

test("launcher 遇到同 minor 下更高补丁版本 broker 时直接复用，不回退接管", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-higher-patch-"))
  const stateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const brokerJsonPath = path.join(stateRoot, "broker.json")
  const diagnosticsPath = path.join(stateRoot, "wechat-broker.diagnostics.jsonl")
  const endpoint = createBrokerEndpoint(sandboxConfigHome)

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  await writeFile(
    brokerJsonPath,
    JSON.stringify({ pid: 48001, endpoint, startedAt: Date.now() - 1000, version: "0.14.40" }, null, 2),
    "utf8",
  )

  let spawned = 0
  const retired = []

  const result = await launcher.connectOrSpawnBroker({
    stateRoot,
    brokerJsonPath,
    expectedVersion: "0.14.39",
    backoffMs: 10,
    maxAttempts: 3,
    endpointFactory: () => createBrokerEndpoint(`${sandboxConfigHome}-unused`),
    pingImpl: async (candidateEndpoint) => candidateEndpoint === endpoint,
    spawnImpl: () => {
      spawned += 1
      return { pid: 49001, unref() {} }
    },
    retireBrokerImpl: async (candidate) => {
      retired.push(candidate)
    },
  })

  assert.equal(result.endpoint, endpoint)
  assert.equal(result.version, "0.14.40")
  assert.equal(spawned, 0)
  assert.equal(retired.length, 0)

  const diagnosticsExists = await access(diagnosticsPath).then(() => true).catch(() => false)
  assert.equal(diagnosticsExists, false)
})

test("Windows Bun runtime 下默认 broker endpoint 应切到 tcp 回环地址", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)

  assert.match(
    launcher.createDefaultBrokerEndpoint({
      platform: "win32",
      execPath: "C:\\Users\\34404\\.bun\\bin\\bun.exe",
    }),
    /^tcp:\/\/127\.0\.0\.1:0$/,
  )
})

test("Windows 打包 opencode.exe runtime 下 broker launcher 应继续复用当前 execPath", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)

  assert.equal(
    launcher.resolveBrokerSpawnCommand({
      execPath: "C:\\Users\\34404\\.bun\\install\\global\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
    }),
    "C:\\Users\\34404\\.bun\\install\\global\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
  )
})

test("Windows opencode-cli.exe runtime 下 broker launcher 应继续复用当前 execPath", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)

  assert.equal(
    launcher.resolveBrokerSpawnCommand({
      execPath: "C:\\Users\\34404\\AppData\\Local\\OpenCode\\opencode-cli.exe",
    }),
    "C:\\Users\\34404\\AppData\\Local\\OpenCode\\opencode-cli.exe",
  )
})

test("broker launcher 默认派生环境应附带 BUN_BE_BUN", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const baseEnv = { HELLO: "world" }

  const env = launcher.resolveBrokerSpawnEnv(baseEnv)

  assert.equal(env.HELLO, "world")
  assert.equal(env.BUN_BE_BUN, "1")
  assert.deepEqual(baseEnv, { HELLO: "world" })
})

test("broker launcher 默认派生环境应覆盖已有的 BUN_BE_BUN", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)

  const env = launcher.resolveBrokerSpawnEnv({ BUN_BE_BUN: "0", HELLO: "world" })

  assert.equal(env.BUN_BE_BUN, "1")
  assert.equal(env.HELLO, "world")
})

test("Windows Node runtime 下默认 broker endpoint 也使用 tcp 回环地址", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)

  assert.match(
    launcher.createDefaultBrokerEndpoint({
      platform: "win32",
      execPath: "C:\\nvm4w\\nodejs\\node.exe",
    }),
    /^tcp:\/\/127\.0\.0\.1:0$/,
  )
})

test("broker-entry 支持 tcp endpoint 并把 broker.json 写成真实监听地址", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-entry-tcp-endpoint-"))
  const endpoint = "tcp://127.0.0.1:0"
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    const metadata = await waitForBrokerMetadata(brokerJsonPath)
    assert.match(String(metadata.endpoint ?? ""), /^tcp:\/\/127\.0\.0\.1:\d+$/)
    const ping = await sendFrameAndReadResponse(
      metadata.endpoint,
      `${JSON.stringify({ id: "ping-tcp-1", type: "ping", payload: {} })}\n`,
    )
    assert.equal(ping.type, "pong")
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("真实默认 spawn + 自定义 stateRoot 时，broker.json 写入自定义 root 且不触碰默认 wechat 根目录", async () => {
  const launcher = await import(`${DIST_BROKER_LAUNCHER_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-launcher-real-custom-root-"))
  const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-broker-default-root-")
  const sandboxDefaultConfigHome = isolatedWechatStateRoot.sandboxConfigHome
  const customStateRoot = path.join(sandboxConfigHome, "custom", "wechat")
  const customBrokerJsonPath = path.join(customStateRoot, "broker.json")
  const defaultWechatRoot = path.join(sandboxDefaultConfigHome, "opencode", "account-switcher", "wechat")
  const defaultBrokerJsonPath = path.join(defaultWechatRoot, "broker.json")

  delete process.env.WECHAT_STATE_ROOT_OVERRIDE

  let metadata = null
  try {
    metadata = await launcher.connectOrSpawnBroker({
      stateRoot: customStateRoot,
      backoffMs: 30,
      maxAttempts: 20,
    })

    const brokerMetadata = await waitForBrokerMetadata(customBrokerJsonPath)
    assert.equal(typeof brokerMetadata.pid, "number")
    assert.equal(typeof brokerMetadata.endpoint, "string")
    assert.equal(metadata.endpoint, brokerMetadata.endpoint)

    await assert.rejects(() => access(defaultWechatRoot), (error) => error?.code === "ENOENT")
    await assert.rejects(() => access(defaultBrokerJsonPath), (error) => error?.code === "ENOENT")
  } finally {
    const pid = metadata?.pid
    if (typeof pid === "number" && isProcessAlive(pid)) {
      await killProcessByPid(pid)
    }
    await isolatedWechatStateRoot.restore()
  }
})

test("client 可完成 registerInstance -> registerAck 往返并缓存会话字段", async () => {
  const clientModule = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-client-register-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const client = await clientModule.connect(endpoint)

    const ping = await client.ping()
    assert.equal(ping.type, "pong")

    const registerAck = await client.registerInstance({
      instanceID: "client-instance-a",
      pid: process.pid,
    })
    assert.equal(typeof registerAck.sessionToken, "string")
    assert.equal(registerAck.sessionToken.length > 0, true)
    assert.equal(typeof registerAck.registeredAt, "number")
    assert.equal(typeof registerAck.brokerPid, "number")

    const snapshot = client.getSessionSnapshot()
    assert.equal(snapshot.instanceID, "client-instance-a")
    assert.equal(snapshot.sessionToken, registerAck.sessionToken)
    assert.equal(snapshot.registeredAt, registerAck.registeredAt)
    assert.equal(snapshot.brokerPid, registerAck.brokerPid)

    await client.close()
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker-client 收到坏帧时应失败当前等待请求，而不是抛出未捕获异常", async () => {
  const clientModule = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const endpoint = createBrokerEndpoint(os.tmpdir())

  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write("not-json\n")
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  const client = await clientModule.connect(endpoint)
  try {
    await assert.rejects(() => client.ping(), /invalid message/i)
  } finally {
    await client.close()
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("同连接同 instanceID 重注册会刷新 token/registrationEpoch；新连接接管后旧 token 失效；同 pid 不同 instanceID 可共存", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-register-state-machine-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)

    const connA = await createPersistentConnection(endpoint)
    const firstAck = await connA.send({
      id: "register-A-1",
      type: "registerInstance",
      instanceID: "instance-shared",
      payload: { pid: 12345 },
    })
    const secondAck = await connA.send({
      id: "register-A-2",
      type: "registerInstance",
      instanceID: "instance-shared",
      payload: { pid: 12345 },
    })

     assert.equal(firstAck.type, "registerAck")
     assert.equal(secondAck.type, "registerAck")
     assert.notEqual(firstAck.payload.sessionToken, secondAck.payload.sessionToken)
     assert.notEqual(firstAck.payload.registrationEpoch, secondAck.payload.registrationEpoch)
     assert.equal(firstAck.payload.brokerPid, secondAck.payload.brokerPid)

    const connB = await createPersistentConnection(endpoint)
    const takeoverAck = await connB.send({
      id: "register-B-1",
      type: "registerInstance",
      instanceID: "instance-shared",
      payload: { pid: 12345 },
    })

    assert.equal(takeoverAck.type, "registerAck")
    assert.notEqual(takeoverAck.payload.sessionToken, firstAck.payload.sessionToken)

    const oldHeartbeat = await connA.send({
      id: "heartbeat-old-token",
      type: "heartbeat",
      instanceID: "instance-shared",
      sessionToken: firstAck.payload.sessionToken,
      payload: {},
    })
    assert.equal(oldHeartbeat.type, "error")
    assert.equal(oldHeartbeat.payload.code, "unauthorized")

    const newHeartbeat = await connB.send({
      id: "heartbeat-new-token",
      type: "heartbeat",
      instanceID: "instance-shared",
      sessionToken: takeoverAck.payload.sessionToken,
      payload: {},
    })
    assert.equal(newHeartbeat.type, "pong")

    const connC = await createPersistentConnection(endpoint)
    const instanceOneAck = await connC.send({
      id: "register-instance-1",
      type: "registerInstance",
      instanceID: "instance-1",
      payload: { pid: 7777 },
    })
    const instanceTwoAck = await connC.send({
      id: "register-instance-2",
      type: "registerInstance",
      instanceID: "instance-2",
      payload: { pid: 7777 },
    })

    assert.equal(instanceOneAck.type, "registerAck")
    assert.equal(instanceTwoAck.type, "registerAck")
    assert.notEqual(instanceOneAck.payload.sessionToken, instanceTwoAck.payload.sessionToken)

    const heartbeatOne = await connC.send({
      id: "heartbeat-instance-1",
      type: "heartbeat",
      instanceID: "instance-1",
      sessionToken: instanceOneAck.payload.sessionToken,
      payload: {},
    })
    const heartbeatTwo = await connC.send({
      id: "heartbeat-instance-2",
      type: "heartbeat",
      instanceID: "instance-2",
      sessionToken: instanceTwoAck.payload.sessionToken,
      payload: {},
    })
    assert.equal(heartbeatOne.type, "pong")
    assert.equal(heartbeatTwo.type, "pong")

    await Promise.all([connA.close(), connB.close(), connC.close()])
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("instances 快照：注册即落盘，超时标记 stale，后续 heartbeat 可恢复 connected", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-instance-heartbeat-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const instancePath = path.join(
    sandboxConfigHome,
    "opencode",
    "account-switcher",
    "wechat",
    "instances",
    "instance-heartbeat-a.json",
  )
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS: "120",
      WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS: "30",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const conn = await createPersistentConnection(endpoint)

    const registerAck = await conn.send({
      id: "register-heartbeat-a",
      type: "registerInstance",
      instanceID: "instance-heartbeat-a",
      payload: {
        pid: 7788,
        displayName: "WeChat QA",
        projectDir: "/tmp/wechat-qa",
      },
    })
    assert.equal(registerAck.type, "registerAck")

    const connectedSnapshot = await waitForInstanceSnapshot(instancePath, (snapshot) => snapshot.status === "connected")
    assert.deepEqual(Object.keys(connectedSnapshot).sort(), [
      "connectedAt",
      "displayName",
      "instanceID",
      "lastHeartbeatAt",
      "pid",
      "projectDir",
      "status",
    ])
    assert.equal(connectedSnapshot.instanceID, "instance-heartbeat-a")
    assert.equal(connectedSnapshot.pid, 7788)
    assert.equal(connectedSnapshot.displayName, "WeChat QA")
    assert.equal(connectedSnapshot.projectDir, "/tmp/wechat-qa")
    assert.equal(typeof connectedSnapshot.connectedAt, "number")
    assert.equal(typeof connectedSnapshot.lastHeartbeatAt, "number")
    assert.equal(connectedSnapshot.status, "connected")
    assert.equal("staleSince" in connectedSnapshot, false)

    const staleSnapshot = await waitForInstanceSnapshot(instancePath, (snapshot) => snapshot.status === "stale")
    assert.equal(staleSnapshot.status, "stale")
    assert.equal(typeof staleSnapshot.staleSince, "number")

    const heartbeatResponse = await conn.send({
      id: "heartbeat-after-stale",
      type: "heartbeat",
      instanceID: "instance-heartbeat-a",
      sessionToken: registerAck.payload.sessionToken,
      payload: {},
    })
    assert.equal(heartbeatResponse.type, "pong")

    const recoveredSnapshot = await waitForInstanceSnapshot(
      instancePath,
      (snapshot) => snapshot.status === "connected" && !("staleSince" in snapshot),
    )
    assert.equal(recoveredSnapshot.status, "connected")
    assert.equal("staleSince" in recoveredSnapshot, false)
    assert.equal(recoveredSnapshot.lastHeartbeatAt >= staleSnapshot.lastHeartbeatAt, true)

    await conn.close()
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("stale instance 会把同 scopeKey 的 open request 标记为 expired", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}`)

  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-stale-request-expire-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const requestDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "requests", "question")
  const deadLetterDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "dead-letter", "question")
  const diagnosticsPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "wechat-broker.diagnostics.jsonl")
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS: "200",
      WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS: "50",
    },
  })

  try {
    const handleValue = `q${Date.now()}`
    const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-stale-expire-1", scopeKey: "instance-stale-expire" })

    await mkdirSync(requestDir, { recursive: true })
    await writeFile(
      path.join(requestDir, `${routeKey}.json`),
      JSON.stringify({
        kind: "question",
        requestID: "q-stale-expire-1",
        routeKey,
        handle: handleValue,
        scopeKey: "instance-stale-expire",
        wechatAccountId: "wx-stale-expire",
        userId: "u-stale-expire",
        status: "open",
        createdAt: Date.now(),
      }, null, 2),
      "utf8",
    )

    await waitForBrokerMetadata(brokerJsonPath)

    const client = await brokerClient.connect(endpoint)
    await client.registerInstance({ instanceID: "instance-stale-expire", pid: process.pid })

    await waitForInstanceSnapshot(
      path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "instances", "instance-stale-expire.json"),
      (snapshot) => snapshot?.status === "stale",
      5_000,
    )

    const expired = await waitForJsonFile(
      path.join(requestDir, `${routeKey}.json`),
      (record) => record?.status === "expired",
      5_000,
    )

    assert.equal(expired.status, "expired")
    assert.equal(typeof expired.expiredAt, "number")

    const deadLetter = await waitForJsonFile(
      path.join(deadLetterDir, `${routeKey}.json`),
      (record) => record?.reason === "instanceStale",
      5_000,
    )
    assert.equal(deadLetter.routeKey, routeKey)
    assert.equal(deadLetter.finalStatus, "expired")
    assert.equal(deadLetter.reason, "instanceStale")

  const diagnosticsRaw = await waitForFileText(
    diagnosticsPath,
    (text) => text.includes('"type":"instanceStale"') && text.includes('"type":"requestExpired"') && text.includes('"type":"deadLetterWritten"'),
    5_000,
  )
    assert.match(diagnosticsRaw, /"code":"instanceStale"/)
    assert.match(diagnosticsRaw, /"code":"requestExpired"/)
    assert.match(diagnosticsRaw, /"code":"deadLetterWritten"/)
  assert.match(diagnosticsRaw, /"type":"instanceStale"/)
    assert.match(diagnosticsRaw, /"instanceID":"instance-stale-expire"/)
    assert.match(diagnosticsRaw, /"routeKey":"question-/)

    await client.close()
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("terminal request 会被自动 cleaned，并在保留期后 purge", async () => {
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-request-cleanup-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const requestDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "requests", "question")
  const deadLetterDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "dead-letter", "question")
  const diagnosticsPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "wechat-broker.diagnostics.jsonl")
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_REQUEST_CLEAN_AFTER_MS: "50",
      WECHAT_BROKER_REQUEST_PURGE_RETENTION_MS: "1000",
      WECHAT_BROKER_REQUEST_CLEANUP_SCAN_INTERVAL_MS: "20",
    },
  })

  try {
    await mkdirSync(requestDir, { recursive: true })

    const now = Date.now()
    const answeredRouteKey = "question-clean-target"
    const oldCleanedRouteKey = "question-cleaned-old"

    await writeFile(
      path.join(requestDir, `${answeredRouteKey}.json`),
      JSON.stringify({
        kind: "question",
        requestID: "q-clean-target",
        routeKey: answeredRouteKey,
        handle: "qclean1",
        scopeKey: "instance-cleanup",
        wechatAccountId: "wx-cleanup",
        userId: "u-cleanup",
        status: "answered",
        createdAt: now - 1_000,
        answeredAt: now - 500,
      }, null, 2),
      "utf8",
    )

    await writeFile(
      path.join(requestDir, `${oldCleanedRouteKey}.json`),
      JSON.stringify({
        kind: "question",
        requestID: "q-cleaned-old",
        routeKey: oldCleanedRouteKey,
        handle: "qclean2",
        scopeKey: "instance-cleanup",
        wechatAccountId: "wx-cleanup",
        userId: "u-cleanup",
        status: "cleaned",
        createdAt: now - 5_000,
        answeredAt: now - 4_000,
        cleanedAt: now - 2_000,
      }, null, 2),
      "utf8",
    )

    await waitForBrokerMetadata(brokerJsonPath)

    const cleaned = await waitForJsonFile(
      path.join(requestDir, `${answeredRouteKey}.json`),
      (record) => record?.status === "cleaned",
      5_000,
    )
    assert.equal(cleaned.status, "cleaned")
    assert.equal(typeof cleaned.cleanedAt, "number")

    await waitForFileRemoved(path.join(requestDir, `${oldCleanedRouteKey}.json`), 5_000)

    const diagnosticsRaw = await waitForFileText(
      diagnosticsPath,
      (text) => text.includes('"type":"requestCleaned"') && text.includes('"type":"requestPurged"'),
      5_000,
    )
    assert.match(diagnosticsRaw, /"code":"requestCleaned"/)
    assert.match(diagnosticsRaw, /"code":"requestPurged"/)
    assert.match(diagnosticsRaw, /"routeKey":"question-clean-target"/)
    assert.match(diagnosticsRaw, /"type":"requestPurged"/)
    assert.match(diagnosticsRaw, /"routeKey":"question-cleaned-old"/)
    await assert.rejects(() => readFile(path.join(deadLetterDir, `${answeredRouteKey}.json`), "utf8"), /ENOENT|no such file/i)
    await assert.rejects(() => readFile(path.join(deadLetterDir, `${oldCleanedRouteKey}.json`), "utf8"), /ENOENT|no such file/i)
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker 默认 heartbeat timeout 常量固定为 30000ms", async () => {
  const brokerServer = await import(DIST_BROKER_SERVER_MODULE)
  assert.equal(brokerServer.DEFAULT_HEARTBEAT_TIMEOUT_MS, 30_000)
})

test("instances 目录不可写时，registerInstance 不可静默成功", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-instance-persist-error-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const instancesPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "instances")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    await rm(instancesPath, { recursive: true, force: true })
    await writeFile(instancesPath, "not-a-directory", "utf8")

    const response = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "register-persist-error",
        type: "registerInstance",
        instanceID: "persist-error-a",
        payload: { pid: 8899, displayName: "Broken", projectDir: "/tmp/broken" },
      }),
    )

    assert.equal(response.type, "error")
    assert.equal(response.payload.code, "brokerUnavailable")
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("stale 恢复时 heartbeat 返回后，磁盘快照应已是 connected（避免旧写回滚）", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-instance-ordering-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const instancePath = path.join(
    sandboxConfigHome,
    "opencode",
    "account-switcher",
    "wechat",
    "instances",
    "instance-ordering-a.json",
  )
  const child = spawnBrokerEntry({
    endpoint,
    xdgConfigHome: sandboxConfigHome,
    extraEnv: {
      WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS: "80",
      WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS: "20",
    },
  })

  try {
    await waitForBrokerMetadata(brokerJsonPath)
    const conn = await createPersistentConnection(endpoint)

    const heavyDisplayName = "D".repeat(1024 * 512)
    const registerAck = await conn.send({
      id: "register-ordering-a",
      type: "registerInstance",
      instanceID: "instance-ordering-a",
      payload: {
        pid: 7878,
        displayName: heavyDisplayName,
        projectDir: "/tmp/ordering",
      },
    })
    assert.equal(registerAck.type, "registerAck")

    await waitForInstanceSnapshot(instancePath, (snapshot) => snapshot.status === "stale")

    const heartbeatResponse = await conn.send({
      id: "heartbeat-ordering-a",
      type: "heartbeat",
      instanceID: "instance-ordering-a",
      sessionToken: registerAck.payload.sessionToken,
      payload: {},
    })
    assert.equal(heartbeatResponse.type, "pong")

    const immediateDiskSnapshot = JSON.parse(await readFile(instancePath, "utf8"))
    assert.equal(immediateDiskSnapshot.status, "connected")
    assert.equal("staleSince" in immediateDiskSnapshot, false)

    const diagnosticsPath = path.join(
      sandboxConfigHome,
      "opencode",
      "account-switcher",
      "wechat",
      "wechat-broker.diagnostics.jsonl",
    )
    const diagnosticsRaw = await waitForFileText(
      diagnosticsPath,
      (text) => text.includes('"type":"instanceRecovered"'),
      5_000,
    )
    assert.match(diagnosticsRaw, /"code":"instanceRecovered"/)
    assert.match(diagnosticsRaw, /"instanceID":"instance-ordering-a"/)
    assert.match(diagnosticsRaw, /"type":"instanceRecovered"/)

    await conn.close()
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("非法 instanceID 注册应被拒绝，且不会写出越界快照文件", async () => {
  const protocol = await import(DIST_PROTOCOL_MODULE)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-instance-path-safety-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)

    const response = await sendFrameAndReadResponse(
      endpoint,
      protocol.serializeEnvelope({
        id: "register-invalid-instanceid",
        type: "registerInstance",
        instanceID: "../escape-out",
        payload: { pid: 5566, displayName: "Invalid", projectDir: "/tmp/invalid" },
      }),
    )
    assert.equal(response.type, "error")
    assert.equal(response.payload.code, "invalidMessage")

    const escapedPath = path.resolve(
      sandboxConfigHome,
      "opencode",
      "account-switcher",
      "wechat",
      "instances",
      "../escape-out.json",
    )
    await assert.rejects(() => access(escapedPath), (error) => error?.code === "ENOENT")
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker 通知合并：短窗口内重复 question 候选只保留一个待发送通知", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-notification-merge-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const wechatStateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const operatorPath = path.join(wechatStateRoot, "operator.json")
  const notificationsDir = path.join(wechatStateRoot, "notifications")

  mkdirSync(path.dirname(operatorPath), { recursive: true })
  await writeFile(
    operatorPath,
    JSON.stringify({
      wechatAccountId: "wx-merge",
      userId: "u-merge",
      boundAt: Date.now(),
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)

    const client = await brokerClient.connect(endpoint, {
      bridge: {
        collectNotificationCandidates: async () => {
          const createdAt = Date.now()
          return [
            {
              idempotencyKey: "notif-merge-question-1",
              kind: "question",
              requestID: "question-merge-1",
              createdAt,
              routeKey: "question-merge-1",
              handle: "q1",
            },
            {
              idempotencyKey: "notif-merge-question-2",
              kind: "question",
              requestID: "question-merge-1",
              createdAt: createdAt + 100,
              routeKey: "question-merge-1",
              handle: "q1",
            },
          ]
        },
      },
    })

    try {
      await client.registerInstance({ instanceID: "instance-merge-question", pid: process.pid })

      await waitForNotificationRecords(
        notificationsDir,
        (fileName) => fileName.startsWith("notif-merge-question-"),
        (items) => items.length >= 1,
      )
      await delay(300)
      const records = await waitForNotificationRecords(
        notificationsDir,
        (fileName) => fileName.startsWith("notif-merge-question-"),
        () => true,
      )

      assert.equal(records.filter((record) => record.status === "pending").length, 1)
      assert.equal(new Set(records.map((record) => record.routeKey)).size, 1)
      assert.equal(new Set(records.map((record) => record.handle)).size, 1)
    } finally {
      await client.close()
    }
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})

test("broker 通知合并：重复候选不会先以 pending 进入可发送集合再被 suppress", async () => {
  const brokerServer = await import(DIST_BROKER_SERVER_MODULE)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const notificationStore = await import("../dist/wechat/notification-store.js")
  const operatorStore = await import("../dist/wechat/operator-store.js")

  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-notification-race-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const notificationsDir = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "notifications")
  const previousStateRoot = process.env.WECHAT_STATE_ROOT_OVERRIDE
  const persistedStatuses = []

  process.env.WECHAT_STATE_ROOT_OVERRIDE = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  notificationStore.setNotificationStoreTestHooks({
    afterWriteNotification: async (record) => {
      if (record.idempotencyKey.startsWith("notif-race-question-")) {
        persistedStatuses.push({ idempotencyKey: record.idempotencyKey, status: record.status })
      }
    },
  })

  const server = await brokerServer.startBrokerServer(endpoint)

  try {
    await operatorStore.rebindOperator({
      wechatAccountId: "wx-race",
      userId: "u-race",
      boundAt: Date.now(),
    })

    const client = await brokerClient.connect(server.endpoint, {
      bridge: {
        collectNotificationCandidates: async () => {
          const createdAt = Date.now()
          return [
            {
              idempotencyKey: "notif-race-question-1",
              kind: "question",
              requestID: "question-race-1",
              createdAt,
              routeKey: "question-race-1",
              handle: "q1",
            },
            {
              idempotencyKey: "notif-race-question-2",
              kind: "question",
              requestID: "question-race-1",
              createdAt: createdAt + 100,
              routeKey: "question-race-1",
              handle: "q1",
            },
          ]
        },
      },
    })

    try {
      await client.registerInstance({ instanceID: "instance-race-question", pid: process.pid })
      await waitForNotificationRecords(
        notificationsDir,
        (fileName) => fileName.startsWith("notif-race-question-"),
        (items) => items.length === 2,
      )

      assert.deepEqual(
        persistedStatuses.filter((entry) => entry.idempotencyKey === "notif-race-question-2").map((entry) => entry.status),
        ["suppressed"],
      )

      const pending = await notificationStore.listPendingNotifications()
      assert.equal(pending.filter((record) => record.idempotencyKey.startsWith("notif-race-question-")).length, 1)
    } finally {
      await client.close()
    }
  } finally {
    notificationStore.setNotificationStoreTestHooks(undefined)
    if (previousStateRoot === undefined) {
      delete process.env.WECHAT_STATE_ROOT_OVERRIDE
    } else {
      process.env.WECHAT_STATE_ROOT_OVERRIDE = previousStateRoot
    }
    await server.close()
  }
})

test("broker 通知合并不会吞掉不同 handle 的 question 通知", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-broker-notification-distinct-"))
  const endpoint = createBrokerEndpoint(sandboxConfigHome)
  const brokerJsonPath = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat", "broker.json")
  const wechatStateRoot = path.join(sandboxConfigHome, "opencode", "account-switcher", "wechat")
  const operatorPath = path.join(wechatStateRoot, "operator.json")
  const notificationsDir = path.join(wechatStateRoot, "notifications")

  mkdirSync(path.dirname(operatorPath), { recursive: true })
  await writeFile(
    operatorPath,
    JSON.stringify({
      wechatAccountId: "wx-distinct",
      userId: "u-distinct",
      boundAt: Date.now(),
    }, null, 2),
    "utf8",
  )

  const child = spawnBrokerEntry({ endpoint, xdgConfigHome: sandboxConfigHome })

  try {
    await waitForBrokerMetadata(brokerJsonPath)

    const client = await brokerClient.connect(endpoint, {
      bridge: {
        collectNotificationCandidates: async () => {
          const createdAt = Date.now()
          return [
            {
              idempotencyKey: "notif-distinct-question-1",
              kind: "question",
              requestID: "question-distinct-1",
              createdAt,
              routeKey: "question-distinct-1",
              handle: "q1",
            },
            {
              idempotencyKey: "notif-distinct-question-2",
              kind: "question",
              requestID: "question-distinct-2",
              createdAt: createdAt + 100,
              routeKey: "question-distinct-2",
              handle: "q2",
            },
          ]
        },
      },
    })

    try {
      await client.registerInstance({ instanceID: "instance-distinct-question", pid: process.pid })

      const records = await waitForNotificationRecords(
        notificationsDir,
        (fileName) => fileName.startsWith("notif-distinct-question-"),
        (items) => items.filter((item) => item.status === "pending").length === 2,
      )

      assert.equal(records.filter((record) => record.status === "pending").length, 2)
      assert.equal(new Set(records.map((record) => record.routeKey)).size, 2)
      assert.equal(new Set(records.map((record) => record.handle)).size, 2)
    } finally {
      await client.close()
    }
  } finally {
    await terminateChild(child)
    childProcesses.delete(child)
  }
})
