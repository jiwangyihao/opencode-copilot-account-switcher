# README 微信通知文档更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新 `README.md`，在 badge 下方新增 `v0.14.46` recent highlight 区，并补一段完整、用户导向的微信通知功能说明。

**Architecture:** 这轮只改 `README.md`，不新增额外 docs 页面，也不改变现有安装/使用主结构。README 顶部用一个短 highlight 区做“最近更新”提示，正文则新增独立的“微信通知功能”章节，用用户视角解释 question、permission、terminal result、natural-stop 与 retry/error 的行为和入口。

**Tech Stack:** Markdown, existing README bilingual structure, current release copy and shipped WeChat notification behavior

---

## 文件结构预分解

- `README.md`
  - 在 badge 下方新增 `Latest in v0.14.46` highlight 区。
  - 在中文 `## 功能一览` 之后、`## 安装` 之前新增“微信通知功能”章节。
  - 在 English 部分新增与中文镜像的 `## WeChat Notifications` 章节。
  - 保持安装、使用方式、实验性功能说明的主结构不变。

### Task 1: 新增顶部 highlight 与中文微信通知章节

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 先确认 README 当前缺少哪些目标锚点**

Run: `rg -n "Latest in v0.14.46|## 微信通知功能|/reply <qid>|/allow <handle>|/reply <s\*>" README.md`
Expected: 当前 README 里找不到 `Latest in v0.14.46` 和 `## 微信通知功能`，说明新增区块尚未落地。

- [ ] **Step 2: 在 README 顶部加入 recent highlight 区**

把 badge 下方改成“badge + highlight + 语言锚点”的结构，highlight 控制在短区块内。目标形态应接近：

```md
[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

> **Latest in v0.14.46**
> 
> - question / permission examples are now line-by-line, easier to copy from WeChat
> - old qid / handles now close with explicit terminal reasons after desktop-side completion
> - natural-stop is replyable, and retry / error summaries are easier to read
> - question / permission 示例现在逐行独立，更方便在微信里整行复制
> - 电脑端结束后旧 qid / handle 会回收，并给出明确终结原因
> - natural-stop 可直接 `/reply`，retry / error 摘要也更清楚

[中文](#中文) | [English](#english)
```

要求：

- highlight 只写用户能感知到的变化
- 不写 broker/store/internal transport
- 维持 README 顶部可扫读
- 顶部区块必须是双语或语言中立结构，不能做成“英文标题 + 中文内容”

- [ ] **Step 3: 在中文部分新增“微信通知功能”章节**

把新章节插在中文 `## 功能一览` 后、`## 安装` 前，并至少包含这 5 组信息：

```md
## 微信通知功能

微信通知现在会覆盖 5 类场景：

- **question**：需要你直接回复的问题，使用 `/reply <qid> ...`
- **permission**：需要你确认工具或动作的请求，使用 `/allow <handle> ...`
- **terminal result**：电脑端已经处理完旧入口后，微信侧收到的终结结果通知
- **natural-stop**：Agent 自然中止后给你的可回复补充入口，使用 `/reply <s*> ...`
- **retry / error**：信息型错误摘要，帮助你判断是否需要回到电脑端处理

### 什么时候可以回复

- question：`/reply <qid> 你的回复`
- permission：`/allow <handle> once|always|reject`
- natural-stop：`/reply <s*> 你的补充内容`

### 电脑端终结后会发生什么

- 如果电脑端已经回复、拒绝、过期或替代某个旧入口，微信侧会先收到一条终结结果通知
- 旧 qid / handle 不会继续悬挂成可回复入口
- 你再发一次 `/reply ...` 或 `/allow ...` 时，会得到稳定的“已结束 + 原因”提示

### natural-stop 和 retry / error 的区别

- **natural-stop** 是可回复分支，表示 Agent 在等待你的补充
- **retry / error** 是信息型摘要，不是可回复入口

### 为什么文案现在更容易复制

- question / permission 示例会逐行独立展示
- question 选项会同时显示标题和说明
```

要求：

- 每类通知都要回答“你会收到什么 / 是否可回复 / 下一步该做什么”
- 3 条命令示例要独立出现，不要只在段落里提到
- “终结结果通知”和“再次 slash 的稳定拒绝提示”要写成两层不同信息

- [ ] **Step 4: 运行 README 锚点检查，确认中文段落已落地**

Run: `rg -n "Latest in v0.14.46|## 微信通知功能|question|permission|terminal result|natural-stop|retry / error|/reply <qid>|/allow <handle>|/reply <s\*>" README.md`
Expected: 能找到顶部 highlight、中文新章节、5 类通知和 3 条命令入口。

### Task 2: 同步 English 结构并校正文案一致性

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 先确认 English 区域当前没有镜像说明**

Run: `node -e "const fs=require('node:fs');const text=fs.readFileSync('README.md','utf8');const start=text.indexOf('## English');const end=text.indexOf('## Installation', start);const english=text.slice(start,end===-1?text.length:end);if(/## WeChat Notifications/.test(english)){process.exit(1)}"`
Expected: 命令成功退出，说明 English 区域当前还没有独立 `## WeChat Notifications` 镜像章节。

- [ ] **Step 2: 在 English 部分新增镜像章节**

在 English 区域新增与中文职责一致、但措辞更精简的章节。该章节必须插在 English `## What You Get` 之后、English `## Installation` 之前，并且要保留与中文相同的 5 块职责骨架：`Overview / Replyable entries / After desktop-side completion / natural-stop vs retry / error / Copy-friendly message format`。目标形态应接近：

```md
## WeChat Notifications

WeChat notifications now cover five user-facing cases:

- **question** — reply with `/reply <qid> ...`
- **permission** — handle with `/allow <handle> ...`
- **terminal result** — tells you an old entry was closed on the desktop side
- **natural-stop** — a replyable stop point, using `/reply <s*> ...`
- **retry / error** — an informational summary, not a replyable entry

### Replyable entries

- question: `/reply <qid> ...`
- permission: `/allow <handle> once|always|reject`
- natural-stop: `/reply <s*> ...`

### What happens after desktop-side completion

- you receive a terminal result notification
- the old qid / handle is no longer replyable
- sending the old command again returns a stable closed reason instead of silently hanging around

### natural-stop vs retry / error

- `natural-stop` is replyable
- ordinary retry / error is informational only

### Copy-friendly message format

- command examples stay on their own lines for easier WeChat copy
- question options show both the title and its explanation when available
```

要求：

- 结构和中文镜像
- 不要求逐句直译，但信息层级必须一致
- English 不能退化成只剩几条 marketing bullet
- 只允许压缩措辞，不允许少掉中文已有的职责块或命令示例

- [ ] **Step 3: 做中英文结构一致性检查**

Run: `node -e "const fs=require('node:fs');const text=fs.readFileSync('README.md','utf8');const zhStart=text.indexOf('## 微信通知功能');const zhEnd=text.indexOf('## 安装', zhStart);const enStart=text.indexOf('## WeChat Notifications');const enEnd=text.indexOf('## Installation', enStart);const zh=text.slice(zhStart,zhEnd===-1?text.length:zhEnd);const en=text.slice(enStart,enEnd===-1?text.length:enEnd);for(const snippet of ['## 微信通知功能','/reply <qid>','/allow <handle>','/reply <s*>','terminal result','natural-stop']){if(!(zh.includes(snippet)||en.includes(snippet))){process.exit(1)}}if(!en.includes('## WeChat Notifications')||!en.includes('/reply <qid>')||!en.includes('/allow <handle>')||!en.includes('/reply <s*>')){process.exit(1)}"`
Expected: 命令成功退出，说明中文和英文对应区段都能找到镜像章节与命令示例。

### Task 3: 收尾校验 README 结构与可读性

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 手工收口文案，确保 README 没被写成 changelog 或实现说明**

重点检查：

```md
- highlight 区仍然短，不抢安装区位置
- “微信通知功能”章节回答的是用户问题，而不是实现细节
- 中文和英文都没有出现 broker/store/protocol/internal transport 这类术语
- 命令示例保持真实、短、独立
```

- [ ] **Step 2: 跑最终 README 完整检查**

Run: `rg -n "Latest in v0.14.46|## 微信通知功能|## WeChat Notifications|/reply <qid>|/allow <handle>|/reply <s\*>|已结束 \+ 原因|replyable|informational" README.md`
Expected: 顶部 highlight、中文/英文章节、3 条命令示例、终结行为说明、natural-stop vs retry/error 区分都能在 README 里找到。

- [ ] **Step 3: 做最终人工验收清单**

逐条人工确认以下事项，不允许只靠关键词存在性判断：

```md
- 顶部 highlight 仍是 recent update，而不是 changelog
- 顶部 highlight 对中文和英文读者都可读
- 中文 `## 微信通知功能` 在“功能一览”后、“安装”前
- 英文 `## WeChat Notifications` 在 English `## What You Get` 后、`## Installation` 前
- 5 类通知在中文和英文里都各自回答了“会收到什么 / 是否可回复 / 下一步该做什么”
- `/reply <qid>`、`/allow <handle>`、`/reply <s*>` 都以独立命令示例出现
- “终结结果通知”和“再次 slash 的稳定拒绝提示”两层信息都明确写出
- natural-stop 被写成可回复分支，ordinary retry / error 被写成信息型摘要
- question 标题 + 说明、示例逐行独立，这类 copy-friendly 约定在中文和英文里都有对应解释
- 整个 README 没有滑成 release notes、changelog 或实现说明
```

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs(readme): 补充微信通知功能说明"
```
