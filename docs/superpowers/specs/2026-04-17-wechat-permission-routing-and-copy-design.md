# WeChat Permission 路由与文案修订设计

## 背景

当前微信交互链路已经具备基础能力，但还有两类明显缺口：

1. **动作正确性问题**
   - 当同一会话里同时存在多条 permission request 时，用户在微信里同意第一条请求，剩余 permission request 也会被一起同意。
   - 这说明 `/allow <handle>` 当前并没有严格只命中单条目标 request / notification，而是存在过宽的会话级或批量级处理。

2. **交互表达问题**
   - question 通知仍没有把“如何使用自定义回复”讲清楚。
   - 对于允许自定义的多选题，当前文案与解析都没有明确支持“编号 + 自定义补充”的混合模式。
   - `/status` 虽然已经比早期更可读，但 todo 展示仍缺每个 todo 项的执行状态，tag 形式也还可以再收敛成更统一、更容易扫读的样式。

这次要解决的不是一个孤立 bug，而是一条统一的“**微信交互正确性 + 表达修订**”线：先收动作正确性，再把微信里看到的 question / permission / `/status` 文案一起改成更像给人看的产品形态。

## 目标

1. 修 `/allow` 的目标路由与状态回写，让多个 permission request 并存时只处理当前 handle 对应的那一条。
2. 扩展 question 的回复语义与微信提示，支持：
   - 纯编号
   - 纯自定义
   - 多选编号 + 自定义补充的混合输入
3. 升级 permission 文案，让用户看得出“自己在批准什么”。
4. 升级 `/status` 的 todo 展示与 tag 样式，让 todo 的状态与内容成为主信息，而不是内部元数据。

## 非目标

1. 不修改 broker owner / replacement / runtime failure mode 这条线。
2. 不修改 debug bundle、runtime diagnostics、release/install 文档。
3. 不扩 `/recover`、通知发送链、broker 生命周期或其它协议面。
4. 不引入按钮式交互或额外的微信侧状态机。

## 方案选择

### 方案 A：正确性优先的一体化修订

做法：

1. 先修 `/allow` 的精确路由与状态回写。
2. 在同一条线里统一收 question / permission / `/status` 的交互表达。

优点：

- 不会把真 bug 淹没在纯文案改动里。
- 又能避免把相互关联的微信交互面拆成两个版本反复改。

缺点：

- 需要同时触达 broker-entry、question-interaction、notification-format、status-format 等几个文件。

### 方案 B：最小热修，只修 permission 串批

做法：

- 只收 `/allow` 的目标路由 bug，把文案和格式全部留到下一轮。

优点：

- 风险最小。

缺点：

- 用户这轮新提出的 question 自定义回复提示、todo 状态、tag 样式问题还会继续存在。

### 方案 C：展示优先，先改 question/status 文案

做法：

- 先让 question / permission / `/status` 看起来更完整，再回头修 permission 路由 bug。

优点：

- 用户立刻能看到界面改善。

缺点：

- 真 bug 仍然存在，风险判断顺序是错的。

### 结论

采用方案 A：**正确性优先的一体化修订**。

## 总体架构

这条线分成两层，但仍是一份统一设计：

1. **动作正确性层**
   - `/allow <handle>` 只允许命中一条 open permission request。
   - broker 本地状态回写也只允许作用于这一条 request 与其对应 notification。

2. **微信表达层**
   - question 通知明确展示题面、选项、编号回复、自定义回复、以及“编号 + 自定义补充”的可用语法。
   - permission 通知明确展示审批对象与 `once/always/reject` 各自语义。
   - `/status` 以 session 标题分段，tag 收紧成统一样式，并把每个 todo 的状态 + 内容放到更前面。

也就是说，这次不是把 bug 修和文案改拆成两个版本，而是在同一条线里先保 correctness，再统一收 presentation。

## 设计细节

### 1. `/allow` 的目标路由与状态回写

`/allow <handle> <once|always|reject> [message]` 的正确语义必须是：

1. 先按 handle 查找**唯一** open permission request。
2. 只对这条 request 发起 bridge RPC 或 fallback client.reply。
3. 只有当目标 bridge RPC / fallback client.reply 明确返回 success 后，才允许进入任何本地状态变更。
4. 本地状态变更顺序必须固定为：先写目标 request 终态，再 resolve 对应 notification。
5. 如果目标 bridge RPC / fallback client.reply 失败，或者目标 request 终态写入失败，则目标 request 必须继续保持 open，目标 notification 必须继续保持 pending / 未 resolved。
6. 同一 session 里其它 permission request 保持原样，不得一起被 answered / rejected / resolved。
7. 对应地，只有目标 handle 绑定的 notification 允许被标记为 `resolved`；同 session 里其它 permission notification 必须保持原样，不得被一起清掉。

这条线必须避免任何“按 session 批量 resolve”或“先把当前 session 里的 permission 都清掉”的逻辑。

### 2. Question 的四类回复语义

当前 question 需要明确支持以下四类输入：

1. **文本题**
   - 例：`/reply q4 这里是完整回复`
   - 行为：整段文本作为最终 answer

2. **纯编号**
   - 单选：`/reply q4 2`
   - 多选：`/reply q4 1,3`
   - 行为：broker 解析成结构化 `answers`

3. **纯自定义**
   - 例：`/reply q4 你的自定义回答`
   - 前提：该题 `custom=true` 或题型本身是纯文本题

4. **编号 + 自定义补充（重点补的新语义）**
    - 例：`/reply q4 1,3; 其他：先灰度再全量`
    - 适用范围：**只在 `multiple + custom=true` 时成立**；本轮不把这条混合语义扩到单选题。
    - 语法合同：
      1. 只认第一个 `;` 作为“编号选择”和“自定义补充”的分隔符。
      2. 分隔符前半段必须是合法的多选编号列表，例如 `1,3`。
      3. 分隔符后半段必须是非空自定义文本；若带 `其他：` 前缀，只用于用户提示，broker 在构造最终 `answers` 时应去掉该前缀。
      4. 其它形式都视为非法混合输入，并返回稳定中文提示，而不是自行猜测。
    - 判定优先级：
      1. 只有当题型为 `multiple + custom=true`，并且第一个 `;` 前半段满足合法多选编号列表时，才进入 mixed mode 解析。
      2. 对于其它题型，如果输入看起来像 mixed mode（即第一个 `;` 前半段是合法编号列表），则必须返回稳定中文提示，明确当前题型不支持“编号 + 自定义补充”，而不是把它当成纯自定义回复吞掉。
      3. 如果题目允许纯自定义回复，且输入虽然包含 `;` 但前半段并不是合法编号列表，则整段输入仍按纯自定义文本处理，不触发 mixed mode。
    - 行为：
      - broker 先解析前半段编号选择
      - 再把后半段自定义补充作为**同一轮 answer 集合里的额外条目**一并提交
      - 最终 `answers` 应等价于 `[[<选项值1>, <选项值2>, <自定义文本>]]`，而不是留给 bridge 再猜
   - 这条路径必须在文案和解析两侧同时明确支持，不能只改提示不改行为。

### 3. Question 文案

question 通知必须至少包含：

1. 完整题面（标题 + 正文）
2. 选项列表（如果有）
3. 对应 handle
4. 三类可用语法说明：
   - 编号回复
   - 自定义回复
   - 编号 + 自定义补充（当题目允许时）

文案必须根据题型与 `custom` 能力区分：

- `single + custom=false`
- `single + custom=true`
- `multiple + custom=false`
- `multiple + custom=true`
- `text`

不允许再把“自定义回复是否可用”留给用户猜。

### 4. Permission 文案

permission 通知必须明确告诉用户：

1. 这条 permission 在批准什么
2. 目标对象 / 操作对象 / 描述（如可用）
3. 当前请求对应的 handle
4. 三条可直接执行的命令用法：`/allow <handle> once`、`/allow <handle> always`、`/allow <handle> reject`
5. `once`、`always`、`reject` 三者分别怎么用

也就是说，permission 不能只剩抽象说明，也不能只剩 `handle` 与命令行示例；它必须同时让人一眼看出“自己到底在批准什么”，并且能立刻复制可执行用法。

### 5. `/status` 排版与 tag 样式

`/status` 这次要继续收口成“给微信读”的输出，而不是内部调试输出。

要求：

1. 以 session 标题分段，而不是内部 `instanceID/sessionID`。
2. 每段前面保留短标签，而且**必须**统一成行内 code 风格，而不是纯文本随意输出。例如：
   - `` `#busy` ``
   - `` `#todo:1` ``
   - `` `#question:0` ``
   - `` `#permission:3` ``
3. 每个 todo 项都必须显示：
   - 执行状态
   - 完整内容
4. 为了做到这一点，上游汇总链路不能再只给 todo 纯文本，而必须保留每条 todo 的**结构化状态 + 内容**，再交给 `/status` formatter 渲染。
5. question 只给必要简写，因为用户在 question 通知里本来就该看到完整题面。
6. 不再把 `instanceID`、`sessionID`、精确到秒的创建时间等内部元数据放在主展示区。

### 6. 状态显示形式建议

todo 展示这次不再停留在“建议”，而是明确采用 Markdown checklist 风格文本：

- `[ ] 发布 release 草稿`
- `[x] 更新 README`
- `[-] 等待 npm 发布`
- `[~] 已取消的迁移任务`

如果当前 status-format 层已有稳定状态枚举，则应直接映射到这种文本形式，而不是另造一套新的状态系统。当前至少要覆盖：

- `pending` -> `[ ]`
- `completed` -> `[x]`
- `in_progress` -> `[-]`
- `cancelled` -> `[~]`

这组映射不是展示建议，而是 `/status` 的测试与验收合同。

## 测试策略

至少覆盖：

1. 多条 permission request 并存时：
    - `/allow p1 ...` 只处理 `p1`
    - 成功路径下只允许目标 request 写终态、只允许目标 notification 被 resolve
    - 失败路径下目标 request 仍保持 open、目标 notification 仍保持 pending / 未 resolved
    - 其它 open permission 保持不变
    - 其它 permission notification 也保持 pending / 未 resolved
2. Question 四类输入：
    - 文本题
    - 纯编号
    - 纯自定义
    - 编号 + 自定义补充
    并且必须明确验证：
    - 只有 `multiple + custom=true` 允许混合输入
    - 分隔符只认第一个 `;`
    - 只有前半段为合法多选编号列表时才进入 mixed mode
    - 其它题型遇到 mixed mode 形态输入时返回稳定中文提示
    - 允许纯自定义的题目里，包含 `;` 但不构成 mixed mode 的输入仍按纯自定义处理
    - 非法混合输入返回稳定中文提示
3. question 文案会明确展示：
    - 题面
    - 选项
    - 编号回复示例
    - 自定义回复示例
    - 混合输入示例（当适用）
4. permission 文案会明确展示批准对象、handle、三条可直接执行的 `/allow <handle> ...` 用法，以及 `once/always/reject` 语义。
5. `/status` 输出会：
    - 按 session 标题分段
    - 用统一的行内 code tag 样式
    - 用 `pending -> [ ]`、`completed -> [x]`、`in_progress -> [-]`、`cancelled -> [~]` 的固定映射展示每个 todo 的状态 + 内容
    - 不再把内部 ID 作为主内容

## 成功判定

完成后应满足：

1. 多条 permission request 并存时，不再出现“同意第一个，其它也一起被同意”的错误。
2. 用户可以在微信 question 通知里明确看出：
    - 如何编号回复
    - 如何纯自定义回复
    - 如何做多选 + 自定义补充
3. permission 通知会让用户明确看出自己在批准什么，并同时提供 handle 与可直接执行的 `/allow <handle> once|always|reject` 用法。
4. `/status` 会更像真正的工作摘要，而不是内部字段 dump；其中 todo 状态必须稳定映射为 `[ ]`、`[x]`、`[-]`、`[~]` 四种 checklist 形式。
5. 整条线仍然不扩到其它子系统。
