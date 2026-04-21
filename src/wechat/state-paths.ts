import path from "node:path"
import { mkdir } from "node:fs/promises"
import { wechatConfigDir } from "../store-paths.js"

export const WECHAT_DIR_MODE = 0o700
export const WECHAT_FILE_MODE = 0o600

export type WechatRequestKind = "question" | "permission"

export function wechatStateRoot() {
  const override = process.env.WECHAT_STATE_ROOT_OVERRIDE
  if (typeof override === "string" && override.trim().length > 0) {
    return override
  }
  return wechatConfigDir()
}

export function brokerStatePath() {
  return path.join(wechatStateRoot(), "broker.json")
}

export function brokerStateStorePath() {
  return path.join(wechatStateRoot(), "broker-state-store.json")
}

export function brokerStateSchemaPath() {
  return path.join(wechatStateRoot(), "broker-state-store.schema.json")
}

export function wechatStatusRuntimeDiagnosticsPath(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "wechat-status-runtime.diagnostics.jsonl")
}

export function brokerStartupDiagnosticsPath(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "broker-startup.diagnostics.log")
}

export function wechatBrokerDiagnosticsPath(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "wechat-broker.diagnostics.jsonl")
}

export function wechatBridgeDiagnosticsPath(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "wechat-bridge.diagnostics.jsonl")
}

export function launchLockPath() {
  return path.join(wechatStateRoot(), "launch.lock")
}

export function operatorStatePath() {
  return path.join(wechatStateRoot(), "operator.json")
}

export function instancesDir() {
  return path.join(wechatStateRoot(), "instances")
}

export function instanceStatePath(instanceID: string) {
  return path.join(instancesDir(), `${instanceID}.json`)
}

export function tokensDir() {
  return path.join(wechatStateRoot(), "tokens")
}

export function tokenStatePath(wechatAccountId: string, userId: string) {
  return path.join(tokensDir(), wechatAccountId, `${userId}.json`)
}

export function latestAccountStatePath(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "latest-account.json")
}

export function notificationsDir() {
  return path.join(wechatStateRoot(), "notifications")
}

export function notificationStatePath(idempotencyKey: string) {
  return path.join(notificationsDir(), `${idempotencyKey}.json`)
}

export function requestKindDir(kind: WechatRequestKind) {
  return path.join(wechatStateRoot(), "requests", kind)
}

export function requestStatePath(kind: WechatRequestKind, routeKey: string) {
  return path.join(requestKindDir(kind), `${routeKey}.json`)
}

export function wechatDeadLetterRoot(stateRoot: string = wechatStateRoot()) {
  return path.join(stateRoot, "dead-letter")
}

export function wechatDeadLetterKindDir(kind: WechatRequestKind, stateRoot: string = wechatStateRoot()) {
  return path.join(wechatDeadLetterRoot(stateRoot), kind)
}

export function wechatDeadLetterPath(kind: WechatRequestKind, routeKey: string, stateRoot: string = wechatStateRoot()) {
  return path.join(wechatDeadLetterKindDir(kind, stateRoot), `${routeKey}.json`)
}

async function ensureDir(dirPath: string) {
  await mkdir(dirPath, { recursive: true, mode: WECHAT_DIR_MODE })
}

export async function ensureWechatStateLayout() {
  await ensureDir(wechatStateRoot())
  await ensureDir(instancesDir())
  await ensureDir(tokensDir())
  await ensureDir(notificationsDir())
  await ensureDir(wechatDeadLetterKindDir("question"))
  await ensureDir(wechatDeadLetterKindDir("permission"))
  await ensureDir(requestKindDir("question"))
  await ensureDir(requestKindDir("permission"))
}
