`opencode-copilot-account-switcher` 进入 1.0.0 稳定版：Copilot 插件现在聚焦 GitHub Copilot 账号切换、配额查询、routing 和 Copilot 请求增强，迁移路径也集中到本次 Release Notes 中。

## 适合谁升级
- 如果你主要使用 GitHub Copilot provider，并希望继续保留多账号、quota、routing、Copilot Network Retry 和 `/copilot-status`，建议升级。
- 如果你还依赖旧版 Copilot 包中的 OpenAI / Codex、Loop Safety、wait、notify 或远程值守能力，请按下面的迁移说明补装独立插件。

## 你会看到的变化
- Copilot 插件以 1.0.0 作为稳定基线，README 聚焦安装、使用和 Copilot 专属开关，不再重复维护拆分边界说明。
- GitHub Copilot 多账号、配额查询、模型账号映射、Copilot Network Retry、Synthetic Agent Initiator 和 `/copilot-status` 继续由本包提供。
- OpenAI / Codex、Loop Safety、wait、notify 和 Oncall 远程值守迁移到独立包，各自独立安装、升级和验证。

## 注意事项
- 这是一次边界收敛后的稳定版发布。本包不再作为其它插件能力的说明中心；完整插件矩阵请看 [OpenCode J Super Suite](https://github.com/jiwangyihao/opencode-j-super-suite)。
- 需要 OpenAI / Codex 账号切换时，请安装：`opencode plugin opencode-openai-account-switcher@0.1.0 --force -g`
- 需要 Guided Loop Safety 工作流时，请安装：`opencode plugin opencode-wait@0.1.0 --force -g`、`opencode plugin opencode-notify-tool@0.1.0 --force -g`、`opencode plugin opencode-loop-safety@0.1.0 --force -g`
- 需要远程值守 / 微信 slash 交互时，请安装：`opencode plugin opencode-oncall@0.1.5 --force -g`

## 升级方式
- `opencode plugin opencode-copilot-account-switcher@1.0.0 --force -g`
