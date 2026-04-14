# WeChat Reply/Allow Bridge RPC 设计

## 背景

当前 WeChat `/reply` / `/allow` 的实现有一个关键设计错误：broker 独立进程在 `src/wechat/broker-entry.ts` 里直接创建了一个硬编码 `baseUrl = http://localhost:4096` 的 `v2Client`，并试图在 broker 进程里调用 `question.reply()` / `permission.reply()`。

这会导致两类问题：

1. 正常 OpenCode 实例并不保证监听这个 HTTP 地址，很多场景下根本没有任何进程在 `localhost:4096` 上提供 API。
2. broker 侧错误地把“宿主内动作”放到了独立进程里做，从而丢掉了真正已经存在的 broker <-> bridge 长连接能力。

现场已经证明了这一点：WeChat `/reply q2 1` 会被 runtime 识别、request/notification 状态也会被本地写成 `answered/resolved`，但上游 OpenCode 问题并没有真的被处理，说明 broker 当前只是**误把失败当成功**，而不是打通了真实回复链路。

## 目标

1. 让 `/reply` / `/allow` 通过现有 broker <-> bridge 长连接执行真正的宿主回复动作。
2. 让 broker 只在收到 bridge 返回的成功结果后，才本地写 `answered/rejected` 和 `resolved`。
3. 移除 broker 独立进程对假的 `localhost:4096` HTTP API 的依赖。
4. 在失败和超时场景下返回稳定中文错误，而不是本地误报“已回复问题”或“已处理权限请求”。

## 非目标

1. 不重做 `/recover`、通知发送、broker 生命周期或任何其他 WeChat 子系统。
2. 不引入新的外部 HTTP API、轮询服务或跨进程额外 daemon。
3. 不把 broker 改成一个通用 RPC 总线；只补 `/reply` / `/allow` 所需的最小消息类型。

## 方案选择

### 方案 A：复用现有 broker <-> bridge 长连接 RPC

做法：

- broker 通过现有 socket 向目标 bridge 实例发送 `questionReplyRequest` / `permissionReplyRequest`
- bridge 在本进程里使用真实宿主 client 执行 `question.reply()` / `permission.reply()`
- bridge 把结果通过同一通道回给 broker

优点：

- 最贴合现有架构，不再猜宿主 API 地址
- 宿主 client 只在真正有它的进程里调用
- 能自然把“成功后再写本地状态”收成一个清晰的请求/响应边界

缺点：

- 需要给现有 broker 协议补两组最小消息类型

### 方案 B：broker 落本地队列，插件轮询消费

做法：

- broker 把 `/reply` / `/allow` 写进本地队列
- 插件进程周期性轮询并执行

优点：

- 不需要即时 RPC 响应

缺点：

- 引入额外轮询延迟和新状态面
- 比现有长连接更绕，且错误恢复更复杂

### 结论

采用方案 A。当前已经有 broker <-> bridge 长连接，不应该再新造轮询通道。

## 设计细节

### 1. 协议边界

新增最小消息类型：

- `questionReplyRequest`
- `questionReplyResult`
- `permissionReplyRequest`
- `permissionReplyResult`

这些消息只在 broker 和目标 bridge 实例之间流动。

### 2. `/reply` 数据流

1. broker 仍然负责：
   - 根据 `handle` 找到 open request
   - 按题型把文本转换成结构化 `answers`
2. broker 不再直接调用 `question.reply()`，而是向目标 `instanceID` 发送：
   - `requestID`
   - `answers`
   - `mutationId`
3. bridge 收到请求后，在本进程里调用真实宿主的 `input.client.question.reply()`。
4. bridge 将成功/失败结果回传给 broker。
5. broker 只有在 `ok: true` 时，才本地写：
   - `markRequestAnswered(...)`
   - `resolveNotificationForOpenRequest(...)`
6. 如果 bridge 返回失败或超时，则 broker 只返回稳定错误文案，不改本地 request/notification 终态。

### 3. `/allow` 数据流

`/allow` 和 `/reply` 完全同一原则：

1. broker 根据 handle 找到 open permission request
2. broker 向目标 bridge 发送 `permissionReplyRequest`
3. bridge 在本进程里调用真实宿主 `input.client.permission.reply()`
4. broker 只在成功结果返回后，才写 `answered` 或 `rejected`，并 resolve 通知
5. 否则返回稳定错误文案，不本地误写状态

### 4. 成功/失败语义

稳定中文结果：

- question 失败：`回复问题失败：<摘要>`
- permission 失败：`处理权限请求失败：<摘要>`

关键原则：

1. 上游返回 `{ error }` 视为失败
2. bridge RPC 超时视为失败
3. 只有真正成功回执才视为成功
4. broker 本地状态更新永远晚于真实宿主动作成功

## 测试策略

至少覆盖：

1. `/reply` 在 bridge 返回 `ok: true` 时才写本地 `answered`
2. `/reply` 在 bridge 返回 `{ error }` 或超时时不会本地误写 `answered`
3. `/allow` 在 bridge 返回 `ok: true` 时才写 `answered/rejected`
4. `/allow` 在失败时不会本地误写终态
5. broker 不再创建硬编码 `localhost:4096` 的 reply 客户端路径

## 成功判定

完成后应满足：

1. WeChat `/reply` / `/allow` 不再依赖 broker 独立进程里的假 HTTP 地址
2. 真实宿主回复结果和本地 request/notification 状态不再脱节
3. “WeChat 已回复，但 OpenCode 里问题仍悬着”的假成功会被消除
