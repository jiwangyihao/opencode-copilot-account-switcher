# opencode-copilot-account-switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/jiwangyihao/opencode-copilot-account-switcher?style=social)](https://github.com/jiwangyihao/opencode-copilot-account-switcher/stargazers)

套件导航 / Suite: [OpenCode J Super Suite](https://github.com/jiwangyihao/opencode-j-super-suite)

> **Latest in v1.0.0 | v1.0.0 最近更新**
>
> - Provides the stable Copilot-only account switcher for OpenCode | 提供稳定的 OpenCode Copilot-only 账号切换插件
> - Keeps account switching, quota checks, routing, retry, and Copilot request enhancements together | 保留账号切换、quota、routing、重试和 Copilot 请求增强能力
> - Leaves OpenAI / Codex, Loop Safety, wait, notify, and remote on-call features to standalone Suite plugins | OpenAI / Codex、Loop Safety、wait、notify 和远程值守能力由 Suite 独立插件承载

[中文](#中文) | [English](#english)

---

<a name="中文"></a>

## 中文

`opencode-copilot-account-switcher` 是面向 **OpenCode** 的 GitHub Copilot 账号切换插件。它基于官方 `github-copilot` provider，补充多账号管理、配额查看、模型路由和 Copilot 请求增强能力，**无需修改模型配置**。

它适合只需要 Copilot 账号能力，或希望把 Copilot、OpenAI / Codex、Loop Safety、wait、notify、远程值守能力拆成独立插件按需组合的用户。

## 功能一览

- **Copilot 多账号管理** — 添加多个 GitHub Copilot 账号，随时切换或删除。
- **配额查询** — 查看每个账号的 Copilot quota 和当前可用状态。
- **Auth 导入** — 从 OpenCode 认证存储导入 GitHub Copilot token。
- **模型路由** — 支持 Copilot 账号与模型路由状态管理。
- **Copilot Network Retry** — 默认关闭；把可重试的网络或 TLS 失败归一化给 OpenCode 原生重试链路。
- **Synthetic Agent Initiator** — 默认关闭；实验性发送或覆盖 `x-initiator=agent`，存在平台计费、滥用判定和行为漂移风险。
- **`/copilot-status`** — 默认开启；实验性 TUI-first slash command，会显示加载 toast 和 quota 结果 toast。

---

## 安装

<details open>
<summary><b>面向人类用户</b></summary>

**选项 A：让 LLM 帮你安装**

把下面这段话丢给任意 LLM（OpenCode / Claude Code / Cursor 等）：

```text
请先查看 opencode-copilot-account-switcher 最新 GitHub Release 正文里的“升级方式”，然后严格执行其中带明确版本号的安装/升级命令。默认应使用带 `-g/--global` 的全局命令来更新你平时实际在用的 OpenCode 实例；只有你明确想改当前项目目录下的 `.opencode` 时，才省略 `-g`。不要手动编辑 OpenCode 配置，也不要使用裸包名或 latest。参考说明：https://github.com/jiwangyihao/opencode-copilot-account-switcher/releases/latest
```

**选项 B：手动安装**

1. **先查看最新 GitHub Release** 的 `## 升级方式` 小节。

2. **执行其中带明确版本号的全局命令**。例如当前版本是：

   ```bash
   opencode plugin opencode-copilot-account-switcher@1.0.0 --force -g
   ```

3. **如果你是刻意只想改当前项目目录下的 `.opencode`**，才使用不带 `-g` 的局部命令；否则默认不要省略 `-g`。

4. **如果升级后看起来仍然没有变化**，先清理 OpenCode 插件缓存，再重新执行同一条带版本号命令。

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. **如果 OpenCode 已在运行，重启后再验证**。

</details>

<details>
<summary><b>面向 LLM 智能体</b></summary>

### 步骤指引

1. 读取本仓库最新 GitHub Release 正文，提取 `## 升级方式` 中带明确版本号的命令。

2. 直接执行该命令。默认使用带 `-g/--global` 的全局命令；只有用户明确要改当前项目目录下的 `.opencode` 时，才省略 `-g`。例如当前版本：

   ```bash
   opencode plugin opencode-copilot-account-switcher@1.0.0 --force -g
   ```

3. 不要手动编辑 OpenCode 配置，也不要使用裸包名或 `latest`。

4. 如果执行后版本看起来仍然没更新，先清理 OpenCode 插件缓存，再重新执行同一条带版本号命令：

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. 如果 OpenCode 已在运行，重启后再验证。

### 验证

运行 GitHub Copilot provider 认证入口，应看到账号管理菜单：

```bash
opencode auth login --provider github-copilot
```

</details>

---

## 使用方式

包的 public entry 只导出 OpenCode 插件函数：

```typescript
import { CopilotAccountSwitcher } from "opencode-copilot-account-switcher"

export default CopilotAccountSwitcher
```

在 Copilot 认证流程中运行：

```bash
opencode auth login --provider github-copilot
```

会出现交互式菜单（方向键 + 回车），用于添加账号、从 `auth.json` 导入、检查 quota、配置 Copilot 相关开关、切换账号、删除账号和清空账号。

## 开关与实验能力

**Copilot Network Retry**

- 默认：关闭
- 作用范围：仅影响 `auth.loader` 返回的官方 Copilot 请求 `fetch` 路径
- 用途：有限处理 `failed to fetch`、`ECONNRESET`、`unknown certificate`、`self signed certificate` 等可重试网络或证书类失败
- 策略：尽量保留官方 loader 行为，再把可重试失败归一化给 OpenCode 原生重试链路判断是否重试

**Synthetic Agent Initiator**

- 默认：关闭
- 作用：发送或覆盖 `x-initiator=agent`，用于提前启用 upstream 开发中的 synthetic initiator 语义
- 风险：该行为不保证平台一定不计费，也可能因为上游实现、平台策略或服务端校验变化而失效
- 上游参考：[#8700](https://github.com/anomalyco/opencode/issues/8700)、[#8721](https://github.com/anomalyco/opencode/pull/8721)、[#8766](https://github.com/anomalyco/opencode/issues/8766)、[`88226f3`](https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74)

**实验性 `/copilot-status`**

- 默认：开启
- 性质：实验特性 / workaround，不是稳定公开 API
- 主支持面：TUI-first；Web/App 不承诺一致体验
- 触发方式：在正常对话里输入 `/copilot-status`
- 预期反馈：先显示 `正在拉取 Copilot quota...` toast，再显示成功或失败结果 toast

关闭该实验特性时，编辑 `~/.config/opencode/copilot-accounts.json`：

```json
{
  "experimentalStatusSlashCommandEnabled": false
}
```

## 存储与 Upstream Sync

账号信息保存于：

```text
~/.config/opencode/copilot-accounts.json
```

仓库中提交了一份 upstream 快照 `src/upstream/copilot-plugin.snapshot.ts`，并提供同步/校验脚本 `scripts/sync-copilot-upstream.mjs`。

常用命令：

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

## 适合谁使用

- 需要在 OpenCode 中管理多个 GitHub Copilot 账号、切换账号或查看 quota 的用户。
- 需要 Copilot provider 专属 routing、retry、status 或 request enhancement 的用户。
- 正在按 OpenCode J Super Suite 迁移，希望 Copilot 能力独立升级、其它能力按需安装的用户。

## 本地开发

```bash
npm install
npm test
npm run build
```

发布资料见 `docs/publishing.md`、`docs/release-notes-template.md` 和 `docs/release-notes-v1.0.0.md`。

---

<a name="english"></a>

## English

`opencode-copilot-account-switcher` is a GitHub Copilot account switcher plugin for **OpenCode**. It builds on the official `github-copilot` provider to add multi-account management, quota checks, model routing, and Copilot request enhancements with **no model configuration changes required**.

Use it when you only need Copilot account capabilities, or when you want Copilot, OpenAI / Codex, Loop Safety, wait, notify, and remote on-call capabilities to stay independently installable.

## What You Get

- **Copilot multi-account support** — add multiple GitHub Copilot accounts and switch or delete them anytime.
- **Quota checks** — view Copilot quota and current availability for each account.
- **Auth import** — import GitHub Copilot tokens from OpenCode auth storage.
- **Model routing** — manage Copilot account and model routing state.
- **Copilot Network Retry** — disabled by default; normalizes retryable network or TLS failures into OpenCode's native retry path.
- **Synthetic Agent Initiator** — disabled by default; experimentally sends or overrides `x-initiator=agent` and carries platform billing, abuse-detection, and drift risk.
- **`/copilot-status`** — enabled by default; experimental TUI-first slash command that shows a loading toast and then a quota result toast.

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (OpenCode, Claude Code, Cursor, etc.):

```text
First read the latest GitHub Release for opencode-copilot-account-switcher and execute the exact versioned install/upgrade command from its "Upgrade / 升级方式" section. By default, use the global command with `-g/--global` so you update the OpenCode instances you actually run; omit `-g` only if you intentionally want to change the current project's `.opencode`. Do not manually edit the OpenCode config, and do not use a bare package name or latest. Reference: https://github.com/jiwangyihao/opencode-copilot-account-switcher/releases/latest
```

**Option B: Manual setup**

1. **Read the latest GitHub Release** and look for the `## Upgrade / 升级方式` section.

2. **Run the exact versioned global command** from that section. For the current version:

   ```bash
   opencode plugin opencode-copilot-account-switcher@1.0.0 --force -g
   ```

3. **Only omit `-g` if you intentionally want to update the current project's `.opencode` instead of the global OpenCode config.**

4. **If an upgrade still looks stale**, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. **If OpenCode is already running, restart it before verification**.

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Read the latest GitHub Release body for this repository and extract the exact versioned command from `## Upgrade / 升级方式`.

2. Execute that command directly. By default, use the global command with `-g/--global`; only omit `-g` if you intentionally want to update the current project's `.opencode`. For the current version:

   ```bash
   opencode plugin opencode-copilot-account-switcher@1.0.0 --force -g
   ```

3. Do not install or upgrade this plugin by hand-editing OpenCode config, and do not use a bare package name or `latest`.

4. If the installed version still does not change, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. If OpenCode is already running, restart before feature verification.

### Verification

Run the GitHub Copilot provider auth flow and confirm the account management menu appears:

```bash
opencode auth login --provider github-copilot
```

</details>

---

## Usage

The package public entry exports only the OpenCode plugin function:

```typescript
import { CopilotAccountSwitcher } from "opencode-copilot-account-switcher"

export default CopilotAccountSwitcher
```

Run the Copilot auth flow:

```bash
opencode auth login --provider github-copilot
```

The interactive menu lets you add accounts, import from `auth.json`, check quota, configure Copilot switches, switch accounts, delete accounts, and clear accounts.

## Switches and Experimental Capabilities

**Copilot Network Retry**

- Default: disabled
- Scope: only the official Copilot request `fetch` path returned by `auth.loader`
- Purpose: limited handling for retryable network or certificate-style failures such as `failed to fetch`, `ECONNRESET`, `unknown certificate`, or `self signed certificate`
- Strategy: preserve official loader behavior, then normalize retryable failures so OpenCode's native retry pipeline can decide whether and when to retry

**Synthetic Agent Initiator**

- Default: disabled
- Effect: sends or overrides `x-initiator=agent` to enable upstream's in-progress synthetic initiator semantics early
- Risk: this does not guarantee non-billable treatment and may stop working as upstream implementation, platform policy, or server-side validation changes
- Upstream references: [#8700](https://github.com/anomalyco/opencode/issues/8700), [#8721](https://github.com/anomalyco/opencode/pull/8721), [#8766](https://github.com/anomalyco/opencode/issues/8766), [`88226f3`](https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74)

**Experimental `/copilot-status`**

- Default: enabled
- Nature: experimental / workaround, not a stable public API
- Support scope: TUI-first; Web/App behavior is not guaranteed to match
- Trigger: enter `/copilot-status` in a normal chat session
- Expected feedback: first a `Fetching Copilot quota...` toast, then a success or error toast

To disable it, edit `~/.config/opencode/copilot-accounts.json`:

```json
{
  "experimentalStatusSlashCommandEnabled": false
}
```

## Storage and Upstream Sync

Accounts are stored in:

```text
~/.config/opencode/copilot-accounts.json
```

The repository includes a committed upstream snapshot at `src/upstream/copilot-plugin.snapshot.ts` plus a sync/check script at `scripts/sync-copilot-upstream.mjs`.

Useful commands:

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

## Who Should Use This

- Users who need to manage multiple GitHub Copilot accounts, switch accounts, or inspect quota in OpenCode.
- Users who need Copilot provider-specific routing, retry, status, or request enhancement behavior.
- Users migrating through OpenCode J Super Suite who want Copilot capabilities to upgrade independently while installing other capabilities only when needed.

## Local Development

```bash
npm install
npm test
npm run build
```

Release material lives in `docs/publishing.md`, `docs/release-notes-template.md`, and `docs/release-notes-v1.0.0.md`.

---

## License

MPL-2.0 License. See [LICENSE](LICENSE) for details.
