import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("package root source exports only Copilot account switcher", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(source, /CopilotAccountSwitcher/)
  assert.doesNotMatch(source, /OpenAICodexAccountSwitcher/)
})

test("package root dist exports only Copilot switcher", async () => {
  const indexExports = await import("../dist/index.js")
  const pluginExports = await import("../dist/plugin.js")
  const distTypeSource = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")

  assert.equal(typeof indexExports.CopilotAccountSwitcher, "function")
  assert.equal(indexExports.CopilotAccountSwitcher, pluginExports.CopilotAccountSwitcher)
  assert.equal("OpenAICodexAccountSwitcher" in indexExports, false)
  assert.equal("OpenAICodexAccountSwitcher" in pluginExports, false)

  assert.match(distTypeSource, /CopilotAccountSwitcher/)
  assert.doesNotMatch(distTypeSource, /OpenAICodexAccountSwitcher/)
})
