# WeChat WS Compat 清理设计

## 背景

当前 broker↔bridge 已有新的 WS 主路径，但运行时仍残留多条 compat / sidecar 分支：

1. **旧 transport 仍在主路径附近存活**
   - `registerInstance`
   - `heartbeat`
   - `statusSnapshot`
   - `syncWechatNotifications`
   - 旧 `reply*Result` envelope
2. **部分用户能力仍借 compat sidecar 闭环**
   - `showFallbackToast` 仍依赖 compat `sessionToken + registrationEpoch`
   - 一些 diagnostics 仍以 compat 语义为主
3. **旧 store 仍在运行时语义里残留角色**
   - `instances/requests/notifications/tokens` 不只是历史导入材料，还会影响当前代码理解与行为边界

这和“WS 主路径已经成为唯一健康模型”的目标不一致。用户已经明确要求：**把旧非 WS 路径代码全面清空，但现有微信用户体验不能缩水。**

## 目标

1. 让 `broker-state-store` 成为 broker↔bridge 运行时的唯一真相源。
2. 从主路径彻底移除 compat transport：
   - `registerInstance`
   - `heartbeat`
   - `statusSnapshot`
   - `syncWechatNotifications`
   - 旧 `reply*Result` fallback
   - compat `showFallbackToast` sidecar
3. 保持现有微信用户合同不缩水：
   - `/status`
   - `/reply <qid>`
   - `/allow <handle>`
   - `/reply <s*>`
   - `question / permission / terminal result / natural-stop / retry-error` 文案与状态语义
4. 明确升级策略：旧代际 `qid/handle/s*` 不能退化成 `not found`。

## 非目标

1. 不回退到旧 TCP/NDJSON 模型。
2. 不重新设计微信用户合同本身。
3. 不把 broker 中心节点弱化成去中心化模型。
4. 不把这轮变成“先继续并存，再慢慢删”的长期过渡方案。

## 方案选择

### 方案 A：一次性硬切到单一 WS 主路径

做法：

1. `broker-state-store` 成为唯一运行时真相源。
2. compat transport 与 sidecar 从主路径彻底删除。
3. 旧 store 只保留一次性导入与升级关闭原因用途。

优点：

- 最符合用户“删残余 compat”的目标。
- 收尾后架构边界最清楚。
- 以后再看日志，不会再混着两套语义。

缺点：

- 改动面最大。
- 需要同时重接 fallback toast、slash 查找、terminal/result 语义与 diagnostics。

### 方案 B：内部 adapter 过渡

做法：

- 对外声称只有 WS 主路径，但内部继续保留 adapter，把旧 transport/store 映射进新状态机。

优点：

- 短期实施风险较低。

缺点：

- 会保留用户明确不想要的 compat 残影。
- 日志与故障排查仍然容易混语义。

### 方案 C：先删 transport，后删 store

做法：

- 先彻底去掉旧 transport，再保留旧 store 一轮作为投影或索引。

优点：

- 顺序更保守。

缺点：

- 旧运行时角色还会继续存一轮，不满足当前目标。

### 结论

采用方案 A：**一次性硬切到单一 WS 主路径**。

## 总体架构

### 1. 单一连接模型

broker↔bridge 之间只保留一套长期 WS 连接模型：

1. bridge 通过 `registerHello` 建立连接与代际协商。
2. bridge 只发送 sequenced events。
3. broker 只发送业务命令与 control frame。
4. 活性只由连接层 `ping/pong/close/lastSeen` 判定，不再保留应用层 compat `heartbeat` RPC。

### 2. 单一真相源

`broker-state-store` 是运行时唯一真相源，至少直接持有：

1. 在线实例与连接水位
2. session 概览
3. open `question / permission / natural-stop`
4. `terminal metadata`
5. `retry-error` 摘要
6. 命令账本
7. retained handle occupancy
8. 升级关闭原因索引

`/status`、slash 拒绝、命令处理中/已完成/已失败文案、terminal result 去重，都只能从这里推导。

### 3. 旧 store 的降级角色

`instances/requests/notifications/tokens` 从这轮起退出 broker↔bridge 运行时主路径。它们只允许承担两类作用：

1. 升级时一次性导入最小 retained state
2. 为无法迁移的旧 `qid/handle/s*` 生成稳定升级关闭原因

导入完成后，运行时不再回读这些目录来做 `/status`、slash 或通知判定。

## 设计细节

### 1. 必删的 compat 主路径

以下代码语义必须从运行时主路径移除：

1. `broker-client.ts`
   - `registerInstance`
   - `heartbeat`
   - `statusSnapshot`
   - `syncWechatNotifications`
   - 旧 `reply*Result` fallback 路径
2. `broker-server.ts`
   - compat `registerInstance`
   - compat `heartbeat`
   - compat `statusSnapshot`
   - compat `syncWechatNotifications`
   - compat `showFallbackToast` 处理链
3. `bridge.ts`
   - `registerHello` 后补一次 compat `registerInstance` 的 sidecar
   - steady keepalive 后再做旧 candidate/full-sync 补偿的逻辑

这里的“移除”不是简单把函数删掉，而是：默认运行时、默认测试入口、默认 diagnostics 都不再依赖它们成立。

### 2. fallback toast / diagnostics 的新归属

现有 `showFallbackToast` sidecar 不允许继续依赖 compat `sessionToken + registrationEpoch` 旁路。它必须二选一：

1. 升级成新的 WS 事件/命令语义；或
2. 并入现有 `retryErrorUpdated` / terminal result / command ledger 文案

但无论选哪种，运行时都不能再回退到 compat `showFallbackToast` 旁路。

diagnostics 也要同步切换成新语义：

1. 连接层在线/断开/重放/full sync
2. 命令账本状态推进
3. 事件积压与 ack 水位

旧 `bridgeResyncStarted/Completed`、compat `collectStatusStage` 等语义不能继续作为主语义依赖。

### 3. 用户合同不缩水

这轮必须继续保持：

1. `/status` 直接读权威视图
2. `question / permission` 的 open/closed 文案与稳定关闭提示
3. `terminal result` 最多一条
4. `s*` 唯一性与保留期
5. `ordinary retry-error` informational-only
6. `natural-stop` replyable
7. `/reply` / `/allow` / `/reply <s*>` 在 `accepted / completed / failed / terminal` 下的稳定文案

如果旧 retained state 无法被迁移，也必须返回稳定升级关闭原因，而不是 `not found`。

### 4. 升级与迁移

升级顺序必须是：

1. 先把现有用户合同完整接到 `broker-state-store`
2. 再切断 live 主路径对旧 compat transport/store 的依赖
3. 最后删除真正不再被读取的 compat 代码和旧 diagnostics 语义

对于升级前已经存在的旧 `qid/handle/s*`：

1. 能迁移的 retained state 就迁进 `broker-state-store`
2. 不能迁移的必须生成稳定升级关闭原因
3. 禁止退化成 `not found`

## 测试策略

至少覆盖：

1. **连接层/协议**
   - 默认运行时不再出现 compat `registerInstance/heartbeat/statusSnapshot/syncWechatNotifications`
   - `registerHello + ack + commandAccepted/commandResult + replay/fullSync` 覆盖真实 live path
2. **用户合同**
   - `/status` 只读 `broker-state-store`
   - `/reply` / `/allow` / `/reply <s*>` 的 `accepted/completed/failed/terminal` 文案不缩水
   - `terminal result` 最多一条
   - `s*` 唯一性与保留期继续成立
   - `ordinary retry-error` 仍 informational-only
3. **升级**
   - 旧代际 `qid/handle/s*` 不退化成 `not found`
   - 无法迁移的 retained state 落成稳定升级关闭原因
   - 用户不需要手工清状态目录才能恢复
4. **删除验证**
   - fresh `npm test` 仍自然结束
   - diagnostics 不再把旧 `bridgeResyncStarted/Completed`、compat `collectStatusStage` 当主语义依赖

## 成功判定

1. 代码里不再存在“WS 主路径 + compat sidecar 并行”的运行时依赖。
2. `broker-state-store` 成为唯一运行时真相源。
3. 旧 `instances/requests/notifications/tokens` 从运行时主路径退出，只剩迁移/关闭承接作用。
4. `/status`、question/permission/terminal result/natural-stop/retry-error 的用户行为不缩水。
5. 旧代际 `qid/handle/s*` 仍有稳定用户可见结果，不退化成 `not found`。
