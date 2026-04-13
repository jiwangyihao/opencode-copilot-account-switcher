import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFile, rm, writeFile } from "node:fs/promises"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-operator-store-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

const operatorStore = await import("../dist/wechat/operator-store.js")
const statePaths = await import("../dist/wechat/state-paths.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("首次绑定 wechatAccountId + userId 成功", async () => {
  const binding = await operatorStore.bindOperator({
    wechatAccountId: "wx-a",
    userId: "user-1",
    boundAt: 1_700_000_000_000,
  })

  assert.deepEqual(binding, {
    wechatAccountId: "wx-a",
    userId: "user-1",
    boundAt: 1_700_000_000_000,
  })

  const current = await operatorStore.readOperatorBinding()
  assert.deepEqual(current, binding)
})

test("第二个用户绑定被拒绝", async () => {
  await operatorStore.bindOperator({
    wechatAccountId: "wx-b",
    userId: "user-a",
    boundAt: 1_700_000_000_010,
  })

  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "wx-b",
      userId: "user-b",
      boundAt: 1_700_000_000_020,
    }),
    (error) => {
      assert.match(String(error?.message), /already bound/i)
      return true
    },
  )
})

test("显式 reset 后允许重新绑定", async () => {
  await operatorStore.bindOperator({
    wechatAccountId: "wx-c",
    userId: "user-old",
    boundAt: 1_700_000_000_030,
  })

  await operatorStore.resetOperatorBinding()

  const rebound = await operatorStore.bindOperator({
    wechatAccountId: "wx-c",
    userId: "user-new",
    boundAt: 1_700_000_000_040,
  })

  assert.equal(rebound.userId, "user-new")
})

test("operator.json 落盘字段固定为 wechatAccountId、userId、boundAt", async () => {
  const expected = {
    wechatAccountId: "wx-d",
    userId: "user-9",
    boundAt: 1_700_000_000_050,
  }

  await operatorStore.bindOperator(expected)

  const raw = await readFile(statePaths.operatorStatePath(), "utf8")
  const parsed = JSON.parse(raw)

  assert.deepEqual(parsed, expected)
  assert.deepEqual(Object.keys(parsed).sort(), ["boundAt", "userId", "wechatAccountId"])
})

test("bindOperator 在 wechatAccountId 非法时抛错且不写脏文件", async () => {
  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "",
      userId: "user-1",
      boundAt: 1_700_000_000_060,
    }),
    /invalid operator binding format/,
  )

  await assert.rejects(
    () => readFile(statePaths.operatorStatePath(), "utf8"),
    (error) => {
      assert.equal(error?.code, "ENOENT")
      return true
    },
  )
})

test("bindOperator 在 userId 非法时抛错且不写脏文件", async () => {
  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "wx-e",
      userId: "",
      boundAt: 1_700_000_000_070,
    }),
    /invalid operator binding format/,
  )

  await assert.rejects(
    () => readFile(statePaths.operatorStatePath(), "utf8"),
    (error) => {
      assert.equal(error?.code, "ENOENT")
      return true
    },
  )
})

test("bindOperator 在 boundAt 非法时抛错且不写脏文件", async () => {
  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "wx-f",
      userId: "user-3",
      boundAt: Number.NaN,
    }),
    /invalid operator binding format/,
  )

  await assert.rejects(
    () => readFile(statePaths.operatorStatePath(), "utf8"),
    (error) => {
      assert.equal(error?.code, "ENOENT")
      return true
    },
  )
})

test("bindOperator 拒绝空白 wechatAccountId / userId", async () => {
  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "   ",
      userId: "user-space",
      boundAt: 1_700_000_000_080,
    }),
    /invalid operator binding format/i,
  )

  await assert.rejects(
    () => operatorStore.bindOperator({
      wechatAccountId: "wx-space",
      userId: "\t\n",
      boundAt: 1_700_000_000_090,
    }),
    /invalid operator binding format/i,
  )
})

test("readOperatorBinding 拒绝空白 wechatAccountId / userId", async () => {
  await operatorStore.resetOperatorBinding()
  await statePaths.ensureWechatStateLayout()

  await assert.rejects(
    async () => {
      await writeFile(
        statePaths.operatorStatePath(),
        JSON.stringify({
          wechatAccountId: "  ",
          userId: "user-1",
          boundAt: 1_700_000_000_100,
        }),
      )
      return operatorStore.readOperatorBinding()
    },
    /invalid operator binding format/i,
  )

  await assert.rejects(
    async () => {
      await writeFile(
        statePaths.operatorStatePath(),
        JSON.stringify({
          wechatAccountId: "wx-1",
          userId: "\n\t",
          boundAt: 1_700_000_000_110,
        }),
      )
      return operatorStore.readOperatorBinding()
    },
    /invalid operator binding format/i,
  )
})
