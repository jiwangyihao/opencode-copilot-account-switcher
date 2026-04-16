# WeChat Broker 单实例与 Runtime 失败模式设计

## 背景

当前现场已经确认两类严重问题，而且它们都不是“偶尔的小抖动”，而是会直接把微信链路拖入不可用状态的系统级故障。

第一类是 **broker split-brain / 多 broker 并存**。

最新现场证据已经证明：

1. 同一个可见的 OpenCode 实例，在这台机器上实际至少对应两个 `opencode.exe` 进程；
2. 单实例启动就曾直接拉起两个 broker；
3. 多实例并发恢复时，owner broker 死亡后的 replacement 竞争窗口里，能稳定复现“第二个、第三个 broker 被继续补拉”的现象；
4. 线上现场曾明确出现过 9 个 broker 同时在同一个 `wechat` state root 上健康监听端口；
5. 当前 `broker.json` 只能指向其中一个 owner，但不能阻止其他 broker 持续活着、继续吃内存、继续与状态目录发生冲突。

第二类是 **`loadPublicHelpers` 持续失败时的失控重试 / 内存暴涨**。

现场证据同样明确：

1. owner broker 在缺依赖（例如 `combined-stream` 缺 `delayed-stream`）时，会反复记录 `runtimeError stage=loadPublicHelpers`；
2. 这类失败并不会平稳降级，而是能把单个 broker 的内存一路推到十几 GB，最终把整机拖进 OOM；
3. “安装缓存损坏”只能解释触发条件，不能解释为什么失败模式会严重到这种程度；
4. 这说明当前 runtime 在 helper 装载持续失败时的 failure mode 本身就是设计缺陷。

这两条线都已经值得单独成 spec，但当前现场又清楚表明：它们会互相放大。split-brain 让多个 broker 争同一份状态根，而失控重试会让其中某一个 broker 很快吃光内存、打乱 owner 更替节奏。因此这次设计采用**分阶段整包**：在一份总 spec 中同时覆盖这两类问题，但实现上明确分成两个连续阶段。

## 目标

1. 让同一个 `wechat` state root 在任何时刻最终只收敛到一条健康的 broker owner 链，而不是长期并存多个 broker。
2. 让单实例启动也不会因为 wrapper/过渡进程参与插件加载而额外拉起 broker。
3. 在 owner 死亡、replacement 尚未 ready、以及多实例并发恢复时，避免再出现 broker 裂变。
4. 让 `loadPublicHelpers` 持续失败不再触发失控重试和内存持续上涨。
5. 让 runtime 失败模式具备足够诊断可见性，能够明确区分卡在哪个阶段，而不是只留下模糊错误。

## 非目标

1. 不在这轮里继续修改 `/reply`、`/allow`、question 文案、`/status` 文案或 debug bundle 范围。
2. 不在这轮里重做 broker<->bridge 协议。
3. 不把所有运行时错误都改造成永久禁用；这次只处理持续失败时的退避/收敛行为。
4. 不扩展多操作者、多微信账号并发绑定等更大主题。

## 方案选择

### 方案 A：分阶段整包（推荐）

做法：

1. **阶段 1** 先收 broker 单实例语义：
   - `plugin.ts` 的 broker 启动入口判定
   - `broker-launcher` 的 reuse/retire/spawn 规则
   - `broker-entry` 的 owner 失效自退
2. **阶段 2** 再收 runtime helper 持续失败的 failure mode：
   - 退避/节流
   - 内存增长风险控制
   - 诊断事件补强

优点：

- 把两条线放在一个总 spec 里，和现场真实故障面一致；
- 又不会在实现阶段把 split-brain 和 OOM 混成一个大补丁；
- 阶段 1 的验证目标和阶段 2 的验证目标都能独立成立。

缺点：

- 需要明确好阶段间共享哪些状态和边界，否则实现容易串线。

### 方案 B：只修 broker 单实例，helper failure 后续再说

优点：

- 可以更快先收掉 duplicate `/status` / 多 broker 并存。

缺点：

- 现场已经证明当前 owner broker 的 OOM 也是一级事故，不适合继续往后拖。

### 方案 C：只修 helper failure mode，把 broker 裂变先归因于环境

优点：

- 可以更快降低单 broker OOM 破坏面。

缺点：

- 与现场证据不符：多 broker 并存已经被多次直接观察到，不是可忽略噪音。

### 结论

采用方案 A：**一份总 spec，两个连续阶段**。

## 总体架构

这份设计把问题拆成两层，但共享同一条核心原则：

> 同一个 `wechat` state root 只能有一个 broker owner 语义；任何进程级入口、launcher 决策和 broker 自身都必须围绕这个原则收敛，而不是各自独立地“尽力启动”。

因此，两阶段共享的基础约束有 3 条：

1. `plugin.ts` 不是“谁加载插件就都能随意拉 broker”的入口，而是**冷启动阶段唯一但受控的 broker eager 启动入口**；
2. 运行期的 bridge reconnect / recovery 仍然允许触发 `broker-launcher`，但它们不再另造一套 owner 语义，而必须服从与冷启动相同的 reuse / replacement 规则；
3. `broker-launcher` 不是单纯“看见不匹配就补起”的执行器，而是单实例 owner 语义的仲裁层；
4. `broker-entry` 不是“启动成功后就一直活着”的后台服务，而必须持续确认自己仍然是 owner，否则主动退出。

## 阶段 1：Broker 单实例 / Owner / Replacement 语义

### 设计目标

阶段 1 要解决的是：

1. 为什么**单实例**也能双 broker；
2. 为什么 owner 死亡后 replacement 竞争会裂变；
3. 为什么同版本 healthy broker 在某些窗口里没有被复用。

### 1. `plugin.ts` 作为唯一但受控的 broker 启动入口

当前 `plugin.ts` 的 `createAccountSwitcherPlugin()` 在插件被加载时就会无条件执行 `ensureWechatBrokerStarted()`。现场和 focused RED 已经证明：这足以在单可见实例背后的多个 `opencode.exe` 进程中重复触发 broker 启动。

阶段 1 的入口策略必须改成：

1. `plugin-hooks.ts` 里现有那条 eager ensure 不再作为第二入口；
2. `plugin.ts` 保留为唯一主入口；
3. 但 `plugin.ts` 不能再无条件拉 broker，而是必须先通过一层 **bridge-capable 判定**。
4. 这里的 `bridge-capable` 不是新的模糊术语，而必须被定义成**和真实 bridge attach 同源的统一契约**：
   - 当前 `input` 必须有 `serverUrl`
   - 当前 `client` 必须满足 WeChat bridge 需要的那组能力，足以构造可用的 `wechatBridgeClient`
   - 冷启动 eager ensure 与后续真正建立 bridge 生命周期时，必须复用同一套判定，不允许 `plugin.ts` 和 bridge/runtime 各写一套“看起来差不多”的能力判断
4. 只有 bridge-capable 的进程才允许请求启动 broker；wrapper/过渡进程即使加载了插件，也不应该进入 broker 启动路径；
5. 同一进程内还需要一个最小的 process-local memo，避免 `plugin.ts` 在同一进程里被重复执行时继续打 launcher。

这里的关键点不是“猜哪个是主进程”，而是：

> 只有真正能承接 bridge/client 语义的进程，才有资格成为 broker 启动请求的来源。

### 2. `broker-launcher` 的单实例仲裁语义

阶段 1 对 launcher 的要求是：

1. **同版本 healthy broker 必须直接复用**；
2. 如果 owner 死亡后 replacement 已经写入 `broker.json`，但 endpoint 还没 ready，后续并发 launcher 必须等待这个 replacement 变 ready，而不是继续补第二个 broker；
3. 但这种等待也不能变成无限等待：如果 replacement 在 ready 之前已经崩溃、失去存活性，或者在明确的 replacement 等待窗口内始终不能变成可复用 broker，那么 launcher 必须把它判定为失效 replacement，再进入下一轮接管；
4. 版本不匹配时，退役逻辑必须尽量强，但不能把“replacement 尚未 ready”误判成“没有 owner”再继续裂变；
5. 在多实例、包括你现场的 6 launcher 并发恢复场景下，也必须最终只收敛到一个 replacement owner。

也就是说，launcher 在阶段 1 里的职责不是“尽快保证有人活着”，而是：

> 在 owner 更替窗口内，保证新的 owner 是唯一被补起的那一个。

### 3. `broker-entry` 的 owner 失效自退

即使前面两层都失手，`broker-entry` 本身也要再加一层最后保险：

1. broker 启动后持续确认 `broker.json` 当前 owner 是否仍然指向自己；
2. 这里的“我已经真正拿到 owner”也必须写成可观测契约，而不是让实现自己猜时间窗：
   - 只有在 broker 已经成功监听自己的 endpoint，且 `broker.json` 当前记录的 `{ pid, startedAt, version, endpoint }` 明确指向自己之后，才算进入 owner 稳定期
   - 在这之前都属于启动期，不能因为 owner 检查暂时不一致就误自退
3. 如果 owner file 已经明确指向别的 broker，就进入自退流程；
4. 这里必须避免“刚启动还没真正拿到 owner 就误自退”的窗口，因此需要显式区分：
   - 尚未完成 owner 建立的启动期
   - 已经建立 owner 后的稳定期

这层保险的目标不是取代 launcher，而是：

> 一旦 split-brain 真的发生，非 owner broker 也要尽快自行收敛，不长期继续吃内存和回复消息。

### 阶段 1 成功判定

阶段 1 至少要通过这些验证：

1. 单可见实例对应的 wrapper + 实际进程，不会因为两边都加载插件而双 broker；
2. 同版本 healthy broker 在单实例和多实例场景下都能稳定复用；
3. owner 死亡后 replacement 已写入 `broker.json` 但 **尚未 ready** 的窗口内，不再裂变出第二个 replacement；
4. replacement 如果在等待窗口内崩溃、失去存活性，或长时间保持 not-ready，launcher 会按明确失效条件重新接管，而不是无限等待或继续裂变；
5. 6 launcher 并发竞争时，最终仍只保留一个 owner broker 链；
6. 失去 owner 的 broker 会主动退出，而不是长期并存。

## 阶段 2：`loadPublicHelpers` 持续失败时的 Runtime Failure Mode

### 设计目标

阶段 2 处理的是当前现场另一条已经独立成立的一级事故：

1. `loadPublicHelpers` 缺依赖会持续失败；
2. 当前 failure mode 不是平稳降级，而是每秒重试并且伴随明显内存上涨；
3. 用户很难仅靠现有日志理解“是缓存坏了、是 helper 装载失败，还是消息链路本身没进来”。

### 1. 限制持续失败时的失控重试

阶段 2 必须把“每秒一轮、无上限、每轮重走重路径”的 failure mode 改成受控形态。原则上要做到：

1. 连续 `loadPublicHelpers` 失败时，不能继续以固定短间隔无限高速重试；
2. 失败重试需要进入显式退避，而不是一直压同一条热路径；
3. 不要求彻底停止重试，但必须把重试频率降到不会把进程持续推向 OOM 的水平；
4. 这里的成功标准不是“短时间看起来没继续涨”，而是**同一诱发条件持续存在时，failure mode 必须进入有界稳态**：
   - 连续失败经过若干轮后，重试节奏进入受控退避，而不是继续线性高频触发
   - 内存占用不再随失败轮次持续线性上涨，而应出现 plateau / 收敛趋势

### 2. 限制失败对象的累积与内存增长

阶段 2 不把“缺依赖”本身当设计可接受的常态，但也不接受“缺一个依赖就把 broker 吃到十几 GB”。因此：

1. 每次失败重试不能继续无界积累 helper 装载链里的失败对象、模块结果或中间状态；
2. helper 装载失败后，相关失败对象要能被及时释放；
3. 诊断和退避状态要足够说明问题，但不能本身成为新的泄漏源；
4. 这里的验收重点不是“失败次数变少”，而是**在同一持续失败场景下，进程资源不再出现无上限增长**。

### 3. 诊断可见性必须提升到能指导现场排障

阶段 2 不是只做“别 OOM”，还要让用户知道到底卡在哪。最少应做到：

1. 诊断里能明确区分：
   - 当前失败停留在哪个 stage（至少 `loadPublicHelpers`）
   - 后续关键阶段（尤其 `getUpdates`）是否根本未触达
2. 连续失败时，诊断必须暴露一个最小但稳定的退避状态面，至少能看出：
   - 当前是第几轮连续失败
   - 当前退避/等待是否已生效
   - 下一次重试大致还要等多久或当前退避级别处于哪一档
3. 错误文本应足以区分“缓存坏了/缺依赖”和“消息链路没进来”；
4. 这些可见状态必须是结构化、稳定、可持续读取的，不接受仅靠自由格式 log 文本去让现场人工猜测。

### 阶段 2 成功判定

阶段 2 至少要通过这些验证：

1. 模拟缺依赖 / 坏 cache 时，不再出现无限高速重试；
2. 同样的失败场景下，进程内存不再出现持续无界上涨，而是进入可观察的收敛/plateau；
3. 诊断能明确说明卡在 `loadPublicHelpers`，并能看出退避状态与阶段停留点；
4. 现场再出现这类问题时，不需要再靠猜“是 slash 没收到还是 helper 没装上”。

## 范围控制

这份 spec 只收两条线：

1. broker 单实例 / owner / replacement 语义；
2. `loadPublicHelpers` 持续失败时的 runtime failure mode。

明确不在本轮内顺手扩的内容：

1. `/reply` / `/allow` 协议或文案
2. debug bundle 导出范围
3. release/install 文档
4. broker 之外的更多 OpenCode 进程治理
5. 更大范围的 OpenClaw 兼容改造

## 测试策略

### 阶段 1

必须至少覆盖：

1. `plugin.ts` 在非 bridge-capable 进程中不会 eager ensure broker
2. 单实例双进程不会双 broker
3. 同版本 healthy broker 必须复用
4. owner 死亡后 replacement **尚未 ready** 的窗口内不再裂变
5. replacement 崩溃或长期 not-ready 时，launcher 会按明确失效条件重新接管，而不是无限等待
6. 6 launcher 并发竞争下最终只保留一个 owner 链
7. 失去 owner 的 broker 会自退
8. bridge reconnect / recovery 在运行期重新触发 launcher 时，也必须满足与冷启动同样的复用和 replacement 规则

### 阶段 2

必须至少覆盖：

1. `loadPublicHelpers` 连续失败时进入受控退避
2. 同样失败场景下不会出现持续无界内存增长，而会进入可观察的有界稳态
3. 诊断里能明确看到 `loadPublicHelpers` 失败、失败轮次和退避状态
4. `getUpdates` / 后续链路未触达时，诊断能体现阶段停留点，而不是只剩一条模糊错误字符串

## 成功判定

这份整包设计完成后，应满足：

1. 同一个 `wechat` state root 最终只存在一个可用 broker owner 链，而不是多个健康 broker 长期并存；
2. 单实例启动不再因为 wrapper/过渡进程也加载插件而双 broker；
3. owner 死亡与 replacement 竞争场景不再轻易裂变；
4. 运行期 bridge reconnect / recovery 在触发 launcher 时，也继续服从同一套 owner / reuse / replacement 规则，不会成为新的隐形第二仲裁路径；
5. `loadPublicHelpers` 持续失败不再把进程拖到 OOM；
6. 现场再次出问题时，日志和诊断足以说明是 owner 竞争还是 helper failure mode，而不是继续靠人工猜。 
