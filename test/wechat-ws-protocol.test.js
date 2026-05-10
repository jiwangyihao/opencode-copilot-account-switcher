import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test, { after } from "node:test"
import { setupIsolatedWechatStateRoot } from "./helpers/wechat-state-root.js"

const isolatedWechatStateRoot = await setupIsolatedWechatStateRoot("wechat-ws-protocol-")

after(async () => {
  await isolatedWechatStateRoot.restore()
})

function importProtocol(label) {
  return import(`../dist/wechat/protocol.js?reload=${Date.now()}-${label}`)
}

function importStatePaths(label) {
  return import(`../dist/wechat/state-paths.js?reload=${Date.now()}-${label}`)
}

test("ws protocol: commandAccepted 与 commandResult 都属于 sequenced event", async () => {
  const protocol = await importProtocol("command-events")

  const accepted = protocol.createBridgeEventEnvelope({
    type: "commandAccepted",
    eventSeq: 11,
    instanceIncarnation: "inc-1",
    payload: {
      commandId: "cmd-1",
      acceptedAt: 1_700_000_100_000,
    },
  })

  assert.equal(accepted.eventSeq, 11)
  assert.equal(accepted.type, "commandAccepted")
  assert.equal(accepted.instanceIncarnation, "inc-1")
  assert.equal("brokerSeq" in accepted, false)
  assert.equal("controlId" in accepted, false)

  const result = protocol.createBridgeEventEnvelope({
    type: "commandResult",
    eventSeq: 12,
    instanceIncarnation: "inc-1",
    payload: {
      commandId: "cmd-1",
      status: "completed",
      completedAt: 1_700_000_200_000,
    },
  })

  assert.equal(result.eventSeq, 12)
  assert.equal(result.type, "commandResult")
  assert.equal(result.instanceIncarnation, "inc-1")
  assert.equal("brokerSeq" in result, false)
})

test("ws protocol: requestReplay 与 requestFullSync 是 control frame，不属于 command", async () => {
  const protocol = await importProtocol("control-frames")

  const replay = protocol.createBrokerControlEnvelope({
    type: "requestReplay",
    brokerSeq: 21,
    controlId: "ctl-1",
    payload: {
      instanceID: "inst-1",
      instanceIncarnation: "inc-1",
      fromEventSeq: 9,
      toEventSeq: 12,
    },
  })

  assert.equal(replay.brokerSeq, 21)
  assert.equal(replay.controlId, "ctl-1")
  assert.equal(replay.type, "requestReplay")
  assert.equal("commandId" in replay, false)
  assert.equal("eventSeq" in replay, false)

  const fullSync = protocol.createBrokerControlEnvelope({
    type: "requestFullSync",
    brokerSeq: 22,
    controlId: "ctl-2",
    payload: {
      instanceID: "inst-1",
      instanceIncarnation: "inc-1",
      reason: "log-gap",
    },
  })

  assert.equal(fullSync.brokerSeq, 22)
  assert.equal(fullSync.controlId, "ctl-2")
  assert.equal(fullSync.type, "requestFullSync")
  assert.equal("commandId" in fullSync, false)
})

test("ws protocol: hello/register 与 registerAck 带 protocolVersion/stateGeneration/instanceIncarnation", async () => {
  const protocol = await importProtocol("register")

  const hello = protocol.createHelloRegisterEnvelope({
    protocolVersion: 2,
    stateGeneration: "wechat-ws-v1",
    instanceID: "inst-1",
    instanceIncarnation: "inc-1",
    lastSeenBrokerSeq: 7,
    lastSentEventSeq: 18,
  })

  assert.equal(hello.type, "hello/register")
  assert.equal(hello.payload.protocolVersion, 2)
  assert.equal(hello.payload.stateGeneration, "wechat-ws-v1")
  assert.equal(hello.payload.instanceIncarnation, "inc-1")

  const ack = protocol.createRegisterAckEnvelope({
    protocolVersion: 2,
    stateGeneration: "wechat-ws-v1",
    instanceIncarnation: "inc-1",
    brokerSeq: 19,
    needReplay: true,
    needFullSync: false,
  })

  assert.equal(ack.type, "registerAck")
  assert.equal(ack.payload.protocolVersion, 2)
  assert.equal(ack.payload.stateGeneration, "wechat-ws-v1")
  assert.equal(ack.payload.instanceIncarnation, "inc-1")
  assert.equal(ack.payload.needReplay, true)
  assert.equal(ack.payload.needFullSync, false)
})

test("state paths: broker-state-store 与 broker.json 启动元数据分路径", async () => {
  const statePaths = await importStatePaths("broker-state-store-paths")
  const root = statePaths.wechatStateRoot()

  assert.equal(statePaths.brokerStatePath(), path.join(root, "broker.json"))
  assert.notEqual(statePaths.brokerStateStorePath(), statePaths.brokerStatePath())
  assert.notEqual(statePaths.brokerStateSchemaPath(), statePaths.brokerStatePath())
  assert.equal(statePaths.brokerStateStorePath(), path.join(root, "broker-state-store.json"))
  assert.equal(statePaths.brokerStateSchemaPath(), path.join(root, "broker-state-store.schema.json"))
})

test("default npm test: 新 WS 模型下完整测试集可以自然结束", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(typeof packageJson.scripts?.test, "string")
  assert.equal(typeof packageJson.scripts?.["test:serial:wechat-ws-core"], "string")
  assert.equal(typeof packageJson.scripts?.["test:serial:wechat-openclaw-task3"], "string")
  assert.equal(typeof packageJson.scripts?.["test:parallel:shard"], "string")

  assert.match(packageJson.scripts.test, /npm run test:serial:wechat-status-flow:early/)
  assert.match(packageJson.scripts.test, /npm run test:serial:wechat-ws-core/)
  assert.match(packageJson.scripts.test, /npm run test:serial:wechat-notification-flow/)
  assert.match(packageJson.scripts.test, /npm run test:serial:wechat-openclaw-task3/)
  assert.match(packageJson.scripts.test, /npm run test:serial:wechat-status-flow:late/)
  assert.match(packageJson.scripts.test, /npm run test:parallel:shard/)
  assert.doesNotMatch(packageJson.scripts.test, /--watch/)

  assert.match(packageJson.scripts["test:serial:wechat-ws-core"], /test\/wechat-ws-protocol\.test\.js/)
  assert.match(packageJson.scripts["test:serial:wechat-ws-core"], /test\/wechat-broker-state-store\.test\.js/)
  assert.match(packageJson.scripts["test:serial:wechat-ws-core"], /test\/wechat-broker-ws-lifecycle\.test\.js/)
  assert.match(packageJson.scripts["test:serial:wechat-openclaw-task3"], /test\/wechat-openclaw-task3\.test\.js/)
  assert.doesNotMatch(packageJson.scripts["test:parallel:shard"], /test\/wechat-openclaw-task3\.test\.js/)
  assert.match(packageJson.scripts["test:parallel:shard"], /test\/wechat-plugin-hooks-status\.test\.js/)
})
