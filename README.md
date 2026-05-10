# OpenCode GitHub Copilot Account Switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

> **Latest in v0.15.0 | v0.15.0 最近更新**
>
> - Guided Loop Safety moved to standalone `opencode-loop-safety@0.1.0` | Guided Loop Safety 已拆分为独立插件 `opencode-loop-safety@0.1.0`
> - Copilot no longer owns Loop Safety hooks, settings, or old slash commands | Copilot 插件不再内置 Loop Safety hooks、设置或旧 slash commands
> - Separate versioned install commands are documented for Loop Safety / Wait / Notify | 已补充 Loop Safety / Wait / Notify 的独立明确版本安装命令

[中文](#中文) | [English](#english)

---

<a name="中文"></a>

## 中文

在 **OpenCode** 中管理并切换多个 **GitHub Copilot** 账号。本插件基于官方 `github-copilot` provider，补充账号管理、配额查看和几项 Copilot 工作流增强能力，**无需修改模型配置**。

默认能力与开关：

- **Copilot Network Retry** — 默认关闭；用于处理可重试的网络或证书类失败
- **Synthetic Agent Initiator** — 默认关闭；实验性开关，会偏离 upstream 当前稳定行为，发送或覆盖 `x-initiator=agent`，不保证平台一定不计费，且存在滥用判定与意外计费风险
- **Copilot Status Slash Command** — 默认开启；实验性 `/copilot-status` workaround，只把 TUI 作为主支持面，Web/App 不承诺一致体验

## 功能一览

- **多账号管理** — 添加多个 Copilot 账号，随时切换
- **配额查询** — 查看每个账号的剩余额度
- **导入认证** — 可从 OpenCode 认证存储导入
- **Copilot Network Retry** — 默认关闭；把可重试的 Copilot 网络或 TLS 失败归一化成 OpenCode 原生重试链路可识别的形态
- **Synthetic Agent Initiator** — 默认关闭；实验性开关，会偏离 upstream 稳定行为，发送或覆盖 `x-initiator=agent`，并伴随计费/滥用风险
- **`/copilot-status`** — 默认开启；实验性 slash command，会先弹出“正在拉取”toast，再弹出 quota 结果或错误 toast
- **无需模型配置** — 使用官方 provider，无需改模型

## 包边界说明

本包现在只描述和承载 GitHub Copilot 账号切换能力。如果你需要 OpenAI Codex / `openai` provider 的账号切换，请使用独立包 `opencode-openai-account-switcher`；它的 public entry 导出 `OpenAICodexAccountSwitcher`，并拥有 Codex store、status、retry、upstream snapshot 与 snapshot sync。

`opencode-openai-account-switcher` 不包含 GitHub Copilot routing、header rewrite、模型账号映射或微信绑定动作。它的独立发布链路应包含 fresh 验证、npm publish、tag push 与 GitHub Release；root Copilot 包不随这条链路发布。

## 微信通知功能

微信通知现在会覆盖 5 类常见场景。你看到通知时，可以先判断它是不是可回复入口，再决定是直接在微信里继续，还是回到电脑端处理。

- **question**：当 Agent 需要你的明确回答时，你会收到带 `qid` 的问题通知；这是可回复入口；下一步直接发送 `/reply <qid> 你的回复`。
- **permission**：当工具或动作需要你授权时，你会收到带 `handle` 的授权请求；这是可处理入口；下一步发送 `/allow <handle> once|always|reject`。
- **terminal result**：当电脑端已经把旧 question 或 permission 处理完、拒绝、过期或替代时，你会先收到一条终结结果通知；这不是新的可回复入口；下一步按通知里的结果判断是否还需要回到电脑端继续。
- **natural-stop**：当 Agent 自然停在一个可继续的分支并等你补充信息时，你会收到带 `s*` 标识的停点通知；这是可回复入口；下一步发送 `/reply <s*> 你的补充内容`。
- **retry / error**：当执行过程中出现普通重试或错误摘要时，你会收到一条信息型说明；这不是可回复入口；下一步根据摘要判断是否继续观察，或回到电脑端处理。

### 什么时候可以直接回复

- question：`/reply <qid> 你的回复`
- permission：`/allow <handle> once|always|reject`
- natural-stop：`/reply <s*> 你的补充内容`

### 电脑端终结后会发生什么

- 如果电脑端已经回复、拒绝、过期或替代了某个旧入口，微信侧会先收到一条终结结果通知，告诉你这个入口为什么结束。
- 这个旧 `qid` / `handle` 随后会失效，不会继续悬挂成可回复入口。
- 你之后再发一次对应的 `/reply ...` 或 `/allow ...`，会收到稳定的“已结束 + 原因”提示，而不是没有反应。

### natural-stop 和 retry / error 的区别

- `natural-stop` 是可回复分支，表示 Agent 还在等你的补充，你可以继续用 `/reply <s*> ...` 往下接。
- 普通 `retry / error` 是信息型摘要，不是可回复入口；如果摘要显示问题还在，通常需要你回到电脑端继续处理。

### 为什么现在更容易复制

- question / permission 的命令示例会逐行独立展示，你在微信里更容易整行复制。
- question 里的选项如果有标题和说明，会一起显示出来，减少只复制到半句的情况。
- 可回复入口和信息型摘要现在分得更清楚，不容易把不能回复的通知误当成命令入口。

---

## 安装

<details open>
<summary><b>面向人类用户</b></summary>

**选项 A：让 LLM 帮你安装**

把下面这段话丢给任意 LLM（OpenCode / Claude Code / Cursor 等）：

```
请先查看 opencode-copilot-account-switcher 最新 GitHub Release 正文里的“升级方式”，然后严格执行其中带明确版本号的安装/升级命令。默认应使用带 `-g/--global` 的全局命令来更新你平时实际在用的 OpenCode 实例；只有你明确想改当前项目目录下的 `.opencode` 时，才省略 `-g`。不要手动编辑 OpenCode 配置，也不要使用裸包名或 latest。参考说明：https://raw.githubusercontent.com/jiwangyihao/opencode-copilot-account-switcher/master/README.md
```

**选项 B：手动安装**

1. **先查看最新 GitHub Release** 的 `## 升级方式` 小节。

2. **执行其中带明确版本号的全局命令**。例如当前版本是：

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.15.0 --force -g
   ```

3. **如果你是刻意只想改当前项目目录下的 `.opencode`**，才使用不带 `-g` 的局部命令；否则默认不要省略 `-g`。

4. **如果是在升级且看起来没有更新**，先清理 OpenCode 插件缓存，再重新执行上面的带版本号命令。

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. **如果 OpenCode 已在运行，重启后再验证**。

6. **登录 GitHub Copilot**：

   ```bash
   opencode auth login --provider github-copilot
   ```

</details>

<details>
<summary><b>面向 LLM 智能体</b></summary>

### 步骤指引

1. 先读取本仓库**最新 GitHub Release 正文**，提取其中 `## 升级方式` 给出的**带明确版本号**命令。

2. 直接执行那条命令。默认应使用带 `-g/--global` 的全局命令来更新你平时实际在用的 OpenCode 实例；如果你明确只想改当前项目目录下的 `.opencode`，才省略 `-g`。例如当前版本：

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.15.0 --force -g
   ```

3. 不要手动编辑 OpenCode 配置来安装或升级这个插件，也不要使用裸包名或 `latest`。

4. 如果执行后版本看起来仍然没更新，先清理 OpenCode 插件缓存，再重新执行同一条带版本号命令：

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. 如果 OpenCode 已在运行，重启后再验证。

### 验证

```bash
opencode auth login --provider github-copilot
```

> **说明**：最新 OpenCode 当前不会主动刷新已缓存的 npm 插件。升级时优先以最新 GitHub Release 正文里的 `## 升级方式` 为准；默认应走带 `-g` 的全局升级，只有明确想改当前项目 `.opencode` 时才省略 `-g`。

</details>

---

## 使用方式

在 Copilot 认证流程中运行：

```bash
opencode auth login --provider github-copilot
```

会出现交互式菜单（方向键 + 回车）：

- **添加账号**
- **从 auth.json 导入**
- **检查配额**
- **Copilot Network Retry 开关** — 默认关闭；仅影响 Copilot 请求的 `fetch` 路径，只处理可重试的网络/证书类失败
- **Synthetic Agent Initiator 开关** — 默认关闭；实验性开关，发送或覆盖 `x-initiator=agent`，会偏离 upstream 稳定行为，且不保证平台一定不计费
- **`/copilot-status`** — 默认开启；实验性 slash command，会先弹出“正在拉取”toast，再弹出 quota 结果或错误 toast
- **切换账号**
- **删除账号**
- **全部删除**

## 独立安装 Loop Safety / Wait / Notify

Guided Loop Safety 已从本 Copilot 插件抽离为独立插件。如果你的工作流需要双通道交互约束、无人值守等待或非阻塞进度通知，请按需分别安装：

```bash
opencode plugin opencode-loop-safety@0.1.0 --force -g
opencode plugin opencode-wait@0.1.0 --force -g
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

安装后，Loop Safety 的策略注入、compact bypass、`/loop-safety` 菜单和相关设置由 `opencode-loop-safety` 拥有；Copilot 插件继续聚焦账号、配额和 Copilot 请求增强。


如果你在切换 Copilot 账号后遇到瞬时 TLS/网络失败，或者遇到由旧 session item ID 残留引起的 `input[*].id too long` 错误，也可以在同一菜单中开启 Copilot Network Retry。它默认关闭。开启后，插件会先保留 upstream 官方 loader 生成的 `baseURL`、认证头和 `fetch` 行为，只在最后一跳 Copilot `fetch` 路径上做最小包装，把可重试的网络类失败归一化成 OpenCode 已有重试链路能识别的形态；对于明确命中的 `input[*].id too long` 400，还会回写命中的 session part，避免旧 item ID 持续污染后续重试。

## 实验性 `/copilot-status`

- 默认：**开启**
- 性质：**实验特性 / workaround**，不是稳定公开 API
- 主支持面：**TUI-first**；Web/App 只保留风险说明，不承诺一致体验
- 触发方式：在正常对话里输入 `/copilot-status`
- 预期反馈：先显示“正在拉取 Copilot quota...” toast，再显示成功或失败结果 toast

如果你想关闭这个实验特性，可编辑账号存储文件 `~/.config/opencode/copilot-accounts.json`，加入或修改：

```json
{
  "experimentalStatusSlashCommandEnabled": false
}
```

关闭后：

- OpenCode 配置里不再注入 `/copilot-status`
- 即使手动输入 `/copilot-status`，插件也不会再进入该 workaround 执行链

## Copilot Network Retry

- 默认：**关闭**
- 作用范围：仅影响 `auth.loader` 返回的官方 Copilot 请求 `fetch` 路径
- 用途：有限处理 `failed to fetch`、`ECONNRESET`、`unknown certificate`、`self signed certificate` 等可重试网络/证书类失败
- 实现策略：尽量保留官方 loader 行为，再把可重试失败归一化给 OpenCode 原生重试链路判断是否重试
- 风险提示：因为插件仍然包裹了官方 fetch 路径，若 upstream 后续内部实现变化，仍可能产生行为漂移

## Synthetic Agent Initiator

- 默认：**关闭**
- 作用：发送或覆盖 `x-initiator=agent`，用于提前启用 upstream 开发中的 synthetic initiator 语义
- 与 upstream 当前稳定代码的关系：开启后，请求行为会与 upstream 当前稳定代码不一致；这是基于上游开发中语义的提前启用方案，不是 upstream 稳定默认行为
- 计费相关说明：平台可能更倾向于把压缩后继续工作、以及其他自动生成的 synthetic 提示消息排除在 premium request 计费范围之外，但这不是保证；实际是否计费、如何计费，始终由平台决定，请不要把它理解为“必然不计费”
- 风险提示：该行为可能更容易被平台判定为滥用；也可能因为上游实现、平台策略或服务端校验变化而失效，甚至产生意外计费
- 上游参考：
  - Issue: https://github.com/anomalyco/opencode/issues/8700
  - PR: https://github.com/anomalyco/opencode/pull/8721
  - Issue: https://github.com/anomalyco/opencode/issues/8766
  - Commit: https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74

## Upstream 同步机制

仓库中提交了一份 upstream 快照 `src/upstream/copilot-plugin.snapshot.ts`，并提供同步/校验脚本 `scripts/sync-copilot-upstream.mjs`。

常用命令：

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

该脚本会生成或校验仓库中提交的 snapshot，并要求在更新正式 snapshot 时显式提供 upstream commit 与同步日期，用来尽早发现与官方 `opencode` `copilot.ts` 的行为漂移。

---

## 存储位置

账号信息保存于：

```
~/.config/opencode/copilot-accounts.json
```

---

## 常见问题

**需要改模型配置吗？**
不需要。本插件只做账号管理，继续使用官方 `github-copilot` provider。

**会替换官方 provider 吗？**
不会。它只是在官方 provider 基础上增加账号切换和配额查询。

**Copilot Network Retry 会替代 OpenCode 自己的重试逻辑吗？**
不会。插件的目标是把可重试的 Copilot 网络/TLS 失败归一化成 OpenCode 已识别的可重试错误形态，真正的是否重试与如何退避仍由 OpenCode 原生链路决定。

---

<a name="english"></a>

## English

Manage and switch between multiple **GitHub Copilot** accounts in **OpenCode**. The plugin builds on the official `github-copilot` provider to add account management, quota visibility, and a few Copilot workflow enhancements, with **no model reconfiguration required**.

Default behavior and optional switches:

- **Copilot Network Retry** — optional and off by default; handles retryable network or certificate-style failures
- **Synthetic Agent Initiator** — optional and off by default; experimental switch that diverges from stable upstream behavior, sends or overrides `x-initiator=agent`, does not guarantee non-billable treatment, and carries abuse or unexpected-billing risk
- **Copilot Status Slash Command** — enabled by default; experimental `/copilot-status` workaround with TUI-first support and no cross-client UX guarantee

## What You Get

- **Multi-account support** — add multiple Copilot accounts and switch anytime
- **Quota check** — view remaining quota per account
- **Auth import** — import Copilot tokens from OpenCode auth storage
- **Copilot Network Retry** — optional and off by default; normalizes retryable Copilot network or TLS failures so OpenCode's native retry path can handle them
- **Synthetic Agent Initiator** — optional and off by default; experimental switch that diverges from stable upstream behavior, sends or overrides `x-initiator=agent`, and carries billing/abuse risk
- **`/copilot-status`** — enabled by default; experimental slash command that shows a loading toast first and then a quota result or error toast
- **Zero model config** — no model changes required (official provider only)

## Package Boundary

This package now documents and owns GitHub Copilot account switching only. OpenAI Codex / `openai` provider account switching belongs to the standalone `opencode-openai-account-switcher` package, whose public entry exports `OpenAICodexAccountSwitcher` and owns the Codex store, status command, retry policy, upstream snapshot, and snapshot sync script.

`opencode-openai-account-switcher` does not include GitHub Copilot routing, header rewrite, model-account assignments, or WeChat binding actions. Its standalone release chain should include fresh verification, npm publish, tag push, and a GitHub Release; the root Copilot package is not released as part of that chain.

## WeChat Notifications

### Overview

WeChat notifications now cover five user-facing cases. Each one tells you whether you can keep going in WeChat or should return to desktop first.

- **question** — a replyable question with a `qid`; next step: send `/reply <qid> your answer`.
- **permission** — a replyable permission request with a `handle`; next step: send `/allow <handle> once|always|reject`.
- **terminal result** — a closure notice after an old question or permission was already resolved, rejected, expired, or replaced on the desktop side; informational only; next step: use the closure result to decide whether you still need to return to desktop.
- **natural-stop** — a replyable stop point with an `s*` handle when the agent is waiting for more input; next step: send `/reply <s*> your follow-up`.
- **retry / error** — an informational-only summary for ordinary retries or errors, not a replyable entry; next step: use it to decide whether to keep watching or return to desktop.

### Replyable entries

- question: `/reply <qid> your answer`
- permission: `/allow <handle> once|always|reject`
- natural-stop: `/reply <s*> your follow-up`

### After desktop-side completion

- You first receive a terminal result notification explaining that the old entry has ended.
- That old `qid` / `handle` is no longer replyable.
- If you send the old `/reply ...` or `/allow ...` again later, you get a stable closed reason instead of a silent no-op.

### natural-stop vs retry / error

- `natural-stop` is replyable and means the agent is explicitly waiting for more input.
- Ordinary `retry / error` is informational only, not a replyable entry.

### Copy-friendly message format

- Command examples stay on their own lines so they are easier to copy from WeChat.
- When question options include both a title and an explanation, both are shown together.

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (OpenCode, Claude Code, Cursor, etc.):

```
First read the latest GitHub Release for opencode-copilot-account-switcher and execute the exact versioned install/upgrade command from its "Upgrade" section. By default, use the global command with `-g/--global` so you update the OpenCode instances you actually run; omit `-g` only if you intentionally want to change the current project's `.opencode`. Do not manually edit the OpenCode config, and do not use a bare package name or latest. Reference: https://raw.githubusercontent.com/jiwangyihao/opencode-copilot-account-switcher/master/README.md
```

**Option B: Manual setup**

1. **Read the latest GitHub Release** and look for the `## Upgrade` section.

2. **Run the exact versioned global command** from that section. For the current version, the command is:

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.15.0 --force -g
   ```

3. **Only omit `-g` if you intentionally want to update the current project's `.opencode` instead of the global OpenCode config.**

4. **If an upgrade still looks stale**, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. **If OpenCode is already running, restart it before verification**.

6. **Login** to GitHub Copilot:

   ```bash
   opencode auth login --provider github-copilot
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Read the **latest GitHub Release body** for this repository and extract the exact versioned command from `## Upgrade`.

2. Execute that command directly. By default, use the global command with `-g/--global`; only omit `-g` if you intentionally want to update the current project's `.opencode`. For the current version, the command is:

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.15.0 --force -g
   ```

3. Do not install or upgrade this plugin by hand-editing the OpenCode config, and do not use a bare package name or `latest`.

4. If the installed version still does not change, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. If OpenCode is already running, restart it before verification.

### Verification

```bash
opencode auth login --provider github-copilot
```

> **Note**: Current OpenCode does not reliably refresh cached npm plugins automatically. Prefer the exact versioned command from the latest GitHub Release. By default, that command should include `-g`; without `-g`, you are only changing the current project's `.opencode`.

</details>

---

## Usage

Run inside the GitHub Copilot auth flow:

```bash
opencode auth login --provider github-copilot
```

You will see an interactive menu. Use the built-in language switch action if you want to swap between Chinese and English labels.

- **Add account**
- **Import from auth.json**
- **Check quota**
- **Copilot Network Retry toggle** — off by default; only affects the Copilot `fetch` path for retryable network/certificate failures
- **Synthetic Agent Initiator toggle** — off by default; experimental switch that sends or overrides `x-initiator=agent`, diverges from stable upstream behavior, and does not guarantee non-billable treatment
- **`/copilot-status`** — enabled by default; experimental slash command workaround that shows a loading toast first and then a quota result or error toast
- **Switch account**
- **Delete account**
- **Delete all**

## Installing Loop Safety / Wait / Notify Separately

Guided Loop Safety has moved out of this Copilot plugin into a standalone plugin. If your workflow needs dual-channel interaction policy, unattended waits, or non-blocking progress notifications, install the companion plugins as needed:

```bash
opencode plugin opencode-loop-safety@0.1.0 --force -g
opencode plugin opencode-wait@0.1.0 --force -g
opencode plugin opencode-notify-tool@0.1.0 --force -g
```

After installation, policy injection, compact bypass, the `/loop-safety` menu, and related settings are owned by `opencode-loop-safety`; this Copilot plugin remains focused on accounts, quota, and Copilot request enhancements.


If you switch Copilot accounts and then hit transient TLS/network failures or `input[*].id too long` errors caused by stale session item IDs, enable Copilot Network Retry from the same menu. It is off by default. When enabled, the plugin keeps the official Copilot header/baseURL behavior from the upstream loader, only wraps the final Copilot `fetch` path, and converts retryable network-like failures into a shape that OpenCode already treats as retryable. It also repairs the matched session part after an `input[*].id too long` 400 so later retries can recover instead of repeatedly failing on stale item IDs.

You can also enable Synthetic Agent Initiator from the same menu. It is off by default. From a user perspective, it changes the request marker by sending or overriding `x-initiator=agent` so requests follow an early version of upstream's still-in-development synthetic initiator semantics instead of the current stable upstream behavior; it does not change who makes the final billing decision, and it does not guarantee the platform will treat those requests as non-billable.

## Experimental `/copilot-status`

- Default: **enabled**
- Nature: **experimental / workaround**, not a stable public plugin command API
- Support scope: **TUI-first**; Web/App behavior is explicitly not guaranteed to match
- Trigger: enter `/copilot-status` in a normal chat session
- Expected feedback: first a `Fetching Copilot quota...` toast, then a success or error toast

To disable this experimental feature, edit `~/.config/opencode/copilot-accounts.json` and add or set:

```json
{
  "experimentalStatusSlashCommandEnabled": false
}
```

After disabling it:

- OpenCode config injection no longer includes `/copilot-status`
- Even manual `/copilot-status` input will no longer enter the plugin workaround execution chain

## Copilot Network Retry

- Default: **disabled**
- Scope: only the official Copilot request `fetch` path returned by `auth.loader`
- Purpose: limited handling for retryable network and certificate-style failures such as `failed to fetch`, `ECONNRESET`, `unknown certificate`, or `self signed certificate`
- Strategy: preserve official loader behavior, then normalize retryable failures so OpenCode's native retry pipeline can decide whether and when to retry
- Risk: because the plugin still wraps the official fetch path, upstream internal behavior may change over time and drift is possible

## Synthetic Agent Initiator

- Default: **disabled**
- Effect: sends or overrides `x-initiator=agent` to enable upstream's in-progress synthetic initiator semantics early
- Relation to stable upstream: when enabled, request behavior intentionally differs from the current stable upstream code path; this is an early-adoption path based on upstream work in progress, not the stable upstream default
- Billing note: compressed continue-working flows and other automatically generated synthetic prompt messages may be more likely to fall outside premium request billing, but that is not guaranteed; the platform decides whether and how billing applies, so do not treat this as "guaranteed non-billable"
- Risk: this behavior may be more likely to be treated as abuse, may stop working as upstream/platform behavior changes, and may also lead to unexpected billing
- Upstream references:
  - Issue: https://github.com/anomalyco/opencode/issues/8700
  - PR: https://github.com/anomalyco/opencode/pull/8721
  - Issue: https://github.com/anomalyco/opencode/issues/8766
  - Commit: https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74

## Upstream Sync

The repository includes a committed upstream snapshot at `src/upstream/copilot-plugin.snapshot.ts` plus a sync/check script at `scripts/sync-copilot-upstream.mjs`.

Useful commands:

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

The script generates or checks the committed snapshot, requires upstream metadata for repository snapshot updates, and helps catch drift from the official `opencode` `copilot.ts` implementation.

---

## Storage

Accounts are stored in:

```
~/.config/opencode/copilot-accounts.json
```

---

## FAQ

**Do I need to change model configurations?**
No. This plugin only manages accounts and works with the official `github-copilot` provider.

**Does it replace the official provider?**
No. It uses the official provider and only adds account switching + quota checks.

**Does Copilot Network Retry replace OpenCode's retry logic?**
No. The plugin keeps retry policy inside OpenCode by normalizing retryable Copilot network/TLS failures into a shape that OpenCode already recognizes as retryable.

---

## License

MPL-2.0 License. See [LICENSE](LICENSE) for details.

