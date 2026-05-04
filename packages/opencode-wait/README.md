# opencode-wait

`opencode-wait` 是一个通用 OpenCode 插件，只提供 `wait` 工具。它适合无人值守等待、后台任务、冷却时间和预期事件，不依赖 Copilot、Codex、Loop Safety、`notify` 或微信。

## 安装

发布后可以使用明确版本安装：

```bash
opencode plugin opencode-wait@0.1.0 -g
```

本地开发时先运行构建：

```bash
npm run build -w opencode-wait
```

## 在 OpenCode 中启用

默认入口导出的是 OpenCode 插件函数：

```typescript
import WaitPlugin from "opencode-wait"

export default WaitPlugin
```

如果需要在测试中注入时间和等待实现，可以使用 `createWaitPlugin()`：

```typescript
import { createWaitPlugin } from "opencode-wait"

export default createWaitPlugin({
  sleep: async () => {},
})
```

## 用法

计时等待最短为 30 秒，缺失或无效的 `seconds` 会归一化为 30 秒：

```json
{
  "seconds": 30
}
```

等待当前会话出现新的用户消息：

```json
{
  "until": "new_user_message"
}
```

当等待期间出现真实用户消息，结果会包含 `reason: new user message`。当等待期间出现插件合成用户消息，结果会包含 `reason: new user message (synthetic)`。

## 不包含的能力

- 不提供 `notify`。
- 不改写 `question`。
- 不包含 Copilot、Codex、Loop Safety 或微信功能。
- 不依赖 `opencode-j-super-suite`。
