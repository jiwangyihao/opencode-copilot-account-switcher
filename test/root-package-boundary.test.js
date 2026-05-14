import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const ROOT_WECHAT_INSTALL_COMMAND = "opencode plugin opencode-wechat@0.1.0 --force -g"
const ALLOWED_ROOT_PUBLIC_EXPORTS = ["CopilotAccountSwitcher"]
const WECHAT_ACTION_PREFIX = ["we", "chat"].join("")
const OPEN_CLAW_PACKAGE_SEGMENT = ["open", "claw"].join("")

const FORBIDDEN_WECHAT_PUBLIC_EXPORTS = [
  "OpenCodeWechat",
  "WECHAT_PROVIDER_DESCRIPTOR",
  "WechatProviderDescriptor",
  "WeChatProviderDescriptor",
  "handleWechatProviderAction",
  "handleWeChatProviderAction",
  "runWechatBindFlow",
]

const FORBIDDEN_ROOT_WECHAT_NEEDLES = [
	`src/${WECHAT_ACTION_PREFIX}`,
	`dist/${WECHAT_ACTION_PREFIX}`,
  `${WECHAT_ACTION_PREFIX}:smoke`,
  `test/${WECHAT_ACTION_PREFIX}-`,
  `@tencent-weixin/${OPEN_CLAW_PACKAGE_SEGMENT}-weixin`,
  OPEN_CLAW_PACKAGE_SEGMENT,
  `${WECHAT_ACTION_PREFIX}-bind`,
  `${WECHAT_ACTION_PREFIX}-export-debug-bundle`,
	`toggle-${WECHAT_ACTION_PREFIX}`,
]

const FORBIDDEN_ROOT_CODEX_NEEDLES = [
	"OpenAICodexAccountSwitcher",
	"CODEX_PROVIDER_DESCRIPTOR",
	"codexAccountsPath",
	"legacyCodexStorePath",
	"codex-accounts.json",
	"codex-store.json",
	"codex-status",
	"sync:codex-snapshot",
	"test/codex-",
]

const FORBIDDEN_README_WECHAT_PATTERNS = [
  /## 微信通知功能(?:\r?\n|$)/,
  /## WeChat Notifications\b/,
  /微信通知现在会覆盖 5 类常见场景/,
  /WeChat notifications now cover five user-facing cases/,
  /### 什么时候可以直接回复(?:\r?\n|$)/,
  /### Replyable entries\b/,
  /Copilot package (?:includes|bundles|owns) WeChat/i,
  /Copilot 包(?:内置|包含|承载)微信/,
  /本包(?:内置|包含|承载)微信/,
]

const TEMP_CONSUMER_DEPENDENCY_STUBS = [
  {
    name: "@opencode-ai/plugin",
    version: "1.2.26",
    source: "export {}\n",
  },
  {
    name: "@opencode-ai/sdk",
    version: "1.2.26",
    source: "export {}\n",
  },
  {
    name: "xdg-basedir",
    version: "5.1.0",
    source: "export const xdgConfig = undefined\nexport const xdgData = undefined\n",
  },
]

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".cts",
  ".d.ts",
  ".js",
  ".json",
  ".mjs",
  ".mts",
  ".ts",
])

function normalize(value) {
  return value.replace(/\\/g, "/")
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value
  return `"${value.replace(/"/g, "\"\"")}"`
}

async function runNpm(args, cwd) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm"
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", ["npm", ...args].map(quoteCmdArg).join(" ")]
    : args

  return execFileAsync(command, commandArgs, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
}

function extensionOf(filePath) {
  const normalized = normalize(filePath)
  if (normalized.endsWith(".d.ts")) return ".d.ts"
  const dot = normalized.lastIndexOf(".")
  return dot === -1 ? "" : normalized.slice(dot)
}

async function collectTextEntries(rootDir, label) {
	const entries = []

  async function visit(current) {
    const currentStat = await stat(current).catch((error) => {
      if (error?.code === "ENOENT") return undefined
      throw error
    })
    if (!currentStat) return

    if (currentStat.isDirectory()) {
      const children = await readdir(current)
      for (const child of children) {
        await visit(join(current, child))
      }
      return
    }

    if (!currentStat.isFile() || !TEXT_EXTENSIONS.has(extensionOf(current))) return
    const relativePath = normalize(current.slice(process.cwd().length + 1))
    const content = await readFile(current, "utf8")
    entries.push({ label, path: relativePath, text: `${relativePath}\n${content}` })
  }

  await visit(rootDir)
	return entries
}

async function collectRelativePaths(rootDir) {
	const paths = []

	async function visit(current) {
		const currentStat = await stat(current).catch((error) => {
			if (error?.code === "ENOENT") return undefined
			throw error
		})
		if (!currentStat) return

		if (currentStat.isDirectory()) {
			const children = await readdir(current)
			for (const child of children) {
				await visit(join(current, child))
			}
			return
		}

		if (!currentStat.isFile()) return
		paths.push(normalize(current.slice(process.cwd().length + 1)))
	}

	await visit(rootDir)
	return paths
}

function assertNoForbiddenNeedles(entries, needles = FORBIDDEN_ROOT_WECHAT_NEEDLES) {
	const failures = []
	for (const entry of entries) {
		const haystack = normalize(entry.text)
		for (const needle of needles) {
			if (haystack.includes(needle)) {
				failures.push(`${entry.label}:${entry.path} contains ${needle}`)
			}
    }
  }

  assert.deepEqual(failures, [])
}

function assertNoWechatPublicExportNames(names) {
  for (const name of FORBIDDEN_WECHAT_PUBLIC_EXPORTS) {
    assert.equal(names.includes(name), false, name)
  }
  assert.equal(names.some((name) => /wechat/i.test(name)), false, names.join(","))
}

function assertOnlyAllowedRootExports(names) {
  const sortedNames = [...names].sort()
  assert.deepEqual(sortedNames, ALLOWED_ROOT_PUBLIC_EXPORTS)
  assertNoWechatPublicExportNames(sortedNames)
}

function readSection(content, startHeading, endHeading) {
  const startIndex = content.indexOf(startHeading)
  assert.notEqual(startIndex, -1, startHeading)
  const endIndex = endHeading ? content.indexOf(endHeading, startIndex + startHeading.length) : -1
  return endIndex === -1 ? content.slice(startIndex) : content.slice(startIndex, endIndex)
}

async function createDependencyStub(stubsRoot, stub) {
  const stubDir = join(stubsRoot, ...stub.name.split("/"))
  await mkdir(stubDir, { recursive: true })
  await writeFile(
    join(stubDir, "package.json"),
    `${JSON.stringify({ name: stub.name, version: stub.version, type: "module", exports: "./index.js" }, null, 2)}\n`,
  )
  await writeFile(join(stubDir, "index.js"), stub.source)
  return [stub.name, `file:${normalize(stubDir)}`]
}

async function createPackArtifact(tempRoot) {
  const packDir = join(tempRoot, "pack")
  await mkdir(packDir)
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", normalize(packDir)], process.cwd())
  const [packInfo] = JSON.parse(stdout)
  assert.ok(packInfo, "npm pack --json should return one packed package")

  return {
    files: packInfo.files.map((entry) => normalize(entry.path)),
    info: packInfo,
    tarballPath: join(packDir, packInfo.filename),
  }
}

async function unpackTarball(tarballPath, destination) {
  await execFileAsync("tar", ["-xzf", tarballPath, "-C", destination], {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
}

async function importFromTemporaryConsumer(tarballPath, packageName, tempRoot) {
  const consumerDir = join(tempRoot, "consumer")
  await mkdir(consumerDir)
  const stubsRoot = join(consumerDir, "stubs")
  const stubDependencies = Object.fromEntries(
    await Promise.all(TEMP_CONSUMER_DEPENDENCY_STUBS.map((stub) => createDependencyStub(stubsRoot, stub))),
  )
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: stubDependencies }, null, 2)}\n`,
  )
  await runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--package-lock=false",
    "--legacy-peer-deps",
    normalize(tarballPath),
  ], consumerDir)

  const driverPath = join(consumerDir, "import-package.mjs")
  await writeFile(
    driverPath,
    `import * as packageExports from ${JSON.stringify(packageName)}\nconsole.log(JSON.stringify(Object.keys(packageExports).sort()))\n`,
  )
  const { stdout } = await execFileAsync(process.execPath, [driverPath], {
    cwd: consumerDir,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  return JSON.parse(stdout)
}

test("root package excludes WeChat runtime from source and dist", async () => {
  const entries = [
    ...(await collectTextEntries(join(process.cwd(), "src"), "source")),
    ...(await collectTextEntries(join(process.cwd(), "dist"), "dist")),
    {
      label: "package-manifest",
      path: "package.json",
      text: normalize(await readFile(join(process.cwd(), "package.json"), "utf8")),
    },
  ]

	assertNoForbiddenNeedles(entries)
	assertNoForbiddenNeedles(entries, FORBIDDEN_ROOT_CODEX_NEEDLES)
})

test("root tests exclude WeChat and OpenClaw fixture files", async () => {
	const paths = await collectRelativePaths(join(process.cwd(), "test"))
	const forbidden = paths.filter((filePath) =>
		/(?:^|\/)(?:wechat-|ui-menu-wechat|fake-openclaw)|openclaw/i.test(filePath),
	)

	assert.deepEqual(forbidden, [])
})

test("README documents WeChat as an independent plugin boundary", async () => {
  const readme = await readFile(join(process.cwd(), "README.md"), "utf8")
  const chineseWechatSection = readSection(readme, "## 微信远程交互", "---")
  const englishWechatSection = readSection(readme, "## WeChat Remote Interaction", "---")

  assert.match(readme, /## 微信远程交互(?:\r?\n|$)/)
  assert.match(readme, /## WeChat Remote Interaction\b/)
  assert.match(readme, new RegExp(`\\b${ROOT_WECHAT_INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`))
  assert.match(chineseWechatSection, new RegExp(`\\b${ROOT_WECHAT_INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`))
  assert.match(englishWechatSection, new RegExp(`\\b${ROOT_WECHAT_INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`))

  const failures = []
  for (const pattern of FORBIDDEN_README_WECHAT_PATTERNS) {
    if (pattern.test(readme)) failures.push(String(pattern))
  }
  assert.deepEqual(failures, [])
})

test("root package tarball excludes WeChat runtime and imports only Copilot root exports", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-root-pack-"))
  try {
    const rootPackage = await readJson(join(process.cwd(), "package.json"))
    const packArtifact = await createPackArtifact(tempRoot)
    const files = packArtifact.files

    assert.equal(packArtifact.info.name, rootPackage.name)
    assert.equal(packArtifact.info.version, rootPackage.version)

    const extractedDir = join(tempRoot, "extracted")
    await mkdir(extractedDir)
    await unpackTarball(packArtifact.tarballPath, extractedDir)
    const extractedPackage = await readJson(join(extractedDir, "package", "package.json"))

    assert.equal(extractedPackage.name, rootPackage.name)
    assert.equal(extractedPackage.version, rootPackage.version)
    assert.equal(normalize(JSON.stringify(extractedPackage.exports ?? {})).includes("wechat"), false)
    assert.equal(normalize(JSON.stringify(extractedPackage.files ?? [])).includes("wechat"), false)

    const installedExportNames = await importFromTemporaryConsumer(
      packArtifact.tarballPath,
      rootPackage.name,
      tempRoot,
    )

    assertOnlyAllowedRootExports(installedExportNames)

    const manifestEntries = [{
      label: "extracted-package-manifest",
      path: "package/package.json",
      text: normalize(JSON.stringify(extractedPackage)),
    }]
    const entries = files.map((filePath) => ({
      label: "pack",
      path: filePath,
      text: filePath,
    }))

		assertNoForbiddenNeedles([...entries, ...manifestEntries])
		assertNoForbiddenNeedles([...entries, ...manifestEntries], FORBIDDEN_ROOT_CODEX_NEEDLES)
	} finally {
		await rm(tempRoot, { force: true, recursive: true })
	}
})
