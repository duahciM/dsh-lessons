# DSH 任务复盘插件（dsh-lessons）
（效果没实验，我只能保证理论上有用）

[English](README_en.md)
> 让 Agent 在任务结束后复盘，把可复用的经验沉淀下来，并在后续任务中按作用域注入。
>
> 运行环境 DeepSeek Harness `0.2.1-rc.5`

---

## 一、插件解决的问题

Agent可能在不同任务中重复犯错,当前会话结束后,相关上下文不一定会保留,换一个会话Agent也未必能利用之前的经验。

单纯增加提示词只能提供静态规则，无法自然记录某次任务中实际出现的问题、修正方法，以及这些经验后来是否再次得到验证。

本插件尝试建立一个闭环：

```text
任务开始 → 决策 → 任务结束 → Agent反思 → 结构化记忆
   ↑                                           │
   └──────────── 后续任务读取并应用经验 ────────┘
```

插件试图解决的问题是：一次任务中形成的经验，能否迁移到后续的独立任务？

> 实验数据请看第四节

---

## 二、插件的机制

### 2.1 四个工具

| 工具 | 作用 |
|---|---|
| `task_start(goal, expected_result)` | 声明任务目标与预期结果，建立任务记录 |
| `task_end(task_id, status, result)` | 声明任务结果，关闭任务并生成复盘材料 |
| `task_reflect(task_id, assessment, source, lessons[])` | 保存Agent对任务的反思和经验 |
| `lessons_lookup(lesson_id)` | **按需**追溯一条经验的完整来源（只读） |

`task_end` 会把任务时间窗内的材料整理成一份**决策轨迹**，主要包括用户请求和纠正、Agent对外表述，以及在缺少对外表述时限量的采集推理摘录。它不收集完整工具调用清单，工具失败计数只作为辅助信号。

这里的反思对象是Agent的**工作决策**，而不是工具调用技巧，工具调用记录与任务决策轨迹分开处理。
   
任务状态包括 `succeeded`、`failed`、`abandoned` 和 `aborted`

#### `lessons_lookup`：按需追溯，而不是预先塞满

决策环境里每个条目都带 id，但**不会**把每条经验的完整来历一起放进去。需要时由 Agent
自己决定查不查：

```text
LESSON task-afbdb466-…#0
  problem:     危险操作先改代码、后验证，且只测成功路径。
  correction:  审批前先解析出全部目标，失败的不进入流程…
  applies when: 为不可逆操作加审批时
  confidence:  high

SOURCE TASK task-afbdb466-…
  goal:     为经验删除增加人类审批门槛，避免误删记忆
  expected: 没有 --yes 时删除被拒绝并显示预览…
  status:   succeeded
  result:   remove 默认改为只预览并 exit 3…
  timeline: session events seq 9743..9831

OTHER LESSONS IN FORCE WHEN THAT TASK STARTED (11 total):
  [E2] (reflection, medium) 直接用 slice 截断…
```

设计取舍：

| | 主动注入 | 按需查询（现状） |
|---|---|---|
| 上下文成本 | 每次反思都付 | **只在真的查时付** |
| 判断权 | 程序预先决定"什么相关" | **Agent 自己决定** |
| 追溯完整性 | 受材料长度限制 | **完整链**（目标→结果→事件区间→当时的其他经验） |

`timeline` 给出会话事件区间，用它可以回到原始对话；`OTHER LESSONS` 来自任务开启时的
环境快照，用来看"当时是不是只有这一条在起作用"。

快照本身分两处保存：`lessons[]`（前 12 条，含做法与适用条件）和 `omitted[]`（其余条目，
只有 id + 问题描述）。查询时**两处都计入**，所以 `(N total)` 与快照记录的条数一致；
详细展开最多 10 条，超出的用 `(+N more in force, not expanded: id, id, …)` 列出 id——
既不把输出撑大，也不让任何 id 失去可追溯性。

### 2.2 三层记忆

| 层 | 主要用途 | 默认作用范围 |
|---|---|---|
| `global` | 跨任务通用的方法论 | 所有会话 |
| `session` | 与特定会话/项目背景绑定的约束或经验 | 指定会话 |
| `reflection` | 从具体任务反思中产生的经验 | 产生该经验的会话 |

三层区分的是记忆的语义类别与作用范围，内容粒度不由程序自动判断。模型负责判断一条经验应该属于哪一层，程序只负责检查结构和引用关系。

注入规则由作用域决定：`global` 对所有会话可见；`session` 对指定 `session_id` 可见；`reflection` 默认随来源会话生效。经验可以晋升到 `global` 或指定的 `session` 作用域。晋升不会复制出一条重复的有效记忆，而是改变注入路径及源条目的有效状态。

三层目前渲染在同一个 system prompt section（`## Accumulated Lessons`）中，按层分组。

### 2.3 记忆治理

- **四个分类**：写入时由模型声明与已有经验的关系：`new`（新增）/ `repeat`（再次出现，只累加证据）/ `revise`（修正同一经验，旧版本不再注入）/ `none`（无新增信息，不落盘）。程序只执行声明。
- **晋升是状态迁移，不是复制**：源反思保留为来源和历史依据，派生条目覆盖的注入路径不再重复注入源条目。晋升到 `global` 会覆盖所有会话中的源注入路径，晋升到指定 `session` 只覆盖该会话的路径，不误伤其他会话。
- **冲突只显性化**：记忆可以声明四种关系：`condition`（适用条件不同）、`goal`（目标要求不同）、`contradiction`（同一条件下的直接矛盾）、`apparent`（一般规则与具体例外）。渲染时并列呈现并说明系统没有裁决，这部分由Agent判断适用条件并说明依据。
- **生命周期**：`active`、`superseded`（被新版本或新经验替代）、`deprecated`（不再推荐，但保留正文与历史依据）、`deleted`（不再作为有效记忆注入）。
- **结构检查器**：检查 `conflicts` / `promoted_from` 引用、scope 和 subject/session_id 的一致性，以及非 `reflection` 条目是否声明 `boundary`。
- **来源和主体分离**：`source` 由 Agent 自述经验最初从何而来，`task_id`、`session_id`、时间等机器侧字段独立记录。`source_text` 用于溯源，不参与记忆注入。

#### 一条经验的字段结构

| 字段 | 回答的问题 | 例 |
|---|---|---|
| `problem` | **发生了什么**（可观察的现象） | 「改完代码就宣布完成，改动带着一个立即可见的缺陷」 |
| `attempted` | **当时怎么处理的**（做法本身，不含评价） | 「直接报告完成，跳过验证；四行分页函数四个用例错三个」 |
| `correction` | **应当怎么做** | 「交付前跑一遍能暴露失败路径的最小测试」 |
| `applies_when` | **什么情况下适用** | 「修改代码后准备交付时」 |
| `confidence` | 自评置信度（`low`/`medium`/`high`） | `high` |

**为什么把 `pattern` 拆成 `problem` + `attempted`**：

旧结构只有 `pattern`，实践中容易写成「问题 + 做法」的复合句，而 `correction` 又比它更窄 ——
语义上自相矛盾：做法比结论还长，但结论才是要采纳的东西。拆开后三者各司其职：

- `problem` 只描述现象（不含"所以应该怎样"）
- `attempted` 记录做法（让「又用了旧做法」这件事变得可观测）
- `correction` 必须是可用于替代的做法，且**不能比 `problem` 更窄**——如果修法说得比问题还少，两者必有一个是错的

> 兼容：旧记录只有 `pattern` 时视为 `problem`，不需要迁移历史数据。

#### 三种条目类型：经验 / 明确方法 / 失败经验

`kind` 决定一条记忆「要不要被判断」：

| `kind` | 语义 | 渲染位置 | 必需字段 |
|---|---|---|---|
| `lesson`（默认） | 启发式：「这样做更好」，由模型判断是否适用 | 各作用域列表 | `problem` + `correction` |
| `directive` | 明确方法：直接要求执行，不判断 | `Required method:` | `correction` |
| `failure` | 失败经验：触发即排除，**不是**可权衡的启发式 | 独立的 `## Known failures` 块 | `problem` + `avoid` |

**为什么失败经验要独立一类**：现有 schema 强制 `correction` 必填，且规定它「不得比 `problem` 更窄」。
这条规则实际上**禁止把约束写成否定式**。但失败经验的自然形态常常是纯否定：

> 不要先改代码再验证。

失败经验未必存在一个已知的正面替代做法。硬塞进 `correction` 就会编造一个自己也不相信的修法，
或者丢掉「我确实不知道替代方案，但这条行不通」这个信息。
`failure` 用 `avoid`（不要做什么）+ 可选 `instead`（已知替代）表达，`correction` 不再必填。

渲染上它也不与普通经验并列：注入时单独成块，标题写明

```text
Known failures
Actions that produced a bad outcome. When the trigger matches, do not do this.
Unlike a lesson, this is not a heuristic to weigh — it is a constraint.
```

——否则「硬禁止」会和「可权衡的启发式」等价，进而被稀释成建议。

> 兼容：旧记录没有 `kind` 时默认 `lesson`，行为不变。

#### 结构化自我反对（`adversarialReview`，默认关）

目的不是让模型写一段自我批评，而是让它在落库前**交出一份可追溯的论证**，
并且**先把反方补强到不再是可以轻易击败的稻草人**。

##### 论证的十一个字段

| 字段 | 回答的问题 | 目的 |
|---|---|---|
| `claim` | 正在论证什么？ | 明确论证对象 |
| `premises` | 依赖哪些事实、假设、条件？ | 暴露隐含假设 |
| `evidence` | 前提有什么可观察的信息支持？ | 检查前提可靠性 |
| `inference` | 前提如何推出结论？ | 检查逻辑有效性 |
| `conclusion` | 最终主张是什么？ | 收束论证 |
| `steelman` | 最强的反方论证是什么？ | 对抗自我确认 |
| `counterexamples` | 哪些观察会挑战结论？ | 检查适用边界 |
| `scope` | 结论在哪些条件下成立？ | 防止过度泛化 |
| `alternatives` | 还有哪些同样能解释现象的原因？ | 避免过早归因 |
| `revision_conditions` | 什么情况会使我改变结论？ | **保持可证伪** |
| `unresolved` | 还有什么无法确定？ | 保留不确定性 |

##### 反方必须迭代补强，不能只反驳一次（看个人，可改）

单个 `steelman` 字段的实际写法几乎总是一次性走过场：写一段看起来很强的反对意见，
立刻反驳掉，然后宣布自己通过了检验。所以这里要求**轮次**：

```text
steelman_rounds:
  - threatens   这一轮攻击论证的哪一环（claim/premises/evidence/inference/…）
    argument    针对那一环加固后的反方论证（要说出原作者没想到的点）
    response    你的反驳
    survives    反驳之后，这一轮还剩下什么没被驳倒
  - threatens   ← 必须换一个环节
    ...
opposition_residual   所有轮次结束后，反方还有哪部分你没驳倒
```

程序机械检查三条，模型无法靠措辞绕过：

| 检查 | 理由 |
|---|---|
| 至少 **2 轮** | 一轮不是对抗，是走过场 |
| 每轮 `threatens` 必须不同 | 在同一处反复加固只是换措辞，不是深入 |
| 必须填 `opposition_residual` | 「真的思考过」的证据是承认反方还剩下什么，而不是宣布全胜 |

留 `opposition_residual` 这一项是关键：如果允许留空，模型会写「反方完全不成立」，
而那几乎从不是真的。

##### 三种有效性分开评估

```text
validity:
  deductive        valid / invalid / not_applicable / unresolved   —— 前提为真时结论是否必然为真
  inductive        strong / moderate / weak / …                    —— 证据在多大程度上支持结论
  premise_truth    established / partial / assumed / unresolved     —— 前提本身是否有依据
```

三者必须分开，否则会出现**形式有效但前提毫无依据**的论证——它看起来无懈可击，
实际没有任何信息。`premise_truth` 是必填项；若填 `unresolved`，则必须在 `unresolved`
里说明哪些问题还没确定。

##### 允许留空，但必须显式标记

不要求每次都填满全部字段。确实不适用或没有信息时，写 `n/a` / `unknown` / `无` / `不适用`，
程序会把它记进 `markers`，与正文分开存：

```text
critique.alternatives  = 省略
critique.markers       = { "alternatives": "n/a" }
critique.unresolved_keys = ["alternatives"]
```

这样事后能区分「**没写**」与「**写了但没有**」。编造内容来填满字段，比如把
`alternatives` 写成一句正确但空泛的话，反而是这里最想避免的行为。

##### verdict 的三条强制规则

| `verdict` | 结果 |
|---|---|
| `holds` | 正常写入 |
| `narrowed` | 必须填 `applies_when`（标出这条经验在哪里停止适用），否则拒收 |
| `withdrawn` | **不写入**，`lessons_recorded: 0` |

**必填而非可选**（有意设计的）同样的位置曾经放过一个可选字段 `conflicts`
（声明两条经验的张力），结果是 **55 条经验里被用过 0 次**，可选的质量控制字段
在实践中等价于不存在。也正因为它是必填，消耗不小，所以**默认关闭**：
这不是「再想一遍」，而是要求把论证逐项写出来。

##### 论证出的边界会进入提示词

`critique.scope` 不需要第二条经验当对手（对手是「旧做法」本身），所以它渲染成独立的
边界段，而不是挤进需要两两配对的 `[CONFLICTS]`：

```text
[BOUNDARIES] Each lesson below was checked against the strongest case for the old way of working.
The old way is still better under the stated condition — prefer it there, and apply the lesson only outside it.
- task-xxx#0: 报错信息极长且与改动位置无关时，先猜再验证更省
```

其余字段（完整论证、各轮补强、残余反方、有效性）**不进入 system prompt**，
用 `lessons_lookup` 展开查看。

#### 先例原则（`precedentGate` + `precedentInPrompt`）

> 有效的方法应该被重复使用，直到有充分的理由改变它。
> 改变一种已被验证有效的方法，所需要的证据标准应该远高于最初采用这种方法时的标准。

**「验证有效」是或然性的**：一条经验哪怕只成功过一次也算验证有效，只是或然性不高（不然太严格）
所以这里不做「是否已被证明」的判断，只数次数：

| 计数 | 来源 |
|---|---|
| `verified` | 该经验在任务开始时的决策环境快照里、且任务 `succeeded` 的次数 |
| `counter` | 同上，但任务失败的次数 |
| `exposures` | 总暴露次数 |

两者都是 `task_open.environment` 与 `task_close.status` 的 join，**不需要模型自评，也不需要对照组**。
渲染成 `Precedent: verified 19x, 1 counterexample(s)`。

**挑战先例必须举证。** `relation: "revise"` 要求 `evidence_task_ids`，程序机械校验三条：

1. 引用的任务真实存在，且有 `close` 记录；
2. 该任务**不是** `succeeded`——一次成功不构成对先例的挑战；
3. 该任务开始时的决策环境快照里**确实包含**被挑战的经验（= 当时它在生效）。

第 4 条「与其适用条件匹配」是语义判断，程序不验证，留给模型。

这一条闸门解决的是「`revise` 太容易」：修复前它的实际使用只有 2 次，
而任何模型都可以凭一时兴起改写一条被验证过 19 次的先例。



### 2.4 决策环境记录

反思材料不能只记录**行为**，还要记录行为发生时的**环境/约束**。否则模型被要求判断
「我做得怎么样」，却看不到「我当时被要求按什么做」。

因此 `task_start` 会把**此刻实际生效的经验冻结成快照**写进 `task_open` 记录：

```json
{"record_type":"open","task_id":"task-…","environment":{
  "taken_at": 1794…, "committed_at": 1794…, "count": 3, "truncated": false,
  "lessons":[{"id":"t1#0","scope":"global","confidence":"high",
              "problem":"…","attempted":"…","correction":"…","applies_when":"…"}]}}
```

**为什么在开始处快照，而不是反思时重算**：

| 事后重算的问题 | 快照的保证 |
|---|---|
| 后续修改经验，历史任务当时看到的约束被改写 | 修改不影响已冻结的快照 |
| `deprecated` 的条目从历史里消失 | 仍出现在它参与过的任务记录里 |
| 分不清「当时注入的」与「事后新增的」 | `taken_at` / `committed_at` 划定边界 |
| 无法追查某条经验的决策影响 | `task_close` 记录带 `environment_ids`，可按 id 反查 |

反思材料中的呈现：

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 2 total):
  [E1] (global, high) 修改前先读完整文件
        do instead: 先读再改
        applies when: 编辑未读过的文件时
  [E2] ...

These were the rules in force when you started. Judge whether any of them applied,
and whether you actually followed them — not whether they still seem right now.
```

> 这是**决策轨迹层**的职责，不是记忆治理层的：错的不是经验怎么存、怎么分类，
> 而是反思时缺少了当时的约束条件。

#### 超量时的截断策略

经验超过详述上限（默认 12 条）时，不能简单地"取前 N 条"——实测发现那样会**系统性丢掉
最新且高置信度的条目**，因为反思按写入顺序排列，越新的越靠后。

现在的策略分两层：

| 层 | 内容 | 数量上限 |
|---|---|---|
| **详细** | id / scope / confidence / problem / attempted / correction / applies_when | 12 条，按 `high → medium → low`，同级内新的优先 |
| **简略** | id / confidence / problem（一行） | 不限，全部列出 |

也就是说**任何时刻都能列出全部 id**，只是超出 12 条的只有一行摘要：

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 20 total, 12 detailed):
  [E1] (reflection, high) 改完代码就宣布完成…
        do instead: 交付前跑一遍最小测试
  …（12 条详细）

  Also in effect, listed without detail (8):
  [task-abc#0] (low) 某条低置信经验
  …
```

这保证了「某条经验是否参与过这次决策」永远可追溯——即使当时的材料没有展开它的全文。

#### 记录与渲染是两件事

| | 是否受开关控制 | 成本 |
|---|---|---|
| **记录**（`task_open.environment`） | 否，**始终写入** | 约 4.3 KB/任务（仅落盘，不占上下文） |
| **渲染**（材料里的 `DECISION ENVIRONMENT` 段） | `environmentInBrief`，默认 `true` | 约 800 token/次反思（实测 11 条 ≈ 1986 字符） |

记录保证历史可审计；渲染解决「反思时不用回翻几十万 token 去 system prompt 找约束」。

两者可以独立取舍：关掉 `environmentInBrief` 后，材料不再重复这些经验（模型仍能在
system prompt 或此前的即时通知里看到它们），但快照照样落盘、照样可按 id 反查。

#### 复盘是思考，不是汇报（`silentReflection`，默认开）

反思材料会让模型「还原决策过程」。不约束的话，模型往往把这当成一份要交的作业：先写
一大段分点回复，再去调 `task_reflect`。

实测（本会话 78 次 `task_end` → `task_reflect` 配对）：

| 指标 | 数值 |
|---|---|
| 复盘位置有对外发言 | 50%（39/78） |
| 发言长度 | 平均 784 字符，最长 6660 |

这段发言**不是写入通道**：`buildReflectionRecord` 只接收 `task_reflect` 的参数，
模型在工具之外说的话没有任何代码路径能进入记录（`test-silent.mjs` 逐字段验证过）。
但它也不是零成本：

| 影响 | 说明 |
|---|---|
| 输出 token | 同一份分析付两次钱——一次在正文，一次在 `task_reflect` 的结构化字段里 |
| 决策轨迹污染 | 若模型先开了新任务、再补做上一个任务的反思，这段发言会落在**新任务**的窗口内，被当成该任务的 `ASSISTANT` 条目收进它的反思材料 |

所以开启 `silentReflection` 后，材料末尾改为要求：

```text
Do this as internal reasoning, not as a visible reply. The six questions above are
prompts for your own thinking; do not answer them in your response text.

Call task_reflect directly, with <task_id> as the task_id.
After that, reply with at most one short line saying whether the task succeeded —
no restatement of the analysis, no per-question section, no bullet summary.
If something genuinely needs the user's attention (a decision only they can make,
a risk they must know), say just that one thing and nothing else.
```

留了一个出口：真的需要用户拍板的事仍然要说，而不是为了安静而瞒报。关闭该开关即恢复
原来的「说完再记录」措辞。

### 2.5 分工原则

> 插件负责记录、结构校验与注入流程；模型负责语义分类、冲突判断和任务反思。

程序不猜一条经验是否足够抽象、是否应该进入 `global`。非 `reflection` 条目必须提供 `boundary`，说明为什么它属于该作用域；程序只检查声明是否存在，不判断声明在语义上是否正确。这样，边界漂移至少能够被检查和复查，而不是完全不可见。

---

## 三、插件的限制

| # | 限制 | 影响 |
|---|---|---|
| 1 | 任务边界仍依赖模型遵循提示并调用 `task_start` / `task_end` | 当前提示要求 `task_start` 必须是任务第一项动作，但没验证，漏开任务仍会导致决策轨迹缺失 |
| 2 | 语义判断由模型负责 | 模型仍然可能把经验分错层、写出空泛的 `boundary`，或错误声明重复/冲突，检查器无法判断这些语义问题 |
| 3 | 三层共用一个 system prompt section | 任一层的注入内容变化都会改变该 section，并触发一次全量提示词缓存重算，实测大约 69 万 token（可能更多，测试样本不够多），之后请求恢复缓存命中 |
| 4 | 不做自动冲突解决 | 冲突双方继续注入，由Agent根据条件判断，这是刻意设计的 |
| 5 | 不做语义相似度去重 | 是否属于同一经验由模型声明 `repeat` / `revise`，程序按条目 ID 和声明执行 |
| 6 | 无 workspace 维度 | 目前不能自动按项目跨会话共享经验，需要显式晋升到 `global` 或指定的 `session` 作用域 |
| 7 | UI没了 | 客户端 bundle 在当前环境加载失败，放弃了，现在只能通过配置文件和命令行维护（哭） |
| 8 | 注入内容是从持久化记录派生的视图 | 任务/反思记录与记忆条目保存在 JSONL 中；删除相应数据文件会丢失历史依据，不是缓存！！！ |
| 9 | 写入器长开文件句柄 | 轮转日志前必须先禁用插件，再操作文件 |
| 10 | 自我反对只能逼近「不敷衍」，不能保证 | 程序强制的是结构（十一字段、≥2 轮补强、每轮换环节、必须承认残余反方）；两段形式不同实质敷衍的论证仍然能通过。目标是让敷衍留下痕迹，不是杜绝敷衍 |
| 11 | 先例闸门的第 4 条无法机械验证 | 「证据任务与被挑战经验的适用条件是否匹配」是语义判断，程序只保证任务真实、失败、经验当时在生效 |
| 12 | `verified` 计数没有对照组 | 同时进入生效集合的经验共享同一批任务，计数区分不出经验好坏，只反映暴露窗口长度（见 4.5） |


---

## 四、实验数据

以下实验用于观察记忆能否迁移到独立会话，不是长期训练的效果。核心实验都在依赖不全的工作区中进行（缺少 `tsc` / `eslint`）

### 4.1 工具链经验（npx）

判据：模型是否在未确认 `.bin` 的情况下使用 `npx` 运行 `tsc`。

| 组别 | 会话数 | 用了 npx | 未用 npx |
|---|---:|---:|---:|
| 无记忆 | 8 | 5 | 3 |
| 有记忆 | 6 | **0** | **6** |

有记忆组 6 次全部先检查 `node_modules/.bin`，缺失则跳过。但加入后期两个无记忆样本后，无记忆组使用 npx 的比例从早期的 5/6 降到 5/8，说明模型自身也可能谨慎处理，其中一个会话主动使用了 `npx --no-install`，快速失败而没有拉取远程包。

> 暂时的结论：记忆组 6/6 都先检查 `.bin`，记忆把正确做法稳定的提前了。**这些数据过旧，因为来自第一版，更新后没有再更新实验数据**。

### 4.2 修复方法经验（coupons）

实验换用一条与 npx 无关的经验：定位共享默认对象中的可变字段时，先用 `===` 探针证明引用相等，再在工厂函数中复制可变字段，并冻结默认值作为护栏。

一个独立会话中，三个具体动作全部复现：

```text
1、 修复前用 === 探针证明共享引用
2、 在工厂函数中复制可变字段
3、 保留 Object.freeze(DEFAULT_COUPONS) 作为回归护栏
```

修复后再次运行探针，引用相等结果变为 `false`。这是目前比较强的一次迁移证据：经验来自另一类任务，三个具体动作在独立会话中完整重现（都是单次样本）

### 4.3 任务边界提醒和提示词改动

旧提醒机制在回合结束时检查：如果本会话从未开过任务、但本回合做了实质工作，就注入一次提醒。记录中四次提醒都让 Agent 当场补开任务并进行反思。

局限在于提醒发生得太晚：补开的任务只能记录提醒之后的过程，不能恢复此前已经发生的决策轨迹。其中一个会话的复盘材料因此只有 5 个事件。

**注意：这项提示词改动尚未验证。** 


### 4.4 工具失败计数的口径

原始「工具失败」计数包含大量假阳性：例如 `grep` 没有匹配、`ls` 路径不存在，都可能通过非零退出码表达正常的查询结果。实验记录区分：

- `P`：前提失败，bench 在修复前就失败
- `A`：计数假阳性，属于统计方失真，修正有效计数时扣除
- `M`：模型侧真实失误或模型自测发现的失败，如实保留

原始计数与修正后的有效计数同时保留。只看原始计数会高估失败数量。插件中的 `tool_failures` 目前仍使用非零退出判断。

### 4.5 先例计数在真实数据上的分布（仅供参考）

拿我的 `tasks.jsonl`（44 个已关闭任务、32 条经验被快照过）跑 `computePrecedents`：

```text
计算出的先例条目: 32
验证次数最多的 6 条:
  19 verified / 1 counter  task-a08f9625…
  19 verified / 1 counter  task-28b1c958…
  19 verified / 1 counter  task-afbdb466…
  （另 3 条相同）
有反例的条目: 11 / 32
从未生效过的条目: 0
```

**这组数字说明的问题**：23 条经验是同一时刻进入生效集合的，之后一直同时生效——
**没有任何一组任务是在它们缺席时跑的**。所以 `verified` 的绝对值区分不出经验好坏，
它只衡量暴露窗口的长度。

这就是为什么 README 开头把「验证有效」定义为**或然性的**：这个计数能回答
「这条经验被用过多少次、其中几次成功」，不能回答「它是不是好东西」。
把它当必要条件（改写前得有反例）是成立的；把它当充分条件（verified 高所以一定对）不成立。

### 4.6 三个特性的实测边界（仅供参考）

| 特性 | 已验证 | 未验证 |
|---|---|---|
| 自我反对 | 十一字段结构、迭代补强三条（≥2 轮 / 每轮换环节 / 必须有残余反方）、`withdrawn` 不落盘、`narrowed` 强制 `applies_when`、`validity.premise_truth` 必填、`n/a` 标记与正文分离 | **论证质量**——程序只能保证「它被逼着补强了两轮且承认了残余」，无法判断那些论证是不是真的有力 |
| 先例闸门 | 三条机械校验（存在 / 非成功 / 当时在生效）全部生效，四类无效证据分别被拒 | 「与其适用条件匹配」这一条是语义判断，程序不验证 |
| 失败经验类型 | `avoid`/`instead` 落盘、独立渲染成 `Known failures`、不再混进 `[Lesson N]` | 模型是否真的会更严格地对待否定性约束——需要长期观察才可能看出 |

**关于「迭代补强」这一步的上限**「必须补强到反方不再是稻草人」是**语义要求**，
程序只能逼近它：轮数下限、每轮必须换攻击环节、必须留下没驳倒的部分。
一个决心走过场的模型仍然可以写两段形式不同但实质敷衍的论证。
真正的区分只能靠事后读 `lessons_lookup` 里的完整论证——所以这套设计的目标是
**让敷衍留下痕迹**，而不是保证不敷衍。

**一个已知风险**：先例闸门如果定得太严，模型的反应不是「更谨慎地修订」，而是**干脆不用 `revise`**。
修复前 `revise` 在 55 条记录里只出现过 2 次，余量本来就小。上线后应当盯 `relation` 分布，
如果 `revise` 归零，说明闸门变成了事实上的禁用。


---

## 五、使用方法

### 5.1 安装

#### 方式 A：在 DSH 界面中一键安装

1. 打开 DSH，进入 **插件 → 添加插件**。
2. 输入 `dsh-lessons`（或填入仓库地址 `https://github.com/duahciM/dsh-lessons`），点击 **安装**。
3. 安装完成后点击 **立即启用**。

#### 方式 B：命令行安装

```sh
dsh plugin --profile web add dsh-lessons
```

命令行安装后请重启 `dsh web`。Headless 用户请使用 `--profile headless`。

依赖：无外部服务，零 npm 依赖（只用 Node 内置模块）。

### 5.2 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: lessons
      name: 'dsh-lessons'
      config:
        taskDir: '<你的数据目录>/dsh-lessons-data'  # 任务记录与经验的存放位置
        fsyncEvery: 16                             # 每 N 条 fsync 一次
        taskBoundaryHints: true                    # 注入任务边界提示
        injectReflection: true                     # task_end 时注入复盘材料
        recordEvents: true                         # 落盘工具调用与失败（不注入）
        stateFromFile: true                        # 任务状态从文件推导（见 5.2.1）
        silentReflection: true                     # 复盘只在思维链里做，不写成回复（见 2.4）
        adversarialReview: false                   # 每条经验必须附完整论证（成本高，默认关，见 2.3）
        precedentGate: true                        # 改写先例必须引用真实反例（见 2.3）
        precedentInPrompt: true                    # 把 verified/counter 计数渲染进提示词
        lessons:
          enabled: true
          maxLessons: 0                            # 0 = 全部注入
          diagnostics: true                        # 内容变化时写 lessons-render.jsonl
          scopes:                                  # 三层开关
            global: true
            session: true
            reflection: true
          batching: true                           # 攒批（见 5.2.2）
          instantNotice: true                      # 新反思即时提示
          commitEvery: 8                           # 攒够 N 条才改一次 system prompt
          commitEveryTokens: 0                     # 或按 token 阈值（0 = 不看）
```

#### 5.2.1 `stateFromFile`：任务状态从文件推导（默认开）

进行中的任务、可反思的任务、哪些会话开过任务、已提醒几次 —— 这些原本是内存态，
插件重载或进程重启就丢，会导致：

- 进行中的任务断裂（`task_end` 报 `no open task`，无法反思）
- 「本会话开过任务」被遗忘 → 每回合误报「没有声明任何任务」
- 提醒次数归零 → 超过上限仍继续提醒

开启后，启动时从 `tasks.jsonl` 重建这四类事实。关闭则退回纯内存态（用于对照实验）。

#### 5.2.2 `batching` + `instantNotice`：缓存友好

**实测依据**：`plugin:` 类注入的缓存命中率中位数 **99.9%**；而 `system/message`
变更的中位数是 **0.0%**（一次约 50 万 token 重算）。缓存按前缀匹配——末尾追加几乎免费，
开头的系统提示一变则整段作废。

因此：

```
task_reflect → 写入反思
             → 未达阈值：发一条 plugin 通知（零缓存代价，立刻可见）
             → 达到阈值：推进「提交水位」，system prompt 才重算一次
```

- `batching: false` → section 实时反映全部条目，每条反思都会重算
- `instantNotice` 仅在 `batching` 开启时有效（否则内容与 section 重复）

### 5.3 日常使用

系统提示会引导 Agent 在任务开始前调用 `task_start`，并在结果出现后调用 `task_end`。当前提示明确要求 `task_start` 是任务第一项动作；`task_end` 生成的复盘材料会要求 Agent 调用 `task_reflect`。

这仍然依赖模型遵循提示并实际调用工具。若任务开始后才补开，插件无法补回此前没有被记录的决策过程。

人工维护记忆：

```bash
node tools/lessons.mjs list --session <会话id>   # 查看某会话实际看到什么
node tools/lessons.mjs check                     # 结构检查（引用/状态/边界）
node tools/lessons.mjs add --scope global --pattern "…" --correction "…" \
     --applies-when "…" --boundary "为什么属于这一层"
node tools/lessons.mjs move <id> --to global     # 晋升（状态迁移，不复制）
node tools/lessons.mjs remove <id>               # 只预览，不写入（exit 3 = 等待审批）
node tools/lessons.mjs remove <id> --yes         # 确认后真正写墓碑
node tools/deprecate.mjs <id> --reason "…"      # 不再推荐但保留历史
node tools/deprecate.mjs --list
```

### 5.4 结构检查

```bash
node tools/lessons.mjs check   # 引用完整性 / 状态自洽 / 边界是否声明
```

不随包分发测试脚本；开发仓库内另有 205 项自动化测试（8 个测试文件）。

---

## 六、文件结构

```text
index.js                 插件入口：三个工具 + system prompt 注入 + 事件落盘
lib/
  task-model.js          任务记录与参数校验
  task-context.js        决策轨迹截取（不含工具调用清单）
  reflection-model.js    反思校验、四分类、冲突声明
  lessons.js             三层解析/折叠/晋升覆盖/冲突渲染/结构检查
  writer.js              崩溃安全写入（write + 批量 fsync + 回读校验）
  classify.js            工具失败信号识别（isError / 非零退出 / 超时 / 信号）
tools/
  lessons.mjs            经验维护 CLI（list/add/move/remove/check/export/import）
  deprecate.mjs          deprecated 状态入口
data/                    运行时创建，不在仓库内
  tasks.jsonl            任务记录 + 反思
  lessons/lessons.jsonl  维护的 global / session 条目 + 补丁
  tool-events.jsonl      工具调用记录（只写不注入）
  error-events.jsonl     失败记录（只写不注入）
docs/
  MEMORY-GOVERNANCE.md   三层治理规范（职责/去重/晋升/冲突/生命周期）
  MEMORY-SCOPES.md       三域作用域与注入规则
  TASK-BOUNDARY-DESIGN.md 任务边界层设计
  REFLECTION-PIPELINE.md 反思生成与持久化
  LESSONS-INJECTION.md   注入实现与 Prefix Cache 实测
```
