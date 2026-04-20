# README 微信通知文档更新设计

## 背景

当前 README 已经覆盖安装、账号管理和若干 Copilot 工作流能力，但对微信通知这条线的说明仍不完整：

1. README 顶部没有一个能快速说明“最近更新了什么”的高亮区。
2. 微信通知相关能力已经明显扩展，但 README 里还缺一段面向普通用户的完整说明。
3. 用户现在需要理解的不只是“有微信通知”，而是：
   - question / permission / terminal result / natural-stop / retry-error 分别是什么
   - 什么时候可以 `/reply` 或 `/allow`
   - 电脑端终结后旧入口为什么会失效
   - 为什么有些通知是信息型摘要，有些通知可以继续回复

这轮目标不是重写整份 README，而是在不破坏当前安装/使用主结构的前提下，把微信通知功能补成一段完整、可扫读、可操作的用户文档。

## 目标

1. 在 badge 下方新增一个短的 highlight 区，展示 `v0.14.46` 最近更新的微信通知变化。
2. 在 README 正文中新增一个“微信通知功能”章节，完整说明这条能力线。
3. 文案采用用户视角，强调“会收到什么、怎么回复、什么时候会失效”，而不是内部实现细节。
4. 中文 README 作为主说明；英文部分同步补一版结构一致、但更精简的说明，避免中英文结构失衡。

## 非目标

1. 不重排 README 的整体结构，不把安装/使用方式整体搬到别处。
2. 不在这轮新增单独的外部文档页；用户已明确选择只改 README。
3. 不把 release notes 直接复制进 README，也不做成长篇 changelog。
4. 不解释 broker/store/protocol 等内部实现名词。

## 方案选择

### 方案 A：顶部 highlight + 正文单独章节

做法：

1. badge 下方增加一个短 highlight 区，明确 `Latest in v0.14.46`。
2. 在“功能一览”之后、“安装”之前新增“微信通知功能”章节。

优点：

- 顶部一眼能看到最近更新。
- 正文还能有一段完整说明，不会把安装区挤没。
- 最符合“README 既可扫读又能完整说明”的目标。

缺点：

- 需要同时修改 README 顶部布局和正文结构。

### 方案 B：全部塞到顶部大区块

做法：

- 把 highlight 和完整微信通知说明都放到 README 顶部。

优点：

- 最醒目。

缺点：

- 会显著拉长 README 开头，安装与使用入口后移。

### 方案 C：只加 highlight，不加正文专章

做法：

- 顶部增加 `v0.14.46` 更新提示，但正文只在现有功能清单里补几条。

优点：

- 改动最小。

缺点：

- 无法达到“完整说明微信通知功能”的目标。

### 结论

采用方案 A：**顶部 highlight + README 正文单独章节**。

## 设计细节

### 1. 顶部 highlight 区

README 顶部 badge 下方新增一个短区块，满足以下合同：

1. 明确写出 `Latest in v0.14.46`。
2. 控制在 3-4 行可扫读内容内。
3. 内容只写用户能感知到的更新，不写底层实现名词。
4. 至少覆盖这次最重要的 3 类变化：
   - question / permission 示例逐行独立，更方便在微信里整行复制
   - 电脑端终结后旧 qid / handle 会回收，并给出明确终结原因
   - natural-stop 可直接 `/reply`，retry/error 摘要更清楚
5. 顶部 highlight 不得只服务中文。它必须是双语或语言中立结构，至少让中文和英文读者都能看懂“这是 v0.14.46 最近更新摘要”。

这块是“最近更新 highlight”，不是 changelog，也不是功能总览替代品。

### 2. README 正文新增“微信通知功能”章节

新增章节放在：

- `## 功能一览` 之后
- `## 安装` 之前

章节目标是让用户看完后能回答 4 个问题：

1. 我会收到哪些微信通知？
2. 哪些可以回复，回复命令长什么样？
3. 电脑端处理后，旧入口为什么会失效？
4. natural-stop 和 ordinary retry/error 的区别是什么？

### 3. 正文内容合同

“微信通知功能”章节至少包含以下 5 小节：

1. **通知类型总览**
   - question
   - permission
   - terminal result
   - natural-stop
   - retry/error

2. **可回复入口**
   - question 使用 `/reply <qid> ...`
   - permission 使用 `/allow <handle> ...`
   - natural-stop 使用 `/reply <s*> ...`

3. **电脑端终结后的行为**
   - 旧 qid / handle 会失效
   - 微信侧会收到终结结果
   - 再次回复会得到稳定“已结束 + 原因”提示

4. **natural-stop 与 retry/error 的区别**
   - natural-stop 是可回复分支
   - ordinary retry/error 是信息型摘要，不是可回复入口

5. **文案使用方式**
   - 示例逐行独立，方便微信里整行复制
   - question 选项会同时显示标题和说明

除此之外，这 5 个小节不是只要“提到名词”就算完成，而要满足更硬的用户视角合同：

1. `question`、`permission`、`terminal result`、`natural-stop`、`retry/error` 这 5 类通知都必须各自至少写出一条“你会收到什么 / 是否可回复 / 下一步该怎么做”的说明。
2. “可回复入口”小节必须给出独立命令示例：
   - `/reply <qid> ...`
   - `/allow <handle> ...`
   - `/reply <s*> ...`
   不能只在段落里口头提到命令形态。
3. “电脑端终结后的行为”必须明确写出两层信息：
   - 微信侧会收到一条终结结果通知
   - 之后再次 slash 会得到稳定“已结束 + 原因”提示
   这两层不能混写成一句泛化描述。
4. `natural-stop` 与 `retry/error` 的区别必须明确到用户能判断：
   - natural-stop 是可回复分支
   - ordinary retry/error 是信息型摘要
   - ordinary retry/error 不应被描述成“等你回复”

### 4. 文案风格

README 新增内容必须遵守：

1. 面向普通用户，不写 broker/store/protocol/internal transport 等术语。
2. 多用“你会看到什么”“你该怎么做”，少用实现过程叙述。
3. 例子尽量短，命令保留真实形态。
4. 中文说明完整；英文说明必须保留同样的结构骨架，而不是退化成装饰性摘要。
5. 英文 README 中必须有与中文对应的 `WeChat Notifications` 章节，位置和职责与中文镜像；至少覆盖同一组通知类型、可回复命令、终结行为、以及 `natural-stop` vs `retry/error` 的区别。

## 测试与验收

这轮主要是 README 文档更新，但仍需要有明确的完成标准：

1. README 顶部存在 `Latest in v0.14.46` highlight 区。
2. highlight 区内容是最近更新摘要，而不是 changelog 或内部实现说明；且它必须对中文和英文读者都可读。
3. README 正文新增“微信通知功能”章节，且位置在“功能一览”后、“安装”前。
4. `question`、`permission`、`terminal result`、`natural-stop`、`retry/error` 这 5 类通知在正文里都各自至少有一条用户视角说明，能回答“会收到什么 / 是否可回复 / 下一步该做什么”。
5. README 中明确出现独立命令示例：`/reply <qid>`、`/allow <handle>`、`/reply <s*>`。
6. “电脑端终结后的行为”同时写清两层信息：终结结果通知，以及再次 slash 的稳定“已结束 + 原因”提示。
7. `natural-stop` 可回复、ordinary retry/error 不可回复，这条边界在正文中明确可见。
8. 英文部分必须有与中文对应的 `WeChat Notifications` 章节，而不是只剩一段摘要或几条散落 bullet。

## 成功判定

完成后，用户打开 README 时应能同时得到两层信息：

1. 顶部一眼看懂：`v0.14.46` 最近更新了哪些微信通知体验。
2. 正文继续看时，能完整理解微信通知功能怎么用，而不需要去读 release notes 或源码。
3. 无论读中文还是英文，都能独立理解微信通知这条能力线，而不是只能从一种语言里获得完整信息。

如果 README 仍然只能让用户知道“有微信通知”，但讲不清“什么时候会收到什么、怎么回复、什么时候旧入口失效”，就不算完成。
