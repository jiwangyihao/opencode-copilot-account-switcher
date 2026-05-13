import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const FORBIDDEN_WECHAT_PUBLIC_EXPORTS = [
  "OpenCodeWechat",
  "WECHAT_PROVIDER_DESCRIPTOR",
  "WechatProviderDescriptor",
  "WeChatProviderDescriptor",
  "handleWechatProviderAction",
  "handleWeChatProviderAction",
  "runWechatBindFlow",
]

function assertNoWechatPublicExportNames(names) {
  for (const name of FORBIDDEN_WECHAT_PUBLIC_EXPORTS) {
    assert.equal(names.includes(name), false, name)
  }
  assert.equal(names.some((name) => /wechat/i.test(name)), false, names.join(","))
}

test("package root source exports only Copilot account switcher", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(source, /CopilotAccountSwitcher/)
  assert.doesNotMatch(source, /OpenAICodexAccountSwitcher/)
  for (const name of FORBIDDEN_WECHAT_PUBLIC_EXPORTS) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), name)
  }
  assert.doesNotMatch(source, /wechat/i)
})

test("package root dist exports only Copilot switcher", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")
  const distTypeSource = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")

  assert.equal(typeof indexExports.CopilotAccountSwitcher, "function")
  assert.equal(indexExports.CopilotAccountSwitcher, pluginExports.CopilotAccountSwitcher)
  assert.equal("OpenAICodexAccountSwitcher" in indexExports, false)
  assert.equal("OpenAICodexAccountSwitcher" in pluginExports, false)
  assertNoWechatPublicExportNames(Object.keys(indexExports))
  assertNoWechatPublicExportNames(Object.keys(pluginExports))

  assert.match(distTypeSource, /CopilotAccountSwitcher/)
  assert.doesNotMatch(distTypeSource, /OpenAICodexAccountSwitcher/)
  for (const name of FORBIDDEN_WECHAT_PUBLIC_EXPORTS) {
    assert.doesNotMatch(distTypeSource, new RegExp(`\\b${name}\\b`), name)
  }
  assert.doesNotMatch(distTypeSource, /wechat/i)
})
