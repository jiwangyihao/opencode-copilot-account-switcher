# WeChat Runtime 诊断补全与调试包范围扩展设计

## 背景

当前仓库已经有一套 WeChat 调试包导出能力，但在最近一次真实用户诊断里暴露出两个明显缺口：

1. `wechat-status-runtime` 在 `loadPublicHelpers`、`getUpdates`、`persistGetUpdatesBuf`、`drainOutboundMessages`、`sendReplyMessage` 这些阶段如果抛错，当前只会走 `onRuntimeError`，不会稳定写进 `wechat-status-runtime.diagnostics.jsonl`。
2. 调试包当前没有把 `operator.json`、`latest-account.json` 和 token 状态一起导出，导致“绑定是否对齐”“当前轮询哪只 bot”“token 有没有落盘”这些关键判断只能脱离 bundle 额外补文件。

这意味着：当用户报告“登录后发 `/status` 没反应”时，现有 bundle 只能证明“slash 没有进入 runtime 处理链”，但无法进一步判断到底是卡在 `getUpdates`、还是发回复前某个 runtime 错误，也无法从同一个 bundle 里直接看到绑定状态与轮询账号是否对齐。

## 目标

1. 把 `wechat-status-runtime` 的关键失败阶段补成结构化 `runtimeError` 事件，并继续写入现有 `wechat-status-runtime.diagnostics.jsonl`。
2. 把 `operator.json`、`latest-account.json` 和非空 token 文件纳入调试包导出范围。
3. 保持现有单 bundle / manifest / environment-summary 结构，不新造第二套运行时日志目录。
4. 保持调试包在文件缺失时的 fail-soft 语义：只记录 `missingPaths`，不因为某个状态文件不存在就整体导出失败。

## 非目标

1. 不在这轮里改 slash 命令语义、broker 生命周期、绑定流程本身。
2. 不新建第二份 runtime 错误日志文件。
3. 不把完整 stack trace 原样塞进 diagnostics；只保留阶段和稳定错误摘要。
4. 不把导出器扩成上传、预览或远端分享功能。

## 方案选择

### 方案 A：扩展现有 runtime diagnostics + 扩大 bundle 范围

做法：

- 在现有 `wechat-status-runtime.diagnostics.jsonl` 里新增 `runtimeError` 事件。
- 在现有 bundle collector 里增加 `operator.json`、`latest-account.json`、非空 token 文件。

优点：

- 直接沿现有诊断与导出链路扩展，用户排查心智最稳定。
- 不需要再教用户额外找第二份日志文件。
- 最适合当前“现场 bundle 还差一点关键信息”的问题形态。

缺点：

- 需要更谨慎地控制错误文本和导出脱敏边界。

### 方案 B：单独新增 runtime-error 日志文件

做法：

- 维持现有 diagnostics 不变，新增 `wechat-runtime-errors.jsonl`。

优点：

- 错误与行为日志分离得更干净。

缺点：

- 用户需要知道并同时查看两份文件。
- 调试包和 manifest 也会更复杂。

### 方案 C：只补 bundle 导出范围，不改 runtime diagnostics

做法：

- 仅把 `operator.json`、`latest-account.json`、tokens 纳入 bundle。

优点：

- 改动最小。

缺点：

- 仍然看不到 runtime 在拿消息前到底报了什么错。
- 对这次 `/status` 无响应这类问题帮助不够。

### 结论

采用方案 A：扩展现有 runtime diagnostics，并把关键状态文件一起纳入 bundle。

## 设计细节

### 1. `runtimeError` 事件模型

新增一种 runtime 诊断事件，统一落在现有 `wechat-status-runtime.diagnostics.jsonl` 中：

```ts
type WechatStatusRuntimeDiagnosticEvent =
  | {
      type: "runtimeError"
      stage:
        | "loadPublicHelpers"
        | "getUpdates"
        | "persistGetUpdatesBuf"
        | "drainOutboundMessages"
        | "sendReplyMessage"
      error: string
    }
  | /* existing events */
```

约束：

1. 仍沿用当前 `onDiagnosticEvent` -> diagnostics file writer 这条链，不新增第二个 writer。
2. `error` 只保留稳定可读的错误摘要，不写完整堆栈。
3. `runtimeError.error` 既然会进入 diagnostics 并可能被导出到 sanitized bundle，就必须继续服从现有 diagnostics 脱敏边界：实现上不能直接把未经处理的原始错误字符串原样落盘并指望导出器兜底。
4. 现有事件：
   - `messageSkipped`
   - `slashCommandRecognized`
   - `replySendFailed`
   都保留，不与 `runtimeError` 合并。
5. 对 `sendReplyMessage` 失败这一类场景，兼容语义也必须写死：
   - 现有 `replySendFailed` 事件继续保留
   - 同一次失败可以额外补一条 `runtimeError { stage: "sendReplyMessage", ... }`
   - 但不能因为引入 `runtimeError` 而移除或重命名现有 `replySendFailed`

### 2. runtime 错误阶段落点

`wechat-status-runtime.ts` 里至少在这些位置补 `runtimeError`：

1. `loadPublicHelpers(...)` 失败
2. `helpers.getUpdates(...)` 失败
3. `helpers.persistGetUpdatesBuf(...)` 失败
4. `drainOutboundMessages(...)` 整体失败
5. `helpers.sendMessageWeixin(...)` 在发 slash/non-slash 回复时失败

这样下次看到 bundle 时，就能直接判断错误发生在：

- 进入轮询前
- 长轮询拿消息阶段
- 更新游标阶段
- 发送本地积压通知阶段
- 回微信消息阶段

### 3. 调试包新增导出项

在当前 bundle collector 里新增这些状态文件/状态类目：

- `state/operator.json`
- `state/latest-account.json`
- `state/tokens/**` 下的非空 token 文件

约束：

1. 若不存在，进入 `missingPaths`，不让整包失败。
2. 这里说的 `tokens/**` 不是“把整个目录无条件全打包”，而是只导出**最终 token state 文件**：
   - 常规 `.json` token 文件
   - 非空
   - 非 `.*.tmp` 这类临时文件
3. `tokens/` 目录存在但没有任何符合条件的 token 文件时，仍要把 `tokens/` 作为一条类别级缺失信号写进 `missingPaths`，从而明确表达“当前没有可用 token 证据”。
   - 这里沿用当前 manifest 的目录类目语义，实际 `relativePath` 应继续使用 `tokens`（不带尾斜杠），不新引入目录路径写法特例。
4. 对新增导出项，缺失与失败要继续沿现有 collector 的两层语义表达，而不是混成一类：
   - 真正不存在：`missingPaths`
   - 枚举后瞬时消失、空文件、临时文件、读取失败等单文件问题：`skippedEntries` + 稳定原因
   - 不因为单个新增文件有问题就让整包失败
5. 这轮新增/依赖的 `skippedEntries.reason` 取值也要固定下来，至少包括：
   - `token-temp-file`
   - `empty-token-file`
   - `file-disappeared`
   - `file-read-failed`
6. `operator.json` 与 `latest-account.json` 在 manifest 中应作为 `state` 类别条目出现。

### 4. 脱敏规则补充

新增导出项仍然必须遵守现有 sanitized/full 模式：

1. `operator.json`
   - sanitized 模式下，`wechatAccountId`、`userId` 按现有 ID 脱敏规则替换。
2. `latest-account.json`
   - sanitized 模式下，`accountId`、`token` 脱敏。
3. `tokens/**`
   - sanitized 模式下，`contextToken`、账号/用户标识继续按现有规则脱敏。
4. `runtimeError.error`
   - sanitized 模式下也必须保证不泄漏账号标识、token、cookie、bearer、message body 等敏感内容。

### 5. manifest / environment-summary 变化

manifest 需要反映新增导出项：

- `entries[]` 中新增 `operator.json`、`latest-account.json`、token 文件条目
- 缺失时进入 `missingPaths`

`environment-summary.json` 不需要新增新结构；只需继续保证：

- state root 是否存在
- diagnostics 是否存在
- 在 full/sanitized 模式下保持当前路径语义

## 测试策略

至少覆盖：

1. `loadPublicHelpers` 失败时会写 `runtimeError`，且 `stage = loadPublicHelpers`。
2. `getUpdates` 失败时会写 `runtimeError`，且 `stage = getUpdates`。
3. `persistGetUpdatesBuf` 失败时会写 `runtimeError`，且 `stage = persistGetUpdatesBuf`。
4. `drainOutboundMessages` 失败时会写 `runtimeError`，且 `stage = drainOutboundMessages`。
5. `sendReplyMessage` 失败时会写 `runtimeError`，且 `stage = sendReplyMessage`。
6. 导出 full bundle 时会包含：
   - `operator.json`
   - `latest-account.json`
   - 非空 token 文件
7. sanitized bundle 会对这些新增文件继续执行脱敏，不泄漏 `token` / `contextToken` / 账号标识；`runtimeError.error` 也服从同样的导出脱敏边界。
8. 这些文件真正缺失时进入 `missingPaths`；空 token 文件、临时 token 文件、枚举后消失或读取失败的单文件进入 `skippedEntries`，并使用上文固定的 reason 字面量；导出仍继续成功。

## 成功判定

当这条线完成时，应满足：

1. 下一次用户再导出 debug bundle 时，若 `/status` 没反应，能够直接从 bundle 里看到 runtime 是卡在 `loadPublicHelpers`、`getUpdates`、还是发回复前。
2. 调试包里能直接看到当前绑定的 `operator.json`、当前轮询账号的 `latest-account.json` 和 token 状态，不必再额外补文件。
3. 新增导出项不会破坏现有脱敏边界，也不会把“缺一个文件”升级成整包失败。
