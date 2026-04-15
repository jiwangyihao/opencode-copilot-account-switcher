import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as realHostHarness from "./helpers/opencode-real-host-harness.js"

import {
  canExecuteWindowsCmdShimRegression,
  classifyRealOpencodeWechatBindResult,
  createRealOpencodeHostRoot,
  installPluginIntoRealHost,
  openGitHubCopilotPluginMenuThroughRealOpencode,
  openWechatNotificationsSubmenuThroughRealOpencode,
  resolveDisabledMcpInlineConfigContent,
  resolveRealHostPluginInlineConfigContent,
  runCommand,
  runRealWechatBindAndClassify,
  runWechatBindThroughRealOpencode,
  resolveOpencodeBinary,
  sendKeys,
  spawnRealOpencodePty,
  stopRealOpencodePty,
  waitForAskAnythingScreen,
  waitForScreenText,
} from "./helpers/opencode-real-host-harness.js"

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS = [
  "providers",
  "login",
  "--provider",
  "github-copilot",
  "--method",
  "Manage GitHub Copilot accounts",
]

// Real-host PTY tests contend on the same external TUI/runtime surface.
// Serializing them avoids false failures from overlapping interactive sessions.
const runExclusiveRealHostPtyTest = (() => {
  let queue = Promise.resolve()
  return async (work) => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
  }
})()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readScreenText(session, readScreenImpl) {
  const screenText = await (readScreenImpl ? readScreenImpl(session) : session.screenText)
  if (typeof screenText === "string") {
    session.screenText = screenText
  }
  return session.screenText
}

async function waitForScreenChange(session, previousScreenText, {
  timeoutMs = 2_000,
  pollIntervalMs = 25,
  readScreenImpl,
} = {}) {
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    const currentScreenText = await readScreenText(session, readScreenImpl)
    if (currentScreenText !== previousScreenText) {
      return currentScreenText
    }

    if (session.exited) {
      break
    }

    await delay(pollIntervalMs)
  }

  return previousScreenText
}

async function openProviderSelectionFromCommandPalette(session, {
  readScreenImpl,
  sendInputImpl,
  paletteTimeoutMs = 15_000,
  filterChangeTimeoutMs = 2_000,
  filterPollIntervalMs = 25,
  providerTimeoutMs = 15_000,
} = {}) {
  const paletteScreen = await waitForScreenText(session, /Connect provider/i, {
    timeoutMs: paletteTimeoutMs,
    readScreenImpl,
  })

  // This upstream palette exposes a Search field, but after stripping ANSI the
  // currently selected row is no longer recoverable from text alone. Filter to
  // the command that opens provider/model selection before pressing Enter.
  await sendKeys(session, ["Switch model"], { sendInputImpl })
  const filteredScreen = await waitForScreenChange(session, paletteScreen, {
    timeoutMs: filterChangeTimeoutMs,
    pollIntervalMs: filterPollIntervalMs,
    readScreenImpl,
  })

  await sendKeys(session, ["ENTER"], { sendInputImpl })
  const providerScreen = await waitForScreenText(session, /Select model/i, {
    timeoutMs: providerTimeoutMs,
    readScreenImpl,
  })

  return {
    paletteScreen,
    filteredScreen,
    providerScreen,
  }
}

async function ensureBuiltPluginPackageRoot() {
  const distEntryPath = path.join(REPO_ROOT, "dist", "index.js")

  try {
    await access(distEntryPath)
  } catch {
    if (process.platform === "win32") {
      await runCommand("cmd.exe", ["/d", "/s", "/c", "npm", "run", "build"], {
        cwd: REPO_ROOT,
        timeoutMs: 300_000,
      })
    } else {
      await runCommand("npm", ["run", "build"], {
        cwd: REPO_ROOT,
        timeoutMs: 300_000,
      })
    }
  }

  return REPO_ROOT
}

test("real host bootstrap: returns host-bootstrap-failed when runnable opencode binary is unavailable", async () => {
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
    opencodePathResolver: async () => undefined,
  })

  assert.equal(host.ok, false)
  assert.equal(host.stage, "host-bootstrap-failed")
  assert.match(host.error, /opencode binary/i)
})

test("real host bootstrap: prepares isolated host directories when opencode runtime is available", async () => {
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
    opencodePathResolver: async () => "opencode",
  })

  assert.equal(host.ok, true)
  assert.equal(host.stage, "host-bootstrap-ready")
  assert.equal(host.runtimePath, "opencode")
  assert.match(host.hostRoot, /opencode-real-host-/i)

  const normalizedHostRoot = path.normalize(host.hostRoot).toLowerCase()
  const normalizedCacheRoot = path.normalize(host.cacheRoot).toLowerCase()
  const normalizedConfigRoot = path.normalize(host.configRoot).toLowerCase()
  const normalizedDataRoot = path.normalize(host.dataRoot).toLowerCase()
  const normalizedLogRoot = path.normalize(host.logRoot).toLowerCase()

  assert.equal(normalizedCacheRoot, path.join(normalizedHostRoot, "cache"))
  assert.equal(normalizedConfigRoot, path.join(normalizedHostRoot, "config"))
  assert.equal(normalizedDataRoot, path.join(normalizedHostRoot, "data"))
  assert.equal(normalizedLogRoot, path.join(normalizedHostRoot, "logs"))

  assert.equal(normalizedCacheRoot.includes(`${path.sep}.cache${path.sep}opencode`), false)
  assert.equal(normalizedConfigRoot.includes(`${path.sep}.config${path.sep}opencode`), false)

  await Promise.all([
    access(host.cacheRoot),
    access(host.configRoot),
    access(host.dataRoot),
    access(host.logRoot),
  ])

  await host.cleanup()
  await assert.rejects(() => access(host.hostRoot))
})

test("real host bootstrap helper: resolveOpencodeBinary returns undefined when runtime is unavailable", async () => {
  const runtime = await resolveOpencodeBinary({
    runCommandImpl: async () => {
      throw new Error("not found")
    },
  })

  assert.equal(runtime, undefined)
})

test("real host bootstrap helper: windows cmd shim execution regression only runs on windows hosts", () => {
  assert.equal(canExecuteWindowsCmdShimRegression("win32"), true)
  assert.equal(canExecuteWindowsCmdShimRegression("linux"), false)
})

test("real host bootstrap helper: resolveOpencodeBinary on windows prefers runnable binary from multiple where results", async () => {
  const runtime = await resolveOpencodeBinary({
    platform: "win32",
    runCommandImpl: async () => ({
      stdout: [
        "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\opencode.cmd",
        "C:\\Program Files\\OpenCode\\opencode.exe",
      ].join("\r\n"),
      stderr: "",
    }),
  })

  assert.deepEqual(runtime, {
    resolvedPath: "C:\\Program Files\\OpenCode\\opencode.exe",
    command: "C:\\Program Files\\OpenCode\\opencode.exe",
    args: [],
    kind: "binary",
  })
})

test("real host bootstrap helper: resolveOpencodeBinary on windows normalizes .cmd shim into cmd.exe strategy", async () => {
  const runtime = await resolveOpencodeBinary({
    platform: "win32",
    runCommandImpl: async () => ({
      stdout: [
        "C:\\Tools\\opencode.bat",
        "C:\\Program Files\\OpenCode CLI\\opencode.cmd",
      ].join("\r\n"),
      stderr: "",
    }),
  })

  assert.deepEqual(runtime, {
    resolvedPath: "C:\\Program Files\\OpenCode CLI\\opencode.cmd",
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "call", "C:\\Program Files\\OpenCode CLI\\opencode.cmd"],
    kind: "cmd-shim",
  })
})

test("real host bootstrap helper: resolveOpencodeBinary windows shim strategy executes cmd path with spaces", {
  skip: canExecuteWindowsCmdShimRegression() ? false : "windows-only execution regression",
}, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-real-host-shim-"))
  const shimDir = path.join(tempRoot, "OpenCode CLI")
  const shimPath = path.join(shimDir, "opencode.cmd")
  const markerPath = path.join(tempRoot, "marker.txt")

  try {
    await mkdir(shimDir, { recursive: true })
    await writeFile(
      shimPath,
      `@echo off\r\necho shim-ran>"${markerPath}"\r\n`,
      "utf8",
    )

    const runtime = await resolveOpencodeBinary({
      platform: "win32",
      runCommandImpl: async () => ({
        stdout: `${shimPath}\r\n`,
        stderr: "",
      }),
    })

    assert.deepEqual(runtime, {
      resolvedPath: shimPath,
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "call", shimPath],
      kind: "cmd-shim",
    })

    await runCommand(runtime.command, runtime.args, { cwd: tempRoot })
    await access(markerPath)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("real host install helper: runCommand rejects on timeout and terminates the child process", async () => {
  const startedAt = Date.now()

  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }),
    (error) => {
      assert.match(error.message, /timed out/i)
      return true
    },
  )

  const durationMs = Date.now() - startedAt
  assert.equal(durationMs < 5_000, true)
})

test("real host install: uses a host-loadable dist entry file path instead of a package or directory spec", async () => {
  const calls = []
  const host = {
    hostRoot: "C:/tmp/opencode-host",
    cacheRoot: "C:/tmp/opencode-host/cache",
    configRoot: "C:/tmp/opencode-host/config",
    dataRoot: "C:/tmp/opencode-host/data",
    logRoot: "C:/tmp/opencode-host/logs",
    tmpRoot: "C:/tmp/opencode-host/tmp",
    runtimeCommand: "cmd.exe",
    runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
    runtimeKind: "cmd-shim",
  }
  const artifact = {
    entryFilePath: "C:\\repo\\copilot-account-switcher\\dist\\index.js",
  }

  process.env.OPENCODE_REAL_HOST_SHOULD_NOT_LEAK = "secret"

  try {
    const result = await installPluginIntoRealHost({
      host,
      artifact,
      runCommandImpl: async (command, args, options) => {
        calls.push({ command, args, options })
        return { stdout: "", stderr: "" }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.stage, "plugin-install-ready")
    assert.equal(result.runtimeKind, "cmd-shim")
    assert.equal(result.pluginSpec, "C:/repo/copilot-account-switcher/dist/index.js")
    assert.equal(result.pluginSpec.includes("plugin-artifact/package"), false)
    assert.equal(result.pluginSpec.includes("file:///"), false)
    assert.equal(result.pluginSpec.includes("@file:"), false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, "cmd.exe")
    assert.deepEqual(calls[0].args, [
      "/d",
      "/s",
      "/c",
      "call",
      "C:/Tools/opencode.cmd",
      "plugin",
      "C:/repo/copilot-account-switcher/dist/index.js",
      "--force",
    ])
    assert.equal(calls[0].options.cwd, "C:/tmp/opencode-host")
    assert.equal(calls[0].options.timeoutMs, 120_000)
    assert.equal(calls[0].options.env.HOME, "C:/tmp/opencode-host")
    assert.equal(calls[0].options.env.USERPROFILE, "C:/tmp/opencode-host")
    assert.equal(calls[0].options.env.OPENCODE_TEST_HOME, "C:/tmp/opencode-host")
    assert.equal(calls[0].options.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1")
    assert.equal(calls[0].options.env.XDG_CONFIG_HOME, "C:/tmp/opencode-host/config")
    assert.equal(calls[0].options.env.XDG_CACHE_HOME, "C:/tmp/opencode-host/cache")
    assert.equal(calls[0].options.env.XDG_DATA_HOME, "C:/tmp/opencode-host/data")
    assert.equal(calls[0].options.env.XDG_STATE_HOME, "C:/tmp/opencode-host/logs")
    assert.equal(calls[0].options.env.APPDATA, "C:/tmp/opencode-host/config")
    assert.equal(calls[0].options.env.LOCALAPPDATA, "C:/tmp/opencode-host/data")
    assert.equal(calls[0].options.env.TMP, "C:/tmp/opencode-host/tmp")
    assert.equal(calls[0].options.env.TEMP, "C:/tmp/opencode-host/tmp")
    assert.equal(calls[0].options.env.TMPDIR, "C:/tmp/opencode-host/tmp")
    assert.equal("OPENCODE_REAL_HOST_SHOULD_NOT_LEAK" in calls[0].options.env, false)
  } finally {
    delete process.env.OPENCODE_REAL_HOST_SHOULD_NOT_LEAK
  }
})

test("real host install: normalizes windows dist entry paths into loadable file paths", async () => {
  const result = await installPluginIntoRealHost({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:\\Users\\dev\\plugin builds\\copilot-account-switcher\\dist\\index.js",
    },
    runCommandImpl: async () => ({ stdout: "", stderr: "" }),
  })

  assert.equal(result.ok, true)
  assert.equal(
    result.pluginSpec,
    "C:/Users/dev/plugin builds/copilot-account-switcher/dist/index.js",
  )
  assert.equal(result.pluginSpec.includes("file:///"), false)
  assert.equal(result.pluginSpec.includes("plugin-artifact/package"), false)
  assert.equal(result.pluginSpec.includes("@file:"), false)
})

test("real host install: decodes encoded windows file URLs into loadable file paths", async () => {
  const result = await installPluginIntoRealHost({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "file:///C:/Users/dev/plugin%20builds/dist/index.js",
    },
    runCommandImpl: async () => ({ stdout: "", stderr: "" }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.pluginSpec, "C:/Users/dev/plugin builds/dist/index.js")
  assert.equal(result.pluginSpec.includes("%20"), false)
})

test("real host install: preserves leading slash when normalizing posix file URLs", async () => {
  const result = await installPluginIntoRealHost({
    host: {
      hostRoot: "/tmp/opencode-host",
      cacheRoot: "/tmp/opencode-host/cache",
      configRoot: "/tmp/opencode-host/config",
      dataRoot: "/tmp/opencode-host/data",
      logRoot: "/tmp/opencode-host/logs",
      tmpRoot: "/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "file:///tmp/repo/dist/index.js",
    },
    runCommandImpl: async () => ({ stdout: "", stderr: "" }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.pluginSpec, "/tmp/repo/dist/index.js")
  assert.equal(result.pluginSpec.startsWith("/tmp/"), true)
  assert.equal(result.pluginSpec.includes("file:///"), false)
})

test("real host install: decodes encoded posix file URLs into loadable file paths", async () => {
  const result = await installPluginIntoRealHost({
    host: {
      hostRoot: "/tmp/opencode-host",
      cacheRoot: "/tmp/opencode-host/cache",
      configRoot: "/tmp/opencode-host/config",
      dataRoot: "/tmp/opencode-host/data",
      logRoot: "/tmp/opencode-host/logs",
      tmpRoot: "/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "file:///tmp/repo/plugin%20builds/dist/index.js",
    },
    runCommandImpl: async () => ({ stdout: "", stderr: "" }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.pluginSpec, "/tmp/repo/plugin builds/dist/index.js")
  assert.equal(result.pluginSpec.includes("%20"), false)
})

test("real host install: classifies runtime failures as plugin-install-failed", async () => {
  const result = await installPluginIntoRealHost({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: { entryFilePath: "C:/repo/copilot-account-switcher/dist/index.js" },
    runCommandImpl: async () => {
      const error = new Error("install exploded")
      error.stdout = "plugin stdout"
      error.stderr = "plugin stderr"
      throw error
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, "plugin-install-failed")
  assert.match(result.error, /install exploded/)
  assert.equal(result.stdout, "plugin stdout")
  assert.equal(result.stderr, "plugin stderr")
})

test("real host PTY helper: resolveDisabledMcpInlineConfigContent turns inherited MCP entries off", async () => {
  const calls = []
  const inlineConfigContent = await resolveDisabledMcpInlineConfigContent({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    runCommandImpl: async (command, args) => {
      calls.push({ command, args })
      return {
      stdout: JSON.stringify({
        mcp: {
          context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
          pencil: { type: "local", command: ["pencil"], enabled: true },
        },
      }),
      stderr: "",
    }
    },
  })

  assert.deepEqual(calls, [{ command: "opencode", args: ["debug", "config", "--pure"] }])
  assert.deepEqual(JSON.parse(inlineConfigContent), {
    mcp: {
      context7: { enabled: false },
      pencil: { enabled: false },
    },
  })
})

test("real host PTY helper: spawnRealOpencodePty appends commandArgsOverride after runtime dispatch args", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const calls = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    commandArgsOverride: PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS,
    spawnPtyImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakePty
    },
  })

  try {
    assert.equal(session.command, "cmd.exe")
    assert.deepEqual(session.args, [
      "/d",
      "/s",
      "/c",
      "call",
      "C:/Tools/opencode.cmd",
      ...PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS,
    ])
    assert.deepEqual(calls[0].args, session.args)
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: spawnRealOpencodePty uses windows binary runtime directly", async () => {
  const hostRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-real-host-pty-wrapper-"))
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const calls = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode.exe",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot,
      projectRoot: REPO_ROOT,
      cacheRoot: path.join(hostRoot, "cache"),
      configRoot: path.join(hostRoot, "config"),
      dataRoot: path.join(hostRoot, "data"),
      logRoot: path.join(hostRoot, "logs"),
      tmpRoot: path.join(hostRoot, "tmp"),
      runtimePath: "C:/Program Files/OpenCode/opencode.exe",
      runtimeCommand: "C:/Program Files/OpenCode/opencode.exe",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    commandArgsOverride: PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS,
    platform: "win32",
    spawnPtyImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakePty
    },
  })

  try {
    assert.equal(session.command, "C:/Program Files/OpenCode/opencode.exe")
    assert.deepEqual(session.args, PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS)
    assert.equal(calls[0].command, "C:/Program Files/OpenCode/opencode.exe")
    assert.equal(calls[0].options.cwd, REPO_ROOT)
  } finally {
    await stopRealOpencodePty(session)
    await rm(hostRoot, { recursive: true, force: true })
  }
})

test("real host PTY helper: waitForScreenText ignores stale matches from cleared historical screens", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    spawnPtyImpl: () => fakePty,
  })

  try {
    dataEmitter.emit("data", "\u001b[2JBind / Rebind WeChat\nOld menu")
    dataEmitter.emit("data", "\u001b[2JCurrent other menu\nNo wechat submenu")
    exitEmitter.emit("exit", { exitCode: 0 })

    await assert.rejects(
      waitForScreenText(session, /Bind \/ Rebind WeChat/, {
        timeoutMs: 10,
        pollIntervalMs: 0,
      }),
      /menu buffer did not match/,
    )
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: waitForScreenText ignores stale matches after cursor-home redraw without clear-screen", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    spawnPtyImpl: () => fakePty,
  })

  try {
    dataEmitter.emit("data", "\u001b[HBind / Rebind WeChat\nOld menu")
    dataEmitter.emit("data", "\u001b[HCurrent other menu\nNo wechat submenu")
    exitEmitter.emit("exit", { exitCode: 0 })

    await assert.rejects(
      waitForScreenText(session, /Bind \/ Rebind WeChat/, {
        timeoutMs: 10,
        pollIntervalMs: 0,
      }),
      /menu buffer did not match/,
    )
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: blank redraw frame does not erase last visible menu snapshot", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    spawnPtyImpl: () => fakePty,
  })

  try {
    dataEmitter.emit("data", "\u001b[2JAsk anything...\nctrl+p commands")
    assert.match(session.screenText, /Ask anything\.\.\./)

    dataEmitter.emit("data", "\u001b[H\u001b[K\r\n\u001b[K\r\n\u001b[K")
    assert.match(session.screenText, /Ask anything\.\.\./)
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: waitForAskAnythingScreen tolerates slow interactive startup", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    spawnPtyImpl: () => fakePty,
  })

  try {
    setTimeout(() => {
      dataEmitter.emit("data", "\u001b[2JAsk anything...\nctrl+p commands")
    }, 40)

    const screenText = await waitForAskAnythingScreen(session, {
      timeoutMs: 100,
      pollIntervalMs: 0,
    })

    assert.match(screenText, /Ask anything\.\.\./)
    assert.match(screenText, /ctrl\+p commands/i)
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: stopRealOpencodePty tolerates UNKNOWN kill errors when session exits anyway", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      setTimeout(() => exitEmitter.emit("exit", { exitCode: 0 }), 0)
      const error = new Error("spawn UNKNOWN")
      error.code = "UNKNOWN"
      throw error
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "cmd.exe",
      runtimeArgs: ["/d", "/s", "/c", "call", "C:/Tools/opencode.cmd"],
      runtimeKind: "cmd-shim",
    },
    spawnPtyImpl: () => fakePty,
  })

  await stopRealOpencodePty(session, {
    gracefulInputs: [],
  })

  assert.equal(session.exited, true)
})

test("real host PTY helper: resolveRealHostPluginInlineConfigContent merges plugin dist entry with disabled MCP overrides", async () => {
  const inlineConfigContent = await resolveRealHostPluginInlineConfigContent({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    resolveDisabledMcpInlineConfigContentImpl: async () => JSON.stringify({
      mcp: {
        context7: { enabled: false },
      },
    }),
  })

  assert.deepEqual(JSON.parse(inlineConfigContent), {
    plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"],
    mcp: {
      context7: { enabled: false },
    },
  })
})

test("real host PTY smoke: starts real opencode in isolated host and observes help screen text", { timeout: 120_000 }, async () => {
  await runExclusiveRealHostPtyTest(async () => {
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
  })

  assert.equal(host.ok, true)

  const smokeHost = {
    ...host,
    runtimeArgs: [...(host.runtimeArgs ?? []), "--help"],
  }
  const session = await spawnRealOpencodePty({ host: smokeHost })

  try {
    const screenText = await waitForScreenText(session, /Commands:/, { timeoutMs: 30_000 })

    assert.equal(session.transport, "pty")
    assert.equal(typeof session.pty.pid, "number")
    assert.match(screenText, /opencode completion/i)

    await sendKeys(session, ["q"])
    await session.exitPromise
  } finally {
    await stopRealOpencodePty(session, { gracefulInputs: ["\u001b"] })
    await host.cleanup()
  }
  })
})

test("real host PTY supplemental input: ctrl+p then enter reaches provider selection without MCP auth modal", { timeout: 120_000 }, async () => {
  await runExclusiveRealHostPtyTest(async () => {
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
  })

  assert.equal(host.ok, true)

  const interactiveHost = {
    ...host,
    runtimeArgs: [...(host.runtimeArgs ?? []), "--agent", "build"],
  }
  const session = await spawnRealOpencodePty({
    host: interactiveHost,
    disableInheritedMcp: true,
  })

  try {
    const initialScreen = await waitForAskAnythingScreen(session)

    assert.match(initialScreen, /ctrl\+p commands/i)
    assert.doesNotMatch(initialScreen, /MCP Authentication Required/i)

    await sendKeys(session, ["CTRL_P"])
    const {
      paletteScreen,
      providerScreen,
    } = await openProviderSelectionFromCommandPalette(session)
    assert.match(paletteScreen, /Switch model/i)

    assert.match(providerScreen, /View all providers/i)
  } finally {
    await stopRealOpencodePty(session)
    await host.cleanup()
  }
  })
})

test("real host PTY helper: selectMenuItemOnScreen keeps moving until Connect provider is selected", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    spawnPtyImpl: () => fakePty,
  })

  const paletteScreen = (selectedLabel) => [
    "┌  Command palette",
    selectedLabel === "Switch model" ? "│  ● Switch model" : "│  ○ Switch model",
    selectedLabel === "Connect provider" ? "│  ● Connect provider" : "│  ○ Connect provider",
    "│  ○ Ask opencode",
    "└",
  ].join("\n")

  const selectedScreen = await realHostHarness.selectMenuItemOnScreen(session, /Connect provider/i, {
    readScreenImpl: async () => {
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length
      return paletteScreen(downCount === 0 ? "Switch model" : "Connect provider")
    },
    timeoutMs: 20,
    inputChangeTimeoutMs: 5,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.match(selectedScreen, /● Connect provider/)
    assert.equal(sentInputs.filter((input) => input === "\u001b[B").length, 1)
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: openProviderSelectionFromCommandPalette filters to Switch model before Enter", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const session = await spawnRealOpencodePty({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    spawnPtyImpl: () => fakePty,
  })

  const paletteScreen = [
    "Commands",
    "Search",
    "Suggested",
    "Switch model",
    "Connect provider",
  ].join("\n")
  const filteredPaletteScreen = [
    "Commands",
    "Search Switch model",
    "Suggested",
    "Switch model",
  ].join("\n")
  const providerScreen = [
    "Select model",
    "View all providers",
  ].join("\n")

  const result = await openProviderSelectionFromCommandPalette(session, {
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const filterCount = sentInputs.filter((input) => input === "Switch model").length

      if (enterCount >= 1) {
        return providerScreen
      }

      if (filterCount >= 1) {
        return filteredPaletteScreen
      }

      return paletteScreen
    },
    filterChangeTimeoutMs: 20,
    filterPollIntervalMs: 0,
    providerTimeoutMs: 20,
  })

  try {
    assert.equal(result.paletteScreen, paletteScreen)
    assert.equal(result.filteredScreen, filteredPaletteScreen)
    assert.equal(result.providerScreen, providerScreen)
    assert.deepEqual(sentInputs, ["Switch model", "\r"])
  } finally {
    await stopRealOpencodePty(session)
  }
})

test("real host PTY helper: providers login sends Enter after Add credential before waiting for plugin menu", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const buffers = [
    "T  Add credential",
    "GitHub Copilot 账号\n通用设置\n微信通知\nProvider 专属设置",
  ]
  let readCount = 0

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => buffers[Math.min(readCount++, buffers.length - 1)],
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "plugin-menu-visible")
    assert.equal(result.reachedAddCredential, true)
    assert.equal(result.reachedPluginMenu, true)
    assert.match(result.addCredentialScreen, /Add credential/i)
    assert.match(result.pluginMenuScreen, /微信通知/)
    assert.deepEqual(sentInputs.slice(0, 1), ["\r"])
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: providers login treats common-settings/provider-settings screen as plugin menu even before 微信通知 is visible", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const buffers = [
    "T  Add credential",
    "GitHub Copilot 账号\nGuided Loop Safety\n通用设置\nProvider 专属设置",
  ]
  let readCount = 0

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => buffers[Math.min(readCount++, buffers.length - 1)],
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "plugin-menu-visible")
    assert.match(result.pluginMenuScreen, /Guided Loop Safety/i)
    assert.match(result.pluginMenuScreen, /通用设置/)
    assert.match(result.pluginMenuScreen, /Provider 专属设置/)
    assert.deepEqual(sentInputs.slice(0, 1), ["\r"])
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: retries Enter when Add credential screen does not advance on first submit", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = "GitHub Copilot 账号\n通用设置\n微信通知\nProvider 专属设置"

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      if (enterCount === 0) {
        return "T  Add credential"
      }
      if (enterCount === 1) {
        return "T  Add credential"
      }

      return pluginMenuScreen
    },
    screenWaitTimeoutMs: 40,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 1,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(sentInputs.filter((input) => input === "\r").length, 2)
    assert.equal(result.pluginMenuScreen, pluginMenuScreen)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: retries the full Add credential -> plugin menu open on a fresh PTY when the first session stalls", async () => {
  const sentInputsByAttempt = []
  const ptys = []
  const pluginMenuScreen = "GitHub Copilot accounts\nGuided Loop Safety\nWeChat notifications\nProvider settings"

  const createFakePty = (attempt) => {
    const dataEmitter = new EventEmitter()
    const exitEmitter = new EventEmitter()
    const fakePty = {
      pid: 1234 + attempt,
      cols: 120,
      rows: 30,
      process: "opencode",
      handleFlowControl: false,
      onData(listener) {
        dataEmitter.on("data", listener)
        return { dispose: () => dataEmitter.off("data", listener) }
      },
      onExit(listener) {
        exitEmitter.on("exit", listener)
        return { dispose: () => exitEmitter.off("exit", listener) }
      },
      write(input) {
        sentInputsByAttempt[attempt].push(input)

        if (input === "\u0003") {
          exitEmitter.emit("exit", { exitCode: 0 })
        }
      },
      kill() {
        exitEmitter.emit("exit", { exitCode: 0 })
      },
    }

    ptys.push(fakePty)
    return fakePty
  }

  let spawnCount = 0

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => {
      const attempt = spawnCount
      sentInputsByAttempt[attempt] = []
      spawnCount += 1
      return createFakePty(attempt)
    },
    readScreenImpl: async (session) => {
      const attempt = ptys.indexOf(session.pty)
      const enterCount = sentInputsByAttempt[attempt].filter((input) => input === "\r").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (attempt === 0) {
        return "Loading provider settings"
      }

      return pluginMenuScreen
    },
    screenWaitTimeoutMs: 20,
    inputChangeTimeoutMs: 5,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.reachedPluginMenu, true)
    assert.equal(result.pluginMenuScreen, pluginMenuScreen)
    assert.equal(spawnCount, 2)
    assert.deepEqual(sentInputsByAttempt[0], ["\r", "\u0003"])
    assert.deepEqual(sentInputsByAttempt[1], ["\r"])
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: providers login uses isolated hostRoot cwd to avoid project-local plugin leakage", async () => {
  const sentInputsByAttempt = []
  const calls = []

  const createFakePty = (attempt) => {
    const dataEmitter = new EventEmitter()
    const exitEmitter = new EventEmitter()
    const fakePty = {
      pid: 1234 + attempt,
      cols: 120,
      rows: 30,
      process: "opencode",
      handleFlowControl: false,
      onData(listener) {
        dataEmitter.on("data", listener)
        return { dispose: () => dataEmitter.off("data", listener) }
      },
      onExit(listener) {
        exitEmitter.on("exit", listener)
        return { dispose: () => exitEmitter.off("exit", listener) }
      },
      write(input) {
        sentInputsByAttempt[attempt].push(input)
      },
      kill() {
        exitEmitter.emit("exit", { exitCode: 0 })
      },
    }

    return fakePty
  }

  let attempt = 0
  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      projectRoot: REPO_ROOT,
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: (command, args, options) => {
      sentInputsByAttempt[attempt] = []
      calls.push({ command, args, options })
      return createFakePty(attempt++)
    },
    readScreenImpl: async () => {
      const currentAttempt = Math.max(0, attempt - 1)
      const enterCount = sentInputsByAttempt[currentAttempt].filter((input) => input === "\r").length
      if (enterCount === 0) {
        return "T  Add credential"
      }
      return "Guided Loop Safety\n通用设置\nProvider 专属设置"
    },
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(calls[0].options.cwd, "C:/tmp/opencode-host")
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: retries Enter when Add credential redraws but still remains active", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = "GitHub Copilot 账号\n通用设置\n微信通知\nProvider 专属设置"

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      if (enterCount === 0) {
        return "T  Add credential"
      }
      if (enterCount === 1) {
        return "T  Add credential\nPress Enter to continue"
      }

      return pluginMenuScreen
    },
    screenWaitTimeoutMs: 40,
    inputChangeTimeoutMs: 5,
    inputRetryAttempts: 1,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(sentInputs.filter((input) => input === "\r").length, 2)
    assert.equal(result.pluginMenuScreen, pluginMenuScreen)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: openGitHubCopilotPluginMenuThroughRealOpencode stops PTY on intermediate failure", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  let killCount = 0
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      killCount += 1
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  await assert.rejects(
    openGitHubCopilotPluginMenuThroughRealOpencode({
      host: {
        hostRoot: "C:/tmp/opencode-host",
        cacheRoot: "C:/tmp/opencode-host/cache",
        configRoot: "C:/tmp/opencode-host/config",
        dataRoot: "C:/tmp/opencode-host/data",
        logRoot: "C:/tmp/opencode-host/logs",
        tmpRoot: "C:/tmp/opencode-host/tmp",
        runtimeCommand: "opencode",
        runtimeArgs: [],
        runtimeKind: "binary",
      },
      artifact: {
        entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
      },
      inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
      spawnPtyImpl: () => fakePty,
      readScreenImpl: async () => "Still booting",
      pluginMenuOpenAttempts: 1,
      screenWaitTimeoutMs: 10,
    }),
    /menu buffer did not match/,
  )

  assert.equal(killCount, 1)
})

test("real host PTY helper: plugin menu sends 12 DOWN keys before opening 微信通知 submenu", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "Bind / Rebind WeChat",
    "WeChat notifications: On",
    "Question notifications: On",
  ].join("\n")

  const result = await openWechatNotificationsSubmenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount >= 2 && downCount >= 12) {
        return submenuScreen
      }

      return pluginMenuScreen(downCount)
    },
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "wechat-submenu-visible")
    assert.equal(result.reachedPluginMenu, true)
    assert.equal(result.reachedWechatSubmenu, true)
    assert.match(result.wechatSubmenuScreen, /Bind \/ Rebind WeChat/)
    assert.equal(sentInputs.filter((input) => input === "\u001b[B").length, 12)
    assert.equal(sentInputs.at(-1), "\r")
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: retries a swallowed DOWN and still reaches 微信通知 submenu", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "Bind / Rebind WeChat",
    "WeChat notifications: On",
    "Question notifications: On",
  ].join("\n")

  const result = await openWechatNotificationsSubmenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      const selectedIndex = downCount <= 5 ? downCount : downCount - 1
      if (enterCount >= 2 && selectedIndex >= 12) {
        return submenuScreen
      }

      return pluginMenuScreen(selectedIndex)
    },
    screenWaitTimeoutMs: 10,
    menuNavigationDelayMs: 0,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 1,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.reachedWechatSubmenu, true)
    assert.match(result.wechatSubmenuScreen, /Bind \/ Rebind WeChat/)
    assert.equal(sentInputs.filter((input) => input === "\u001b[B").length, 13)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: 微信通知子菜单首帧只出现绑定项时会等待完整稳定帧", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const partialSubmenuScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
  ].join("\n")
  const fullSubmenuScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "○ WeChat notifications: On",
    "○ Question notifications: On",
    "○ Permission notifications: On",
    "○ Session error notifications: On",
  ].join("\n")
  let submenuReadCount = 0

  const result = await openWechatNotificationsSubmenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount === 1) {
        return pluginMenuScreen(Math.min(downCount, 12))
      }

      if (enterCount === 2) {
        if (downCount < 12) {
          return pluginMenuScreen(downCount)
        }

        submenuReadCount += 1
        return submenuReadCount === 1 ? partialSubmenuScreen : fullSubmenuScreen
      }

      return fullSubmenuScreen
    },
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "wechat-submenu-visible")
    assert.equal(result.wechatSubmenuScreen, fullSubmenuScreen)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: waits for 微信通知 to be selected before pressing Enter into submenu", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "Bind / Rebind WeChat",
    "WeChat notifications: On",
    "Question notifications: On",
  ].join("\n")

  const result = await openWechatNotificationsSubmenuThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    menuOpenAttempts: 1,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount >= 2 && downCount >= 13) {
        return submenuScreen
      }

      return pluginMenuScreen(Math.max(0, Math.min(downCount - 1, 12)))
    },
    screenWaitTimeoutMs: 40,
    menuNavigationDelayMs: 0,
    inputChangeTimeoutMs: 5,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.reachedWechatSubmenu, true)
    assert.match(result.wechatSubmenuScreen, /Bind \/ Rebind WeChat/)
    assert.equal(sentInputs.filter((input) => input === "\u001b[B").length, 13)
    assert.equal(sentInputs.at(-1), "\r")
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: openWechatNotificationsSubmenuThroughRealOpencode stops PTY on submenu failure", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  let killCount = 0
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write() {},
    kill() {
      killCount += 1
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const screens = [
    "T  Add credential",
    "GitHub Copilot 账号\n通用设置\n微信通知\nProvider 专属设置",
    "GitHub Copilot 账号\n通用设置\n微信通知\nProvider 专属设置",
  ]
  let readCount = 0

  await assert.rejects(
    openWechatNotificationsSubmenuThroughRealOpencode({
      host: {
        hostRoot: "C:/tmp/opencode-host",
        cacheRoot: "C:/tmp/opencode-host/cache",
        configRoot: "C:/tmp/opencode-host/config",
        dataRoot: "C:/tmp/opencode-host/data",
        logRoot: "C:/tmp/opencode-host/logs",
        tmpRoot: "C:/tmp/opencode-host/tmp",
        runtimeCommand: "opencode",
        runtimeArgs: [],
        runtimeKind: "binary",
      },
      artifact: {
        entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
      },
      inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
      spawnPtyImpl: () => fakePty,
      readScreenImpl: async () => screens[Math.min(readCount++, screens.length - 1)],
      menuOpenAttempts: 2,
      screenWaitTimeoutMs: 10,
      menuNavigationDelayMs: 0,
    }),
    /menu buffer did not match/,
  )

  assert.equal(killCount, 2)
})

test("real host PTY helper: 微信通知子菜单后会 DOWN + ENTER 真正执行绑定并按最终结果分类", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "● Back",
    "○ Bind / Rebind WeChat",
    "WeChat notifications: On",
  ].join("\n")
  const submenuBindSelectedScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "WeChat notifications: On",
  ].join("\n")
  const bindDispatchScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "Dispatching bind...",
  ].join("\n")

  const result = await runRealWechatBindAndClassify({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount === 1) {
        return pluginMenuScreen(Math.min(downCount, 12))
      }

      if (enterCount === 2) {
        if (downCount >= 13) {
          return submenuBindSelectedScreen
        }

        return downCount >= 12 ? submenuScreen : pluginMenuScreen(downCount)
      }

      return bindDispatchScreen
    },
    readRealHostLogTextImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount >= 3 && downCount >= 13) {
        return "QR URL fallback: https://host-gate.invalid/qr"
      }

      return ""
    },
    screenWaitTimeoutMs: 10,
    menuNavigationDelayMs: 0,
    bindOutcomeTimeoutMs: 10,
    bindOutcomePollIntervalMs: 0,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 1,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, false)
    assert.equal(result.stage, "qr-wait-reached")
    assert.equal(result.reachedAddCredential, true)
    assert.equal(result.reachedPluginMenu, true)
    assert.equal(result.reachedWechatSubmenu, true)
    assert.equal(result.reachedBindAction, true)
    assert.match(result.wechatSubmenuScreen, /Bind \/ Rebind WeChat/)
    assert.match(result.logText, /host-gate\.invalid\/qr/i)
    assert.match(result.error, /host-gate\.invalid\/qr/i)
    assert.equal(sentInputs.filter((input) => input === "\u001b[B").length, 13)
    assert.deepEqual(sentInputs.slice(-2), ["\u001b[B", "\r"])
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: bind 执行前会先把子菜单焦点移回 绑定 / 重绑微信", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuToggleSelectedScreen = [
    "WeChat notifications",
    "○ Back",
    "○ Bind / Rebind WeChat",
    "● WeChat notifications: On",
    "○ Question notifications: On",
  ].join("\n")
  const submenuBindSelectedScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "○ WeChat notifications: On",
    "○ Question notifications: On",
  ].join("\n")
  const bindDispatchScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "Dispatching bind...",
  ].join("\n")
  const wrongActionScreen = [
    "WeChat notifications",
    "○ Back",
    "○ Bind / Rebind WeChat",
    "● Question notifications: On",
  ].join("\n")

  const result = await runRealWechatBindAndClassify({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length
      const upCount = sentInputs.filter((input) => input === "\u001b[A").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount === 1) {
        return pluginMenuScreen(Math.min(downCount, 12))
      }

      if (enterCount === 2) {
        if (upCount >= 1) {
          return submenuBindSelectedScreen
        }

        return downCount >= 12 ? submenuToggleSelectedScreen : pluginMenuScreen(downCount)
      }

      return upCount >= 1 ? bindDispatchScreen : wrongActionScreen
    },
    readRealHostLogTextImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const upCount = sentInputs.filter((input) => input === "\u001b[A").length

      if (enterCount >= 3 && upCount >= 1) {
        return "QR URL fallback: https://host-gate.invalid/qr"
      }

      return ""
    },
    screenWaitTimeoutMs: 10,
    menuNavigationDelayMs: 0,
    bindOutcomeTimeoutMs: 10,
    bindOutcomePollIntervalMs: 0,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, false)
    assert.equal(result.stage, "qr-wait-reached")
    assert.equal(result.bindActionScreen, bindDispatchScreen)
    assert.equal(sentInputs.at(-2), "\u001b[A")
    assert.equal(sentInputs.at(-1), "\r")
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: 旧二维码日志不会把尚未产出新二维码结果的本次 bind 误判成 qr-wait", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "WeChat notifications: On",
  ].join("\n")
  const submenuBindSelectedScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "WeChat notifications: On",
  ].join("\n")
  const bindDispatchScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "Dispatching bind...",
  ].join("\n")

  const result = await runRealWechatBindAndClassify({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount === 1) {
        return pluginMenuScreen(Math.min(downCount, 12))
      }

      if (enterCount === 2) {
        if (downCount >= 13) {
          return submenuBindSelectedScreen
        }

        return downCount >= 12 ? submenuScreen : pluginMenuScreen(downCount)
      }

      return bindDispatchScreen
    },
    readRealHostLogTextImpl: async () => "historical qr login complete\nsessionKey=stale-session",
    screenWaitTimeoutMs: 10,
    menuNavigationDelayMs: 0,
    bindOutcomeTimeoutMs: 10,
    bindOutcomePollIntervalMs: 0,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, false)
    assert.equal(result.stage, "menu-chain-failed")
    assert.equal(result.reachedBindAction, true)
    assert.match(result.transcript, /Dispatching bind/i)
    assert.equal(result.logText, "")
    assert.doesNotMatch(result.error, /sessionKey|qr login/i)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY helper: 最后一跳被吞且没有新屏新日志时不会被旧二维码日志误判通过", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }
  const pluginMenuScreen = (selectedIndex) => {
    const selectedLabel = selectedIndex === 12 ? "WeChat notifications" : `Menu item ${selectedIndex}`
    return [
      "GitHub Copilot accounts",
      `Selected: ${selectedLabel}`,
      "Guided Loop Safety",
      selectedIndex === 12 ? "● WeChat notifications" : "○ WeChat notifications",
      "Provider settings",
    ].join("\n")
  }
  const submenuScreen = [
    "WeChat notifications",
    "○ Back",
    "● Bind / Rebind WeChat",
    "WeChat notifications: On",
  ].join("\n")

  const result = await runRealWechatBindAndClassify({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    artifact: {
      entryFilePath: "C:/repo/opencode-copilot-account-switcher/dist/index.js",
    },
    inlineConfigContent: JSON.stringify({ plugin: ["C:/repo/opencode-copilot-account-switcher/dist/index.js"] }),
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => {
      const enterCount = sentInputs.filter((input) => input === "\r").length
      const downCount = sentInputs.filter((input) => input === "\u001b[B").length

      if (enterCount === 0) {
        return "T  Add credential"
      }

      if (enterCount === 1) {
        return pluginMenuScreen(Math.min(downCount, 12))
      }

      return submenuScreen
    },
    readRealHostLogTextImpl: async () => "historical qr login complete\nsessionKey=stale-session",
    screenWaitTimeoutMs: 10,
    menuNavigationDelayMs: 0,
    bindOutcomeTimeoutMs: 10,
    bindOutcomePollIntervalMs: 0,
    inputChangeTimeoutMs: 10,
    inputRetryAttempts: 0,
    inputPollIntervalMs: 0,
  })

  try {
    assert.equal(result.ok, false)
    assert.equal(result.stage, "menu-chain-failed")
    assert.equal(result.reachedBindAction, true)
    assert.equal(result.transcript, "")
    assert.equal(result.logText, "")
    assert.doesNotMatch(result.error, /sessionKey|qr login/i)
  } finally {
    await stopRealOpencodePty(result.session)
  }
})

test("real host PTY supplemental plugin menu: providers login waits for Add credential, sends Enter, then reaches dist entry plugin menu", { timeout: 180_000 }, async () => {
  await runExclusiveRealHostPtyTest(async () => {
  const pluginPackageRoot = await ensureBuiltPluginPackageRoot()
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
  })

  assert.equal(host.ok, true)

  const inlineConfigContent = await resolveRealHostPluginInlineConfigContent({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
  })

  const result = await openGitHubCopilotPluginMenuThroughRealOpencode({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
    inlineConfigContent,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "plugin-menu-visible")
    assert.equal(result.reachedAddCredential, true)
    assert.equal(result.reachedPluginMenu, true)

    if (process.platform === "win32") {
      assert.match(result.session.command, /opencode\.exe$/i)
      assert.deepEqual(result.session.args, PROVIDERS_LOGIN_GITHUB_COPILOT_ARGS)
    }

    assert.match(result.addCredentialScreen, /Add credential/i)
    const pluginMenuScreen = result.pluginMenuScreen
    assert.match(pluginMenuScreen, /Guided Loop Safety/i)
    assert.match(pluginMenuScreen, /Common settings|通用设置/i)
    assert.match(pluginMenuScreen, /Provider 专属设置|Provider settings/i)
    assert.doesNotMatch(pluginMenuScreen, /MCP Authentication Required/i)
    assert.doesNotMatch(pluginMenuScreen, /Select model/i)
    assert.doesNotMatch(pluginMenuScreen, /opencode completion|show resolved configuration/i)
  } finally {
    await stopRealOpencodePty(result.session, { gracefulInputs: ["\u001b"] })
    await host.cleanup()
  }
  })
})

test("real host wechat submenu: providers login reaches 微信通知 -> 绑定 / 重绑微信", { timeout: 180_000 }, async () => {
  await runExclusiveRealHostPtyTest(async () => {
  const pluginPackageRoot = await ensureBuiltPluginPackageRoot()
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
  })

  assert.equal(host.ok, true)

  const inlineConfigContent = await resolveRealHostPluginInlineConfigContent({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
  })

  const result = await openWechatNotificationsSubmenuThroughRealOpencode({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
    inlineConfigContent,
  })

  try {
    assert.equal(result.ok, true)
    assert.equal(result.stage, "wechat-submenu-visible")
    assert.equal(result.reachedAddCredential, true)
    assert.equal(result.reachedPluginMenu, true)
    assert.equal(result.reachedWechatSubmenu, true)

    assert.match(result.addCredentialScreen, /Add credential/i)
    assert.match(result.pluginMenuScreen, /WeChat notifications|微信通知/)
    const submenuScreen = result.wechatSubmenuScreen
    assert.match(submenuScreen, /Bind \/ Rebind WeChat|绑定 \/ 重绑微信/i)
    assert.match(submenuScreen, /WeChat notifications: On|微信通知总开关：已开启|微信通知：已开启/i)
    assert.match(submenuScreen, /Question notifications: On|问题通知：已开启/i)
    assert.match(submenuScreen, /Permission notifications: On|权限通知：已开启|授权通知：已开启/i)
    assert.match(submenuScreen, /Session error notifications: On|会话错误通知：已开启/i)
  } finally {
    await stopRealOpencodePty(result.session, { gracefulInputs: ["\u001b"] })
    await host.cleanup()
  }
  })
})

test("real host wechat bind: providers login 真正执行 绑定 / 重绑微信 并返回最终分类", { timeout: 240_000 }, async () => {
  await runExclusiveRealHostPtyTest(async () => {
  const pluginPackageRoot = await ensureBuiltPluginPackageRoot()
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
  })

  assert.equal(host.ok, true)

  const inlineConfigContent = await resolveRealHostPluginInlineConfigContent({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
  })

  const result = await runRealWechatBindAndClassify({
    host,
    artifact: {
      entryFilePath: path.join(pluginPackageRoot, "dist", "index.js"),
    },
    inlineConfigContent,
    bindOutcomeTimeoutMs: 120_000,
  })

  try {
    assert.equal(result.ok, false)
    assert.equal(result.reachedAddCredential, true)
    assert.equal(result.reachedPluginMenu, true)
    assert.equal(result.reachedWechatSubmenu, true)
    assert.equal(result.reachedBindAction, true)
    assert.match(result.wechatSubmenuScreen, /Bind \/ Rebind WeChat|绑定 \/ 重绑微信/i)
    assert.match(result.stage, /^(wechat-bind-import-failed|wechat-bind-runtime-failed|qr-wait-reached)$/)

    if (result.stage === "wechat-bind-import-failed") {
      assert.match(result.error, /wechat bind failed:/i)
      assert.match(result.error, /Missing 'default' export/i)
    }

    if (result.stage === "wechat-bind-runtime-failed") {
      assert.match(result.error, /wechat bind failed:/i)
      assert.doesNotMatch(result.error, /Missing 'default' export/i)
    }

    if (result.stage === "qr-wait-reached") {
      assert.match(result.error, /QR URL fallback:|sessionKey|qr login|[█▄▀]{20,}/i)
    }
  } finally {
    await stopRealOpencodePty(result.session, { gracefulInputs: ["\u001b"] })
    await host.cleanup()
  }
  })
})

test("real host helper menu chain: drives 微信通知 -> 绑定 / 重绑微信 through PTY screen polling helpers", async () => {
  const dataEmitter = new EventEmitter()
  const exitEmitter = new EventEmitter()
  const sentInputs = []
  const fakePty = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "opencode",
    handleFlowControl: false,
    onData(listener) {
      dataEmitter.on("data", listener)
      return { dispose: () => dataEmitter.off("data", listener) }
    },
    onExit(listener) {
      exitEmitter.on("exit", listener)
      return { dispose: () => exitEmitter.off("exit", listener) }
    },
    write(input) {
      sentInputs.push(input)
    },
    kill() {
      exitEmitter.emit("exit", { exitCode: 0 })
    },
  }

  const buffers = [
    "GitHub Copilot 账号\n操作\n微信通知",
    "GitHub Copilot 账号\n操作\n> 微信通知\n绑定 / 重绑微信",
    "微信通知\n> 绑定 / 重绑微信",
  ]
  let readCount = 0

  const result = await runWechatBindThroughRealOpencode({
    host: {
      hostRoot: "C:/tmp/opencode-host",
      cacheRoot: "C:/tmp/opencode-host/cache",
      configRoot: "C:/tmp/opencode-host/config",
      dataRoot: "C:/tmp/opencode-host/data",
      logRoot: "C:/tmp/opencode-host/logs",
      tmpRoot: "C:/tmp/opencode-host/tmp",
      runtimeCommand: "opencode",
      runtimeArgs: [],
      runtimeKind: "binary",
    },
    spawnPtyImpl: () => fakePty,
    readScreenImpl: async () => buffers[Math.min(readCount++, buffers.length - 1)],
  })

  assert.equal(result.ok, true)
  assert.equal(result.stage, "menu-chain-reached")
  assert.equal(result.reachedWechatMenu, true)
  assert.equal(result.reachedBindAction, true)
  assert.deepEqual(sentInputs.slice(0, 2), ["\r", "\r"])
})

test("real host classification: preserves raw wechat bind error text when host reproduces import failure", () => {
  const result = classifyRealOpencodeWechatBindResult({
    transcript: "wechat bind failed: Missing 'default' export in module '...json5/lib/index.js'.",
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, "wechat-bind-import-failed")
  assert.match(result.error, /json5\/lib\/index\.js/i)
})

test("real host classification: qr wait is not reported as generic success", () => {
  const result = classifyRealOpencodeWechatBindResult({
    transcript: "QR URL fallback: https://host-gate.invalid/qr",
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, "qr-wait-reached")
  assert.match(result.error, /host-gate\.invalid\/qr/i)
})

test("real host classification: terminal qr block canvas is treated as qr wait", () => {
  const qrCanvas = [
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
    "█ ▄▄▄▄▄ █▀▀ ███  ▀█▀▄▄▀▄ █▀▀ ▄█ ▄▄▄▄▄ █",
    "█ █   █ █▄▀██▀█▄▀ ▄█▀▄██ ▀▀ ▄██ █   █ █",
    "█ █▄▄▄█ █ ▄ █ ▀█  ▀▀▀▀█ ▄▄▄▄ ▀█ █▄▄▄█ █",
    "█▄▄▄▄▄▄▄█ █ ▀▄█ ▀ ▀▄▀ ▀ ▀▄█ ▀ █▄▄▄▄▄▄▄█",
    "█▄▄█▄██▄ ▀██   ▀▄▀▀██▄ █▄█▄▄█▀▀ ▄▄▀ ▄▀█",
    "█▄ ▄█ █▄█▀▄   ▀▄▀▀▄█▄▄ ▀█▀ ▄█ ▀██ ▀▄▀ █",
    "██ ▀▀  ▄▀▀▄▀ █▀▄██  ▀█ ▄█ █▀▄ ▄ ▀████ █",
  ].join("\n")

  const result = classifyRealOpencodeWechatBindResult({
    transcript: [
      "┌  微信通知",
      "│  ● 绑定 / 重绑微信",
      qrCanvas,
    ].join("\n"),
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, "qr-wait-reached")
  assert.match(result.error, /[█▄▀]/)
  assert.doesNotMatch(result.error, /QR URL fallback:|sessionKey|qr login|wechat bind failed:/i)
})

test("real host classification: keeps non-import wechat bind failures as runtime failures", () => {
  const result = classifyRealOpencodeWechatBindResult({
    transcript: "wechat bind failed: socket hang up",
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, "wechat-bind-runtime-failed")
  assert.match(result.error, /socket hang up/i)
})

test("real host classification: falls back to menu-chain-failed for empty or unknown output", () => {
  assert.deepEqual(
    classifyRealOpencodeWechatBindResult({ transcript: "", logText: "" }),
    {
      ok: false,
      stage: "menu-chain-failed",
      error: "unknown real-host failure",
    },
  )

  const unknownResult = classifyRealOpencodeWechatBindResult({
    transcript: "unexpected host output",
  })

  assert.equal(unknownResult.ok, false)
  assert.equal(unknownResult.stage, "menu-chain-failed")
  assert.match(unknownResult.error, /unexpected host output/i)
})
