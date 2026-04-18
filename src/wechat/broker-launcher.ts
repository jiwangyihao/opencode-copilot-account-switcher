import path from "node:path"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createBrokerSocket, createDefaultBrokerEndpoint } from "./broker-endpoint.js"
import { WECHAT_FILE_MODE, wechatBrokerDiagnosticsPath, wechatStateRoot } from "./state-paths.js"
import { parseEnvelopeLine, serializeEnvelope } from "./protocol.js"

type BrokerMetadata = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

type LaunchLockContent = {
  pid: number
  acquiredAt: number
  lockId: string
}

type LaunchOptions = {
  stateRoot?: string
  brokerJsonPath?: string
  launchLockPath?: string
  backoffMs?: number
  maxAttempts?: number
  expectedVersion?: string
  endpointFactory?: () => string
  spawnImpl?: (endpoint: string, stateRoot: string) => { pid?: number | undefined; unref?: (() => void) | undefined }
  retireBrokerImpl?: (metadata: BrokerMetadata) => Promise<void> | void
  pingImpl?: (endpoint: string) => Promise<boolean>
  isProcessAliveImpl?: (pid: number) => boolean
  onLockAcquired?: (lock: LaunchLockContent) => void
}

const DEFAULT_BACKOFF_MS = 250
const DEFAULT_MAX_ATTEMPTS = 20
const DEFAULT_BOOTING_BROKER_WAIT_STEP_MS = 100
const DEFAULT_BOOTING_BROKER_WAIT_STEPS = 20

type ResolveBrokerSpawnCommandOptions = {
  execPath?: string
}

type ResolveBrokerSpawnEnv = NodeJS.ProcessEnv

type AcquireLaunchLockResult = {
  lock: LaunchLockContent | null
  recoveredStaleLock?: {
    pid: number
  }
}

type WechatBrokerLauncherDiagnosticEvent = {
  type: "brokerTakeover"
  code: "brokerTakeover"
  reason: "versionMismatch" | "staleLock"
  previousPid: number
  previousVersion?: string
  nextVersion?: string
}

type CompatibleBrokerState =
  | {
      status: "ready"
      metadata: BrokerMetadata
    }
  | {
      status: "booting"
      metadata: BrokerMetadata
    }
  | {
      status: "unavailable"
    }

type WaitForBootingBrokerResult =
  | {
      status: "ready"
      metadata: BrokerMetadata
    }
  | {
      status: "replaced"
      metadata: BrokerMetadata
    }
  | {
      status: "failed"
      metadata: BrokerMetadata
    }
  | null

async function appendBrokerLauncherDiagnostic(stateRoot: string, event: WechatBrokerLauncherDiagnosticEvent) {
  try {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
    await appendFile(
      wechatBrokerDiagnosticsPath(stateRoot),
      `${JSON.stringify({ at: Date.now(), ...event })}\n`,
      { encoding: "utf8", mode: WECHAT_FILE_MODE },
    )
  } catch {
  }
}

export function resolveBrokerSpawnEnv(env: ResolveBrokerSpawnEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    BUN_BE_BUN: "1",
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

type ParsedBrokerVersion = {
  major: number
  minor: number
  patch: number
}

function parseBrokerVersion(version: string): ParsedBrokerVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function isBrokerVersionCompatible(candidateVersion: string, expectedVersion: string): boolean {
  const candidate = parseBrokerVersion(candidateVersion)
  const expected = parseBrokerVersion(expectedVersion)
  if (!candidate || !expected) {
    return candidateVersion === expectedVersion
  }

  if (candidate.major !== expected.major || candidate.minor !== expected.minor) {
    return false
  }

  return candidate.patch >= expected.patch
}

function shouldRetireBrokerForVersion(candidateVersion: string, expectedVersion: string): boolean {
  const candidate = parseBrokerVersion(candidateVersion)
  const expected = parseBrokerVersion(expectedVersion)
  if (!candidate || !expected) {
    return candidateVersion !== expectedVersion
  }

  if (candidate.major !== expected.major || candidate.minor !== expected.minor) {
    return true
  }

  return candidate.patch < expected.patch
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { createDefaultBrokerEndpoint }

export function resolveBrokerSpawnCommand(options: ResolveBrokerSpawnCommandOptions = {}): string {
  const execPath = options.execPath ?? process.execPath
  return execPath
}

async function readCurrentPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url)
    const raw = await readFile(packageJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return isNonEmptyString(parsed.version) ? parsed.version : "unknown"
  } catch {
    return "unknown"
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readBrokerMetadata(filePath: string): Promise<BrokerMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<BrokerMetadata>
    if (!isFiniteNumber(parsed.pid) || !isNonEmptyString(parsed.endpoint) || !isFiniteNumber(parsed.startedAt)) {
      return null
    }
    return {
      pid: parsed.pid,
      endpoint: parsed.endpoint,
      startedAt: parsed.startedAt,
      version: isNonEmptyString(parsed.version) ? parsed.version : "unknown",
    }
  } catch {
    return null
  }
}

async function defaultPingImpl(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createBrokerSocket(endpoint)
    let buffer = ""
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)

    socket.once("error", () => {
      clearTimeout(timer)
      resolve(false)
    })

    socket.once("connect", () => {
      socket.write(serializeEnvelope({ id: `launcher-ping-${Date.now()}`, type: "ping", payload: {} }))
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      clearTimeout(timer)
      socket.end()
      try {
        const response = parseEnvelopeLine(buffer.slice(0, newlineIndex + 1))
        resolve(response.type === "pong")
      } catch {
        resolve(false)
      }
    })
  })
}

async function readLaunchLock(filePath: string): Promise<LaunchLockContent | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<LaunchLockContent>
    if (!isFiniteNumber(parsed.pid) || !isFiniteNumber(parsed.acquiredAt) || !isNonEmptyString(parsed.lockId)) {
      return null
    }
    return {
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
      lockId: parsed.lockId,
    }
  } catch {
    return null
  }
}

async function acquireLaunchLock(filePath: string, isProcessAliveImpl: (pid: number) => boolean): Promise<AcquireLaunchLockResult> {
  const lock: LaunchLockContent = {
    pid: process.pid,
    acquiredAt: Date.now(),
    lockId: randomUUID(),
  }

  try {
    const handle = await open(filePath, "wx", 0o600)
    await handle.writeFile(JSON.stringify(lock, null, 2), "utf8")
    await handle.close()
    return { lock }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }

    const existing = await readLaunchLock(filePath)
    if (existing && isProcessAliveImpl(existing.pid)) {
      return { lock: null }
    }

    await rm(filePath, { force: true })
    return {
      lock: null,
      ...(existing ? { recoveredStaleLock: { pid: existing.pid } } : {}),
    }
  }
}

function getBrokerIdentity(metadata: BrokerMetadata): string {
  return `${metadata.pid}:${metadata.startedAt}:${metadata.version}:${metadata.endpoint}`
}

async function readCompatibleBrokerState(
  brokerFilePath: string,
  pingImpl: (endpoint: string) => Promise<boolean>,
  isProcessAliveImpl: (pid: number) => boolean,
  expectedVersion?: string,
): Promise<CompatibleBrokerState> {
  const metadata = await readBrokerMetadata(brokerFilePath)
  if (!metadata) {
    return { status: "unavailable" }
  }

  if (isNonEmptyString(expectedVersion) && !isBrokerVersionCompatible(metadata.version, expectedVersion)) {
    return { status: "unavailable" }
  }

  if (!isProcessAliveImpl(metadata.pid)) {
    return { status: "unavailable" }
  }

  const ok = await pingImpl(metadata.endpoint)
  if (ok) {
    return {
      status: "ready",
      metadata,
    }
  }

  return {
    status: "booting",
    metadata,
  }
}

async function isBrokerAlive(
  brokerFilePath: string,
  pingImpl: (endpoint: string) => Promise<boolean>,
  isProcessAliveImpl: (pid: number) => boolean,
  expectedVersion?: string,
): Promise<BrokerMetadata | null> {
  const state = await readCompatibleBrokerState(brokerFilePath, pingImpl, isProcessAliveImpl, expectedVersion)
  if (state.status !== "ready") {
    return null
  }

  return state.metadata
}

async function readBootingCompatibleBroker(
  brokerFilePath: string,
  pingImpl: (endpoint: string) => Promise<boolean>,
  isProcessAliveImpl: (pid: number) => boolean,
  expectedVersion?: string,
): Promise<BrokerMetadata | null> {
  const state = await readCompatibleBrokerState(brokerFilePath, pingImpl, isProcessAliveImpl, expectedVersion)
  if (state.status !== "booting") {
    return null
  }

  return state.metadata
}

async function readVersionMismatchedBroker(
  brokerFilePath: string,
  expectedVersion?: string,
): Promise<BrokerMetadata | null> {
  const metadata = await readBrokerMetadata(brokerFilePath)
  if (!metadata) {
    return null
  }

  if (!isNonEmptyString(expectedVersion) || !shouldRetireBrokerForVersion(metadata.version, expectedVersion)) {
    return null
  }

  return metadata
}

async function defaultRetireBrokerImpl(
  metadata: BrokerMetadata,
  pingImpl: (endpoint: string) => Promise<boolean>,
): Promise<void> {
  if (metadata.pid === process.pid) {
    return
  }

  const reachable = await pingImpl(metadata.endpoint)
  if (!reachable) {
    return
  }

  if (!isProcessAlive(metadata.pid)) {
    return
  }

  try {
    process.kill(metadata.pid, "SIGTERM")
  } catch {
    return
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (!isProcessAlive(metadata.pid)) {
      return
    }
    await delay(50)
  }

  try {
    process.kill(metadata.pid, "SIGKILL")
  } catch {
    // process already exited
  }
}

function defaultSpawnImpl(endpoint: string, stateRoot: string) {
  const entry = fileURLToPath(new URL("./broker-entry.js", import.meta.url))
  const child = spawn(resolveBrokerSpawnCommand(), [entry, `--endpoint=${endpoint}`, `--state-root=${stateRoot}`], {
    cwd: path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
    detached: true,
    env: resolveBrokerSpawnEnv(process.env),
    stdio: "ignore",
  })
  child.unref()
  return child
}

async function waitForBootingBrokerToBecomeReady(input: {
  brokerFilePath: string
  bootingBrokerIdentity: string
  pingImpl: (endpoint: string) => Promise<boolean>
  isProcessAliveImpl: (pid: number) => boolean
  expectedVersion?: string
  waitStepMs: number
  maxWaitSteps: number
}): Promise<WaitForBootingBrokerResult> {
  let lastBootingBroker: BrokerMetadata | null = null

  for (let step = 0; step < input.maxWaitSteps; step += 1) {
    const state = await readCompatibleBrokerState(
      input.brokerFilePath,
      input.pingImpl,
      input.isProcessAliveImpl,
      input.expectedVersion,
    )
    if (state.status === "ready") {
      return {
        status: "ready",
        metadata: state.metadata,
      }
    }

    if (state.status !== "booting") {
      return lastBootingBroker
        ? {
            status: "failed",
            metadata: lastBootingBroker,
          }
        : null
    }

    if (getBrokerIdentity(state.metadata) !== input.bootingBrokerIdentity) {
      return {
        status: "replaced",
        metadata: state.metadata,
      }
    }

    lastBootingBroker = state.metadata
    if (step < input.maxWaitSteps - 1) {
      await delay(input.waitStepMs)
    }
  }

  return lastBootingBroker
    ? {
        status: "failed",
        metadata: lastBootingBroker,
      }
    : null
}

export async function connectOrSpawnBroker(options: LaunchOptions = {}): Promise<BrokerMetadata> {
  const stateRoot = options.stateRoot ?? wechatStateRoot()
  const brokerJsonFile = options.brokerJsonPath ?? path.join(stateRoot, "broker.json")
  const launchLockFile = options.launchLockPath ?? path.join(stateRoot, "launch.lock")
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const expectedVersion = options.expectedVersion ?? await readCurrentPackageVersion()
  const pingImpl = options.pingImpl ?? defaultPingImpl
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive
  const spawnImpl = options.spawnImpl ?? defaultSpawnImpl
  const retireBrokerImpl = options.retireBrokerImpl ?? ((metadata: BrokerMetadata) => defaultRetireBrokerImpl(metadata, pingImpl))
  const endpointFactory = options.endpointFactory ?? (() => createDefaultBrokerEndpoint({ stateRoot }))
  const bootingBrokerWaitStepMs = Math.min(Math.max(backoffMs, 10), DEFAULT_BOOTING_BROKER_WAIT_STEP_MS)
  const bootingBrokerWaitSteps = DEFAULT_BOOTING_BROKER_WAIT_STEPS

  await mkdir(stateRoot, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const running = await isBrokerAlive(brokerJsonFile, pingImpl, isProcessAliveImpl, expectedVersion)
    if (running) {
      return running
    }

    let failedBootingBrokerIdentity: string | null = null
    const bootingCompatibleBroker = await readBootingCompatibleBroker(
      brokerJsonFile,
      pingImpl,
      isProcessAliveImpl,
      expectedVersion,
    )
    if (bootingCompatibleBroker) {
      let bootingBrokerToWaitFor: BrokerMetadata | null = bootingCompatibleBroker

      for (let transition = 0; transition < maxAttempts && bootingBrokerToWaitFor; transition += 1) {
        const waitResult = await waitForBootingBrokerToBecomeReady({
          brokerFilePath: brokerJsonFile,
          bootingBrokerIdentity: getBrokerIdentity(bootingBrokerToWaitFor),
          pingImpl,
          isProcessAliveImpl,
          expectedVersion,
          waitStepMs: bootingBrokerWaitStepMs,
          maxWaitSteps: bootingBrokerWaitSteps,
        })
        if (waitResult?.status === "ready") {
          return waitResult.metadata
        }

        if (waitResult?.status === "replaced") {
          bootingBrokerToWaitFor = waitResult.metadata
          continue
        }

        failedBootingBrokerIdentity = waitResult ? getBrokerIdentity(waitResult.metadata) : null
        bootingBrokerToWaitFor = null
      }

      if (bootingBrokerToWaitFor) {
        continue
      }
    }

    const lockAttempt = await acquireLaunchLock(launchLockFile, isProcessAliveImpl)
    if (lockAttempt.recoveredStaleLock) {
      await appendBrokerLauncherDiagnostic(stateRoot, {
        type: "brokerTakeover",
        code: "brokerTakeover",
        reason: "staleLock",
        previousPid: lockAttempt.recoveredStaleLock.pid,
      })
    }
    const lock = lockAttempt.lock
    if (!lock) {
      await delay(backoffMs)
      continue
    }

    options.onLockAcquired?.(lock)

    try {
      const lockWindowBrokerState = await readCompatibleBrokerState(
        brokerJsonFile,
        pingImpl,
        isProcessAliveImpl,
        expectedVersion,
      )
      if (lockWindowBrokerState.status === "ready") {
        return lockWindowBrokerState.metadata
      }

      if (
        lockWindowBrokerState.status === "booting" &&
        getBrokerIdentity(lockWindowBrokerState.metadata) !== failedBootingBrokerIdentity
      ) {
        continue
      }

      const versionMismatchedBroker = await readVersionMismatchedBroker(brokerJsonFile, expectedVersion)
      if (versionMismatchedBroker) {
        await appendBrokerLauncherDiagnostic(stateRoot, {
          type: "brokerTakeover",
          code: "brokerTakeover",
          reason: "versionMismatch",
          previousVersion: versionMismatchedBroker.version,
          nextVersion: expectedVersion,
          previousPid: versionMismatchedBroker.pid,
        })
        await retireBrokerImpl(versionMismatchedBroker)
      }

      const endpoint = endpointFactory()
      const child = spawnImpl(endpoint, stateRoot)
      void child?.unref?.()

      for (let n = 0; n < 20; n += 1) {
        await delay(100)
        const spawned = await isBrokerAlive(brokerJsonFile, pingImpl, isProcessAliveImpl, expectedVersion)
        if (spawned) {
          return spawned
        }
      }

      throw new Error("spawned broker did not become available")
    } finally {
      await rm(launchLockFile, { force: true })
    }
  }

  throw new Error("broker unavailable")
}
